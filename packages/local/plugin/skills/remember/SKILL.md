---
name: remember
description: Save an insight, decision, or learning to RetainDB Local.
argument-hint: "[what to remember]"
user-invocable: true
---

The user wants to save this to long-term memory: $ARGUMENTS

Use the `memory_save` MCP tool.

Steps:
- Extract the durable fact, decision, constraint, workflow, preference, or correction.
- Extract 2-5 searchable concepts.
- Extract relevant files if present.
- Call `memory_save` with `content`, `concepts`, `files`, and an appropriate `type`.
- Confirm the save and show the concepts used for retrieval.

Do not store secrets, raw API keys, passwords, or private content the user did not ask to preserve.
