"""Retrieval ranking metrics for the benchmark suite (ADR-010 §1).

Pure functions over binary relevance: `ref` is the set of ground-truth memory
ids, `top` is the ranked list of ids returned by the retriever. Kept dependency
free so the runner and the gate can both import it.

Self-test:  python scripts/benchmark/metrics.py
"""
from __future__ import annotations

from math import log2
from typing import Iterable, Sequence


def recall_at_k(ref: Iterable[str], top: Sequence[str], k: int) -> float:
    """Fraction of ground-truth ids present in the top-k results."""
    ref_set = set(ref)
    if not ref_set:
        return 0.0
    return len(ref_set & set(top[:k])) / len(ref_set)


def precision_at_k(ref: Iterable[str], top: Sequence[str], k: int) -> float:
    """Fraction of the top-k results that are relevant (denominator = k)."""
    if k <= 0:
        return 0.0
    return len(set(ref) & set(top[:k])) / k


def mrr(ref: Iterable[str], top: Sequence[str]) -> float:
    """Reciprocal rank of the first relevant result (0.0 if none)."""
    ref_set = set(ref)
    for rank, memory_id in enumerate(top, start=1):
        if memory_id in ref_set:
            return 1.0 / rank
    return 0.0


def ndcg_at_k(ref: Iterable[str], top: Sequence[str], k: int) -> float:
    """Binary-relevance NDCG@k (ideal ranking = all relevant results first)."""
    ref_set = set(ref)
    if not ref_set:
        return 0.0
    dcg = sum(
        1.0 / log2(rank + 1)
        for rank, memory_id in enumerate(top[:k], start=1)
        if memory_id in ref_set
    )
    ideal_hits = min(len(ref_set), k)
    idcg = sum(1.0 / log2(rank + 1) for rank in range(1, ideal_hits + 1))
    return dcg / idcg if idcg else 0.0


def score_item(ref: Iterable[str], top: Sequence[str], k: int) -> dict[str, float]:
    """All ranking metrics for a single question."""
    return {
        "recall": recall_at_k(ref, top, k),
        "precision": precision_at_k(ref, top, k),
        "mrr": mrr(ref, top),
        "ndcg": ndcg_at_k(ref, top, k),
    }


def aggregate(per_question: Sequence[dict[str, float]]) -> dict[str, float]:
    """Mean of each metric across questions (empty input -> all zeros)."""
    keys = ("recall", "precision", "mrr", "ndcg")
    if not per_question:
        return {key: 0.0 for key in keys}
    return {
        key: sum(item.get(key, 0.0) for item in per_question) / len(per_question)
        for key in keys
    }


def _close(a: float, b: float, eps: float = 1e-9) -> bool:
    return abs(a - b) < eps


def _self_test() -> None:
    assert recall_at_k({"a", "b"}, ["x", "a", "b"], 3) == 1.0
    assert recall_at_k({"a", "b"}, ["x", "a"], 2) == 0.5
    assert recall_at_k(set(), ["a"], 1) == 0.0

    assert precision_at_k({"a"}, ["a", "x"], 2) == 0.5
    assert precision_at_k({"a"}, ["x", "x"], 2) == 0.0

    assert _close(mrr({"a"}, ["x", "y", "a"]), 1 / 3)
    assert mrr({"a"}, ["x"]) == 0.0

    assert _close(ndcg_at_k({"a"}, ["x", "a"], 2), 1 / log2(3))
    assert _close(ndcg_at_k({"a", "b"}, ["a", "b"], 2), 1.0)

    agg = aggregate([{"recall": 1.0, "precision": 0.5, "mrr": 1.0, "ndcg": 1.0},
                     {"recall": 0.0, "precision": 0.5, "mrr": 0.0, "ndcg": 0.0}])
    assert _close(agg["recall"], 0.5) and _close(agg["precision"], 0.5)
    assert aggregate([]) == {"recall": 0.0, "precision": 0.0, "mrr": 0.0, "ndcg": 0.0}

    print("metrics self-test OK")


if __name__ == "__main__":
    _self_test()
