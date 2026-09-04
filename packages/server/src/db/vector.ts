/**
 * pgvector access layer (ADR-006).
 *
 * Prisma cannot express vector dimension or ANN indexes — this module is the
 * single place that owns pgvector specifics: the canonical embedding dimension
 * and the `::vector` literal formatting used by raw `<=>` SQL across the code.
 */

import { EMBEDDING_DIM } from "../config.js";

/** Validate an embedding against the canonical dimension before write/search. */
export function dimensionCheck(vector: number[], dim: number = EMBEDDING_DIM): boolean {
  if (!Array.isArray(vector) || vector.length !== dim) return false;
  return vector.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Format a number[] as a pgvector literal, e.g. `[0.1,0.2,0.3]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Format a number[] as a SQL expression ready for `<=>` comparison. */
export function embeddingToSql(vector: number[]): string {
  return `${toVectorLiteral(vector)}::vector`;
}
