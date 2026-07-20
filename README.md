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

### Обязательные системные зависимости

Независимо от режима запуска, на машине должны быть:

| Зависимость | Мин. версия | Проверка |
|---|---|---|
| **Node.js** | ≥ 18.0 | `node --version` |
| **pnpm** | ≥ 9.0 | `pnpm --version` |
| **git** | любая | `git --version` |

Установка Node.js и pnpm (Ubuntu):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm@9.15.0
```

Клонирование и установка зависимостей:

```bash
git clone https://github.com/Pilarov/Margo.git
cd Margo
pnpm install
```

---

### Сервисы, необходимые для каждого режима

Margo состоит из нескольких сервисов. Не все нужны одновременно — набор зависит от выбранного режима запуска.

| Сервис | Порт | Назначение | Когда обязателен |
|---|---|---|---|
| **Margo Server** | `:3000` | Основной API: запись/поиск памяти, контекст, коннекторы | Всегда (кроме local-режима) |
| **PostgreSQL + pgvector** | `:5432` | База данных: memory, chunks, embeddings, граф | Только server-режим |
| **Embedding Server** | `:8080` | Генерация векторных эмбеддингов (BGE-large) | При `EMBEDDING_MODE=remote` или `local` |
| **Redis** | `:6379` | Кэш поиска, очередь embedding-задач | Опционально (server сам работает без него, но медленнее) |

Схема для server-режима:

```
[Клиент] → :3000 [Margo Server] → :5432 [PostgreSQL+pgvector]
                                   → :8080 [Embedding Server]
                                   → :6379 [Redis] (опционально)
```

---

### Вариант 1: Полностью локально (без Postgres, без API-ключей)

Минимальный набор: **Margo Server + Embedding Server**. PostgreSQL не нужен, Redis не нужен, API-ключи не нужны.

```bash
# Терминал 1 — Embedding Server (обязателен)
cd packages/server
npx tsx src/embedding-server.ts
# Ждать сообщения "[LocalEmbeddings] Model loaded in ~14s"
# Проверить: curl http://localhost:8080/health

# Терминал 2 — Margo Server
cd Margo
EMBEDDING_MODE=remote \
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080 \
pnpm dev:server
# Сервер на http://localhost:3000
```

Порты после запуска:

| Сервис | Порт | Проверка |
|---|---|---|
| Embedding Server | `:8080` | `curl http://localhost:8080/health` |
| Margo Server | `:3000` | `curl http://localhost:3000/health` |

Embedding Server загружает модель `Xenova/bge-large-en-v1.5` (1024 измерения). Первый холодный запуск: ~14 секунд и ~1.3 ГБ RAM. Затем latency: ~60-70ms на запрос.

---

### Вариант 2: С OpenAI (без своего эмбеддера)

Нужен только **Margo Server**. Эмбеддинг — через OpenAI API.

```bash
# Терминал 1 (достаточно одного)
EMBEDDING_MODE=openai \
OPENAI_API_KEY=sk-... \
pnpm dev:server
```

Embedding Server не нужен. PostgreSQL не нужен (для dev-режима без `db:push` сервер запустится, но упадёт на первом запросе к БД).

---

### Вариант 3: Production (PostgreSQL + свой эмбеддер + DeepSeek)

Полный набор: **Margo Server + PostgreSQL + Embedding Server + DeepSeek API**.

Шаг 1: PostgreSQL с pgvector:

```bash
# Docker (рекомендуется)
docker run -d --name margo-pg \
  -e POSTGRES_USER=retaindb \
  -e POSTGRES_PASSWORD=retaindb \
  -e POSTGRES_DB=retaindb \
  -p 5432:5432 \
  pgvector/pgvector:pg16

# Или локально: установить PostgreSQL 16 + CREATE EXTENSION vector;
```

Шаг 2: `.env` в `packages/server/` (скопировать из `.env.example`):

```bash
cp .env.example packages/server/.env
```

В `packages/server/.env`:

```bash
DATABASE_URL=postgresql://retaindb:retaindb@localhost:5432/retaindb
OPENAI_API_KEY=sk-...                        # Ключ DeepSeek
OPENAI_BASE_URL=https://api.deepseek.com/v1  # DeepSeek endpoint
LLM_EXTRACTION_MAX_TOKENS=1500               # Больше для reasoning-моделей
LLM_RERANK_MAX_TOKENS=500
```

Шаг 3: Embedding Server (терминал 1):

```bash
cd packages/server
npx tsx src/embedding-server.ts
# Ждать загрузки модели
```

Шаг 4: Применить миграции и запустить сервер (терминал 2):

```bash
cd Margo
pnpm --filter @retaindb/server run db:push   # Создать таблицы
EMBEDDING_MODE=remote \
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080 \
pnpm dev:server
```

Сервисы после запуска:

| Сервис | Порт | Откуда |
|---|---|---|
| PostgreSQL | `:5432` | Docker / системный |
| Embedding Server | `:8080` | Терминал 1 |
| Margo Server | `:3000` | Терминал 2 |

Проверка:

```bash
# Эмбеддер
curl http://localhost:8080/health

# Сервер
curl http://localhost:3000/health

# E2E-тест пайплайна
node e2e-test.mjs
```

---

### Вариант 4: Docker Compose (всё в контейнерах)

```bash
# Server-режим: PostgreSQL + Server
docker compose up -d

# Local-режим: один контейнер со встроенным эмбеддером
docker compose -f docker-compose-local.yml up -d
```

Состав `docker-compose.yml` (server-режим):
- `postgres` — pgvector/pgvector:pg16, порт `:5432`
- `server` — собирается из `packages/server/Dockerfile`, порт `:3000`

Embedding Server в Docker-режиме не поднимается автоматически — его нужно либо запустить отдельно, либо переключить `EMBEDDING_MODE=openai` и передать `OPENAI_API_KEY`.

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
