#!/usr/bin/env python3
"""Seed Margo with working memories (памятивы) — NOT user facts.

Reads the golden set from qa/golden-set.json and optionally injects hygiene
memories from a separate file. Writes qa/memory_map.json (slug -> id) so eval
scripts can resolve ground-truth references.

Usage:
    RETAINDB_BASE_URL=http://localhost:3000 RETAINDB_API_KEY=margo-test-key \
      python3 scripts/seed-dialectic-data.py
    # golden + all hygiene injections:
    RETAINDB_BASE_URL=... python3 scripts/seed-dialectic-data.py --hygiene qa/hygiene-injections.json
    # golden + first 100 hygiene injections:
    RETAINDB_BASE_URL=... python3 scripts/seed-dialectic-data.py --hygiene qa/hygiene-injections.json --hygiene-n 100
"""
import argparse
import json
import os
import time

import requests

BASE = os.environ.get("RETAINDB_BASE_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("RETAINDB_API_KEY", "margo-test-key")
HERE = os.path.dirname(os.path.abspath(__file__))
QA_PATH = os.path.join(HERE, "..", "qa", "qa-set.json")
GOLDEN_PATH = os.path.join(HERE, "..", "qa", "golden-set.json")
MAP_PATH = os.path.join(HERE, "..", "qa", "memory_map.json")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def _qa_user() -> str:
    """qa/qa-set.json is the single source of truth for the eval user."""
    try:
        with open(QA_PATH) as f:
            return json.load(f).get("user") or "working-memory-test-user"
    except (OSError, ValueError):
        return "working-memory-test-user"


def load_memories(path: str) -> list:
    with open(path) as f:
        data = json.load(f)
    memories = data.get("memories", [])
    return memories


def post_memory(mem: dict, user: str) -> str | None:
    r = requests.post(BASE + "/v1/memory", headers=H, json={
        "project": "default",
        "content": mem["content"],
        "memory_type": mem.get("memory_type", "factual"),
        "user_id": user,
        "importance": mem.get("importance", 0.5),
        "entity_mentions": mem.get("entity_mentions", []),
        "write_mode": "sync",
    }, timeout=60)
    if r.status_code in (200, 201):
        body = r.json()
        return (body.get("memory") or {}).get("id") or body.get("memory_id")
    print(f"FAIL {mem.get('slug', '?')}: {r.status_code} {r.text[:120]}")
    return None


def wait_until_indexed(slug_to_id: dict, memories: list, user: str, timeout_s: int = 90) -> bool:
    if not slug_to_id:
        return False
    sample_slug = next(iter(slug_to_id))
    sample_id = slug_to_id[sample_slug]
    content = next((m["content"] for m in memories if m.get("slug") == sample_slug), None)
    if not content:
        return False
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            r = requests.post(BASE + "/v1/memory/search", headers=H, json={
                "project": "default", "query": content, "user_id": user,
                "top_k": 50, "include_pending": True,
            }, timeout=30)
            ids = [x.get("memory", {}).get("id") for x in (r.json() or {}).get("results", [])]
            if sample_id in ids:
                return True
        except requests.RequestException:
            pass
        time.sleep(2)
    return False


def main() -> int:
    p = argparse.ArgumentParser(description="Seed Margo with golden set (+ hygiene)")
    p.add_argument("--golden", default=GOLDEN_PATH)
    p.add_argument("--hygiene", default=None, help="path to hygiene-injections.json")
    p.add_argument("--hygiene-n", type=int, default=None, help="inject only the first N hygiene memories")
    p.add_argument("--user", default=None)
    args = p.parse_args()

    user = args.user or os.environ.get("RETAINDB_USER") or _qa_user()

    memories = load_memories(args.golden)
    if args.hygiene:
        hygiene = load_memories(args.hygiene)
        if args.hygiene_n is not None:
            hygiene = hygiene[: args.hygiene_n]
        memories = memories + hygiene

    slug_to_id = {}
    count = 0
    for mem in memories:
        slug = mem.get("slug") or mem["content"][:24]
        mid = post_memory(mem, user)
        if mid:
            slug_to_id[slug] = mid
            count += 1

    os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
    with open(MAP_PATH, "w") as f:
        json.dump({"user": user, "slugs": slug_to_id}, f, indent=2)

    print(f"\nSeeded {count}/{len(memories)} working memories for {user}")
    print(f"Memory map written to {MAP_PATH}")

    ready = wait_until_indexed(slug_to_id, memories, user)
    print(f"Indexing: {'ready' if ready else 'TIMEOUT (search may return 0)'}")
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
