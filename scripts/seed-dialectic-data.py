#!/usr/bin/env python3
"""Seed a realistic memory set for testing dialectic semantic selection.

Creates a single user (`dialectic-test-user`) with two thematic clusters:
  - work/infra (HIGH importance, 0.6-0.85): backend/Go/k8s/CI
  - preferences/style (LOW importance, 0.25-0.6): editor theme, fonts, habits

The point: queries about preferences must surface LOW-importance memories, which
`importance + recency` selection fails at and semantic `<=>` selection solves.

Usage:
    RETAINDB_BASE_URL=http://localhost:3000 RETAINDB_API_KEY=margo-test-key python3 scripts/seed-dialectic-data.py
"""
import os
import requests

BASE = os.environ.get("RETAINDB_BASE_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("RETAINDB_API_KEY", "margo-test-key")
USER = "dialectic-test-user"
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

MEMORIES = [
    # ── Cluster A: work / infrastructure (HIGH importance) ─────────────────
    ("Works as a backend engineer at Stripe", "factual", 0.85),
    ("Primary backend language is Go", "factual", 0.8),
    ("Services communicate over gRPC", "factual", 0.75),
    ("Uses PostgreSQL with pgvector for embeddings", "factual", 0.7),
    ("Deploys to Kubernetes on AWS EKS", "factual", 0.8),
    ("CI/CD pipeline runs on GitHub Actions", "factual", 0.7),
    ("Monorepo is managed with pnpm workspaces", "factual", 0.75),
    ("Observability stack is Prometheus and Grafana", "factual", 0.7),
    ("Infrastructure is defined with Terraform", "factual", 0.75),
    ("Service mesh is Istio", "factual", 0.65),
    ("API rate limit is 1000 requests per minute", "constraint", 0.8),
    ("On-call rotation is weekly", "factual", 0.6),
    ("Code review is required before merge", "instruction", 0.8),
    ("Feature flags are managed with LaunchDarkly", "factual", 0.7),
    ("Secrets are stored in AWS Secrets Manager", "factual", 0.65),
    # ── Cluster B: preferences / style (LOW importance) ────────────────────
    ("Prefers dark theme in the code editor", "preference", 0.35),
    ("Likes monospace fonts, especially JetBrains Mono", "preference", 0.4),
    ("Prefers concise bullet-point answers", "preference", 0.3),
    ("Dislikes emojis in technical output", "preference", 0.35),
    ("Prefers pnpm over npm", "preference", 0.45),
    ("Prefers a maximum line length of 80 characters", "preference", 0.4),
    ("Prefers tabs over spaces for indentation", "preference", 0.5),
    ("Enjoys morning coffee before starting work", "preference", 0.25),
    ("Prefers Vim keybindings in the editor", "preference", 0.4),
    ("Likes small focused git commits", "preference", 0.45),
    ("Prefers TypeScript over plain JavaScript", "preference", 0.6),
    ("Dislikes long meetings", "preference", 0.4),
    ("Prefers async communication over meetings", "preference", 0.45),
    ("Likes writing tests before implementation", "preference", 0.5),
    ("Prefers dark mode everywhere including the terminal", "preference", 0.35),
    ("Likes the Dracula color scheme", "preference", 0.3),
    # ── Goals / events (mixed importance) ──────────────────────────────────
    ("Goal: migrate the monolith to microservices by Q3", "goal", 0.8),
    ("Goal: reduce p99 latency below 100 milliseconds", "goal", 0.7),
    ("Attended KubeCon in 2025", "event", 0.5),
    ("Shipped the new billing API in March", "event", 0.6),
    ("Planning to adopt Rust for performance-critical services", "goal", 0.6),
    ("Migrated the frontend from JavaScript to TypeScript", "event", 0.55),
    ("Uses a standing desk to reduce back pain", "preference", 0.3),
    ("Prefers error messages with code snippets", "preference", 0.4),
    ("Likes when APIs return typed schemas", "preference", 0.45),
    ("Dislikes abbreviations in documentation", "preference", 0.35),
]

count = 0
for content, memory_type, importance in MEMORIES:
    r = requests.post(BASE + "/v1/memory", headers=H, json={
        "project": "default",
        "content": content,
        "memory_type": memory_type,
        "user_id": USER,
        "importance": importance,
        "write_mode": "sync",
    }, timeout=60)
    if r.status_code in (200, 201):
        count += 1
    else:
        print(f"FAIL {memory_type}: {content[:40]} -> {r.status_code} {r.text[:120]}")

print(f"\nSeeded {count}/{len(MEMORIES)} memories for {USER}")
