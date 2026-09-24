/**
 * Telemetry collector (ADR-011 §1).
 *
 * Aggregates MemorySearchDiagnostics into a drop-off funnel + timing summary.
 * Stage names are DATA, not schema: retrieval emits whatever stages it has
 * (today "vector"/"intent_rerank", after ADR-007 "S0".."S3"), and the collector
 * groups by name. Telemetry/QC therefore adapts to a changing architecture
 * without code changes here.
 *
 * Privacy: only numbers are stored — never query text or memory content.
 * Non-blocking: pure in-memory accumulation, size-capped, no I/O in the hot path.
 */

import type { MemorySearchDiagnostics } from "../memory/types.js";
import { telemetry as telemetryCfg } from "../../config.js";

interface StageAgg {
  name: string;
  firstSeen: number;
  count: number;
  inSum: number;
  outSum: number;
  /** Per-layer detail (ADR-014 step 1): dropped/ms/cutoff when the layer reports them. */
  msSum: number;
  msSamples: number[];
  cutoffSum: number;
  cutoffCount: number;
}

interface TimingAgg {
  count: number;
  totalMs: number;
  samplesMs: number[];
}

const ENABLED = telemetryCfg?.collector?.enabled ?? true;
const MAX_SAMPLES = telemetryCfg?.collector?.maxSamples ?? 1000;
const MAX_STAGES = parseInt(process.env.TELEMETRY_MAX_STAGES || "32", 10);

let samples = 0;
let cacheHits = 0;
let fastModeCount = 0;
let lastSampleAt: string | null = null;
let stageSeq = 0;
const stageAgg = new Map<string, StageAgg>();
const timingAgg = new Map<string, TimingAgg>();

let llmCalls = 0;
let promptTokens = 0;
let completionTokens = 0;
let totalTokens = 0;

export function isTelemetryEnabled(): boolean {
  return ENABLED;
}

export interface LLMUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Record token usage from an LLM response (wired in llm-client.ts). */
export function recordLLMUsage(usage?: LLMUsageLike): void {
  if (!ENABLED || !usage || typeof usage !== "object") return;
  llmCalls += 1;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  promptTokens += prompt;
  completionTokens += completion;
  totalTokens += usage.total_tokens ?? prompt + completion;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function recordSearchTelemetry(diag: MemorySearchDiagnostics): void {
  if (!ENABLED) return;

  samples += 1;
  if (diag.cache_hit) cacheHits += 1;
  if (diag.fast_mode) fastModeCount += 1;
  lastSampleAt = new Date().toISOString();

  for (const stage of diag.stages ?? []) {
    if (!stage || typeof stage.name !== "string") continue;
    let agg = stageAgg.get(stage.name);
    if (!agg) {
      if (stageAgg.size >= MAX_STAGES) continue;
      agg = { name: stage.name, firstSeen: stageSeq++, count: 0, inSum: 0, outSum: 0,
              msSum: 0, msSamples: [], cutoffSum: 0, cutoffCount: 0 };
      stageAgg.set(stage.name, agg);
    }
    agg.count += 1;
    agg.inSum += Number.isFinite(stage.in) ? stage.in : 0;
    agg.outSum += Number.isFinite(stage.out) ? stage.out : 0;
    if (Number.isFinite(stage.ms) && (stage.ms as number) >= 0) {
      agg.msSum += stage.ms as number;
      agg.msSamples.push(stage.ms as number);
      if (agg.msSamples.length > MAX_SAMPLES) agg.msSamples.shift();
    }
    if (Number.isFinite(stage.cutoff)) {
      agg.cutoffSum += stage.cutoff as number;
      agg.cutoffCount += 1;
    }
  }

  const timings: Record<string, number> = {
    cache_ms: diag.cache_ms,
    embed_ms: diag.embed_ms,
    vector_ms: diag.vector_ms,
    lexical_ms: diag.lexical_ms,
    merge_ms: diag.merge_ms,
    total_ms: diag.total_ms,
  };
  for (const [name, value] of Object.entries(timings)) {
    if (!Number.isFinite(value) || value < 0) continue;
    let agg = timingAgg.get(name);
    if (!agg) {
      agg = { count: 0, totalMs: 0, samplesMs: [] };
      timingAgg.set(name, agg);
    }
    agg.count += 1;
    agg.totalMs += value;
    agg.samplesMs.push(value);
    if (agg.samplesMs.length > MAX_SAMPLES) agg.samplesMs.shift();
  }
}

export function getDropOffSummary() {
  const stages = [...stageAgg.values()]
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map((agg) => {
      const avgIn = agg.count > 0 ? agg.inSum / agg.count : 0;
      const avgOut = agg.count > 0 ? agg.outSum / agg.count : 0;
      return {
        name: agg.name,
        samples: agg.count,
        avg_in: avgIn,
        avg_out: avgOut,
        // Net change, NOT a clamp: a layer that adds candidates (`S1.type_recall`) reports
        // a negative "dropped". Per-layer traces clamp to 0 (a drop cannot be negative);
        // the funnel reports the honest delta so growth is visible too.
        avg_dropped: avgIn - avgOut,
        retention: avgIn > 0 ? avgOut / avgIn : 1,
        // ADR-014 step 1 / ADR-011 §8: per-layer cost and the chosen window. `avg_cutoff`
        // is null when the layer never reports one, so the funnel can tell "no window"
        // from "window k = 0".
        avg_ms: agg.msSamples.length > 0 ? agg.msSum / agg.msSamples.length : null,
        p95_ms: agg.msSamples.length > 0 ? percentile(agg.msSamples, 95) : null,
        avg_cutoff: agg.cutoffCount > 0 ? agg.cutoffSum / agg.cutoffCount : null,
      };
    });

  const timings = Object.fromEntries(
    [...timingAgg.entries()].map(([name, agg]) => [
      name,
      {
        count: agg.count,
        avg_ms: agg.count > 0 ? agg.totalMs / agg.count : 0,
        p50_ms: percentile(agg.samplesMs, 50),
        p95_ms: percentile(agg.samplesMs, 95),
        p99_ms: percentile(agg.samplesMs, 99),
      },
    ])
  );

  return {
    generated_at: new Date().toISOString(),
    last_sample_at: lastSampleAt,
    sample_count: samples,
    cache_hit_rate: samples > 0 ? cacheHits / samples : 0,
    fast_mode_rate: samples > 0 ? fastModeCount / samples : 0,
    stages,
    timings,
    llm: {
      calls: llmCalls,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      avg_tokens_per_call: llmCalls > 0 ? totalTokens / llmCalls : 0,
    },
  };
}

export function resetTelemetry(): { reset: true; timestamp: string } {
  samples = 0;
  cacheHits = 0;
  fastModeCount = 0;
  lastSampleAt = null;
  stageSeq = 0;
  stageAgg.clear();
  timingAgg.clear();
  llmCalls = 0;
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  return { reset: true, timestamp: new Date().toISOString() };
}
