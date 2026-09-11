# ADR-007: Retrieval pipeline — scope → recall → rerank → delivery

**Status**: Proposed
**Date**: 2026-09-04 (updated 2026-09-08)
**Deciders**: opencode + dspilarov

## Context

Сейчас retrieval в Margo — две монолитные функции с плоской последовательностью шагов:

1. **`searchMemories`** (`engine/memory/search.ts`, ~800 строк) — поиск памятей. Шаги: кэш → `detectQueryIntent` → `expandMemorySearchQueries` → `embedSingle` → `vectorSearchMemories` → `rerankByScope` → type-aware recall → budget guardrail → early exit → `enrichWithRelations` → `calculateTemporalRelevance` → combine (semantic×0.7 + temporal×0.3) → `rerankByIntent` → `injectSourceChunks`.

2. **`retrieve`** (`engine/retriever.ts`, ~2000 строк) — поиск контекста. Шаги: кэш → `detectQuerySourceIntent` → embedding → oracle scope (`selectOracleCandidateChunkIds`) → `vectorSearch` → `fullTextSearch` → `memorySearch` → `graphSearch` → `reciprocalRankFusion` → `deduplicateResults` → `rerankResults` → `enrichResults` → `packContext` → `compressContext`.

Проблема: слои существуют, но **не изолированы** — перемешаны в одной функции, hard-кодированы в порядке, их нельзя переставить/отключить/протестировать по отдельности. Ранкинг размазан: `searchMemories` использует только intent-boost (без cross-encoder/LLM), а `retrieve.rerankResults` — cross-encoder/LLM/balanced. Латентность управляется ad-hoc guardrail'ами (`POST_VECTOR_BUDGET_MS`, `CHUNK_INJECTION_GUARDRAIL_MS`, `EARLY_EXIT_SIMILARITY`), разбросанными по коду.

Отдельная проблема целостности: обязательные по типу/времени/скоупу записи (instruction/goal/preference, `validUntil`/`supersededBy`) сейчас зависят от семантического ранжирования и теряются, когда семантически далеки от запроса (кейсы `q-backend`, `q-package-manager`).

### Impact analysis (codegraph)

- **Affected modules**: 2 файла-монолита + 8 зависимостей — `engine/memory/search.ts` (21 callee: `vectorSearchMemories`, `rerankByScope`, `enrichWithRelations`, `rerankByIntent`, `injectSourceChunks`, `detectQueryIntent`, `expandMemorySearchQueries`, `calculateTemporalRelevance`, …), `engine/retriever.ts` (`rerankResults` → `rerankWithCrossEncoder`, `rerankWithLLM`, `rerankWithInferenceService`, `shouldUseLLMFallback`), `embeddings-local.ts`, `inference-client.ts`, `cache.ts`, `memory-normalization.ts`.
- **Call chains**: `dialecticQuery` → `searchMemories`; `POST /v1/memory/search` → `searchMemories`; `POST /v1/context/query` → `retrieve`. Рефакторинг затрагивает оба потребителя.
- **Breaking points**: порядок шагов и формат промежуточных структур (`{memory: {...}, similarity}`, `finalScore`) — при выделении слоёв нельзя менять публичный формат результата.

## Decision

**Конвейер из 4 стадий: детерминированный scope-фильтр → гибридный recall (4 канала + фузия) → реранкинг (cross-encoder → LLM) → доставка. Два профиля: precision (search) и recall (dialectic). Каждая стадия — чистая функция `Candidate[] → Candidate[]`.**

```
S0 SCOPE FILTER (детерминированный, всегда первый)
  org · project · user · session · agent · task · scope
  validity: validUntil / supersededBy (по версионным связям updates/contradicts)
  → изолированный, актуальный пул; cutoff-статистика считается только по нему

S1 RECALL (гибрид; каналы независимы, затем RRF-фузия)
  ├─ type-recall bypass  — обязательные типы (instruction/goal/preference/decision/…)
  │                        НЕ проходят семантический отсев
  ├─ lexical (BM25/FTS)  — точные термины (grpc, pnpm, имена)
  ├─ semantic (embed + ANN) — смысл; KNN/HNSW/IVFFlat
  ├─ graph — ассоциативные связи (extends/derives/supports):
  │          seed = топ семантики; depth ≤ 2, degree ≤ k, confidence ≥ 0.7
  └─ [опц.] fast (model2vec) — только при N > threshold, только мусор,
                               НЕ трогает type-recall
  → RRF-фузия → пул кандидатов (fused score)

S2 RERANK
  cross-encoder (честный score 0..1, локально) →
  [опц.] LLM (structured: relevance + reason) — только если cross-encoder неуверен
         (top < 0.85 или gap(top-2) < 0.1) и бюджет есть
  → топ с честным score

S3 DELIVERY
  graph traversal + temporal + injectSourceChunks + expansion (включение)
  → packContext (token budget) + compressContext
  → контекст / диалектика
```

**Версионные связи** (`updates`/`contradicts`) — только S0 (актуальность), **не** recall.
**Ассоциативные связи** (`extends`/`derives`/`supports`) — S1 graph-канал.

Конфиг (`retaindb.config.json` → `retrieval`):
- `profile` — `precision` (search) | `recall` (dialectic); влияет на пороги и ширину пула.
- `scope` — обязательный предикат (не отключается): `org/project/user/session/agent/task/scope` + `validity`.
- `recall.typeRecall.enabled` — bypass обязательных типов.
- `recall.lexical.enabled` — BM25/FTS-канал.
- `recall.semantic.enabled` + `ann{metric,strategy(auto|knn|hnsw|ivfflat),autoThresholds,hnsw{m,efConstruction,efSearch},ivfflat{lists,probes},filterMode}`.
- `recall.graph{enabled,depth,maxDegree,minConfidence,weight}` — граф-канал.
- `recall.fast{enabled,threshold,embedder{model,dim,apiKey,baseUrl}}` — опциональный fast-канал (model2vec).
- `recall.fusion.weights` — веса каналов в RRF.
- `rerank.crossEncoder{enabled,weight,topN}` — S2a.
- `rerank.llm{minRecords,maxRecords,batchSize,returnReason,budgetMs}` — S2b.
- `delivery.contextTokenBudget`, `delivery.expansionTopN` — S3.

Правила:
- **S0 детерминирован и обязателен**: фильтр стоит до семантики; изоляция и актуальность не зависят от косинуса.
- **Обязательные типы bypass семантику**: type-recall не отсекается L0/semantic/graph.
- **Разделение типов связей**: версионные → S0; ассоциативные → S1 graph.
- **Каналы S1 независимы**: падение одного (semantic/lexical/graph/fast) не ломает остальные; фузия — по доступным.
- **Граф — низкий вес + жёсткие лимиты** (`depth`, `maxDegree`, `minConfidence`); иначе шум и latency.
- **SLO разнесён**: S0+S1 ≤ 150ms, S2 ≤ 100ms, S3 ≤ 50ms, S2-LLM ≤ 1.5s (опционален, вне критического пути).
- **Per-layer tracing обязателен**: `LayerTrace{in,out,dropped,ms,cutoff}` — иначе eval/дебаг невозможны.
- Публичный формат результата (`MemorySearchResult`, `RetrievalResult`) не меняется — рефакторинг внутренний.

## Implementation Impact

### New modules

```
engine/retrieval/
  types.ts        Candidate, LayerTrace, RetrievalMode (precision|recall)
  pipeline.ts     оркестратор S0→S3 (заменяет тела монолитов)
  scope-filter.ts S0
  recall/{type-recall,lexical,semantic,graph,fast,fusion}.ts
  rerank/{cross-encoder,llm}.ts
  delivery/{graph,temporal,chunks,pack}.ts
  trace.ts
engine/embeddings-fast.ts   отдельный модуль (model2vec), свои синглтоны
```
`embeddings-fast.ts` обязателен отдельным: `initEmbedder` (`embeddings-local.ts:52`) жёстко зашит на `Xenova/bge-large-en-v1.5`, а `embed()` (`embeddings.ts:100`) используется на write-пути — не трогать.

### Existing code to change

| Файл | Изменение | Риск |
|---|---|---|
| `engine/memory/search.ts` | `searchMemories` → адаптер над `pipeline` (mode=precision); `enrichWithRelations:647` → `graphRecall()` (depth/degree/confidence/type); `injectSourceChunks:776` — shape сохранить | HIGH |
| `engine/retriever.ts` | `retrieve` → адаптер; `rerankResults:1486`/`rerankWithLLM:1568` → `rerank/*`; `vectorSearch:919`/`fullTextSearch:1064`/`memorySearch:1259`/`graphSearch:1342` → `recall/*` | HIGH |
| `engine/memory/dialectic.ts:98` | вызов `searchMemories` → `pipeline` (mode=recall); `:111` `importance: r.similarity` | HIGH |
| `db/vector.ts` | добавить metric-awareness (сейчас без оператора) | MED |
| `engine/cache.ts:469` | semantic cache без namespace/model | MED |
| `engine/memory/relations.ts:93` | `detectRelations` field names (`toMemoryId`/`relationType`) завязаны на `write.ts:953` | MED |
| `api/memory.ts:321` | `keywordSearchMemories` — третий lexical, объединить с S1 | MED |
| `api/routes.ts:997` | Zod enum `retrieval_profile` только `legacy|precision_v1` | MED |

### Config (`config.ts`)

- `jRetrieval` рядом с `jEmbed`/`jRerank`/`jLlm` (`config.ts:30-33`).
- `RetrievalConfig` + `retrieval` — после rerank (`config.ts:107`), до LLM (`config.ts:109`), env>json>default.
- `profile` — whitelist-паттерн из `extractionMode` (`config.ts:195-200`).
- Второй эмбеддер: `retrieval.recall.fast.embedder.dim` — **не** в глобальный `EMBEDDING_DIM` (`config.ts:223`).
- Новый LLM-task `rerankStructured` в `LLMConfig`/`llm` (`config.ts:121-182`).

### Schema / DB

- `prisma/scripts/pgvector.sql:16-23` — `ivfflat lists=100` жёстко; HNSW + параметры.
- Второй вектор: `Memory.embedding` (`schema.prisma:226`), `Chunk.embedding:175` → `embedding_fast Unsupported("vector")?` + `ALTER`/индекс.
- `halfvec`/`bit` → смена типа колонки + новые opclass.
- **29 сайтов `<=>`** (`search.ts:630`, `retriever.ts:945-1357`, `routes.ts:2739/3194`, `oracle-select.ts:95`) — при смене metric менять все.
- `filterMode` → `SET LOCAL hnsw.ef_search` / `hnsw.iterative_scan`.
- ADR-006:71: новые векторные колонки держать `Unsupported(...)`, вне Prisma-миграций.

### API / tests / eval / clients

- API (shape сохранить): `POST /v1/context/query` (`routes.ts:1010`), `POST /v1/memory/search` (`memory.ts:675`), `/v1/memory/dialectic` (`memory.ts:2639`), `/profile/:userId/ask` (`memory.ts:2675`), research `search_documents` (`research-agent.ts:279,292`).
- Ломающиеся тесты: `retriever.test.ts:27-53` (RRF/dedupe экспортированы, literal `"hybrid"`); `dialectic.integration.test.ts:104-120` (контракт `similarity`); `search.test.ts:4` (хрупкий `vi.mock`); `write-helpers.test.ts:348-470` (**словарь scope-target**); `llm-wiring.test.ts:29-30` (пинит `llmCfg.rerank` в `retriever.ts`); `hermes-contract.test.ts` (source-inspection, окно 2000 симв.).
- Eval: `eval-retrieval.py:44` читает `results[].memory.id`, **не шлёт `scope_targets`** → S0 должен по умолчанию включать USER; `eval-synthesis.py:30`; `seed-dialectic-data.py` → `qa/memory_map.json` (gitignored, регенерить); дефолтные юзеры не совпадают → `RETAINDB_USER`.
- Клиенты: SDK `QueryResult` (`index.ts:51-92`), `MemorySearchResponse` (`:311-354`), `agent-runtime.ts:1066` (клиентские floor'ы); MCP `search-payload.mjs:16-44`; **`packages/local` — параллельная реализация retrieval** (`cli.ts:813`), паритет S0–S3 портировать отдельно.

### Critical invariants (нельзя ломать)

1. `MemorySearchResult.similarity` — публичное поле **и** `importance` диалектики (`dialectic.ts:111`).
2. `RetrievalResult.score` — единственное экспонируемое поле ранга + `source` union (`vector|bm25|hybrid|memory|graph`).
3. `metadata`-ключи: `parent_chunk_id`, `section_path`, `heading_path`, `parent_content`/`parent_excerpt` (precedence `packContext:1644`), `source_id`, `source_family`.
4. `detectRelations` field names (`toMemoryId`/`relationType`) для `write.ts`.
5. Кэш-сериализация (simple+semantic в `search.ts`, context в `retriever.ts`).
6. Экспортированные тестируемые хелперы: `uniqueStrings`, `estimateTokens`, `deduplicateResults`, `reciprocalRankFusion`, `detectQueryIntent`.
7. Cache key `search:...` (`search.ts:272`) не включает `memoryTypes/namespace/tags` → scope-фильтр **обязан** попасть в ключ.

### Duplication to remove (попутно)

1. `searchMemories` (`search.ts:236`) vs `memorySearch` (`retriever.ts:1259`).
2. `keywordSearchMemories` (`memory.ts:321`) — третий lexical.
3. Legacy `/v1/memories/search` (`routes.ts:2695`) — своя embedding-логика.
4. Entity-vector SQL: `graphSearch` (`retriever.ts:1351`) vs `routes.ts:3191`.
5. `estimateTokens` ×4 (`retriever.ts:1675`, `compressor.ts:331`, `dreamer.ts:172`, `local/cli.ts:130`).
6. `MemorySearchResult` конструируется дважды (`search.ts:491` vs `:825`).

### Risk priority

| # | Риск | Митигация |
|---|---|---|
| 1 | `similarity` как importance в диалектике | сохранить `similarity` в S1-выходе |
| 2 | `score`-нормализация в реранке (`retriever.ts:1502-1556`) | единый S2-контракт `→ score` |
| 3 | `metadata`-ключи (нет тестов) | заморозить + тест |
| 4 | fast-вектора в semantic cache | namespace/model в ключ |
| 5 | scope не в cache key `search.ts:272` | добавить scope |
| 6 | `vi.mock`-списки `search.test.ts:4` | расширить моки |
| 7 | `retrieval_profile` enum `routes.ts:997` | добавить значения |
| 8 | source-inspection окно 2000 симв. | не вставлять код перед route |

## Alternatives Considered

### Option A: Оставить монолит, только добавить ещё guardrail'ы
- **Pros**: ноль риска регресса.
- **Cons**: нарастающая сложность; невозможность unit-тестировать слои.
- **Why rejected**: уже упёрлись — type-recall/intent-логика заставила править формат и early-exit в разных местах.

### Option B: Полная замена на готовую библиотеку (LlamaIndex/LangChain retrieval)
- **Pros**: зрелые примитивы.
- **Cons**: тяжёлая зависимость, чужой формат результата, конфликт с local-first и pgvector-слоем (ADR-006).
- **Why rejected**: Margo уже имеет рабочий пайплайн; нужен рефакторинг, не замена.

### Option C: Каскад из 5 векторных слоёв (fast → slow → cross-encoder → LLM → delivery)
- **Pros**: дешёвый отсев мусора на входе.
- **Cons**: семантический каскад теряет type/lexical-релевантное (обязательные типы далеки от запроса по косинусу); два обязательных эмбеддера — двойной проход на write; fast-слой не даёт скорости на малых пулах (тысячи памятей).
- **Why rejected**: для профиля Margo (памяти — тысячи) проигрывает гибридному recall с type-bypass; граф и lexical решают semantic-gap точнее.

### Option D: Микросервис-ранкер отдельно от сервера
- **Pros**: изоляция масштабирования.
- **Cons**: лишняя инфраструктура, противоречит self-hosted/local-first.
- **Why rejected**: оверкилл на текущем этапе.

## Consequences

### Positive
- **Целостность**: обязательные типы, актуальность (`validUntil`/`supersededBy`) и scope-изоляция защищены от семантического отсева (S0 + type-recall).
- **Semantic gap**: graph-канал подтягивает записи, далёкие по косинусу, но связанные (кейсы `q-backend`, `q-package-manager`).
- **Тестируемость**: каждая стадия/канал — отдельный unit-тест.
- **Два профиля**: precision (search) и recall (dialectic) — разные цели без компромисса.
- **Progressive degradation**: каналы S1 независимы; дорогой LLM опционален.

### Negative
- **Рефакторинг**: ~2800 строк в двух файлах, риск регресса — митигируется сохранением публичного формата + eval-набором.
- **Граф**: риск шума (ложные LLM-связи) и latency — митигируется `minConfidence` и лимитами обхода.
- **Dangling-связи**: при supersession/delete связи надо чистить каскадом.

### Neutral
- Интерфейс `Candidate`/`LayerTrace` фиксируется типом.
- Delivery-уровни (summary/full из ADR-004) — отдельная ось от retrieval S0–S3; имена L0/L1/L2 в ADR-001/004/VISION относятся к доставке и должны быть переименованы в `summary`/`full`.

## Risks / Weaknesses

- **Недетерминизм распределения**: cutoff по μ+kσ зависит от всего пула; добавление записи меняет результаты. Митигация: per-query калибровка (локоть/gap), а не фиксированный σ.
- **SLO 200ms с LLM недостижим** — поэтому SLO разнесён, LLM вне критического пути.
- **Два эмбеддера дороги** (write/память) — fast-канал выключен по умолчанию и не обязателен.
- **Observability**: без per-layer tracing дебаг потерь невозможен — tracing обязателен.

## Open Questions

- Fast-эмбеддер: хранить оба вектора в БД или считать fast on-the-fly (диагностика)?
- Два вектора: 2 колонки в `memories` или отдельная таблица?
- `filterMode` default: pre / post / iterative?
- Пороги `autoThresholds` (10k / 1M) — фиксированы или зависят от dim?
- Rebuild ANN-индекса: on-write / периодический / ручной?

## Falsification Criteria

- **recall@10 ≥ 0.90** на расширенном QA-наборе (`qa/qa-set.json`, 21 вопрос) после рефакторинга — без регресса от текущих 0.937.
- **p99 latency S0+S1 ≤ 150ms** при пуле ≤ 1000 памятей (замер в `scripts/eval-retrieval.py`).
- **слои/каналы независимы**: отключение LLM (S2b) или graph-канала не ломает остальные и не падает с ошибкой.
- **type-recall не теряется**: recall по type-вопросам (goal/preference/instruction) ≥ 0.95 после семантического отсева.
- **graph даёт прирост**: recall на semantic-gap вопросах (`q-backend`, `q-package-manager`) растёт с включённым graph-каналом.

Если после рефакторинга recall@10 падает ниже 0.90 или p99 S0+S1 вырастает выше 150ms — решение пересмотреть.
