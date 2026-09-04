import { describe, it, expect } from "vitest";
import {
  extractPersona,
  collectInstructions,
  collectCapabilities,
  deriveWorkingStyle,
  collectGoals,
  computeCoverage,
} from "../../../engine/memory/agent-model.js";
import type { AgentMemoryRecord, AgentSelfModel } from "../../../engine/memory/agent-model.js";

function mem(partial: Partial<AgentMemoryRecord> & { content: string }): AgentMemoryRecord {
  return {
    id: partial.id ?? "m",
    content: partial.content,
    memoryType: partial.memoryType ?? "factual",
    confidence: partial.confidence ?? 0.8,
    importance: partial.importance ?? 0.5,
    entityMentions: partial.entityMentions ?? [],
    createdAt: partial.createdAt ?? new Date(),
    updatedAt: partial.updatedAt ?? new Date(),
  };
}

describe("agent-model: extractPersona", () => {
  it("extracts persona from 'i am'", () => {
    expect(extractPersona([mem({ content: "I am a helpful assistant that values clarity" })])).toBe(
      "a helpful assistant that values clarity"
    );
  });

  it("returns null when no persona is present", () => {
    expect(extractPersona([mem({ content: "random fact" })])).toBeNull();
  });
});

describe("agent-model: collectInstructions", () => {
  it("collects instruction/preference types only", () => {
    const instructions = collectInstructions([
      mem({ content: "Always use formal tone", memoryType: "instruction" }),
      mem({ content: "Prefer bullet answers", memoryType: "preference" }),
      mem({ content: "Works at Stripe", memoryType: "factual" }),
    ]);
    expect(instructions).toContain("Always use formal tone");
    expect(instructions).not.toContain("Works at Stripe");
  });
});

describe("agent-model: collectCapabilities", () => {
  it("collects 'can ...' capabilities, skips plain facts", () => {
    const caps = collectCapabilities([
      mem({ content: "I can write TypeScript" }),
      mem({ content: "just a fact" }),
    ]);
    expect(caps).toContain("I can write TypeScript");
    expect(caps).not.toContain("just a fact");
  });
});

describe("agent-model: deriveWorkingStyle", () => {
  it("detects a concise style", () => {
    expect(deriveWorkingStyle([mem({ content: "be concise" })])).toContain("concise");
  });

  it("returns null when no descriptor matches", () => {
    expect(deriveWorkingStyle([mem({ content: "random" })])).toBeNull();
  });
});

describe("agent-model: collectGoals", () => {
  it("collects goal/decision/workflow types", () => {
    const goals = collectGoals([
      mem({ content: "Ship MVP", memoryType: "goal" }),
      mem({ content: "prefers dark mode", memoryType: "preference" }),
    ]);
    expect(goals).toContain("Ship MVP");
    expect(goals).not.toContain("prefers dark mode");
  });
});

describe("agent-model: computeCoverage", () => {
  it("rates a populated model higher than an empty one", () => {
    const full: AgentSelfModel = {
      agent_id: "a",
      persona: "helper",
      persistent_instructions: ["x"],
      capabilities: ["can code"],
      working_style: "concise",
      goals: ["ship"],
      memory_count: 8,
      last_updated: null,
      coverage_score: 0,
    };
    const empty: AgentSelfModel = {
      agent_id: "a",
      persona: null,
      persistent_instructions: [],
      capabilities: [],
      working_style: null,
      goals: [],
      memory_count: 0,
      last_updated: null,
      coverage_score: 0,
    };
    expect(computeCoverage(full)).toBeGreaterThan(computeCoverage(empty));
  });
});
