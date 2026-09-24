import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSearchTelemetry,
  recordLLMUsage,
  getDropOffSummary,
  resetTelemetry,
} from "../../../engine/telemetry/collector.js";
import type { MemorySearchDiagnostics } from "../../../engine/memory/types.js";

function diag(partial: Partial<MemorySearchDiagnostics>): MemorySearchDiagnostics {
  return {
    cache_ms: 0,
    embed_ms: 0,
    vector_ms: 0,
    lexical_ms: 0,
    merge_ms: 0,
    total_ms: 0,
    cache_hit: false,
    cache_hit_type: "none",
    fast_mode: false,
    ...partial,
  };
}

describe("telemetry collector", () => {
  beforeEach(() => resetTelemetry());

  it("aggregates dynamic stages by name", () => {
    recordSearchTelemetry(diag({ stages: [{ name: "vector", in: 30, out: 10 }, { name: "final", in: 10, out: 5 }] }));
    recordSearchTelemetry(diag({ stages: [{ name: "vector", in: 30, out: 20 }, { name: "final", in: 20, out: 10 }] }));

    const s = getDropOffSummary();
    expect(s.sample_count).toBe(2);

    const vector = s.stages.find((x) => x.name === "vector")!;
    expect(vector.avg_in).toBe(30);
    expect(vector.avg_out).toBe(15);
    expect(vector.retention).toBe(0.5);
  });

  it("adapts to a different stage vocabulary without code changes", () => {
    recordSearchTelemetry(diag({ stages: [{ name: "S0", in: 100, out: 80 }, { name: "S1", in: 80, out: 40 }] }));

    const s = getDropOffSummary();
    expect(s.stages.map((x) => x.name)).toEqual(["S0", "S1"]);
    expect(s.stages[1].retention).toBe(0.5);
  });

  it("never stores query text or memory content", () => {
    recordSearchTelemetry(diag({ stages: [{ name: "vector", in: 1, out: 1 }] }));
    const json = JSON.stringify(getDropOffSummary());
    expect(json).not.toMatch(/query|content/i);
  });

  it("tracks cache-hit and fast-mode rates", () => {
    recordSearchTelemetry(diag({ cache_hit: true, fast_mode: true }));
    recordSearchTelemetry(diag({}));

    const s = getDropOffSummary();
    expect(s.cache_hit_rate).toBe(0.5);
    expect(s.fast_mode_rate).toBe(0.5);
  });

  it("ignores malformed stages", () => {
    recordSearchTelemetry(diag({
      stages: [{ name: "vector", in: 10, out: 5 }, { name: 123 as unknown as string, in: 1, out: 1 }],
    }));

    const s = getDropOffSummary();
    expect(s.stages).toHaveLength(1);
    expect(s.stages[0].name).toBe("vector");
  });

  it("computes timing percentiles", () => {
    for (let i = 1; i <= 100; i++) {
      recordSearchTelemetry(diag({ total_ms: i }));
    }
    const s = getDropOffSummary();
    expect(s.timings.total_ms.count).toBe(100);
    expect(s.timings.total_ms.p50_ms).toBe(51);
    expect(s.timings.total_ms.p95_ms).toBe(96);
  });

  it("aggregates per-layer dropped/ms/cutoff (ADR-011 §1/§8)", () => {
    recordSearchTelemetry(diag({ stages: [
      { name: "S1.window", in: 100, out: 30, dropped: 70, ms: 2, cutoff: 30 },
      { name: "S1.window", in: 100, out: 40, dropped: 60, ms: 4, cutoff: 40 },
    ] }));

    const s = getDropOffSummary();
    const window = s.stages.find((x) => x.name === "S1.window")!;
    expect(window.samples).toBe(2);
    expect(window.avg_dropped).toBe(65);
    expect(window.avg_ms).toBe(3);
    expect(window.p95_ms).toBe(4);
    expect(window.avg_cutoff).toBe(35);
  });

  it("leaves cutoff null for a layer that applies no window", () => {
    recordSearchTelemetry(diag({ stages: [{ name: "S3.delivery", in: 10, out: 10, dropped: 0, ms: 1 }] }));

    const s = getDropOffSummary();
    const delivery = s.stages.find((x) => x.name === "S3.delivery")!;
    expect(delivery.avg_cutoff).toBeNull();
    expect(delivery.avg_ms).toBe(1);
  });

  it("reports a negative delta for a layer that adds candidates (net change, not a drop)", () => {
    recordSearchTelemetry(diag({ stages: [{ name: "S1.type_recall", in: 33, out: 37, dropped: 0, ms: 2 }] }));

    const s = getDropOffSummary();
    const recall = s.stages.find((x) => x.name === "S1.type_recall")!;
    expect(recall.avg_dropped).toBe(-4);
    expect(recall.retention).toBeGreaterThan(1);
  });

  it("records LLM token usage", () => {
    recordLLMUsage({ prompt_tokens: 10, completion_tokens: 5 });
    recordLLMUsage({ total_tokens: 30 });

    const s = getDropOffSummary();
    expect(s.llm.calls).toBe(2);
    expect(s.llm.prompt_tokens).toBe(10);
    expect(s.llm.completion_tokens).toBe(5);
    expect(s.llm.total_tokens).toBe(45);
  });

  it("ignores missing usage", () => {
    recordLLMUsage(undefined);
    expect(getDropOffSummary().llm.calls).toBe(0);
  });
});
