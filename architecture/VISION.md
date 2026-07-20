# Margo v2: Memory Lifecycle Architecture

**Status**: Proposed (ADR-001–004)
**Date**: 2026-07-20

## Целостное видение

Margo v2 — эволюция пайплайна памяти с опциональным LLM-усилением на каждой стадии. Три стадии, три конфига, полная обратная совместимость.

```
СТАДИЯ 1: EXTRACTION           СТАДИЯ 2: CONSOLIDATION        СТАДИЯ 3: DELIVERY
┌──────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────┐
│ Local (pattern)      │    │ Local (basic)            │    │ Local (flat)         │
│ ───────────────────  │    │ ────────────────────────  │    │ ───────────────────  │
│ • regex patterns     │    │ • Jaccard dedup ≥0.92    │    │ • token_budget cut   │
│ • 13 типов памяти    │    │ • decay >14d, <0.45      │    │ • все результаты     │
│ • 0 токенов          │    │ • session rollup         │    │   сразу              │
│                      │    │ • 0 токенов              │    │                      │
│ Server (one_pass)    │    │ Server (dreamer)         │    │ Server (progressive) │
│ ───────────────────  │    │ ────────────────────────  │    │ ───────────────────  │
│ • schema-driven      │    │ • inductive patterns     │    │ • L0 abstract (100t) │
│ • 1 LLM-вызов        │    │ • conflict resolution    │    │ • L1 overview (~2k)  │
│ • N× экономия        │    │ • peer-card generation   │    │ • L2 full on-demand  │
│ • ~500 токенов       │    │ • ~2000 токенов/pass     │    │ • 10-50× экономия    │
└──────────────────────┘    └──────────────────────────┘    └──────────────────────┘
         │                            │                            │
    EXTRACTION_MODE             CONSOLIDATION_MODE            CONTEXT_MODE
    pattern|per_type|one_pass   basic|dreamer|off             flat|progressive

                            WRITE_MODE (server only)
                            sync|async
```

## Конфигурация (новые env vars)

```bash
# Стадия 1: Extraction
EXTRACTION_MODE=pattern        # pattern | per_type | one_pass

# Стадия 2: Consolidation
CONSOLIDATION_MODE=basic       # basic | dreamer | off

# Стадия 3: Delivery
CONTEXT_MODE=flat              # flat | progressive

# Write path (server only)
WRITE_MODE=sync                # sync | async
```

## Дорожная карта

| Фаза | ADR | Что | Усиление |
|---|---|---|---|
| **Phase 1** | ADR-002 | One-pass extraction | 1 LLM-вызов вместо N, N× экономия токенов |
| **Phase 2** | ADR-003 | Dreamer consolidation | Inductive + conflict + peer-card |
| **Phase 3** | ADR-004 | Progressive context + async write | L0/L1/L2 + мгновенная запись |

## Источники

- `research/2026-07-20-viking-honcho-analysis.md` — анализ конкурентов
- `architecture/ADR-001-memory-lifecycle-v2.md` — общее решение
- `architecture/ADR-002-one-pass-extraction.md` — детали extraction
- `architecture/ADR-003-dreamer-consolidation.md` — детали consolidation
- `architecture/ADR-004-progressive-context-async-write.md` — детали delivery
