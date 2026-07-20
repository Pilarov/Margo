import { describe, it, expect } from "vitest";
import {
  parseTemporalLocal,
  parseTemporalFast,
  decideTemporalFilter,
} from "../../../engine/memory/temporal-local.js";

describe("Temporal: parseTemporalLocal", () => {
  const now = new Date("2026-07-20T12:00:00Z");

  it("should parse 'yesterday'", () => {
    const result = parseTemporalLocal("what happened yesterday", now);
    expect(result.hasConstraint).toBe(true);
    expect(result.relative).toBeDefined();
  });

  it("should parse 'today'", () => {
    const result = parseTemporalLocal("what happened today", now);
    expect(result.hasConstraint).toBe(true);
  });

  it("should parse 'last week'", () => {
    const result = parseTemporalLocal("decisions from last week", now);
    expect(result.hasConstraint).toBe(true);
  });

  it("should parse '3 days ago'", () => {
    const result = parseTemporalLocal("memories from 3 days ago", now);
    expect(result.hasConstraint).toBe(true);
    expect(result.relative).toBeDefined();
  });

  it("should parse 'last month'", () => {
    const result = parseTemporalLocal("summary of last month", now);
    expect(result.hasConstraint).toBe(true);
  });

  it("should parse ISO date", () => {
    const result = parseTemporalLocal("events on 2025-01-15", now);
    expect(result.hasConstraint).toBe(true);
  });

  it("should return no constraint for non-temporal query", () => {
    const result = parseTemporalLocal("what is TypeScript", now);
    expect(result.hasConstraint).toBe(false);
  });

  it("should handle empty query", () => {
    const result = parseTemporalLocal("", now);
    expect(result.hasConstraint).toBe(false);
  });

  it("should include confidence score", () => {
    const result = parseTemporalLocal("yesterday", now);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("should set parsedFrom for matched patterns", () => {
    const result = parseTemporalLocal("yesterday", now);
    expect(result.parsedFrom).toBeDefined();
  });

  it("should provide dateRange for yesterday", () => {
    const result = parseTemporalLocal("yesterday decisions", now);
    expect(result.dateRange).toBeDefined();
    expect(result.dateRange!.start).toBeInstanceOf(Date);
    expect(result.dateRange!.end).toBeInstanceOf(Date);
  });
});

describe("Temporal: decideTemporalFilter", () => {
  const now = new Date("2026-07-20T12:00:00Z");

  it("should produce filter from parsed result", () => {
    const parsed = parseTemporalLocal("yesterday", now);
    const filter = decideTemporalFilter(parsed);
    expect(filter.hasTemporalConstraint).toBe(true);
    expect(filter.dateRange).toBeDefined();
  });

  it("should return no constraint for non-temporal parsed", () => {
    const parsed = parseTemporalLocal("hello world", now);
    const filter = decideTemporalFilter(parsed);
    expect(filter.hasTemporalConstraint).toBe(false);
  });
});

describe("Temporal: parseTemporalFast", () => {
  const now = new Date("2026-07-20T12:00:00Z");

  it("should return filter with constraint for temporal query", () => {
    const filter = parseTemporalFast("yesterday", now);
    expect(filter.hasTemporalConstraint).toBe(true);
  });

  it("should return filter without constraint for non-temporal query", () => {
    const filter = parseTemporalFast("TypeScript features", now);
    expect(filter.hasTemporalConstraint).toBe(false);
  });
});
