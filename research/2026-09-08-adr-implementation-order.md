# ADR Implementation Order

**Date**: 2026-09-08
**Status**: Recommendation
**Context**: Порядок реализации ADR-004, ADR-007, ADR-009, ADR-010 (вкл. влитый ADR-008), ADR-011, ADR-012 (сквозной).

## Goal

Безопасный порядок реализации, при котором самый рискованный рефакторинг (ADR-007, ~2800 строк) выполняется **под защитой метрик**, а inference-фундамент (ADR-012) — до schema-волны.

## Принцип

```
измеримость → inference-фундамент → schema-база → главный рефакторинг → эксплуатация → автономия
```

ADR-007 — в середине, под gate. ADR-012 — сквозной, до schema (задаёт `dim`/metric).

## Этапы

### Этап 1 — Измеримость (инфраструктура)

| # | ADR | Что | Зачем |
|---|---|---|---|
| 1 | **ADR-010** | benchmark suite + regression gate + **LLM-judge (§7)**; черновой baseline на текущем коде | Без gate любой рефакторинг слеп |
| 2 | **ADR-011** ч.1 | TelemetryCollector + **per-layer drop-off** (additive к `MemorySearchDiagnostics`) | Видеть, где теряется релевантное |

Попутно (предусловия): user-mismatch (`qa-set.json:2` vs `seed-dialectic-data.py:22`), regen `qa/memory_map.json`, `reviews/` из `.gitignore`.

### Этап 2 — Inference-фундамент (сквозной)

| # | ADR | Что | Зачем |
|---|---|---|---|
| 3 | **ADR-012** | провайдеры (`EmbeddingProvider`/`RerankProvider`), generic config, CPU-дефолты, смена моделей (en→multilingual) | Определяет `dim`/metric → всё остальное |
| 4 | **ADR-006-ext** | `dim` из провайдера (не константа), `halfvec`, ANN | Расширение принятого ADR-006 под ADR-012 |
| 5 | — | **финальный baseline** на новых моделях | Baseline должен быть на актуальной конфигурации |

### Этап 3 — Schema-база (одна миграция)

| # | ADR | Что | Зачем |
|---|---|---|---|
| 6 | **ADR-004** Ph1 | `Memory.summary` + `generateMemorySummary()` + task `summarization` | Сниппет S2/S3 |
| 7 | **ADR-009** schema | `state`, `embedding_status`, `embedding_model/dim` + backfill | ADR-007 зависит от `embedding_status`/`state` |

### Этап 4 — Главный рефакторинг

| # | ADR | Что | Зачем |
|---|---|---|---|
| 8 | **ADR-007** | S0 scope → S1 hybrid recall (type/lexical/semantic/graph/fast) → S2 rerank → S3 delivery | Под gate (010) + drop-off (011) |

### Этап 5 — Эксплуатация

| # | ADR | Что | Зачем |
|---|---|---|---|
| 9 | **ADR-009** процессы | reindex, reembed, cleanupRelations, транзакции, scheduler, `/v1/admin/hygiene/*` | reembed нужен при смене провайдера |

### Этап 6 — Автономия

| # | ADR | Что | Зачем |
|---|---|---|---|
| 10 | **ADR-011** полный | QC, drift, MAPE-K control loop, tuner L0→L1→L2 | Тюнить только измеримое |

## Зависимости

```
ADR-012 ────→ ADR-006-ext (dim/metric) ────→ ADR-009 schema (embedding_dim)
ADR-012 ────→ ADR-007 (провайдеры в S0–S3)
ADR-010 ────→ ADR-007 (gate = право применить)   ← КРИТИЧНО
ADR-011 ────→ ADR-007 (drop-off = где теряется)
ADR-004 ────→ ADR-007 (summary = сниппет S2/S3)
ADR-009 ────→ ADR-007 (embedding_status, state)
ADR-007 ────→ ADR-009 (reindex для ANN-стратегии)   ← обратная
```

**Ключевые инверсии:**
- **ADR-012 — до ADR-006-ext/009**: задаёт `dim`.
- **Gate-инфраструктура — до ADR-007**, но **финальный baseline — после ADR-012** (на новых моделях).
- **ADR-009 процессы — после ADR-007**: reindex знает ANN-стратегию.

## Что изменилось против прошлого порядка

| Было | Стало |
|---|---|
| ADR-010 → ADR-011 → schema → ADR-007 | + **ADR-012** между измеримостью и schema |
| baseline один (Этап 1) | baseline **дважды**: черновой (010), финальный — после 012 |
| `dim` = константа 1024 | `dim` = **свойство провайдера** (012) |

## Что можно параллелить

- **ADR-004 Ph1** и **ADR-009 schema** — одна миграция, разные файлы.
- **ADR-011 ч.1** — независим (additive).
- **ADR-010 §7 (LLM-judge)** и остальной benchmark — внутри одного ADR.

## Риски порядка

1. **ADR-012 меняет модели → меняет recall.** Черновой baseline (010) и финальный — разные; gate сравнивает с финальным.
2. **ADR-012 + ADR-006-ext + ADR-009 schema пересекаются** по `dim`/колонке — делать согласованно.
3. **CPU-first** снижает качество дефолтов — baseline на CPU-моделях скромнее; это не регресс.
4. **`EMBEDDING_DIM` — публичный контракт** (тесты, 29 сайтов `<=>`) — менять в одном этапе.
5. **ADR-007 без Этапа 1** — незамеченный регресс. Не начинать.

## Краткая сводка

```
1. ADR-010 (benchmark+gate+judge)  ┐
2. ADR-011 ч.1 (drop-off)          ┘  измеримость
3. ADR-012 (inference providers)      inference-фундамент
4. ADR-006-ext (dim/halfvec)
5. финальный baseline
6. ADR-004 Ph1 + ADR-009 schema       одна миграция
7. ADR-007 (S0–S3)                 ← под gate
8. ADR-009 процессы (reindex/reembed/cleanup)
9. ADR-011 полный (QC/control)
```
