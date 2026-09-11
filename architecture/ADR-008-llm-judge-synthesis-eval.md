# ADR-008: LLM-judge для оценки synthesis вместо anchor-substring

**Status**: Proposed
**Date**: 2026-09-04
**Deciders**: opencode + dspilarov

## Context

`scripts/eval-synthesis.py` оценивает качество диалектики метрикой **anchor coverage**: эталонные фразы (`anchors`) должны встречаться как подстрока в ответе. На расширенном наборе (21 вопрос) она показала **нестабильность** (0.53 → 0.87 между прогонами из-за семантического кэша и ретраев) и **грубость**: `"Friday"` засчитывается, а синонимичный `"Fridays"` или переформулированный смысл — нет.

## Decision

**Заменить anchor-substring на LLM-judge**: LLM сравнивает ответ диалектики с эталонным `answer` из `qa/qa-set.json` по смыслу и возвращает бинарную оценку `{ correct: true|false, reason }` (опционально 0-1 score). Оставляем `anchors` в наборе как подсказку для judge, но не как жёсткий substring-критерий.

## Alternatives Considered

### Option A: Оставить anchor-substring
- **Pros**: бесплатно, детерминированно.
- **Cons**: формулировочно-зависимо, нестабильно, не оценивает смысл.
- **Why rejected**: уже показала разброс 0.53–0.87 на одном наборе.

### Option B: Точное совпадение answer (exact match)
- **Pros**: детерминированно.
- **Cons**: слишком строго — диалектика редко даёт дословный эталон.
- **Why rejected**: даст ложные «fail» на корректных, но иначе сформулированных ответах.

### Option C: BLEU/ROUGE
- **Pros**: классические метрики генерации.
- **Cons**: n-gram overlap, слабо улавливает смысл коротких ответов.
- **Why rejected**: для коротких фактологических ответов LLM-judge надёжнее.

## Consequences

- **Positive**: стабильная смысловая оценка, устойчивость к переформулировке и кэшу.
- **Negative**: +LLM-вызов на каждый вопрос (стоимость), недетерминизм — митигируется `temperature=0` и усреднением по N прогонам.
- **Neutral**: `anchors` остаются в наборе как evidence для judge.

## Falsification Criteria

- **Стабильность**: дисперсия LLM-judge-оценки на 3 повторных прогонах одного набора < 5 п.п. (против 30+ п.п. у anchor-substring).
- **Корреляция**: LLM-judge совпадает с ручной оценкой ≥ 90% на случайной выборке 10 вопросов.

## Related ADRs

- **ADR-010 (benchmarking & regression)** — LLM-judge входит в benchmark suite.
- **ADR-011 (telemetry & QC)** — sampled LLM-judge для answer-quality в live.
