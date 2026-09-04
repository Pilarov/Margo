import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildMemoryBlock, LEVEL_CONFIG } from "../../../engine/memory/dialectic.js";

describe("dialectic: buildSystemPrompt", () => {
  it("minimal and low return the base prompt without citation", () => {
    const minimal = buildSystemPrompt("minimal");
    const low = buildSystemPrompt("low");
    expect(minimal).toContain("Be concise and factual");
    expect(minimal).not.toContain("cite");
    expect(low).toBe(minimal);
  });

  it("medium and high add citation + contradiction guidance", () => {
    for (const level of ["medium", "high"] as const) {
      const prompt = buildSystemPrompt(level);
      expect(prompt).toContain("cite");
      expect(prompt).toContain("contradictory");
    }
  });
});

describe("dialectic: buildMemoryBlock", () => {
  const mk = (content: string, importance: number, updatedAt: Date) => ({
    content,
    memoryType: "preference",
    importance,
    updatedAt,
  });

  it("sorts by importance desc, then recency", () => {
    const a = mk("low importance", 0.3, new Date("2026-01-03"));
    const b = mk("high importance", 0.9, new Date("2026-01-01"));
    const c = mk("mid importance", 0.5, new Date("2026-01-02"));
    const block = buildMemoryBlock([a, b, c], 10);
    const idxB = block.indexOf("high importance");
    const idxC = block.indexOf("mid importance");
    const idxA = block.indexOf("low importance");
    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxA);
  });

  it("caps output at maxMemories", () => {
    const memories = Array.from({ length: 10 }, (_, i) => mk(`mem ${i}`, 0.5, new Date()));
    const block = buildMemoryBlock(memories, 3);
    expect(block.split("\n")).toHaveLength(3);
  });

  it("formats each line as [index] (type) content", () => {
    const block = buildMemoryBlock([mk("User prefers dark mode", 0.8, new Date())], 5);
    expect(block).toBe("[1] (preference) User prefers dark mode");
  });
});

describe("dialectic: LEVEL_CONFIG", () => {
  it("scales maxMemories and maxTokens with reasoning level", () => {
    expect(LEVEL_CONFIG.minimal.maxMemories).toBeLessThan(LEVEL_CONFIG.low.maxMemories);
    expect(LEVEL_CONFIG.low.maxMemories).toBeLessThan(LEVEL_CONFIG.medium.maxMemories);
    expect(LEVEL_CONFIG.medium.maxMemories).toBeLessThan(LEVEL_CONFIG.high.maxMemories);
    expect(LEVEL_CONFIG.high.maxTokens).toBeGreaterThan(LEVEL_CONFIG.minimal.maxTokens);
  });
});
