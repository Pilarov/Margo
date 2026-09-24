import { describe, it, expect, vi } from "vitest";

// config.ts reads process.env at import time; re-import with fresh env per case
// (same pattern as config-llm-env.test.ts).

async function loadConfigWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  const original = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import("../config.js");
  } finally {
    for (const k of Object.keys(original)) process.env[k] = original[k];
    for (const k of Object.keys(process.env)) {
      if (!(k in original)) delete process.env[k];
    }
  }
}

describe("benchmark config (ADR-010)", () => {
  it("uses the documented gate defaults", async () => {
    const { benchmark } = await loadConfigWithEnv({});
    expect(benchmark.gates).toEqual({
      recallDeltaPp: 2,
      latencyDeltaPct: 10,
      costDeltaPct: 15,
      synthesisDeltaPp: 5,
    });
  });

  it("reads gate overrides from env", async () => {
    const { benchmark } = await loadConfigWithEnv({ BENCH_RECALL_DELTA_PP: "5" });
    expect(benchmark.gates.recallDeltaPp).toBe(5);
  });

  it("defaults cadence and golden sets", async () => {
    const { benchmark } = await loadConfigWithEnv({});
    expect(benchmark.cadence.onCommit).toBe("subset");
    expect(benchmark.cadence.nightly).toBe("full");
    expect(benchmark.sets.retrieval).toBe("qa/qa-set.json");
    expect(benchmark.sets.latency).toBe("qa/latency-set.json");
  });
});

describe("telemetry config (ADR-011)", () => {
  it("is enabled by default", async () => {
    const { telemetry } = await loadConfigWithEnv({});
    expect(telemetry.collector.enabled).toBe(true);
    expect(telemetry.collector.maxSamples).toBe(1000);
    expect(telemetry.dropOff.enabled).toBe(true);
  });

  it("respects TELEMETRY_ENABLED=false", async () => {
    const { telemetry } = await loadConfigWithEnv({ TELEMETRY_ENABLED: "false" });
    expect(telemetry.collector.enabled).toBe(false);
  });
});

describe("retrieval/ANN config (TD-001)", () => {
  it("defaults to hnsw with efSearch 100", async () => {
    const { retrieval } = await loadConfigWithEnv({});
    expect(retrieval.ann.type).toBe("hnsw");
    expect(retrieval.ann.efSearch).toBe(100);
    expect(retrieval.ann.probes).toBe(10);
  });

  it("reads env overrides", async () => {
    const { retrieval } = await loadConfigWithEnv({ ANN_INDEX_TYPE: "ivfflat", IVFFLAT_PROBES: "25" });
    expect(retrieval.ann.type).toBe("ivfflat");
    expect(retrieval.ann.probes).toBe(25);
  });

  it("defaults window strategies per layer", async () => {
    const { retrieval } = await loadConfigWithEnv({});
    expect(retrieval.window.recall.strategy).toBe("curvature");
    // recall.min = 30: the measured floor that keeps recall@10 at 0.787 (review I1)
    expect(retrieval.window.recall.min).toBe(30);
    expect(retrieval.window.recall.max).toBe(100);
    expect(retrieval.window.rerank.strategy).toBe("median-gap");
    expect(retrieval.window.delivery.strategy).toBe("fixed");
    expect(retrieval.window.delivery.params.k).toBe(10);
  });

  it("reads window overrides from env", async () => {
    const { retrieval } = await loadConfigWithEnv({
      WINDOW_RECALL_STRATEGY: "median-gap",
      WINDOW_RECALL_MIN: "5",
    });
    expect(retrieval.window.recall.strategy).toBe("median-gap");
    expect(retrieval.window.recall.min).toBe(5);
  });

  it("rejects an unknown window strategy at load time (review I3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { retrieval } = await loadConfigWithEnv({ WINDOW_RECALL_STRATEGY: "curvatur" });
      expect(retrieval.window.recall.strategy).toBe("curvature");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("normalizes window bounds: min >= 1 and min <= max (review I3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const low = await loadConfigWithEnv({ WINDOW_RECALL_MIN: "0" });
      expect(low.retrieval.window.recall.min).toBe(1);

      const inverted = await loadConfigWithEnv({ WINDOW_RECALL_MIN: "50", WINDOW_RECALL_MAX: "10" });
      expect(inverted.retrieval.window.recall.max).toBe(50);
      expect(inverted.retrieval.window.recall.min).toBeLessThanOrEqual(inverted.retrieval.window.recall.max);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
