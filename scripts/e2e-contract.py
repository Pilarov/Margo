#!/usr/bin/env python3
"""E2E smoke test for the RetainDB/Hermes plugin contract.

Verifies the 15 endpoints the Hermes `retaindb` MemoryProvider calls, with the
exact request shapes from the plugin's `_Client` class, and checks response shapes.

Requires a running Margo server (Postgres + embeddings + LLM configured).

Usage:
    RETAINDB_BASE_URL=http://localhost:3000 RETAINDB_API_KEY=margo-test-key python3 scripts/e2e-contract.py

Exits 0 when all checks pass, 1 otherwise.
"""
import io
import json
import os
import sys

import requests

BASE = os.environ.get("RETAINDB_BASE_URL", "http://localhost:3000").rstrip("/")
KEY = os.environ.get("RETAINDB_API_KEY", "margo-test-key")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
PROJECT = os.environ.get("RETAINDB_PROJECT", "default")
USER = "e2e-user"
SESSION = "e2e-session-1"
AGENT = "e2e-agent"

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail and not ok else ""))


def post(path, body, timeout=30):
    return requests.post(BASE + path, json=body, headers=H, timeout=timeout)

def get(path, **params):
    return requests.get(BASE + path, headers=H, params=params, timeout=30)

def delete(path):
    return requests.delete(BASE + path, headers=H, timeout=30)


# 0. Auth gate
r = requests.post(BASE + "/v1/memory/search", json={"query": "x"}, timeout=10)
check("auth: 401 without key", r.status_code == 401, f"got {r.status_code}")

# 1. POST /v1/context/query
r = post("/v1/context/query", {
    "project": PROJECT, "query": "hello", "user_id": USER,
    "session_id": SESSION, "include_memories": True, "max_tokens": 1200,
})
body = r.json()
check("context/query 200 + results[]", r.status_code == 200 and isinstance(body.get("results"), list),
      f"got {r.status_code} {str(body)[:120]}")

# 2. POST /v1/memory/search
r = post("/v1/memory/search", {
    "project": PROJECT, "query": "hello", "user_id": USER,
    "session_id": SESSION, "top_k": 8, "include_pending": True,
})
body = r.json()
check("memory/search 200 + results[]", r.status_code == 200 and isinstance(body.get("results"), list),
      f"got {r.status_code} {str(body)[:120]}")

# 3. GET /v1/memory/profile/:userId
r = get(f"/v1/memory/profile/{USER}", project=PROJECT, include_pending="true")
body = r.json()
check("profile 200 + memories[]", r.status_code == 200 and isinstance(body.get("memories"), list),
      f"got {r.status_code} {str(body)[:120]}")

# 4. POST /v1/memory (write sync)
r = post("/v1/memory", {
    "project": PROJECT, "content": "The user prefers short, concise answers.",
    "memory_type": "preference", "user_id": USER, "session_id": SESSION,
    "importance": 0.7, "write_mode": "sync",
})
body = r.json()
ok = r.status_code in (200, 201) and body.get("success") is True and (body.get("memory_id") or body.get("job_id"))
check("memory write (sync) 201/200 + id", ok, f"got {r.status_code} {str(body)[:160]}")
memory_id = (body.get("memory") or {}).get("id") or body.get("memory_id")

# 5. GET profile again — should now contain the memory
r = get(f"/v1/memory/profile/{USER}", project=PROJECT)
body = r.json()
mem = (body.get("memories") or [])
check("profile returns written memory", r.status_code == 200 and any("concise" in (m.get("content") or "") for m in mem),
      f"memories={len(mem)}")

# 6. POST /v1/memory/ingest/session
r = post("/v1/memory/ingest/session", {
    "project": PROJECT, "session_id": SESSION, "user_id": USER,
    "messages": [
        {"role": "user", "content": "I like building in TypeScript.", "timestamp": "2026-08-31T12:00:00Z"},
        {"role": "assistant", "content": "Noted, I'll keep that in mind.", "timestamp": "2026-08-31T12:00:01Z"},
    ],
    "write_mode": "sync",
})
body = r.json()
ok = r.status_code in (200, 201, 202) and body.get("success") is True
check("ingest/session 2xx + success", ok, f"got {r.status_code} {str(body)[:160]}")

# 7. POST /v1/memory/profile/:userId/ask  (dialectic — needs LLM)
r = post(f"/v1/memory/profile/{USER}/ask", {
    "project": PROJECT, "query": "What does this user prefer?", "reasoning_level": "low",
})
body = r.json()
ok = r.status_code == 200 and isinstance(body.get("answer"), str)
check("dialectic /ask 200 + answer", ok, f"got {r.status_code} {str(body)[:160]}")

# 8. GET /v1/memory/agent/:id/model
r = get(f"/v1/memory/agent/{AGENT}/model", project=PROJECT)
body = r.json()
ok = r.status_code == 200 and "memory_count" in body
check("agent model 200 + memory_count", ok, f"got {r.status_code} {str(body)[:160]}")

# 9. POST /v1/memory/agent/:id/seed
r = post(f"/v1/memory/agent/{AGENT}/seed", {
    "project": PROJECT, "content": "I am a helpful assistant that values clarity.",
    "source": "soul_md",
})
body = r.json()
ok = r.status_code in (200, 201, 202)
check("agent seed 2xx", ok, f"got {r.status_code} {str(body)[:160]}")

# 10. POST /v1/files (upload)
r = requests.post(
    BASE + "/v1/files",
    files={"file": ("notes.txt", io.BytesIO(b"Hello from e2e test"), "text/plain")},
    data={"path": "/e2e/notes.txt", "scope": "PROJECT"},
    headers={"Authorization": f"Bearer {KEY}"},
    timeout=30,
)
body = r.json()
ok = r.status_code in (200, 201) and (body.get("file") or {}).get("id") or body.get("id")
check("files upload 2xx + id", ok, f"got {r.status_code} {str(body)[:160]}")
file_id = (body.get("file") or {}).get("id") or body.get("id")

# 11. GET /v1/files (list)
r = get("/v1/files", limit=50)
body = r.json()
check("files list 200", r.status_code == 200, f"got {r.status_code} {str(body)[:160]}")

if file_id:
    # 12. GET /v1/files/:fileId
    r = get(f"/v1/files/{file_id}")
    body = r.json()
    check("files metadata 200", r.status_code == 200, f"got {r.status_code} {str(body)[:160]}")

    # 13. GET /v1/files/:fileId/content
    r = requests.get(BASE + f"/v1/files/{file_id}/content", headers={"Authorization": f"Bearer {KEY}"}, timeout=30)
    check("files content 200", r.status_code == 200, f"got {r.status_code}")

    # 14. POST /v1/files/:fileId/ingest
    r = post(f"/v1/files/{file_id}/ingest", {"user_id": USER, "agent_id": AGENT}, timeout=60)
    body = r.json()
    check("files ingest 2xx", r.status_code in (200, 201, 202), f"got {r.status_code} {str(body)[:160]}")

    # 15. DELETE /v1/files/:fileId
    r = delete(f"/v1/files/{file_id}")
    check("files delete 2xx", r.status_code in (200, 204), f"got {r.status_code}")
else:
    check("files metadata 200", False, "no file_id from upload")
    check("files content 200", False, "no file_id")
    check("files ingest 2xx", False, "no file_id")
    check("files delete 2xx", False, "no file_id")

# 5b. DELETE /v1/memory/:id
if memory_id:
    r = delete(f"/v1/memory/{memory_id}")
    check("memory delete 2xx", r.status_code in (200, 204), f"got {r.status_code}")
else:
    check("memory delete 2xx", False, "no memory_id")

passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f"\n===== {passed}/{total} passed =====")
sys.exit(0 if passed == total else 1)
