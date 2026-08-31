// E2E: multi-provider LLM config
// Run (from packages/server):
//   node --import tsx/esm src/e2e-llm-provider.ts
//
// Requires env:
//   OPENAI_API_KEY, OPENAI_BASE_URL       (global defaults)
//   LLM_EXTRACTION_MODEL/API_KEY/BASE_URL (per-task extraction)
//   LLM_RERANK_MODEL/API_KEY/BASE_URL     (per-task rerank)

import { llm } from "./config.js";
import { getLLMClient } from "./engine/llm-client.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`[${mark}] ${name}${detail ? " — " + detail : ""}`);
}

console.log("=== E2E-1: Multi-provider config resolution ===\n");

// Global defaults
check("global defaultApiKey is set", !!llm.defaultApiKey);
check("global defaultBaseUrl is set", !!llm.defaultBaseUrl, String(llm.defaultBaseUrl));

// Per-task extraction
check("extraction.model set", !!llm.extraction.model, llm.extraction.model);
check("extraction.baseUrl set or falls back", !!(llm.extraction.baseUrl || llm.defaultBaseUrl));

// Per-task rerank
check("rerank.model set", !!llm.rerank.model, llm.rerank.model);

// All 18 tasks have a model
const tasks = [
  "extraction", "queryExpansion", "rerank", "sourceProfile", "compressor",
  "oracle", "synthesis", "pageExtractor", "researchAgent", "taskRunner",
  "videoStt", "memoryExtraction", "consolidation", "dialectic", "inference",
  "sessionSummary", "relation", "temporal",
];
for (const t of tasks) {
  const task = (llm as any)[t];
  check(`task ${t} has model`, !!task?.model, task?.model);
}

console.log("\n=== E2E-2: getLLMClient resolves provider correctly ===\n");

// extraction client should use its baseUrl or global default
const extractionClient = getLLMClient(llm.extraction);
check(
  "extraction client baseURL matches config",
  extractionClient.baseURL === (llm.extraction.baseUrl || llm.defaultBaseUrl),
  extractionClient.baseURL
);

// rerank client should use its own (or global)
const rerankClient = getLLMClient(llm.rerank);
check(
  "rerank client baseURL matches config",
  rerankClient.baseURL === (llm.rerank.baseUrl || llm.defaultBaseUrl),
  rerankClient.baseURL
);

// same provider → same cached instance
const again = getLLMClient(llm.extraction);
check("client caching (same instance)", again === extractionClient);

console.log("\n=== E2E-3: Real LLM call through getLLMClient ===\n");

try {
  const res = await extractionClient.chat.completions.create({
    model: llm.extraction.model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_tokens: 50,
    temperature: 0,
  });
  const content = res.choices?.[0]?.message?.content?.trim() ?? "";
  check("LLM call succeeded", res.choices?.length > 0, `model=${res.model}`);
  check("LLM returned non-empty content", content.length > 0, `"${content}"`);
  check(
    "LLM model matches configured extraction model",
    res.model === llm.extraction.model,
    `expected=${llm.extraction.model} got=${res.model}`
  );
  console.log(`   tokens: ${res.usage?.total_tokens} (reasoning=${res.usage?.completion_tokens_details?.reasoning_tokens ?? 0}, content=${res.usage?.completion_tokens ?? 0})`);
} catch (err: any) {
  failures += 1;
  console.log(`[FAIL] LLM call threw: ${err?.message}`);
}

console.log(`\n=== RESULT: ${failures === 0 ? "ALL E2E CHECKS PASSED" : failures + " CHECKS FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
