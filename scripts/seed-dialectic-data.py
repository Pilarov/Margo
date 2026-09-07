#!/usr/bin/env python3
"""Seed Margo with *working* memories (памятивы) — NOT user facts.

Margo stores durable working memory about the project/work: decisions, constraints,
goals, procedures, corrections, and answer-style preferences. User identity,
relationships, biography and dialogues live in other services.

Each memory has a stable `slug` used to cross-reference the QA eval set. The
seed writes `qa/memory_map.json` mapping slug -> memory_id so eval scripts can
resolve ground-truth references.

Usage:
    RETAINDB_BASE_URL=http://localhost:3000 RETAINDB_API_KEY=margo-test-key \
      python3 scripts/seed-dialectic-data.py
"""
import json
import os
import requests

BASE = os.environ.get("RETAINDB_BASE_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("RETAINDB_API_KEY", "margo-test-key")
USER = os.environ.get("RETAINDB_USER", "dialectic-test-user")
MAP_PATH = os.path.join(os.path.dirname(__file__), "..", "qa", "memory_map.json")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# (slug, content, memory_type, importance, entity_mentions)
MEMORIES = [
    # ── Cluster A: architecture / decisions / constraints (HIGH importance) ──
    ("go-backend", "Standardized the backend on Go", "decision", 0.8, ["Go"]),
    ("grpc-comms", "Chose gRPC for service-to-service communication", "decision", 0.75, ["gRPC"]),
    ("pnpm-monorepo", "Monorepo is managed with pnpm workspaces", "factual", 0.7, ["pnpm"]),
    ("postgres-pgvector", "Primary datastore is PostgreSQL with pgvector", "factual", 0.7, ["PostgreSQL", "pgvector"]),
    ("aws-only", "Deployment must stay on AWS", "constraint", 0.8, ["AWS"]),
    ("prom-grafana", "Observability stack is Prometheus and Grafana", "factual", 0.7, ["Prometheus", "Grafana"]),
    ("terraform-infra", "Infrastructure is defined with Terraform", "decision", 0.75, ["Terraform"]),
    ("gh-actions", "CI/CD runs on GitHub Actions", "factual", 0.7, ["GitHub Actions"]),
    ("rate-limit", "API rate limit is 1000 requests per minute", "constraint", 0.8, []),
    ("secrets-manager", "Secrets are stored in AWS Secrets Manager", "factual", 0.65, ["AWS"]),
    ("review-before-merge", "Code review is required before merge", "instruction", 0.8, []),
    ("launchdarkly", "Feature flags are managed with LaunchDarkly", "decision", 0.7, ["LaunchDarkly"]),

    # ── Cluster B: how to work / how to answer (LOW importance) ──────────────
    ("concise-answers", "Prefers concise bullet-point answers", "preference", 0.3, []),
    ("no-emojis", "No emojis in technical output", "preference", 0.35, []),
    ("code-snippets", "Likes code snippets over prose explanations", "preference", 0.4, []),
    ("line-length-80", "Prefers a maximum line length of 80 characters", "preference", 0.4, []),
    ("error-examples", "Prefers error messages to include code examples", "preference", 0.4, []),
    ("tests-before-push", "Always run tests before pushing", "instruction", 0.5, []),
    ("changelog-entry", "Add a changelog entry with every merge", "instruction", 0.45, []),
    ("deploy-fridays", "Deploy to production only on Fridays", "workflow", 0.45, []),
    ("semver", "Release process uses semantic versioning", "workflow", 0.5, []),
    ("pnpm-over-npm", "Previously used npm, now standardized on pnpm", "correction", 0.45, ["pnpm"]),
    ("typed-schemas", "Prefers typed schemas in API responses", "preference", 0.45, []),
    ("no-abbreviations", "Avoids abbreviations in documentation", "preference", 0.35, []),

    # ── Goals / project state / solutions (mixed importance) ─────────────────
    ("goal-microservices", "Migrate the monolith to microservices by Q3", "goal", 0.8, []),
    ("goal-latency", "Reduce p99 latency below 100 milliseconds", "goal", 0.7, []),
    ("state-beta", "Currently in beta phase", "project_state", 0.6, []),
    ("state-migration-blocker", "Main blocker is the database migration", "project_state", 0.6, []),
    ("solution-memleak", "Resolved the memory leak with a connection pool", "solution", 0.6, []),
    ("correction-wed-fri", "Previously deployed on Wednesdays, now on Fridays", "correction", 0.5, []),

    # ── Security / operations ───────────────────────────────────────────────
    ("no-secrets-in-logs", "Never log secrets or credentials", "constraint", 0.75, []),
    ("rotate-keys-monthly", "Rotate API keys every month", "instruction", 0.6, []),
    ("no-weekend-deploys", "No production deploys on weekends", "constraint", 0.7, []),
    ("blue-green-deploy", "Uses blue-green deployment strategy", "decision", 0.65, []),
    ("outage-fix", "Resolved the billing outage with a circuit breaker", "solution", 0.6, []),
    ("redis-cache", "Uses Redis for caching hot data", "factual", 0.65, ["Redis"]),

    # ── Testing / documentation ─────────────────────────────────────────────
    ("jest-unit-tests", "Standardized on Jest for unit tests", "decision", 0.7, ["Jest"]),
    ("coverage-80", "Requires 80 percent test coverage", "constraint", 0.65, []),
    ("tdd-approach", "Prefers test-driven development", "preference", 0.5, []),
    ("readme-required", "Every repository must have a README", "instruction", 0.6, []),
    ("document-apis", "Document public APIs with examples", "instruction", 0.6, []),

    # ── Integrations ────────────────────────────────────────────────────────
    ("stripe-api", "Payment processing uses the Stripe API", "factual", 0.7, ["Stripe"]),
    ("sendgrid-email", "Transactional email uses SendGrid", "factual", 0.6, ["SendGrid"]),

    # ── More preferences / workflows / corrections ──────────────────────────
    ("async-first", "Prefers asynchronous communication over meetings", "preference", 0.4, []),
    ("standup-daily", "Daily standup happens at 9am", "workflow", 0.5, []),
    ("pr-small", "Prefers pull requests under 300 lines", "preference", 0.45, []),
    ("node-to-go", "Previously used Node.js for services, now Go", "correction", 0.5, ["Node.js", "Go"]),
    ("goal-multi-region", "Goal: deploy to multiple regions by end of year", "goal", 0.65, []),
    ("state-production", "The billing service is in production", "project_state", 0.6, []),
    ("state-migrating-auth", "Currently migrating the auth service", "project_state", 0.55, []),
    ("bundle-size-goal", "Goal: keep the frontend bundle under 100 kilobytes", "goal", 0.6, []),
]

slug_to_id = {}
count = 0
for slug, content, memory_type, importance, entities in MEMORIES:
    r = requests.post(BASE + "/v1/memory", headers=H, json={
        "project": "default",
        "content": content,
        "memory_type": memory_type,
        "user_id": USER,
        "importance": importance,
        "entity_mentions": entities,
        "write_mode": "sync",
    }, timeout=60)
    if r.status_code in (200, 201):
        body = r.json()
        mid = (body.get("memory") or {}).get("id") or body.get("memory_id")
        if mid:
            slug_to_id[slug] = mid
            count += 1
    else:
        print(f"FAIL {slug}: {r.status_code} {r.text[:120]}")

os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
with open(MAP_PATH, "w") as f:
    json.dump({"user": USER, "slugs": slug_to_id}, f, indent=2)

print(f"\nSeeded {count}/{len(MEMORIES)} working memories for {USER}")
print(f"Memory map written to {MAP_PATH}")
