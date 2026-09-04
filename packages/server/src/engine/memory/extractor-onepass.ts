/**
 * One-pass memory extraction (ADR-002).
 *
 * A single schema-driven LLM call that extracts memories across ALL memory
 * types at once, instead of the conservative "infer up to 4 durable memories"
 * used by the default inference path.
 */

import type { ExtractedMemory, MemoryType, MemorySourceRole } from "./types.js";
import { getLLMClient } from "../llm-client.js";
import { llm as llmCfg } from "../../config.js";
import { parseInferenceResponse } from "./inference.js";

// Type descriptions for the schema-driven prompt (ADR-002).
const TYPE_DESCRIPTIONS: Record<MemoryType, string> = {
  factual: "objective facts, technical stack, versions, configurations",
  preference: "user likes, dislikes, preferences, habits",
  decision: "choices made, options selected, trade-offs accepted",
  constraint: "limitations, requirements, must-have or must-not-have rules",
  instruction: "procedures, workflows, commands to follow",
  goal: "objectives, targets, desired outcomes",
  event: "things that happened with timestamps",
  relationship: "connections between people, teams, tools, concepts",
  opinion: "subjective judgments, evaluations, assessments",
  solution: "resolved problems, implemented fixes, working approaches",
  project_state: "status of project, milestones, current phase",
  correction: "fixes to previous statements, updates, deprecations",
  workflow: "repeatable processes, pipelines, automation steps",
};

const MAX_MESSAGE_LEN = 2500;
const MAX_CONTEXT_LEN = 1000;
const MAX_OUTPUT_TOKENS = 1024;

function buildSystemPrompt(): string {
  const types = Object.entries(TYPE_DESCRIPTIONS)
    .map(([type, description]) => `- ${type}: ${description}`)
    .join("\n");

  return `You are a memory extraction system that extracts durable memories from a message and its surrounding context.

Extract memories across ALL of the following types that are actually present in the input:

${types}

Rules:
- Only extract durable, future-useful information (not greetings, filler, or generic chat).
- Each memory must be a standalone, unambiguous statement with no pronouns.
- Classify each memory into the single most specific applicable type from the list above.
  Only use "factual" when no more specific type fits.
- Set confidence 0-1 based on how certain you are the memory is durable and correctly captured.
- reasoning: one short sentence (debug only).
- Return JSON: { "memories": [{"content": "...", "memoryType": "<one of the listed types>", "confidence": 0.9, "reasoning": "...", "entities": []}] }`;
}

function sanitize(value: string, maxLen: number): string {
  return value.slice(0, maxLen).trim();
}

function getOpenAI() {
  if (!llmCfg.defaultApiKey) return null;
  return getLLMClient(llmCfg.memoryExtraction);
}

function getMaxOutputTokensParam(model: string, maxTokens: number) {
  return /^gpt-5/i.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function shouldRetryWithoutStructuredOutput(err: any): boolean {
  const message = String(err?.message || "");
  return err?.status === 400 && /Failed to generate JSON|Failed to validate JSON|tool_use_failed|json_validate_failed/i.test(message);
}

export async function extractMemoriesOnePass(
  message: string,
  context: string = "",
  options?: {
    minConfidence?: number;
    sourceRole?: MemorySourceRole;
    maxMemories?: number;
  }
): Promise<ExtractedMemory[]> {
  if (!message.trim() || message.trim().length < 8) return [];

  const safeMessage = sanitize(message, MAX_MESSAGE_LEN);
  const safeContext = sanitize(context, MAX_CONTEXT_LEN);
  const minConfidence = typeof options?.minConfidence === "number" ? options.minConfidence : 0.5;
  const maxMemories = options?.maxMemories ?? 20;
  const sourceRole = options?.sourceRole || "user";

  const client = getOpenAI();
  if (!client) return [];

  const userContent = [
    `## Message Source\n${sourceRole}`,
    safeContext ? `## Context\n${safeContext}` : "",
    `## Message\n${safeMessage}`,
  ].filter(Boolean).join("\n\n");

  try {
    const model = llmCfg.memoryExtraction.model;
    const base = {
      model,
      ...getMaxOutputTokensParam(model, MAX_OUTPUT_TOKENS),
      temperature: 0.1,
      messages: [
        { role: "system" as const, content: buildSystemPrompt() },
        { role: "user" as const, content: userContent },
      ],
    };

    let response;
    try {
      response = await client.chat.completions.create({
        ...base,
        response_format: { type: "json_object" as const },
      });
    } catch (err: any) {
      if (!shouldRetryWithoutStructuredOutput(err)) throw err;
      response = await client.chat.completions.create({
        ...base,
        messages: [
          { role: "system" as const, content: `${buildSystemPrompt()}\n\nReturn ONLY valid JSON. Do not use markdown fences or extra commentary.` },
          { role: "user" as const, content: `${userContent}\n\nReturn ONLY a valid JSON object with a top-level "memories" array.` },
        ],
      });
    }

    const text = response.choices[0]?.message?.content?.trim() ?? null;
    if (!text) return [];

    return parseInferenceResponse(text)
      .filter((memory) => memory.confidence >= minConfidence)
      .slice(0, maxMemories)
      .map((memory) => ({
        content: memory.content,
        memoryType: memory.memoryType as MemoryType,
        entityMentions: memory.entities,
        eventDate: null,
        confidence: memory.confidence,
        reasoning: memory.reasoning,
        inferred: true,
        sourceRole,
      }));
  } catch (error: any) {
    console.error("[onepass] extractMemoriesOnePass failed:", error?.message || error);
    return [];
  }
}
