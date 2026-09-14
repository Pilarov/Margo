"""Regression gate for the benchmark suite (ADR-010 §4).

Compares current metrics against a versioned baseline. Quality metrics are
compared in percentage points (a drop is bad); latency/cost in percent (a rise
is bad). Thresholds come from retaindb.config.json -> benchmark.gates, with the
defaults below as fallback (env > json > default, like the rest of Margo).
"""
from __future__ import annotations

import json
import os
from typing import Any

DEFAULT_GATES: dict[str, float] = {
    "recallDeltaPp": 2.0,
    "latencyDeltaPct": 10.0,
    "costDeltaPct": 15.0,
    "synthesisDeltaPp": 5.0,
}

# metric key in the report -> (gate key, human label, kind)
_QUALITY = [
    ("synthesis_score", "synthesisDeltaPp", "synthesis"),
]
_COST = [
    ("latency_p99_ms", "latencyDeltaPct", "latency p99"),
    ("cost_usd", "costDeltaPct", "cost"),
]


def load_gates(config_path: str | None) -> dict[str, float]:
    """Read benchmark.gates from the JSON config; fall back to defaults."""
    gates = dict(DEFAULT_GATES)
    if not config_path or not os.path.exists(config_path):
        return gates
    try:
        with open(config_path) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return gates
    section = ((cfg.get("benchmark") or {}).get("gates") or {})
    for key in gates:
        if isinstance(section.get(key), (int, float)):
            gates[key] = float(section[key])
    return gates


def compare(
    current: dict[str, Any],
    baseline: dict[str, Any],
    gates: dict[str, float],
    k: int = 10,
) -> dict[str, Any]:
    """Return {pass, checks:[...]} comparing current metrics to baseline."""
    checks: list[dict[str, Any]] = []

    quality = [(f"recall@{k}", "recallDeltaPp", f"recall@{k}"), *_QUALITY]
    for metric, gate_key, label in quality:
        if metric not in current or metric not in baseline:
            continue
        base, cur = baseline[metric], current[metric]
        drop_pp = (base - cur) * 100.0
        checks.append({
            "metric": label,
            "kind": "quality",
            "baseline": base,
            "current": cur,
            "delta": round(-drop_pp, 3),
            "unit": "pp",
            "threshold": gates[gate_key],
            "pass": drop_pp <= gates[gate_key],
        })

    for metric, gate_key, label in _COST:
        if metric not in current or metric not in baseline or not baseline[metric]:
            continue
        base, cur = baseline[metric], current[metric]
        rise_pct = (cur - base) / base * 100.0
        checks.append({
            "metric": label,
            "kind": "cost",
            "baseline": base,
            "current": cur,
            "delta": round(rise_pct, 3),
            "unit": "%",
            "threshold": gates[gate_key],
            "pass": rise_pct <= gates[gate_key],
        })

    return {"pass": all(c["pass"] for c in checks), "checks": checks}


def _self_test() -> None:
    gates = dict(DEFAULT_GATES)
    base = {"recall@10": 0.937, "latency_p99_ms": 100.0}
    # recall drop 3.7pp > 2pp -> fail
    res = compare({"recall@10": 0.900, "latency_p99_ms": 100.0}, base, gates)
    assert not res["pass"]
    # within thresholds -> pass
    res = compare({"recall@10": 0.925, "latency_p99_ms": 105.0}, base, gates)
    assert res["pass"]
    # latency rise 20% > 10% -> fail
    res = compare({"recall@10": 0.937, "latency_p99_ms": 120.0}, base, gates)
    assert not res["pass"]
    print("gate self-test OK")


if __name__ == "__main__":
    _self_test()
