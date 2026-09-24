import { describe, it, expect } from "vitest";
import { createLayerTracer, layerTrace } from "../../../engine/retrieval/trace.js";

describe("layer traces (ADR-014 step 1)", () => {
  it("computes dropped from in/out and keeps the cutoff", () => {
    expect(layerTrace({ layer: "S1.window", in: 100, out: 32, ms: 1.2, cutoff: 32 })).toEqual({
      layer: "S1.window",
      in: 100,
      out: 32,
      dropped: 68,
      ms: 1.2,
      cutoff: 32,
    });
  });

  it("never reports a negative drop, and defaults ms to 0", () => {
    const trace = layerTrace({ layer: "S1.type_recall", in: 10, out: 17 });
    expect(trace.dropped).toBe(0);
    expect(trace.ms).toBe(0);
    expect("cutoff" in trace).toBe(false);
  });

  it("times a synchronous step and derives out from an array result", () => {
    const tracer = createLayerTracer();
    const out = tracer.take("S1.window", 100, () => [1, 2, 3]);
    expect(out).toHaveLength(3);
    const [trace] = tracer.traces();
    expect(trace).toMatchObject({ layer: "S1.window", in: 100, out: 3, dropped: 97 });
    expect(trace.ms).toBeGreaterThanOrEqual(0);
  });

  it("times an async step", async () => {
    const tracer = createLayerTracer();
    const out = await tracer.takeAsync("S0.scope", 100, async () => [1, 2]);
    expect(out).toHaveLength(2);
    expect(tracer.traces()[0]).toMatchObject({ layer: "S0.scope", in: 100, out: 2, dropped: 98 });
  });

  it("maps traces to diagnostics stages with dropped/ms/cutoff", () => {
    const tracer = createLayerTracer();
    tracer.record({ layer: "S1.window", in: 100, out: 30, ms: 2, cutoff: 30 });
    expect(tracer.stages()).toEqual([
      { name: "S1.window", in: 100, out: 30, dropped: 70, ms: 2, cutoff: 30 },
    ]);
  });

  it("keeps the S0-S3 vocabulary in every layer label", () => {
    const tracer = createLayerTracer();
    tracer.record({ layer: "S2.rerank", in: 5, out: 5 });
    tracer.record({ layer: "S3.delivery", in: 5, out: 5 });
    for (const trace of tracer.traces()) {
      expect(trace.layer).toMatch(/^S[0-3](\.|$)/);
    }
  });
});
