#!/usr/bin/env python3
"""Generate a synthetic memory pool of size N for latency benchmarking (ADR-010 §2).

The latency suite needs controlled pool sizes (1k/10k/100k) to measure how
p50/p95/p99 scale. There is no such dataset in the repo, so we synthesize one:
N working memories for a dedicated user, written via POST /v1/memory/bulk.

Deterministic (seeded), so the pool is reproducible. Writes land async, so the
script waits before returning (tune with --wait-seconds).

Usage:
    RETAINDB_BASE_URL=http://localhost:3000 RETAINDB_API_KEY=margo-test-key \
      python scripts/benchmark/gen_pool.py --n 1000
"""
from __future__ import annotations

import argparse
import os
import random
import sys
import time

import requests

BASE = os.environ.get("RETAINDB_BASE_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("RETAINDB_API_KEY", "margo-test-key")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

TOPICS = [
    "deployment", "database", "caching", "authentication", "billing", "monitoring",
    "logging", "messaging", "storage", "networking", "security", "testing",
    "documentation", "release", "migration", "scheduling", "search", "analytics",
]
VERBS = ["standardized", "migrated", "deprecated", "introduced", "optimized", "documented", "replaced", "adopted"]
TYPES = [
    "decision", "constraint", "goal", "preference", "instruction",
    "workflow", "solution", "project_state", "factual", "correction",
]


def gen_memory(rng: random.Random, idx: int) -> dict:
    topic = rng.choice(TOPICS)
    verb = rng.choice(VERBS)
    detail = rng.choice(["for service", "across the platform", "in the monorepo", "for the api", "in production"])
    return {
        "content": f"Team {verb} the {topic} approach {detail} {idx}",
        "memory_type": rng.choice(TYPES),
        "importance": round(rng.uniform(0.3, 0.9), 2),
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Generate a synthetic latency pool")
    p.add_argument("--n", type=int, required=True, help="pool size (number of memories)")
    p.add_argument("--user", default=None, help="target user (default latency-pool-<n>)")
    p.add_argument("--project", default="default")
    p.add_argument("--batch", type=int, default=100, help="memories per bulk request (max 1000)")
    p.add_argument("--write-mode", choices=["sync", "async"], default="sync",
                   help="sync (inline, reliable) or async (needs a working ingestion_jobs)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--wait-seconds", type=int, default=30, help="wait for async writes to settle")
    args = p.parse_args()

    if args.batch > 1000:
        print("ERROR: --batch must be <= 1000", file=sys.stderr)
        return 2

    user = args.user or f"latency-pool-{args.n}"
    rng = random.Random(args.seed)
    created = 0

    for start in range(0, args.n, args.batch):
        size = min(args.batch, args.n - start)
        memories = [{**gen_memory(rng, start + i), "user_id": user} for i in range(size)]
        r = requests.post(BASE + "/v1/memory/bulk", headers=H, json={
            "project": args.project,
            "memories": memories,
            "write_mode": args.write_mode,
        }, timeout=300)
        if r.status_code not in (200, 201, 202):
            print(f"FAIL batch {start}: {r.status_code} {r.text[:160]}", file=sys.stderr)
            return 1
        created += size
        print(f"  {created}/{args.n}")

    if args.wait_seconds > 0:
        print(f"waiting {args.wait_seconds}s for async writes...")
        time.sleep(args.wait_seconds)

    print(f"Generated {created} memories for user={user}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
