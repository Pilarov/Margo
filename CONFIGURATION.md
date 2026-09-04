# Конфигурация Margo (RetainDB)

Вся конфигурация централизована: эмбеддинг, реранкинг и **LLM-задачи**. Три способа настройки — в порядке приоритета:

| Приоритет | Источник | Пример |
|---|---|---|
| 1 (высший) | Переменная окружения | `LLM_EXTRACTION_MODEL=deepseek-v4-flash` |
| 2 | `retaindb.config.json` | `{ "llm": { "tasks": { ... } } }` |
| 3 (низший) | Значение по умолчанию | `gpt-4o-mini` |

---

## Модель LLM: мультипровайдер

Главная идея: **каждая задача имеет свою модель + ключ + URL**. Разные задачи могут использовать разных провайдеров независимо.

```
┌─────────────────────────────────────────────────────────────┐
│  llm                                                        │
│  ├── default (OPENAI_API_KEY / OPENAI_BASE_URL)  ← фолбэк   │
│  └── tasks:                                                  │
│       ├── extraction:  { model, apiKey, baseUrl }           │
│       ├── rerank:      { model, apiKey, baseUrl }           │
│       ├── dialectic:   { model, apiKey, baseUrl }           │
│       ├── compressor:  { model, apiKey, baseUrl }           │
│       ├── oracle:      { model, apiKey, baseUrl }           │
│       └── ... (18 задач)                                    │
└─────────────────────────────────────────────────────────────┘
```

### Fallback-цепочка для каждой задачи

```
task.model   = LLM_<TASK>_MODEL      → tasks.<task>.model    → дефолт
task.apiKey  = LLM_<TASK>_API_KEY    → tasks.<task>.apiKey   → default.apiKey
task.baseUrl = LLM_<TASK>_BASE_URL   → tasks.<task>.baseUrl  → default.baseUrl
```

Если у задачи не задан `apiKey`/`baseUrl` — наследуются из `default` (глобальные `OPENAI_API_KEY` / `OPENAI_BASE_URL`).

### Все 18 LLM-задач

| Задача | Дефолт модели | Что делает |
|---|---|---|
| `extraction` | `gpt-4o-mini` | Извлечение памяти и сущностей |
| `memoryExtraction` | `gpt-5.4-mini` | SOTA-экстракция памяти (`EXTRACTOR_MODEL`) |
| `queryExpansion` | `gpt-4o-mini` | Переформулировка поискового запроса |
| `rerank` | `gpt-4o-mini` | LLM-реранкинг результатов |
| `sourceProfile` | `gpt-4o-mini` | Профиль источника (бренд, темы) |
| `compressor` | `gpt-4o-mini` | Сжатие контекста |
| `oracle` | `gpt-4o` | Oracle scope-selection |
| `synthesis` | `gpt-4o-mini` | Синтез ответа (`SYNTHESIS_MODEL`) |
| `pageExtractor` | `gpt-4o-mini` | Извлечение данных из HTML |
| `researchAgent` | `gpt-4o` | Research-агент |
| `taskRunner` | `gpt-4o` | Браузерный agent-task runner |
| `videoStt` | `gpt-4o-mini-transcribe` | Транскрибация видео |
| `consolidation` | `gpt-5.4-mini` | Консолидация памяти |
| `dialectic` | `gpt-5.4-mini` | Диалектический Q&A по памяти |
| `inference` | `gpt-5.4-mini` | LLM-inference фолбэк |
| `sessionSummary` | `gpt-5.4-mini` | Суммаризация сессии |
| `relation` | `gpt-5.4-mini` | Детекция связей между memory |
| `temporal` | `gpt-5.4-mini` | Темпоральное рассуждение |

---

## Быстрый старт

### Минимальный запуск (всё локально, без API-ключей)

```bash
cd Margo
pnpm install
pnpm dev:server
```

Сервер на `:3000`, `EMBEDDING_MODE=remote`. Без `EMBEDDING_INFERENCE_BASE_URL` эмбеддинг упадёт на первый запрос — подними embedding-server или переключи режим.

### Локальный эмбеддинг (BGE-large, бесплатно)

```bash
# Терминал 1: embedding-server
cd packages/server
npx tsx src/embedding-server.ts   # → :8080, Xenova/bge-large-en-v1.5

# Терминал 2: сервер
EMBEDDING_MODE=remote \
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080 \
pnpm dev:server
```

### Один провайдер на всё (DeepSeek)

```bash
EMBEDDING_MODE=remote \
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080 \
OPENAI_API_KEY=sk-... \
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
LLM_EXTRACTION_MODEL=deepseek-v4-flash \
LLM_RERANK_MODEL=deepseek-v4-flash \
LLM_RERANK_MAX_TOKENS=500 \
LLM_EXTRACTION_MAX_TOKENS=1500 \
pnpm dev:server
```

### Мультипровайдер (разные провайдеры на разные задачи)

```bash
# extraction и rerank → DeepSeek, dialectic → OpenAI, остальное → дефолт
OPENAI_API_KEY=sk-openai... \
OPENAI_BASE_URL=https://api.openai.com/v1 \
LLM_EXTRACTION_MODEL=deepseek-v4-flash \
LLM_EXTRACTION_API_KEY=sk-deepseek... \
LLM_EXTRACTION_BASE_URL=https://api.deepseek.com/v1 \
LLM_RERANK_MODEL=deepseek-v4-flash \
LLM_RERANK_API_KEY=sk-deepseek... \
LLM_RERANK_BASE_URL=https://api.deepseek.com/v1 \
pnpm dev:server
```

> ⚠️ DeepSeek v4 — reasoning-модели. `max_tokens` включает reasoning + content. Для extraction нужно ≥800, для reranking ≥300.

---

## Конфигурация через `retaindb.config.json`

```json
{
  "embedding": {
    "mode": "remote",
    "model": "Xenova/bge-large-en-v1.5",
    "embeddingInferenceBaseUrl": "http://localhost:8080",
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
    "budgetMs": 90,
    "llmEnabled": false,
    "llmMinBudgetMs": 75,
    "llmMaxCandidates": 5,
    "maxCandidates": 20,
    "llmMaxTokens": 200
  },
  "llm": {
    "default": {
      "apiKey": "sk-openai...",
      "baseUrl": "https://api.openai.com/v1"
    },
    "tasks": {
      "extraction": {
        "model": "deepseek-v4-flash",
        "apiKey": "sk-deepseek...",
        "baseUrl": "https://api.deepseek.com/v1"
      },
      "rerank": {
        "model": "deepseek-v4-flash",
        "apiKey": "sk-deepseek...",
        "baseUrl": "https://api.deepseek.com/v1"
      },
      "dialectic": {
        "model": "gpt-4o"
      },
      "compressor": {
        "model": "gpt-4o-mini"
      }
    }
  }
}
```

- `default` — глобальный фолбэк ключа/URL
- `tasks.<name>` — конфиг конкретной задачи
- Если у задачи нет `apiKey`/`baseUrl` → берётся из `default`
- Если у задачи нет `model` → дефолт из таблицы выше

---

## Все переменные окружения

### LLM (мультипровайдер)

Глобальные:

| Переменная | Описание |
|---|---|
| `OPENAI_API_KEY` | Глобальный ключ (фолбэк для всех задач) |
| `OPENAI_BASE_URL` | Глобальный URL (фолбэк для всех задач) |

Per-task (для каждой из 18 задач, `<TASK>` = имя задачи в UPPER_SNAKE):

| Переменная | Описание |
|---|---|
| `LLM_<TASK>_MODEL` | Модель для задачи (напр. `LLM_EXTRACTION_MODEL`) |
| `LLM_<TASK>_API_KEY` | Ключ для задачи (напр. `LLM_RERANK_API_KEY`) |
| `LLM_<TASK>_BASE_URL` | URL для задачи (напр. `LLM_DIALECTIC_BASE_URL`) |

Пример: `LLM_EXTRACTION_MODEL`, `LLM_EXTRACTION_API_KEY`, `LLM_EXTRACTION_BASE_URL`, `LLM_RERANK_MODEL`, `LLM_RERANK_API_KEY`, `LLM_RERANK_BASE_URL`, ...

Legacy-псевдонимы (SOTA-модели, по-прежнему работают):

| Переменная | Задача |
|---|---|
| `EXTRACTOR_MODEL` | `memoryExtraction` |
| `CONSOLIDATION_MODEL` | `consolidation` |
| `DIALECTIC_MODEL` | `dialectic` |
| `INFERENCE_MODEL` | `inference` |
| `SESSION_SUMMARY_MODEL` | `sessionSummary` |
| `RELATION_MODEL` | `relation` |
| `TEMPORAL_MODEL` | `temporal` |
| `SYNTHESIS_MODEL` | `synthesis` |
| `VIDEO_STT_MODEL` | `videoStt` |

### Extraction

| Переменная | По умолчанию | Описание |
|---|---|---|
| `EXTRACTION_MODE` | `per_type` | `pattern` — regex без LLM (local); `per_type` — pattern + одиночный LLM-inference (текущее поведение); `one_pass` — pattern + schema-driven одиночный LLM-вызов по всем типам памяти (ADR-002) |

### Consolidation

| Переменная | По умолчанию | Описание |
|---|---|---|
| `CONSOLIDATION_MODE` | `basic` | `basic` — dedup + decay; `dreamer` — basic + inductive reasoning + peer-card (требует LLM-ключ); `off` — без консолидации (ADR-003) |

### Embedding

| Переменная | По умолчанию | Описание |
|---|---|---|
| `EMBEDDING_MODE` | `remote` | `openai` \| `gemini` \| `local` \| `hybrid` \| `remote` \| `workers` |
| `EMBEDDING_MODEL` | `Xenova/bge-large-en-v1.5` | Модель для embedding-server |
| `EMBEDDING_LOCAL_MODEL` | `Xenova/bge-large-en-v1.5` | Модель локального in-process режима |
| `EMBEDDING_INFERENCE_BASE_URL` | — | URL remote-сервиса (приоритет 1) |
| `EMBEDDING_BASE_URL` | — | URL remote-сервиса (приоритет 2) |
| `INFERENCE_BASE_URL` | — | Общий URL embed+rerank (приоритет 3) |
| `INFERENCE_API_URL` | — | Общий URL (приоритет 4) |
| `INFERENCE_API_KEY` | — | Bearer-токен remote-сервиса |
| `RETAINDB_INFERENCE_KEY` | — | Альтернативное имя ключа |
| `INFERENCE_TIMEOUT_MS` | `2500` | Таймаут HTTP к remote |
| `REMOTE_INFERENCE_REQUIRED` | `false` | Падать при недоступности remote |
| `LARGE_BATCH_THRESHOLD` | `20` | Батчи больше → OpenAI/Gemini |
| `EMBEDDING_MAX_BATCH_SIZE` | `64` | Лимит embedding-server |
| `EMBEDDING_MAX_CONCURRENCY` | `2` | Макс. одновременных запросов |
| `EMBEDDING_CACHE_FILE` | `.embedding-cache.json` | Файл кэша эмбеддингов |
| `GEMINI_EMBEDDING_DIMENSIONS` | `768` | Размерность Gemini |
| `GOOGLE_API_KEY` | — | Ключ Gemini |
| `LLM_EXTRACTION_MAX_TOKENS` | `800` | max_tokens для extraction |

### Reranking

| Переменная | По умолчанию | Описание |
|---|---|---|
| `RERANK_MODE` | `balanced` | `balanced` \| `cross-encoder` \| `llm` |
| `RERANK_PROVIDER` | `local` | `local` \| `remote` |
| `RERANK_INFERENCE_BASE_URL` | — | URL remote-реранкера |
| `RERANK_BASE_URL` | — | URL remote-реранкера (приоритет 2) |
| `LLM_RERANK_ENABLED` | `false` | LLM-fallback в balanced |
| `RERANK_BUDGET_MS` | `90` | Бюджет времени |
| `LLM_RERANK_MIN_BUDGET_MS` | `75` | Остаток для LLM-fallback |
| `LLM_RERANK_MAX_CANDIDATES` | `5` | Макс. кандидатов LLM-реранкера |
| `LLM_RERANK_MAX_TOKENS` | `200` | max_tokens реранкинга |
| `MAX_RERANK_CANDIDATES` | `20` | Макс. кандидатов на вход |

### Локальный режим

| Переменная | По умолчанию | Описание |
|---|---|---|
| `RETAINDB_EMBEDDING_PROVIDER` | `hash` | `hash` \| `local-transformers` |
| `RETAINDB_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Модель локального режима |

---

## Режимы эмбеддинга

| Режим | Что использует | Ключ |
|---|---|---|
| `openai` | `text-embedding-3-small` (1024-dim) | `OPENAI_API_KEY` |
| `gemini` | `text-embedding-004` (до 768-dim) | `GOOGLE_API_KEY` |
| `local` | BGE-large in-process (1024-dim) | — |
| `hybrid` | local (≤20) + OpenAI (>20) | `OPENAI_API_KEY` |
| `remote` | Любой HTTP-сервис | `INFERENCE_API_KEY` |

⚠️ Смена размерности (OpenAI 1024 → Gemini 768) требует реиндексации.

## Режимы реранкинга

| Режим | Что использует |
|---|---|
| `cross-encoder` | BGE-reranker-large (локально, бесплатно) |
| `llm` | LLM (модель из `llm.tasks.rerank`) |
| `balanced` | cross-encoder + LLM-fallback (confidence < 0.85) |
| `remote` | Любой HTTP-сервис |

---

## DeepSeek: особенности

DeepSeek v4 (pro/flash) — **reasoning-модели**. `max_tokens` = reasoning + content.

| Операция | OpenAI default | DeepSeek recommendation |
|---|---|---|
| Extraction | `800` | `1500` |
| Reranking | `200` | `500` |

Пример `.env` для DeepSeek (всё на одном провайдере):

```bash
EMBEDDING_MODE=remote
EMBEDDING_INFERENCE_BASE_URL=http://localhost:8080
OPENAI_API_KEY=sk-deepseek...
OPENAI_BASE_URL=https://api.deepseek.com/v1
LLM_EXTRACTION_MODEL=deepseek-v4-flash
LLM_RERANK_MODEL=deepseek-v4-flash
LLM_EXTRACTION_MAX_TOKENS=1500
LLM_RERANK_MAX_TOKENS=500
```

---

## Embedding-server (standalone)

```bash
cd packages/server
PORT=8080 npx tsx src/embedding-server.ts
```

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Статус, модель, лимиты |
| `POST` | `/v1/inference/embeddings` | Эмбеддинг текстов |

```bash
PORT=8080                                # порт
EMBEDDING_MODEL=Xenova/bge-large-en-v1.5  # модель
EMBEDDING_MAX_BATCH_SIZE=64              # макс. текстов/запрос
EMBEDDING_MAX_CONCURRENCY=2              # макс. параллельных запросов
INFERENCE_API_KEY=secret                 # Bearer-авторизация
```

---

## Запуск тестов

```bash
pnpm install
pnpm run test                 # все пакеты

pnpm --filter @retaindb/server test   # 235 тестов
pnpm --filter @retaindb/local test    # 80 тестов
pnpm --filter @retaindb/sdk test      # 31 тест
```

E2E:

```bash
# мультипровайдерный конфиг + реальный LLM-вызов
cd packages/server
OPENAI_API_KEY=... OPENAI_BASE_URL=https://api.deepseek.com/v1 \
LLM_EXTRACTION_MODEL=deepseek-v4-flash \
node --import tsx/esm src/e2e-llm-provider.ts
```

Подробнее в [TESTING.md](./TESTING.md).
