# ADR-004: Progressive context delivery + async write path

**Status**: Proposed
**Date**: 2026-07-20 (updated 2026-09-08)
**Deciders**: opencode + dspilarov

## Context

Сейчас Margo доставляет контекст агенту плоско: важная preference и шумный лог сборки занимают одинаковые токены, обрезанные до `token_budget`. Агент получает всё сразу или ничего.

Проблемы:
1. **Плоский — нет приоритизации**: важная preference и шумный лог сборки занимают одинаковые токены.
2. **Нет progressive disclosure**: агент не может запросить «только кратко» или «полностью по вот этой записи».
3. **Sync write path**: в server-режиме запись ждёт extraction+embedding+relations (latency до нескольких секунд).

Honcho решает (3) через async write (запись мгновенная → reasoning в очереди).

## Decision

### Two-level memory content (вместо трёх уровней)

Каждая запись имеет **2 уровня**:

| Уровень | Что это | Объём | Когда формируется |
|---|---|---|---|
| **summary** | короткое описание записи | ~1-2 предложения | автоматически при записи |
| **full** | основной текст записи | как есть | при записи (сам контент) |

**Phase 1 (сейчас) — только формирование.** Когда от агента прилетает запись, Margo сам формирует для неё `summary` из контента. Оба уровня сохраняются вместе с записью.

**Phase 2 (потом) — доставка.** Агент сможет запросить `summary` (дёшево, обзор) или `full` (детали по запросу) через параметр контекста. Доставка в этом ADR **не реализуется** — только заготовка данных.

### Summary generation — отдельная функция + LLM-задача

- **Новая функция** `generateMemorySummary()` в `engine/memory/summarize.ts`: вход `{ content, memoryType }`, выход — короткое описание (string). Вызывается в write path (`writeMemoryCanonical`) после persist; результат пишется в поле `summary` записи.
- **Новая LLM-задача в конфиге**: `summarization` — отдельный `{ model, apiKey, baseUrl }` в `config.ts` (`llmCfg.summarization`), fallback env → json → default как у остальных. Default model `gpt-4o-mini`, env-суффикс `LLM_SUMMARIZATION_*`. Это **19-я** LLM-задача.
- **Хранение**: новое nullable поле `summary` в модели `Memory` (Prisma `schema.prisma`) + миграция.

### Phase 1.5 — summary как ускоритель поиска

`summary` используется не только для доставки, но и как **дешёвое представление записи** в retrieval (ADR-007):

| Где | Использование |
|---|---|
| S1 fast-канал | эмбеддинг summary быстрым эмбеддером (короткий текст → быстрее) |
| S1 lexical | BM25 по summary (короче индекс; LLM выделяет выразительные слова) |
| S2 rerank | summary как сниппет для cross-encoder/LLM (вместо `content.slice(0,1024)`) |
| S3 delivery | summary для дешёвого контекста, `full` только для top-K |
| Dedup / hygiene (ADR-009) | предфильтр по summary перед точным сравнением |
| Telemetry (ADR-011) | логирование summary вместо содержимого (приватность) |

Ограничения: summary **не заменяет** full-эмбеддинг в semantic (теряет точные термины вроде `grpc`/`pnpm`); при обновлении записи summary пересчитывается (аналог `embedding_status`).

### Async write path (server only) — без изменений

Async-запись уже частично реализована (`POST /v1/memory` → `ingestionQueue`, `GET /v1/memory/jobs/:jobId`). Остаётся как есть, в этом ADR не трогается.

```
WRITE_MODE=sync           # Текущее поведение, local default
WRITE_MODE=async          # Server only, требует Redis/очередь
```

## Alternatives Considered

### Option A: Три уровня (L0 abstract / L1 overview / L2 full)
- **Pros**: тоньше градация доставки.
- **Cons**: дороже — два производных текста на запись (abstract + overview); L1/L2 различие редко востребовано агентом.
- **Why rejected**: 2 уровня (summary + full) покрывают 95% сценариев при меньшей стоимости и сложности.

### Option B: Summary без LLM (первые N слов контента)
- **Pros**: бесплатно, детерминированно.
- **Cons**: «первые N слов» — плохое описание для длинных/структурных записей; не отражает суть.
- **Why rejected**: качество summary критично для Phase 2 (агент будет принимать решение по summary); нужен LLM.

### Option C: Только progressive disclosure (без async write)
- **Pros**: меньше scope.
- **Cons**: основной источник latency (extraction/embedding) не решён.
- **Why rejected**: progressive без async — косметика; обе части ортогональны.

## Consequences

### Positive
- **Готовность к progressive disclosure**: summary формируется уже сейчас, доставка — потом без миграции данных.
- **Дешёвый обзор**: Phase 2 даст 10–50× экономию токенов на обзоре контекста.
- **Latency записи** (async): sync 2–5 сек → async <100ms.

### Negative
- **+1 LLM-вызов на запись** (summary) — рост стоимости/латентности записи в Phase 1.
- **Схема**: новое поле `summary` → миграция.
- **Сложность**: +2 режима (CONTEXT_MODE, WRITE_MODE) на Phase 2.

### Neutral
- **Конфиг**: +1 env-группа (`LLM_SUMMARIZATION_*`), +1 поле `llmCfg.summarization`.
- **API**: Phase 2 добавит параметр уровня в контекст-эндпоинт (сейчас не меняется).

## Compliance

- Тест: `generateMemorySummary` возвращает ≤ ~80 токенов по каждому типу записи.
- Тест: summary пишется в поле `summary` при `writeMemoryCanonical` (outcome `created`).
- Тест: `llmCfg.summarization` резолвится по fallback-цепочке (env → json → default), как остальные задачи (llm-wiring).
- Тест: `WRITE_MODE=sync` — поведение записи не меняется (регрессия).

## Related ADRs

- **ADR-001 (memory lifecycle v2)** — общий контекст стадии DELIVERY.
- **ADR-007 (retrieval S0–S3)** — summary как сниппет в S1/S2, дешёвый контекст в S3.
- **ADR-009 (memory hygiene)** — summary как предфильтр dedup.
- **ADR-011 (telemetry & QC)** — summary вместо содержимого в логах (приватность).
- **ADR-005 (knowledge→skill, Rejected)** — упоминал L0 peer-card с top skills; не реализуется.
