# TD-011 — why the latency criterion is not gradable (investigation)

**Date**: 2026-09-24 · **Time box**: 60 min · **Status**: investigation only — no source file changed
**Question**: can the criterion "p99 must not grow by more than +10% vs the named baseline" (ADR-013,
ADR-014) be evaluated at all today, and what is the smallest change that makes it gradable?

**Short answer**: no. Three independent defects stack: the gate evaluates *nothing* for latency yet
prints `GATE: PASS`; no committed baseline carries a latency value; and the metric itself — one run's
p99 out of 160 samples — moves ±19% at identical configuration. The tail is real work, not noise.

---

## 1. Codebase findings

| # | Finding | Evidence |
|---|---|---|
| F1 | A latency run compares **zero** checks and prints `GATE: PASS` | `qa/bench-20260924T111800Z.json` → `gate: {pass: true, checks: []}`; `gate.py:74-88` skips a metric missing from either side, `gate.py:90` then computes `all([]) == True` |
| F2 | No committed baseline ever carried a latency value | `qa/baseline*.json` (4 files) expose only `recall@10, precision@10, mrr, ndcg@10, synthesis_score, anchor_coverage`; `git log -S"latency_p99_ms" -- qa/` returns nothing |
| F3 | The suite's metric is `max` over pools, so the 1k pool's p99 never reaches the gate | `run.py:202` → `metrics = {"latency_p99_ms": max(r["p99_ms"] ...)}`; per-pool detail stays in the `latency` array, uncompared |
| F4 | p99 out of 160 samples is the **2nd largest sample** — an extreme order statistic, not an average | `run.py:82-87` nearest-rank percentile; samples = `repeats(20) × queries(8) = 160` |
| F5 | `user_id`/`session_id` always trigger a keyword search + merge, and the response then reports `vector_ms: 0, embed_ms: 0` while `total_ms` still includes them | `api/memory.ts:696-698` (`shouldMergeScopedFallback`), `:823-824` (`usedLexicalFallback ? 0 : …`); measured: median `total_ms` 116 vs sum of reported stages 25 |
| F6 | `fallback: "lexical"` does **not** mean the vector path failed — it marks that merge; the vector path never threw in these runs | same lines; `grep -c "Memory vector search failed"` = 0 over the whole session log |
| F7 | The default `include_pending` adds a pending-overlay fetch to every searched request | `api/memory.ts:761-771`; `include_pending !== false` |
| F8 | The honest per-stage timings do exist, but only server-side | `engine/telemetry/collector.ts:76` records the raw diagnostics before the route rewrites them; `GET /v1/admin/telemetry/drop-off` → `timings.*.p99_ms` |
| F9 | The drop-off funnel aggregates by stage **name across samples**, so a stage present in only some requests has a different denominator | `collector.ts:84-95` (`agg.count += 1` per occurrence); e.g. this probe's queries produced no `intent_rerank` row at all |

## 2. Measurements

Artifacts: `reviews/td011/td011-spike.json`, `td011-attrib.json`, `td011-attrib3.json` (+ the three
probe scripts). Box: 4 vCPU, load 0.14, no cron — the noise is not co-tenant load.

### 2.1 Three consecutive latency suites, identical config

| run | 1k p50 / p99 | 10k p50 / p99 |
|---|---|---|
| `T111113Z` | 127.9 / 154.7 | 170.1 / 212.7 |
| `T111656Z` | 128.7 / 184.4 | 171.9 / 229.9 |
| `T111800Z` | 128.4 / 166.7 | 171.9 / 218.9 |
| spread | **19.2%** | **8.1%** |

p50 moves by 0.6%; the entire spread is in p99.

### 2.2 One run, 300 raw samples, split into four 75-sample blocks (the same estimator a re-run uses)

| pool | p50 | p90 | p95 | p99 | max | block p99s | block spread |
|---|---|---|---|---|---|---|---|
| 1000 | 128.2 | 142.9 | 149.6 | 168.5 | 184.2 | 168.6 / 168.5 / 159.9 / 184.2 | **15.2%** |
| 10000 | 172.5 | 191.3 | 200.2 | 218.9 | 227.2 | 218.9 / 207.5 / 209.8 / 227.2 | **9.5%** |

Within a single run the p99 of four independent blocks already differs by up to 15% — the instability
is the statistic, not the machine. p95 is ~9× more stable than p99 (8th-largest of 160 vs 2nd).

### 2.3 Where the tail actually is (server telemetry, 215 samples, 10k pool)

| stage | p50 | p95 | p99 |
|---|---|---|---|
| `embed_ms` | 22 | 34 | 57 |
| `vector_ms` | 100 | 114 | **138** |
| `merge_ms` | 6 | 9 | 10 |
| `searchMemories total_ms` | 128 | 148 | 174 |
| client wall clock | 172.1 | — | 222.3 |

The p99 is genuine pipeline work: the HNSW vector search dominates (138 of the 222 ms), the query
embedding adds 57. `client p99 − searchMemories p99 = 48.3 ms` outside the memory search: the keyword
merge F5 forces (23-42 ms), the pending overlay (5-7 ms: p99 222.3 → 215.3 with `include_pending=false`),
and ~10 ms of HTTP.

## 3. Sources

External evidence was **not** collected: `web_search` and `web_extract` are unconfigured in this
session (both back ends returned HTTP 403 / "set an API key"). No source is cited, and no claim above
depends on one — every number comes from the artifacts in `reviews/td011/` and the code lines named in
§1. A follow-up could add the standard references on percentile estimation and coordinated omission
(e.g. HdrHistogram's README); that has not been done.

## 4. Alternatives

| # | Option | Pros | Cons / footprint |
|---|---|---|---|
| A | `run.py --suite latency --runs N`: repeat the suite, report p99 per run and write/compare the **median**, plus a `latency_spread_pct` metric; keep raw samples in the JSON | kills the ±19% ambiguity; keeps the criterion as written; artifacts stay analysable | ~N× runtime (3 runs ≈ 8 min); `run.py` + `report.py`, ~50 LOC |
| B | Raise `repeats` in `qa/latency-set.json` (20 → 200) so p99 sits on the 16th-largest of 1600 | no code change | 10× runtime (~25 min); does not fix F1 — the gate would still be vacuous |
| C | Gate on p95 (or a trimmed tail mean) instead of p99 and reword the criterion in ADR-013/014 | cheapest; p95 is ~9× more stable | changes an accepted ADR's criterion → needs a decision; still gradable only after F1+F2 are fixed |
| D | Fix the gate semantics: a metric **present in `current` but missing from `baseline`** must produce a failing check ("no baseline value"), not a silent skip | 6 lines in `gate.py`; removes the vacuous PASS for every future metric, not just latency | changes what `GATE: PASS` means — existing "green" latency history becomes visibly ungraded (which is the point) |
| E | Make the published breakdown honest: stop zeroing `embed_ms`/`vector_ms` when the scoped merge ran, and name the field for what it is (`merged_lexical`, not `fallback`) | the response stops contradicting itself (F5) | touches a hot response path; `hermes-contract.test.ts` and the plugin contract must stay green |

## 5. Recommendation

**D + A + E, in that order, as one commit; C deferred.**

1. **D first** (it is the reason TD-011 was invisible): a latency run must refuse to say PASS when the
   baseline has no value to compare. 6 lines, and it is a prerequisite for trusting any of the rest.
2. **A second**: `--runs 3` (nightly) with the median written into `qa/baseline-<date>.json` and the
   spread reported; `on-commit` keeps `runs 1` and stays retrieval-only. This is the ledger's original
   fix, now backed by §2.1-2.2.
3. **E third**: the breakdown currently hides ~90 ms of real work per request (F5); fixing it makes the
   tail attributable from the outside, which is what a future tuner (ADR-011 L1/L2) will need.
4. **C deferred**, not rejected: if `--runs 3` proves too slow in practice, switching the *criterion*
   to a stable statistic is the honest alternative — but it is an ADR-level decision, not a TD fix.

Rejected: **B** — 10× runtime buys a better estimator while leaving the gate blind.

## 6. Risks

- `--runs 3` triples suite time: mitigate by keeping it to the nightly profile and by capping the
  latency suite to one corpus size for the median gate.
- Fixing D will make current latency runs FAIL until a latency baseline is written: expected, and the
  fix bundle must write that baseline in the same commit.
- E touches the memory-search response: the plugin contract (`hermes-contract.test.ts`) reads field
  names, so renaming `fallback` must be checked against `plugins/memory/retaindb` consumers first.

## 7. Reproduce

```bash
scp reviews/td011/td011_spike.py  pilarovds@46.16.36.148:/tmp/ && ssh … 'cd ~/Margo && python3 /tmp/td011_spike.py'
scp reviews/td011/td011_attrib3.py pilarovds@46.16.36.148:/tmp/ && ssh … 'cd ~/Margo && python3 /tmp/td011_attrib3.py'
# gate mechanics (F1): open any qa/bench-*.json written by --suite latency and read .gate.checks
```
