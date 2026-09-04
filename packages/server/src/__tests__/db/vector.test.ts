import { describe, it, expect } from "vitest";
import { dimensionCheck, toVectorLiteral, embeddingToSql } from "../../db/vector.js";

describe("db/vector: dimensionCheck", () => {
  it("accepts the correct length", () => {
    expect(dimensionCheck([1, 2, 3], 3)).toBe(true);
  });

  it("rejects a wrong length", () => {
    expect(dimensionCheck([1, 2], 3)).toBe(false);
  });

  it("rejects non-finite entries", () => {
    expect(dimensionCheck([1, Number.NaN, 3], 3)).toBe(false);
  });

  it("rejects non-array input", () => {
    expect(dimensionCheck("x" as any, 3)).toBe(false);
  });
});

describe("db/vector: toVectorLiteral", () => {
  it("formats a bracket-enclosed comma list", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("handles an empty vector", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });
});

describe("db/vector: embeddingToSql", () => {
  it("appends the ::vector cast", () => {
    expect(embeddingToSql([0.1, 0.2])).toBe("[0.1,0.2]::vector");
  });
});
