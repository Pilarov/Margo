#!/usr/bin/env python3
"""Margo benchmark runner (ADR-010).

Black-box over HTTP: drives POST /v1/memory/search with the golden QA set,
scores recall/precision/MRR/NDCG, compares against a versioned baseline and
writes JSON + markdown reports.

Usage:
    RETAINDB_BASE_URL=http://localhost:3000 RETAINDB_API_KEY=margo-test-key \
      python scripts/benchmark/run.py --profile on-commit
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

import requests

from gate import compare, load_gates
from metrics import aggregate, score_item
from report import write_reports

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BASE = os.environ.get("RETAINDB_BASE_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("RETAINDB_API_KEY", "margo-test-key")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

QA_PATH = os.path.join(REPO, "qa", "qa-set.json")
MAP_PATH = os.path.join(REPO, "qa", "memory_map.json")
BASELINE_PATH = os.path.join(REPO, "qa", "baseline.json")


def load_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def healthcheck() -> bool:
    try:
        r = requests.get(BASE + "/health", timeout=5)
        return r.status_code < 500
    except requests.RequestException:
        return False


def reseed() -> None:
    seed = os.path.join(REPO, "scripts", "seed-dialectic-data.py")
    subprocess.run([sys.executable, seed], check=True)


def run_retrieval(qa: dict, slug_to_id: dict, user: str, k: int) -> tuple[list, list]:
    per_question: list[dict] = []
    skipped: list[str] = []
    for item in qa["items"]:
        ref = [slug_to_id[s] for s in item["reference_slugs"] if s in slug_to_id]
        if not ref:
            skipped.append(f"{item['id']}: no resolved reference memories")
            print(f"SKIP {item['id']}: no resolved reference memories")
            continue
        r = requests.post(BASE + "/v1/memory/search", headers=H, json={
            "project": "default",
            "query": item["question"],
            "user_id": user,
            "top_k": k,
            "include_pending": True,
            "fast_mode": False,
        }, timeout=60)
        results = (r.json() or {}).get("results", [])
        top = [res.get("memory", {}).get("id") for res in results]
        scores = score_item(ref, top, k)
        per_question.append({"id": item["id"], **scores})
        print(f"{item['id']}: recall@{k} = {scores['recall']:.2f}  {item['question']}")
    return per_question, skipped


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int((p / 100) * len(ordered)))
    return ordered[idx]


def run_latency(latency_cfg: dict) -> list[dict]:
    """Measure p50/p95/p99 search latency per synthetic pool size (ADR-010 §2)."""
    results: list[dict] = []
    project = latency_cfg.get("project", "default")
    repeats = int(latency_cfg.get("repeats", 1))
    fast_mode = bool(latency_cfg.get("fast_mode", False))
    for pool in latency_cfg["pools"]:
        user = latency_cfg["user_template"].format(n=pool["n"])
        queries = pool["queries"]
        for i in range(int(latency_cfg.get("warmup", 0))):
            requests.post(BASE + "/v1/memory/search", headers=H, json={
                "project": project, "query": queries[i % len(queries)], "user_id": user,
                "top_k": 10, "fast_mode": fast_mode,
            }, timeout=60)
        samples: list[float] = []
        for _ in range(repeats):
            for query in queries:
                started = time.perf_counter()
                requests.post(BASE + "/v1/memory/search", headers=H, json={
                    "project": project, "query": query, "user_id": user,
                    "top_k": 10, "fast_mode": fast_mode,
                }, timeout=60)
                samples.append((time.perf_counter() - started) * 1000)
        entry = {
            "n": pool["n"],
            "samples": len(samples),
            "p50_ms": percentile(samples, 50),
            "p95_ms": percentile(samples, 95),
            "p99_ms": percentile(samples, 99),
        }
        results.append(entry)
        print(f"pool n={entry['n']}: p50={entry['p50_ms']:.1f}ms p95={entry['p95_ms']:.1f}ms p99={entry['p99_ms']:.1f}ms")
    return results


def run_synthesis(qa: dict, user: str, level: str = "medium") -> list[dict]:
    """Score dialectic answers with the LLM-judge (ADR-010 §7).

    Primary metric: judge score. Secondary: anchor coverage (kept as a cheap
    signal, no longer the pass/fail criterion).
    """
    per_question: list[dict] = []
    for item in qa["items"]:
        answer = ""
        try:
            r = requests.post(BASE + f"/v1/memory/profile/{user}/ask", headers=H, json={
                "project": "default", "query": item["question"], "reasoning_level": level,
            }, timeout=120)
            answer = (r.json() or {}).get("answer") or ""
        except requests.RequestException as exc:
            print(f"{item['id']}: dialectic error {exc}")

        score, correct = 0.0, False
        try:
            jr = requests.post(BASE + "/v1/admin/benchmark/judge", headers=H, json={
                "question": item["question"],
                "reference_answer": item["answer"],
                "candidate_answer": answer,
                "anchors": item.get("anchors", []),
            }, timeout=120)
            j = jr.json() or {}
            score = float(j.get("score", 0.0))
            correct = bool(j.get("correct", False))
        except (requests.RequestException, ValueError) as exc:
            print(f"{item['id']}: judge error {exc}")

        anchors = item.get("anchors", [])
        anchor_cov = sum(1 for a in anchors if a.lower() in answer.lower()) / len(anchors) if anchors else 0.0
        per_question.append({
            "id": item["id"], "judge_score": score, "judge_correct": correct,
            "anchor_coverage": anchor_cov,
        })
        print(f"{item['id']}: judge={score:.2f} correct={correct} anchors={anchor_cov:.2f}")
    return per_question


def write_baseline(metrics: dict, per_question: list) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Merge so a synthesis run does not wipe retrieval metrics (single baseline
    # file holds both suites' metrics; the gate compares the keys present in both).
    existing: dict = {}
    if os.path.exists(BASELINE_PATH):
        existing = load_json(BASELINE_PATH).get("metrics", {})
    merged = {**existing, **metrics}
    payload = {"timestamp": datetime.now(timezone.utc).isoformat(), "metrics": merged,
               "per_question": per_question}
    dated = os.path.join(REPO, "qa", f"baseline-{stamp}.json")
    with open(dated, "w") as f:
        json.dump(payload, f, indent=2)
    with open(BASELINE_PATH, "w") as f:
        json.dump(payload, f, indent=2)
    return dated


def main() -> int:
    p = argparse.ArgumentParser(description="Margo benchmark runner (ADR-010)")
    p.add_argument("--profile", choices=["on-commit", "nightly"], default="on-commit")
    p.add_argument("--suite", choices=["retrieval", "latency", "synthesis"], default="retrieval")
    p.add_argument("--k", type=int, default=10)
    p.add_argument("--baseline", default=None)
    p.add_argument("--write-baseline", action="store_true")
    p.add_argument("--reseed", action="store_true")
    p.add_argument("--config", default=os.path.join(REPO, "retaindb.config.json"))
    args = p.parse_args()

    if not healthcheck():
        print(f"ERROR: server not reachable at {BASE}", file=sys.stderr)
        return 2

    if args.suite == "latency":
        latency_cfg = load_json(os.path.join(REPO, "qa", "latency-set.json"))
        latency_results = run_latency(latency_cfg)
        metrics = {"latency_p99_ms": max((r["p99_ms"] for r in latency_results), default=0.0)}
        baseline_path = args.baseline or BASELINE_PATH
        gate_result = None
        baseline_ref = None
        if args.write_baseline:
            dated = write_baseline(metrics, [])
            print(f"baseline written: {os.path.relpath(dated, REPO)}")
        elif os.path.exists(baseline_path):
            baseline = load_json(baseline_path)
            gate_result = compare(metrics, baseline.get("metrics", baseline), load_gates(args.config), k=args.k)
            baseline_ref = os.path.relpath(baseline_path, REPO).replace("\\", "/")
        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "profile": args.profile,
            "suite": "latency",
            "k": args.k,
            "metrics": metrics,
            "latency": latency_results,
            "baseline_ref": baseline_ref,
            "gate": gate_result,
        }
        json_path, md_path = write_reports(REPO, result)
        print(f"report: {os.path.relpath(md_path, REPO)}  ({os.path.relpath(json_path, REPO)})")
        if gate_result is not None:
            verdict = "PASS" if gate_result["pass"] else "FAIL"
            print(f"GATE: {verdict}")
            return 0 if gate_result["pass"] else 1
        return 0

    if args.suite == "synthesis":
        if not os.path.exists(MAP_PATH):
            print(f"ERROR: {MAP_PATH} missing — run with --reseed", file=sys.stderr)
            return 2
        qa = load_json(QA_PATH)
        mem_map = load_json(MAP_PATH)
        user = os.environ.get("RETAINDB_USER") or mem_map["user"]
        per_question = run_synthesis(qa, user)
        n = len(per_question) or 1
        metrics = {
            "synthesis_score": sum(q["judge_score"] for q in per_question) / n,
            "anchor_coverage": sum(q["anchor_coverage"] for q in per_question) / n,
        }
        print(f"\nMean synthesis score: {metrics['synthesis_score']:.3f} over {len(per_question)} questions")
        baseline_path = args.baseline or BASELINE_PATH
        gate_result = None
        baseline_ref = None
        if args.write_baseline:
            dated = write_baseline(metrics, per_question)
            print(f"baseline written: {os.path.relpath(dated, REPO)}")
        elif os.path.exists(baseline_path):
            baseline = load_json(baseline_path)
            gate_result = compare(metrics, baseline.get("metrics", baseline), load_gates(args.config), k=args.k)
            baseline_ref = os.path.relpath(baseline_path, REPO).replace("\\", "/")
        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "profile": args.profile,
            "suite": "synthesis",
            "k": args.k,
            "metrics": metrics,
            "per_question": per_question,
            "baseline_ref": baseline_ref,
            "gate": gate_result,
        }
        json_path, md_path = write_reports(REPO, result)
        print(f"report: {os.path.relpath(md_path, REPO)}  ({os.path.relpath(json_path, REPO)})")
        if gate_result is not None:
            verdict = "PASS" if gate_result["pass"] else "FAIL"
            print(f"GATE: {verdict}")
            return 0 if gate_result["pass"] else 1
        return 0

    if args.reseed:
        reseed()

    if not os.path.exists(MAP_PATH):
        print(f"ERROR: {MAP_PATH} missing — run with --reseed", file=sys.stderr)
        return 2

    qa = load_json(QA_PATH)
    mem_map = load_json(MAP_PATH)
    user = os.environ.get("RETAINDB_USER") or mem_map["user"]
    slug_to_id = mem_map["slugs"]

    per_question, skipped = run_retrieval(qa, slug_to_id, user, args.k)
    agg = aggregate(per_question)
    metrics = {
        f"recall@{args.k}": agg["recall"],
        f"precision@{args.k}": agg["precision"],
        "mrr": agg["mrr"],
        f"ndcg@{args.k}": agg["ndcg"],
    }
    print(f"\nMean recall@{args.k}: {agg['recall']:.3f} over {len(per_question)} questions")

    gate_result = None
    baseline_ref = None
    if args.write_baseline:
        dated = write_baseline(metrics, per_question)
        print(f"baseline written: {os.path.relpath(dated, REPO)}")
    else:
        baseline_path = args.baseline or BASELINE_PATH
        if os.path.exists(baseline_path):
            baseline = load_json(baseline_path)
            gate_result = compare(metrics, baseline.get("metrics", baseline),
                                  load_gates(args.config), k=args.k)
            baseline_ref = os.path.relpath(baseline_path, REPO).replace("\\", "/")

    result = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "profile": args.profile,
        "k": args.k,
        "metrics": metrics,
        "per_question": per_question,
        "skipped": skipped,
        "baseline_ref": baseline_ref,
        "gate": gate_result,
    }
    json_path, md_path = write_reports(REPO, result)
    print(f"report: {os.path.relpath(md_path, REPO)}  ({os.path.relpath(json_path, REPO)})")

    if gate_result is not None:
        verdict = "PASS" if gate_result["pass"] else "FAIL"
        print(f"GATE: {verdict}")
        return 0 if gate_result["pass"] else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
