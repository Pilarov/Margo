# Research Spike — 2026-09-04: данные памяти для проверки семантической селекции в диалектике

## Goal

Перед добавлением семантической (векторной) селекции памятей в `dialecticQuery` нужен реалистичный набор памятей, чтобы доказать, что `<=>`-поиск релевантности лучше текущей селекции `importance + recency`. Найти готовый датасет ИЛИ синтезировать данные нужной структуры, и выгрузить их в Margo.

## Codebase Findings

- Структура памяти Margo: `Memory` (`packages/server/prisma/schema.prisma`) — `content`, `memoryType` (13 типов: factual/preference/goal/decision/event/instruction/relationship/…), `importance` (0-1), `confidence`, `entityMentions`, `scope` (USER/SESSION/PROJECT/AGENT), `embedding` (vector).
- Запись через API: `POST /v1/memory` (`write_mode: sync`, `memory_type`, `importance`, `user_id`, `content`).
- Диалектика сегодня (`engine/memory/dialectic.ts`): `loadUserModelMemories` берёт top-200 по `importance desc, updatedAt desc`, затем `buildMemoryBlock` обрезает top-N. Селекция — **importance+recency, без релевантности query**.
- Для демонстрации проблемы нужны данные, где важные памяти (high importance) тематически НЕ совпадают с query, а релевантные — low importance.

## Sources (web)

- **PerLTQA** (arxiv 2402.16288) — Personal Long-Term Memory Dataset: 141 профилей, 1339 semantic relationships, 4501 events, 3409 dialogues, 8593 QA. Категории близки Margo (profiles, facts, relationships, events). Самый подходящий по структуре, но скачивание + трансформация затратны, лицензия/доступ неочевидны.
- **LoCoMo** (Long Context Memory) — human-human диалоги, менее task-oriented.
- **LongMemEval** (2410.10813) — QA-бенчмарк чат-ассистентов, история до нескольких тыс. токенов.
- **Memora** (2604.20006) — long-term memory бенчмарк (remembering/reasoning/recommending), недели-месяцы.
- **ATM-Bench** (2603.01990) — multimodal multi-source, избыточно для нашей задачи.

## Findings

- Готового, сразу совместимого с Margo датасета нет — все требуют скачивания, парсинга и маппинга схемы. Оверкилл для проверки одной функции.
- Для валидации семантической селекции достаточно **контролируемого синтетического набора**: ~50 памятей одного пользователя, разнесённых по темам, где `importance` намеренно НЕ коррелирует с релевантностью к тестовым query.

## Alternatives

### Option A: Выгрузить PerLTQA
- **Pros**: реальные данные, внешняя валидность.
- **Cons**: скачивание, парсинг, трансформация схемы, лицензионные риски. Большой footprint.
- **Why rejected**: для проверки одной функции — избыточно.

### Option B: Синтезировать контролируемый набор (рекомендовано)
- **Pros**: мгновенно, полный контроль над importance/relevance, воспроизводимо (seed-скрипт в репо), нет лицензионных рисков.
- **Cons**: не «живые» данные, возможен bias.
- **Why chosen**: даёт чёткий A/B (importance+recency vs semantic) на одинаковых данных.

### Option C: Гибрид (PerLTQA + синтез)
- **Pros**: лучшая валидность.
- **Cons**: максимальный footprint, задержка.
- **Why rejected**: оверкилл на текущем этапе.

## Recommendation

- **Chosen approach**: Option B — синтезировать ~50 памятей одного пользователя (`dialectic-test-user`) с двумя тематическими кластерами (работа/инфраструктура = high importance; предпочтения/стиль = low importance), выгрузить в Margo через `POST /v1/memory`.
- **Rationale**: контролируемый контраст «важно vs релевантно» — единственное, что нужно для A/B семантической селекции; воспроизводимо seed-скриптом.
- **Rejected**: PerLTQA (footprint), гибрид (оверкилл).
- **Risks**: синтетика может быть «слишком чистой» для реального шума — митигируется добавлением частично перекрывающихся формулировок и разброса importance.
