# ADR-013: Adaptive retrieval window (dynamic top-K via pluggable selectors)

**Status**: Proposed
**Date**: 2026-09-23
**Deciders**: opencode + dspilarov

## Context

Retrieval uses hard-coded candidate windows: `limit = topK*3` (=30) on the vector
recall, `maxCandidates=20` on rerank, `topK=10` on delivery. These are baked into
`search.ts` and `retriever.ts`.

The problem showed up empirically when the golden set grew 51 → 200 core memories:
`recall@10` dropped **0.937 → 0.781**, while `recall@30` stayed **0.846**. The
retrieval can already *find* the right memories — a fixed top-30 simply truncates
them before rerank. A fixed window cannot adapt to how much relevant material a
query actually has: «what package manager» has 1 answer, «what are our goals» has many.

Design constraints agreed in discussion:
- **No dependence on golden** — the golden set is synthetic smoke/regression data,
  not a runtime signal. The window mechanism must be self-contained.
- **No dependence on feedback** — user-feedback is a later stage (ADR-011), heavy
  engineering. The core must work on score geometry alone.
- **Per-layer, not global** — recall/rerank/delivery have different cost/recall tradeoffs.
- **Configurable, not hard-coded** — two config anchors (min/max) plus a strategy
  that cuts between them; new strategies must be droppable in for experiments.

**Affected modules**: `engine/memory/search.ts` (S1 recall, already partially changed),
`engine/retriever.ts` (S2/S3), `config.ts`, new `engine/retrieval/window-selector.ts`.
**Call chain**: `searchMemories → vectorSearchMemories → (new) selectWindow`.

## Decision

**Replace hard-coded top-K with a pluggable `WindowSelector` per retrieval layer,
configured as `{strategy, min, max, params}`. The selector decides how many of the
already-scored candidates to keep, always clamped to `[min, max]`. Default strategy
is `curvature` (knee / point of maximum curvature).**

Interface:

```ts
interface WindowSelector {
  name: string;
  select(scores: number[], bounds: {min:number; max:number}, params?: Record<string, number>): number;
}
```

Built-in strategies (scores sorted descending):

| strategy | rule |
|---|---|
| `fixed` | `k = params.k` (current behavior, opt-out) |
| `relative-top` | keep `s_i >= δ·s_1` |
| `median-gap` | stop where `gap_i > k·median(gaps)` |
| `curvature` | knee via Kneedle: `argmax(y_norm + x_norm − 1)` |

### Strategy implementations

All strategies are pure functions of the (descending) score list, `O(n)`, and end
with `clamp(k, min, max)`.

**`fixed`** — the degenerate case, reproduces the old hard-coded behavior (used for `delivery`).
```ts
select(_scores, bounds, params) {
  return clamp(params?.k ?? bounds.max, bounds);   // params.k = N
}
```

**`relative-top`** — cut everything below a fraction of the leader; does not detect
a "gap", just trims the tail.
```
cut = δ · s₁
k   = count(s_i ≥ cut)
```
```ts
if (scores.length === 0) return bounds.min;
const cut = scores[0] * (params?.delta ?? 0.7);
let k = scores.findIndex(s => s < cut);
k = k === -1 ? scores.length : k;                  // all above threshold → take all
return clamp(k, bounds);
```
Example: `[0.95, 0.93, 0.91, 0.40]`, `δ=0.7` → `cut=0.665` → `k=3`.
Params: `δ` (default 0.7). Edge: empty → `min`.

**`median-gap`** — adaptive gap calibrated to *this query*: a drop is "sharp" when it
exceeds `k ×` the typical (median) drop in the same list. Dimensionless `k` is
portable across models (ADR-012).
```
gaps[i] = s[i] − s[i+1]
τ       = k · median(gaps)
stop at the first i where gaps[i] > τ
```
```ts
if (scores.length <= 1) return bounds.min;
const gaps = scores.slice(1).map((s, i) => scores[i] - s);
const tau  = (params?.k ?? 3) * median(gaps);
let n = 1;
for (let i = 1; i < scores.length; i++) {
  if (scores[i-1] - scores[i] > tau) break;
  n++;
}
return clamp(n, bounds);
```
Example: `[0.95,0.93,0.91,0.88,0.45,0.42,0.40]` → gaps `[.02,.02,.03,.43,.03,.02]`,
median ≈ `.025`, `τ=0.075` → stops at the `.43` drop → `n=4`.
Params: `k` (default 3). Edge: `median=0` (all scores equal) → `τ=0`, so any positive
drop stops; on a truly flat list `n` runs to `max`.

**`curvature`** — the default. Finds the knee (point of maximum curvature) via Kneedle.
```
1. normalize: x_norm[i] = i/(n−1)
              y_norm[i] = (s_i − s_min)/(s_max − s_min)
2. difference to the line joining (0,1)→(1,0):
              d[i] = y_norm[i] + x_norm[i] − 1
3. knee = argmax_i d[i]
4. k = knee + 1            (inclusive)
```
```ts
if (n === 0) return bounds.min;
if (n < 3) return clamp(n, bounds);                 // knee needs ≥3 points
const yMin = scores[n-1], yMax = scores[0], yRange = yMax - yMin;
let best = 0, bestDiff = -Infinity;
for (let i = 0; i < n; i++) {
  const xNorm = i / (n - 1);
  const yNorm = yRange > 0 ? (scores[i] - yMin) / yRange : 1;
  const diff  = yNorm + xNorm - 1;
  if (diff > bestDiff) { bestDiff = diff; best = i; }
}
return clamp(best + 1, bounds);
```
Why `y_norm + x_norm − 1`: the line from `(x=0,y=1)` to `(x=1,y=0)` is `y_line = 1 − x_norm`;
deviation is `y_norm − (1 − x_norm) = y_norm + x_norm − 1`. The knee is where the score
stops being "worth its rank" — the top cluster ends.
Example: `[1.0,0.98,0.95,0.55,0.53,0.52,0.51,0.50]` → knee at index 2 → `k=3`.
Params: none. Edge: `n<3` → return `n` (clamped).

Config:

```jsonc
"retrieval": {
  "window": {
    "recall":   { "strategy": "curvature",  "min": 30, "max": 100, "params": {} },
    "rerank":   { "strategy": "median-gap", "min": 1,  "max": 50,  "params": { "k": 3 } },
    "delivery": { "strategy": "fixed",      "min": 1,  "max": 10,  "params": { "k": 10 } }
  }
}
```

Rationale: the two config anchors (`min`/`max`) bound cost and guarantee a minimum
recall; the strategy is *how* to cut inside them. All selectors are pure functions
of the score list, so they are independent of the embedding model's score scale
(portable across ADR-012 providers) and require no golden/feedback.

`min`/`max` remain constants by design — they are safety anchors (min recall floor,
cost cap), not the adaptive part. The adaptive part is the cut point the strategy
chooses between them.

## Falsification Criteria

- `recall@10` on the 200-core golden **increases by ≥ +0.05** (0.781 → ≥ 0.83) after
  switching S1 recall from `fixed` topK*3 to `curvature`, same corpus and model.
- `p99` retrieval latency does **not grow > +10%** vs the fixed topK*3 baseline
  (the window cap must not drag extra candidates into the expensive layer).
- A new strategy is addable as **one function + one registry entry**, with no change
  to `searchMemories`' control flow (code-review gradeable).
- `curvature` returns the correct knee on a synthetic score curve with a known knee
  (unit test), and every selector clamps to `[min, max]`.

## Alternatives Considered

### Option A: Fixed top-K (current)
- **Pros**: zero work, deterministic.
- **Cons**: recall collapses as corpus grows (measured 0.937→0.781); cannot adapt to query difficulty.
- **Why rejected**: the measured recall loss is exactly the bug we are fixing.

### Option B: Entropy-slider window (`K = min + c^γ·(max−min)`)
- **Pros**: smooth, single normalized signal.
- **Cons**: redundant while `curvature`/`median-gap` already adapt to the score curve; adds a `γ` to tune with no direct benefit yet.
- **Why rejected**: deferred — can be added as another selector later, not needed for the core.

### Option C: Calibrated `P(relevant|score)` trained on golden
- **Pros**: semantic threshold, portable.
- **Cons**: golden is synthetic and not representative; couples the runtime mechanism to a dataset we agreed it must not depend on.
- **Why rejected**: violates the "no golden dependency" constraint; kept only for offline regression (ADR-010).

### Option D: LLM query-classifier + feedback-driven window
- **Pros**: richer signal (intent, difficulty).
- **Cons**: new LLM task, async plumbing, feedback channel — significant engineering.
- **Why rejected**: deferred to a later stage; the geometry-only core must work first and is not blocked by it.

## Consequences

### Positive
- Recall is no longer truncated by a fixed 30 — measured loss recovers toward recall@30.
- Experiments become cheap: switch `strategy`/`params` in config, no redeploy.
- Portable: selectors operate on scores, not on model-specific scales (ADR-012).

### Negative
- Knee/gap are heuristics — `δ`, `k` (median-gap) need calibration; edge cases (few
  candidates, noisy scores) need guards (already handled by min/max clamp).
- Larger config surface (`window.*` per layer).

### Neutral
- `min`/`max` are still fixed per layer — deliberate safety anchors, not the adaptive part.
- `recall.max` fetch (100 vs 30) is slightly more ANN work, negligible vs rerank cost.

## Compliance

- Unit tests: `window-selector.test.ts` covers every strategy + clamping + knee.
- Config test: `config-benchmark-telemetry.test.ts` asserts `retrieval.window` defaults.
- Benchmark gate (ADR-010): recall/p99 on golden; regressions block merge.

## Related ADRs

- **ADR-007 (S0–S3 retrieval)** — this window lives in S1/S2/S3; supersedes the fixed `limit=topK*3` there.
- **ADR-009 (memory hygiene)** — `retention_class`/`mandatory` affect retention and pinning, not ranking window.
- **ADR-010 (benchmark)** — recall/p99 falsification gate lives there.
- **ADR-011 (telemetry & QC)** — collector gains a "chosen window k" counter; tuner adjusts `strategy`/`params`.
- **ADR-012 (inference providers)** — score-scale portability requirement.

## Implementation Impact

**Done (this iteration):**
- `engine/retrieval/window-selector.ts` — interface + `fixed`/`relative-top`/`median-gap`/`curvature` + registry.
  An unknown strategy resolves to the default (`curvature`), never to `fixed`/`bounds.max`;
  `isWindowStrategy` / `WINDOW_STRATEGY_NAMES` exist for config validation (review I3).
- `config.ts` — `retrieval.window.{recall,rerank,delivery}`, validated at load time:
  unknown strategy → default + warning, bounds normalized to `1 <= min <= max` (review I3).
- `search.ts` — S1 recall fetches `recall.max`, scope-boosts first and cuts via `selectWindow`
  (`recall.min = 30` by measurement), then publishes the chosen `k` as the `window_recall`
  stage (review I4 + M1).

**Measured 2026-09-24** (golden 200-core, 54 scored questions; evidence
`reviews/AB-ADR-013-2026-09-24.md`, `qa/bench-20260924T*`):

| arm | recall@10 | avg window k | p99 1k / 10k |
|---|---|---|---|
| `fixed`/30 (pre-window behaviour) | 0.781 | 30.0 | 177.0 / 211.9 ms |
| `curvature`/min=10, window on raw similarity | 0.787 | 11.6 | 148.1 / 212.7 ms |
| `curvature`/min=10, after the scope-boost order fix | 0.769 | 13.3 | — |
| `curvature`/min=30, after the order fix (shipped default) | 0.787 | 32.6 | 166.7 / 218.9 ms¹ |

¹ median of three consecutive runs — a single run varies by up to 19% at identical config (TD-011).

The knee on this corpus sits close to the floor (avg 32.6 at min=30), so the "adaptive" part is
not yet demonstrated on real score distributions — the floor is what protects recall.

**Pending:**
- ~~Apply selector to `retriever.ts` S2 (rerank) and S3 (delivery).~~ — **снято 2026-09-24 решением ADR-015**:
  documents-путь вырезается целиком, значит окна в `retriever.ts` не внедряются. Окно ADR-013 живёт в
  memory-пути: S1 сделано, S2/S3 — в шагах ADR-014 при разделении `searchMemories`.
- Calibrate `δ`/`k` defaults against golden + live score distributions; a latency baseline file
  (the p99 criterion has no named baseline to compare against).
