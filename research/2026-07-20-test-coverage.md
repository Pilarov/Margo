# Research: Test Coverage for RetainDB/Margo

**Date**: 2026-07-20
**Goal**: Evaluate criticality of modules and design a prioritized test plan
**Time box**: 30 min (large)

## Codebase Findings

### Current state
- **0 tests** across 4 packages (server, local, sdk, mcp) + 166 source files
- No test framework, no test deps, no test scripts in any package.json
- Only quality gates: `turbo run typecheck` + `turbo run lint`
- ESM project (`"type": "module"`, `moduleResolution: "bundler"`)

### Pure functions identified
- 129 pure/nearly-pure functions across all packages
- Server package: 80+ pure helpers (patterns, temporal, dedup, scoring)
- Local package: 30+ pure helpers (embedding, scoring, validation)
- SDK package: ~15 pure helpers (hashing, URL normalization, graph utils)

### Most critical modules (by business risk)

| Rank | Module | Risk | Reason |
|------|--------|------|--------|
| 1 | `memory/write.ts` | DATA LOSS | Scope inference bugs → wrong scope → data leaks. Dedup threshold 0.88 → silent merges. |
| 2 | `memory/search.ts` | WRONG RESULTS | Stale cache (300s TTL). Silent scope leaks. Fast-mode degradation. |
| 3 | `engine/retriever.ts` | WRONG RESULTS | Threshold 0.25 → no results. Oracle prefilter false negatives. Rerank cost explosion. |
| 4 | `engine/embeddings.ts` | CRASH | Dimension mismatch on mode switch. OpenAI API key missing = crash. |
| 5 | `local/src/cli.ts` | DATA LOSS | File corruption on crash. O(n) search bottleneck. No encryption. |

## Recommendation

**Chosen approach**: Vitest + TypeScript, incremental (P0 → P1 → P2)

### Phase 1: Infrastructure + P0 (this session)
- Install vitest as devDependency
- Configure vitest in each package
- Add `test` script to package.json
- Test pure helpers from write.ts (`__memoryWriteTestables`)
- Test critical pure functions: hashEmbedding, cosine, signalQuality, jaccardSimilarity

### Phase 2: P1 (next session)
- Pattern extraction engine
- Temporal parsing
- Memory normalization
- Config module

### Phase 3: P2 (follow-up)
- SDK utils, graph utils
- Compressor, chunker
- Cost optimization

**Rejected**: Jest (CJS-first, worse ESM support), Mocha (no TS support), no tests (risk too high)

**Risks**: Vitest is not yet in project deps — needs install. Node.js not on this machine — user runs typecheck manually.
