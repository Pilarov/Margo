---
name: recall
description: Search RetainDB Local for past observations, sessions, and learnings about a topic.
argument-hint: "[search query]"
user-invocable: true
---

The user wants to recall past context about: $ARGUMENTS

Use the `memory_smart_search` MCP tool with the user's query and `limit: 10`.

Present only returned results:
- Group by session when session metadata is present.
- Show the memory type, score, and concise content.
- Highlight decisions, constraints, corrections, and workflow memories first.
- If nothing returns, suggest 2-3 narrower search terms.

Do not invent memories. If `memory_smart_search` is missing, tell the user to start RetainDB Local and reconnect MCP:

```bash
npx -y @retaindb/local
RETAINDB_BASE_URL=http://localhost:3111 npx -y @retaindb/mcp
```
