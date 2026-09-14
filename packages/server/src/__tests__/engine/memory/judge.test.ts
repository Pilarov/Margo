import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChatCreate } = vi.hoisted(() => ({
  mockChatCreate: vi.fn(),
}));

vi.mock("../../../engine/llm-client.js", () => ({
  getLLMClient: () => ({ chat: { completions: { create: mockChatCreate } } }),
}));

vi.mock("../../../config.js", () => ({
  llm: { dialectic: { model: "gpt-5.4-mini" } },
}));

import {
  judgeAnswer,
  parseJudgeResponse,
  buildJudgeUserPrompt,
} from "../../../engine/memory/judge.js";

describe("judgeAnswer", () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
  });

  it("returns the parsed verdict from the LLM", async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"correct": true, "score": 0.9, "reason": "matches"}' } }],
    });

    const result = await judgeAnswer({ question: "q", referenceAnswer: "r", candidateAnswer: "c" });

    expect(result).toEqual({ correct: true, score: 0.9, reason: "matches" });
  });

  it("calls the LLM with temperature 0 and json_object format", async () => {
    mockChatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"correct": false, "score": 0, "reason": "x"}' } }],
    });

    await judgeAnswer({ question: "q", referenceAnswer: "r", candidateAnswer: "c", anchors: ["a"] });

    const call = mockChatCreate.mock.calls[0][0];
    expect(call.temperature).toBe(0);
    expect(call.response_format).toEqual({ type: "json_object" });
  });

  it("parses a fenced JSON response", () => {
    const result = parseJudgeResponse('```json\n{"correct": true, "score": 0.5, "reason": "ok"}\n```');
    expect(result.correct).toBe(true);
    expect(result.score).toBe(0.5);
  });

  it("throws on a response without JSON", () => {
    expect(() => parseJudgeResponse("no json here")).toThrow(/no JSON/);
  });

  it("includes anchors as hints in the prompt", () => {
    const prompt = buildJudgeUserPrompt({
      question: "Q",
      referenceAnswer: "R",
      candidateAnswer: "C",
      anchors: ["Friday", "semver"],
    });
    expect(prompt).toContain("ANCHORS");
    expect(prompt).toContain("Friday");
    expect(prompt).toContain("semver");
  });
});
