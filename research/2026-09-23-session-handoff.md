# Session Handoff — 2026-09-23

> **Заменён 2026-09-24.** Актуальная редакция: `research/2026-09-24-session-handoff.md` (включает аудит,
> ADR-014, переработанную карту этапов и runbook покрытия этапов). Этот файл сохранён как история.
> Ниже — контекст на момент 2026-09-23; разделы §4 (git), §8 (что делать) и §9 (техдолг) устарели.

> Детальный контекст для передачи работы другому агенту. Читать первым.
> Проект: **Margo** — форк RetainDB, память-слой для AI-агентов.

---

## 1. Что это за проект (30 сек)

Margo хранит **рабочие памяти** (decisions/constraints/goals/procedures/corrections/preferences) — НЕ факты о пользователе. Два режима: local (JSON) и server (PostgreSQL+pgvector). Цель vs upstream: **local-first, self-hostable, multi-provider LLM**.

Ключевые слова: retrieval pipeline (S0–S3), memory hygiene (ADR-009), pgvector, LLM-judge, golden set, adaptive window (ADR-013).

Полный контекст проекта — в `AGENTS.md` (прочитать обязательно).

---

## 2. Инфраструктура (сервер)

| Что | Значение |
|---|---|
| SSH | `pilarovds@46.16.36.148` (BatchMode, ключ по умолчанию) |
| Репо на сервере | `~/Margo` (clean git worktree, deploy-ключ) |
| Локально (Windows) | `C:\Users\Oblre\OneDrive\Рабочий стол\RetainDB` |
| Postgres | `localhost:5432`, БД `retaindb`, user `pilarovds` |
| Сервер :3000 | запущен через `setsid nohup pnpm exec tsx src/index.ts`, env `MEMORY_SEARCH_DISABLE_CACHE=true` |
| API key | `margo-test-key` (из `.env`) |
| Package manager | pnpm 9.15.0; Node v22 |

**Workflow (обязательный):** локально правишь → `scp` на сервер → `git add/commit/push` на сервере → локально `git fetch origin && git reset --hard origin/main`.

**Нюансы:**
- Node/pnpm **нет локально** — тесты гонять на сервере: `cd ~/Margo/packages/server && pnpm exec vitest run`.
- Python на сервере есть (3.10, requests). Локально только `python` для `py_compile`/JSON-проверок.
- CRLF vs LF: `.gitattributes` нормализует, не удалять.
- PowerShell-кавычки ломают сложные ssh-команды — пиши скрипты в `C:\Users\Oblre\AppData\Local\Temp\opencode\*.sh`, `scp` их и запускай `sh /tmp/x.sh`.
- `.codegraph/` в корне — локальный мусор codegraph MCP, **не коммитить** (добавить в `.gitignore`).

---

## 3. Бекапы (важно, не терять)

- **Сервер**: `~/backups/retaindb-20260923-092433.dump` (pg_dump custom format, 53MB).
- **ПК**: `backups/retaindb-20260923-092433.dump` (в OneDrive, `backups/` gitignored).
- Содержит `latency-pool-10000` (10k дистракторов) — **по требованию пользователя НЕ чистить**, он нужен для проверок просачивания мусора и гигиены.

---

## 4. Состояние git

**Закоммичено** (в `origin/main`, локально синхронизировано):
```
b3aa123 feat(qa): golden set 200 core + hygiene injections + distractor isolation
a90e011 fix(retrieval): HNSW + per-query ef_search (TD-001)
6ff49c1 docs(bench): Stage 1 completion
d654c6d fix(ingestion-queue): rewrite под OSS schema (TD-006)
e1a2b87 docs(research): Stage 1 live-run + 5 bugs
1232fcb fix(search,api,auth): benchmark correctness + OSS admin (TD-007/008)
4196326 feat(bench): Stage 1 benchmark suite + telemetry drop-off
```

**НЕ закоммичено (главное — это и есть текущая работа):**

| Файл | Что |
|---|---|
| `architecture/ADR-013-adaptive-retrieval-window.md` | **новый ADR** — adaptive window (Proposed) |
| `packages/server/src/engine/retrieval/window-selector.ts` | **новый** — 4 стратегии + registry |
| `packages/server/src/__tests__/engine/retrieval/window-selector.test.ts` | **новый** — 7 тестов (зелёные) |
| `packages/server/src/config.ts` | `retrieval.window.{recall,rerank,delivery}` + `retrieval.ann` |
| `packages/server/src/engine/memory/search.ts` | S1 recall через `selectWindow` (вместо `topK*3`) |
| `packages/server/src/__tests__/config-benchmark-telemetry.test.ts` | тесты window + ann |
| `architecture/ADR-009-memory-hygiene.md` | §2 «Сигналы селекции» — signal decomposition |
| `architecture/ADR-007-layered-retrieval-pipeline.md` | правила: ranking=relevance, recency=tie-breaker |
| `architecture/ADR-011-telemetry-quality-control.md` | ссылка на ADR-013 |
| `research/2026-09-08-adr-implementation-order.md` | план этапов перераспределён |

**Тесты на сервере: 393 passed** (33 файла), включая новые window-selector (7) + config-window (2).

---

## 5. Что сделано за сессию (сводка)

### Этап 1 — измеримость ✅
Benchmark suite (`scripts/benchmark/{run,metrics,gate,report,gen_pool}.py`), LLM-judge (`engine/memory/judge.ts` + `/v1/admin/benchmark/judge`, reuse task `dialectic`), TelemetryCollector (`engine/telemetry/collector.ts` + `/v1/admin/telemetry/drop-off`, динамические `MemoryStage[]`), per-layer drop-off.

### Найденные и исправленные баги
- **auth**: `isAdmin` никогда не ставился → все `/v1/admin/*` были 403. OSS single-tenant → владелец ключа = admin.
- **`profile.default("fast")`** перекрывал `fast_mode:false`; **`fast_mode` перезаписывался** на lexical fallback.
- **seed → recall 0** из-за async-индексации → `wait_until_indexed`.
- **кэш искажал замеры** → `MEMORY_SEARCH_DISABLE_CACHE`.
- **`ingestion_jobs` schema mismatch** (cloud snake_case vs OSS camelCase, нет `ingestion_documents`) → `ingestion-queue.ts` переписан под OSS (`payload` jsonb). Async bulk: 202 → COMPLETED.
- **judge**: Proxy терял `this`; `deepseek-v4-pro` (reasoning) `max_tokens=300` → пустой content → поднят до 800.
- **TD-001**: IVFFlat `probes=1`/`lists=100` → recall 0.937@171 → 0.698@11k. Решено: HNSW + per-query `ef_search` через `set_config`.

### Данные
- `qa/golden-set.json` — **200 core** (51 старых + 149 новых: security/data/observability/qa/process/product/api/infra/legal).
- `qa/hygiene-injections.json` — **278** (correction 80, contradiction 68, near_duplicate 70, low_importance 60).
- `qa/qa-set.json` — **55 вопросов** (было 21).
- Distractor `latency-pool-10000` → изолирован в **project `distractor`** (иначе PROJECT-scope просачивается в golden-поиск).

### Baseline (при 200 core, HNSW, cache off)
```
recall@10 = 0.781   precision@10 = 0.091   mrr = 0.725   ndcg@10 = 0.718
recall@20 = 0.815   recall@30 = 0.846
```
Прежний 0.937 был при 51 записи — падение **ожидаемо** (top-10 = 5% корпуса vs 20%). Цель ADR-007/013 — поднять.

---

## 6. Ключевые архитектурные решения (важно для продолжения)

### ADR-013 «Adaptive retrieval window» (новый, Proposed)
Жёсткие топы (`topK*3=30`, `maxCandidates=20`) → **pluggable `WindowSelector`** на каждом слое (`recall/rerank/delivery`), конфиг `{strategy, min, max, params}`, всегда `clamp(k, min, max)`.

Стратегии (`engine/retrieval/window-selector.ts`):
- `fixed` — `k = params.k`.
- `relative-top` — `s_i ≥ δ·s_1`.
- `median-gap` — стоп при `gap > k·median(gaps)`.
- `curvature` (дефолт) — knee/Kneedle: `argmax(y_norm + x_norm − 1)`.

**Сделано**: S1 recall. **Осталось**: S2/S3 в `retriever.ts`, telemetry-счётчик `k`, калибровка δ/k.

### Signal decomposition (дополнено в ADR-009 §2 + ADR-007 правила)
Скаляр `importance` «мёртв» (LLM не назначает, дефолт 0.5). Разделить:
- `confidence` (0..1, хранится) — достоверность.
- `retention_class` (enum: `mandatory|critical|normal|transient|ephemeral`, хранится) — retention-политика; `mandatory` = не decay/archive/pin.
- `relevance` (0..1, **вычисляется** на запрос) — **главный сигнал ранжирования**.
- `recency` (**вычисляется**) — актуальность, только tie-breaker.

**Актуальность — 4 механизма** (не скалярный множитель): validity (hard filter validFrom/validUntil) / supersession (correction инвалидирует) / tie-breaker (recency) / retention (decay для гигиены, вне ответа).

**Ранжирование = relevance, не importance** (ADR-007). `mandatory` pin'ится только в S3 delivery.

---

## 7. Важные договорённости (не нарушать)

1. **Golden — синтетика**, узкая задача (smoke/regression). **Runtime-механизмы (окно) не зависят от golden** — ядро на геометрии скоров (gap/curvature/median-gap).
2. **Feedback** (ADR-011 §продукт) — **этап 2**, серьёзная инженерия; не сейчас.
3. **DeepSeek reasoning** (`deepseek-v4-pro/flash`) — `max_tokens` включает reasoning → ≥800 для extraction/judge.
4. **CPU-only** кроме LLM-задач (диалектика, LLM-rerank, управление, клининг).
5. **Distractor (10k) не чистить** — нужен для проверок просачивания/гигиены.
6. **Окно** = `min/max` (якоря из конфига) + стратегия режет внутри; K — эмерджентный результат, не константа.
7. `reviews/`, `qa/memory_map.json`, `qa/bench-*.json`, `backups/` — gitignored.

---

## 8. Что делать следующему агенту (по порядку)

1. **Закоммитить незакоммиченное** (см. §4) — одним логическим коммитом или двумя:
   - (a) `feat(retrieval): ADR-013 adaptive window — selectors + S1 integration`,
   - (b) `docs(architecture): signal decomposition in ADR-007/009 + impl order`.
   - Плюс добавить `.codegraph/` в `.gitignore`.
2. **Завершить ADR-013** (Этап 2 плана):
   - применить selector к `retriever.ts` S2 (rerank) и S3 (delivery);
   - telemetry-счётчик выбранного `k` (ADR-011);
   - прогнать recall на golden — проверить falsification (`recall@10 ≥ 0.83`).
3. **ADR-007 §S1 lexical-канал** (закрыть TD-005: `q-package-manager`=pnpm, `q-backend`=grpc-comms).
4. Дальше по плану: ADR-012 (inference providers) → ADR-009 schema (+retention_class/mandatory) → ADR-007 полный → ADR-009 процессы → ADR-011 полный.

Полный план — `research/2026-09-08-adr-implementation-order.md`.

---

## 9. Техдолг (TECH_DEBT.md)

Открытые: **TD-001** (HNSW уже сделан — закрыть в ledger), **TD-002** (изоляция — закрыть), **TD-003** (`SourceStatus "CONNECTING"` enum drift — scheduler), **TD-004** (seed не идемпотентен), **TD-005** (recall gaps pnpm/gRPC → ADR-007), **TD-009** (синтетика через LLM write-path → `gen_pool` должен писать embedding-only, иначе снова сожжёт деньги на relations-LLM).

---

## 10. Где что лежит (быстрые ссылки)

- ADR: `architecture/ADR-NNN-*.md` (001–013).
- Retrieval engine: `packages/server/src/engine/memory/search.ts`, `engine/retriever.ts`.
- Window: `packages/server/src/engine/retrieval/window-selector.ts`.
- Hygiene: `packages/server/src/engine/memory/{importance-decay,consolidation,dreamer,relations,session-lifecycle}.ts`.
- Benchmark: `scripts/benchmark/*.py`, `qa/{golden-set,hygiene-injections,qa-set}.json`.
- Телеметрия: `packages/server/src/engine/telemetry/collector.ts`.
- Judge: `packages/server/src/engine/memory/judge.ts`.
- Конфиг: `packages/server/src/config.ts`.
