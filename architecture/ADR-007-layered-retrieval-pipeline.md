# ADR-007: Многослойный retrieval pipeline — явные этапы recall → rerank → delivery

**Status**: Proposed
**Date**: 2026-09-04
**Deciders**: opencode + dspilarov

## Context

Сейчас retrieval в Margo — две монолитные функции с плоской последовательностью шагов:

1. **`searchMemories`** (`engine/memory/search.ts`, ~800 строк) — поиск памятей. Шаги: кэш → `detectQueryIntent` → `expandMemorySearchQueries` → `embedSingle` → `vectorSearchMemories` → `rerankByScope` → type-aware recall → budget guardrail → early exit → `enrichWithRelations` → `calculateTemporalRelevance` → combine (semantic×0.7 + temporal×0.3) → `rerankByIntent` → `injectSourceChunks`.

2. **`retrieve`** (`engine/retriever.ts`, ~2000 строк) — поиск контекста. Шаги: кэш → `detectQuerySourceIntent` → embedding → oracle scope (`selectOracleCandidateChunkIds`) → `vectorSearch` → `fullTextSearch` → `memorySearch` → `graphSearch` → `reciprocalRankFusion` → `deduplicateResults` → `rerankResults` → `enrichResults` → `packContext` → `compressContext`.

Проблема: слои существуют, но **не изолированы** — перемешаны в одной функции, hard-кодированы в порядке, их нельзя переставить/отключить/протестировать по отдельности. Ранкинг размазан: `searchMemories` использует только intent-boost (без cross-encoder/LLM), а `retrieve.rerankResults` — cross-encoder/LLM/balanced. Латентность управляется ad-hoc guardrail'ами (`POST_VECTOR_BUDGET_MS`, `CHUNK_INJECTION_GUARDRAIL_MS`, `EARLY_EXIT_SIMILARITY`), разбросанными по коду.

### Impact analysis (codegraph)

- **Affected modules**: 2 файла-монолита + 8 зависимостей — `engine/memory/search.ts` (21 callee: `vectorSearchMemories`, `rerankByScope`, `enrichWithRelations`, `rerankByIntent`, `injectSourceChunks`, `detectQueryIntent`, `expandMemorySearchQueries`, `calculateTemporalRelevance`, …), `engine/retriever.ts` (`rerankResults` → `rerankWithCrossEncoder`, `rerankWithLLM`, `rerankWithInferenceService`, `shouldUseLLMFallback`), `embeddings-local.ts`, `inference-client.ts`, `cache.ts`, `memory-normalization.ts`.
- **Call chains**: `dialecticQuery` → `searchMemories`; `POST /v1/memory/search` → `searchMemories`; `POST /v1/context/query` → `retrieve`. Рефакторинг затрагивает оба потребителя.
- **Breaking points**: порядок шагов и формат промежуточных структур (`{memory: {...}, similarity}`, `finalScore`) — при выделении слоёв нельзя менять публичный формат результата.

## Decision

**Разбить retrieval на изолированные слои, каждый — отдельная функция/модуль с собственным бюджетом и флагом отключения (progressive degradation):**

```
L0 LEXICAL (дешёвый, отсекает ~50%)   L1 SEMANTIC (векторный, до порога контекста)
  w2v-подобные лёгкие векторы +         embedSingle
  TF-IDF по наиболее выразительным      vectorSearch (<=>) + scope/type boost
  словам + type-recall                  → топ записей, влезших в token budget
  → пул кандидатов                       (конфиг, напр. 100 000 токенов)

L2 LLM RERANK (точный, от N до M)      L2+ EXPANSION (chunks включаются)
  cross-encoder → LLM-guard             LLM отмечает наиболее релевантные записи
  от min до max записей (конфиг)        → для каждой такой записи подбирается
  → упорядоченный top-K                  топ-N похожих по векторам
                                         (chunks НЕ только исключаются, но и включаются)

L3 DELIVERY (сборка финального контекста)
  graph traversal (связанные записи) + temporal
  injectSourceChunks (родительский контекст)
  packContext (упаковка в token budget) + compressContext
```

Конфиг (`retaindb.config.json` → `retrieval`):
- `contextTokenBudget` — порог контекста для L1 (напр. `100000`) — в память попадают только топ-записи, влезшие в бюджет.
- `llmRerankMinRecords` / `llmRerankMaxRecords` — диапазон записей, который L2 отбирает (от «какое-то число» до «какое-то число»).
- `lexicalCutoffRatio` — доля выборки, отсекаемая на L0 (напр. `0.5`).
- `expansionTopN` — сколько похожих чанков/записей подтягивать на каждую отмеченную LLM-ом запись.

Правила:
- **Каждый слой — чистая функция** с явным входом/выходом (`candidates → candidates`), тестируемая изолированно.
- **Единый бюджет латентности** сверху вниз: если L1 превысил бюджет → пропустить L2 rerank, отдать как есть (как сейчас `degraded_mode_fast`).
- **Ранкинг унифицируется**: `searchMemories` и `retrieve` используют один и тот же L2 (cross-encoder/LLM/balanced), а не дублируют intent-boost отдельно.
- **Включение, а не только исключение**: L2+ расширяет выборку (векторная подборка похожих к отмеченным LLM-ом записям), а не только отфильтровывает.
- Публичный формат результата (`MemorySearchResult`, `RetrievalResult`) не меняется — рефакторинг внутренний.

## Alternatives Considered

### Option A: Оставить монолит, только добавить ещё guardrail'ы
- **Pros**: ноль риска регресса.
- **Cons**: нарастающая сложность; каждый новый шаг (type-recall, intent-boost) ухудшает читаемость; невозможность unit-тестировать слои.
- **Why rejected**: уже упёрлись — type-recall/intent-логика заставила править формат и early-exit в разных местах.

### Option B: Полная замена на готовую библиотеку (LlamaIndex/LangChain retrieval)
- **Pros**: зрелые примитивы.
- **Cons**: тяжёлая зависимость, чужой формат результата, конфликт с local-first и pgvector-слоем (ADR-006).
- **Why rejected**: Margo уже имеет рабочий пайплайн; нужен рефакторинг, не замена.

### Option C: Микросервис-ранкер отдельно от сервера
- **Pros**: изоляция масштабирования.
- **Cons**: лишняя инфраструктура, противоречит self-hosted/local-first.
- **Why rejected**: оверкилл на текущем этапе.

## Consequences

### Positive
- **Тестируемость**: каждый слой — отдельный unit-тест (L0 recall, L1 vector, L2 rerank, L3 pack).
- **Настройка**: порядок/пороги/флаги слоёв через конфиг, а не hard-code.
- **Единый ранкинг**: убирает дублирование intent-boost (search) vs cross-encoder/LLM (retrieve).
- **Progressive degradation**: бюджет сверху вниз — предсказуемая латентность.

### Negative
- **Рефакторинг**: ~2800 строк в двух файлах, риск регресса — митигируется сохранением публичного формата + eval-набором (`scripts/eval-retrieval.py`, `eval-synthesis.py`).
- **Абстракция**: если слоёв слишком много, может появиться косвенность — держать ровно 4, не больше.

### Neutral
- Интерфейс слоёв (`candidates → candidates`) должен быть зафиксирован типом.

## Falsification Criteria

- **recall@10 ≥ 0.90** на расширенном QA-наборе (`qa/qa-set.json`, 21 вопрос) после рефакторинга — без регресса от текущих 0.937.
- **p99 latency `searchMemories` ≤ 200ms** при пуле ≤ 1000 памятей (замер в `scripts/eval-retrieval.py`).
- **слои независимы**: отключение L2 (rerank) не ломает L0/L1 и не падает с ошибкой.

Если после рефакторинга recall@10 падает ниже 0.90 или p99 вырастает выше 200ms — решение пересмотреть.
