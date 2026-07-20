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
