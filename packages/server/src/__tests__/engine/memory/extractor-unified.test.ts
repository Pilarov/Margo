import { describe, it, expect } from "vitest";
import {
  shouldExtractMemory,
  chunkMessage,
  normalizeDedupeKey,
  deduplicateAndMerge,
  buildSessionEntityMap,
} from "../../../engine/memory/extractor-unified.js";
import type { ExtractedMemory } from "../../../engine/memory/types.js";

function mem(partial: Partial<ExtractedMemory> & { content: string }): ExtractedMemory {
  return {
    content: partial.content,
    memoryType: partial.memoryType ?? "factual",
    entityMentions: partial.entityMentions ?? [],
    eventDate: partial.eventDate ?? null,
    confidence: partial.confidence ?? 0.7,
    inferred: partial.inferred,
  };
}

describe("extractor-unified: shouldExtractMemory", () => {
  it("rejects greetings and one-word replies", () => {
    expect(shouldExtractMemory("hi")).toBe(false);
    expect(shouldExtractMemory("thanks")).toBe(false);
    expect(shouldExtractMemory("ok")).toBe(false);
  });

  it("accepts meaningful messages", () => {
    expect(shouldExtractMemory("I prefer TypeScript for new projects")).toBe(true);
  });
});

describe("extractor-unified: chunkMessage", () => {
  it("returns a single chunk for short messages", () => {
    expect(chunkMessage("hello world")).toEqual(["hello world"]);
  });

  it("splits long messages into bounded chunks", () => {
    const long = "a".repeat(4000);
    const chunks = chunkMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1800)).toBe(true);
  });
});

describe("extractor-unified: normalizeDedupeKey", () => {
  it("removes stop words and sorts significant words", () => {
    expect(normalizeDedupeKey("preference", "Works at Stripe")).toBe("preference:stripe:works");
  });

  it("is order-insensitive", () => {
    const a = normalizeDedupeKey("factual", "Works at Stripe");
    const b = normalizeDedupeKey("factual", "Stripe works at");
    expect(a).toBe(b);
  });
});

describe("extractor-unified: deduplicateAndMerge", () => {
  it("merges duplicates and keeps the higher confidence", () => {
    const a = mem({ content: "Works at Stripe", memoryType: "factual", confidence: 0.7, entityMentions: ["Stripe"] });
    const b = mem({ content: "Stripe works at", memoryType: "factual", confidence: 0.9, entityMentions: ["Stripe"] });
    const result = deduplicateAndMerge([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
  });

  it("keeps distinct memories separate", () => {
    const a = mem({ content: "Works at Stripe", memoryType: "factual" });
    const b = mem({ content: "Prefers dark mode", memoryType: "preference" });
    expect(deduplicateAndMerge([a, b])).toHaveLength(2);
  });

  it("unions entity mentions when merging", () => {
    const a = mem({ content: "Works at Stripe", entityMentions: ["Stripe"] });
    const b = mem({ content: "Stripe works at", entityMentions: ["Payments"] });
    const result = deduplicateAndMerge([a, b]);
    expect(result[0].entityMentions).toEqual(expect.arrayContaining(["Stripe", "Payments"]));
  });
});

describe("extractor-unified: buildSessionEntityMap", () => {
  it("maps pronouns to the most-mentioned name", () => {
    const map = buildSessionEntityMap([
      "Alice said she likes TypeScript",
      "Alice is working on the backend",
      "she prefers pnpm",
    ]);
    expect(map.get("she")).toBe("Alice");
  });
});
