# Session Handoff — 2026-09-24

> Детальный контекст для передачи работы следующему агенту. **Читать первым.**
> Проект: **Margo** — форк RetainDB, память-слой для AI-агентов.
> **Revision 2026-09-24**: переписан после аудита и фиксации ADR-014. Заменяет редакцию 2026-09-23
> (та сохранена как история со ссылкой сюда). Цель этой редакции — **подготовить покрытие этапов**.

## 0. Проверка, что контекст поднят (smoke test)

```bash
cd "C:\Users\Oblre\OneDrive\Рабочий стол\RetainDB"
git log --oneline -3        # ожидаем b3aa123 во главе, дальше a90e011, 6ff49c1
git status --short          # ожидаем 11 modified + 7 untracked (см. §4)
ls architecture/ADR-014*    # ADR-014 существует (принят 2026-09-24)
ssh -o BatchMode=yes pilarovds@46.16.36.148 'cd ~/Margo/packages/server && pnpm exec vitest run'
                            # ожидаем: 33 файла, 393 passed
codegraph status            # ожидаем: 229 файлов, 4052 узла, 12 576 рёбер
```

Если любое ожидание не сходится — **не начинать работу**, а сначала прочитать §4 (git) и §5 (что сделано).

---

## 1. Что это за проект (30 сек)

Margo хранит **рабочие памяти** (decisions / constraints / goals / procedures / corrections / preferences),
а не факты о пользователе. Два режима: local (JSON) и server (PostgreSQL + pgvector). Цель vs upstream —
**local-first, self-hostable, multi-provider LLM**.

Ключевые слова: retrieval pipeline (S0–S3), memory hygiene, pgvector + HNSW, LLM-judge, golden set,
adaptive window (ADR-013), incremental extraction (ADR-014).

**Где живут истины (не дублировать их!):**
- `AGENTS.md` — как устроен репозиторий, конфиг, тесты, workflow (читать обязательно).
- `architecture/ADR-NNN-*.md` — решения и их статусы.
- `research/2026-09-08-adr-implementation-order.md` — **единственный источник по порядку и состоянию этапов**,
  с exit criteria у каждого этапа и предусловиями P1–P5.
- `TECH_DEBT.md` — долг.

---

## 2. Инфраструктура

| Что | Значение |
|---|---|
| SSH | `pilarovds@46.16.36.148` (BatchMode, ключ по умолчанию) |
| Репо на сервере | `~/Margo` (clean git worktree, deploy-ключ, **источник коммитов**) |
| Локально (Windows) | `C:\Users\Oblre\OneDrive\Рабочий стол\RetainDB` |
| Postgres | `localhost:5432`, БД `retaindb`, user `pilarovds` |
| Сервер :3000 | `setsid nohup pnpm exec tsx src/index.ts`, env `MEMORY_SEARCH_DISABLE_CACHE=true` |
| API key | `margo-test-key` (из `.env`) |
| Package manager | pnpm 9.15.0; Node v22 на сервере |

**Workflow (обязательный):** локально правишь → `scp` на сервер → на сервере `git add/commit/push` →
локально `git fetch origin && git reset --hard origin/main`.

**Нюансы (проверено 2026-09-24):**
- **Node/pnpm локально нет** — тесты только на сервере. Локально есть `python` (не `python3`), им же
  гоняются `py_compile` и JSON-проверки; на сервере `python3` (3.10).
- **Docker-демон локально не запущен**, `psycopg` локально не установлен → локально проверяемы только
  сетевые/скриптовые ветки, всё docker/PG-зависимое — на сервере.
- **Доказательства живут на сервере, вне git**: `qa/bench-*.json` (33+ прогонов) и `reviews/BENCH-*.md`
  есть **только** в `~/Margo/`; в локальном клоне их нет, потому что `qa/bench-*.json` и `reviews/`
  в `.gitignore`. Не делать вывод «артефакта не существует» по локальному клону — сначала проверить сервер.
- CRLF vs LF: `.gitattributes` нормализует; при правках из агента git предупреждает про CRLF — это норма.
- PowerShell-кавычки ломают сложные ssh-команды: писать скрипты в `%LOCALAPPDATA%\Temp\*.sh`, `scp` и `sh /tmp/x.sh`.
- `.codegraph/` в корне — локальный индекс codegraph, **не коммитить** (в `.gitignore` его пока нет — см. §8).

---

## 3. Бекапы (не терять)

- **Сервер**: `~/backups/retaindb-20260923-092433.dump` (pg_dump custom format, 53 MB).
- **ПК**: `backups/retaindb-20260923-092433.dump` (в OneDrive, `backups/` gitignored).
- Содержит `latency-pool-10000` (10k дистракторов) — **не чистить**, нужен для проверок просачивания мусора.

---

## 4. Состояние git (коммит НЕ сделан — ждёт решения)

**В `origin/main` (локально синхронизировано):** `b3aa123` golden set 200 core · `a90e011` HNSW + ef_search ·
`6ff49c1` Stage 1 completion · `d654c6d` ingestion-queue под OSS · `e1a2b87` Stage 1 live-run ·
`1232fcb` benchmark correctness + OSS admin · `61a45da` Stage 1 spec · `4196326` benchmark suite.

**Незакоммичено — 11 modified + 7 untracked (всего 309 вставок / 93 удаления):**

| Modified | Что |
|---|---|
| `packages/server/src/engine/memory/search.ts` | S1 recall через `selectWindow` (окно ADR-013) |
| `packages/server/src/config.ts` | `retrieval.window.{recall,rerank,delivery}` + `retrieval.ann` |
| `packages/server/src/__tests__/config-benchmark-telemetry.test.ts` | тесты window + ann (2) |
| `architecture/ADR-007-layered-retrieval-pipeline.md` | правила ranking/recency + ссылка на ADR-014 |
| `architecture/ADR-009-memory-hygiene.md` | §2 «Сигналы селекции» — signal decomposition |
| `architecture/ADR-011-telemetry-quality-control.md` | ссылка на ADR-013 |
| `architecture/ADR-006-pgvector-schema-outside-prisma.md` | `**Implementation**: 🟡 partial` + TD-010 |
| `architecture/VISION.md` | убран лживый `Status`, статусы приведены к реальности |
| `AGENTS.md` | §8: статусы + ссылка на план этапов |
| `TECH_DEBT.md` | TD-001 → Resolved, TD-002 → partial, добавлены TD-009 и TD-010 |
| `research/2026-09-08-adr-implementation-order.md` | переработан: этапы, exit criteria, предусловия P1–P5 |

| Untracked | Что |
|---|---|
| `architecture/ADR-013-adaptive-retrieval-window.md` | окно (Proposed; S1 реализован) |
| `architecture/ADR-014-incremental-extraction-of-retrieval-layers.md` | **принят 2026-09-24** — как делать ADR-007 |
| `packages/server/src/engine/retrieval/window-selector.ts` | 4 стратегии + registry (125 строк) |
| `packages/server/src/__tests__/engine/retrieval/window-selector.test.ts` | 7 тестов (зелёные) |
| `research/2026-09-24-session-handoff.md` | этот файл |
| `research/2026-09-23-session-handoff.md` | заменённая редакция (сохранена как история; при коммите можно не включать) |
| `.codegraph/` | локальный индекс — **в коммит не включать** (и добавить в `.gitignore`) |

**Коммит блокирован вердиктом ревью**: работа по окну уезжает без прогона falsification ADR-013
(`recall@10 ≥ 0.83`). Сначала §8 шаг 0–1, потом коммит (предлагается двумя-тремя логическими коммитами:
`feat(retrieval): ADR-013 window`, `docs(architecture): signal decomposition + ADR-014`, `chore(debt): ledger sync`).

---

## 5. Что сделано 2026-09-24 (аудит + фиксы)

Аудит проведён с проверкой утверждений по коду и артефактам, а не по документам:

| Аудит | Результат |
|---|---|
| Ревью незакоммиченной работы ADR-013 | **0 Critical / 4 Important / 6 Minor**, вердикт **Needs fixes** |
| Оценка 13 ADR по 8 критериям | средний **5.6/8**; статус честен у 6, частичен у 4, нарушен у 1 |
| Аудит плана этапов | датасеты точны (200/278/55), 2 утверждения о долге неверны, **3 предусловия были потеряны**, exit criteria отсутствовали |
| Сверка статусов с кодом | ADR-002/003 реально реализованы; ADR-004/009/011/012 — нет; ADR-006 Accepted с нарушенным compliance (27 вхождений `<=>` в 5 файлах) |
| Тесты | **393 passed / 33 файла** (прогнано на сервере) |

**Исправлено этим проходом:** план этапов переработан (карта состояния по 14 ADR, предусловия P1–P5,
exit criteria у каждого этапа, `ADR-006-ext` → расширение ADR-006, риск №6); леджер приведён в порядок
(TD-001 resolved, TD-002 partial, +TD-009, +TD-010); `VISION.md` и `AGENTS.md` §8 синхронизированы;
шапка ADR-006 помечена `partial`; принят ADR-014.

Подробности — в `reviews/REVIEW-2026-09-24.md` и `reviews/ADR-EVALUATION-2026-09-24.md` (**gitignored**,
есть только локально; их выводы продублированы здесь и в леджере — на сервере файлов не будет).

---

## 6. Ключевые решения, которые надо знать

**ADR-013 «Adaptive retrieval window»** (S1 сделан): жёсткие топы → pluggable `WindowSelector` на каждом
слое `{strategy, min, max, params}` с `clamp(k, min, max)`; стратегии `fixed` / `relative-top` /
`median-gap` / `curvature` (дефолт). **Слабые места, найденные ревью:** дефолт `curvature + min=10` на
гладких кривых схлопывается в нижнюю границу (замер: linear-100 → k=10, exp-decay → k=10), то есть в окно
**меньше** прежнего `topK*3=30`; стратегия неустойчива (та же кривая с шумом ±0.002 → k=78); конфиг окна не
валидируется (опечатка стратегии → `fixed` с `max=100`); окно применяется к сырому `similarity` **до**
`rerankByScope`. Всё это лечится до коммита (§8 шаг 2).

**ADR-014 «Incremental extraction of retrieval layers»** — принят 2026-09-24, четыре решения:
(1) strangler по слоям в `main`; (2) legacy-путь памяти за флагом `retrieval_profile` (A/B и откат — одна
строка конфига); (3) два входа `pipeline.memory()` / `pipeline.documents()` при общих S0/S2/S3 и разных
наборах S1-каналов; (4) `importance` уходит из ранжирования на шаге S1-унификации.
Карта модулей уточняет ADR-007 и **добавляет три модуля**: `recall/memory.ts` (в ADR-007 пути памяти не
было вовсе, а в коде их два с разными сигналами ранжирования), `rerank/intent.ts` (`rerankByIntent` живёт
в `search.ts:87`), `delivery/enrich.ts`.

**Signal decomposition** (ADR-009 §2 + ADR-007): скаляр `importance` мёртв → `retention_class` (хранимый
enum: mandatory/critical/normal/transient/ephemeral) + вычисляемые `relevance` и `recency`; актуальность —
4 механизма (validity / supersession / tie-breaker / retention), а не скалярный множитель. Ранжирование =
relevance, `mandatory` pin'ится только в S3.

**Факты о монолитах, которые будут разделять:** `search.ts` 954 строк (`searchMemories` = 317),
`retriever.ts` 1963 (`retrieve()` = 433) — 2917 строк; публичная поверхность мала (`retrieve` — 2
импортёра, `searchMemories`, экспортированные тестовые хелперы); `fullTextSearch` содержит **три**
почти идентичных SQL-блока `ts_rank_cd` (1099/1138/1176); `estimateTokens` определён **четыре** раза.

---

## 7. Договорённости (не нарушать)

1. **Golden — синтетика**, узкая задача (smoke/regression). Runtime-механизмы (окно) не зависят от golden:
   ядро на геометрии скоров.
2. **Feedback** (ADR-011 §продукт) — поздний этап (Этап 7), не сейчас.
3. **DeepSeek reasoning** (`deepseek-v4-pro/flash`) — `max_tokens` включает reasoning → ≥800 для extraction/judge.
4. **CPU-only** кроме LLM-задач (диалектика, LLM-rerank, управление, клининг).
5. **Distractor (10k) не чистить** — нужен для проверок просачивания/гигиены.
6. **Окно** = `min/max` (якоря из конфига) + стратегия режет внутри; K — эмерджентный результат.
7. `reviews/`, `qa/memory_map.json`, `qa/bench-*.json`, `backups/` — gitignored.

**Новые договорённости (2026-09-24):**
8. **План `research/2026-09-08-adr-implementation-order.md` — единственный источник по порядку и состоянию
   этапов.** Статусы решений — в шапках ADR; не дублировать их в других файлах.
9. **Приёмка = показанный вывод**, а не утверждение: этап или шаг закрывается воспроизведённой командой
   и её результатом. «Тесты зелёные» без вывода не считается.
10. **Baseline — только именованным файлом** (`qa/baseline-2026-09-24.json`), иначе критерии неgradable;
    абсолютные числа вроде `recall@10 ≥ 0.90` (корпус в 51 запись) больше не использовать.
11. **`importance` не участвует в ранжировании** — убрать на шаге S1-унификации (ADR-014 решение 4).
12. Незакоммиченная работа не расширяется до прогона гейта: сначала измерить, потом коммитить.

---

## 8. Покрытие этапов: что делать по шагам

Порядок и exit criteria — в плане (Этапы 2.0 → 2 → 3 → …). Ниже — operational runbook первого дня.
**Каждый шаг = отдельный коммит после показанного PASS.**

### Шаг 0 (Этап 2.0) — закрепить baseline + починить TD-002

```bash
# 0.1 фикс тулинга (локально): в scripts/benchmark/gen_pool.py дефолт --project → distractor,
#     в qa/latency-set.json project: "default" → "distractor"
# 0.2 первый прогон: пишет и qa/baseline-<дата>.json, и qa/baseline.json (мержит метрики)
ssh -o BatchMode=yes pilarovds@46.16.36.148 'cd ~/Margo && python3 scripts/benchmark/run.py --suite retrieval --k 10 --write-baseline'
# 0.3 второй прогон БЕЗ --write-baseline: сравнивает с qa/baseline.json и печатает gate-результат
ssh -o BatchMode=yes pilarovds@46.16.36.148 'cd ~/Margo && python3 scripts/benchmark/run.py --suite retrieval --k 10'
```
Exit: расхождение между прогонами ≤ 1 п.п. по `recall@10`; `qa/baseline-2026-09-24.json` закоммичен
(он tracked; `qa/bench-*.json` — нет). **Это же закрывает предусловие P1** и разблокирует приёмку Этапа 2.

### Шаг 1 (Этап 2.0) — tracing без изменения поведения

`engine/retrieval/types.ts` (`Candidate`, `LayerTrace`, `RetrievalMode`) + `engine/retrieval/trace.ts`;
per-layer `{in,out,dropped,ms,cutoff}` для S0–S3 встроить в существующие монолиты, **не меняя логику**.
Exit: drop-off виден в телеметрии, `recall@10` не изменился ни на пункт (сравнение с P1-файлом).

### Шаг 2 (Этап 2) — закрыть ADR-013 и снять блокер коммита

A/B делается **без правок кода** — конфиг читается из env:

```bash
ssh ... 'cd ~/Margo && WINDOW_RECALL_STRATEGY=fixed WINDOW_RECALL_MAX=30 python3 scripts/benchmark/run.py --suite retrieval --k 10'   # старое поведение
ssh ... 'cd ~/Margo && python3 scripts/benchmark/run.py --suite retrieval --k 10'                                                    # дефолт (curvature, min=10)
```
Плюс исправить три находки ревью (валидация конфига окна, порядок `rerankByScope` → `selectWindow`,
telemetry-счётчик `k`), затем доделать S2/S3 окна в `retriever.ts`.
Exit: falsification ADR-013 — `recall@10 ≥ 0.83` и `p99 ≤ +10%` против P1-файла; гейт PASS.

### Дальше

- **Шаг 3** (Этап 2): lexical-канал S1 → `recall/lexical.ts`, коллапс трёх SQL-блоков; закрывает TD-005
  (`q-package-manager` ≠ 0, `q-backend` ≥ 0.67).
- Затем Этап 3 (ADR-012 + расширение ADR-006), Этап 4 (schema), Этап 5 (рефакторинг по ADR-014 шаги 2–8).
- **`.codegraph/` в `.gitignore`** — сделать до первого `git add -A`, иначе индекс уедет в коммит.

---

## 9. Техдолг (актуально на 2026-09-24)

**Open:** TD-002 (`gen_pool --project` — изоляция не воспроизводима, шаг 0), TD-003 (`SourceStatus
"CONNECTING"` enum drift), TD-004 (seed не идемпотентен), TD-005 (recall gaps pnpm/gRPC → Этап 2),
**TD-009** (генерация синтетики идёт через LLM write-path и жжёт деньги → embedding-only),
**TD-010** (`<=>` вне `db/vector.ts`: 27 вхождений в 5 файлах; либо миграция, либо переписать compliance ADR-006).
**Resolved:** TD-001 (`a90e011`), TD-006 (`d654c6d`), TD-007, TD-008 (`1232fcb`).

---

## 10. Быстрые ссылки

- План и состояние этапов: `research/2026-09-08-adr-implementation-order.md`
- ADR: `architecture/ADR-001…014.md` + `VISION.md` (документ видения, не ADR)
- Retrieval: `packages/server/src/engine/memory/search.ts`, `engine/retriever.ts`
- Окно: `packages/server/src/engine/retrieval/window-selector.ts`
- Гигиена: `engine/memory/{importance-decay,consolidation,dreamer,relations,session-lifecycle}.ts`
- Бенчмарк: `scripts/benchmark/{run,metrics,gate,report,gen_pool}.py`, `qa/{golden-set,hygiene-injections,qa-set,latency-set}.json`
- Телеметрия: `engine/telemetry/collector.ts`; judge: `engine/memory/judge.ts`; конфиг: `src/config.ts`
- Локальные (gitignored) аудиты: `reviews/REVIEW-2026-09-24.md`, `reviews/ADR-EVALUATION-2026-09-24.md`

---

## 11. Ждёт решения человека (не делать без ответа)

1. **Коммит** накопленного пакета (§4) — предлагается после шага 2 (когда окно пройдёт гейт).
2. **I1**: переформулировать falsification-критерии ADR-007/009/013 в дельту к именованному baseline-файлу.
3. **I4**: где живёт критерий улучшения ADR-013 (+5 п.п.) в механике ADR-010 (там только допуск на ухудшение).
4. **Конвенция `Implementation`** в шапках 13 ADR (образец — ADR-006).
5. **M2/M6**: разделение ADR-007/009/012/013 на «решение» и «программу» (не трогали).
