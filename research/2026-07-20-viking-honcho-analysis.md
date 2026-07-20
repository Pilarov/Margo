# Research: Viking (VikingMem/OpenViking) vs Honcho vs Margo

**Date**: 2026-07-20
**Goal**: Детальный анализ архитектуры Viking и Honcho — как они работают, сравнение с Margo (RetainDB)
**Time box**: 30 min (large)

## Sources

- VikingMem paper: arXiv:2605.29640 (VLDB 2026, ByteDance)
- OpenViking: github.com/volcengine/OpenViking
- Honcho: honcho.dev, github.com/plastic-labs/honcho
- Mem0 vs Honcho comparison: mem0.ai/blog

---

## 1. VikingMem / OpenViking (ByteDance)

### Что это

VikingMem — облачная Memory Base Management System, построенная поверх **VikingDB** (векторная БД ByteDance). OpenViking — open-source подмножество.

### Архитектура

```
[Agent] → VikingMem API
              ├── Memory Extraction (one-pass LLM)
              ├── Memory Management (event → entity operators)
              └── Memory Retrieval (hybrid: vector + keyword graph)
                        ↓
                   VikingDB (векторный движок)
                        ├── AGFS (Agent Filesystem)
                        └── Vector Index
```

### Ключевая инновация: Event-Entity модель

В отличие от традиционных систем (где каждый тип памяти = отдельный prompt + отдельный LLM-вызов), VikingMem использует **one-pass экстракцию**:

```
Традиционно:
  prompt_factual → LLM → factual memories   \
  prompt_preference → LLM → preferences       } N вызовов LLM = N × токены
  prompt_decision → LLM → decisions          /

VikingMem:
  schema { events: [...], entities: [...] } → LLM (один вызов) → все типы памяти
```

**Event** = структурированная запись о событии (извлекается по схеме из сырых данных).
**Entity** = состояние, которое обновляется событиями через **операторы**:

| Оператор | Что делает |
|---|---|
| `SUM` | Накапливает числовые значения |
| `AVG` | Усредняет |
| `LLM_MERGE` | Сливает текстовые обновления через LLM |
| `TIME_COMPRESS` | Сжимает старые записи в summary по топикам с временными весами |

Пример: entity «UserPreferences» обновляется событиями «User chose dark mode», «User switched to TypeScript» → `LLM_MERGE` → «User prefers dark mode, TypeScript for new projects».

### Хранилище: AGFS (Agent Filesystem)

Файловая парадигма для контекста:

```
viking://resources/docs/auth/
├── .abstract.md          # L0: краткое summary (~100 токенов)
├── .overview.md          # L1: структура (~2k токенов)
├── oauth.md              # L2: полный документ
├── jwt.md
└── .relations.json       # Граф связей
```

Три уровня progressive disclosure: агент сначала видит L0 → если нужно, запрашивает L1 → L2. Экономит токены.

Векторный индекс: `TYPE_PATH` вместо plain-text path — можно искать по поддереву (`viking://user/memories/*`) без фильтрации строк.

### Плюсы

- **One-pass extraction** — один вызов LLM для всех типов памяти (экономия токенов в N раз)
- **Schema-driven** — не hardcoded prompts, а декларативные схемы событий/сущностей
- **Progressive disclosure** — L0/L1/L2 уровни контекста для экономии токенов
- **Entity operators** — `LLM_MERGE`, `TIME_COMPRESS` для эволюции состояния
- **Production-grade** — используется внутри ByteDance (TikTok, etc.)

### Минусы

- **VikingDB — проприетарный** (OpenViking — только подмножество)
- **Cloud-native** — завязан на инфраструктуру ByteDance
- **Сложность** — schema-driven подход требует настройки схем под каждый use-case
- **Нет локального режима** — только облако

### Стек

- Python (OpenViking SDK)
- VikingDB (векторная БД, проприетарная)
- AGFS (файловая система)
- LLM для экстракции (provider-agnostic)

---

## 2. Honcho (Plastic Labs)

### Что это

Honcho — open-source библиотека памяти с managed-сервисом. Строит **representations** (представления) пиров (peers) через непрерывное reasoning.

### Архитектура

```
[Agent] → Honcho API (FastAPI)
              ├── Write path (sync):  сохраняет сообщение, ставит задачу в очередь → ответ сразу
              └── Query path (sync): Dialectic agent — ищет в выводах, синтезирует ответ
                   ↓
              Redis (очередь задач)
                   ↓
              Deriver Worker (async, uvloop)
                   ├── Deriver:     читает сообщения → извлекает выводы о пире
                   ├── Summarizer:  каждые 20/60 сообщений → short/long summary сессии
                   └── Dreamer:     раз в ~8 часов → dedup, merge, inductive выводы
                        ↓
                   PostgreSQL + pgvector
                        ├── Workspaces, Peers, Sessions, Messages
                        ├── Collections (векторные выводы)
                        └── Embeddings
```

### Ключевые компоненты

#### Deriver («Извлекатель»)
- Читает каждое сообщение, извлекает **выводы** (conclusions) о пире
- Два типа: **explicit** (прямые утверждения: «я люблю Python») и **deductive** (логические выводы)
- Batch-обработка: экономичнее, чем per-message
- Structured output через LLM (не agentic tool loop)

#### Dialectic («Диалектик»)
- Отвечает на запросы о пире: «что этот пользователь предпочитает?», «как он обычно решает проблему X?»
- 5 уровней reasoning: minimal → low → medium → high → max
- Inline (синхронный) — выполняется во время запроса
- Ищет в коллекциях выводов, подтягивает supporting messages, синтезирует ответ

#### Dreamer («Сновидец»)
- Периодический (каждые ~8 часов)
- Удаляет устаревшие/противоречивые выводы
- Объединяет дубликаты
- Строит индуктивные выводы (паттерны через много сообщений)
- Обновляет **peer card** — компактную биографию пира

#### Summarizer
- Каждые 20 сообщений → short summary сессии
- Каждые 60 сообщений → long summary (рекурсивно включает предыдущий summary)

### Модель данных: Peer-centric

```
Workspace
  ├── Peer (человек ИЛИ агент — единая абстракция)
  │     └── Representation (выводы Deriver + Dreamer)
  ├── Session (может включать несколько Peers)
  │     └── Messages (упорядоченные, с метаданными)
  └── Collections (векторное хранилище выводов)
```

Peers симметричны: человек и агент — одинаковые сущности. Можно моделировать multi-agent, group chat, user↔agent, agent↔agent.

### Стек

- Python (FastAPI + uvloop)
- PostgreSQL + pgvector
- Redis (очередь)
- LLM: Gemini (deriver/default), Anthropic (dialectic high/dream), OpenAI (embeddings)
- Конфиг: TOML-файл + env vars

### Плюсы

- **Async write path** — запись мгновенная, reasoning в фоне
- **Peer-centric** — человек и агент симметричны → естественно для multi-agent
- **Deriver + Dreamer** — память не просто растёт, а эволюционирует (dedup, merge, inductive)
- **5 уровней Dialectic** — от дешёвого (Gemini) до глубокого (Claude Opus)
- **Self-hosted** — можно развернуть на своей инфраструктуре
- **Provider-agnostic** — Gemini/Anthropic/OpenAI на выбор

### Минусы

- **Требует PostgreSQL + Redis** — больше инфраструктуры, чем Margo Local
- **Python-стек** — не TypeScript (если стек агентов на TS)
- **Нет локального режима без БД** — только полноценный сервер
- **Нет файлового контекста** — только память о людях/агентах, не индексирует код/документы
- **Conversation-centric** — фокус на диалогах, меньше на knowledge base

---

## 3. Сравнение: Viking vs Honcho vs Margo

| Измерение | VikingMem | Honcho | Margo (наш) |
|---|---|---|---|
| **Экстракция** | One-pass schema-driven (1 вызов LLM на все типы) | Deriver per-batch (выводы из сообщений) | Pattern-based + LLM (write.ts) |
| **Модель памяти** | Event → Entity (события обновляют сущности) | Peer → Representation (выводы о пире) | Memory (13 типов) → Scope (6 уровней) |
| **Эволюция** | `TIME_COMPRESS`, `LLM_MERGE` операторы | Dreamer (dedup, merge, inductive) | Consolidation (dedup, decay, session rollup) |
| **Поиск** | Hybrid: vector + keyword graph + TYPE_PATH | Dialectic (semantic + LLM synthesis) | BM25 + vector + graph RRF + reranking |
| **Хранилище** | VikingDB (проприетарное) | PostgreSQL + pgvector | JSON-файл (local) / PostgreSQL+pgvector (server) |
| **Локальный режим** | Нет (cloud-only) | Нет (нужен PG+Redis) | Да (один JSON-файл, без БД) |
| **Коннекторы** | Filesystem (AGFS) | Нет (только диалоги) | 20+ коннекторов (GitHub, Slack, PDF, etc.) |
| **Эмбеддеры** | Встроен в VikingDB | OpenAI (embeddings) | 6 провайдеров (OpenAI, Gemini, BGE, remote, hash, hybrid) |
| **Язык** | Python | Python | TypeScript |
| **Лицензия** | Проприетарная (OpenViking — Apache 2.0 subset) | MIT | Apache 2.0 / BSL |
| **Тесты** | Неизвестно | Неизвестно | 302 теста |

---

## 4. Идеи для Margo из конкурентов

### Из VikingMem

1. **One-pass extraction** — один LLM-вызов для извлечения всех типов памяти одновременно (экономия токенов). Сейчас Margo делает это через pattern-based + отдельный LLM-вызов.
2. **Progressive disclosure (L0/L1/L2)** — для context pack: сначала summary, потом структура, потом полный контент.
3. **Entity operators** — `LLM_MERGE`, `TIME_COMPRESS` как декларативные операторы обновления памяти.

### Из Honcho

1. **Dreamer** — периодическая консолидация: dedup противоречий, inductive выводы через паттерны. У Margo есть consolidation, но без inductive reasoning.
2. **Peer-card** — компактная биография пользователя/агента (сейчас у Margo есть profile, но без авто-генерации карточки).
3. **Async write path** — запись мгновенная, reasoning в фоне (сейчас Margo делает часть синхронно).
4. **Dialectic levels** — уровни глубины reasoning для разных бюджетов (сейчас Margo использует один extraction model).

---

## Recommendation

**Не внедрять сейчас.** Обе системы решают ту же задачу, но с другими компромиссами:

- VikingMem силён в schema-driven extraction и масштабе (ByteDance), но проприетарен
- Honcho силён в peer-centric reasoning и эволюции памяти, но требует PG+Redis

Margo выигрывает в:
- **Локальном режиме** (один JSON-файл, ноль зависимостей)
- **Коннекторах** (20+ источников против 0 у Honcho)
- **Гибкости эмбеддинга** (6 провайдеров)
- **TypeScript-стеке** (естественно для JS/TS агентов)

**Что стоит взять**: one-pass extraction (из Viking) и Dreamer-подобную консолидацию (из Honcho) — в бэклог.
