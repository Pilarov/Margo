import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChatCreate, mockLoadMemories, mockSynthModel, mockSearchMemories } = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
  mockLoadMemories: vi.fn(),
  mockSynthModel: vi.fn(),
  mockSearchMemories: vi.fn(),
}));

vi.mock("../../../engine/memory/user-model.js", () => ({
  loadUserModelMemories: mockLoadMemories,
  synthesizeUserModel: mockSynthModel,
}));

vi.mock("../../../engine/memory/search.js", () => ({
  searchMemories: mockSearchMemories,
}));

vi.mock("../../../engine/llm-client.js", () => ({
  getLLMClient: () => ({ chat: { completions: { create: mockChatCreate } } }),
}));

vi.mock("../../../config.js", () => ({
  llm: { dialectic: { model: "gpt-5.4-mini" } },
}));

import { dialecticQuery } from "../../../engine/memory/dialectic.js";

describe("dialecticQuery", () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    mockLoadMemories.mockReset();
    mockSynthModel.mockReset();
    mockSearchMemories.mockReset();
    mockSearchMemories.mockResolvedValue([]);
  });

  it("returns the no-memories answer without calling the LLM", async () => {
    mockLoadMemories.mockResolvedValue([]);
    mockSynthModel.mockResolvedValue({ evidence: { coverage_score: 0 } });

    const result = await dialecticQuery({ userId: "u1", projectId: "p1", query: "anything?" });

    expect(result.answer).toBe("No memories found for this user yet.");
    expect(result.supporting_memory_ids).toEqual([]);
    expect(result.coverage_score).toBe(0);
    expect(mockChatCreate).not.toHaveBeenCalled();
  });

  it("calls the LLM once and returns answer + reasoning level + coverage", async () => {
    mockLoadMemories.mockResolvedValue([
      { id: "m1", content: "User prefers dark mode", memoryType: "preference", importance: 0.9, updatedAt: new Date() },
    ]);
    mockSynthModel.mockResolvedValue({ evidence: { coverage_score: 0.7 } });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: "User prefers dark mode." } }] });

    const result = await dialecticQuery({ userId: "u1", projectId: "p1", query: "dark mode?", reasoningLevel: "medium" });

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("User prefers dark mode.");
    expect(result.reasoning_level).toBe("medium");
    expect(result.coverage_score).toBe(0.7);
  });

  it("derives supporting_memory_ids from content overlap", async () => {
    mockLoadMemories.mockResolvedValue([
      { id: "m1", content: "User prefers dark mode", memoryType: "preference", importance: 0.9, updatedAt: new Date() },
      { id: "m2", content: "User works at Stripe", memoryType: "factual", importance: 0.5, updatedAt: new Date() },
    ]);
    mockSynthModel.mockResolvedValue({ evidence: { coverage_score: 0.5 } });
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: "The user prefers dark mode." } }] });

    const result = await dialecticQuery({ userId: "u1", projectId: "p1", query: "dark mode?" });

    expect(result.supporting_memory_ids).toContain("m1");
    expect(result.supporting_memory_ids).not.toContain("m2");
  });

  it("propagates an LLM failure", async () => {
    mockLoadMemories.mockResolvedValue([
      { id: "m1", content: "User prefers dark mode", memoryType: "preference", importance: 0.9, updatedAt: new Date() },
    ]);
    mockSynthModel.mockResolvedValue({ evidence: { coverage_score: 0.5 } });
    mockChatCreate.mockRejectedValue(new Error("llm down"));

    await expect(dialecticQuery({ userId: "u1", projectId: "p1", query: "q" })).rejects.toThrow("llm down");
  });

  it("prefers semantically relevant memories over high-importance ones", async () => {
    mockLoadMemories.mockResolvedValue([
      { id: "important", content: "Works at Stripe", memoryType: "factual", importance: 0.9, updatedAt: new Date() },
    ]);
    mockSynthModel.mockResolvedValue({ evidence: { coverage_score: 0.5 } });
    mockSearchMemories.mockResolvedValue([
      { memory: { id: "font1", content: "Prefers JetBrains Mono", memoryType: "preference" }, similarity: 0.9 },
    ]);
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: "The user prefers JetBrains Mono." } }] });

    const result = await dialecticQuery({ userId: "u1", projectId: "p1", query: "editor font?" });

    const userPrompt = mockChatCreate.mock.calls[0][0].messages.find((m: any) => m.role === "user").content;
    expect(userPrompt).toContain("JetBrains Mono");
    expect(userPrompt).not.toContain("Works at Stripe");
    expect(result.answer).toBe("The user prefers JetBrains Mono.");
  });
});
