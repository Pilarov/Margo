/**
 * Dialectic query engine — answers natural-language questions about a user
 * by running an LLM against their full memory model.
 *
 * Answers natural-language questions about a user by running an LLM against their memory model.
 */

import OpenAI from "openai";
import { loadUserModelMemories, synthesizeUserModel } from "./user-model.js";

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
}

export type DialecticReasoningLevel = "minimal" | "low" | "medium" | "high";

// How many memories and how rich the prompt is per level
const LEVEL_CONFIG: Record<DialecticReasoningLevel, { maxMemories: number; maxTokens: number }> = {
  minimal: { maxMemories: 6,  maxTokens: 200 },
  low:     { maxMemories: 12, maxTokens: 350 },
  medium:  { maxMemories: 20, maxTokens: 600 },
  high:    { maxMemories: 40, maxTokens: 900 },
};

function getModel(): string {
  return process.env.DIALECTIC_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini";
}

function getMaxOutputTokensParam(model: string, maxTokens: number) {
  return /^gpt-5/i.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function buildSystemPrompt(level: DialecticReasoningLevel): string {
  const base = `You are an AI that knows a specific user through their stored memories.
Answer the question about this user based only on the memories provided.
Be concise and factual. If the memories don't contain enough information to answer, say so briefly.`;

  if (level === "minimal" || level === "low") return base;

  return `${base}
When relevant, cite which memory supports your answer.
If there are contradictory memories, note the most recent one.
Do not speculate beyond what the memories support.`;
}

function buildMemoryBlock(
  memories: Array<{ content: string; memoryType: string; importance: number; updatedAt: Date }>,
  maxMemories: number
): string {
  const sorted = [...memories]
    .sort((a, b) => b.importance - a.importance || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, maxMemories);

  return sorted
    .map((m, i) => `[${i + 1}] (${m.memoryType}) ${m.content}`)
    .join("\n");
}

export interface DialecticResult {
  answer: string;
  supporting_memory_ids: string[];
  coverage_score: number;
  reasoning_level: DialecticReasoningLevel;
}

export async function dialecticQuery(params: {
  userId: string;
  projectId: string;
  query: string;
  reasoningLevel?: DialecticReasoningLevel;
}): Promise<DialecticResult> {
  const level = params.reasoningLevel ?? "low";
  const { maxMemories, maxTokens } = LEVEL_CONFIG[level];

  const [memories, model] = await Promise.all([
    loadUserModelMemories({ userId: params.userId, projectId: params.projectId }),
    synthesizeUserModel({ userId: params.userId, projectId: params.projectId }),
  ]);

  if (memories.length === 0) {
    return {
      answer: "No memories found for this user yet.",
      supporting_memory_ids: [],
      coverage_score: 0,
      reasoning_level: level,
    };
  }

  const memoryBlock = buildMemoryBlock(memories, maxMemories);
  const systemPrompt = buildSystemPrompt(level);

  const userPrompt = `User memories:\n${memoryBlock}\n\nQuestion: ${params.query}`;

  let answer = "";
  try {
    const model = getModel();
    const response = await getOpenAIClient().chat.completions.create({
      model,
      ...getMaxOutputTokensParam(model, maxTokens),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    });
    answer = response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err: any) {
    console.error("[dialectic] LLM call failed:", err?.message || err);
    throw err;
  }

  // Best-effort: find memory IDs whose content appears in the answer
  const queryLower = params.query.toLowerCase();
  const supporting = memories
    .filter((m) => {
      const c = m.content.toLowerCase();
      return answer.toLowerCase().includes(c.slice(0, 40)) || queryLower.split(" ").some((w) => w.length > 4 && c.includes(w));
    })
    .slice(0, 8)
    .map((m) => m.id);

  return {
    answer,
    supporting_memory_ids: supporting,
    coverage_score: model.evidence.coverage_score,
    reasoning_level: level,
  };
}
