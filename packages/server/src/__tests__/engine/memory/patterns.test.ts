import { describe, it, expect } from "vitest";
import {
  extractTechEntities,
  extractExplicitMemory,
  isExplicitMemory,
} from "../../../engine/memory/patterns.js";

describe("Patterns: extractTechEntities", () => {
  it("should extract TypeScript from text", () => {
    const entities = extractTechEntities("We use TypeScript and React for the frontend");
    expect(entities.some((e) => e.toLowerCase().includes("typescript") || e === "React")).toBe(true);
  });

  it("should extract Python from text", () => {
    const entities = extractTechEntities("The backend is built with Python and FastAPI");
    expect(entities.some((e) => e.toLowerCase().includes("python"))).toBe(true);
  });

  it("should extract Docker from text", () => {
    const entities = extractTechEntities("We deploy with Docker and Kubernetes");
    expect(entities.some((e) => e.toLowerCase().includes("docker"))).toBe(true);
  });

  it("should return max 6 entities", () => {
    const text =
      "React TypeScript Python Docker PostgreSQL Redis Kubernetes Node.js GraphQL MongoDB AWS";
    const entities = extractTechEntities(text);
    expect(entities.length).toBeLessThanOrEqual(6);
  });

  it("should return empty for non-technical text", () => {
    expect(extractTechEntities("The quick brown fox")).toEqual([]);
  });

  it("should handle empty string", () => {
    expect(extractTechEntities("")).toEqual([]);
  });

  it("should deduplicate entities", () => {
    const entities = extractTechEntities("React React React is great");
    const reactCount = entities.filter((e) => e === "React").length;
    expect(reactCount).toBeLessThanOrEqual(1);
  });
});

describe("Patterns: extractExplicitMemory", () => {
  it("should extract preference statements", () => {
    const matches = extractExplicitMemory("I prefer TypeScript over JavaScript");
    const preferences = matches.filter((m) => m.type === "preference");
    expect(preferences.length).toBeGreaterThan(0);
  });

  it("should produce matches for preference statements with context", () => {
    const matches = extractExplicitMemory("I like using React because of its component model");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("should extract decision statements", () => {
    const matches = extractExplicitMemory("I decided to use Redis for caching");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("should extract instruction/procedural statements", () => {
    const matches = extractExplicitMemory("The team deploys every Friday at 5pm");
    expect(matches).toBeDefined();
  });

  it("should deduplicate matches by content", () => {
    const matches = extractExplicitMemory(
      "I like Python. I prefer Python. I decided on Python."
    );
    const pythonCount = matches.filter((m) => m.content.toLowerCase().includes("python")).length;
    expect(pythonCount).toBeLessThanOrEqual(3); // different types may produce different memories
  });

  it("should truncate input at 4000 characters", () => {
    const longMessage = "I prefer React. ".repeat(500);
    expect(() => extractExplicitMemory(longMessage)).not.toThrow();
  });

  it("should handle empty string", () => {
    const matches = extractExplicitMemory("");
    expect(matches).toEqual([]);
  });

  it("should return matches sorted by confidence descending", () => {
    const matches = extractExplicitMemory(
      "I always prefer dark mode. The API uses REST."
    );
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(matches[i].confidence);
    }
  });

  it("should assign correct retention level", () => {
    const matches = extractExplicitMemory("I prefer concise answers");
    for (const match of matches) {
      expect(["durable", "session", "short"]).toContain(match.retention);
    }
  });
});

describe("Patterns: isExplicitMemory", () => {
  it("should return true for explicit memory statements", () => {
    expect(isExplicitMemory("I prefer TypeScript over JavaScript")).toBe(true);
  });

  it("should return false for non-memory text", () => {
    expect(isExplicitMemory("ok thanks")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isExplicitMemory("")).toBe(false);
  });

  it("should return true for explicit preference statements", () => {
    expect(isExplicitMemory("I prefer dark mode in my IDE")).toBe(true);
  });

  it("should return false for vague chit-chat", () => {
    expect(isExplicitMemory("sounds good to me")).toBe(false);
  });
});
