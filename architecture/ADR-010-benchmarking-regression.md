# ADR-010: Benchmarking & regression testing

**Status**: Proposed
**Date**: 2026-09-08
**Deciders**: opencode + dspilarov

> Парный ADR: **ADR-011 (Telemetry & quality control)**. Бенчмарк отвечает на вопрос «стало ли хуже», телеметрия — «что происходит сейчас». Тюнер (ADR-011) использует телеметрию как сигнал и бенчмарк как право применить изменение.

## Context

Есть разрозненные eval-скрипты, но нет системы бенчмаркинга:

- `scripts/eval-retrieval.py` — recall@k против `qa/qa-set.json` (21 вопрос), порог 0.8.
- `scripts/eval-synthesis.py` — anchor coverage диалектики, порог 0.8.
- `scripts/seed-dialectic-data.py` — сидит golden-данные, пишет `qa/memory_map.json`.
- `qa/qa-set.json` — golden set (question/answer/reference_slugs/anchors).

Проблемы:
1. **Нет регрессии**: скрипты запускаются вручную, нет gate в CI/nightly.
2. **Один профиль**: только recall@k и anchors; нет precision@k, MRR, NDCG.
3. **Нет latency/cost-бенчмарков** (SLO из ADR-007 не проверяется).
4. **Нет baseline**: не с чем сравнивать (метрики не версионируются).
5. **Synthesis-метрика груба** (anchor substring) — ADR-008 предлагает LLM-judge.
6. **Нет per-layer метрик** (drop-off по S0–S3, ADR-007).

## Decision

**Ввести benchmark suite с версионированным baseline, фиксированной cadence и regression-gate. Бенчмарк — детерминированный, воспроизводимый, отделён от live-телеметрии (ADR-011).**

### 1. Что мерить

| Категория | Метрики |
|---|---|
| Качество (retrieval) | recall@k, precision@k, MRR, NDCG |
| Качество (synthesis) | anchor coverage + LLM-judge (ADR-008) |
| Латентность | p50/p95/p99 по слоям S0–S3 (ADR-007) |
| Стоимость | токены, LLM-вызовы, $ per query |
| Здоровье | index recall (ANN vs brute-force), embedding coverage |

### 2. Golden sets

- `qa/qa-set.json` — retrieval + synthesis (существует).
- `qa/latency-set.json` — фиксированные запросы для latency (разные N пула).
- `qa/cost-set.json` — запросы для замера токенов/$.
- Golden set версионируется вместе с данными сидера; регенерация `memory_map.json` — часть прогона.

### 3. Cadence

- **on-commit** — быстрый subset (retrieval recall@10, smoke).
- **nightly** — полный прогон (все метрики, latency, cost).
- **on-config-change** — при изменении `retaindb.config.json` (обязательно).
- **on-demand** — админ-API.

### 4. Baseline & regression gate

- Baseline — снапшот метрик, версионируется (`qa/baseline-YYYY-MM-DD.json`).
- Gate: изменение хуже порога → fail + alert.
  - recall@10: −2 п.п. (относительно baseline)
  - p99 latency: +10%
  - cost: +15%
  - synthesis: −5 п.п.
- Пороги — в конфиге (`benchmark.gates`), не hard-code.

### 5. Отчётность

- Machine-readable JSON (для тюнера/CI) + human-отчёт (`reviews/BENCH-*.md`).
- Дифф против baseline: какие метрики выросли/упали.

### 6. Конфиг

`retaindb.config.json` → `benchmark`:
- `gates.{recallDeltaPp,latencyDeltaPct,costDeltaPct,synthesisDeltaPp}`.
- `cadence.{onCommit,nightly,onConfigChange}`.
- `sets.{retrieval,synthesis,latency,cost}`.

## Alternatives Considered

### Option A: Ручной прогон eval-скриптов (текущее)
- **Pros**: ноль работы.
- **Cons**: регрессия проходит незамеченной; нет baseline; нет gate.
- **Why rejected**: при рефакторинге ADR-007 регресс неизбежен и должен ловиться автоматически.

### Option B: Внешний eval-фреймворк (RAGAS, DeepEval)
- **Pros**: готовые метрики.
- **Cons**: тяжёлая зависимость; чужой формат; конфликт с self-hosted и своими golden-данными.
- **Why rejected**: свои golden-данные и метрики специфичны; нужен контроль.

### Option C: Только live-телеметрия (без golden set)
- **Pros**: без поддержки датасета.
- **Cons**: нет воспроизводимости, нельзя сравнить версии; шум.
- **Why rejected**: без детерминированного baseline тюнер не имеет «права применить».

## Consequences

### Positive
- **Регрессия ловится автоматически** (gate в CI/nightly).
- **Baseline** позволяет сравнивать версии и изменения конфига.
- **Право на изменение**: тюнер (ADR-011) применяет только то, что прошло gate.

### Negative
- **Поддержка golden set** — данные надо обновлять при изменении профиля памяти.
- **Стоимость полного прогона** (nightly + LLM-judge) — токены/время.
- **Пороги gate** — требуют калибровки.

### Neutral
- ADR-008 (LLM-judge) становится частью benchmark suite.

## Risks / Weaknesses

- **Golden set дрейфует** — если память/схема меняются, старые эталоны устаревают.
- **Переобучение на golden set** — тюнер может подгонять под 21 вопрос; нужен holdout.
- **LLM-judge недетерминирован** — митигается temperature=0 + усреднение (ADR-008).

## Open Questions

- Где хранить baseline — в git или во внешнем store?
- Holdout-набор для защиты от переобучения тюнера?
- Latency-бенчмарк на каком N пула (1k / 10k / 100k)?
- Включать ли cost-бенчмарк в on-commit (дорого) или только nightly?

## Falsification Criteria

- **Gate ловит регресс**: искусственное ухудшение (например, `threshold` вверх) → прогон падает с fail.
- **Baseline воспроизводим**: два прогона на неизменном состоянии дают расхождение ≤ 1 п.п. по recall.
- **Полный прогон укладывается в бюджет**: nightly ≤ N минут.
- **Пороги не ложно-срабатывают**: на 5 последовательных ночных прогонах без изменений — 0 fail.
