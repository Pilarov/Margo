# Margo — Project Guide

> Informative handoff document for continuing work. Read this before making changes.
> Margo = fork of [RetainDB](https://github.com/retaindb/retaindb) — memory infrastructure for AI agents.

---

## 1. What this project is

Margo is a **memory layer for AI agents**: it stores, structures, retrieves, and reinforces durable memory (facts, preferences, decisions, procedures, corrections) across sessions.

Two runtime modes:
- **Local** (`packages/local`) — one JSON file + append-only journal, zero infra, hash/local embeddings.
- **Server** (`packages/server`) — PostgreSQL + pgvector, SOTA memory pipeline, 20+ connectors.

The whole point vs upstream RetainDB: **local-first, self-hostable, multi-provider LLM** (not cloud-only $20/mo).

---

## 2. Repo / access

| Thing | Value |
|---|---|
| GitHub | `github.com/Pilarov/Margo` (fork), branch `main` |
| SSH server (test) | `46.16.36.148`, user `pilarovds` |
| Server deploy key | `~/.ssh/id_ed25519` (`margo-cloud`), repo already cloned at `~/Margo` |
| Local Windows dir | `C:\Users\Oblre\OneDrive\Рабочий стол\RetainDB` (tracking `origin/main`) |
| Package manager | pnpm 9.15.0 (workspace `packages/*`, `examples/*`) |

Server has Node v22 + pnpm installed. Deps installed with `pnpm install --ignore-scripts` (the `sharp` postinstall times out downloading libvips — not needed for typecheck/tests).

---

## 3. Monorepo layout

```
packages/
  server/   @retaindb/server   — Hono API :3000, Prisma+pgvector, SOTA memory
  local/    @retaindb/local    — one-process runtime :3111/:3113, JSON store
  sdk/      @retaindb/sdk      — TS client, adapters (Vercel AI SDK, LangChain)
  mcp/      @retaindb/mcp      — MCP server (12 tools)
```

Key server files:
- `packages/server/src/config.ts` — **central config** (embedding, rerank, llm)
- `packages/server/src/engine/llm-client.ts` — `getLLMClient(task)` (multi-provider)
- `packages/server/src/engine/retriever.ts` — `retrieve()` main pipeline
- `packages/server/src/engine/memory/write.ts` — `writeMemoryCanonical()` + `__memoryWriteTestables`
- `packages/server/src/engine/memory/search.ts` — `searchMemories()`
- `packages/server/src/engine/memory/dialectic.ts` — `dialecticQuery()` (dialectic engine)
- `packages/server/src/api/memory.ts`, `routes.ts`, `context.ts`, `files.ts` — HTTP routes

---

## 4. Configuration — multi-provider LLM (the big recent work)

Three sources, priority `env > retaindb.config.json > default`.

The core idea: **each LLM task has its own `model` + `apiKey` + `baseUrl`**, with fallback to global `default`.

```jsonc
// retaindb.config.json
{
  "llm": {
    "default": { "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1" },
    "tasks": {
      "extraction": { "model": "deepseek-v4-flash", "apiKey": "sk-ds...", "baseUrl": "https://api.deepseek.com/v1" },
      "rerank":     { "model": "deepseek-v4-flash", "apiKey": "sk-ds...", "baseUrl": "https://api.deepseek.com/v1" },
      "dialectic":  { "model": "gpt-4o" }
    }
  }
}
```

Fallback chain per task: `LLM_<TASK>_MODEL → tasks.<task>.model → default`, same for `apiKey`/`baseUrl`.

**18 LLM tasks** (default model): `extraction`(gpt-4o-mini), `memoryExtraction`(gpt-5.4-mini, legacy `EXTRACTOR_MODEL`), `queryExpansion`(gpt-4o-mini), `rerank`(gpt-4o-mini), `sourceProfile`(gpt-4o-mini), `compressor`(gpt-4o-mini), `oracle`(gpt-4o), `synthesis`(gpt-4o-mini), `pageExtractor`(gpt-4o-mini), `researchAgent`(gpt-4o), `taskRunner`(gpt-4o), `videoStt`(gpt-4o-mini-transcribe), `consolidation`/`dialectic`/`inference`/`sessionSummary`/`relation`/`temporal`(all gpt-5.4-mini).

Helper: `getLLMClient(task?)` in `engine/llm-client.ts` — caches clients per `key::baseUrl`, throws without key. Every LLM call site must pass its task: `getLLMClient(llmCfg.extraction)`.

See `CONFIGURATION.md` for full reference.

---

## 5. Embedding & reranking

- Embedding modes: `openai` | `gemini` | `local` (BGE-large) | `hybrid` | `remote` | `workers`.
- Embedding bridge runs as `packages/server/src/embedding-server.ts` (`:8080`, `POST /v1/inference/embeddings`).
- Rerank modes: `cross-encoder` (local BGE-reranker) | `llm` | `balanced` | `remote`.

**DeepSeek gotcha**: `deepseek-v4-pro/flash` are **reasoning models** — `max_tokens` includes reasoning+content, so use ≥800 for extraction, ≥500 for rerank (defaults 200/800 are for OpenAI).

---

## 6. Hermes plugin contract (recent work)

The Hermes agent (`NousResearch/hermes-agent`, `plugins/memory/retaindb/__init__.py`) is a **REST client** (not MCP) that calls 14 endpoints. Margo implements the full contract:

- `POST /v1/context/query` → `{results:[{content}]}`
- `POST /v1/memory/search`, `POST /v1/memory`, `DELETE /v1/memory/:id`
- `GET /v1/memory/profile/:userId` → `{memories:[{content}]}`
- `POST /v1/memory/profile/:userId/ask` → **dialectic** `{answer}` (adapter added; maps `{query, reasoning_level}` → `dialecticQuery`)
- `GET /v1/memory/agent/:id/model` → `{memory_count, persona, persistent_instructions, working_style}`
- `POST /v1/memory/agent/:id/seed`
- files: `POST/GET/DELETE /v1/files`, `/v1/files/:fileId`, `/ingest`

Dialectic in the plugin is **not a tool** — it's a per-turn background `ask_user` prefetch injected as `[RetainDB User Synthesis]`. Auth: plugin sends `Authorization: Bearer <key>` (+ redundant `X-API-Key`); Margo reads Bearer only.

Regression test: `packages/server/src/__tests__/hermes-contract.test.ts` (source-inspection).

---

## 7. Testing

```bash
pnpm run test                            # all packages (346 total)
pnpm --filter @retaindb/server test      # 257 tests
pnpm --filter @retaindb/local test       # 80
pnpm --filter @retaindb/sdk test         # 31
```

Test layers worth knowing:
- `config-llm-env.test.ts` — `task()` fallback (env→json→default), uses `vi.resetModules()`+dynamic import
- `llm-client.test.ts` — `getLLMClient` resolution/caching/error (mocks config)
- `llm-wiring.test.ts` — **source-inspection**: asserts each of 18 files calls `getLLMClient(llmCfg.<task>)` with correct task; only `cost-optimization.ts` uses bare `getLLMClient()`
- `hermes-contract.test.ts` — endpoint + field contract
- `write-helpers.test.ts` — scope inference/dedup/validation via `__memoryWriteTestables` (7 `vi.mock`s for Prisma/Redis/OpenAI)

**Typecheck caveat**: `tsc --noEmit` has many PRE-EXISTING errors (Prisma client drift, missing `redis` module, loose typing). Tests run via vitest (which doesn't strict-typecheck). Don't be alarmed by tsc noise — check that YOUR changes don't add new errors (grep output for your files).

---

## 8. Roadmap (ADRs in `architecture/`)

| Phase | ADR | What | Status |
|---|---|---|---|
| — | — | multi-provider LLM config | ✅ done |
| — | — | Hermes plugin contract | ✅ done |
| P1 | ADR-002 | one-pass extraction (1 LLM call vs N) | proposed |
| P2 | ADR-003 | Dreamer consolidation (inductive + peer-card) | proposed |
| P3 | ADR-004 | progressive context + async write | proposed |
| P4 | ADR-005 | knowledge→skill pipeline | hypothesis |

Docs: `README.md`, `CONFIGURATION.md`, `TESTING.md`, `architecture/VISION.md`.

---

## 9. Workflow (how to make changes)

The user's required flow: **commit via git, not SCP hackery**.

Practical current flow (local Windows ↔ test server):
1. Edit locally on Windows.
2. `scp` changed files to `pilarovds@46.16.36.148:~/Margo/...` (server is the clean git worktree with the deploy key).
3. On server: `git add -A && git commit -m '...' && git push origin main`.
4. Sync local: `git fetch origin && git reset --hard origin/main`.

Alternatively (once local has git push creds): commit locally + `git push`.

**Gotcha**: editing on Windows introduces CRLF; `.gitattributes` (`* text=auto`, `*.ts eol=lf`) normalizes — don't delete it. If a commit shows a whole file as "changed", it's a line-ending diff, not a real change.

---

## 10. Gotchas / quirks

- **DeepSeek reasoning models** — need large `max_tokens` (see §5).
- **`sharp` postinstall times out** — use `pnpm install --ignore-scripts` on the server; irrelevant for tests/typecheck.
- **CRLF vs LF** — see §9.
- **`dialecticQuery` engine needs Postgres** (`loadUserModelMemories`/`synthesizeUserModel`), so the dialectic `/ask` endpoint can't be e2e-tested without a running DB — that's why it's contract-tested, not integration-tested.
- **`cost-optimization.ts`** intentionally uses bare `getLLMClient()` (model comes from its own Claude→OpenAI mapping).
- **`video.ts`** uses `new OpenAI({...})` directly (STT needs `audio.transcriptions`, not `chat.completions`); still reads `llmCfg.videoStt`.
- **`tsc --noEmit` noise** — pre-existing; don't fix unless asked.

---

## 11. Next steps (suggested)

1. **Real Hermes↔Margo e2e** on the server (needs Postgres + `pnpm dev:server`, then point Hermes `RETAINDB_BASE_URL` at it).
2. **ADR-002 one-pass extraction** — biggest token savings, feeds dialectic quality.
3. **ADR-003 Dreamer + peer-card** — canonical user model for dialectic.
