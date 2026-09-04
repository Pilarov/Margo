import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChatCreate } = vi.hoisted(() => ({ mockChatCreate: vi.fn() }));

vi.mock("../../../engine/llm-client.js", () => ({
  getLLMClient: () => ({ chat: { completions: { create: mockChatCreate } } }),
}));

vi.mock("../../../config.js", () => ({
  llm: { defaultApiKey: "test-key", inference: { model: "gpt-5.4-mini" } },
}));

import { extractImplicitMemories } from "../../../engine/memory/inference.js";

describe("extractImplicitMemories", () => {
  beforeEach(() => mockChatCreate.mockReset());

  it("makes one LLM call and maps inferred memories", async () => {
    mockChatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              memories: [
                { content: "User works at Stripe", memoryType: "factual", confidence: 0.9, entities: ["Stripe"] },
              ],
            }),
          },
        },
      ],
    });

    const result = await extractImplicitMemories("I work at Stripe as an engineer", "", { minConfidence: 0.5 });

    expect(mockChatCreate).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ content: "User works at Stripe", memoryType: "factual", inferred: true });
  });

  it("returns [] for very short messages", async () => {
    const result = await extractImplicitMemories("hi", "", {});
    expect(mockChatCreate).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns [] when the model returns no content", async () => {
    mockChatCreate.mockResolvedValue({ choices: [{ message: { content: null } }] });
    const result = await extractImplicitMemories("a sufficiently long message here", "", {});
    expect(result).toEqual([]);
  });

  it("filters by minConfidence", async () => {
    mockChatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              memories: [
                { content: "Strong durable fact here", memoryType: "factual", confidence: 0.9, entities: [] },
                { content: "Weak signal that is uncertain", memoryType: "opinion", confidence: 0.4, entities: [] },
              ],
            }),
          },
        },
      ],
    });
    const result = await extractImplicitMemories("some message about the user", "", { minConfidence: 0.7 });
    expect(result).toHaveLength(1);
    expect(result[0].memoryType).toBe("factual");
  });
});
