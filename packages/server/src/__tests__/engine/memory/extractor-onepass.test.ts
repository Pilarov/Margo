import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("../../../engine/llm-client.js", () => ({
  getLLMClient: () => ({ chat: { completions: { create: mockCreate } } }),
}));

vi.mock("../../../config.js", () => ({
  llm: {
    defaultApiKey: "test-key",
    memoryExtraction: { model: "gpt-5.4-mini" },
  },
}));

import { extractMemoriesOnePass } from "../../../engine/memory/extractor-onepass.js";

function respond(memories: unknown) {
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ memories }) } }],
  });
}

const ALL_TYPES = [
  "factual", "preference", "decision", "constraint", "instruction", "goal",
  "event", "relationship", "opinion", "solution", "project_state", "correction", "workflow",
];

describe("extractMemoriesOnePass", () => {
  beforeEach(() => mockCreate.mockReset());

  it("makes a single LLM call and maps all extracted memories", async () => {
    respond([
      { content: "User prefers dark mode", memoryType: "preference", confidence: 0.9, entities: [] },
      { content: "Project standardized on Bun", memoryType: "decision", confidence: 0.85, entities: ["Bun"] },
    ]);

    const result = await extractMemoriesOnePass(
      "I prefer dark mode and we decided to use Bun.",
      "",
      { minConfidence: 0.5 }
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ content: "User prefers dark mode", memoryType: "preference", inferred: true });
    expect(result[1]).toMatchObject({ memoryType: "decision", entityMentions: ["Bun"] });
  });

  it("prompt enumerates all 13 memory types with descriptions", async () => {
    respond([]);
    await extractMemoriesOnePass("hello world", "", {});
    const args = mockCreate.mock.calls[0][0];
    const system = args.messages.find((m: any) => m.role === "system").content;
    for (const type of ALL_TYPES) {
      expect(system, `prompt should mention type "${type}"`).toContain(type);
    }
  });

  it("filters by minConfidence", async () => {
    respond([
      { content: "High confidence fact about the user", memoryType: "factual", confidence: 0.9, entities: [] },
      { content: "Weak signal not durable", memoryType: "opinion", confidence: 0.4, entities: [] },
    ]);
    const result = await extractMemoriesOnePass("some message here", "", { minConfidence: 0.6 });
    expect(result).toHaveLength(1);
    expect(result[0].memoryType).toBe("factual");
  });

  it("returns [] when the model produces no content", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
    const result = await extractMemoriesOnePass("hello world", "", {});
    expect(result).toEqual([]);
  });
});
