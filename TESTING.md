# Тестирование Margo

## Запуск

```bash
pnpm install
pnpm run test                 # все 3 пакета, 346 тестов
pnpm --filter @retaindb/server test   # сервер (235 тестов)
pnpm --filter @retaindb/local test    # локальный (80 тестов)
pnpm --filter @retaindb/sdk test      # SDK (31 тест)
```

## Структура

```
packages/server/src/__tests__/          # сервер (12 файлов, 235 тестов)
├── config.test.ts                      # defaults: embedding, rerank, llm (29)
├── config-llm-env.test.ts              # task() fallback: env → json → default (8)
├── engine/
│   ├── llm-client.test.ts              # getLLMClient: резолв, кэш, ошибки (8)
│   ├── llm-wiring.test.ts              # проводка 18 файлов → getLLMClient(llmCfg.X) (21)
│   ├── chunker.test.ts                 # detectChunkType (21)
│   ├── cost-optimization.test.ts       # getOptimalModel, estimateCost (13)
│   ├── embeddings-local.test.ts        # shouldUseLLMFallback (11)
│   ├── ingestion-profiles.test.ts      # classifyDocument, resolveIngestionPlan (17)
│   └── memory/
│       ├── patterns.test.ts            # extractExplicitMemory (21)
│       ├── temporal-local.test.ts      # parseTemporalLocal (15)
│       └── write-helpers.test.ts       # scope inference, dedup, validation (50)
└── lib/
    └── memory-normalization.test.ts    # buildMemoryNormalizationFields (21)

packages/local/src/__tests__/           # локальный (3 файла, 80 тестов)
├── cli-pure.test.ts                    # hashEmbedding, cosine, signalQuality (60)
├── config.test.ts                      # конфиг локального режима (4)
└── store-integrity.test.ts             # JSON-хранилище, журнал, recovery (16)

packages/sdk/src/__tests__/             # SDK (2 файла, 31 тест)
├── core/utils.test.ts                  # stableHash, normalizeBaseUrl (21)
└── graph-utils.test.ts                 # memoryGraphToMermaid (10)
```

## LLM-конфиг: что покрыто (по слоям)

| Слой | Тест | Что проверяет |
|---|---|---|
| Дефолты моделей | `config.test.ts` | 18 задач имеют ожидаемую модель |
| Fallback-цепочка | `config-llm-env.test.ts` | env > json > default для model/apiKey/baseUrl |
| Резолв клиента | `llm-client.test.ts` | `getLLMClient(task)` — per-task key/url, fallback, кэш, ошибка без ключа |
| Проводка | `llm-wiring.test.ts` | каждый из 18 файлов зовёт `getLLMClient(llmCfg.<правильный-task>)` |
| Реальный провайдер | `e2e-llm-provider.ts` | настоящий LLM-вызов через DeepSeek |

## Критичность по приоритетам

| Приоритет | Компоненты |
|---|---|
| **P0** | Scope inference, dedup, validation, hashEmbedding, store integrity, LLM-конфиг (резолв + проводка) |
| **P1** | Patterns, temporal parsing, memory normalization, config defaults |
| **P2** | SDK utils, graph, chunker, cost-optimization, ingestion-profiles |

## Что не покрыто (честно)

| Модуль | Причина | Приоритет |
|---|---|---|
| `retrieve()` / `searchMemories()` / `writeMemoryCanonical()` | требуют PostgreSQL + Redis, только чистые helper'ы протестированы | P1 |
| `retaindb.config.json` путь | `readJsonConfig()` не тестируется с реальным JSON-файлом | P2 |
| MCP-сервер (12 инструментов) | 0 тестов | P3 |
| 20+ коннекторов (GitHub, Slack, Notion...) | 0 тестов | P3 |
| SDK-клиент (`RetainDBClient`, `MemoryModule`, адаптеры) | только utils/graph | P3 |
| `LocalMemoryRuntime` класс (addMemory/search/consolidate) | не экспортирован | P3 |

## E2E-тесты

### E2E: мультипровайдерный конфиг

```bash
cd packages/server
OPENAI_API_KEY=sk-... \
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
LLM_EXTRACTION_MODEL=deepseek-v4-flash \
LLM_EXTRACTION_BASE_URL=https://api.deepseek.com/v1 \
node --import tsx/esm src/e2e-llm-provider.ts
```

Проверяет:
1. Конфиг резолвится (per-task model/key/url + fallback)
2. `getLLMClient(task)` строит клиента с правильным baseURL
3. Реальный LLM-вызов проходит и возвращает контент

### E2E: полный пайплайн (Embed → Search → Extract → Rerank)

```bash
# Требует запущенный embedding-server на :8080
node e2e-test.mjs
```

Проверяет: BGE-large эмбеддинг → cosine search → LLM extraction → LLM reranking.
