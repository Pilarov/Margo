#!/usr/bin/env python3
"""Evaluate memory retrieval recall@k against the QA ground-truth set.

For each QA item, POST /v1/memory/search with the question and check how many of
the ground-truth reference memories appear in the top-k results.

Usage:
    RETAINDB_BASE_URL=http://localhost:3000 RETAINDB_API_KEY=margo-test-key \
      python3 scripts/eval-retrieval.py [--k 10]
"""
import json
import os
import sys
import requests

BASE = os.environ.get("RETAINDB_BASE_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("RETAINDB_API_KEY", "margo-test-key")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
HERE = os.path.dirname(os.path.abspath(__file__))
QA_PATH = os.path.join(HERE, "..", "qa", "qa-set.json")
MAP_PATH = os.path.join(HERE, "..", "qa", "memory_map.json")

K = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--k" else 10

with open(QA_PATH) as f:
    qa = json.load(f)
with open(MAP_PATH) as f:
    mem_map = json.load(f)

user = mem_map["user"]
slug_to_id = mem_map["slugs"]

rows = []
for item in qa["items"]:
    ref_ids = [slug_to_id[s] for s in item["reference_slugs"] if s in slug_to_id]
    if not ref_ids:
        print(f"SKIP {item['id']}: no resolved reference memories")
        continue
    r = requests.post(BASE + "/v1/memory/search", headers=H, json={
        "project": "default", "query": item["question"],
        "user_id": user, "top_k": K, "include_pending": True,
    }, timeout=60)
    results = (r.json() or {}).get("results", [])
    top_ids = [res.get("memory", {}).get("id") for res in results]
    hits = [rid for rid in ref_ids if rid in top_ids]
    recall = len(hits) / len(ref_ids)
    rows.append((item["id"], len(ref_ids), len(hits), recall))
    print(f"{item['id']}: recall@{K} = {len(hits)}/{len(ref_ids)} ({recall:.2f})  {item['question']}")

if rows:
    avg = sum(r[3] for r in rows) / len(rows)
    print(f"\nMean recall@{K}: {avg:.3f} over {len(rows)} questions")
    sys.exit(0 if avg >= 0.8 else 1)
