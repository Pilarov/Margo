# How to combine the semantic and lexical channels (investigation, 2026-09-24)

**Goal**: the TD-005 lexical channel must not just exist — the *combination rule* has to be chosen
by measurement, and we need to know whether 54/54 golden questions is reachable at all.

**Method**: for each of the 54 golden questions, collect the full ordered candidate list from each
channel — semantic (live `POST /v1/memory/search`, top-50, the API maximum) and lexical (OR-semantics
``to_tsquery`` over `memories.content`, ``ts_rank_cd``, top-50) — then simulate fusion variants
offline with the benchmark's own metric (`recall@10` per question = |refs ∩ top10| / |refs|).
Artifacts: `reviews/td005/fusion-data.json`, `reviews/td005/fusion-results.json`, scripts
`fusion_collect.py`, `fusion_simulate.py`.

Caveat: the collection runs at `top_k=50`, which scales the window/rerank slices, so absolute macro
values differ from the k=10 benchmark (0.7685 here vs 0.7870 in the suite). Only the *relative* deltas
are the finding.

## 1. Channel complementarity (question level, top-10)

| both channels cover | semantic only | lexical only | neither |
|---|---|---|---|
| 37 | 6 | **8** | **3** |

Union ceiling = **51/54 (94.4%)**. 54/54 is **not reachable** by any semantic+lexical fusion — that
is a measured ceiling, not a tuning problem.

Questions only the lexical arm can save: `q-deploy-constraint`, `q-package-manager`, `q-release-phase`,
`q-coverage`, `q-sso`, `q-soft-delete`, `q-pii-tokenize`, `q-canary`.

## 2. Fusion variants (macro recall@10, baseline 0.7685)

| variant | macro | worse/better vs semantic-only |
|---|---|---|
| semantic only (today) | 0.7685 | — |
| lexical only | 0.7870 | +8 / −9 |
| RRF, w_sem 1.0 / w_lex 0.3 | 0.8920 | +7 / −1 |
| RRF, w_sem 1.0 / w_lex 0.5 | 0.8920 | +7 / −1 |
| RRF, w_sem 1.0 / w_lex 0.7 | 0.8920 | +7 / −1 |
| **RRF equal (1:1)** | **0.9012** | **+8 / −1** |
| RRF, w_sem 0.7 / w_lex 1.0 | 0.8549 | +8 / −4 |
| **semantic-first top-up, keep=8** | **0.8889** | **+7 / −0** |
| semantic-first top-up, keep=5 | 0.9012 | +8 / −1 |
| semantic-first top-up, keep=10 | 0.7685 | +0 / −0 |
| lexical-first head (3) then semantic | 0.8889 | +7 / −0 |

The weight surface is **flat** for w_lex ∈ [0.3 … 0.7] (identical macro), and the extremes are the
only place it breaks: letting lexical outweigh semantics (w_sem 0.7/w_lex 1.0) costs 4 questions.
The single question the aggressive variants break is `q-backend` — a case where the semantic arm
already held two of three references.

## 3. Is there a per-query signal to route on? (measured: no)

- `top_similarity` of the semantic arm: 0.90–1.15 across questions, and the range is the **same** for
  questions the lexical arm saves (0.900–1.004) and for those already fine (0.902–1.150) → it does not
  separate the two sets.
- Lexical match counts also overlap (saving questions: 2, 3, 8, 9, 50 …; fine questions: 1, 4, 17, 21, 50).
- The semantic list is never shorter than 10 (min 30), so "top up only when semantic returns too few"
  never fires (keep=10 → no change at all).

Conclusion: an adaptive router built on these signals would be **overfitting** a 54-question synthetic
set. Adaptivity should come from (a) the ADR-011 tuner once a real signal exists, or (b) rerank-level
fusion (per-candidate lexical-overlap features instead of one global weight) — which is ADR-007 §S2
work (Этап 5), not Этап 2.

## 4. Where 54/54 actually dies

The three questions no channel covers have their references **already retrieved but not promoted**:

| question | reference rank in the semantic list | list length |
|---|---|---|
| `q-log-format` | 16 | 34 |
| `q-no-secrets` | 37 | 50 |
| `q-test-framework` | 47 | 50 |

Two of them sit **beyond the S1 recall window** (`recall.min = 30` cuts before rerank); the third is
outranked inside the delivery cut. So the remaining gap is **S2/S3 ranking/delivery, not channel
coverage** — i.e. exactly ADR-013's outstanding S2/S3 work, which is measurable on the memory path.

## 5. Recommendation

1. **Ship fusion as a configurable shape, not a single hard-coded rule**:
   `retrieval.fusion = { strategy: "top-up" | "rrf", keep, weights }`, with `top-up` (keep = 8) as the
   measured default — zero regressions, semantic head order preserved, one knob — and `rrf` (equal
   weights) available for the next calibration round once ADR-012 changes the embedding profile.
2. **Do not build an adaptive router yet** (§3: no separating signal; a 54-question synthetic set
   cannot justify one).
3. **Treat 54/54 as a two-part target**: lexical fusion covers the channel half (51/54 question-level
   ceiling, macro 0.7685 → 0.89–0.90); the tail needs S2/S3 ranking work on the memory path, which is
   also where ADR-013's remaining `rerank`/`delivery` windows belong.

## 6. Rejected / deferred

- **Adaptive routing on query features** — rejected for now (§3).
- **Lexical-only or lexical-dominant fusion** — rejected: −4 to −9 questions.
- **Rerank-level fusion** (features per candidate) — deferred to ADR-007 §S2 (Этап 5); it is the
  flexible long-term answer but needs the reranker refactor first.
