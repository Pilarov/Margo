# ADR-011: Telemetry & quality control

**Status**: Proposed
**Date**: 2026-09-08
**Deciders**: opencode + dspilarov

> Парный ADR: **ADR-010 (Benchmarking & regression)**. Телеметрия отвечает на вопрос «что происходит сейчас», бенчмарк — «стало ли хуже». Control loop использует телеметрию как сигнал и бенчмарк как право применить изменение.

## Context

В Margo есть несколько observability-модулей, но они **разрознены** и не образуют единый контур контроля:

| Модуль | Что даёт | Где |
|---|---|---|
| `latency-tracing.ts` / `middleware/latency-trace.ts` | latency-метрики | `admin/latency/*` |
| `ops-observability.ts` | очереди, коннекторы, counters | `admin/ops/*` |
| `extraction-observability.ts` | extraction-статистика | `admin/extraction/*` |
| `cost-optimization.ts` | стоимость | `cost/*` |
| `trace.ts` | trace-id | сквозной |
| `diagnosticsCollector` | latency-разбивка поиска | `searchMemories` |

Проблемы:
1. **Нет единого metrics store** — метрики разбросаны по модулям и in-memory.
2. **Нет per-layer drop-off** (S0–S3, ADR-007) — не видно, где теряется релевантное.
3. **Нет контроля качества в live** — дрейф, деградация, галлюцинации не детектятся.
4. **Нет data-quality проверок** — dangling-связи, битые/отсутствующие вектора, orphaned chunks.
5. **Нет control loop** — параметры тюнит человек вручную, без обратной связи.
6. **Нет алертинга** по SLO.

## Decision

**Ввести единый слой телеметрии и контроля качества: сбор метрик по категориям, live QC-проверки, data-quality аудит и control loop (MAPE-K) с уровнями автономности и guardrails. Телеметрия отделена от бенчмарка (ADR-010).**

### 1. Телеметрия — что собираем

| Категория | Метрики |
|---|---|
| Латентность | p50/p95/p99 по слоям S0–S3, cache ms, embed ms |
| Качество | drop-off по слоям (сколько отсек каждый), index recall, embedding coverage |
| Стоимость | токены, LLM-вызовы, $ per query |
| Здоровье | cache hit rate, error rate, timeout rate, queue depth |
| Продукт | feedback (👍/👎), session success, повторные запросы |

Сбор: единый collector (агрегирует существующие модули) → metrics store. Retention и агрегация (raw → 1m → 1h → 1d) — в конфиге.

### 2. Контроль качества (live QC)

- **SLO-проверки**: latency > порога, error rate > порога, cache hit < порога → alert.
- **Drift detection**: распределение score/запросов, доля пустых результатов, изменение drop-off по слоям.
- **Data quality**: dangling `MemoryRelation`, записи без векторов (`embedding_status`), orphaned chunks, expired-но-активные.
- **Answer quality** (диалектика): sampled LLM-judge (ADR-008) + пользовательский feedback.
- **Consistency**: сверка индекса с данными (ANN recall на сэмпле).

### 3. Control loop (MAPE-K)

```
Monitor  → телеметрия + бенчмарк
Analyze  → метрики vs baseline, детект регресса/дрейфа
Plan     → предложить изменение «краника»
Execute  → применить (canary) + замерить
Knowledge→ история изменений и их эффект
   ↑____________________________________│
```

«Краники» (что тюнится): retrieval-пороги, `crossEncoder.weight`, `llmRerank.min/max`, `hnsw.efSearch`, `ivfflat.probes`, decay-скорости, интервалы hygiene, batch/temperature LLM.

**Не тюнится**: scope/validity-предикаты, retention/privacy (целостность).

### 4. Уровни автономности

| Уровень | Поведение |
|---|---|
| **L0** | только телеметрия; тюнит человек |
| **L1** | ИИ предлагает, человек применяет |
| **L2** | ИИ применяет в safe-диапазонах + авто-откат при регрессе |
| **L3** | полная автономия |

Рекомендация: L0 → L1 → L2. L3 — только после стабильных бенчмарков.

### 5. Guardrails

1. **Safe-ranges** — допустимый диапазон каждого «краника».
2. **Canary** — изменение на части трафика/тенанта.
3. **Auto-rollback** — регресс бенчмарка (ADR-010 gate) → откат.
4. **Shadow** — значение считается, но не влияет (сравнение).
5. **Multi-objective** — нельзя оптимизировать latency за счёт recall без явного решения.
6. **Аудит** — каждое изменение: кто/что/когда/эффект.

### 6. Компоненты

```
Telemetry collector  (агрегация существующих модулей)
        │
Metrics store        (time-series / агрегаты)
        │
Quality control      (SLO, drift, data-quality, answer-quality)
        │
Scorer               (единая multi-objective оценка)
        │
Tuner (control plane)(L1→L2: предложение/применение)
        │
Config store         (retaindb.config.json + версии + rollback)
        │
Alerting             (SLO/QC-нарушения)
```

### 7. Конфиг

`retaindb.config.json` → `telemetry` и `control`:
- `telemetry.{collector,store,retention,aggregation}`.
- `control.{level(L0|L1|L2),safeRanges,canary,shadow,rollback}`.
- `quality.{slo,drift,dataQuality,answerQualitySampling}`.

## Alternatives Considered

### Option A: Оставить разрозненные observability-модули
- **Pros**: ноль работы.
- **Cons**: нет единого store, нет drop-off, нет QC, нет control loop.
- **Why rejected**: без контура контроля тюнинг невозможен.

### Option B: Внешний APM (Datadog/Grafana + Prometheus)
- **Pros**: зрелая инфраструктура.
- **Cons**: тяжёлая зависимость, противоречит self-hosted/local-first, чужие метрики.
- **Why rejected**: можно интегрировать позже как экспортёр, но ядро — своё.

### Option C: Сразу L3 (полная автономия)
- **Pros**: минимум ручной работы.
- **Cons**: высокий риск деградации/целостности; нет доверия к guardrails.
- **Why rejected**: начинать с L0→L1, L2 только после стабильных бенчмарков.

### Option D: Только бенчмарк (ADR-010), без live-телеметрии
- **Pros**: проще.
- **Cons**: нет сигнала о текущем состоянии; дрейф между прогонами не виден.
- **Why rejected**: телеметрия и бенчмарк ортогональны.

## Consequences

### Positive
- **Единый взгляд** на состояние сервиса (латентность, качество, стоимость, здоровье).
- **Раннее обнаружение** дрейфа и деградации.
- **Основа для self-tuning** (L1→L2) с guardrails.
- **Data-quality аудит** ловит битые связи/вектора.

### Negative
- **Сложность**: +collector, +store, +scorer, +tuner.
- **Стоимость телеметрии** (хранение, вычисление).
- **Риск неверного тюнинга** — митигируется guardrails и L1-режимом.

### Neutral
- Часть существующих модулей переезжает под единый collector.
- Feedback (продуктовый) требует отдельного канала, если его нет.

## Risks / Weaknesses

- **Multi-objective конфликт**: latency vs recall vs cost — нужна явная функция/ Pareto.
- **Шум телеметрии**: live-сигнал нестабилен — нужны окна и baseline (ADR-010).
- **Переобучение тюнера** на golden set — нужен holdout (ADR-010).
- **Наблюдаемость без тестов** — нужны тесты на детект регресса/дрейфа.
- **Приватность**: телеметрия не должна логировать содержимое памятей (только метрики).

## Open Questions

- Metrics store: in-process (JSON) vs time-series (SQLite/Prometheus)?
- Scorer: как агрегировать multi-objective в одну оценку (веса / Pareto)?
- Тунить по тенанту или глобально?
- Feedback-канал: есть ли продуктовый сигнал, или только LLM-judge?
- Экспортёр во внешний APM — нужен ли?

## Falsification Criteria

- **Детект дрейфа**: искусственная деградация (например, отключение semantic-канала) → QC поднимает alert в течение окна.
- **Auto-rollback**: тюнер применяет плохое значение → регресс бенчмарка (ADR-010) → откат в течение N минут.
- **Multi-objective**: тюнер не ухудшает recall при оптимизации latency (проверяемо бенчмарком).
- **Приватность**: телеметрия не содержит содержимого памятей/запросов (аудит логов).
- **Неблокируемость**: сбор телеметрии не увеличивает p99 retrieval >5%.

## Related ADRs

- **ADR-010 (benchmarking)** — парный ADR: телеметрия = сигнал, бенчмарк = право применить.
- **ADR-004 (summary/full)** — summary вместо содержимого в логах (приватность).
- **ADR-007 (retrieval S0–S3)** — per-layer drop-off, контроль latency SLO.
- **ADR-009 (memory hygiene)** — data-quality аудит (dangling, `embedding_status`).
