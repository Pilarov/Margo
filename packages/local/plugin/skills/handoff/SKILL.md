---
name: handoff
description: Resume or transfer the current coding session with RetainDB Local context.
argument-hint: "[optional topic or session id]"
user-invocable: true
---

The user wants to resume or hand off work. Optional argument: $ARGUMENTS

Use these MCP tools:
- `memory_sessions` to inspect recent session-scoped memories.
- `memory_smart_search` to retrieve decisions, constraints, failures, and next steps for the topic.
- `handoff` when the user wants a durable handoff packet for another agent.

Summarize:
- What was being done.
- Key decisions and constraints.
- Files or systems touched.
- Known failures or pending next steps.

Only use returned memory. Do not invent session details.
