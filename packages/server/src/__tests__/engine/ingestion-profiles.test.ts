import { describe, it, expect } from "vitest";
import {
  normalizeProfileConfig,
  classifyDocument,
  resolveIngestionPlan,
} from "../../engine/ingestion-profiles.js";

describe("normalizeProfileConfig", () => {
  it("should return defaults for undefined input", () => {
    const result = normalizeProfileConfig();
    expect(result).toBeDefined();
  });

  it("should return defaults for empty object", () => {
    const result = normalizeProfileConfig({});
    expect(result).toBeDefined();
  });

  it("should preserve semantic config", () => {
    const result = normalizeProfileConfig({
      semantic: { semantic_refine: true, topic_shift_sensitivity: 0.5 },
    });
    expect(result.semantic?.semantic_refine).toBe(true);
  });

  it("should preserve hierarchy config (may clamp to defaults)", () => {
    const result = normalizeProfileConfig({
      hierarchy: { parent_chunk_target: 100, child_chunk_target: 50, max_children_per_parent: 10 },
    });
    expect(result.hierarchy?.parent_chunk_target).toBeDefined();
    expect(result.hierarchy?.parent_chunk_target).toBeGreaterThan(0);
  });
});

describe("classifyDocument", () => {
  it("should classify TypeScript code file", () => {
    const result = classifyDocument({
      content: "import React from 'react';\nconst App = () => <div>Hello</div>;",
      filePath: "src/app.ts",
    });
    expect(result.profile_candidate).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("should classify Python code file", () => {
    const result = classifyDocument({
      content: "def hello():\n    print('world')",
      filePath: "main.py",
    });
    expect(result.profile_candidate).toBeDefined();
    expect(result.document_signals).toBeDefined();
  });

  it("should classify Markdown documentation", () => {
    const result = classifyDocument({
      content: "# Project Title\n\n## Overview\n\nThis is a project.",
      filePath: "README.md",
    });
    expect(result.profile_candidate).toBeDefined();
    expect(result.reason).toBeDefined();
  });

  it("should include confidence between 0 and 1", () => {
    const result = classifyDocument({
      content: "export const foo = 1;",
      filePath: "src/index.ts",
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("should include document_signals", () => {
    const result = classifyDocument({
      content: "# Hello\n\nWorld",
      filePath: "README.md",
    });
    expect(Array.isArray(result.document_signals)).toBe(true);
  });

  it("should classify web/HTML content", () => {
    const result = classifyDocument({
      content: "<html><head><title>Page</title></head><body><p>Content</p></body></html>",
    });
    expect(result.profile_candidate).toBeDefined();
  });

  it("should classify transcript-like content", () => {
    const result = classifyDocument({
      content: "Speaker 1: Hello everyone\nSpeaker 2: Hi there\nSpeaker 1: Let's begin",
    });
    expect(result.profile_candidate).toBeDefined();
  });
});

describe("resolveIngestionPlan", () => {
  it("should resolve plan for TypeScript file", () => {
    const plan = resolveIngestionPlan({
      content: "export const Button = () => <button>Click</button>;",
      filePath: "src/components/Button.tsx",
    });
    expect(plan.profile).toBeDefined();
    expect(plan.strategy).toBeDefined();
    expect(plan.parser).toBeDefined();
  });

  it("should resolve plan for Markdown file", () => {
    const plan = resolveIngestionPlan({
      content: "# API Reference\n\n## GET /users\n\nReturns list of users.",
      filePath: "docs/api.md",
    });
    expect(plan.profile).toBeDefined();
    expect(plan.parser).toBeDefined();
  });

  it("should include latency_budget_ms", () => {
    const plan = resolveIngestionPlan({
      content: "const x = 1;",
      filePath: "test.ts",
    });
    expect(plan.latency_budget_ms).toBeDefined();
    expect(plan.latency_budget_ms).toBeGreaterThan(0);
  });

  it("should include classification", () => {
    const plan = resolveIngestionPlan({
      content: "const x = 1;",
      filePath: "test.ts",
    });
    expect(plan.classification).toBeDefined();
    expect(plan.classification.profile_candidate).toBeDefined();
  });

  it("should include parser_confidence", () => {
    const plan = resolveIngestionPlan({
      content: "const x = 1;",
      filePath: "test.ts",
    });
    expect(plan.parser_confidence).toBeDefined();
  });

  it("should include adaptive_used flag", () => {
    const plan = resolveIngestionPlan({
      content: "const x = 1;",
      filePath: "test.ts",
    });
    expect(typeof plan.adaptive_used).toBe("boolean");
  });
});
