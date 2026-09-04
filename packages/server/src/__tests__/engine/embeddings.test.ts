import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockOpenAIEmbed } = vi.hoisted(() => ({ mockOpenAIEmbed: vi.fn() }));

vi.mock("openai", () => ({
  default: class {
    embeddings = { create: mockOpenAIEmbed };
  },
}));

vi.mock("../../config.js", () => ({
  llm: { defaultApiKey: "test-key", defaultBaseUrl: "https://api.openai.com/v1" },
  embedding: { geminiDimensions: 768, mode: "openai", largeBatchThreshold: 20 },
}));

import { embedWithOpenAI, embedWithGemini } from "../../engine/embeddings.js";

process.env.OPENAI_API_KEY = "test-key";
process.env.GOOGLE_API_KEY = "test-key";

describe("embedWithOpenAI", () => {
  beforeEach(() => mockOpenAIEmbed.mockReset());

  it("calls text-embedding-3-small with dimensions 1024 and maps embeddings", async () => {
    mockOpenAIEmbed.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
    });

    const result = await embedWithOpenAI(["hello", "world"]);

    expect(mockOpenAIEmbed).toHaveBeenCalledTimes(1);
    const args = mockOpenAIEmbed.mock.calls[0][0];
    expect(args.model).toBe("text-embedding-3-small");
    expect(args.dimensions).toBe(1024);
    expect(args.input).toEqual(["hello", "world"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("embedWithGemini", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("batches and maps gemini embeddings", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }),
    });
    globalThis.fetch = mockFetch as any;

    const result = await embedWithGemini(["a", "b"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("text-embedding-004");
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("throws when the API returns an error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, text: async () => "boom" }) as any;

    await expect(embedWithGemini(["a"])).rejects.toThrow(/boom/);
  });
});
