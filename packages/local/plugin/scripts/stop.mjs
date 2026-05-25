#!/usr/bin/env node
import { capture } from "./_capture.mjs";

const BASE_URL = (process.env.RETAINDB_BASE_URL || "http://localhost:3111").replace(/\/+$/, "");
let input = "";
for await (const chunk of process.stdin) input += chunk;
let data = {};
try { data = input.trim() ? JSON.parse(input) : {}; } catch {}
const sessionId = data.session_id || data.sessionId || process.env.RETAINDB_SESSION_ID || "unknown";

await capture("stop");

try {
  await fetch(`${BASE_URL}/retaindb/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, project: process.env.RETAINDB_PROJECT || data.cwd || "default" }),
    signal: AbortSignal.timeout(5000),
  });
  await fetch(`${BASE_URL}/retaindb/session/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, project: process.env.RETAINDB_PROJECT || data.cwd || "default" }),
    signal: AbortSignal.timeout(2000),
  });
} catch {}
