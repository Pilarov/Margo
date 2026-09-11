# ADR-009: Memory Hygiene — селекция записей и санитарные процессы

**Status**: Proposed
**Date**: 2026-09-08
**Deciders**: opencode + dspilarov

## Context

В Margo есть набор процессов обслуживания памяти, но они **разрознены**: разные триггеры, нет общей модели состояний, нет observability, нет re-embed/re-index и чистки связей.

Инвентаризация:

| Процесс | Где | Триггер |
|---|---|---|
| Exact/near dedup | `write.ts` | на write |
| Relation detection (LLM) | `relations.ts:93` | на write |
| Invalidation (`updates`/`contradicts`) | `write.ts` | на write |
| Consolidation (vector ≥0.95 + merge) | `consolidation.ts:225` | scheduled |
| Dreamer (inductive + peer-card) | `dreamer.ts:224` | scheduled |
| Importance decay/archive | `importance-decay.ts` | scheduled/on-demand |
| Session promotion SESSION→USER | `session-lifecycle.ts` | scheduled |
| Expiry (`expiresAt`) | `write.ts` | на read (фильтр) |
| Admin-эндпоинты | `optimization.ts` | on-demand |

Проблемы:
1. **Нет re-embed/re-index** — при смене модели эмбеддера или росте N (KNN→HNSW→IVFFlat, ADR-007) система деградирует молча.
2. **Нет чистки dangling-связей** — supersession/delete оставляет висящие `MemoryRelation`.
3. **Нет разрешения противоречий** — `contradicts` детектится, но не разрешается процессом.
4. **Жёсткие пороги** decay (14d, 0.45) — не адаптивны к профилю памяти.
5. **Нет observability** — не видно, работает ли consolidation, что он удалил, сколько слил.
6. **`consolidation.calculateSimilarity`** не используется; `scheduledConsolidation` — неясно кем и когда вызывается.
7. **Нет `embedding_status`** — при двухвекторной схеме (ADR-007) нужен явный статус готовности.

## Decision

**Выделить Memory Hygiene как отдельный слой: явная модель состояний записи + политика селекции (сигналы → решения) + реестр процессов, разложенных по триггерам. Процессы идемпотентны, неблокирующи, транзакционны, обратимы (archive вместо delete) и наблюдаемы.**

### 1. Модель состояний записи

```
candidate → active → decayed → archived → deleted
              ↑         │
              │         └─ restored (из архива)
              ├─ promoted   (SESSION → USER)
              ├─ merged     (в canonical-запись)
              └─ superseded (заменена новой версией)
```

- `candidate` — записана, но не готова (нет обоих векторов/связей).
- `active` — видна в retrieval.
- `decayed` — importance ниже порога; видна, но с пониженным весом.
- `archived` — невидима в retrieval, но сохраняется для графа/аудита.
- `deleted` — необратимо (только по retention/privacy).
- `merged`/`superseded` — терминальные указатели на canonical.

Правило: **по умолчанию архив, не удаление**. Удаление — только по `expiresAt` (retention) или явному запросу.

### 2. Сигналы селекции

| Сигнал | Роль |
|---|---|
| `importance` (+decay) | базовый вес |
| `confidence` | надёжность |
| `accessCount` / `recallCount` | востребованность (reinforcement) |
| `lastAccessedAt` | свежесть использования |
| `scope` | SESSION эфемерен, USER долговечен |
| `relations` | `superseded` → архив |
| `grounding` (`sourceChunkId`) | подтверждённость источником |
| `validatorIssues` | мусор → GC |
| `entityMentions` | связность с графом |

Решения: **keep / promote / merge / archive / delete**. Политика — функция от сигналов; пороги в конфиге, не hard-code.

### 3. Классы процессов (по триггеру)

| Класс | Триггер | Процессы | Бюджет |
|---|---|---|---|
| **Inline** | на write, синхронно | валидация, exact dedup, scope, versioning | <100ms |
| **Near-write** | async после write | embedding (fast+slow), relation detection, `embedding_status` | секунды |
| **Periodic** | scheduled | consolidation, decay, promotion, Dreamer | минуты |
| **Threshold** | по метрике | re-index ANN, re-embed (смена модели), conflict sweep | по триггеру |
| **Reactive** | на delete/supersede | чистка dangling-связей, пересчёт Dreamer peer-card | <1s |

### 4. Реестр процессов

| Процесс | Класс | Вход | Выход | Идемпотентен |
|---|---|---|---|---|
| `dedupExact` | inline | новая запись | created/duplicate | да |
| `embedBoth` | near-write | запись | `embedding_status=ready` | да |
| `detectRelations` | near-write | запись + кандидаты | `MemoryRelation[]` | да (upsert) |
| `consolidate` | periodic | кластеры ≥0.95 | merged canonical | да |
| `decay` | periodic | активные записи | importance↓, archive | да |
| `promote` | periodic | SESSION-записи | USER-записи | да |
| `dreamer` | periodic | USER-записи | derived memories | да (dedup по content) |
| `reindex` | threshold | N изменился | ANN-индекс пересобран | да |
| `reembed` | threshold | модель сменилась | вектора пересчитаны | да |
| `conflictSweep` | threshold | накопленные `contradicts` | resolved/помечено | да |
| `cleanupRelations` | reactive | delete/supersede | dangling-связи удалены | да |

### 5. Сквозные принципы

1. **Идемпотентность** — повторный прогон не меняет результат (безопасен для retry).
2. **Неблокируемость** — санитария в отдельных воркерах, не держит write/read path; уступает им по ресурсам.
3. **Транзакционность** — merge/supersede + чистка связей в одной транзакции (иначе dangling).
4. **Обратимость** — archive вместо delete; журнал операций (аудит) для отката.
5. **Наблюдаемость** — метрики per-process: сколько слито/архивировано/удалено, ошибки, latency.
6. **Приоритеты** — санитария не голодает write/read.

### 6. Observability

- Per-process метрики: `hygiene.{process}.{scanned,changed,errors,ms}`.
- Admin-API: `GET /v1/admin/hygiene/status`, `POST /v1/admin/hygiene/run/:process`.
- Аудит операций (что изменено, когда, чем триггернуто).

### 7. Конфиг

`retaindb.config.json` → `hygiene`:
- `state.importanceDecayThreshold`, `state.archiveAfterDays`, `state.deleteOnlyOnExpiry` (bool).
- `periodic.{consolidate,decay,promote,dreamer}.{enabled,intervalMs}`.
- `threshold.{reindexMaxRecords,reembedOnModelChange,conflictSweepMinConflicts}`.
- `archive.enabled` (default `true`).

## Alternatives Considered

### Option A: Оставить разрозненные процессы как есть
- **Pros**: ноль работы.
- **Cons**: нет re-index/re-embed/conflict/cleanup; нет observability; жёсткие пороги.
- **Why rejected**: при росте пула и смене моделей система деградирует молча.

### Option B: Всё в один «большой scheduled job»
- **Pros**: одна точка входа.
- **Cons**: нельзя запускать выборочно, отладить или бюджетировать; один сбой роняет всё.
- **Why rejected**: классы процессов имеют разные триггеры и бюджеты.

### Option C: Удалять вместо архивации
- **Pros**: чище БД.
- **Cons**: необратимо, ломает граф и аудит, нет отката.
- **Why rejected**: архив дешевле и безопаснее; delete — только retention/privacy.

## Consequences

### Positive
- **Управляемость**: явная модель состояний и политика селекции вместо неявных флагов.
- **Масштабируемость**: re-index/re-embed привязаны к порогам (ADR-007 ANN-стратегия).
- **Надёжность**: чистка dangling-связей, разрешение конфликтов.
- **Отладка**: per-process метрики и админ-API.

### Negative
- **Сложность**: +слой процессов, +конфиг, +метрики.
- **Консистентность**: асинхронная санитария требует транзакций и `embedding_status`.
- **Риск**: агрессивная политика может архивировать нужное — митигируется консервативными дефолтами + observability.

### Neutral
- Модель состояний добавляет поля (`state`, `embedding_status`) → миграция.
- `scheduledConsolidation` переезжает в общий планировщик.

## Risks / Weaknesses

- **Пороги селекции**: жёсткие значения могут не подойти всем профилям — нужны адаптивные дефолты и наблюдение.
- **Гонки**: санитария и write конкурируют — нужны транзакции/блокировки.
- **Re-embed дорог**: при смене модели — массовый пересчёт; нужен батчинг и фоновый режим.
- **Observability без тестов** — добавить тесты на идемпотентность процессов.

## Open Questions

- Где хранить `state`/`embedding_status` — колонки в `Memory` или отдельная таблица?
- Единый планировщик (`scheduler.ts`) или отдельный для hygiene?
- Retention по умолчанию: сколько держать `decayed`/`archived`?
- Conflict sweep: авто-разрешение или только пометка для ревью?
- Re-embed: in-place или версионирование векторов?

## Falsification Criteria

- **Идемпотентность**: повторный прогон любого periodic/threshold-процесса не меняет состояние БД (проверяемо тестом на снимках).
- **Нет dangling**: после delete/supersede не остаётся `MemoryRelation` на неактивную/удалённую запись.
- **Recall не падает**: `recall@10 ≥ 0.90` на QA-наборе после прогона hygiene (архивация не съедает релевантное).
- **Наблюдаемость**: каждый процесс эмитит `{scanned,changed,errors,ms}` в `/v1/admin/hygiene/status`.
- **Неблокируемость**: p99 `searchMemories`/`retrieve` не растёт >10% при параллельном прогоне hygiene.
