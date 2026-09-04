import { describe, it, expect, vi, beforeEach } from "vitest";

// Test the task() helper's fallback chain: env var > json > default.
// Since config.ts reads process.env at import time, we re-import the module
// with fresh env for each scenario.

async function loadConfigWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  const original = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import("../config.js");
  } finally {
    for (const k of Object.keys(original)) process.env[k] = original[k];
    for (const k of Object.keys(process.env)) {
      if (!(k in original)) delete process.env[k];
    }
  }
}

describe("LLM config: task() resolution", () => {
  it("should default extraction model to gpt-4o-mini when no env/json", async () => {
    const { llm } = await loadConfigWithEnv({});
    expect(llm.extraction.model).toBe("gpt-4o-mini");
    expect(llm.extraction.apiKey).toBeUndefined();
    expect(llm.extraction.baseUrl).toBeUndefined();
  });

  it("should read per-task model from LLM_EXTRACTION_MODEL env", async () => {
    const { llm } = await loadConfigWithEnv({
      LLM_EXTRACTION_MODEL: "deepseek-v4-flash",
    });
    expect(llm.extraction.model).toBe("deepseek-v4-flash");
  });

  it("should read per-task apiKey from LLM_EXTRACTION_API_KEY env", async () => {
    const { llm } = await loadConfigWithEnv({
      LLM_EXTRACTION_API_KEY: "sk-custom",
    });
    expect(llm.extraction.apiKey).toBe("sk-custom");
  });

  it("should read per-task baseUrl from LLM_EXTRACTION_BASE_URL env", async () => {
    const { llm } = await loadConfigWithEnv({
      LLM_EXTRACTION_BASE_URL: "https://deepseek.example.com/v1",
    });
    expect(llm.extraction.baseUrl).toBe("https://deepseek.example.com/v1");
  });

  it("should fall back defaultApiKey to OPENAI_API_KEY", async () => {
    const { llm } = await loadConfigWithEnv({ OPENAI_API_KEY: "sk-global" });
    expect(llm.defaultApiKey).toBe("sk-global");
  });

  it("should fall back defaultBaseUrl to OPENAI_BASE_URL", async () => {
    const { llm } = await loadConfigWithEnv({
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
    });
    expect(llm.defaultBaseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("should keep per-task key/url independent from global", async () => {
    const { llm } = await loadConfigWithEnv({
      OPENAI_API_KEY: "sk-global",
      LLM_RERANK_API_KEY: "sk-rerank",
      LLM_RERANK_BASE_URL: "https://rerank.example.com",
    });
    expect(llm.rerank.apiKey).toBe("sk-rerank");
    expect(llm.rerank.baseUrl).toBe("https://rerank.example.com");
    expect(llm.defaultApiKey).toBe("sk-global");
    // extraction still has no key/url of its own
    expect(llm.extraction.apiKey).toBeUndefined();
  });

  it("should keep SOTA models (memoryExtraction, dialectic) at gpt-5.4-mini", async () => {
    const { llm } = await loadConfigWithEnv({});
    expect(llm.memoryExtraction.model).toBe("gpt-5.4-mini");
    expect(llm.dialectic.model).toBe("gpt-5.4-mini");
    expect(llm.consolidation.model).toBe("gpt-5.4-mini");
  });

  it("should read camelCase task models from SNAKE_CASE env names", async () => {
    const { llm } = await loadConfigWithEnv({
      LLM_MEMORY_EXTRACTION_MODEL: "deepseek-v4-flash",
      LLM_QUERY_EXPANSION_MODEL: "deepseek-v4-flash",
      LLM_SESSION_SUMMARY_MODEL: "deepseek-v4-pro",
    });
    expect(llm.memoryExtraction.model).toBe("deepseek-v4-flash");
    expect(llm.queryExpansion.model).toBe("deepseek-v4-flash");
    expect(llm.sessionSummary.model).toBe("deepseek-v4-pro");
  });
});
