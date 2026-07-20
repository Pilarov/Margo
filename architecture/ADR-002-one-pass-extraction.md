# ADR-002: One-pass memory extraction

**Status**: Proposed
**Date**: 2026-07-20
**Deciders**: opencode + dspilarov

## Context

Сейчас Margo извлекает память двумя путями:
- **Pattern-based** (local, дефолт): regex-паттерны по типам памяти. Бесплатно, быстро, но ограниченно.
- **LLM extraction** (server): один вызов `gpt-4o-mini` на извлечение одного memory_type.

Проблема: для извлечения N типов памяти из одного текста нужно N вызовов LLM. Это N × токены, N × latency.

VikingMem (ByteDance, VLDB 2026) решает это через **one-pass extraction**: одна схема со всеми типами → один LLM-вызов → структурированный вывод со всеми memory сразу. Экономия: N× по токенам и latency.

Margo должен сохранить оба пути: pattern-based без LLM для local-режима, и one-pass LLM для server-режима (опционально).

## Decision

**Добавить `EXTRACTION_MODE` в конфиг с тремя режимами: `pattern` (local, дефолт), `one_pass` (один LLM-вызов), `per_type` (текущее поведение, обратная совместимость).**

```
EXTRACTION_MODE=pattern    # Regex, без LLM, local default
EXTRACTION_MODE=per_type   # N вызовов LLM (текущее поведение)
EXTRACTION_MODE=one_pass   # 1 вызов LLM, schema-driven (новое)
```

В режиме `one_pass`:
1. Генерируется extraction-схема из списка `MemoryType` (13 типов)
2. Один LLM-вызов с промптом: «извлеки из текста все типы памяти: preference, decision, factual, ...»
3. Ответ парсится как массив `ExtractedMemory[]`
4. Каждый memory проходит существующий пайплайн валидации (buildValidatorIssues, calibrateWriteConfidence, inferScopeTarget)

Schema-генерация из существующих типов:

```typescript
// Автогенерация промпта из MemoryType
function buildExtractionSchema(types: MemoryType[]): string {
  const typeDescriptions = {
    factual:       "objective facts, technical stack, versions, configurations",
    preference:    "user likes, dislikes, preferences, habits",
    decision:      "choices made, options selected, trade-offs accepted",
    constraint:    "limitations, requirements, must-have or must-not-have rules",
    instruction:   "procedures, workflows, commands to follow",
    goal:          "objectives, targets, desired outcomes",
    event:         "things that happened with timestamps",
    correction:    "fixes to previous statements, updates, deprecations",
    opinion:       "subjective judgments, evaluations, assessments",
    relationship:  "connections between people, teams, tools, concepts",
    solution:      "resolved problems, implemented fixes, working approaches",
    project_state: "status of project, milestones, current phase",
    workflow:      "repeatable processes, pipelines, automation steps",
  };
  // → один LLM-промпт со всеми типами и их описаниями
}
```

Fallback: если one-pass LLM недоступен (нет ключа, ошибка) → автоматически переключается на `pattern`.

## Alternatives Considered

### Option A: Только one-pass (убрать pattern-based)
- **Pros**: Максимальная точность, один путь в коде
- **Cons**: Зависимость от LLM, не работает в local-режиме без ключа, рост токенов на простых запросах
- **Why rejected**: Local-first требует работы без LLM

### Option B: Multi-pass с кэшированием (сохранить per_type)
- **Pros**: Обратная совместимость, точность под каждый тип
- **Cons**: N × токены, не решает проблему
- **Why rejected**: Сохраняем как fallback, но не как основной путь

## Consequences

### Positive
- **N× меньше LLM-вызовов**: 1 вместо 13 (по числу типов памяти)
- **N× меньше токенов**: промпт с 13 описаниями типов всё равно меньше, чем 13 отдельных промптов
- **Меньше latency**: 1 network round-trip вместо N
- **Обратная совместимость**: `per_type` остаётся, `pattern` — дефолт для local

### Negative
- **Schema maintenance**: при добавлении нового MemoryType нужно обновить описание в schema-генераторе
- **Сложнее дебажить**: один большой промпт → труднее понять, почему конкретный тип не извлёкся

### Neutral
- **Конфиг**: +1 env var `EXTRACTION_MODE`, +1 поле в `retaindb.config.json`

## Compliance

- Тест: один и тот же текст → `pattern` и `one_pass` должны давать непересекающиеся множества memory (разные методы, не дубликаты контента)
- Тест: `per_type` должен давать те же результаты, что и до изменений (регрессия)
- Конфиг: `EXTRACTION_MODE=pattern` в `.env.example` для local, `EXTRACTION_MODE=one_pass` в примере для DeepSeek
