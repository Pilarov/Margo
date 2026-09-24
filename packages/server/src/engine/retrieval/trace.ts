/**
 * Per-layer tracing (ADR-014 step 1, ADR-011 §1).
 *
 * A layer records `{in, out, dropped, ms, cutoff}` for the drop-off funnel. Nothing here
 * changes behaviour: measuring never alters what the pipeline returns, never throws, and
 * carries numbers only — no query text, no memory content (ADR-011 privacy rule).
 *
 * Stage names are layer-based (S0–S3) with an optional sub-stage suffix, so the funnel
 * speaks the ADR-007 vocabulary while keeping the per-step detail of today's monoliths.
 */
import type { MemoryStage } from "../memory/types.js";
import type { LayerTrace } from "./types.js";

export interface LayerTraceInput {
  layer: string;
  in: number;
  out: number;
  ms?: number;
  cutoff?: number;
}

/** Build one trace; `dropped` is derived and never negative. */
export function layerTrace(input: LayerTraceInput): LayerTrace {
  const trace: LayerTrace = {
    layer: input.layer,
    in: input.in,
    out: input.out,
    dropped: Math.max(0, input.in - input.out),
    ms: input.ms ?? 0,
  };
  if (input.cutoff !== undefined) trace.cutoff = input.cutoff;
  return trace;
}

export interface LayerTracer {
  /** Record a layer whose timing/counts the caller already has. */
  record(input: LayerTraceInput): void;
  /** Time a synchronous step; `out` is derived from an array result. */
  take<T>(layer: string, inCount: number, fn: () => T): T;
  /** Time an async step; `out` is derived from an array result. */
  takeAsync<T>(layer: string, inCount: number, fn: () => Promise<T>): Promise<T>;
  traces(): LayerTrace[];
  /** Diagnostics shape for the telemetry collector (ADR-011 §1). */
  stages(): MemoryStage[];
}

function outCount(result: unknown, fallback: number): number {
  if (Array.isArray(result)) return result.length;
  return typeof result === "number" && Number.isFinite(result) ? result : fallback;
}

export function createLayerTracer(): LayerTracer {
  const traces: LayerTrace[] = [];

  const record = (input: LayerTraceInput): void => {
    traces.push(layerTrace(input));
  };

  const take = <T>(layer: string, inCount: number, fn: () => T): T => {
    const started = Date.now();
    const result = fn();
    record({ layer, in: inCount, out: outCount(result, inCount), ms: Date.now() - started });
    return result;
  };

  const takeAsync = async <T>(layer: string, inCount: number, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const result = await fn();
    record({ layer, in: inCount, out: outCount(result, inCount), ms: Date.now() - started });
    return result;
  };

  return {
    record,
    take,
    takeAsync,
    traces: () => [...traces],
    stages: () =>
      traces.map((trace) => ({
        name: trace.layer,
        in: trace.in,
        out: trace.out,
        dropped: trace.dropped,
        ms: trace.ms,
        ...(trace.cutoff === undefined ? {} : { cutoff: trace.cutoff }),
      })),
  };
}
