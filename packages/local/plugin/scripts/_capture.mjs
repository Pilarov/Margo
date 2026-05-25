#!/usr/bin/env node

const BASE_URL = (process.env.RETAINDB_BASE_URL || "http://localhost:3111").replace(/\/+$/, "");
const API_KEY = process.env.RETAINDB_API_KEY || "";

function headers() {
  const value = { "Content-Type": "application/json" };
  if (API_KEY) value.Authorization = `Bearer ${API_KEY}`;
  return value;
}

function truncate(value, max = 8000) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...[truncated]` : value;
  } catch {
    return value;
  }
}

export async function capture(hookType) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let data = {};
  try {
    data = input.trim() ? JSON.parse(input) : {};
  } catch {
    data = { raw: input.slice(0, 8000) };
  }

  if (process.env.RETAINDB_SDK_CHILD === "1" || data.entrypoint === "sdk-ts") return;

  const sessionId = data.session_id || data.sessionId || process.env.RETAINDB_SESSION_ID || "unknown";
  const project = process.env.RETAINDB_PROJECT || data.cwd || data.project || "default";
  const agentId = process.env.RETAINDB_AGENT_ID || data.agent_id || data.agentId || "agent";

  const payload = {
    hookType,
    sessionId,
    project,
    cwd: data.cwd || process.cwd(),
    timestamp: new Date().toISOString(),
    data: {
      ...data,
      tool_output: truncate(data.tool_output ?? data.tool_response),
      prompt: truncate(data.prompt),
    },
  };

  try {
    await fetch(`${BASE_URL}/retaindb/observe`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Hooks must never block the agent.
  }
}
