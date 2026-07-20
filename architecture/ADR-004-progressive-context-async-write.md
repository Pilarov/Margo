# ADR-004: Progressive context delivery + async write path

**Status**: Proposed
**Date**: 2026-07-20
**Deciders**: opencode + dspilarov

## Context

Сейчас Margo доставляет контекст агенту через `POST /v1/context/pack` — плоский набор результатов, обрезанных до `token_budget`. Агент получает всё сразу или ничего.

Проблемы:
1. **Плоский — нет приоритизации**: важная preference и шумный лог сборки занимают одинаковые токены.
2. **Нет progressive disclosure**: агент не может запросить «только summary» или «детали по вот этому документу».
3. **Sync write path**: в server-режиме запись ждёт extraction+embedding+relations (latency до нескольких секунд).

VikingMem решает первое и второе через L0/L1/L2 (abstract → overview → full document). Honcho решает третье через async write (запись мгновенная → reasoning в очереди).

## Decision

### Progressive disclosure

```
CONTEXT_MODE=flat         # Текущее поведение (обрезать до token_budget)
CONTEXT_MODE=progressive  # L0 всегда, L1/L2 по запросу
```

**L0 (abstract)** — ~100 токенов. Автоматически включается в каждый context pack.
Генерируется при создании memory из первых N слов контента + типа памяти + importance.

**L1 (overview)** — ~2k токенов. Структура: поля, связи, временной контекст.
Отдаётся по `include_overview: true` или при `token_budget > 500`.

**L2 (full)** — полный контент memory/chunk.
Отдаётся по прямому запросу: `GET /v1/context/pack/:id/full`.

### Async write path (server only)

```
POST /v1/memory (sync)
  ↓
validate → persist (быстро) → return 202 Accepted { id, status: "pending" }
  ↓
[async queue]
  embed → extract_relations → consolidate → status: "ready"
```

Клиент может опрашивать: `GET /v1/memory/:id` → `{ status: "pending" | "ready" | "failed" }`.

Local-режим остаётся синхронным (нет очереди). Конфиг:

```
WRITE_MODE=sync           # Текущее поведение, local default
WRITE_MODE=async          # Server only, требует Redis/очередь
```

## Alternatives Considered

### Option A: Только progressive disclosure (без async write)
- **Pros**: Меньше scope, проще
- **Cons**: Основной источник latency — extraction/embedding — не решён
- **Why rejected**: Progressive без async — косметика. Настоящая проблема в latency записи.

### Option B: Только async write (без progressive disclosure)
- **Pros**: Решает latency записи
- **Cons**: Контекст всё ещё плоский, агент получает шум
- **Why rejected**: Оба улучшения ортогональны и решают разные проблемы. Делаем оба.

## Consequences

### Positive
- **Latency записи**: sync: 2-5 секунд → async: <100ms (только validate+persist)
- **Токен-бюджет**: L0 (100 токенов) вместо полного контента → 10-50× экономия
- **Гибкость**: агент сам решает, когда запрашивать L1/L2

### Negative
- **Сложность**: два режима записи (sync/async), два режима контекста (flat/progressive)
- **Консистентность**: async — memory видна не сразу (status: pending)
- **Отладка**: async ошибки не видны клиенту сразу

### Neutral
- **Конфиг**: +2 env var (`CONTEXT_MODE`, `WRITE_MODE`)
- **API**: новый эндпоинт `GET /v1/context/pack/:id/full` для L2

## Compliance

- Тест: `CONTEXT_MODE=flat` — те же результаты, что и текущий context pack (регрессия)
- Тест: `CONTEXT_MODE=progressive` — L0 ≤200 токенов, L1 ≤3000 токенов
- Тест: `WRITE_MODE=async` — `POST /v1/memory` возвращает 202, статус меняется с pending на ready в течение 30 секунд
