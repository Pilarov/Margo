# Тестирование Margo

## Запуск

```bash
pnpm install
pnpm run test                 # Все 3 пакета, 302 теста
pnpm --filter @retaindb/server test   # Только сервер (191 тест)
pnpm --filter @retaindb/local test    # Только локальный (80 тестов)
pnpm --filter @retaindb/sdk test      # Только SDK (31 тест)
```

## Структура

```
packages/server/src/__tests__/          # Серверные тесты (9 файлов)
├── config.test.ts                      # Конфиг: defaults, типы
├── engine/
│   ├── chunker.test.ts                 # detectChunkType (21 тест)
│   ├── cost-optimization.test.ts       # getOptimalModel, estimateCost
│   ├── embeddings-local.test.ts        # shouldUseLLMFallback
│   ├── ingestion-profiles.test.ts      # classifyDocument, resolveIngestionPlan
│   └── memory/
│       ├── patterns.test.ts            # extractExplicitMemory (21 тест)
│       ├── temporal-local.test.ts      # parseTemporalLocal (15 тестов)
│       └── write-helpers.test.ts       # Scope inference, dedup, validation (50 тестов)
└── lib/
    └── memory-normalization.test.ts    # buildMemoryNormalizationFields

packages/local/src/__tests__/           # Локальные тесты (3 файла)
├── cli-pure.test.ts                    # hashEmbedding, cosine, signalQuality (65 тестов)
├── config.test.ts                      # Конфиг локального режима
└── store-integrity.test.ts             # JSON-хранилище, журнал, recovery

packages/sdk/src/__tests__/             # SDK тесты (2 файла)
├── core/utils.test.ts                  # stableHash, normalizeBaseUrl (25 тестов)
└── graph-utils.test.ts                 # memoryGraphToMermaid (10 тестов)
```

## Критичность по приоритетам

| Приоритет | Файлов | Тестов | Компоненты |
|---|---|---|---|
| **P0** | 3 | 160 | Scope inference, dedup, validation, hashEmbedding, store integrity, shouldUseLLMFallback |
| **P1** | 6 | 109 | Patterns, temporal parsing, memory normalization, config defaults |
| **P2** | 5 | 33 | SDK utils, graph, chunker, cost-optimization, ingestion-profiles |

## Что не покрыто

- **Интеграционные тесты сервера** — требуют PostgreSQL + Redis (writeMemoryCanonical, searchMemories, retrieve)
- **E2E тесты** — полный цикл с HTTP-запросами (есть отдельный скрипт `e2e-test.mjs`)
- **MCP-сервер** — `packages/mcp` пока без тестов

## E2E-тест (отдельный)

```bash
# Требует запущенный embedding-server на :8080
node e2e-test.mjs
```

Проверяет полный пайплайн: Embed → Search → Extract → Rerank.
