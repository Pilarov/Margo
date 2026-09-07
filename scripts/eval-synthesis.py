#!/usr/bin/env python3
"""Evaluate dialectic synthesis against the QA ground-truth set.

For each QA item, POST /v1/memory/profile/:userId/ask and check whether the
ground-truth anchor phrases appear in the answer (a proxy for grounding).

Usage:
    RETAINDB_BASE_URL=http://localhost:3000 RETAINDB_API_KEY=margo-test-key \
      python3 scripts/eval-synthesis.py [--level medium]
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

LEVEL = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--level" else "medium"

with open(QA_PATH) as f:
    qa = json.load(f)

user = os.environ.get("RETAINDB_USER", qa["user"])
rows = []
for item in qa["items"]:
    r = requests.post(BASE + f"/v1/memory/profile/{user}/ask", headers=H, json={
        "project": "default", "query": item["question"], "reasoning_level": LEVEL,
    }, timeout=120)
    body = r.json()
    answer = (body.get("answer") or "").lower()
    anchors = [a for a in item["anchors"] if a.lower() in answer]
    score = len(anchors) / len(item["anchors"]) if item["anchors"] else 0.0
    rows.append((item["id"], score))
    print(f"{item['id']}: {len(anchors)}/{len(item['anchors'])} anchors  ({score:.2f})  Q: {item['question']}")
    print(f"    answer: {body.get('answer', '')[:160]}")

if rows:
    avg = sum(r[1] for r in rows) / len(rows)
    print(f"\nMean anchor coverage: {avg:.3f} over {len(rows)} questions")
    sys.exit(0 if avg >= 0.8 else 1)
