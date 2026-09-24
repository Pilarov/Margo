# ADR Implementation Order

**Date**: 2026-09-08 · **Revision**: 2026-09-24 (перенумерация этапов; exit criteria у каждого этапа; предусловия вынесены в отдельный раздел; статусы сверены с кодом)
**Status**: Recommendation — **единственный источник истины по порядку и состоянию этапов**. Статусы самих решений живут в шапках ADR; этот файл их не дублирует, а описывает *состояние реализации*.
**Context**: Порядок реализации ADR-004, ADR-006, ADR-007, ADR-009, ADR-010 (вкл. влитый ADR-008), ADR-011, ADR-012 (сквозной), ADR-013 (adaptive retrieval window), ADR-014 (стратегия перехода к ADR-007).

**Обозначения**: ✅ выполнено · 🟡 частично (что именно — рядом) · ⬜ не начато · ❌ отклонено.
Этап закрывается прогоном гейта ADR-010 (ADR-011 даёт drop-off по слоям): приёмка фиксируется **показанным выводом**, а не утверждением. У каждого этапа ниже есть exit criteria — проверяемое условие плюс команда, которой оно проверяется.

## Goal

Безопасный порядок, где самый рискованный рефакторинг (ADR-007) выполняется **под gate**, а быстрые победы (window, lexical) идут раньше — они не зависят от смены моделей и дают измеримый recall сразу.

## Принцип

```
измеримость ✅ → предусловия (baseline + tracing) → retrieval-быстрые победы → inference-фундамент → schema-база → главный рефакторинг → эксплуатация → автономия
```

## Состояние (сверено с кодом 2026-09-24)

| ADR | Реализация | Что именно в дереве / чего нет |
|---|---|---|
| 001 Memory lifecycle v2 | 🟡 через детей | 002/003 сделаны, 004 — нет; у самого ADR-001 нет falsification-критериев |
| 002 One-pass extraction | ✅ | `EXTRACTION_MODE` (`config.ts:193-197`) + `extractor-onepass.test.ts` |
| 003 Dreamer consolidation | ✅ | `CONSOLIDATION_MODE` (`config.ts:211-215`) + `dreamer.integration.test.ts` |
| 004 Progressive context | ⬜ | нет `summary` в схеме, нет `generateMemorySummary`, нет LLM-задачи `summarization`; `WRITE_MODE` не существует (в коде `MEMORY_WRITE_MODE_DEFAULT`) |
| 005 Knowledge→skill | ❌ | отклонён 2026-09-08, не реализуется |
| 006 pgvector вне Prisma | 🟡 | `db/vector.ts` + идемпотентный SQL есть; миграция `<=>` не выполнена — 27 вхождений в 5 файлах (TD-010), пункт §Compliance нарушен |
| 007 Retrieval S0–S3 | 🟡 | только side-правила внутри монолитов (type-recall, `precision_v1`); каталога `engine/retrieval/*` нет |
| 008 LLM-judge | ✅ | влит в ADR-010 §7 |
| 009 Memory hygiene | ⬜ | нет `state`/`embedding_status` в схеме, нет `/v1/admin/hygiene/*` |
| 010 Benchmarking | 🟡 | suite + `gate.py` + baseline + `benchmark`-секция (`config.ts:226/242`) есть; нет `qa/cost-set.json` и `benchmark.gates` в `retaindb.config.json` |
| 011 Telemetry & QC | 🟡 | `engine/telemetry/collector.ts` + drop-off есть; control loop, L1/L2, alerting — нет |
| 012 Inference providers | ⬜ | интерфейсов `EmbeddingProvider`/`RerankProvider` нет |
| 013 Adaptive window | 🟡 | S1 сделано: окно + валидация конфига + счётчик `k` в телеметрии (`search.ts`, `retrieval/window-selector.ts`); `recall.min=30` — по замеру (A/B 2026-09-24, `reviews/AB-ADR-013-2026-09-24.md`); S2/S3 и калибровка δ/k — нет |
| 014 Incremental extraction | 🟡 | шаги 0–1 сделаны 2026-09-24 (`types.ts` + `trace.ts`, S0–S3 в телеметрии обоих монолитов); шаги 2–8 не начаты |

Долг: **TD-001** закрыт кодом (`a90e011`) — в леджере был `Open`, исправлено 2026-09-24; **TD-002** закрыт
(`81779d8`: дефолт `--project distractor` + `qa/latency-set.json`, проверено повторным прогоном, изоляция
подтверждена запросом к `distractor`/`default`); **TD-006** ✅ (`d654c6d`); **TD-009** (синтетика через LLM
write-path) был только в handoff — заведён в леджер; **TD-010** (`<=>` вне `db/vector.ts`) — новый;
**TD-011** (латентностного baseline-файла нет — `p99`-критерий неgradable) — новый, найден A/B 2026-09-24.

## Предусловия и блокеры (без них exit criteria не измеримы)

| # | Предусловие | Состояние | Критерий закрытия |
|---|---|---|---|
| P1 | Baseline закреплён отдельным файлом (`qa/baseline-2026-09-24.json`) | ✅ `81779d8` | `recall@10` воспроизводится дважды, расхождение ≤ 1 п.п. (0.787037 оба прогона, 0.000 п.п.) |
| P2 | `qa/memory_map.json` — `run.py` берёт из него user (`RETAINDB_USER` → `mem_map["user"]`) | 🟡 файл есть в `~/Margo/qa/` (12 328 Б), в git нет (gitignored) | прогон воспроизводится без ручного `RETAINDB_USER` — да, на сервере; из чистого клона нужен `--reseed` |
| P3 | `reviews/` в `.gitignore:13`, а ADR-010 §5 обещает `reviews/BENCH-*.md` (отчёты живут только на сервере) | ⬜ | отчёты попадают в git (ADR-010 §8 п.6 закрыл только baseline) либо ADR-010 §5 приведён к реальности |
| P4 | Схемы наборов неоднородны: `qa/latency-set.json` без поля `user` (там `user_template`) | ⬜ (проверено 2026-09-24: `qa-set`/`hygiene-injections` — `user`, `latency-set` — `user_template`) | все наборы имеют одинаковую схему юзера |
| P5 | TD-002: `gen_pool.py --project` по умолчанию пишет пулы в `default` → следующий latency-прогон загрязнит baseline | ✅ `81779d8` | дефолт `--project distractor`, проверено повторным прогоном |

## Этапы

### Этап 1 — Измеримость + датасеты ✅ (выполнено)

| # | ADR | Что | Статус |
|---|---|---|---|
| 1 | **ADR-010** | benchmark suite + gate + LLM-judge | ✅ |
| 2 | **ADR-011** ч.1 | TelemetryCollector + per-layer drop-off | ✅ |
| — | — | golden 200 core + hygiene 278 + qa-set 55, distractor изолирован | ✅ |

**Exit criteria (выполнено)**: гейт печатает PASS; baseline-файлы записаны; датасеты 200/278/55; 393 теста зелёных.

### Этап 2.0 — Предусловия (ADR-014, шаги 0–1)

Идут **до** быстрых побед: без замороженного baseline нечем закрыть критерий ADR-013, без per-layer
tracing — гейты шагов 2–7 рефакторинга. Обе работы принадлежат ADR-014, но исполняются здесь.

| Шаг | Что | Exit criteria |
|---|---|---|
| 0 ✅ | P1 + P5: закрепить baseline файлом; `gen_pool.py --project distractor` по умолчанию | `recall@10` воспроизводится дважды, расхождение ≤ 1 п.п. — ✅ 0.787037 / 0.000 п.п. (`81779d8`) |
| 1 ✅ | `types.ts` + `trace.ts`; per-layer tracing встроен в монолиты **без изменения поведения** | drop-off виден в телеметрии, `recall@10` не изменился — ✅ фаннел S0–S3 с `{in,out,dropped,ms,cutoff}`, `recall@10` = 0.787 (2026-09-24) |

### Этап 2 — Retrieval: быстрые победы (текущий)

| # | ADR | Что | Зачем | Статус |
|---|---|---|---|---|
| 3 | **ADR-013** | ~~завершить window: S2/S3 в `retriever.ts`~~ — **снят решением ADR-015** (documents-путь вырезается целиком). Остаток шага: перекалибровка S1-окна на memory-пути после фузии | recall без жёстких топов | 🟡 снят (documents), перекалибровка S1 не начата |
| 4 | **ADR-007 §S1** | lexical-канал (OR-FTS) + фузия, стратегия конфигурируема (базовая RRF 1:1) — контракт в ADR-007 §S1 fusion contract | закрыть pnpm/gRPC gap (TD-005) | 🟡 контракт внесён 2026-09-24, реализация в работе |

**Как шаг 4 закрывает цель 54/54 (измерено 2026-09-24, `research/2026-09-24-fusion-semantic-lexical.md`):**
потолок объединения двух каналов на top-10 — **51/54** (37 закрывают оба, 6 только семантика, 8 только
лексика, 3 не закрывает никто). Послойный замер: S1 семантика @50 — 0.9753, после окна @30 — 0.8210,
лексика @50 — 0.8302, **union(окно ∪ лексика) — 0.9414**, S3 фузия @10 — 0.9012 (против 0.7685 сейчас).
Остаток хвоста делится: два вопроса обрезает S1-окно (reference на рангах 37 и 47 — их не вернёт никакой
S2/S3), один доходит до S2/S3 и проигрывает там (ранг 16). Поэтому остаток закрывается перекалибровкой
S1-окна и memory-шагами ADR-014, а documents-часть обоих шагов снята ADR-015.

Не зависят от ADR-012 — используют текущий embedding.

**Depends on**: Этап 2.0 (P1, P5) — иначе критерий не измерим.
**Exit criteria**: TD-005 закрыт — `q-package-manager` ≠ 0 (был 0.00) и `q-backend` ≥ 0.67, оба значения из `per_question` прогона, baseline `qa/baseline-2026-09-24.json`, протокол `run.py --suite retrieval --k 10`, допуск recall@10 не ниже baseline −2 п.п.; фузия обратима (semantic-only возвращает 0.787 ±2 п.п.); гейт ADR-010 — PASS.
~~`recall@10 ≥ 0.83` и `p99 ≤ +10%`~~ — **переобъявляются** по ADR-010 §8 п.1: первое — как дельта к baseline-файлу (с протоколом и допуском), второе — **неgradable** до реализации TD-011 compliance (латентностного baseline-файла нет), поэтому в закрытие Этапа 2 не входит и живёт в TD-011.

### Этап 2.5 — Вырезание documents-подсистемы (ADR-015)

Отдельный трек, не «быстрая победа»: подсистема вырезается по шагам, каждый — свой коммит под гейтом
ADR-010, и только шаг 5 является destructive.

| Шаг | Что | Приёмка |
|---|---|---|
| 1 | Граница: `ADR-015` + план + пометки в ADR-007/013/014 | ADR на месте, план без documents-пунктов |
| 2 | Memory-путь чистого листа: убрать `injectSourceChunks`, `ChunkMemory` и чанковые метаданные. Подсказка об источнике (что/где/когда) остаётся контентом памяти и проходит общий путь — типизация, скоуп, validity, фильтрация, модерация | memory-тесты зелёные, `recall@10` = 0.787 против P1-файла |
| 3 | Эндпоинты: `/v1/context/query`, `/v1/index(+bundle)`, `/v1/learn(+batch)`, 11 `/v1/sources/*`, `/v1/sync-jobs/*`, `github-tarball`, `/v1/jobs/:jobId`, admin ops queues/connectors/sources, rehydrate (сделано для `routes.ts`; остаются модули `context.ts`, `files.ts`, `research-agent.ts`, `search.ts`, `app.ts`, реестр контрактов, `route-controls`) | контрактный тест и `route-controls` обновлены, гейт PASS |
| 4 | Движок: 7 модулей (`retriever`, `compressor`, `chunker`, `ingestion-profiles`, `ingest`, `oracle-select` + документная ветка `ingestion-queue`) + 22 коннектора + их тесты. **Очередь и `ingestion_jobs` остаются** — async-запись памятей | сборка и память зелёные |
| 5 | Схема (destructive): `DROP` для `Source`, `SourceVersion`, `Document`, `Chunk`, `ChunkMemory` (**без `IngestionJob`**) | дамп БД сделан, `prisma validate`, сервер поднимается |
| 6 | Клиенты: SDK (`QueryResult`), MCP-payload, `packages/local`, research-agent (`search_documents`) | SDK-тесты зелёные, версия помечена |
| 7 | Гигиена: ingestion-сиды, документация, TD-003 закрыть как «снят удалением», TD-010 сократить | grep-критерий ADR-015 выполняется |

**Exit criteria**: критерии ADR-015 выполнены (`recall@10` = 0.787, схема без документных таблиц, grep чист,
продукт жив), TD-003 закрыт, TD-010 сокращён по факту.

### Этап 3 — Inference-фундамент (сквозной)

| # | ADR | Что | Зачем |
|---|---|---|---|
| 5 | **ADR-012** | провайдеры (`EmbeddingProvider`/`RerankProvider`), generic config, CPU-дефолты | `dim`/metric → всё остальное |
| 6 | **ADR-006 (расширение)** | `dim` из провайдера, `halfvec` (HNSW уже сделан — TD-001). Отдельного файла `ADR-006-ext` нет — расширение ведём в рамках ADR-012, чтобы не плодить ADR | схема под провайдера |
| 7 | — | **финальный baseline** на новых моделях | baseline на актуальной конфигурации |

**Depends on**: Этап 2 (быстрые победы) — dim-миграции позже них.
**Exit criteria**: grep-критерий ADR-012 выполняется (`bge-large|text-embedding-3-small|text-embedding-004|bge-reranker` не встречаются вне конфига/дефолтов); смена `dim` (384↔768) проходит без правок кода; полный retrieval работает без GPU и укладывается в CPU-SLO; финальный baseline записан отдельным файлом и объявлен новым основанием для гейта (ADR-010 §4).

### Этап 4 — Schema-база (одна миграция)

| # | ADR | Что | Зачем |
|---|---|---|---|
| 8 | **ADR-009 schema** | `state`, `embedding_status`, `embedding_model/dim`, **`retention_class` (enum), `mandatory`** + backfill | сигналы селекции (signal decomposition) |
| 9 | **ADR-004 Ph1** | `Memory.summary` + `generateMemorySummary()` + task `summarization` | сниппет S2/S3 |

`retention_class`/`mandatory` — новое из дополнения ADR-009 (signal decomposition): нужны до ADR-007 (S3 pin, S0 validity) и ADR-009 процессов (decay по retention_class, а не importance).

**Depends on**: Этап 3 (`dim` из провайдера) — одна миграция на всё.
**Exit criteria**: миграция идемпотентна (повторный прогон → no-op); backfill завершён — 0 записей без `state`/`embedding_status`; `summary` пишется при исходе `created`; `recall@10` не ниже порога ADR-010 (−2 п.п. к P1-файлу).

### Этап 5 — Главный рефакторинг

| # | ADR | Что | Зачем |
|---|---|---|---|
| 10 | **ADR-007** | S0 scope → S1 hybrid recall → S2 rerank → S3 delivery (relevance, recency tie-breaker) | под gate (010) + drop-off (011) |
| 10a | **ADR-014** | **как** перейти: strangler по слоям в `main` + legacy-путь за `retrieval_profile`, два входа с общим S0/S2/S3. Шаги 0–1 — в Этапе 2.0, здесь шаги 2–8 | без регресса и с откатом в одну строку |

**Depends on**: Этапы 3 и 4 (провайдеры и schema) + Этап 2.0 (tracing, baseline).

**Порядок шагов ADR-014 (принято 2026-09-24).** Каждый шаг — отдельный коммит под гейтом ADR-010;
следующий начинается только после PASS предыдущего. **Шаги 0–1 выполняются в Этапе 2.0** (предусловия,
см. выше) — здесь остаются шаги 2–8, то есть сам рефакторинг.

| Шаг | Что | Exit criteria |
|---|---|---|
| 2 | S0 → `scope-filter.ts` (+ scope в кэш-ключ) | eval-recall не упал; `write-helpers.test.ts` зелёный |
| 3 | S1 lexical → `recall/lexical.ts` (3 SQL-блока → 1, третий lexical унифицирован) | `q-package-manager` / `q-backend` поднимаются (TD-005) |
| 4 | S1 память: один `recall/memory.ts`; `importance` уходит из ранга | dialectic- и document-путь дают один порядок на одном наборе |
| 5 | S2 → `rerank/*`; одна нормализация score | `retriever.test.ts`, dialectic-контракт зелёные |
| 6 | S3 → `delivery/*` | precedence-тесты `packContext` |
| 7 | `pipeline.ts` + адаптеры; флип `retrieval_profile` | гейт ADR-010 + drop-off ADR-011 |
| 8 | Удаление шести дублей ADR-007 + паритет `packages/local` | отдельный трек |

**Exit criteria этапа**: falsification-критерии ADR-007 выполнены на текущем корпусе (числа пересчитаны против P1-файла);
`searchMemories()` ≤ 100 строк без SQL и скоринговых констант (документный близнец `retrieve()` вырезан ADR-015,
поэтому требование к нему снято); публичные контракты неизменны (`similarity`, `score`/`source`, memory-metadata,
экспортированные хелперы — source-inspection тесты зелёные).

### Этап 6 — Эксплуатация

| # | ADR | Что | Зачем |
|---|---|---|---|
| 11 | **ADR-009** процессы | reindex, reembed, cleanupRelations, decay (по retention_class), scheduler, `/v1/admin/hygiene/*` | жизненный цикл памяти |

**Depends on**: Этап 4 (schema: `state`, `embedding_status`, `retention_class`) и Этап 5 (reindex для ANN).
**Exit criteria**: каждый periodic/threshold-процесс идемпотентен (повторный прогон не меняет состояние БД — тест на снимках); после delete/supersede не остаётся dangling `MemoryRelation`; `/v1/admin/hygiene/status` отдаёт `{scanned,changed,errors,ms}` по каждому процессу; p99 `searchMemories`/`retrieve` не растёт более чем на 10% при параллельном прогоне.

### Этап 7 — Автономия

| # | ADR | Что | Зачем |
|---|---|---|---|
| 12 | **ADR-011** полный | QC, drift, MAPE-K control loop, tuner L0→L1→L2, feedback | тюнить window.strategy/params, ef_search, decay-пороги |

**Depends on**: Этапы 5 и 6 (есть что тюнить и чем мерить).
**Exit criteria**: искусственная деградация (например, отключение semantic-канала) поднимает alert в течение окна; тюнер применяет плохое значение → регресс бенчмарка → auto-rollback; телеметрия не содержит содержимого памятей/запросов (аудит логов); сбор телеметрии не увеличивает p99 retrieval более чем на 5%.

## Зависимости

```
ADR-010/011 ──────► всё (gate/drop-off)            ✅ сделано
ADR-014 (шаги 0–1) ► Этап 2 (baseline + tracing)   ← предусловие всех exit criteria
ADR-013 (window) ─► ADR-007 (S1/S2/S3 окна)        ← быстрые победы, до 012
ADR-007 §S1 lexical ► ADR-007 (RRF-фузия)
ADR-012 ──────────► ADR-006 (расш.) ──► ADR-009 schema (embedding_model/dim)
ADR-009 schema ──► ADR-007 (state/embedding_status/retention_class/mandatory)
ADR-009 schema ──► ADR-009 процессы (decay по retention_class)
ADR-004 Ph1 ─────► ADR-007 (summary = сниппет S2/S3)
ADR-007 ─────────► ADR-009 процессы (reindex для ANN)
```

**Ключевые инверсии:**
- **ADR-013 + lexical (Этап 2) — до ADR-012**: не зависят от смены моделей, дают recall сразу.
- **retention_class/mandatory — в ADR-009 schema (Этап 4), до ADR-007/процессов**: ranking и retention разделены (signal decomposition).
- **ADR-012 — до расширения ADR-006 и ADR-009** (задаёт `dim`), но **после** retrieval-побед.

## Что изменилось против прошлого порядка

| Было | Стало |
|---|---|
| ADR-012 сразу после измеримости | **ADR-013 window + lexical** раньше (быстрые победы, без смены моделей) |
| schema = state/embedding_status | schema += **retention_class/mandatory** (signal decomposition) |
| — | **ADR-013** как отдельный ADR (частично уже реализован) |
| importance-скаляр | **retention_class + relevance + recency** (дополнены ADR-007/009) |
| — (2026-09-24) | **Этап 2.0** (baseline + tracing) как предусловие; **ADR-014** как стратегия перехода; exit criteria у каждого этапа; предусловия вынесены в отдельный раздел; статусы сверены с кодом |

## Что можно параллелить

- **ADR-004 Ph1** и **ADR-009 schema** — одна миграция, разные файлы.
- **ADR-013 S2/S3** и **ADR-007 §S1 lexical** — независимые файлы (retriever vs search).
- **ADR-012** независим от Этапа 2 (можно параллельно, но dim-изменения до schema).

## Риски порядка

1. **ADR-012 меняет модели → recall.** Финальный baseline — после ADR-012; gate сравнивает с финальным.
2. **ADR-013 window + ADR-007 lexical оба меняют S1** — делать согласованно, иначе конфликты в `search.ts`. Механизм: одна ветка работ, шаг 3 (lexical) идёт после шага 2 (S0) в той же последовательности.
3. **retention_class/mandatory** — schema-миграция; до неё decay работает по importance (старый путь не сломать).
4. **`EMBEDDING_DIM` — публичный контракт** (`db/vector.ts:12` + тесты), а `<=>` встречается в **29 местах в 6 файлах** — менять metric/dim только в Этапе 3 (ADR-012 + расширение ADR-006).
5. **ADR-007 без Этапа 1** — незамеченный регресс; Этап 1 ✅, но **без P1 (baseline-файл) exit criteria не измеримы** — отсюда Этап 2.0.
6. **Порядок не проверяется, если гейт не прогоняется.** Незакоммиченная работа ADR-013 уже в дереве без прогона falsification — правило: шаг не закрыт, пока не показан PASS.

## Краткая сводка

```
✅ 1.   ADR-010 + ADR-011 ч.1 + датасеты              измеримость
   2.0 ADR-014 шаги 0–1 (baseline + tracing)          ✅ предусловие (P1, P5) закрыто
   2.  ADR-013 window (S2/S3) + lexical (S1)          retrieval-быстрые победы
   3.  ADR-012 + расширение ADR-006 + baseline        inference-фундамент
   4.  ADR-009 schema (+retention_class/mandatory) + ADR-004 Ph1
   5.  ADR-007 (S0–S3) + ADR-014 шаги 2–8           ← под gate
   6.  ADR-009 процессы (reindex/reembed/decay/cleanup)
   7.  ADR-011 полный (QC/control/feedback)
```
