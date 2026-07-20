# Margo v2: Memory Lifecycle Architecture

**Status**: Proposed (ADR-001–005)
**Date**: 2026-07-20

## Целостное видение

Margo v2 — эволюция пайплайна памяти с опциональным LLM-усилением на каждой стадии. Четыре стадии, четыре конфига, полная обратная совместимость.

```
СТАДИЯ 1: EXTRACTION      СТАДИЯ 2: CONSOLIDATION   СТАДИЯ 3: DELIVERY      СТАДИЯ 4: SKILL [HYPOTHESIS]
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
│Local (pattern)   │   │Local (basic)         │   │Local (flat)      │   │Knowledge → Skill loop   │
│──────────────────│   │──────────────────────│   │──────────────────│   │──────────────────────────│
│• regex patterns  │   │• Jaccard dedup ≥0.92 │   │• token_budget cut│   │• procedure → candidate   │
│• 13 типов памяти │   │• decay >14d, <0.45  │   │• все результаты  │   │• Dreamer: inductive pass │
│• 0 токенов       │   │• session rollup      │   │  сразу           │   │• confidence ≥0.85,       │
│                  │   │• 0 токенов           │   │                  │   │  evidence ≥5            │
│Server (one_pass) │   │Server (dreamer)      │   │Server (progressive│   │• Feedback loop:          │
│──────────────────│   │──────────────────────│   │──────────────────│   │  success_rate ↑↓        │
│• schema-driven   │   │• inductive patterns  │   │• L0 abstract 100t│   │• Export → tool def       │
│• 1 LLM-вызов     │   │• conflict resolution │   │• L1 overview ~2k │   │  (Hermes/Codex/OpenCode) │
│• N× экономия     │   │• peer-card generation│   │• L2 full on-demand│  │                          │
│• ~500 токенов    │   │• skill_candidate flag│   │• 10-50× экономия │   │ADR-005                   │
└──────────────────┘   └──────────────────────┘   └──────────────────┘   └──────────────────────────┘
         │                       │                        │                        │
    EXTRACTION_MODE        CONSOLIDATION_MODE        CONTEXT_MODE           SKILL_MODE
    pattern|per_type       basic|dreamer|off         flat|progressive       off|candidate|full
    |one_pass

                            WRITE_MODE (server only)
                            sync|async
```

## Дорожная карта

| Фаза | ADR | Что | Статус |
|---|---|---|---|
| **Phase 1** | ADR-002 | One-pass extraction | Proposed |
| **Phase 2** | ADR-003 | Dreamer consolidation (+ skill_candidate flag) | Proposed |
| **Phase 3** | ADR-004 | Progressive context + async write | Proposed |
| **Phase 4** | ADR-005 | Knowledge → Skill pipeline | Hypothesis |

## Конфигурация (новые env vars)

```bash
# Стадия 1: Extraction
EXTRACTION_MODE=pattern        # pattern | per_type | one_pass

# Стадия 2: Consolidation
CONSOLIDATION_MODE=basic       # basic | dreamer | off

# Стадия 3: Delivery
CONTEXT_MODE=flat              # flat | progressive

# Стадия 4: Skill
SKILL_MODE=off                 # off | candidate | full

# Write path (server only)
WRITE_MODE=sync                # sync | async
```

## Источники

- `research/2026-07-20-viking-honcho-analysis.md` — анализ конкурентов
- `architecture/ADR-001-memory-lifecycle-v2.md` — общее решение
- `architecture/ADR-002-one-pass-extraction.md` — детали extraction
- `architecture/ADR-003-dreamer-consolidation.md` — детали consolidation
- `architecture/ADR-004-progressive-context-async-write.md` — детали delivery
- `architecture/ADR-005-knowledge-to-skill-pipeline.md` — гипотеза knowledge→skill
