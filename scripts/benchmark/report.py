"""Benchmark report writers (ADR-010 §5).

Machine-readable JSON for the gate/CI + a human markdown report under reviews/.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any


def _fmt(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def render_markdown(result: dict[str, Any]) -> str:
    lines = [
        f"# Benchmark {result.get('timestamp', '')}",
        "",
        f"- profile: `{result.get('profile')}`",
        f"- k: {result.get('k')}",
        f"- baseline: `{result.get('baseline_ref') or 'none'}`",
        "",
        "## Metrics",
        "",
        "| metric | value |",
        "|---|---|",
    ]
    for key, value in (result.get("metrics") or {}).items():
        lines.append(f"| {key} | {_fmt(value)} |")

    gate = result.get("gate")
    lines += ["", "## Gate", ""]
    if not gate:
        lines.append("_no baseline comparison_")
    else:
        verdict = "PASS" if gate.get("pass") else "FAIL"
        lines += [f"**{verdict}**", "", "| metric | baseline | current | delta | threshold | pass |",
                  "|---|---|---|---|---|---|"]
        for c in gate.get("checks", []):
            lines.append(
                f"| {c['metric']} | {_fmt(c['baseline'])} | {_fmt(c['current'])} "
                f"| {c['delta']:+} {c['unit']} | {c['threshold']} | {'yes' if c['pass'] else 'NO'} |"
            )

    skipped = result.get("skipped") or []
    if skipped:
        lines += ["", "## Skipped", ""]
        lines += [f"- {item}" for item in skipped]
    lines.append("")
    return "\n".join(lines)


def write_reports(repo_root: str, result: dict[str, Any]) -> tuple[str, str]:
    """Write qa/bench-<ts>.json + reviews/BENCH-<date>.md. Returns paths."""
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    day = now.strftime("%Y-%m-%d")

    qa_dir = os.path.join(repo_root, "qa")
    reviews_dir = os.path.join(repo_root, "reviews")
    os.makedirs(qa_dir, exist_ok=True)
    os.makedirs(reviews_dir, exist_ok=True)

    json_path = os.path.join(qa_dir, f"bench-{stamp}.json")
    md_path = os.path.join(reviews_dir, f"BENCH-{day}.md")

    with open(json_path, "w") as f:
        json.dump(result, f, indent=2)
    with open(md_path, "w") as f:
        f.write(render_markdown(result))

    return json_path, md_path


def _self_test() -> None:
    result = {
        "timestamp": "2026-09-08T00:00:00Z",
        "profile": "on-commit",
        "k": 10,
        "baseline_ref": "qa/baseline.json",
        "metrics": {"recall@10": 0.937, "precision@10": 0.42},
        "gate": {"pass": False, "checks": [
            {"metric": "recall@10", "baseline": 0.937, "current": 0.9,
             "delta": -3.7, "unit": "pp", "threshold": 2.0, "pass": False},
        ]},
    }
    md = render_markdown(result)
    assert "FAIL" in md and "recall@10" in md and "0.937" in md
    print("report self-test OK")


if __name__ == "__main__":
    _self_test()
