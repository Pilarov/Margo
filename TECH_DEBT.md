# Tech Debt

Ledger of known debt, workarounds and risks. Newest first.

## Open

### TD-003 — `SourceStatus "CONNECTING"` enum drift
**Severity**: Medium · **Found**: 2026-09-22 (server log) · **Blocks**: source scheduler

Scheduler writes `SourceStatus = "CONNECTING"`; the DB enum only has
`PENDING, SYNCING, SYNCED, READY, INDEXING, ERROR, DISABLED` → repeated
`invalid input value for enum` errors in the log.

**Fix**: align the scheduler to an existing value (e.g. `SYNCING`) or add the enum value.

### TD-004 — Seed is not idempotent (duplicate users)
**Severity**: Low · **Found**: 2026-09-22 · **Blocks**: —

Repeated `seed-dialectic-data.py` runs created `working-memory-test-user` **and**
`working-memory-v2` (51 memories each). No duplicate content within a user, but stale users linger.

**Fix**: seed should upsert by slug or clear the target user first.

### TD-005 — Retrieval recall gaps (semantic)
**Severity**: Medium · **Found**: earlier · **Blocks**: ADR-007 quality

`q-package-manager` = 0.00 (pnpm), `q-backend` = 0.67 (grpc-comms) — memories far from the query
embedding are missed. Target of ADR-007 (hybrid recall + type/graph channels) and Этап 2 of the plan.

### TD-009 — Synthetic pool generation runs through the LLM write path
**Severity**: Medium · **Found**: 2026-09-23 (session handoff) · **Blocks**: benchmark cost

`gen_pool.py` writes synthetic memories through the normal write path, which fires relation-extraction
LLM calls — generating the 10k distractor pool costs real money for data that needs no relations.
**Fix**: the pool generator should write embedding-only records (skip the relations LLM), or call the
write path with relations disabled.

### TD-010 — `<=>` still scattered outside `db/vector.ts`
**Severity**: Medium · **Found**: 2026-09-24 (ADR audit) · **Blocks**: ADR-006 compliance, `metric` changes

ADR-006 decided `db/vector.ts` is the only vector access module and made it a compliance rule
("никакого `<=>` вне `db/vector.ts`"). Reality: **27 occurrences across 5 files** — `retriever.ts` (16),
`api/routes.ts` (4), `consolidation.ts` (3, a site absent from ADR-006's inventory),
`search.ts` (2), `oracle-select.ts` (2). ADR-007 later records "29 сайтов `<=>`" as a fact.
**Fix**: either complete the migration to the helper (preferred, ADR-006 §План реализации п.3), or
rewrite ADR-006 §Compliance to state the actual rule. Touches the same files as Этап 5 (ADR-014).

### TD-011 — No latency baseline file (the p99 criterion is not gradable)
**Severity**: Medium · **Found**: 2026-09-24 (ADR-013 A/B) · **Blocks**: ADR-013/ADR-014 p99 criteria

`qa/baseline-*.json` carries retrieval and synthesis metrics only; there are no `latency_*` keys in
any committed baseline. ADR-013/ADR-014 require "p99 not worse by more than +10% vs the named
baseline file", which cannot be evaluated — the comparison is arm-vs-arm only. Measured evidence
(`qa/bench-*.json`, `reviews/BENCH-*.md`) is gitignored and server-local, so any "p99 was X" claim
is unverifiable a month later.

**Also measured 2026-09-24**: three consecutive latency runs at *identical* config give 1k p99
154.7 / 166.7 / 184.4 ms and 10k p99 212.7 / 218.9 / 229.9 ms (spread +19.2% / +8.1%). A single
run cannot resolve a +10% criterion — verdicts must use medians of repeats (or a fixed-run-count
protocol), otherwise the gate is a coin flip.
**Fix**: run `scripts/benchmark/run.py --suite latency --k 10 --write-baseline` and commit the dated
baseline file; extend `.gitignore`-aware evidence handling so the numbers survive a lost server;
give `run.py --suite latency` a `--repeats-suite` mode that aggregates N runs and reports the median
plus spread.

**Investigated 2026-09-24** — `research/2026-09-24-td011-latency-measurement.md` (evidence in
`reviews/td011/`). Three defects stack, and the second one was invisible before the investigation:

1. **The latency gate evaluates nothing.** A latency run writes `metrics: {latency_p99_ms: …}` and
   `gate: {pass: true, checks: []}` — `gate.py:74-88` skips a metric that is missing from the
   baseline, and `gate.py:90` then computes `all([]) == True`. Every `GATE: PASS` ever printed for a
   latency run is therefore vacuous.
2. **The published breakdown hides the dominant stage.** Whenever `user_id`/`session_id` is present the
   route always runs a keyword search, merges it, and then reports `vector_ms: 0, embed_ms: 0` while
   `total_ms` still includes them (`api/memory.ts:696-698`, `:823-824`) — measured: median `total_ms`
   116 ms vs 25 ms of reported stages. The telemetry collector keeps the honest values
   (`GET /v1/admin/telemetry/drop-off`): `vector_ms` p99 138 of a client p99 of 222 ms.
3. **The statistic is an extreme order statistic.** p99 of 160 samples = the 2nd-largest sample;
   four 75-sample blocks of one run disagree by 15.2% (1k) / 9.5% (10k), three whole runs by 19.2% /
   8.1%, while p50 moves 0.6%.
4. **The API boundary rewrites telemetry** (found 2026-09-24 while wiring ADR-014 step 1):
   `POST /v1/context/query` rebuilds `meta` field by field (`api/routes.ts:1061-1082`), so any new
   field on `ContextResponse.meta` — e.g. the per-layer `layers` — is silently dropped unless it is
   threaded by hand. Same family as #2: what the pipeline reports is not what the caller receives.

Proposed fix (D+A+E: gate semantics, `--runs N` median, honest breakdown) — **не реализован**:
решения по форме зафиксированы в **ADR-010 §8** (объявление критерия, вердикты `PASS|FAIL|NOT GRADABLE`,
статистика = медиана N=3 прогонов, noise floor, per-pool сравнение, baseline в git) и **ADR-011 §8**
(достоверность публикуемых чисел: разбивка складывается, merge ≠ деградация, знаменатели воронки,
воспроизводимость сигнала). Код D+A+E — compliance-пункты этих поправок и ждёт реализации вместе с
записью латентностного baseline.

## Resolved

### TD-002 — Benchmark corpus is not isolated from latency pools — RESOLVED `81779d8`
**Found**: 2026-09-22 · **Closed**: 2026-09-24

Latency pools (up to 10k) were written into the golden corpus project, degrading the retrieval
baseline through the shared ANN index. The 2026-09-23 DB move was one-off; the tooling still
re-polluted on the next run. Now `gen_pool.py` defaults to `--project distractor` and
`qa/latency-set.json` declares `project: "distractor"`, so the isolation is reproducible.
Verified 2026-09-24: a search for `latency-pool-10000` in `distractor` returns synthetic pool
records, the same query in `default` returns golden-corpus records; two consecutive retrieval runs
give recall@10 = 0.787037 with a 0.000 pp delta (P1/P5 closed).

### TD-001 — ANN recall degrades with corpus size (pgvector IVFFlat) — RESOLVED `a90e011`
**Found**: 2026-09-22 · **Closed**: 2026-09-24 (ledger was stale)

Observed: recall@10 = **0.937** at 171 memories → **0.698** at 11,208. Cause: `ivfflat` with `lists=100`
and `probes` never set (default 1). Fixed by switching to **HNSW** (`prisma/scripts/pgvector.sql:16`)
with per-query `set_config('hnsw.ef_search', …)` (`engine/memory/search.ts:631-635`); counted in
`config.ts:284` and pinned by `config-benchmark-telemetry.test.ts`.

### TD-006 — `ingestion_jobs` schema mismatch (async bulk broken) — RESOLVED `d654c6d`
Cloud-shaped `ingestion-queue.ts` (snake_case, `org_id`/`user_id`, counters, `ingestion_documents`)
vs OSS generic `ingestion_jobs` (camelCase, `payload`/`result`; no `ingestion_documents` table).
Rewritten to store job data in `payload` (jsonb). Verified: async bulk 202 → COMPLETED.

### TD-007 — OSS admin endpoints unreachable (403) — RESOLVED `1232fcb`
`auth.ts` never set `isAdmin`, so every `/v1/admin/*` returned 403. Now the API-key holder is admin.

### TD-008 — `fast_mode:false` ignored — RESOLVED `1232fcb`
`profile` had `.default("fast")`, shadowing `fast_mode:false`; and `diagnostics.fast_mode` was
overwritten to `true` on lexical fallback. Both fixed.
