/**
 * LLM-judge for the synthesis benchmark (ADR-010 §7).
 *
 * Replaces the brittle anchor-substring check with a semantic comparison of the
 * dialectic answer against the golden reference. Reuses the `dialectic` LLM task
 * (same provider/model as the engine under test), temperature=0.
 *
 * Shared by the benchmark suite and (later) live answer-quality sampling
 * (ADR-011 §2).
 */

import { z } from "zod";
import { getLLMClient } from "../llm-client.js";
import { llm as llmCfg } from "../../config.js";

export const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator for a memory-retrieval benchmark.
Decide whether the CANDIDATE answer conveys the same key facts as the REFERENCE answer for the QUESTION.
Rules:
- Judge meaning, not wording. Paraphrases count.
- Ignore differences in casing, punctuation and plurality.
- If the candidate omits or contradicts a key fact, it is incorrect.
- Anchors are hints about expected key terms; they are NOT required verbatim.
Return ONLY JSON: {"correct": <boolean>, "score": <number 0..1>, "reason": "<short>"}`;

const JudgeResponseSchema = z.object({
  correct: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string().optional(),
});

export interface JudgeResult {
  correct: boolean;
  score: number;
  reason: string;
}

export interface JudgeInput {
  question: string;
  referenceAnswer: string;
  candidateAnswer: string;
  anchors?: string[];
}

export function buildJudgeUserPrompt(p: JudgeInput): string {
  const anchors = (p.anchors ?? []).length > 0 ? `\nANCHORS (hints): ${(p.anchors ?? []).join(", ")}` : "";
  return `QUESTION: ${p.question}\nREFERENCE: ${p.referenceAnswer}\nCANDIDATE: ${p.candidateAnswer}${anchors}`;
}

/** Extract the JSON object from a (possibly fenced) LLM response. */
export function parseJudgeResponse(text: string): JudgeResult {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`judge: no JSON object in response: ${text.slice(0, 120)}`);
  }
  const parsed = JudgeResponseSchema.parse(JSON.parse(cleaned.slice(start, end + 1)));
  return { correct: parsed.correct, score: parsed.score, reason: parsed.reason ?? "" };
}

function maxOutputTokensParam(model: string, maxTokens: number) {
  return /^gpt-5/i.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

export async function judgeAnswer(p: JudgeInput): Promise<JudgeResult> {
  const model = llmCfg.dialectic.model;
  const client = getLLMClient(llmCfg.dialectic);
  const response = await client.chat.completions.create({
    model,
    ...maxOutputTokensParam(model, 300),
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: buildJudgeUserPrompt(p) },
    ],
  });
  const text = response.choices[0]?.message?.content ?? "";
  return parseJudgeResponse(text);
}
