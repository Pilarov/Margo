# ADR-006: Векторная схема вне Prisma DSL — кастомный слой pgvector (тип + индексы + хелпер)

**Status**: Proposed
**Date**: 2026-08-31
**Deciders**: opencode + dspilarov

## Context

После перевода Margo на self-hosted OSS-схему (удаление SaaS-миграций: `organizations`, `users`, `billing`, `wizard_events`…) встал вопрос о pgvector-колонках. SaaS-миграция `20260216_change_vector_dimension` делала `ALTER TABLE … ADD COLUMN embedding vector(1024)` + `CREATE INDEX … USING ivfflat (vector_cosine_ops)`. Новая OSS `init` миграция, сгенерированная из `schema.prisma`, воспроизводит только `vector` **без размерности и без ANN-индекса**.

Причина структурная: Prisma не умеет задавать размерность вектора и не умеет создавать ivfflat/hnsw-индексы. В `schema.prisma` колонки объявлены как `Unsupported("vector")` — непрозрачный тип.

Фактические размерности в коде (`engine/embeddings.ts`):
- `openai` → `text-embedding-3-small` с `dimensions: 1024` → **1024**
- `local` → BGE-large → **1024**
- `gemini` → text-embedding-004 → **768** (требует re-index)

Векторный поиск сейчас — разбросанный сырой SQL с оператором `<=>` (cosine distance) в трёх местах: `api/routes.ts:2735`, `engine/retriever.ts:943-1353`, `engine/oracle-select.ts:94`.

### Impact analysis (codegraph)

- **Affected modules**: 11 файлов, ключевые — `engine/embeddings.ts`, `engine/embeddings-local.ts`, `config.ts`, `db/index.ts`, `engine/retriever.ts`, `engine/oracle-select.ts`, `api/routes.ts`, `engine/memory/write.ts`, `engine/memory/search.ts`, `engine/workers/embedding-worker.ts`.
- **Call chains**:
  - Запись: `write.ts:embedMemoryInline` / `workers/embedding-worker.ts:processMemoryJob` → `embedSingle` → `embedWithOpenAI|embedLocal|embedWithInferenceService`.
  - Поиск: `retriever.retrieve` → raw SQL `<=>`; `oracle-search` → `<=>`; `memory/search.searchMemories` → `<=>`.
  - `embedSingle` имеет **16 caller'ов**, `embed` — 3 (`ingest.embedSearchableChunks`, `api/search.embedWithCache`).
- **Breaking points**: любое решение о размерности затрагивает все точки записи/чтения вектора; замена `<=>` на хелпер — рефакторинг в 3 файлах.

## Decision

**Вынести всю pgvector-специфику из Prisma-схемы в отдельный слой**: Prisma владеет структурой таблиц (вектор — непрозрачный `Unsupported("vector")`), а размерность, ANN-индексы и векторный доступ живут в кастомном модуле + идемпотентном провиженинг-SQL.

```
schema.prisma                     db/vector.ts (новый)            prisma/scripts/pgvector.sql
───────────────────────────────── ─────────────────────────────── ────────────────────────────────
embedding Unsupported("vector")   $queryRaw + <=> wrapper         ALTER COLUMN ... TYPE vector(1024)
(структура, без размерности)      валидация размерности           CREATE INDEX ... USING ivfflat/hnsw
                                  единая EMBEDDING_DIM = 1024     (идемпотентно, вне migrate)
```

Конкретно:
1. `config.ts` — константа `EMBEDDING_DIM = 1024` (единый источник, синхронизирован с `embeddings.ts`).
2. `db/vector.ts` — единственный модуль доступа к векторам: обёртка над `$queryRaw` с `<=>`, валидирует длину вектора при записи и поиске, возвращает типизированный результат. Заменяет разбросанный `<=>` SQL из трёх файлов.
3. `prisma/scripts/pgvector.sql` — идемпотентный SQL (`ALTER COLUMN … TYPE vector(1024)` + `CREATE INDEX IF NOT EXISTS … USING ivfflat`), запускается из `scripts/provision-db.sh` до/после `migrate deploy`, **не** через Prisma migrate.

## Alternatives Considered

### Option A: Ничего не менять (текущее состояние)
- **Pros**: Ноль кода, ноль рисков; всё уже работает (e2e 17/17).
- **Cons**: Векторный поиск делает последовательный скан O(N) вместо ANN — деградация на больших объёмах; нет защиты от mismatch размерностей.
- **Why rejected**: Отложить — валидный временный выбор, но не архитектурное решение.

### Option B: Raw SQL миграция внутри Prisma migrate (как SaaS `change_vector_dimension`)
- **Pros**: Минимум кода (~20 строк SQL), размерность + индексы в одной миграции.
- **Cons**: `prisma db push` / `migrate dev` видит `vector` (schema) vs `vector(1024)` (БД) и генерирует drift-шаги, пытаясь «починить» колонку; размерность и логика поиска остаются размазанными по коду.
- **Why rejected**: Дрейф между schema и БД возвращает ручной контроль над миграциями — ровно то, от чего мы уходим.

### Option C: Полная кастомизация типа (нативный скаляр через `Unsupported("vector(1024)")`)
- **Pros**: Размерность прямо в schema.prisma.
- **Cons**: Недокументированное использование `Unsupported` (Prisma ожидает имя типа без параметров) — хрупко, может сломаться на `migrate diff`/`generate`.
- **Why rejected**: Слишком хрупко; размерность — это runtime-концерн провайдера (openai 1024 / gemini 768), а не структура таблицы.

## Consequences

### Positive
- **Нет drift**: Prisma не знает про размерность (`Unsupported` игнорирует параметры) и про ivfflat-индексы (их нет в schema) → `db push`/`migrate dev` больше не пытаются «починить» колонки.
- **ANN-поиск**: ivfflat/hnsw возвращает суб-линейный поиск по мере роста данных.
- **Единая размерность**: `EMBEDDING_DIM` в одном месте; mismatch (gemini 768 vs 1024) ловится валидацией в `db/vector.ts`, а не падением `<=>` в продакшене.
- **Централизация**: один модуль вместо трёх копий `<=>` SQL — проще тестировать и менять метрику (cosine → l2 → inner product).

### Negative
- **Больше кода**: новый модуль + SQL-скрипт + шаг провиженинга.
- **Провиженинг не одной командой**: `migrate deploy` + `pgvector.sql` — нужен обёрточный скрипт, иначе развёртывание «забудет» индексы.
- **Рефакторинг**: заменить `<=>` в `retriever.ts`, `oracle-select.ts`, `routes.ts` на вызовы хелпера.

### Neutral
- **gemini остаётся исключением**: при `EMBEDDING_MODE=gemini` (768) нужен re-index — как и раньше, это уже задокументировано в `embeddings.ts:47`.

## Compliance

- `db/vector.ts` — обязательная валидация `vector.length === EMBEDDING_DIM` перед записью/поиском; тесты на mismatch.
- `prisma/scripts/pgvector.sql` — идемпотентный (`IF NOT EXISTS`), покрыт smoke-тестом в `scripts/provision-db.sh`.
- Никакого `<=>` вне `db/vector.ts` — линт-проверка (grep) или code review.
- ADR обновляется при смене метрики (cosine/l2/ip) или размерности.

## План реализации

1. `config.ts`: `EMBEDDING_DIM = 1024`.
2. `db/vector.ts`: `findSimilar(table, vector, {topK, where})`, `insertVector`, `dimensionCheck`.
3. Мигрировать 3 вызова `<=>` на хелпер (`retriever.ts`, `oracle-select.ts`, `routes.ts`).
4. `prisma/scripts/pgvector.sql` + `scripts/provision-db.sh`.
5. Тесты: dimension mismatch, helper-возвраты, провиженинг-скрипт.
