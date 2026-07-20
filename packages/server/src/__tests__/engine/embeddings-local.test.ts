import { describe, it, expect } from "vitest";
import { shouldUseLLMFallback } from "../../engine/embeddings-local.js";

describe("shouldUseLLMFallback", () => {
  it("should return true when top score is below 0.85", () => {
    expect(shouldUseLLMFallback([
      { crossEncoderScore: 0.7 },
      { crossEncoderScore: 0.5 },
    ])).toBe(true);
  });

  it("should return true when top two scores are within 0.1", () => {
    expect(shouldUseLLMFallback([
      { crossEncoderScore: 0.9 },
      { crossEncoderScore: 0.85 },
    ])).toBe(true);
  });

  it("should return false for one clear winner above 0.85", () => {
    expect(shouldUseLLMFallback([
      { crossEncoderScore: 0.92 },
      { crossEncoderScore: 0.5 },
    ])).toBe(false);
  });

  it("should return false when top score is exactly 0.85 with clear margin", () => {
    expect(shouldUseLLMFallback([
      { crossEncoderScore: 0.85 },
      { crossEncoderScore: 0.5 },
    ])).toBe(false);
  });

  it("should return false for empty array", () => {
    expect(shouldUseLLMFallback([])).toBe(false);
  });

  it("should return true for single result below 0.85", () => {
    expect(shouldUseLLMFallback([{ crossEncoderScore: 0.7 }])).toBe(true);
  });

  it("should return false for single result above 0.85", () => {
    expect(shouldUseLLMFallback([{ crossEncoderScore: 0.9 }])).toBe(false);
  });

  it("should handle many results", () => {
    expect(shouldUseLLMFallback(
      Array.from({ length: 20 }, (_, i) => ({ crossEncoderScore: 0.95 - i * 0.01 }))
    )).toBe(true); // top=0.95, second=0.94, gap=0.01 < 0.1
  });

  it("should return true for all zero scores", () => {
    expect(shouldUseLLMFallback([
      { crossEncoderScore: 0 },
      { crossEncoderScore: 0 },
    ])).toBe(true);
  });

  it("should trigger on floating-point edge case (0.86 - 0.76 ≈ 0.0999...)", () => {
    // IEEE 754: 0.86 - 0.76 = 0.09999999999999998 which is < 0.1
    expect(shouldUseLLMFallback([
      { crossEncoderScore: 0.86 },
      { crossEncoderScore: 0.76 },
    ])).toBe(true);
  });

  it("should return true when gap=0.09", () => {
    expect(shouldUseLLMFallback([
      { crossEncoderScore: 0.86 },
      { crossEncoderScore: 0.77 },
    ])).toBe(true);
  });
});
