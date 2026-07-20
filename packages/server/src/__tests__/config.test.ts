import { describe, it, expect } from "vitest";

// These tests import the actual config module.
// When no env vars are set and no retaindb.config.json exists,
// all values fall back to their documented defaults.
import { embedding, rerank } from "../../config.js";

describe("ServerConfig: Embedding defaults", () => {
  it("should default mode to 'remote'", () => {
    expect(embedding.mode).toBe("remote");
  });

  it("should default model to Xenova/bge-large-en-v1.5", () => {
    expect(embedding.model).toBe("Xenova/bge-large-en-v1.5");
  });

  it("should default localModel to Xenova/bge-large-en-v1.5", () => {
    expect(embedding.localModel).toBe("Xenova/bge-large-en-v1.5");
  });

  it("should default remoteRequired to false", () => {
    expect(embedding.remoteRequired).toBe(false);
  });

  it("should default largeBatchThreshold to 20", () => {
    expect(embedding.largeBatchThreshold).toBe(20);
  });

  it("should default maxBatchSize to 64", () => {
    expect(embedding.maxBatchSize).toBe(64);
  });

  it("should default maxConcurrency to 2", () => {
    expect(embedding.maxConcurrency).toBe(2);
  });

  it("should default cacheFile to .embedding-cache.json", () => {
    expect(embedding.cacheFile).toBe(".embedding-cache.json");
  });

  it("should default geminiDimensions to 768", () => {
    expect(embedding.geminiDimensions).toBe(768);
  });

  it("should default inferenceTimeoutMs to 2500", () => {
    expect(embedding.inferenceTimeoutMs).toBe(2500);
  });

  it("should have undefined URLs when env is not set", () => {
    // When no env vars are set, inference service URLs are undefined
    expect(
      embedding.embeddingInferenceBaseUrl === undefined ||
      embedding.embeddingInferenceBaseUrl === ""
    ).toBe(true);
  });

  it("should have mode in valid set", () => {
    const validModes = ["openai", "gemini", "local", "hybrid", "remote", "workers"];
    expect(validModes).toContain(embedding.mode);
  });
});

describe("ServerConfig: Rerank defaults", () => {
  it("should default mode to 'balanced'", () => {
    expect(rerank.mode).toBe("balanced");
  });

  it("should default provider to 'local'", () => {
    expect(rerank.provider).toBe("local");
  });

  it("should default remoteRequired to false", () => {
    expect(rerank.remoteRequired).toBe(false);
  });

  it("should default llmEnabled to false", () => {
    expect(rerank.llmEnabled).toBe(false);
  });

  it("should default budgetMs to 90", () => {
    expect(rerank.budgetMs).toBe(90);
  });

  it("should default llmMinBudgetMs to 75", () => {
    expect(rerank.llmMinBudgetMs).toBe(75);
  });

  it("should default llmMaxCandidates to 5", () => {
    expect(rerank.llmMaxCandidates).toBe(5);
  });

  it("should default maxCandidates to 20", () => {
    expect(rerank.maxCandidates).toBe(20);
  });

  it("should have mode in valid set", () => {
    const validModes = ["balanced", "cross-encoder", "llm"];
    expect(validModes).toContain(rerank.mode);
  });

  it("should have provider in valid set", () => {
    const validProviders = ["local", "remote"];
    expect(validProviders).toContain(rerank.provider);
  });
});
