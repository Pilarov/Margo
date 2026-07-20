<p align="center">
  <h1 align="center">Margo</h1>
</p>

<p align="center">
  Memory infrastructure for AI agents — fork of <a href="https://github.com/retaindb/retaindb">RetainDB</a> with centralized configuration, pluggable embeddings, LLM reranking, and comprehensive test coverage.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/local-first-success" alt="Local first" />
  <img src="https://img.shields.io/badge/license-Apache%202.0%20%2F%20BSL%201.1-blue" alt="License" />
  <img src="https://img.shields.io/badge/tests-302%20passed-green" alt="Tests" />
</p>

---

## Что нового в Margo

| Возможность | Статус |
|---|---|
| Централизованный конфиг (`config.ts`) | ✓ |
| `retaindb.config.json` — альтернатива env-переменным | ✓ |
| Подключаемые эмбеддеры: OpenAI, Gemini, BGE-local, remote HTTP | ✓ |
| Подключаемый реранкинг: cross-encoder, LLM, balanced, remote HTTP | ✓ |
| Настройка `max_tokens` для reasoning-моделей (DeepSeek) | ✓ |
| 302 unit-теста в 14 файлах (Vitest) | ✓ |
| E2E-тест: Embed → Search → Extract → Rerank | ✓ |
| Подробная документация: `CONFIGURATION.md`, `TESTING.md` | ✓ |

---

## Быстрый старт

### Локально (без Postgres, без API-ключей)

```bash
git clone https://github.com/Pilarov/Margo.git
cd Margo
pnpm install

# Терминал 1: embedding-server
cd packages/server && npx tsx src/embedding-server.ts

# Терминал 2: сервер
EMBEDDING_MODE=remote EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080 pnpm dev:server
```

Сервер на `:3000`. Эмбеддер на `:8080` (BGE-large, 1024-dim, бесплатно).

### С OpenAI

```bash
EMBEDDING_MODE=openai OPENAI_API_KEY=sk-... pnpm dev:server
```

### С DeepSeek

```bash
EMBEDDING_MODE=remote \
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080 \
OPENAI_API_KEY=sk-... \
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
LLM_EXTRACTION_MAX_TOKENS=1500 \
LLM_RERANK_MAX_TOKENS=500 \
pnpm dev:server
```

### Docker

```bash
docker compose up                    # Server + PostgreSQL + pgvector
docker compose -f docker-compose-local.yml up -d  # Local mode
```

---

## Конфигурация

Три способа — в порядке приоритета:

| Приоритет | Источник |
|---|---|
| 1 | Переменные окружения |
| 2 | `retaindb.config.json` |
| 3 | Значения по умолчанию |

Пример `retaindb.config.json`:

```json
{
  "embedding": {
    "mode": "remote",
    "embeddingInferenceBaseUrl": "http://localhost:8080",
    "extractionMaxTokens": 1500
  },
  "rerank": {
    "mode": "llm",
    "llmMaxTokens": 500
  }
}
```

Подробнее: **[CONFIGURATION.md](./CONFIGURATION.md)** — все 50+ переменных, 6 режимов эмбеддинга, 4 режима реранкинга, DeepSeek-особенности.

---

## Эмбеддинг

| Режим | Что используется | Ключ |
|---|---|---|
| `remote` | Любой HTTP-сервис | `EMBEDDING_INFERENCE_BASE_URL` |
| `openai` | text-embedding-3-small (1024-dim) | `OPENAI_API_KEY` |
| `gemini` | text-embedding-004 (768-dim) | `GOOGLE_API_KEY` |
| `local` | BGE-large in-process (1024-dim) | Не нужен |
| `hybrid` | local + OpenAI (по размеру батча) | `OPENAI_API_KEY` |

## Реранкинг

| Режим | Что используется |
|---|---|
| `cross-encoder` | BGE-reranker-large (локально) |
| `llm` | GPT-4o-mini / DeepSeek |
| `balanced` | cross-encoder + LLM-fallback (если confidence < 0.85) |
| `remote` | Любой HTTP-сервис |

---

## Тесты

```bash
pnpm install
pnpm run test                 # 302 теста, 3 пакета
pnpm --filter @retaindb/server test   # 191 тест
pnpm --filter @retaindb/local test    # 80 тестов
pnpm --filter @retaindb/sdk test      # 31 тест
```

Подробнее: **[TESTING.md](./TESTING.md)** — структура, приоритеты P0/P1/P2, непокрытое.

## E2E

```bash
# Требует embedding-server на :8080
node e2e-test.mjs
```

Пайплайн: Embed (BGE-large) → Search (cosine) → Extract (LLM) → Rerank (LLM).

---

## Пакеты

| Пакет | Описание |
|---|---|
| `packages/local` | Локальный runtime: JSON-хранилище, in-process embeddings, API на `:3111`/`:3113` |
| `packages/server` | Сервер: PostgreSQL + pgvector, SOTA memory, 20+ коннекторов |
| `packages/sdk` | TypeScript SDK: клиент, кэш, очереди, адаптеры (Vercel AI, LangChain) |
| `packages/mcp` | MCP-сервер: 12 инструментов для Claude/Codex/OpenCode |

---

## REST API (сервер)

Сервер на `:3000` (или `PORT`).

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/v1/memory` | Запись памяти |
| `POST` | `/v1/memory/search` | Поиск памяти |
| `POST` | `/v1/context/query` | Контекст для LLM |
| `POST` | `/v1/memory/ingest/session` | Импорт сессии |
| `GET` | `/v1/projects` | Список проектов |
| `POST` | `/v1/projects/:id/sources` | Подключить источник |

## Разработка

```bash
pnpm install
pnpm dev:server          # Сервер в dev-режиме
pnpm local:demo          # Локальный режим с демо
pnpm run typecheck       # Проверка типов
pnpm run lint            # Линтер
```

## Лицензия

- `packages/local`: Apache 2.0
- `packages/sdk`: Apache 2.0
- `packages/mcp`: Apache 2.0
- `packages/server`: [Business Source License 1.1](./LICENSE-BSL)
