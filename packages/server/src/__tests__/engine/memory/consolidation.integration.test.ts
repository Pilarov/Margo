import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockChatCreate,
  mockMemoryCreate,
  mockMemoryUpdate,
  mockMemoryFindMany,
  mockQueryRaw,
  mockEmbedSingle,
} = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
  mockMemoryCreate: vi.fn(),
  mockMemoryUpdate: vi.fn(),
  mockMemoryFindMany: vi.fn(),
  mockQueryRaw: vi.fn(),
  mockEmbedSingle: vi.fn(),
}));

vi.mock("../../../db/index.js", () => ({
  db: {
    memory: { create: mockMemoryCreate, update: mockMemoryUpdate, findMany: mockMemoryFindMany },
    $queryRaw: mockQueryRaw,
  },
}));

vi.mock("../../../engine/embeddings.js", () => ({
  embedSingle: mockEmbedSingle,
}));

vi.mock("../../../engine/llm-client.js", () => ({
  getLLMClient: () => ({ chat: { completions: { create: mockChatCreate } } }),
}));

vi.mock("../../../config.js", () => ({
  llm: { defaultApiKey: "test-key", consolidation: { model: "gpt-5.4-mini" } },
  consolidationMode: "basic",
}));

import { mergeDuplicateMemories, findDuplicateMemories } from "../../../engine/memory/consolidation.js";

describe("mergeDuplicateMemories", () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    mockMemoryCreate.mockReset();
    mockMemoryUpdate.mockReset();
    mockEmbedSingle.mockReset();
  });

  it("merges a cluster into one memory and deactivates the originals", async () => {
    mockChatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              merged_content: "User works at Stripe",
              entity_mentions: ["Stripe"],
              confidence: 0.95,
              reasoning: "merged",
            }),
          },
        },
      ],
    });
    mockEmbedSingle.mockResolvedValue([0.1, 0.2, 0.3]);
    mockMemoryCreate.mockResolvedValue({ id: "merged1" });

    const cluster = {
      representative: {
        id: "m1",
        projectId: "p1",
        orgId: "default",
        userId: "u1",
        sessionId: null,
        memoryType: "factual",
        content: "Works at Stripe",
        confidence: 0.8,
        documentDate: null,
        eventDate: null,
        importance: 0.7,
      },
      duplicates: [{ id: "m2", content: "Works at Stripe too", confidence: 0.7, documentDate: null }],
      similarity: 0.95,
    };

    const id = await mergeDuplicateMemories(cluster);

    expect(id).toBe("merged1");
    expect(mockMemoryCreate).toHaveBeenCalledTimes(1);
    expect(mockMemoryCreate.mock.calls[0][0].data.content).toBe("User works at Stripe");
    expect(mockMemoryUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("findDuplicateMemories", () => {
  beforeEach(() => {
    mockMemoryFindMany.mockReset();
    mockQueryRaw.mockReset();
  });

  it("clusters memories above the similarity threshold", async () => {
    mockMemoryFindMany.mockResolvedValue([
      { id: "m1", content: "a", importance: 0.8 },
      { id: "m2", content: "b", importance: 0.7 },
      { id: "m3", content: "c", importance: 0.6 },
    ]);
    mockQueryRaw.mockResolvedValue([{ id: "m2", similarity: 0.97 }]);

    const clusters = await findDuplicateMemories({ projectId: "p1", userId: "u1", similarityThreshold: 0.95 });

    expect(clusters).toHaveLength(1);
    expect(clusters[0].representative.id).toBe("m1");
    expect(clusters[0].duplicates).toHaveLength(1);
    expect(clusters[0].duplicates[0].id).toBe("m2");
  });

  it("returns no clusters when nothing is similar", async () => {
    mockMemoryFindMany.mockResolvedValue([
      { id: "m1", content: "a", importance: 0.8 },
      { id: "m2", content: "b", importance: 0.7 },
    ]);
    mockQueryRaw.mockResolvedValue([{ id: "m2", similarity: 0.2 }]);

    const clusters = await findDuplicateMemories({ projectId: "p1", userId: "u1", similarityThreshold: 0.95 });

    expect(clusters).toHaveLength(0);
  });
});
