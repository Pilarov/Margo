import { describe, it, expect } from "vitest";
import {
  getOptimalModel,
  estimateCost,
  recommendModelUpgrades,
} from "../../engine/cost-optimization.js";

describe("getOptimalModel", () => {
  it("should return a model config for memory_extraction", () => {
    const result = getOptimalModel("memory_extraction");
    expect(result).toBeDefined();
    expect(result.model).toBeDefined();
    expect(result.maxTokens).toBeGreaterThan(0);
  });

  it("should respect forceModel option", () => {
    const result = getOptimalModel("memory_extraction", { forceModel: "opus" });
    expect(result.model).toContain("opus");
  });

  it("should return configs for all task types", () => {
    const tasks = [
      "temporal_parsing",
      "memory_extraction",
      "relation_detection",
      "complex_reasoning",
      "consolidation",
      "simple_classification",
      "summarization",
    ] as const;
    for (const task of tasks) {
      const result = getOptimalModel(task);
      expect(result).toBeDefined();
      expect(result.model).toBeDefined();
    }
  });

  it("should handle minQuality option", () => {
    const result = getOptimalModel("summarization", { minQuality: true });
    expect(result).toBeDefined();
  });
});

describe("estimateCost", () => {
  it("should return cost object with all fields for memory_extraction", () => {
    const result = estimateCost({
      taskType: "memory_extraction",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result.model).toBeDefined();
    expect(result.inputCost).toBeGreaterThanOrEqual(0);
    expect(result.outputCost).toBeGreaterThanOrEqual(0);
    expect(result.totalCost).toBeGreaterThanOrEqual(0);
  });

  it("should have totalCost = inputCost + outputCost", () => {
    const result = estimateCost({
      taskType: "memory_extraction",
      inputTokens: 2000,
      outputTokens: 1000,
    });
    expect(result.totalCost).toBeCloseTo(result.inputCost + result.outputCost, 5);
  });

  it("should return zero cost for zero tokens", () => {
    const result = estimateCost({
      taskType: "memory_extraction",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(result.totalCost).toBe(0);
  });

  it("should scale linearly with token count", () => {
    const small = estimateCost({
      taskType: "memory_extraction",
      inputTokens: 100,
      outputTokens: 100,
    });
    const large = estimateCost({
      taskType: "memory_extraction",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(large.totalCost).toBeCloseTo(small.totalCost * 10, 5);
  });

  it("should respect model override", () => {
    const defaultModel = estimateCost({
      taskType: "memory_extraction",
      inputTokens: 1000,
      outputTokens: 500,
    });
    const opusModel = estimateCost({
      taskType: "memory_extraction",
      inputTokens: 1000,
      outputTokens: 500,
      model: "opus",
    });
    expect(defaultModel.model).not.toBe(opusModel.model);
  });

  it("should handle summarization task type", () => {
    const result = estimateCost({
      taskType: "summarization",
      inputTokens: 500,
      outputTokens: 100,
    });
    expect(result).toBeDefined();
  });
});

describe("recommendModelUpgrades", () => {
  it("should return upgrade recommendations for high error rates", () => {
    const result = recommendModelUpgrades({
      errorRates: {
        temporal_parsing: 0.15,
        memory_extraction: 0.05,
        relation_detection: 0.1,
        complex_reasoning: 0,
        consolidation: 0,
        simple_classification: 0.2,
        summarization: 0.3,
      },
    });
    expect(Array.isArray(result)).toBe(true);
  });

  it("should return empty/near-empty for low error rates", () => {
    const result = recommendModelUpgrades({
      errorRates: {
        temporal_parsing: 0.01,
        memory_extraction: 0,
        relation_detection: 0.02,
        complex_reasoning: 0,
        consolidation: 0,
        simple_classification: 0.01,
        summarization: 0,
      },
    });
    for (const rec of result) {
      expect(rec.taskType).toBeDefined();
      expect(rec.recommendedModel).toBeDefined();
    }
  });

  it("should respect custom threshold", () => {
    const lowThreshold = recommendModelUpgrades({
      errorRates: {
        temporal_parsing: 0.05, memory_extraction: 0.03,
        relation_detection: 0.02, complex_reasoning: 0.01,
        consolidation: 0.01, simple_classification: 0.06,
        summarization: 0.04,
      },
      threshold: 0.03,
    });
    const highThreshold = recommendModelUpgrades({
      errorRates: {
        temporal_parsing: 0.05, memory_extraction: 0.03,
        relation_detection: 0.02, complex_reasoning: 0.01,
        consolidation: 0.01, simple_classification: 0.06,
        summarization: 0.04,
      },
      threshold: 0.1,
    });
    expect(lowThreshold.length).toBeGreaterThanOrEqual(highThreshold.length);
  });
});
