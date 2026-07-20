# Конфигурация Margo (RetainDB)

Вся конфигурация эмбеддинга и реранкинга централизована. Три способа настройки — в порядке приоритета:

| Приоритет | Источник | Пример |
|---|---|---|
| 1 (высший) | Переменная окружения | `EMBEDDING_MODE=openai` |
| 2 | `retaindb.config.json` | `{ "embedding": { "mode": "openai" } }` |
| 3 (низший) | Значение по умолчанию | `"remote"` |

---

## Быстрый старт

### Минимальный запуск (всё локально, без API-ключей)

```bash
cd Margo
pnpm install
pnpm dev:server
```

Сервер поднимется на `:3000` с `EMBEDDING_MODE=remote` (по умолчанию). Если не указан `EMBEDDING_INFERENCE_BASE_URL`, эмбеддинг упадёт на первый запрос — нужно либо поднять embedding-server, либо переключить режим.

### Локальный эмбеддинг (BGE-large, бесплатно)

```bash
# Терминал 1: поднимаем embedding-server
cd packages/server
npx tsx src/embedding-server.ts
# → слушает :8080, модель Xenova/bge-large-en-v1.5

# Терминал 2: сервер с remote-эмбеддером
EMBEDDING_MODE=remote \
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080 \
pnpm dev:server
```

### OpenAI

```bash
EMBEDDING_MODE=openai \
OPENAI_API_KEY=sk-... \
pnpm dev:server
```

### DeepSeek (реранкинг + extraction через reasoning-модели)

```bash
EMBEDDING_MODE=remote \
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080 \
OPENAI_API_KEY=sk-... \
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
LLM_RERANK_MAX_TOKENS=500 \
LLM_EXTRACTION_MAX_TOKENS=1500 \
pnpm dev:server
```

> ⚠️ DeepSeek v4 — reasoning-модели. `max_tokens` включает и reasoning, и content. Для extraction нужно ≥800, для reranking ≥300. Значения по умолчанию (200/800) рассчитаны на OpenAI.

---

## Конфигурация через `retaindb.config.json`

Создай файл в корне проекта:

```json
{
  "embedding": {
    "mode": "remote",
    "model": "Xenova/bge-large-en-v1.5",
    "embeddingInferenceBaseUrl": "http://localhost:8080",
    "inferenceApiKey": null,
    "inferenceTimeoutMs": 2500,
    "remoteRequired": false,
    "largeBatchThreshold": 20,
    "maxBatchSize": 64,
    "maxConcurrency": 2,
    "cacheFile": ".embedding-cache.json",
    "geminiDimensions": 768,
    "extractionMaxTokens": 800
  },
  "rerank": {
    "mode": "balanced",
    "provider": "local",
    "rerankInferenceBaseUrl": null,
    "budgetMs": 90,
    "llmEnabled": false,
    "llmMinBudgetMs": 75,
    "llmMaxCandidates": 5,
    "maxCandidates": 20,
    "llmMaxTokens": 200
  }
}
```

Переменные окружения переопределяют значения из этого файла.

---

## Все переменные окружения

### Embedding

| Переменная | По умолчанию | Описание |
|---|---|---|
| `EMBEDDING_MODE` | `remote` | `openai` \| `gemini` \| `local` \| `hybrid` \| `remote` \| `workers` |
| `EMBEDDING_MODEL` | `Xenova/bge-large-en-v1.5` | Модель для embedding-server |
| `EMBEDDING_LOCAL_MODEL` | `Xenova/bge-large-en-v1.5` | Модель для локального in-process режима |
| `EMBEDDING_INFERENCE_BASE_URL` | — | URL remote-сервиса (приоритет 1) |
| `EMBEDDING_BASE_URL` | — | URL remote-сервиса (приоритет 2) |
| `INFERENCE_BASE_URL` | — | Общий URL для embed + rerank (приоритет 3) |
| `INFERENCE_API_URL` | — | Общий URL (приоритет 4) |
| `INFERENCE_API_KEY` | — | Bearer-токен для remote-сервиса |
| `RETAINDB_INFERENCE_KEY` | — | Альтернативное имя для API-ключа |
| `INFERENCE_TIMEOUT_MS` | `2500` | Таймаут HTTP-запроса к remote |
| `REMOTE_INFERENCE_REQUIRED` | `false` | `true` — падать при недоступности remote |
| `LARGE_BATCH_THRESHOLD` | `20` | Батчи больше — всегда OpenAI/Gemini |
| `EMBEDDING_MAX_BATCH_SIZE` | `64` | Лимит embedding-server |
| `EMBEDDING_MAX_CONCURRENCY` | `2` | Макс. одновременных запросов к embedding-server |
| `EMBEDDING_CACHE_FILE` | `.embedding-cache.json` | Файл кэша эмбеддингов |
| `GEMINI_EMBEDDING_DIMENSIONS` | `768` | Размерность для Gemini |
| `GOOGLE_API_KEY` | — | Ключ для Gemini |
| `LLM_EXTRACTION_MAX_TOKENS` | `800` | max_tokens для LLM-экстракции памяти |

### Reranking

| Переменная | По умолчанию | Описание |
|---|---|---|
| `RERANK_MODE` | `balanced` | `balanced` \| `cross-encoder` \| `llm` |
| `RERANK_PROVIDER` | `local` | `local` \| `remote` |
| `RERANK_INFERENCE_BASE_URL` | — | URL remote-реранкера (приоритет 1) |
| `RERANK_BASE_URL` | — | URL remote-реранкера (приоритет 2) |
| `LLM_RERANK_ENABLED` | `false` | Включить LLM-fallback в balanced-режиме |
| `RERANK_BUDGET_MS` | `90` | Бюджет времени на реранкинг |
| `LLM_RERANK_MIN_BUDGET_MS` | `75` | Остаток бюджета для LLM-fallback |
| `LLM_RERANK_MAX_CANDIDATES` | `5` | Макс. кандидатов для LLM-реранкера |
| `LLM_RERANK_MAX_TOKENS` | `200` | max_tokens для LLM-реранкинга |
| `MAX_RERANK_CANDIDATES` | `20` | Макс. кандидатов на вход реранкера |

### Локальный режим (RetainDB Local)

| Переменная | По умолчанию | Описание |
|---|---|---|
| `RETAINDB_EMBEDDING_PROVIDER` | `hash` | `hash` (SHA-256, быстро) \| `local-transformers` |
| `RETAINDB_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Модель для локального режима |

---

## Режимы эмбеддинга

### `openai`
```bash
EMBEDDING_MODE=openai OPENAI_API_KEY=sk-...
```
- Модель: `text-embedding-3-small`, 1024 измерения
- Требует `OPENAI_API_KEY`

### `gemini`
```bash
EMBEDDING_MODE=gemini GOOGLE_API_KEY=... GEMINI_EMBEDDING_DIMENSIONS=768
```
- Модель: `text-embedding-004`, до 768 измерений
- Требует `GOOGLE_API_KEY`
- ⚠️ Смена измерений требует реиндексации

### `local`
```bash
EMBEDDING_MODE=local
```
- In-process BGE-large через `@xenova/transformers`
- Бесплатно, но грузит CPU/RAM (первый запуск: загрузка ~1.3 ГБ модели)

### `hybrid`
```bash
EMBEDDING_MODE=hybrid
```
- Малые батчи (≤20): локальный BGE
- Большие батчи (>20): OpenAI

### `remote`
```bash
EMBEDDING_MODE=remote EMBEDDING_INFERENCE_BASE_URL=http://your-service:8080
```
- Любой HTTP-сервис с эндпоинтом `POST /v1/inference/embeddings`
- Формат запроса: `{ "inputs": ["text1", "text2"] }`
- Формат ответа: `{ "embeddings": [[0.1, ...], ...], "model": "...", "count": N }`

---

## Режимы реранкинга

### `cross-encoder`
```bash
RERANK_MODE=cross-encoder
```
- Локальный BGE-reranker-large/base
- Быстро, бесплатно, не требует API-ключей

### `llm`
```bash
RERANK_MODE=llm OPENAI_API_KEY=sk-...
```
- GPT-4o-mini ранжирует кандидатов
- Для DeepSeek: добавить `OPENAI_BASE_URL=https://api.deepseek.com/v1` и `LLM_RERANK_MAX_TOKENS=500`

### `balanced` (по умолчанию)
- Cross-encoder + LLM-fallback если confidence < 0.85
- LLM-fallback включается флагом `LLM_RERANK_ENABLED=true`

### `remote`
```bash
RERANK_PROVIDER=remote RERANK_INFERENCE_BASE_URL=http://your-reranker:8080
```
- Любой HTTP-сервис с `POST /v1/inference/rerank`
- Формат: `{ "query": "...", "top_k": 5, "candidates": [...] }`

---

## DeepSeek: особенности

Модели DeepSeek v4 (pro и flash) — **reasoning-модели**. Токены тратятся в два этапа: reasoning → content.

| Операция | OpenAI (default) | DeepSeek (рекомендация) |
|---|---|---|
| Extraction | `LLM_EXTRACTION_MAX_TOKENS=800` | `LLM_EXTRACTION_MAX_TOKENS=1500` |
| Reranking | `LLM_RERANK_MAX_TOKENS=200` | `LLM_RERANK_MAX_TOKENS=500` |

Если `max_tokens` слишком мал, весь бюджет уходит в reasoning, и content пустой.

### Пример .env для DeepSeek

```bash
EMBEDDING_MODE=remote
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com/v1
RERANK_MODE=llm
RERANK_PROVIDER=local
LLM_EXTRACTION_MAX_TOKENS=1500
LLM_RERANK_MAX_TOKENS=500
```

---

## Embedding-server (standalone)

Запускается отдельным процессом:

```bash
cd packages/server
PORT=8080 npx tsx src/embedding-server.ts
```

Эндпоинты:
| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Статус, модель, лимиты |
| `POST` | `/v1/inference/embeddings` | Эмбеддинг текстов |

Настройки:
```bash
PORT=8080                           # Порт (по умолчанию)
EMBEDDING_MODEL=Xenova/bge-large-en-v1.5  # Модель
EMBEDDING_MAX_BATCH_SIZE=64         # Макс. текстов за запрос
EMBEDDING_MAX_CONCURRENCY=2         # Макс. одновременных запросов
INFERENCE_API_KEY=secret            # Включает Bearer-авторизацию
```

---

## Запуск тестов

```bash
pnpm install
pnpm run test                 # Все пакеты (302 теста)

# По отдельности:
pnpm --filter @retaindb/server test   # 191 тест
pnpm --filter @retaindb/local test    # 80 тестов
pnpm --filter @retaindb/sdk test      # 31 тест
```

---

## Пример `retaindb.config.json` для DeepSeek

```json
{
  "embedding": {
    "mode": "remote",
    "embeddingInferenceBaseUrl": "http://localhost:8080",
    "extractionMaxTokens": 1500
  },
  "rerank": {
    "mode": "llm",
    "provider": "local",
    "llmMaxTokens": 500
  }
}
```

Плюс в `.env`:
```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com/v1
```
