import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── LLM wiring regression test ──────────────────────────────────────────────
// Verifies each LLM call site is wired to the CORRECT task config. This is a
// source-inspection test: it reads the actual files and asserts the
// `getLLMClient(llmCfg.<task>)` pattern, catching typos, wrong task names,
// and accidental reversions to the old flat `llmCfg.<task>Model` scheme.
//
// This complements (not replaces) the behavioral E2E test.

const SRC = resolve(__dirname, "../../");

interface WiringSpec {
  file: string;          // relative to packages/server/src
  expectedTask: string;  // llmCfg.<expectedTask>
  callSites: number;     // minimum expected getLLMClient(llmCfg.X) occurrences
}

const WIRING: WiringSpec[] = [
  { file: "engine/extractor.ts", expectedTask: "extraction", callSites: 2 },
  { file: "engine/synthesis.ts", expectedTask: "synthesis", callSites: 1 },
  { file: "engine/oracle.ts", expectedTask: "oracle", callSites: 2 },
  { file: "engine/compressor.ts", expectedTask: "compressor", callSites: 3 },
  { file: "engine/source-extraction.ts", expectedTask: "sourceProfile", callSites: 1 },
  { file: "engine/page-extractor.ts", expectedTask: "pageExtractor", callSites: 2 },
  { file: "engine/task-runner.ts", expectedTask: "taskRunner", callSites: 2 },
  { file: "engine/retriever.ts", expectedTask: "queryExpansion", callSites: 1 },
  { file: "engine/retriever.ts", expectedTask: "rerank", callSites: 1 },
  { file: "api/research-agent.ts", expectedTask: "researchAgent", callSites: 3 },
  { file: "engine/memory/consolidation.ts", expectedTask: "consolidation", callSites: 1 },
  { file: "engine/memory/dialectic.ts", expectedTask: "dialectic", callSites: 1 },
  { file: "engine/memory/extractor.ts", expectedTask: "memoryExtraction", callSites: 1 },
  { file: "engine/memory/extractor-onepass.ts", expectedTask: "memoryExtraction", callSites: 1 },
  { file: "engine/memory/inference.ts", expectedTask: "inference", callSites: 1 },
  { file: "engine/memory/relations.ts", expectedTask: "relation", callSites: 1 },
  { file: "engine/memory/temporal.ts", expectedTask: "temporal", callSites: 1 },
  { file: "engine/memory/session-lifecycle.ts", expectedTask: "sessionSummary", callSites: 1 },
];

function readSource(rel: string): string {
  return readFileSync(join(SRC, rel), "utf-8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("LLM wiring: each call site uses the correct task config", () => {
  for (const spec of WIRING) {
    it(`${spec.file} → getLLMClient(llmCfg.${spec.expectedTask})`, () => {
      const src = readSource(spec.file);
      const pattern = `getLLMClient(llmCfg.${spec.expectedTask})`;
      const count = countOccurrences(src, pattern);
      expect(count, `${spec.file} should call ${pattern} at least ${spec.callSites}×`).toBeGreaterThanOrEqual(spec.callSites);
    });
  }

  it("no file uses the old flat llmCfg.<task>Model pattern", () => {
    for (const spec of WIRING) {
      const src = readSource(spec.file);
      expect(countOccurrences(src, /llmCfg\.\w+Model/.source), `${spec.file} has legacy llmCfg.XModel`).toBe(0);
    }
  });

  it("only cost-optimization.ts may call getLLMClient() without argument", () => {
    for (const spec of WIRING) {
      const src = readSource(spec.file);
      // count bare getLLMClient() (no following argument)
      const bare = src.match(/getLLMClient\(\)/g)?.length ?? 0;
      expect(bare, `${spec.file} has bare getLLMClient() call`).toBe(0);
    }
  });

  it("cost-optimization.ts still uses bare getLLMClient() (intentional)", () => {
    const src = readSource("engine/cost-optimization.ts");
    expect(src).toContain("getLLMClient()");
  });

  it("video.ts uses llmCfg.videoStt model + baseUrl (uses new OpenAI directly for STT)", () => {
    const src = readSource("connectors/video.ts");
    expect(src).toContain("llmCfg.videoStt.model");
    expect(src).toContain("llmCfg.videoStt.baseUrl");
  });
});
