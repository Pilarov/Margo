# RetainDB Local Capability Gap

This compares RetainDB Local against the cloned reference runtime as product inspiration, not as code to copy.

## Current RetainDB Local

RetainDB Local now has:

- One-process local server on `:3111`.
- Atomic disk JSON memory store under `~/.retaindb/local-store.json` plus an append-only JSONL journal.
- No Postgres, Redis, Kafka, Qdrant, Cloudflare, or cloud account required.
- REST memory write/search/context/session-ingest endpoints.
- RetainDB hook endpoints under `/retaindb/*`.
- MCP tools for `context`, `remember`, `recall`, `handoff`, `session_history`, and `forget`.
- Compatibility MCP aliases: `memory_save`, `memory_smart_search`, and `memory_sessions`.
- Bundled hook scripts for Codex/Claude-style lifecycle events.
- Hook manifests for Claude Code and Codex.
- Generated OpenCode capture plugin.
- Slash-command skill docs for recall, remember, and handoff.
- `retaindb demo`, `retaindb benchmark`, `retaindb install-embeddings`, `retaindb connect all`, `retaindb hook`, `retaindb import-jsonl`, `retaindb consolidate`, `retaindb reembed`, `retaindb status`, and `retaindb doctor`.
- BM25-style local lexical ranking with document-frequency scoring.
- Hash-vector local semantic scoring by default, with optional bundled local transformer embeddings when `RETAINDB_EMBEDDING_PROVIDER=local-transformers`.
- RRF-style fusion across BM25, vector, and graph signals.
- Reranking that boosts exact matches, early-token matches, lifecycle memories, and consolidated evidence.
- Dynamic local concept graph extraction.
- Local secret redaction before memory writes.
- Low-signal capture filtering.
- Automatic semantic, procedural, correction, and summary typing.
- Recall reinforcement through access counts, last-access timestamps, and memory strength.
- Stale weak raw-memory decay during consolidation.
- Built-in local viewer on `:3113`.
- Clickable concept graph in the viewer.
- Snapshot API for memories, sessions, projects, type counts, and health stats.
- Claude-style JSONL transcript import.
- Session replay API and viewer replay timeline with step-through playback.
- Manual and hourly consolidation for duplicate removal, session summaries, semantic memories, and procedural memories.
- Small local benchmark command with top-5 hit rate, p50/p90/p99 latency output, and saved report files.
- Optional `connect --install` for Codex and Claude Code config merging with backups.

## Not Yet At Parity

RetainDB Local is no longer just a foundation, but it is still not full parity with the reference runtime.

| Area | RetainDB Local | Gap |
| --- | --- | --- |
| Install flow | `npx @retaindb/local`, demo, connect snippets, optional config install, status | Needs polished first-run onboarding, stop, remove, upgrade |
| Storage | Atomic disk JSON plus append-only journal with redacted writes | SQLite is still better for very large local histories |
| Search | BM25 + vector + graph RRF + rerank | Needs benchmark tuning on larger corpora |
| Embeddings | Hash-vector default, optional bundled local transformer provider, model warmup command | Needs broader provider fallback chain |
| Hooks | Core scripts and manifests | Needs full idempotent config merge into user agent configs |
| MCP | RetainDB tools plus key aliases | Needs larger resources/prompts/tool surface if we want parity |
| Viewer | Built-in memory/session/replay/clickable graph viewer on `:3113` | Needs filters and health panels |
| Replay | JSONL import plus replay API and step-through timeline | Needs scrubber/player polish |
| Consolidation | Manual/hourly duplicate removal, episodic summaries, semantic and procedural rollups, recall reinforcement, stale raw decay, journal audit rows | Needs user-tunable scoring policies |
| Graph | Local concept graph extraction and graph-aware search | Needs relationship typing and visualization |
| Privacy | No-cloud default plus secret redaction | Needs configurable privacy policy and audit logs |
| Observability | Health, status, viewer snapshot, append-only journal, benchmark reports | Needs local traces/logs/flame view |
| Federation | None | Optional; keep local-first before sync |

## Next Parity Milestones

1. Replace JSON snapshot with SQLite once local histories become large.
2. Add remote/provider embedding fallback chain.
3. Publish repeatable benchmark reports against larger corpora.
4. Expand config installers to Cursor, Gemini, OpenCode user config, Cline, Roo, Windsurf.
5. Add scrubber polish to the session replay player.
6. Make lifecycle scoring user-tunable and benchmarked across real transcripts.
7. Add relationship-typed graph extraction.

The product direction is right now. RetainDB Local is now usable, installable, and meaningfully agent-native; the remaining work is depth, polish, and benchmark proof.
