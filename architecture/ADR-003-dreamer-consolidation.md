# ADR-003: Dreamer-style memory consolidation

**Status**: Proposed
**Date**: 2026-07-20
**Deciders**: opencode + dspilarov

## Context

Сейчас consolidation в Margo делает три вещи:
- **Dedup**: Jaccard ≥0.92 → слияние почти одинаковых memory
- **Decay**: memory старше 14 дней без доступа и strength <0.45 → деактивация
- **Session rollup**: группировка memory по сессиям

Этого достаточно для базовой гигиены. Но Honcho (Plastic Labs) делает больше через компонент **Dreamer**:
- **Inductive reasoning**: паттерны через много сессий → «пользователь 5 раз предпочитал X → confidence = 0.95»
- **Разрешение противоречий**: «memory A говорит X, memory B говорит Y → пометить A как outdated»
- **Peer-card**: авто-генерация компактной биографии: «User: TS-разработчик, предпочитает pnpm, деплоит по пятницам»

VikingMem добавляет: `LLM_MERGE` оператор для слияния и `TIME_COMPRESS` для сжатия старых записей с временными весами.

## Decision

**Расширить `consolidate()` тремя опциональными LLM-пассами, управляемыми через `CONSOLIDATION_MODE`:**

```
CONSOLIDATION_MODE=basic     # dedup + decay (текущее, local default)
CONSOLIDATION_MODE=dreamer   # basic + inductive + conflict resolution + peer-card
CONSOLIDATION_MODE=off       # без консолидации
```

### Inductive pass

```
Вход: все active memory пользователя за последние N дней
LLM-промпт: «найди повторяющиеся паттерны в этих memory. Для каждого паттерна: сформулируй обобщённый вывод и confidence»
Выход: новые memory типа "preference"/"decision" с confidence = f(частота_паттерна)

Пример:
  Memory 1: "prefers TypeScript" (session 1)
  Memory 2: "chose TypeScript for new project" (session 3)
  Memory 3: "migrated JS to TS" (session 5)
  → Inductive: "User strongly prefers TypeScript" (confidence: 0.92, derived_from: [id1, id2, id3])
```

### Conflict resolution

```
Вход: пары memory, где jaccard ≥0.7 но sentiment/intent противоречат
LLM-промпт: «эти два утверждения противоречат друг другу? Если да — какое новее/актуальнее?»
Выход: пометить устаревшее как inactive, новое — related_to: old_id, relation: "contradicts"
```

### Peer-card

```
Вход: top-20 memory пользователя, сгруппированные по типу
LLM-промпт: «сгенерируй краткий профиль пользователя на основе этих memory»
Выход: строка ~200 токенов для инъекции в system prompt
```

## Alternatives Considered

### Option A: Полный Dreamer как у Honcho (периодический, раз в 8 часов)
- **Pros**: Зрелая архитектура, проверено в production
- **Cons**: Требует scheduler + очередь + постоянные LLM-вызовы. Не работает в local.
- **Why rejected**: Local-first. Consolidation в Margo запускается вручную (`retaindb consolidate`), так и оставляем.

### Option B: Только inductive (без conflict resolution и peer-card)
- **Pros**: Меньше scope, проще реализовать
- **Cons**: Без conflict resolution память накапливает противоречия. Peer-card — самый полезный для агентов артефакт.
- **Why rejected**: Все три пасса взаимодополняющие. Делать по одному — дольше, а не проще.

## Consequences

### Positive
- **Качество памяти**: inductive находит скрытые паттерны, conflict resolution чистит противоречия
- **Контекст для агента**: peer-card — готовая инъекция в system prompt (~200 токенов)
- **Опциональность**: всё выключено по умолчанию, работает только с LLM-ключом
- **Совместимость**: `basic` = текущее поведение, ничего не ломается

### Negative
- **LLM-зависимость**: inductive/conflict/peer-card требуют LLM (в local — только basic)
- **Токены**: один inductive pass на пользователя с сотней memory — ~2000 токенов
- **Гонки**: если consolidation и запись происходят одновременно — нужен lock на store

### Neutral
- **Конфиг**: +1 env var `CONSOLIDATION_MODE`, +3 поля в `retaindb.config.json`

## Compliance

- Тест: `basic` режим должен давать те же результаты, что и текущий consolidation (регрессия)
- Тест: `dreamer` с моком LLM — inductive pass создаёт ожидаемые derived memory
- Peer-card: не длиннее 500 токенов (проверка в тесте)
