import { describe, it, expect } from "vitest";
import {
  stableHash,
  normalizeBaseUrl,
  normalizeEndpoint,
  normalizeQuery,
} from "../../core/utils.js";

describe("SDK Utils", () => {
  describe("stableHash", () => {
    it("should produce deterministic output for same input", () => {
      const a = stableHash("hello world");
      const b = stableHash("hello world");
      expect(a).toBe(b);
    });

    it("should produce different hashes for different inputs", () => {
      expect(stableHash("hello")).not.toBe(stableHash("world"));
    });

    it("should handle empty string", () => {
      expect(stableHash("")).toBeTypeOf("string");
      expect(stableHash("").length).toBeGreaterThan(0);
    });

    it("should handle unicode", () => {
      const h = stableHash("привет мир");
      expect(h).toBeTypeOf("string");
      expect(h).toBe(stableHash("привет мир"));
    });

    it("should produce consistent length", () => {
      const h1 = stableHash("a");
      const h2 = stableHash("a".repeat(10000));
      expect(h1.length).toBe(h2.length);
    });

    it("should not collide on similar strings", () => {
      expect(stableHash("abc")).not.toBe(stableHash("abd"));
    });
  });

  describe("normalizeBaseUrl", () => {
    it("should strip trailing slash", () => {
      expect(normalizeBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    });

    it("should strip multiple trailing slashes", () => {
      expect(normalizeBaseUrl("http://localhost:3000///")).toBe("http://localhost:3000");
    });

    it("should keep URL without trailing slash unchanged", () => {
      expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    });

    it("should handle empty string", () => {
      expect(normalizeBaseUrl("")).toBe("");
    });

    it("should handle https and strip API path suffixes", () => {
      // normalizeBaseUrl strips trailing slashes AND /api/v1, /v1, /api suffixes
      expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com");
      expect(normalizeBaseUrl("https://api.example.com/api/v1")).toBe("https://api.example.com");
      expect(normalizeBaseUrl("https://api.example.com/api")).toBe("https://api.example.com");
    });
  });

  describe("normalizeEndpoint", () => {
    it("should ensure leading slash", () => {
      expect(normalizeEndpoint("v1/memory")).toBe("/v1/memory");
    });

    it("should keep leading slash if present", () => {
      expect(normalizeEndpoint("/v1/memory")).toBe("/v1/memory");
    });

    it("should keep trailing slash (normalizeEndpoint does not strip)", () => {
      expect(normalizeEndpoint("/v1/memory/")).toBe("/v1/memory/");
    });

    it("should handle empty string", () => {
      expect(normalizeEndpoint("")).toBe("/");
    });

    it("should handle root endpoint", () => {
      expect(normalizeEndpoint("/")).toBe("/");
    });
  });

  describe("normalizeQuery", () => {
    it("should trim whitespace", () => {
      expect(normalizeQuery("  hello world  ")).toBe("hello world");
    });

    it("should collapse multiple whitespace", () => {
      expect(normalizeQuery("hello   world")).toBe("hello world");
    });

    it("should lowercase", () => {
      expect(normalizeQuery("HELLO World")).toBe("hello world");
    });

    it("should handle empty string", () => {
      expect(normalizeQuery("")).toBe("");
    });

    it("should handle tabs and newlines", () => {
      expect(normalizeQuery("hello\t\nworld")).toBe("hello world");
    });
  });
});
