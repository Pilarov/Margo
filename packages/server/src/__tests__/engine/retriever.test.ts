import { describe, it, expect } from "vitest";
import {
  uniqueStrings,
  reciprocalRankFusion,
  deduplicateResults,
  estimateTokens,
} from "../../engine/retriever.js";

function r(id: string, score: number, source: string): any {
  return { id, score, source, content: "content", metadata: {} };
}

describe("retriever: uniqueStrings", () => {
  it("dedupes, trims, and drops empties", () => {
    expect(uniqueStrings(["a", "b", "a", " c ", "", null, undefined])).toEqual(["a", "b", "c"]);
  });
});

describe("retriever: estimateTokens", () => {
  it("uses ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("retriever: deduplicateResults", () => {
  it("keeps the highest score per id", () => {
    const results = [r("x", 0.9, "vector"), r("x", 0.7, "bm25"), r("y", 0.5, "vector")];
    const deduped = deduplicateResults(results);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((d) => d.id === "x").score).toBe(0.9);
  });
});

describe("retriever: reciprocalRankFusion", () => {
  it("ranks results present in both vector and bm25 higher, marking them hybrid", () => {
    const results = [
      r("shared", 0.8, "vector"),
      r("vecOnly", 0.6, "vector"),
      r("shared", 0.7, "bm25"),
    ];
    const fused = reciprocalRankFusion(results, 1, 1);
    expect(fused[0].id).toBe("shared");
    expect(fused[0].source).toBe("hybrid");
  });

  it("preserves non-vector/bm25 results with a reduced score", () => {
    const results = [r("graph1", 0.9, "graph")];
    const fused = reciprocalRankFusion(results, 1, 1);
    expect(fused).toHaveLength(1);
    expect(fused[0].source).toBe("graph");
  });
});
