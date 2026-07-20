import { describe, it, expect } from "vitest";
import {
  buildMemoryNormalizationFields,
  mergeMemoryNormalizationMetadata,
  expandMemorySearchQueries,
  getMemorySemanticStatus,
} from "../../lib/memory-normalization.js";

describe("Memory Normalization: buildMemoryNormalizationFields", () => {
  it("should produce normalized content", () => {
    const result = buildMemoryNormalizationFields("  Hello   World  ");
    expect(result.normalized_content).toBe("hello world");
  });

  it("should produce canonical content with first-person conversion", () => {
    const result = buildMemoryNormalizationFields("I am a developer");
    expect(result.canonical_content.length).toBeGreaterThan(0);
    // FIRST_PERSON_CANONICAL: "I am" -> "the user is"
    expect(result.canonical_content).toContain("the user");
  });

  it("should produce at least one search variant", () => {
    const result = buildMemoryNormalizationFields("I prefer dark mode");
    expect(result.search_variants.length).toBeGreaterThan(0);
  });

  it("should have semantic_status as pending (always)", () => {
    const result = buildMemoryNormalizationFields("Hello world");
    expect(result.semantic_status).toBe("pending");
  });

  it("should set search_text to joined variants", () => {
    const result = buildMemoryNormalizationFields("test content");
    expect(result.search_text.length).toBeGreaterThan(0);
  });

  it("should handle empty string", () => {
    const result = buildMemoryNormalizationFields("");
    expect(result.normalized_content).toBe("");
    expect(result.search_variants).toBeDefined();
  });

  it("should include third-person variants in search_variants", () => {
    const result = buildMemoryNormalizationFields("he prefers TypeScript");
    // Third-person conversion is in search_variants, not canonical_content
    const hasUser = result.search_variants.some((v) => v.includes("user"));
    expect(hasUser).toBe(true);
  });

  it("should deduplicate search variants", () => {
    const result = buildMemoryNormalizationFields("I am I am I am");
    const unique = new Set(result.search_variants);
    expect(unique.size).toBe(result.search_variants.length);
  });

  it("should handle term expansions", () => {
    const result = buildMemoryNormalizationFields("my gf likes Python");
    const variants = result.search_variants;
    expect(variants.some((v) => v.includes("girlfriend"))).toBe(true);
  });
});

describe("Memory Normalization: mergeMemoryNormalizationMetadata", () => {
  it("should merge normalization fields into metadata", () => {
    const result = mergeMemoryNormalizationMetadata({ key: "value" }, "Hello world");
    expect((result as any).key).toBe("value");
    expect((result as any).normalized_content).toBeDefined();
    expect((result as any).search_variants).toBeDefined();
  });

  it("should handle null metadata", () => {
    const result = mergeMemoryNormalizationMetadata(null, "Hello world");
    expect(result.normalized_content).toBeDefined();
  });

  it("should handle undefined metadata", () => {
    const result = mergeMemoryNormalizationMetadata(undefined, "Hello world");
    expect(result.search_variants).toBeDefined();
  });

  it("should preserve existing metadata fields", () => {
    const original = { importance: 0.8, tags: ["important"] };
    const result = mergeMemoryNormalizationMetadata(original, "content");
    expect((result as any).importance).toBe(0.8);
    expect((result as any).tags).toEqual(["important"]);
  });
});

describe("Memory Normalization: expandMemorySearchQueries", () => {
  it("should return at least one variant", () => {
    const queries = expandMemorySearchQueries("TypeScript preferences");
    expect(queries.length).toBeGreaterThan(0);
  });

  it("should include normalized version of query", () => {
    const queries = expandMemorySearchQueries("  WHAT  IS  TYPESCRIPT  ");
    expect(queries.some((q) => q.includes("typescript"))).toBe(true);
  });

  it("should return empty array for empty string", () => {
    expect(expandMemorySearchQueries("")).toEqual([]);
  });

  it("should handle first-person queries", () => {
    const queries = expandMemorySearchQueries("I want to find my preferences");
    expect(queries.length).toBeGreaterThan(0);
  });
});

describe("Memory Normalization: getMemorySemanticStatus", () => {
  it("should return 'ready' for valid metadata", () => {
    expect(getMemorySemanticStatus({ semantic_status: "ready" })).toBe("ready");
  });

  it("should return 'pending' for missing status", () => {
    expect(getMemorySemanticStatus({})).toBe("pending");
  });

  it("should return 'pending' for null/undefined", () => {
    expect(getMemorySemanticStatus(null)).toBe("pending");
    expect(getMemorySemanticStatus(undefined)).toBe("pending");
  });

  it("should return 'pending' for non-object metadata", () => {
    expect(getMemorySemanticStatus("string")).toBe("pending");
  });
});
