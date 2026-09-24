/**
 * Window selectors — pluggable strategies for choosing how many candidates a
 * retrieval layer keeps (top-K), instead of a hard-coded N.
 *
 * Each layer (recall / rerank / delivery) picks a strategy from config:
 *
 *   retrieval.<layer>.window = { strategy, min, max, params }
 *
 * `min`/`max` are the two config anchors (a "slider" bounds); the strategy
 * decides HOW to cut inside them. `select()` always returns k clamped to
 * [min, max], so a new strategy is a drop-in with no pipeline changes.
 *
 * scores[] is sorted descending (most relevant first).
 */

export interface WindowBounds {
  min: number;
  max: number;
}

export interface WindowSelector {
  name: string;
  select(scores: number[], bounds: WindowBounds, params?: Record<string, number>): number;
}

function clamp(k: number, bounds: WindowBounds): number {
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(k)));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Fixed window: always `params.k` (or bounds.max), regardless of scores. */
const fixed: WindowSelector = {
  name: "fixed",
  select(_scores, bounds, params) {
    return clamp(params?.k ?? bounds.max, bounds);
  },
};

/** Relative-to-top threshold: keep scores >= delta * scores[0]. */
const relativeTop: WindowSelector = {
  name: "relative-top",
  select(scores, bounds, params) {
    if (scores.length === 0) return bounds.min;
    const delta = params?.delta ?? 0.7;
    const cut = scores[0] * delta;
    let k = scores.findIndex((s) => s < cut);
    if (k === -1) k = scores.length;
    return clamp(k, bounds);
  },
};

/** Adaptive gap: stop where a drop exceeds k * median(gaps) for this query. */
const medianGap: WindowSelector = {
  name: "median-gap",
  select(scores, bounds, params) {
    if (scores.length <= 1) return bounds.min;
    const k = params?.k ?? 3;
    const gaps: number[] = [];
    for (let i = 1; i < scores.length; i++) gaps.push(scores[i - 1] - scores[i]);
    const tau = k * median(gaps);
    let n = 1;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i - 1] - scores[i] > tau) break;
      n += 1;
    }
    return clamp(n, bounds);
  },
};

/**
 * Curvature (knee) — point of maximum curvature on the score curve.
 * Kneedle: normalize rank (x) and score (y) to [0,1], then the knee is where
 * the difference (y_norm - x_norm) is maximal — the score stops being worth
 * its rank. Requires at least 3 points; falls back to bounds.max otherwise.
 */
const curvature: WindowSelector = {
  name: "curvature",
  select(scores, bounds, _params) {
    const n = scores.length;
    if (n === 0) return bounds.min;
    if (n < 3) return clamp(n, bounds);

    const yMin = scores[n - 1];
    const yMax = scores[0];
    const yRange = yMax - yMin;

    let bestIndex = 0;
    let bestDiff = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const xNorm = n > 1 ? i / (n - 1) : 0;
      const yNorm = yRange > 0 ? (scores[i] - yMin) / yRange : 1;
      // Kneedle difference: deviation from the line connecting (0,1) → (1,0).
      const diff = yNorm + xNorm - 1;
      if (diff > bestDiff) {
        bestDiff = diff;
        bestIndex = i;
      }
    }
    // knee index counts how many to keep (inclusive)
    return clamp(bestIndex + 1, bounds);
  },
};

export const windowSelectors: Record<string, WindowSelector> = {
  fixed,
  "relative-top": relativeTop,
  "median-gap": medianGap,
  curvature,
};

/** Registry names in declaration order — config validation and messages use this. */
export const WINDOW_STRATEGY_NAMES = Object.keys(windowSelectors);

/** Strategy a bad/unknown configured name resolves to (ADR-013 default). */
export const DEFAULT_WINDOW_STRATEGY = "curvature";

export function isWindowStrategy(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(windowSelectors, name);
}

/**
 * Cut point for one layer. An unknown strategy resolves to the DEFAULT strategy —
 * never to `fixed`, whose missing `params.k` would fall back to `bounds.max` and hand a
 * typo the widest (most expensive) window (review I3). `config.ts` rejects unknown names
 * at load time with a warning; this is the runtime backstop.
 */
export function selectWindow(
  strategy: string,
  scores: number[],
  bounds: WindowBounds,
  params?: Record<string, number>
): number {
  const selector = isWindowStrategy(strategy) ? windowSelectors[strategy] : windowSelectors[DEFAULT_WINDOW_STRATEGY];
  return selector.select(scores, bounds, params);
}
