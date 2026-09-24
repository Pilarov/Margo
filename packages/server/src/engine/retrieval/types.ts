/**
 * Shared retrieval vocabulary (ADR-007 layering, ADR-014 module map).
 *
 * Layer names are the S0–S3 stages of the target architecture. The monoliths emit them
 * today with a sub-stage suffix where the work is still fused (e.g. "S1.window"), so the
 * funnel keeps per-step detail while the vocabulary stays layer-based.
 */

export type LayerName = "S0" | "S1" | "S2" | "S3";

/**
 * Which entry point is doing the retrieval (ADR-014 decision 3): the memory pipeline and
 * the documents pipeline share S0/S2/S3 but have different S1 channel sets.
 */
export type RetrievalMode = "memory" | "documents";

/** Minimal structural shape a layer exchanges: an id plus an optional score. */
export interface Candidate {
  id: string;
  similarity?: number;
  finalScore?: number;
}

/** One measured layer: how many candidates entered, survived, and how long it took. */
export interface LayerTrace {
  /** Stage label; always starts with a `LayerName` ("S1", "S1.window"). */
  layer: string;
  in: number;
  out: number;
  dropped: number;
  ms: number;
  /** Window/limit this layer actually applied, when it applies one. */
  cutoff?: number;
}
