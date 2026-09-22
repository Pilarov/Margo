# Tech Debt

Ledger of known debt, workarounds and risks. Newest first.

## Open

### TD-001 — ANN recall degrades with corpus size (pgvector IVFFlat)
**Severity**: High · **Found**: 2026-09-22 (Stage 1 benchmark) · **Blocks**: ADR-006, ADR-007

`pgvector.sql:17` creates `memories_embedding_idx USING ivfflat (... ) WITH (lists = 100)`, and
`ivfflat.probes` is never set → default **1** (scans 1 of 100 lists).

Observed: recall@10 = **0.937** at 171 memories → **0.698** at 11,208 (same queries).
The planner also flips between seq-scan and ANN, so recall is not reproducible without a
stable corpus + `ANALYZE`.

**Fix (ADR-006/007)**: HNSW, or `lists ≈ N/1000` + `probes` proportional to N, or a documented
`ANALYZE` + index-rebuild step. Verify recall stays flat across N.

### TD-002 — Benchmark corpus is not isolated from latency pools
**Severity**: High · **Found**: 2026-09-22 · **Blocks**: ADR-010 reproducibility

`gen_pool.py` writes latency pools (up to 10k) into the same `memories` table/ANN index as the
golden set, so a latency run degrades the retrieval baseline (TD-001).

**Workaround now**: `DELETE FROM memories WHERE "userId" LIKE 'latency-pool-%'; ANALYZE memories;`
**Fix**: isolate benchmark data (separate DB/schema) or auto-cleanup + ANALYZE after `--suite latency`.

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
embedding are missed. Target of ADR-007 (hybrid recall + type/graph channels).

## Resolved

### TD-006 — `ingestion_jobs` schema mismatch (async bulk broken) — RESOLVED `d654c6d`
Cloud-shaped `ingestion-queue.ts` (snake_case, `org_id`/`user_id`, counters, `ingestion_documents`)
vs OSS generic `ingestion_jobs` (camelCase, `payload`/`result`; no `ingestion_documents` table).
Rewritten to store job data in `payload` (jsonb). Verified: async bulk 202 → COMPLETED.

### TD-007 — OSS admin endpoints unreachable (403) — RESOLVED `1232fcb`
`auth.ts` never set `isAdmin`, so every `/v1/admin/*` returned 403. Now the API-key holder is admin.

### TD-008 — `fast_mode:false` ignored — RESOLVED `1232fcb`
`profile` had `.default("fast")`, shadowing `fast_mode:false`; and `diagnostics.fast_mode` was
overwritten to `true` on lexical fallback. Both fixed.
