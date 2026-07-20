# ADR-005: Knowledge → Skill pipeline (Hypothesis)

**Status**: Proposed (Hypothesis)
**Date**: 2026-07-20
**Deciders**: opencode + dspilarov

## Context

Margo хранит 13 типов памяти включая `procedure` — повторяемые последовательности действий (деплой, фикс линтера, PR). Сейчас procedure-память используется пассивно: агент ищет её при запросе. Но если procedure повторяется N раз с высоким success_rate, она по сути становится **скиллом** — исполняемой процедурой с доказанной эффективностью.

Hermes (и любой агент с tool-use) может автоматизировать цепочку:

```
Сырые сессии → Margo extraction → procedure-память →
Dreamer inductive pass → skill_candidate →
Margo Skill Registry → tool definition для агента →
Feedback loop → reinforcement/decay скилла
```

## Decision (Hypothesis)

**Margo должен уметь превращать procedure-память в скиллы через цикл: обнаружение → верификация → экспорт → обратная связь → усиление.**

Компоненты:

| Компонент | Что делает | Когда |
|---|---|---|
| **Skill candidate detection** | Dreamer находит procedure с confidence ≥0.85 и evidence_count ≥5 → `skill_candidate: true` | Phase 2 (ADR-003) |
| **Skill Registry** | Хранилище procedure→skill: confidence, evidence_count, success_rate, tools_used | Phase 4 |
| **`GET /v1/skills/candidates`** | Отдать все procedure, готовые стать скиллами | Phase 4 |
| **`POST /v1/skills/:id/feedback`** | Агент сообщает: скилл сработал/провалился → обновить success_rate | Phase 4 |
| **`GET /v1/skills/:id/export`** | Экспорт скилла как tool definition (JSON Schema) для Hermes/Codex/OpenCode | Phase 4 |
| **Reinforcement loop** | success_rate ↑ → confidence ↑; success_rate ↓ → decay, пометка `deprecated` | Phase 4 |

## Open questions

- Пороги confidence/evidence: 0.85/5 — оптимальны? Нужны A/B-тесты.
- Формат tool definition: JSON Schema для Hermes? MCP tool definition? Универсальный?
- Feedback loop: только success/failure или еще duration_ms, tokens_used?
- Deprecation: при каком success_rate скилл считается «разученным»?

## Relation to other ADRs

- ADR-002 (One-pass extraction): procedure извлекается качественнее → больше кандидатов
- ADR-003 (Dreamer): inductive pass находит повторяющиеся procedure → skill_candidate
- ADR-004 (Progressive context): L0 peer-card включает "top skills" пользователя
