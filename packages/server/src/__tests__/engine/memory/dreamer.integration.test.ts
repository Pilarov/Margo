import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChatCreate, mockMemoryFindMany, mockMemoryCreate } = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
  mockMemoryFindMany: vi.fn(),
  mockMemoryCreate: vi.fn(),
}));

vi.mock("../../../db/index.js", () => ({
  db: {
    memory: { findMany: mockMemoryFindMany, create: mockMemoryCreate },
  },
}));

vi.mock("../../../engine/llm-client.js", () => ({
  getLLMClient: () => ({ chat: { completions: { create: mockChatCreate } } }),
}));

vi.mock("../../../config.js", () => ({
  llm: {
    defaultApiKey: "test-key",
    consolidation: { model: "gpt-5.4-mini" },
  },
}));

import {
  runInductivePass,
  runPeerCardPass,
  runDreamerConsolidation,
} from "../../../engine/memory/dreamer.js";

const SAMPLE_MEMORIES = [
  { id: "m1", content: "User prefers TypeScript", memoryType: "preference", confidence: 0.8 },
  { id: "m2", content: "User chose TypeScript for new project", memoryType: "decision", confidence: 0.85 },
  { id: "m3", content: "User migrated JS to TS", memoryType: "event", confidence: 0.75 },
];

describe("dreamer integration: runInductivePass", () => {
  beforeEach(() => mockChatCreate.mockReset());

  it("makes one LLM call and returns parsed patterns", async () => {
    mockChatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patterns: [
                { content: "User strongly prefers TypeScript", memoryType: "preference", confidence: 0.92, evidence: ["m1", "m2", "m3"] },
              ],
            }),
          },
        },
      ],
    });
    const result = await runInductivePass(SAMPLE_MEMORIES);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].memoryType).toBe("preference");
    expect(result[0].evidence).toEqual(["m1", "m2", "m3"]);
  });

  it("returns [] without calling LLM when fewer than 3 memories", async () => {
    const result = await runInductivePass(SAMPLE_MEMORIES.slice(0, 2));
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe("dreamer integration: runPeerCardPass", () => {
  beforeEach(() => mockChatCreate.mockReset());

  it("makes one LLM call and returns the profile", async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ profile: "TypeScript developer" }) } }],
    });
    const result = await runPeerCardPass(SAMPLE_MEMORIES);
    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(result).toBe("TypeScript developer");
  });
});

describe("dreamer integration: runDreamerConsolidation", () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    mockMemoryFindMany.mockReset();
    mockMemoryCreate.mockReset();
  });

  it("writes derived memories and returns peer-card", async () => {
    mockMemoryFindMany.mockResolvedValue([
      { id: "m1", content: "prefers TS", memoryType: "preference", confidence: 0.8, orgId: "default" },
      { id: "m2", content: "chose TS", memoryType: "decision", confidence: 0.85, orgId: "default" },
      { id: "m3", content: "migrated to TS", memoryType: "event", confidence: 0.75, orgId: "default" },
    ]);
    mockChatCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                patterns: [
                  { content: "User strongly prefers TypeScript", memoryType: "preference", confidence: 0.9, evidence: ["m1", "m2", "m3"] },
                ],
              }),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ profile: "TypeScript dev" }) } }],
      });
    mockMemoryCreate.mockResolvedValue({ id: "derived1" });

    const result = await runDreamerConsolidation({ projectId: "p1", userId: "u1" });

    expect(result.inductiveCreated).toBe(1);
    expect(result.peerCard).toBe("TypeScript dev");
    expect(mockMemoryCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockMemoryCreate.mock.calls[0][0];
    expect(createArgs.data.memoryType).toBe("preference");
    expect(createArgs.data.content).toBe("User strongly prefers TypeScript");
  });

  it("returns zero without LLM when fewer than 3 memories", async () => {
    mockMemoryFindMany.mockResolvedValue([
      { id: "m1", content: "prefers TS", memoryType: "preference", confidence: 0.8, orgId: "default" },
    ]);
    const result = await runDreamerConsolidation({ projectId: "p1", userId: "u1" });
    expect(result).toEqual({ inductiveCreated: 0, peerCard: null });
    expect(mockChatCreate).not.toHaveBeenCalled();
  });
});
