# ADR-001: Memory lifecycle architecture — extraction, consolidation, delivery

**Status**: Proposed
**Date**: 2026-07-20
**Deciders**: opencode + dspilarov

## Context

Margo (форк RetainDB) имеет работающий пайплайн памяти: pattern-based + LLM extraction → BM25+vector+graph RRF search → consolidation (dedup, decay). Анализ конкурентов (VikingMem/ByteDance, Honcho/PlasticLabs — см. `research/2026-07-20-viking-honcho-analysis.md`) выявил три архитектурных пробела:

1. **Экстракция**: один LLM-вызов на каждый тип памяти. VikingMem делает one-pass по схеме — 1 вызов вместо N. Экономия токенов: N×.
2. **Консолидация**: только dedup+decay. Honcho добавляет inductive reasoning (паттерны через много сессий), разрешение противоречий, авто-генерацию peer-card.
3. **Доставка контекста**: плоская (token budget → обрезка). VikingMem использует progressive disclosure (L0 summary → L1 структура → L2 полный контент).

Философия Margo: local-first (JSON-файл, без БД), pluggable (конфиг-система), dual-mode (local/server). Любое решение должно работать в обоих режимах, с опциональным LLM и без принудительной облачной инфраструктуры.

## Decision

**Пайплайн памяти Margo v2: три стадии с опциональным LLM-усилением на каждой.**

```
СТАДИЯ 1: EXTRACTION           СТАДИЯ 2: CONSOLIDATION        СТАДИЯ 3: DELIVERY
┌──────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────┐
│ Local: pattern-match │    │ Local: dedup + decay     │    │ Local: flat token cut│
│ Server: one-pass LLM │ →  │ Server: + Dreamer pass   │ →  │ Server: L0/L1/L2     │
│   (schema-driven)    │    │   (inductive + merge)    │    │   (progressive)      │
└──────────────────────┘    └──────────────────────────┘    └──────────────────────┘
         │                            │                            │
    LLM опционален               LLM опционален               Без LLM (чистая
    (EXTRACTION_MODE)            (CONSOLIDATION_MODE)         логика токенов)
```

Принципы:
- **Каждая стадия работает без LLM** (local-режим, дефолт)
- **LLM-усиление включается конфигом** (server-режим, опционально)
- **Async write path** — в server-режиме: запись → мгновенный ответ, extraction+consolidation → очередь
- **Progressive disclosure** — в context/pack: L0 всегда, L1/L2 по запросу

## Alternatives Considered

### Option A: Полная замена на VikingMem-подход (schema-driven, one-pass)
- **Pros**: Максимальная экономия токенов, строгая типобезопасность памяти
- **Cons**: Требует schema definition для каждого use-case, ломает pattern-based extraction (который работает бесплатно), cloud-only
- **Why rejected**: Противоречит local-first. Margo должен работать без схем и без LLM.

### Option B: Полная замена на Honcho-подход (peer-centric, async deriver)
- **Pros**: Зрелая архитектура reasoning, peer-card, dialectic
- **Cons**: Требует PostgreSQL + Redis (противоречит local), Python-стек, conversation-centric
- **Why rejected**: Margo шире, чем диалоги (код, документы, knowledge bases). Нельзя терять коннекторы.

### Option C: Ничего не менять (оставить как есть)
- **Pros**: Работает, просто, без рисков
- **Cons**: Отстаём от конкурентов по токен-эффективности, consolidation слабый, context delivery плоский
- **Why rejected**: Окно возможностей закрывается. Конкуренты уже внедряют one-pass и progressive disclosure.

## Consequences

### Positive
- **Экономия токенов**: one-pass extraction → N× меньше LLM-вызовов на extraction
- **Качество памяти**: Dreamer consolidation → меньше дубликатов, inductive паттерны, peer-card
- **Токен-бюджет**: progressive disclosure → агент получает L0 всегда (~100 токенов), L1/L2 только когда нужно
- **Async writes**: server-режим — запись не ждёт LLM, latency падает
- **Обратная совместимость**: все изменения — опциональные флаги в конфиге, старый пайплайн работает как раньше

### Negative
- **Сложность конфига**: +3 режима (EXTRACTION_MODE, CONSOLIDATION_MODE, CONTEXT_MODE)
- **Два пути в коде**: local (без LLM) и server (с LLM) — нужно тестировать оба
- **Async write**: сообщения об ошибках extraction приходят не сразу — нужен retry + dead letter

### Neutral
- **Schema definition**: для one-pass extraction нужна схема типов памяти. Можно автогенерировать из существующих MemoryType.
- **Peer-card**: новая сущность в модели данных (опциональная)

## Compliance

- Каждая стадия — отдельный модуль с конфигом: `extractionMode`, `consolidationMode`, `contextMode`
- Тесты: local-путь (без LLM) всегда обязателен, server-путь (с LLM) — с моками
- `retaindb.config.json` — примеры всех трёх режимов в `.env.example`
- ADR обновляется при изменении схемы extraction или consolidation

## План реализации

### Phase 1: One-pass extraction (ADR-002)
1. `extractionMode: "pattern" | "one_pass"` в config.ts
2. Schema-генератор из существующих MemoryType → extraction prompt
3. Один LLM-вызов вместо N
4. Fallback: pattern-based, если LLM недоступен

### Phase 2: Dreamer consolidation (ADR-003)
1. `consolidationMode: "basic" | "dreamer"` в config.ts
2. Inductive pass: паттерны через N сессий → повышение confidence
3. Peer-card: авто-генерация профиля
4. Запуск: по расписанию (как существующий consolidation)

### Phase 3: Progressive disclosure + Async write (ADR-004)
1. `contextMode: "flat" | "progressive"` в config.ts
2. L0 (.abstract) из метаданных памяти, L1 (.overview) из search results, L2 (full) по запросу
3. Async extraction+consolidation в server-режиме через очередь
