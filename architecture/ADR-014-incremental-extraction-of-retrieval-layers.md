# ADR-014: Extract retrieval layers incrementally (strangler + profile flag)

**Status**: Accepted
**Date**: 2026-09-24
**Deciders**: dspilarov + Hermes Agent
**Evidence**: инвентаризация кода 2026-09-24 (см. Context — все размеры и строки измерены); отдельного spike-файла нет.

> Принято 2026-09-24 (все четыре развилки выбраны пользователем). Реализация не начата:
> шаги 0–8 — см. план `research/2026-09-08-adr-implementation-order.md`, Этап 5.

## Context

ADR-007 решает, **какой** должна быть архитектура retrieval (четыре стадии, чистые функции, два
профиля). Этот ADR решает, **как** к ней перейти, не потеряв recall, и уточняет карту модулей по
фактическому состоянию кода.

Замер на 2026-09-24:

| Файл | Строк | Что внутри |
|---|---|---|
| `engine/memory/search.ts` | 954 | `searchMemories` — **317 строк** (243–559), `vectorSearchMemories` (560), `enrichWithRelations` (675), `injectSourceChunks` (804), S0-хелперы `rerankByScope`/`scopeBoost`/`resolveApplicableScopes`, `rerankByIntent` (87) |
| `engine/retriever.ts` | 1963 | `retrieve()` — **433 строки** (150–582) с переплетёнными S0–S3; `vectorSearch` (919), `fullTextSearch` (1064), `memorySearch` (1259), `graphSearch` (1342), `reciprocalRankFusion` (1422), `rerankResults` (1486), `rerankWithLLM` (1568), `packContext` (1635), `enrichResults` (1718) |

Итого **2917 строк**. Публичная поверхность при этом мала: `retrieve` (два импортёра —
`api/routes.ts:11`, `api/research-agent.ts:12`), `searchMemories` (диалектика + memory API),
экспортированные для тестов `uniqueStrings` / `reciprocalRankFusion` / `deduplicateResults` /
`estimateTokens` и `RETRIEVAL_PROFILE_VALUES`. Это делает поэтапную нарезку дешёвой.

Инвентаризация вскрыла **три расхождения с картой модулей ADR-007 §Implementation Impact**:

1. **Путей памяти два, и они ранжируют разными сигналами**: `searchMemories`
   (`similarity * 0.7 + temporalScore * 0.3`, `search.ts:463`) и `retriever.memorySearch`
   (`similarity * (importance || 0.5)`, `retriever.ts:1333`). То есть `importance` **жив в одном из
   путей** — прямо против правила ADR-007 «ранжирование = relevance, не importance» и декомпозиции
   ADR-009 §2. В карте ADR-007 канал памяти как отдельный модуль отсутствует.
2. **`rerankByIntent` живёт в `search.ts:87`**, а не в ретрайвере, и в карте ADR-007 не значится.
3. **`fullTextSearch` содержит три почти идентичных SQL-блока `ts_rank_cd`** (1099, 1138, 1176) —
   дублирование внутри одной функции, а не между файлами.

Дополнительно: `estimateTokens` определён **четыре раза** (`retriever.ts:1675`, `compressor.ts:331`,
`dreamer.ts:172`, `local/cli.ts:130`).

**Affected modules**: `engine/memory/search.ts`, `engine/retriever.ts` (носители),
`engine/memory/dialectic.ts`, `api/{routes,memory,research-agent}.ts` (потребители формы).
Не входят в работу: `engine/cache.ts`, `engine/oracle-select.ts`, `engine/compressor.ts`,
`engine/embeddings*`, `db/vector.ts`, `packages/local`.

**Call chains**: `retrieve → vectorSearch/fullTextSearch/memorySearch/graphSearch → reciprocalRankFusion
→ deduplicateResults → rerankResults → enrichResults → packContext`; `searchMemories →
vectorSearchMemories → [окно ADR-013] → rerankByScope → type-recall → … → calculateTemporalRelevance →
rerankByIntent → injectSourceChunks`.

**Breaking points**: публичные формы — `MemorySearchResult.similarity` (он же `importance` диалектики,
`dialectic.ts:111`), `RetrievalResult.score`/`source`, metadata-ключи (`parent_chunk_id`, `section_path`,
`heading_path`, `parent_content`/`parent_excerpt`, `source_id`, `source_family`), кэш-ключ
`search:…` без scope/`memoryTypes`/`namespace`/`tags`.

## Decision

Четыре решения, принятые 2026-09-24:

1. **Стратегия — strangler по слоям в `main`.** Каждый шаг выносит один слой или канал в новый модуль;
   старый вызов становится делегатом. Публичная форма результата не меняется ни на одном шаге.
2. **Legacy-путь остаётся исполняемым за флагом `retrieval_profile`** (`legacy | precision_v1`) для
   S0–S1, чтобы A/B и откат были одной строкой конфига. Флип значения по умолчанию — только после
   прохождения гейта.
3. **Два входа, общий S0/S2/S3.** `pipeline.memory()` (каналы: memory, type-recall, semantic, lexical,
   graph) и `pipeline.documents()` (semantic, lexical, graph, oracle-scope) — разные наборы S1-каналов,
   общие S0-фильтр, S2-реранк и S3-доставка.
4. **`importance` убирается из ранжирования на шаге S1-унификации** (`retriever.ts:1333`), не дожидаясь
   schema-миграции ADR-009: ранжирование = relevance (ADR-007). `retention_class` придёт позже как
   политика хранения, а не как сигнал ранга.

### Карта модулей (уточняет ADR-007, три модуля добавлены)

```
engine/retrieval/
  types.ts          Candidate · LayerTrace · RetrievalMode
  trace.ts          per-layer {in,out,dropped,ms,cutoff} → telemetry collector (ADR-011)
  scope-filter.ts   S0: resolveApplicableScopes + scopeBoost + rerankByScope + validity/supersession
  recall/
    semantic.ts     vectorSearchMemories + vectorSearch (два SQL-пути → один контракт)
    lexical.ts      fullTextSearch (3 блока → 1) + keywordSearchMemories (api/memory.ts:321) + computeCodebaseLexicalScore
    memory.ts       searchMemories + retriever.memorySearch → один путь ранжирования   ← добавлен
    type-recall.ts  type-aware boost (сейчас inline внутри searchMemories)
    graph.ts        graphSearch + entity-SQL из routes.ts:3191
    fusion.ts       reciprocalRankFusion + веса каналов
  rerank/
    intent.ts       rerankByIntent (search.ts:87)                                       ← добавлен
    cross-encoder.ts rerankResults + rerankWithCrossEncoder/InferenceService + одна нормализация score
    llm.ts          rerankWithLLM
  delivery/
    enrich.ts       enrichResults + enrichWithRelations                                 ← добавлен
    temporal.ts     calculateTemporalRelevance + правило tie-breaker
    chunks.ts       injectSourceChunks + expandParentContexts
    pack.ts         packContext + buildChunkHeader + buildParentExcerpt + один estimateTokens из четырёх
  pipeline.ts       оркестратор S0→S3; searchMemories/retrieve → тонкие адаптеры
```

### Порядок шагов (каждый — отдельный коммит под гейтом ADR-010)

| # | Шаг | Exit criteria |
|---|---|---|
| 0 | Закрепить baseline отдельным файлом; `gen_pool.py --project distractor` по умолчанию (TD-002) | recall@10 воспроизводится дважды, расхождение ≤ 1 п.п. |
| 1 | `types.ts` + `trace.ts`; per-layer tracing встроен в монолиты **без изменения поведения** | drop-off виден в телеметрии, recall@10 не изменился |
| 2 | S0 → `scope-filter.ts` (+ scope в кэш-ключ) | eval-recall не упал; `write-helpers.test.ts` зелёный |
| 3 | S1 lexical → `recall/lexical.ts` (3 SQL-блока → 1, третий lexical унифицирован) | `q-package-manager` / `q-backend` поднимаются (TD-005) |
| 4 | S1 память: один `recall/memory.ts`; `importance` уходит из ранга | dialectic- и document-путь дают один порядок на одном наборе |
| 5 | S2 → `rerank/*`; одна нормализация score | `retriever.test.ts`, dialectic-контракт зелёные |
| 6 | S3 → `delivery/*` | precedence-тесты `packContext` |
| 7 | `pipeline.ts` + адаптеры; флип `retrieval_profile` | гейт ADR-010 + drop-off ADR-011 |
| 8 | Удаление шести дублей ADR-007 + паритет `packages/local` | отдельный трек |

## Falsification Criteria

Критерии ниже — **шаговые гейты**: каждый становится измеримым по мере выполнения соответствующего шага
и до его выполнения не является «уже ложным».

- **Нет регресса на шагах**: каждый шаг не роняет `recall@10` более чем на 2 п.п. относительно
  закреплённого `qa/baseline-YYYY-MM-DD.json`; гейт ADR-010 печатает PASS.
- **A/B выполним без правок кода**: переключение `retrieval_profile` на одном корпусе даёт два
  различных результата в одном прогоне, а откат к legacy — одна строка конфига.
- **Оркестраторы исчезают**: после шага 7 `retrieve()` и `searchMemories()` ≤ 100 строк каждый и не
  содержат SQL и скоринговых констант (gradeable код-ревью).
- **Единый путь памяти**: после шага 4 память, найденная dialectic- и document-путём, даёт одинаковый
  порядок на одном наборе (тест).
- **Наблюдаемость без цены**: после шага 1 телеметрия содержит per-layer `{in,out,dropped,ms,cutoff}`
  для S0–S3 и p99 retrieval не растёт более чем на 5%.
- **Контракты не двинулись**: `similarity`, `score`/`source`, metadata-ключи и экспортированные
  тестовые хелперы неизменны — `retriever.test.ts`, `dialectic`, `hermes-contract.test.ts` зелёные.

## Alternatives Considered

### Option A: Только strangler, без флага профиля
- **Pros**: меньше дублирующего кода и конфигурации.
- **Cons**: на шагах, меняющих семантику S0/S1, нет способа доказать эквивалентность и откатиться
  одним переключением.
- **Why rejected**: цена ошибки несимметрична — регресс recall ловится дороже, чем стоит флаг.

### Option B: Новый конвейер рядом целиком, потом один флип
- **Pros**: чистый старт, нет промежуточных переходных состояний.
- **Cons**: 2917 строк живут в двух копиях; флип одним шагом без промежуточных гейтов; расхождения
  поведения копятся незаметно.
- **Why rejected**: как основа отвергнуто; из него взята часть — флаг профиля (решение 2).

### Option C: Big-bang — переписать оба файла разом
- **Pros**: без временного дублирования.
- **Cons**: промежуточной верификации нет, семь инвариантов ADR-007 ломаются незаметно, откат —
  revert на 2917 строк.
- **Why rejected**: ровно тот сценарий, от которого ADR-010 и ADR-011 и строились.

### Option D: Не сливать память и документы, вынести только каналы
- **Pros**: минимальный риск.
- **Cons**: два оркестратора, дублирование S0/S2/S3, `retrieve` остаётся 433 строки → цель ADR-007
  (изолированные стадии) не достигнута.
- **Why rejected**: не решает задачу, ради которой ADR-007 написан.

## Consequences

### Positive
- Пошаговость: гейт на каждом шаге, откат — одна строка конфига.
- Наблюдаемость появляется **до** изменения поведения (шаг 1), а не после.
- Один путь ранжирования памяти вместо двух, расходящихся сигналами.
- Снимается дублирование: 3 SQL-блока, 4 `estimateTokens`, 2 нормализации score.

### Negative
- Временно два пути → двойное покрытие тестами и риск расхождения; митигация — флаг снимается
  отдельным коммитом после двух недель без откатов.
- Шаг 1 не даёт функциональной ценности: платим один-два коммита за наблюдаемость.
- Флаг профиля добавляет ветвление в конфиг и в тесты.

### Neutral
- ADR-007 остаётся целевой архитектурой; этот ADR — про путь к ней.
- `packages/local` — отдельный трек; `halfvec`/fast-embedder — ADR-012/006-ext, не сюда.

## Compliance

- План `research/2026-09-08-adr-implementation-order.md` содержит все шаги с exit criteria: шаги 0–1 —
  в «Этапе 2.0» (предусловия), шаги 2–8 — в Этапе 5 (обновлён 2026-09-24).
- Каждый шаг — отдельный коммит; гейт ADR-010 прогоняется перед следующим.
- Legacy-флаг удаляется отдельным коммитом после двух недель без откатов; до этого он обязателен.
- ADR-007 получает ссылку на ADR-014; при расхождении карт модулей приоритет у ADR-014.

## Related ADRs

- **ADR-007 (retrieval S0–S3)** — целевая архитектура; ADR-014 уточняет карту модулей и путь перехода.
- **ADR-006 (pgvector вне Prisma)** — слой доступа к векторам; в этой работе не трогается.
- **ADR-009 (memory hygiene)** — `importance` → `retention_class`; шаг 4 убирает `importance` из ранга.
- **ADR-010 (benchmarking)** — гейт на каждом шаге.
- **ADR-011 (telemetry & QC)** — per-layer drop-off, который встраивается шагом 1.
- **ADR-012 (inference providers)** — провайдеры в S0–S3; выполняется после этой работы.
- **ADR-013 (adaptive window)** — окно применяется на S1 в шагах 3–4.
