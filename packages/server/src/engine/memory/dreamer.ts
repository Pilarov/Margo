/**
 * Dreamer consolidation (ADR-003).
 *
 * Inductive reasoning (recurring patterns → derived memories) and peer-card
 * (concise user profile) layered on top of the existing dedup/decay
 * consolidation in consolidation.ts.
 */

import { z } from "zod";
import { db } from "../../db/index.js";
import { getLLMClient } from "../llm-client.js";
import { llm as llmCfg } from "../../config.js";
import { MEMORY_TYPES, MEMORY_TYPE_MAP } from "./inference.js";
import type { MemoryType } from "./types.js";

export interface InductivePattern {
  content: string;
  memoryType: string;
  confidence: number;
  evidence: string[];
  reasoning?: string;
}

export interface DreamerMemoryInput {
  id: string;
  content: string;
  memoryType: string;
  confidence: number;
}

const PatternSchema = z.object({
  content: z.string().min(8).max(400),
  memoryType: z.enum(MEMORY_TYPES),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().max(100)).max(20).default([]),
  reasoning: z.string().max(200).optional(),
});

function getOpenAI() {
  if (!llmCfg.defaultApiKey) return null;
  return getLLMClient(llmCfg.consolidation);
}

function getModel(): string {
  return llmCfg.consolidation.model;
}

function getMaxOutputTokensParam(model: string, maxTokens: number) {
  return /^gpt-5/i.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function normalizeMemoryType(raw: unknown): string {
  const key = String(raw || "factual").toLowerCase().trim();
  return MEMORY_TYPE_MAP[key] || "factual";
}

function toNumber(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// ── Inductive pass ──────────────────────────────────────────────────────────

export function buildInductivePrompt(memories: DreamerMemoryInput[]): string {
  const block = memories
    .map((m, i) => `[${i + 1}] (${m.memoryType}) ${m.content} (id: ${m.id})`)
    .join("\n");

  return `You are consolidating a user's long-term memory via inductive reasoning.

Find recurring patterns across these memories — things the user has stated, preferred, or done multiple times across different moments.

Memories:
${block}

For each pattern, produce ONE generalized conclusion:
- content: a standalone generalized statement (no pronouns)
- memoryType: the single most specific type that fits (preference, decision, goal, instruction, factual, ...)
- confidence: 0-1, higher for patterns backed by more evidence
- evidence: the ids of the source memories that support this pattern
- reasoning: one short sentence (debug only)

Return JSON:
{ "patterns": [{"content": "...", "memoryType": "<type>", "confidence": 0.9, "evidence": ["id1", "id2"], "reasoning": "..."}] }`;
}

export function parseInductiveResponse(text: string): InductivePattern[] {
  let parsed: unknown;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as any).patterns)
      ? (parsed as any).patterns
      : [];
  if (!Array.isArray(items) || items.length === 0) return [];

  const result: InductivePattern[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, any>;
    const evidenceRaw = r.evidence ?? r.derived_from ?? r.source_ids ?? [];
    const parsedItem = PatternSchema.safeParse({
      content: String(r.content ?? r.conclusion ?? ""),
      memoryType: normalizeMemoryType(r.memoryType ?? r.memory_type ?? r.type),
      confidence: toNumber(r.confidence, 0.8),
      evidence: Array.isArray(evidenceRaw) ? evidenceRaw.map(String) : [],
      reasoning: r.reasoning,
    });
    if (parsedItem.success) {
      result.push({
        content: parsedItem.data.content,
        memoryType: parsedItem.data.memoryType,
        confidence: parsedItem.data.confidence,
        evidence: parsedItem.data.evidence,
        reasoning: parsedItem.data.reasoning,
      });
    }
  }
  return result;
}

// ── Peer-card pass ──────────────────────────────────────────────────────────

export function buildPeerCardPrompt(memories: DreamerMemoryInput[]): string {
  const block = memories
    .map((m, i) => `[${i + 1}] (${m.memoryType}) ${m.content}`)
    .join("\n");

  return `Generate a concise user profile from these memories.

Memories:
${block}

Summarize who this user is in 1-3 short sentences (~200 tokens), covering:
- their role / what they work on
- their preferences and working style
- any recurring goals or decisions

Return JSON:
{ "profile": "..." }`;
}

export function parsePeerCardResponse(text: string): string {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);
    const profile = parsed?.profile ?? parsed?.content ?? parsed?.summary ?? parsed?.peer_card;
    return typeof profile === "string" ? profile.trim() : "";
  } catch {
    return "";
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── LLM passes ──────────────────────────────────────────────────────────────

export async function runInductivePass(memories: DreamerMemoryInput[]): Promise<InductivePattern[]> {
  if (memories.length < 3) return [];
  const client = getOpenAI();
  if (!client) return [];

  try {
    const model = getModel();
    const response = await client.chat.completions.create({
      model,
      ...getMaxOutputTokensParam(model, 2048),
      temperature: 0.1,
      messages: [{ role: "user", content: buildInductivePrompt(memories) }],
      response_format: { type: "json_object" },
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    return parseInductiveResponse(text);
  } catch (error: any) {
    console.error("[dreamer] inductive pass failed:", error?.message || error);
    return [];
  }
}

export async function runPeerCardPass(memories: DreamerMemoryInput[]): Promise<string> {
  if (memories.length === 0) return "";
  const client = getOpenAI();
  if (!client) return "";

  try {
    const model = getModel();
    const response = await client.chat.completions.create({
      model,
      ...getMaxOutputTokensParam(model, 512),
      temperature: 0.2,
      messages: [{ role: "user", content: buildPeerCardPrompt(memories) }],
      response_format: { type: "json_object" },
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    return parsePeerCardResponse(text);
  } catch (error: any) {
    console.error("[dreamer] peer-card pass failed:", error?.message || error);
    return "";
  }
}

// ── Orchestration ───────────────────────────────────────────────────────────

export async function runDreamerConsolidation(params: {
  projectId: string;
  userId?: string;
}): Promise<{ inductiveCreated: number; peerCard: string | null }> {
  const { projectId, userId } = params;

  const memories = await db.memory.findMany({
    where: { projectId, userId, isActive: true, validUntil: null },
    orderBy: { importance: "desc" },
    take: 100,
  });
  if (memories.length < 3) return { inductiveCreated: 0, peerCard: null };

  const inputs: DreamerMemoryInput[] = memories.map((m) => ({
    id: m.id,
    content: m.content,
    memoryType: m.memoryType,
    confidence: m.confidence,
  }));

  const [patterns, peerCard] = await Promise.all([
    runInductivePass(inputs),
    runPeerCardPass(inputs),
  ]);

  let inductiveCreated = 0;
  for (const pattern of patterns) {
    try {
      await db.memory.create({
        data: {
          projectId,
          orgId: memories[0].orgId,
          userId,
          content: pattern.content,
          memoryType: pattern.memoryType as MemoryType,
          confidence: pattern.confidence,
          entityMentions: [],
          importance: Math.max(0.5, pattern.confidence),
          metadata: {
            derivedFrom: pattern.evidence,
            derivedReasoning: pattern.reasoning,
            source: "dreamer.inductive",
          },
        },
      });
      inductiveCreated++;
    } catch (error) {
      console.error("[dreamer] failed to write derived memory:", error);
    }
  }

  return { inductiveCreated, peerCard };
}
