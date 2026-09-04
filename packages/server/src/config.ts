import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function readJsonConfig(): Record<string, any> {
  const path = resolve(process.cwd(), "retaindb.config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    console.warn("[Config] Failed to parse retaindb.config.json, falling back to env/defaults");
    return {};
  }
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^true$/i.test(value);
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function str(value: string | undefined, fallback: string): string {
  return value !== undefined ? value : fallback;
}

const json = readJsonConfig();
const jEmbed = (json.embedding ?? {}) as Record<string, any>;
const jRerank = (json.rerank ?? {}) as Record<string, any>;
const jLlm = (json.llm ?? {}) as Record<string, any>;

// ── Embedding config ────────────────────────────────────────────────────────

export interface EmbeddingConfig {
  mode: "openai" | "gemini" | "local" | "hybrid" | "remote" | "workers";
  model: string;
  localModel: string;
  embeddingInferenceBaseUrl: string | undefined;
  embeddingBaseUrl: string | undefined;
  inferenceBaseUrl: string | undefined;
  inferenceApiUrl: string | undefined;
  inferenceApiKey: string | undefined;
  inferenceTimeoutMs: number;
  remoteRequired: boolean;
  largeBatchThreshold: number;
  maxBatchSize: number;
  maxConcurrency: number;
  cacheFile: string;
  geminiDimensions: number;
  extractionMaxTokens: number;
}

export const embedding: EmbeddingConfig = {
  mode: (str(process.env.EMBEDDING_MODE, jEmbed.mode) || "remote") as EmbeddingConfig["mode"],
  model: str(process.env.EMBEDDING_MODEL, jEmbed.model) || "Xenova/bge-large-en-v1.5",
  localModel: str(process.env.EMBEDDING_LOCAL_MODEL, jEmbed.localModel) || "Xenova/bge-large-en-v1.5",
  embeddingInferenceBaseUrl: process.env.EMBEDDING_INFERENCE_BASE_URL ?? jEmbed.embeddingInferenceBaseUrl,
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL ?? jEmbed.embeddingBaseUrl,
  inferenceBaseUrl: process.env.INFERENCE_BASE_URL ?? jEmbed.inferenceBaseUrl,
  inferenceApiUrl: process.env.INFERENCE_API_URL ?? jEmbed.inferenceApiUrl,
  inferenceApiKey: process.env.INFERENCE_API_KEY || process.env.RETAINDB_INFERENCE_KEY || jEmbed.inferenceApiKey,
  inferenceTimeoutMs: num(process.env.INFERENCE_TIMEOUT_MS, jEmbed.inferenceTimeoutMs) ?? 2500,
  remoteRequired: bool(process.env.REMOTE_INFERENCE_REQUIRED, jEmbed.remoteRequired ?? false),
  largeBatchThreshold: num(process.env.LARGE_BATCH_THRESHOLD, jEmbed.largeBatchThreshold) ?? 20,
  maxBatchSize: num(process.env.EMBEDDING_MAX_BATCH_SIZE, jEmbed.maxBatchSize) ?? 64,
  maxConcurrency: num(process.env.EMBEDDING_MAX_CONCURRENCY, jEmbed.maxConcurrency) ?? 2,
  cacheFile: str(process.env.EMBEDDING_CACHE_FILE, jEmbed.cacheFile) ?? ".embedding-cache.json",
  geminiDimensions: num(process.env.GEMINI_EMBEDDING_DIMENSIONS, jEmbed.geminiDimensions) ?? 768,
  extractionMaxTokens: num(process.env.LLM_EXTRACTION_MAX_TOKENS, jEmbed.extractionMaxTokens) ?? 800,
};

// ── Rerank config ───────────────────────────────────────────────────────────

export interface RerankConfig {
  mode: "balanced" | "cross-encoder" | "llm";
  provider: "local" | "remote";
  rerankInferenceBaseUrl: string | undefined;
  rerankBaseUrl: string | undefined;
  inferenceBaseUrl: string | undefined;
  inferenceApiUrl: string | undefined;
  remoteRequired: boolean;
  llmEnabled: boolean;
  budgetMs: number;
  llmMinBudgetMs: number;
  llmMaxCandidates: number;
  maxCandidates: number;
  llmMaxTokens: number;
}

export const rerank: RerankConfig = {
  mode: (str(process.env.RERANK_MODE, jRerank.mode) || "balanced") as RerankConfig["mode"],
  provider: (str(process.env.RERANK_PROVIDER, jRerank.provider) || "local") as RerankConfig["provider"],
  rerankInferenceBaseUrl: process.env.RERANK_INFERENCE_BASE_URL ?? jRerank.rerankInferenceBaseUrl,
  rerankBaseUrl: process.env.RERANK_BASE_URL ?? jRerank.rerankBaseUrl,
  inferenceBaseUrl: process.env.INFERENCE_BASE_URL ?? jRerank.inferenceBaseUrl,
  inferenceApiUrl: process.env.INFERENCE_API_URL ?? jRerank.inferenceApiUrl,
  remoteRequired: bool(process.env.REMOTE_INFERENCE_REQUIRED, jRerank.remoteRequired ?? false),
  llmEnabled: bool(process.env.LLM_RERANK_ENABLED, jRerank.llmEnabled ?? false),
  budgetMs: num(process.env.RERANK_BUDGET_MS, jRerank.budgetMs) ?? 90,
  llmMinBudgetMs: num(process.env.LLM_RERANK_MIN_BUDGET_MS, jRerank.llmMinBudgetMs) ?? 75,
  llmMaxCandidates: num(process.env.LLM_RERANK_MAX_CANDIDATES, jRerank.llmMaxCandidates) ?? 5,
  maxCandidates: num(process.env.MAX_RERANK_CANDIDATES, jRerank.maxCandidates) ?? 20,
  llmMaxTokens: num(process.env.LLM_RERANK_MAX_TOKENS, jRerank.llmMaxTokens) ?? 200,
};

// ── LLM config ──────────────────────────────────────────────────────────────
// Каждая задача имеет свою модель + ключ + URL. Если ключ/URL не заданы для
// задачи — наследуются глобальные (OPENAI_API_KEY / OPENAI_BASE_URL).
// Поддерживает любые OpenAI-совместимые провайдеры (DeepSeek, Together, Groq,
// vLLM, Ollama, и т.д.) через baseUrl.

export interface LLMTaskConfig {
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface LLMConfig {
  defaultApiKey: string | undefined;
  defaultBaseUrl: string | undefined;
  extraction: LLMTaskConfig;
  queryExpansion: LLMTaskConfig;
  rerank: LLMTaskConfig;
  sourceProfile: LLMTaskConfig;
  compressor: LLMTaskConfig;
  oracle: LLMTaskConfig;
  synthesis: LLMTaskConfig;
  pageExtractor: LLMTaskConfig;
  researchAgent: LLMTaskConfig;
  taskRunner: LLMTaskConfig;
  videoStt: LLMTaskConfig;
  memoryExtraction: LLMTaskConfig;
  consolidation: LLMTaskConfig;
  dialectic: LLMTaskConfig;
  inference: LLMTaskConfig;
  sessionSummary: LLMTaskConfig;
  relation: LLMTaskConfig;
  temporal: LLMTaskConfig;
}

function task(
  name: string,
  jCfg: Record<string, any>,
  defaultModel: string
): LLMTaskConfig {
  const j = (jCfg[name] ?? {}) as Record<string, any>;
  // camelCase task name → SNAKE_CASE env suffix, e.g. memoryExtraction → MEMORY_EXTRACTION
  const envSuffix = name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  return {
    model: str(process.env[`LLM_${envSuffix}_MODEL`], j.model) || defaultModel,
    apiKey: process.env[`LLM_${envSuffix}_API_KEY`] || j.apiKey,
    baseUrl: process.env[`LLM_${envSuffix}_BASE_URL`] || j.baseUrl,
  };
}

const jTasks = (jLlm.tasks ?? {}) as Record<string, any>;

export const llm: LLMConfig = {
  defaultApiKey: process.env.OPENAI_API_KEY || jLlm.defaultApiKey || jLlm.apiKey,
  defaultBaseUrl: process.env.OPENAI_BASE_URL || jLlm.defaultBaseUrl || jLlm.baseUrl,
  extraction: task("extraction", jTasks, "gpt-4o-mini"),
  queryExpansion: task("queryExpansion", jTasks, "gpt-4o-mini"),
  rerank: task("rerank", jTasks, "gpt-4o-mini"),
  sourceProfile: task("sourceProfile", jTasks, "gpt-4o-mini"),
  compressor: task("compressor", jTasks, "gpt-4o-mini"),
  oracle: task("oracle", jTasks, "gpt-4o"),
  synthesis: task("synthesis", jTasks, "gpt-4o-mini"),
  pageExtractor: task("pageExtractor", jTasks, "gpt-4o-mini"),
  researchAgent: task("researchAgent", jTasks, "gpt-4o"),
  taskRunner: task("taskRunner", jTasks, "gpt-4o"),
  videoStt: task("videoStt", jTasks, "gpt-4o-mini-transcribe"),
  memoryExtraction: task("memoryExtraction", jTasks, "gpt-5.4-mini"),
  consolidation: task("consolidation", jTasks, "gpt-5.4-mini"),
  dialectic: task("dialectic", jTasks, "gpt-5.4-mini"),
  inference: task("inference", jTasks, "gpt-5.4-mini"),
  sessionSummary: task("sessionSummary", jTasks, "gpt-5.4-mini"),
  relation: task("relation", jTasks, "gpt-5.4-mini"),
  temporal: task("temporal", jTasks, "gpt-5.4-mini"),
};

// ── Extraction mode ─────────────────────────────────────────────────────────
// Controls how memories are extracted from messages (ADR-002):
//   pattern  — regex patterns only, no LLM (local default)
//   per_type — pattern + single-call LLM inference (current behavior)
//   one_pass — pattern + schema-driven single LLM call across all memory types
const jExtraction = (json.extraction ?? {}) as Record<string, any>;

export type ExtractionMode = "pattern" | "per_type" | "one_pass";

const EXTRACTION_MODE_VALUES: readonly ExtractionMode[] = ["pattern", "per_type", "one_pass"];

export const extractionMode: ExtractionMode = (() => {
  const raw = str(process.env.EXTRACTION_MODE, jExtraction.mode) || "per_type";
  return (EXTRACTION_MODE_VALUES as readonly string[]).includes(raw)
    ? (raw as ExtractionMode)
    : "per_type";
})();

// ── Consolidation mode ──────────────────────────────────────────────────────
// Controls memory consolidation (ADR-003):
//   basic   — dedup + decay (local default)
//   dreamer — basic + inductive reasoning + peer-card
//   off     — no consolidation
const jConsolidation = (json.consolidation ?? {}) as Record<string, any>;

export type ConsolidationMode = "basic" | "dreamer" | "off";

const CONSOLIDATION_MODE_VALUES: readonly ConsolidationMode[] = ["basic", "dreamer", "off"];

export const consolidationMode: ConsolidationMode = (() => {
  const raw = str(process.env.CONSOLIDATION_MODE, jConsolidation.mode) || "basic";
  return (CONSOLIDATION_MODE_VALUES as readonly string[]).includes(raw)
    ? (raw as ConsolidationMode)
    : "basic";
})();

// Canonical embedding dimension (ADR-006). openai (text-embedding-3-small with
// dimensions:1024) and local (BGE-large) both emit 1024; gemini emits 768 and
// requires a re-index when switched.
export const EMBEDDING_DIM = num(process.env.EMBEDDING_DIM, 1024);
