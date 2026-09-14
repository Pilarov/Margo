# ADR-012: Model-agnostic inference providers (CPU-first)

**Status**: Proposed
**Date**: 2026-09-08
**Deciders**: opencode + dspilarov

> **Сквозной ADR.** На него ссылаются ADR-006 (pgvector/размерность), ADR-007 (S0–S3 retrieval), ADR-009 (reembed). Определяет, как Margo работает с ML-моделями.

## Context

Margo завязан на конкретные модели и их размерности:

| Завязка | Где | Проблема |
|---|---|---|
| `EMBEDDING_DIM = 1024` (константа) | `config.ts:223`, `db/vector.ts:12` | нельзя любой эмбеддер |
| `Xenova/bge-large-en-v1.5` зашит | `embeddings-local.ts:52` | English-only, не сменный |
| OpenAI всегда `text-embedding-3-small` | `embeddings.ts:36-38` | модель не из конфига |
| Gemini зашит `text-embedding-004` | `embeddings.ts:61,67` | то же |
| cross-encoder зашит `bge-reranker-large` | `embeddings-local.ts:76` | не сменный, English |
| pgvector колонка `vector(1024)` | `prisma/scripts/pgvector.sql:12-14` | фиксирует dim |
| `embedding-server.ts:76` | `POST /v1/inference/embeddings` | только `embedLocal` (bge-large) |

Требования:
1. **CPU-first**: всё, кроме LLM-задач (диалектика, LLM-rerank, управление, клининг), работает на CPU. GPU не обязателен.
2. **Model-agnostic через endpoint**: любой эмбеддер/реранкер задаётся конфигом; Margo не знает, мультиязычная ли модель, — для него это «текст → вектор» и «(query, docs) → scores».

## Decision

**Ввести абстракцию inference-провайдера: все ML-модели (embedding, fast-embedding, rerank) скрыты за интерфейсом, реализация и параметры выбираются конфигом. Margo агностичен к модели; CPU — дефолт, remote endpoint — опция.**

### 1. Интерфейсы

```ts
interface EmbeddingProvider {
  readonly dim: number;
  readonly metric: "cosine" | "l2" | "ip";
  embed(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

interface RerankProvider {
  rerank(query: string, docs: string[], opts?: { topN?: number }): Promise<number[]>; // scores
}
```

Реализации: `local` (CPU, ONNX/transformers.js), `remote` (HTTP endpoint), `openai`, `gemini`, `custom`. Добавление новой модели = новый конфиг, **не код**.

### 2. Generic-конфиг

```jsonc
"inference": {
  "embedding": {
    "provider": "local",              // local | remote | openai | gemini | custom
    "endpoint": "http://.../embeddings",  // для remote/custom
    "model": "Xenova/multilingual-e5-small",
    "dim": 384,
    "metric": "cosine"
  },
  "fastEmbedding": {
    "provider": "local",
    "model": "minishlab/potion-multilingual-128M",
    "dim": 256
  },
  "rerank": {
    "provider": "remote",
    "endpoint": "http://.../rerank",
    "model": "<any>"
  }
}
```

- `dim`/`metric` — свойства провайдера, не глобальные константы.
- `EMBEDDING_DIM` перестаёт быть константой; остаётся только как fallback для `local`-дефолта.

### 3. CPU-first дефолты

| Провайдер | CPU-дефолт | Обоснование |
|---|---|---|
| embedding | компактная мультиязычная (напр. `multilingual-e5-small`, 384) + ONNX int8 | CPU-совместимость |
| fastEmbedding | `potion-multilingual-128M` (model2vec) | ~500× быстрее на CPU |
| rerank | компактный cross-encoder (напр. `bge-reranker-base`/MiniLM) + int8 | большой cross-encoder на CPU не влезает в SLO |

Большие модели (BGE-M3, bge-reranker-v2-m3) — **опция через `remote`**, не дефолт. SLO формулируется для CPU-дефолта.

### 4. Смена провайдера (dim + reembed)

- `pgvector` колонка создаётся под `dim` из конфига.
- При смене провайдера с другим `dim` → `ALTER COLUMN ... TYPE vector(N)` + **reembed** (ADR-009 threshold-процесс).
- В записи хранятся `embedding_model` и `embedding_dim` для валидации (`embedding_status` — ADR-009).
- Смена модели при том же `dim` → reembed без ALTER.

### 5. Инвариант

**Margo не знает про мультиязычность.** Мультиязычность — свойство выбранной модели. Замена English→multilingual — это смена конфига, не кода.

## Implementation Impact

### Что написать (новое)

- `engine/inference/provider.ts` — интерфейсы `EmbeddingProvider`, `RerankProvider`.
- `engine/inference/providers/local.ts` — CPU (ONNX/transformers.js), `dim` из конфига.
- `engine/inference/providers/remote.ts` — HTTP endpoint (generic, любой model/dim).
- `engine/inference/providers/openai.ts`, `gemini.ts` — обёртки (модель из конфига).
- `engine/inference/registry.ts` — выбор провайдера из конфига.
- `engine/inference/fast.ts` — fast-embedding (model2vec, ADR-007 L0).
- `EmbeddingProvider.embedOne` для единичных вызовов.

### Что изменить (существующее)

| Файл | Изменение | Риск |
|---|---|---|
| `config.ts:37-73` | `EmbeddingConfig` → generic (`provider/endpoint/model/dim/metric`); `EMBEDDING_DIM:223` → из провайдера | HIGH |
| `config.ts:77-107` | `RerankConfig` → generic | MED |
| `embeddings.ts:100/140` | `embed`/`embedSingle` делегируют в registry; убрать хардкод OpenAI/Gemini | HIGH |
| `embeddings-local.ts:52/68/150` | модель не зашита; `dim` параметр; cross-encoder → `RerankProvider` | HIGH |
| `db/vector.ts:12/18/23` | `dimensionCheck` принимает `dim` провайдера, не константу | HIGH |
| `prisma/scripts/pgvector.sql:12-14` | `vector(1024)` → под `dim` конфига | HIGH |
| `inference-client.ts:93/101` | generic endpoint/model, не только bge | MED |
| `embedding-server.ts:76` | отдаёт конфигурируемую модель (не только bge-large) | MED |
| `schema.prisma` (Memory/Chunk/Embedding) | `embedding_model`, `embedding_dim` (валидация) | MED |
| `embeddings.ts:24-26` | `EMBEDDING_MODE`/`USE_LOCAL` снапшоты на импорте → читать при вызове | MED |

### Callers (затронуты)

- `write.ts:760` `embedMemoryInline`, `write.ts:783` (embeddingText) → провайдер.
- `embedding-worker.ts:24` `processMemoryJob` → провайдер + `embedding_status`.
- `ingest.ts:266`, `consolidation.ts:182`, `extractor.ts:88` → `embedSingle`/`embed`.
- `search.ts:288`, `retriever.ts` → `embedSingle` для запроса.
- `embeddings-local.ts:179` `shouldUseLLMFallback` (cross-encoder score) → `RerankProvider`.

### Что может сломать

1. **`EMBEDDING_DIM` — публичный контракт**: `db/vector.ts:12`, `db/vector.test.ts`, `config.test.ts`, `config-llm-env.test.ts:111-113`. Замена на per-provider dim ломает тесты и логику размерности.
2. **pgvector `vector(N)` не гибок**: смена `dim` требует `ALTER` + reembed; при несовпадении — падение `<=>` на 29 сайтах (`search.ts:630`, `retriever.ts:945-1357`, `routes.ts:2739/3194`, `oracle-select.ts:95`).
3. **Хардкод моделей**: `embeddings.ts:36-38` (OpenAI), `:61-67` (Gemini), `embeddings-local.ts:52/76` — удаление меняет поведение существующих режимов.
4. **Моки тестов**: `embeddings.test.ts:11-14` мокает config с `{geminiDimensions, mode, largeBatchThreshold}`; `embeddings-local.test.ts` тестирует `shouldUseLLMFallback`; добавление `inference`-импортов сломает.
5. **`embedding-server.ts:76`** — контракт `POST /v1/inference/embeddings` (только bge-large); generic-модель меняет ответ (dim).
6. **`halfvec`/`bit`** (ADR-006): колонка другого типа → новые opclass; нельзя смешивать без каста.
7. **Кэш**: `cache.ts:469` semantic cache без model/dim tag → разные провайдеры в одном пространстве дадут мусор. Нужен namespace.
8. **`embedding_status`**: при смене провайдера массовый reembed (ADR-009); без него поиск вернёт неполные результаты.
9. **`llm-wiring.test.ts`**: `cost-optimization.ts` использует bare `getLLMClient()` — не трогать; новые провайдеры не должны нарушить WIRING.
10. **`EMBEDDING_MODE` snapshot** (`embeddings.ts:24-26`) — live-смена конфига игнорируется до рестарта.

## Alternatives Considered

### Option A: Оставить хардкод моделей, добавить ещё режимы
- **Pros**: минимум работы.
- **Cons**: каждая новая модель = код; мультиязычность невозможна без правок; `dim` зашит.
- **Why rejected**: противоречит требованию model-agnostic.

### Option B: Только remote-провайдер (всё через endpoint)
- **Pros**: Margo вообще не знает моделей.
- **Cons**: обязательный внешний inference-сервис; нарушает CPU-first (нужен отдельный сервис).
- **Why rejected**: CPU-дефолт должен работать без внешних зависимостей.

### Option C: Плагины-провайдеры (динамическая загрузка)
- **Pros**: максимальная расширяемость.
- **Cons**: сложность, безопасность, версионирование.
- **Why rejected**: оверкилл; достаточно enum-провайдеров из конфига.

## Consequences

### Positive
- **Любая модель через конфиг** — English/multilingual/размерность, без кода.
- **CPU-first** — работает без GPU; большие модели опциональны через remote.
- **Смена провайдера** — процедура (dim + reembed), а не рефакторинг.
- **Единая точка** контроля ML-зависимостей.

### Negative
- **Абстракция** — +слой, +косвенность.
- **dim-миграции** — смена провайдера требует ALTER + reembed.
- **SLO** — CPU-дефолты скромнее по качеству/скорости, чем GPU-модели.

### Neutral
- `EMBEDDING_DIM` сохраняется как fallback для local-дефолта.
- ADR-006/007/009 переформулируются в терминах провайдеров.

## Risks / Weaknesses

- **Кэш-коллизии**: semantic cache без model/dim tag (нужен namespace).
- **Тесты на размерность**: массовые правки `EMBEDDING_DIM`.
- **Live-конфиг**: снапшоты на импорте (`embeddings.ts:24-26`, `middleware/latency-trace.ts:9`).
- **Смена провайдера без reembed** — тихая деградация (несовпадение пространств).
- **remote-провайдер** — новая точка отказа; нужен fallback.

## Open Questions

- Дефолтная CPU-модель: `multilingual-e5-small` (384) или компактнее?
- Хранить `embedding_dim` per-record или per-project?
- Поддерживать несколько эмбеддеров одновременно (несколько колонок) или один на инстанс?
- `fastEmbedding` — обязателен или опционален (ADR-007 L0)?
- Кто владеет `embedding-server.ts` — отдельный сервис или встроенный?

## Falsification Criteria

- **Model-agnostic**: смена `inference.embedding.model`+`dim` в конфиге (напр. 384↔768) проходит без правок кода (только миграция+reembed).
- **CPU-only**: полный retrieval (embed + fast + rerank) работает без GPU и укладывается в CPU-SLO.
- **Мультиязычность**: запрос на русском находит русскую память с multilingual-моделью без изменений кода.
- **Нет хардкода**: grep по `bge-large|text-embedding-3-small|text-embedding-004|bge-reranker` не находит зашитых моделей вне конфига/дефолтов.
- **Размерность**: несовпадение `dim` записи и провайдера ловится валидацией, а не падением `<=>`.

## Related ADRs

- **ADR-006 (pgvector вне Prisma)** — `dim`/metric как свойства провайдера; колонка под конфиг.
- **ADR-007 (retrieval S0–S3)** — S0/S1/S2 через провайдеры; fast = `fastEmbedding`; rerank = `RerankProvider`.
- **ADR-009 (memory hygiene)** — reembed как threshold-процесс при смене провайдера.
- **ADR-010 (benchmark)** — замер качества/latency per-provider.
