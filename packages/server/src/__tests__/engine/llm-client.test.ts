import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock config before importing llm-client ──────────────────────────────
vi.mock("../../config.js", () => ({
  llm: {
    defaultApiKey: "default-key",
    defaultBaseUrl: "https://default.example.com/v1",
    extraction: { model: "deepseek-v4-flash" },
    rerank: {
      model: "rerank-model",
      apiKey: "rerank-key",
      baseUrl: "https://rerank.example.com/v1",
    },
  },
}));

import { getLLMClient, resetLLMClient } from "../../engine/llm-client.js";

describe("getLLMClient", () => {
  beforeEach(() => {
    resetLLMClient();
  });

  it("B1: should use global default key/url when task has neither", () => {
    const client = getLLMClient({ model: "deepseek-v4-flash" });
    expect(client.apiKey).toBe("default-key");
    expect(client.baseURL).toBe("https://default.example.com/v1");
  });

  it("B2: should use per-task key/url when provided", () => {
    const client = getLLMClient({
      model: "rerank-model",
      apiKey: "rerank-key",
      baseUrl: "https://rerank.example.com/v1",
    });
    expect(client.apiKey).toBe("rerank-key");
    expect(client.baseURL).toBe("https://rerank.example.com/v1");
  });

  it("B3: should use per-task key but fall back to global url", () => {
    const client = getLLMClient({
      model: "x",
      apiKey: "custom-key",
    });
    expect(client.apiKey).toBe("custom-key");
    expect(client.baseURL).toBe("https://default.example.com/v1");
  });

  it("B4: should use per-task url but fall back to global key", () => {
    const client = getLLMClient({
      model: "x",
      baseUrl: "https://custom.example.com/v1",
    });
    expect(client.apiKey).toBe("default-key");
    expect(client.baseURL).toBe("https://custom.example.com/v1");
  });

  it("B5: should cache by provider (same key+url → same instance)", () => {
    const a = getLLMClient({ model: "x", apiKey: "k1", baseUrl: "https://a.example.com" });
    const b = getLLMClient({ model: "y", apiKey: "k1", baseUrl: "https://a.example.com" });
    expect(a).toBe(b);
  });

  it("B6: should create separate clients for different providers", () => {
    const a = getLLMClient({ model: "x", apiKey: "k1", baseUrl: "https://a.example.com" });
    const b = getLLMClient({ model: "x", apiKey: "k2", baseUrl: "https://b.example.com" });
    expect(a).not.toBe(b);
  });

  it("B8: resetLLMClient should clear the cache", () => {
    const a = getLLMClient({ model: "x", apiKey: "k", baseUrl: "https://a.example.com" });
    resetLLMClient();
    const b = getLLMClient({ model: "x", apiKey: "k", baseUrl: "https://a.example.com" });
    expect(a).not.toBe(b);
  });
});

describe("getLLMClient: error handling", () => {
  it("B7: should throw when no apiKey is available", async () => {
    vi.resetModules();
    vi.doMock("../../config.js", () => ({
      llm: { defaultApiKey: undefined, defaultBaseUrl: undefined },
    }));
    const mod = await import("../../engine/llm-client.js");
    expect(() => mod.getLLMClient({ model: "x" })).toThrow(/OPENAI_API_KEY/);
  });
});
