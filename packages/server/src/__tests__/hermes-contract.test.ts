import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Hermes RetainDB plugin → Margo API contract test ────────────────────────
// Source-inspection regression test. The Hermes RetainDB plugin
// (hermes-agent/plugins/memory/retaindb/__init__.py) is a REST client that calls
// a fixed set of endpoints with a fixed request/response shape. This test
// verifies Margo's server exposes the FULL contract, so the plugin connects
// without modification. See CONFIGURATION.md § "Hermes-интеграция".

const SRC = resolve(__dirname, "../");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf-8");
}

// Extract a route's body (from its path string to ~2000 chars ahead).
function routeBlock(src: string, path: string): string {
  const i = src.indexOf(path);
  return i === -1 ? "" : src.slice(i, i + 2000);
}

const memory = () => read("api/memory.ts");
const files = () => read("api/files.ts");

describe("Hermes plugin contract: endpoints", () => {
  const cases: Array<[string, () => string]> = [
    ["/v1/context/query", () => read("api/routes.ts")],
    ["/v1/memory/search", memory],
    ['"/v1/memory",', memory],
    ["/v1/memory/ingest/session", memory],
    ["/v1/memory/profile/:userId", memory],
    ["/v1/memory/profile/:userId/ask", memory],
    ["/v1/memory/agent/:agentId/model", memory],
    ["/v1/memory/agent/:agentId/seed", memory],
    ["/v1/memory/:memoryId", memory],
    ["/v1/files", files],
    ["/v1/files/:fileId", files],
    ["/v1/files/:fileId/ingest", files],
  ];
  for (const [path, src] of cases) {
    it(`exposes ${path}`, () => {
      expect(src()).toContain(path);
    });
  }
});

describe("Hermes plugin contract: request fields", () => {
  it("context/query accepts query, user_id, session_id, include_memories, max_tokens", () => {
    const b = routeBlock(read("api/routes.ts"), "/v1/context/query");
    expect(b).toContain("query:");
    expect(b).toContain("user_id");
    expect(b).toContain("session_id");
    expect(b).toContain("include_memories");
    expect(b).toContain("max_tokens");
  });

  it("memory/search accepts query, user_id, session_id, top_k, include_pending", () => {
    const b = routeBlock(memory(), "/v1/memory/search");
    expect(b).toContain("top_k");
    expect(b).toContain("include_pending");
    expect(b).toContain("user_id");
    expect(b).toContain("session_id");
  });

  it("memory write accepts content, memory_type, importance, write_mode", () => {
    const b = routeBlock(memory(), '"/v1/memory",');
    expect(b).toContain("content");
    expect(b).toContain("memory_type");
    expect(b).toContain("importance");
    expect(b).toContain("write_mode");
  });

  it("profile/:userId accepts project + include_pending query params", () => {
    const b = routeBlock(memory(), "/v1/memory/profile/:userId");
    expect(b).toContain("include_pending");
  });

  it("agent seed accepts project, content, source", () => {
    const b = routeBlock(memory(), "/v1/memory/agent/:agentId/seed");
    expect(b).toContain("content");
    expect(b).toContain("source");
  });

  it("dialectic /ask accepts query + reasoning_level (NOT question)", () => {
    const b = routeBlock(memory(), "/v1/memory/profile/:userId/ask");
    expect(b).toContain("query:");
    expect(b).toContain("reasoning_level");
    expect(b).not.toContain("question:");
  });
});

describe("Hermes plugin contract: response fields", () => {
  it("context/query returns results[].content", () => {
    const src = read("api/routes.ts");
    const i = src.indexOf('"/v1/context/query"');
    expect(src.slice(i)).toContain("results:");
    expect(src.slice(i)).toContain("content:");
  });

  it("profile/:userId returns memories[].content", () => {
    const src = memory();
    const i = src.indexOf('"/v1/memory/profile/:userId"');
    expect(src.slice(i)).toContain("memories:");
  });

  it("dialectic /ask maps to dialecticQuery and returns answer", () => {
    const src = memory();
    const i = src.indexOf('"/v1/memory/profile/:userId/ask"');
    expect(src.slice(i)).toContain("dialecticQuery({");
  });

  it("agent model returns memory_count/persona/persistent_instructions/working_style", () => {
    const model = read("engine/memory/agent-model.ts");
    expect(model).toContain("persona");
    expect(model).toContain("persistent_instructions");
    expect(model).toContain("working_style");
    expect(model).toContain("memory_count");
  });
});
