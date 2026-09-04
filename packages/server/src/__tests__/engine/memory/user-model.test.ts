import { describe, it, expect } from "vitest";
import {
  extractName,
  extractRole,
  collectPreferences,
  collectGoals,
  deriveWorkingStyle,
  collectFrequentEntities,
  computeCoverage,
  computeTrustLevel,
} from "../../../engine/memory/user-model.js";
import type { MemoryRecord } from "../../../engine/memory/user-model.js";

function mem(partial: Partial<MemoryRecord> & { content: string }): MemoryRecord {
  return {
    id: partial.id ?? "m",
    content: partial.content,
    memoryType: partial.memoryType ?? "factual",
    confidence: partial.confidence ?? 0.8,
    importance: partial.importance ?? 0.5,
    entityMentions: partial.entityMentions ?? [],
    createdAt: partial.createdAt ?? new Date(),
    updatedAt: partial.updatedAt ?? new Date(),
    lastAccessedAt: partial.lastAccessedAt ?? null,
    metadata: partial.metadata ?? {},
  };
}

describe("user-model: extractName", () => {
  it("extracts a name from 'my name is'", () => {
    expect(extractName([mem({ content: "My name is John Smith" })])).toBe("John Smith");
  });

  it("returns null when no name is present", () => {
    expect(extractName([mem({ content: "I like TypeScript" })])).toBeNull();
  });
});

describe("user-model: extractRole", () => {
  it("extracts a role from 'i am'", () => {
    expect(extractRole([mem({ content: "I am a backend engineer" })])).toBe("backend engineer");
  });

  it("returns null when no role is present", () => {
    expect(extractRole([mem({ content: "prefers dark mode" })])).toBeNull();
  });
});

describe("user-model: collectPreferences", () => {
  it("collects only preference/instruction/opinion types", () => {
    const prefs = collectPreferences([
      mem({ content: "Prefers dark mode", memoryType: "preference" }),
      mem({ content: "Use bullets", memoryType: "instruction" }),
      mem({ content: "Likes React", memoryType: "opinion" }),
      mem({ content: "Works at Stripe", memoryType: "factual" }),
    ]);
    expect(prefs).toHaveLength(3);
    expect(prefs).toContain("Prefers dark mode");
    expect(prefs).not.toContain("Works at Stripe");
  });
});

describe("user-model: collectGoals", () => {
  it("collects goal/project_state/workflow/decision types", () => {
    const goals = collectGoals([
      mem({ content: "Ship MVP", memoryType: "goal" }),
      mem({ content: "Use Bun", memoryType: "decision" }),
      mem({ content: "Prefers dark mode", memoryType: "preference" }),
    ]);
    expect(goals).toContain("Ship MVP");
    expect(goals).toContain("Use Bun");
    expect(goals).not.toContain("Prefers dark mode");
  });
});

describe("user-model: deriveWorkingStyle", () => {
  it("detects concise + structured descriptors", () => {
    expect(deriveWorkingStyle(["be concise"], [], [])).toContain("concise");
    expect(deriveWorkingStyle(["use bullet lists"], [], [])).toContain("structured");
  });

  it("returns null when no descriptor matches", () => {
    expect(deriveWorkingStyle(["random text"], [], [])).toBeNull();
  });
});

describe("user-model: collectFrequentEntities", () => {
  it("counts, sorts, and excludes generic entities", () => {
    const entities = collectFrequentEntities([
      mem({ entityMentions: ["Stripe", "user"] }),
      mem({ entityMentions: ["Stripe", "TypeScript"] }),
    ]);
    expect(entities[0]).toBe("Stripe");
    expect(entities).not.toContain("user");
  });
});

describe("user-model: computeCoverage", () => {
  it("is higher for a populated profile than an empty one", () => {
    const full = computeCoverage([mem({ content: "x" }), mem({ content: "y" })], {
      name: "John",
      role: "dev",
      preferences: ["a"],
      current_goals: ["b"],
      working_style: "concise",
      frequent_entities: ["Stripe"],
    });
    const empty = computeCoverage([], {
      name: null,
      role: null,
      preferences: [],
      current_goals: [],
      working_style: null,
      frequent_entities: [],
    });
    expect(full).toBeGreaterThan(empty);
  });
});

describe("user-model: computeTrustLevel", () => {
  it("returns 0 for empty memories", () => {
    expect(computeTrustLevel([], 1)).toBe(0);
  });

  it("returns a score in (0, 1] for non-empty memories", () => {
    const score = computeTrustLevel([mem({ content: "x", confidence: 0.9, importance: 0.9 })], 0.5);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
