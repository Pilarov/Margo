import { describe, it, expect } from "vitest";
import {
  buildInductivePrompt,
  parseInductiveResponse,
  buildPeerCardPrompt,
  parsePeerCardResponse,
  estimateTokens,
} from "../../../engine/memory/dreamer.js";

const SAMPLE = [
  { id: "m1", content: "User prefers TypeScript", memoryType: "preference", confidence: 0.8 },
  { id: "m2", content: "User chose TypeScript for new project", memoryType: "decision", confidence: 0.85 },
  { id: "m3", content: "User migrated JS to TS", memoryType: "event", confidence: 0.75 },
];

describe("dreamer: buildInductivePrompt", () => {
  it("mentions every memory content, type, and id", () => {
    const prompt = buildInductivePrompt(SAMPLE);
    for (const m of SAMPLE) {
      expect(prompt).toContain(m.content);
      expect(prompt).toContain(m.memoryType);
      expect(prompt).toContain(m.id);
    }
  });

  it("instructs the model to find recurring patterns and return a patterns array", () => {
    const prompt = buildInductivePrompt(SAMPLE);
    expect(prompt.toLowerCase()).toContain("pattern");
    expect(prompt).toContain("patterns");
  });
});

describe("dreamer: parseInductiveResponse", () => {
  it("parses valid JSON into InductivePattern[]", () => {
    const text = JSON.stringify({
      patterns: [
        {
          content: "User strongly prefers TypeScript",
          memoryType: "preference",
          confidence: 0.92,
          evidence: ["m1", "m2", "m3"],
          reasoning: "recurring across sessions",
        },
      ],
    });
    const result = parseInductiveResponse(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      content: "User strongly prefers TypeScript",
      memoryType: "preference",
      confidence: 0.92,
      evidence: ["m1", "m2", "m3"],
    });
  });

  it("strips markdown fences", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        patterns: [
          { content: "User prefers dark mode", memoryType: "preference", confidence: 0.9, evidence: [] },
        ],
      }) +
      "\n```";
    const result = parseInductiveResponse(text);
    expect(result).toHaveLength(1);
    expect(result[0].memoryType).toBe("preference");
  });

  it("drops invalid items (too-short content, out-of-range confidence)", () => {
    const text = JSON.stringify({
      patterns: [
        { content: "short", memoryType: "preference", confidence: 0.9, evidence: [] },
        { content: "Valid pattern about the user preference", memoryType: "preference", confidence: 2.0, evidence: [] },
        { content: "Another valid pattern about the user", memoryType: "preference", confidence: 0.8, evidence: [] },
      ],
    });
    const result = parseInductiveResponse(text);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Another valid pattern about the user");
  });

  it("returns [] for invalid JSON", () => {
    expect(parseInductiveResponse("not json")).toEqual([]);
  });
});

describe("dreamer: peer-card", () => {
  it("buildPeerCardPrompt mentions memory contents", () => {
    const prompt = buildPeerCardPrompt(SAMPLE);
    for (const m of SAMPLE) expect(prompt).toContain(m.content);
  });

  it("parsePeerCardResponse extracts the profile string", () => {
    const text = JSON.stringify({ profile: "TypeScript developer who prefers concise answers" });
    expect(parsePeerCardResponse(text)).toBe("TypeScript developer who prefers concise answers");
  });

  it("parsePeerCardResponse returns '' for invalid input", () => {
    expect(parsePeerCardResponse("garbage")).toBe("");
    expect(parsePeerCardResponse(JSON.stringify({ nope: true }))).toBe("");
  });

  it("estimateTokens keeps a reasonable peer-card under 500 tokens", () => {
    const profile = "TypeScript developer who prefers concise bullet-point answers and deploys on Fridays. ".repeat(5);
    expect(estimateTokens(profile)).toBeLessThanOrEqual(500);
  });
});
