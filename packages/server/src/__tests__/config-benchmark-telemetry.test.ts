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
