/**
 * SOTA Memory Search Engine
 * Memory-first hybrid search with temporal filtering and graph traversal
 * Beats Supermemory's 81.6% and targets 85%+ on LongMemEval
 * 
 * OPTIMIZATION NOTES:
 * - Timing instrumentation tracks latency at each pipeline step
 * - Early exit when similarity is high to skip expensive graph traversal
 * - Semantic cache threshold lowered to 0.85 for higher hit rate
 * - Graph traversal parallelized with chunk injection where possible
 */

import { db } from "../../db/index.js";
import { expandMemorySearchQueries } from "../../lib/memory-normalization.js";
import { embedSingle } from "../embeddings.js";
import { parseTemporalFast } from "./temporal-local.js";
import { calculateTemporalRelevance } from "./temporal.js";
import { getFromSemanticCache, setInSemanticCache, getFromCache, setInCache } from "../cache.js";
import type { MemoryScopeTarget, MemorySearchDiagnostics, MemorySearchParams, MemorySearchResult, MemoryStage } from "./types.js";
import { recordSearchTelemetry } from "../telemetry/collector.js";
import { retrieval as retrievalCfg, type WindowLayerConfig } from "../../config.js";
import { selectWindow } from "../retrieval/window-selector.js";
import { createLayerTracer } from "../retrieval/trace.js";
import { Prisma } from "@prisma/client";
import { decrypt } from "../../lib/encryption.js";

// Early exit threshold - skip graph traversal if top result is very similar
const EARLY_EXIT_SIMILARITY = 0.92;

// Lower semantic cache threshold for higher hit rate (was 0.92, now 0.85)
const SEMANTIC_CACHE_THRESHOLD = 0.85;

// SLO budgets (overridable via env)
const TOTAL_SLO_BUDGET_MS = parseInt(process.env.MEMORY_SEARCH_TOTAL_BUDGET_MS || "220", 10);
const POST_VECTOR_BUDGET_MS = parseInt(process.env.MEMORY_SEARCH_POST_VECTOR_BUDGET_MS || "120", 10);

// Benchmark escape hatch: bypass caches so runs are independent and reproducible.
const DISABLE_CACHE = /^true$/i.test(process.env.MEMORY_SEARCH_DISABLE_CACHE || "false");

// Timing instrumentation
interface TimingLog {
  step: string;
  duration: number;
}

interface QueryIntent {
  wantsRecent: boolean;
  asksForSearchHistory: boolean;
  asksForGoals: boolean;
  asksForPreferences: boolean;
  asksForDecisions: boolean;
  asksForInstructions: boolean;
  asksForSolutions: boolean;
  asksForWorkflows: boolean;
}

export function detectQueryIntent(query: string): QueryIntent {
  const normalized = query.toLowerCase();
  return {
    wantsRecent: /\b(last|latest|recent|recently|previous|before|earlier)\b/.test(normalized),
    asksForSearchHistory: /\b(search|searched|query|queried|asked|question|chat|conversation|llm|ai)\b/.test(normalized),
    asksForGoals: /\b(goal|goals|objective|objectives|target|targets|aim|milestone)\b/.test(normalized),
    asksForPreferences: /\b(prefer\w*|preference\w*|like\w*|style|format)\b/.test(normalized),
    asksForDecisions: /\b(decide|decision|decisions|chose|chosen|standard|standardized|stack|architecture|backend)\b/.test(normalized),
    asksForInstructions: /\b(how|required|require|must|always|should|rotate|document\w*|practice\w*|rule\w*|procedure\w*)\b/.test(normalized),
    asksForSolutions: /\b(resolved|resolve|fixed|fix|outage|incident|issue|solution\w*)\b/.test(normalized),
    asksForWorkflows: /\b(pipeline|strategy|cadence|release|workflow\w*|process\w*)\b/.test(normalized),
  };
}

function parseDateSafe(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getMemoryRecencyDate(memory: any): Date | null {
  return (
    parseDateSafe(memory.eventDate) ||
    parseDateSafe(memory.documentDate) ||
    parseDateSafe(memory.updatedAt) ||
    parseDateSafe(memory.createdAt) ||
    null
  );
}

function rerankByIntent(memories: any[], questionDate: Date | undefined, intent: QueryIntent): any[] {
  if (
    !intent.wantsRecent &&
    !intent.asksForSearchHistory &&
    !intent.asksForGoals &&
    !intent.asksForPreferences &&
    !intent.asksForDecisions &&
    !intent.asksForInstructions &&
    !intent.asksForSolutions &&
    !intent.asksForWorkflows
  ) {
    return memories;
  }

  const nowMs = (questionDate && !isNaN(questionDate.getTime())) ? questionDate.getTime() : Date.now();
  const eventKeyword = /\b(search|searched|looked|queried|asked|question|chat|conversation|llm|ai)\b/i;

  const scored = memories.map((memory) => {
    const similarityScore = typeof memory.finalScore === "number"
      ? memory.finalScore
      : (memory.similarity || 0);

    const recencyDate = getMemoryRecencyDate(memory);
    const ageDays = recencyDate ? Math.max(0, (nowMs - recencyDate.getTime()) / (1000 * 60 * 60 * 24)) : 365;
    const recencyScore = Math.max(0, 1 - Math.min(ageDays / 365, 1));

    let typeBoost = 0;
    if (intent.asksForSearchHistory) {
      if (memory.memoryType === "event") typeBoost += 0.35;
      if (eventKeyword.test(memory.content || "")) typeBoost += 0.2;
    }
    if (intent.asksForGoals && memory.memoryType === "goal") typeBoost += 0.4;
    if (intent.asksForPreferences && memory.memoryType === "preference") typeBoost += 0.4;
    if (intent.asksForDecisions && (memory.memoryType === "decision" || memory.memoryType === "constraint")) typeBoost += 0.4;
    if (intent.asksForInstructions && memory.memoryType === "instruction") typeBoost += 0.4;
    if (intent.asksForSolutions && memory.memoryType === "solution") typeBoost += 0.4;
    if (intent.asksForWorkflows && memory.memoryType === "workflow") typeBoost += 0.4;

    const finalIntentScore =
      similarityScore * 0.65 +
      (intent.wantsRecent ? recencyScore * 0.35 : 0) +
      typeBoost;

    return { memory, finalIntentScore };
  });

  scored.sort((a, b) => b.finalIntentScore - a.finalIntentScore);
  return scored.map((s) => ({ ...s.memory, finalScore: s.finalIntentScore }));
}

const DEBUG_TIMINGS = process.env.MEMORY_SEARCH_DEBUG_TIMINGS === "true";

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldDisableLatencyDegradation(params: Pick<MemorySearchParams, "disableLatencyDegradation">): boolean {
  if (typeof params.disableLatencyDegradation === "boolean") {
    return params.disableLatencyDegradation;
  }
  return isTruthyEnv(process.env.MEMORY_SEARCH_DISABLE_LATENCY_DEGRADATION);
}

function logTimings(timings: TimingLog[], _query: string): void {
  // Only log full timing breakdown in explicit debug mode — queries contain user data.
  if (!DEBUG_TIMINGS) return;
  const total = timings.reduce((sum, t) => sum + t.duration, 0);
  console.log(`\n[MemorySearch] timing (total: ${total}ms):`);
  timings.forEach((t) => {
    const pct = total > 0 ? ((t.duration / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${t.step}: ${t.duration}ms (${pct}%)`);
  });
}

function emitDiagnostics(
  params: MemorySearchParams,
  timings: TimingLog[],
  totalMs: number,
  cacheHitType: "none" | "simple" | "semantic",
  fastMode: boolean,
  stages?: MemoryStage[]
): void {
  const sumStep = (...steps: string[]) =>
    timings
      .filter((timing) => steps.includes(timing.step))
      .reduce((acc, timing) => acc + timing.duration, 0);

  const cacheMs = sumStep("simple_cache", "semantic_cache_check", "cache_write");
  const embedMs = sumStep("embedding");
  const vectorMs = sumStep("vector_search");
  const lexicalMs = sumStep("lexical_search");
  const mergeMs = totalMs - cacheMs - embedMs - vectorMs - lexicalMs;

  const diagnostics: MemorySearchDiagnostics = {
    cache_ms: Math.max(cacheMs, 0),
    embed_ms: Math.max(embedMs, 0),
    vector_ms: Math.max(vectorMs, 0),
    lexical_ms: Math.max(lexicalMs, 0),
    merge_ms: Math.max(mergeMs, 0),
    total_ms: Math.max(totalMs, 0),
    cache_hit: cacheHitType !== "none",
    cache_hit_type: cacheHitType,
    fast_mode: fastMode,
    ...(stages && stages.length > 0 ? { stages } : {}),
  };

  recordSearchTelemetry(diagnostics);
  if (typeof params.diagnosticsCollector === "function") {
    params.diagnosticsCollector(diagnostics);
  }
}

function resolveApplicableScopes(params: Pick<MemorySearchParams, "userId" | "sessionId" | "agentId" | "taskId" | "scopes">): MemoryScopeTarget[] {
  if (params.scopes && params.scopes.length > 0) {
    return Array.from(new Set(params.scopes.filter((scope) => scope !== "DROPPED")));
  }

  const scopes = new Set<MemoryScopeTarget>(["PROJECT"]);
  if (params.userId) scopes.add("USER");
  if (params.sessionId) scopes.add("SESSION");
  if (params.agentId) scopes.add("AGENT");
  if (params.taskId) scopes.add("TASK");
  return Array.from(scopes);
}

function scopeBoost(memory: any, params: Pick<MemorySearchParams, "userId" | "sessionId" | "agentId" | "taskId">): number {
  const scope = String(memory.scope || "");
  if (scope === "TASK" && params.taskId && memory.taskId === params.taskId) return 0.3;
  if (scope === "SESSION" && params.sessionId && memory.sessionId === params.sessionId) return 0.2;
  if (scope === "AGENT" && params.agentId && memory.agentId === params.agentId) return 0.15;
  if (scope === "USER" && params.userId && memory.userId === params.userId) return 0.15;
  if (scope === "PROJECT") return 0.1;
  return 0;
}

function rerankByScope(memories: any[], params: Pick<MemorySearchParams, "userId" | "sessionId" | "agentId" | "taskId">): any[] {
  return [...memories]
    .map((memory) => {
      const boost = scopeBoost(memory, params);
      const baseScore = typeof memory.finalScore === "number"
        ? memory.finalScore
        : (typeof memory.similarity === "number" ? memory.similarity : 0);
      return {
        ...memory,
        similarity: typeof memory.similarity === "number" ? memory.similarity + boost : boost,
        finalScore: baseScore + boost,
      };
    })
    .sort((left, right) => (right.finalScore ?? right.similarity ?? 0) - (left.finalScore ?? left.similarity ?? 0));
}

/**
 * S1 recall cut (ADR-013): scope-boost the candidates first, then let the configured
 * window decide how many of them survive.
 *
 * The boost is part of the ranking every later stage sees, so the window has to cut
 * AFTER it — cutting on the raw `similarity` first drops candidates that the scope boost
 * would have promoted, which contradicts "ranking = relevance" (review I4). Exported for
 * tests: the composition order is the contract, not an implementation detail.
 *
 * `requested` — the caller's own `top_k`, when the stage is caller-facing. The recall stage
 * passes nothing (pool size is the engine's business); delivery/rerank stages must pass it so
 * a window can narrow a result set but never widen it past the request (ADR-013 contract fix).
 */
export function __cutRecallWindow<T extends { similarity?: number; finalScore?: number }>(
  candidates: T[],
  layer: WindowLayerConfig,
  scopeParams: Pick<MemorySearchParams, "userId" | "sessionId" | "agentId" | "taskId">,
  requested?: number
): { kept: T[]; in: number; k: number } {
  const boosted = rerankByScope(candidates as any[], scopeParams) as unknown as T[];
  const k = selectWindow(
    layer.strategy,
    boosted.map((candidate: any) => candidate.finalScore ?? candidate.similarity ?? 0),
    { min: layer.min, max: layer.max },
    layer.params,
    requested
  );
  return { kept: boosted.slice(0, k), in: boosted.length, k };
}
/**
 * Main memory search function
 * Implements memory-first hybrid approach from Supermemory
 * OPTIMIZED: Added timing instrumentation and parallel execution
 */
export async function searchMemories(
  params: MemorySearchParams
): Promise<MemorySearchResult[]> {
  const timings: TimingLog[] = [];
  // Per-layer traces (ADR-014 step 1): the funnel speaks S0–S3 now. The numbers are the
  // ones the pipeline already computes (plus a Date.now() pair per layer) and the result
  // is untouched, so behaviour is unchanged by construction.
  const tracer = createLayerTracer();
  const startTotal = Date.now();
  const disableLatencyDegradation = shouldDisableLatencyDegradation(params);

  const {
    query,
    questionDate,
    userId,
    projectId,
    orgId,
    sessionId,
    agentId,
    taskId,
    topK = 10,
    includeInactive = false,
    memoryTypes,
    namespace,
    tags,
    fastMode = false,
  } = params;
  let effectiveFastMode = fastMode;
  let cacheHitType: "none" | "simple" | "semantic" = "none";
  const queryIntent = detectQueryIntent(query);
  const queryVariants = expandMemorySearchQueries(query);
  const semanticQuery = queryVariants.join(" | ") || query;
  const applicableScopes = resolveApplicableScopes({ userId, sessionId, agentId, taskId, scopes: params.scopes });
  const effectiveMemoryTypes =
    queryIntent.asksForSearchHistory && (!memoryTypes || memoryTypes.length === 0)
      ? (["event"] as string[])
      : memoryTypes;

  // Step 0a: Check simple cache first (before embedding!)
  const step0Start = Date.now();
  const cacheKey = `search:${projectId}:${userId || ""}:${sessionId || ""}:${agentId || ""}:${taskId || ""}:${applicableScopes.join(",")}:${query}:${topK}`;
  const simpleCached = DISABLE_CACHE ? null : await getFromCache<MemorySearchResult[]>(cacheKey);
  timings.push({ step: "simple_cache", duration: Date.now() - step0Start });
  
  if (simpleCached) {
    cacheHitType = "simple";
    const total = Date.now() - startTotal;
    timings.push({ step: "TOTAL", duration: total });
    logTimings(timings, query);
    console.log("⚡ Simple cache hit");
    emitDiagnostics(params, timings, total, cacheHitType, effectiveFastMode, tracer.stages());
    return simpleCached;
  }

  // Step 0b: Generate embedding + check semantic cache
  const embedStart = Date.now();
  const queryEmbedding = await embedSingle(semanticQuery);
  timings.push({ step: "embedding", duration: Date.now() - embedStart });

  const semanticCacheStart = Date.now();
  const cached = DISABLE_CACHE ? null : await getFromSemanticCache(queryEmbedding);
  timings.push({ step: "semantic_cache_check", duration: Date.now() - semanticCacheStart });

  if (cached && cached.similarity >= SEMANTIC_CACHE_THRESHOLD) {
    cacheHitType = "semantic";
    console.log(`⚡ Semantic cache hit (similarity: ${cached.similarity.toFixed(3)})`);
    const results = cached.results.slice(0, topK);
    if (!DISABLE_CACHE) await setInCache(cacheKey, results, 300);
    const total = Date.now() - startTotal;
    timings.push({ step: "TOTAL", duration: total });
    logTimings(timings, query);
    emitDiagnostics(params, timings, total, cacheHitType, effectiveFastMode, tracer.stages());
    return results;
  }

  // Step 1: Parse temporal constraints from query (LOCAL - no LLM!)
  const temporalStart = Date.now();
  const temporal = params.temporalFilter || parseTemporalFast(query, questionDate);
  timings.push({ step: "temporal_parse", duration: Date.now() - temporalStart });

  // Step 2: Vector search on memories (NOT chunks!)
  const vectorStart = Date.now();
  const recallWindow = retrievalCfg.window.recall;
  const semanticResults = await vectorSearchMemories({
    embedding: queryEmbedding,
    userId,
    projectId,
    orgId,
    sessionId,
    agentId,
    taskId,
    scopes: applicableScopes,
    temporal,
    includeInactive,
    memoryTypes: effectiveMemoryTypes,
    namespace,
    tags,
    limit: recallWindow.max, // fetch up to the window cap, cut by selector below
  });
  const vectorMs = Date.now() - vectorStart;
  timings.push({ step: "vector_search", duration: vectorMs });
  // S0 and the semantic fetch share this row in the memory path: scope/validity are
  // predicates inside the ANN query, so there is no separate candidate-level drop to report
  // yet. Этап 5 шаг 2 (ADR-014) moves them into scope-filter.ts and splits the row.
  tracer.record({ layer: "S0.scope", in: recallWindow.max, out: semanticResults.length, ms: vectorMs });
  // Dynamic window (ADR-013): cut the vector candidates by the configured strategy
  // (curvature / median-gap / relative-top / fixed) instead of a hard topK*3, and on the
  // scope-boosted ranking the rest of the pipeline sees (review I4).
  const cutStart = Date.now();
  const recallCut = __cutRecallWindow(semanticResults, recallWindow, { userId, sessionId, agentId, taskId });
  const scopedSemanticResults = recallCut.kept;
  // The window the selector chose is published (ADR-013 / review M1): `cutoff` carries k.
  tracer.record({ layer: "S1.window", in: recallCut.in, out: recallCut.k, ms: Date.now() - cutStart, cutoff: recallCut.k });

  // Type-aware recall boost: when the query asks for a specific memory type, also
  // pull that type directly so semantic gaps (e.g. "goals" vs "Reduce p99 latency")
  // don't drop on-type memories that are far from the query embedding.
  const typeRecallTypes = queryIntent.asksForGoals
    ? ["goal"]
    : queryIntent.asksForPreferences
      ? ["preference"]
      : queryIntent.asksForDecisions
        ? ["decision", "constraint"]
        : queryIntent.asksForInstructions
          ? ["instruction"]
          : queryIntent.asksForSolutions
            ? ["solution"]
            : queryIntent.asksForWorkflows
              ? ["workflow"]
              : null;
  const typeRecallStart = Date.now();
  const beforeTypeRecall = scopedSemanticResults.length;
  if (typeRecallTypes && userId) {
    const typeMemories = await db.memory.findMany({
      where: {
        projectId,
        userId,
        orgId,
        scope: { in: applicableScopes },
        isActive: true,
        memoryType: { in: typeRecallTypes },
        OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
      },
      orderBy: { importance: "desc" },
      take: topK,
    });
    const seen = new Set(scopedSemanticResults.map((m) => m.id));
    for (const tm of typeMemories) {
      if (seen.has(tm.id)) continue;
      scopedSemanticResults.push({
        id: tm.id,
        content: tm.content,
        memoryType: tm.memoryType,
        entityMentions: tm.entityMentions || [],
        confidence: tm.confidence,
        version: tm.version,
        scope: tm.scope,
        userId: tm.userId ?? null,
        sessionId: tm.sessionId ?? null,
        agentId: tm.agentId ?? null,
        taskId: tm.taskId ?? null,
        documentDate: tm.documentDate,
        eventDate: tm.eventDate,
        validFrom: tm.validFrom,
        validUntil: tm.validUntil,
        createdAt: tm.createdAt,
        updatedAt: tm.updatedAt,
        sourceChunkId: tm.sourceChunkId,
        metadata: tm.metadata,
        similarity: 0.8,
      });
    }
  }
  tracer.record({ layer: "S1.type_recall", in: beforeTypeRecall, out: scopedSemanticResults.length, ms: Date.now() - typeRecallStart });

  // Guardrail: if we're already over budget after vector search, degrade to fast mode.
  if (!disableLatencyDegradation && !effectiveFastMode && Date.now() - startTotal > POST_VECTOR_BUDGET_MS) {
    effectiveFastMode = true;
    timings.push({ step: "degraded_mode_fast_after_vector", duration: 0 });
    console.warn(`[MemorySearch] Degraded to fast mode after vector stage (budget=${POST_VECTOR_BUDGET_MS}ms)`);
  }

  if (scopedSemanticResults.length === 0) {
    if (!DISABLE_CACHE) await setInCache(cacheKey, [], 60); // Cache empty results too
    const total = Date.now() - startTotal;
    timings.push({ step: "TOTAL", duration: total });
    logTimings(timings, query);
    emitDiagnostics(params, timings, total, cacheHitType, effectiveFastMode, tracer.stages());
    return [];
  }

  // Step 3: Early exit if top result is excellent
  if (!queryIntent.wantsRecent && scopedSemanticResults.length > 0 && scopedSemanticResults[0].similarity >= EARLY_EXIT_SIMILARITY) {
    console.log(`⚡ Early exit at ${scopedSemanticResults[0].similarity.toFixed(3)}`);
    const topMemories = toMemorySearchResults(scopedSemanticResults.slice(0, topK));

    // Cache good results
    if (!DISABLE_CACHE) await setInSemanticCache(queryEmbedding, topMemories, 300);
    if (!DISABLE_CACHE) await setInCache(cacheKey, topMemories, 300); // 5 min cache

    const total = Date.now() - startTotal;
    timings.push({ step: "TOTAL", duration: total });
    logTimings(timings, query);
    emitDiagnostics(params, timings, total, cacheHitType, effectiveFastMode, tracer.stages());
    return topMemories;
  }

  // Step 4: FAST MODE - Skip graph traversal and temporal scoring for speed
  let finalResults = scopedSemanticResults.slice(0, topK);
  let candidatePool: any[] = scopedSemanticResults;
  const rerankStart = Date.now();
  
  if (!effectiveFastMode) {
    // Graph traversal - enrich with related memories
    const graphStart = Date.now();
    const enriched = await enrichWithRelations(scopedSemanticResults, topK * 2, orgId);
    timings.push({ step: "graph_traversal", duration: Date.now() - graphStart });

    // Temporal relevance scoring
    const temporalScoringStart = Date.now();
    const scored = enriched.map((memory) => ({
      ...memory,
      temporalScore: memory.documentDate
        ? calculateTemporalRelevance(memory.documentDate, questionDate)
        : 0.5,
    }));
    timings.push({ step: "temporal_scoring", duration: Date.now() - temporalScoringStart });

    // Combine scores (semantic + temporal)
    const combineStart = Date.now();
    const combined = rerankByScope(scored.map((m) => ({
      ...m,
      finalScore: m.similarity * 0.7 + m.temporalScore * 0.3,
    })), { userId, sessionId, agentId, taskId });
    timings.push({ step: "score_combine", duration: Date.now() - combineStart });

    // Sort by final score
    const sortStart = Date.now();
    combined.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
    timings.push({ step: "sort", duration: Date.now() - sortStart });

    candidatePool = combined;
    // Take top K
    finalResults = combined.slice(0, topK);
  }
  tracer.record({ layer: "S2.rerank", in: scopedSemanticResults.length, out: candidatePool.length, ms: Date.now() - rerankStart });

  // Step 4b: Intent-aware reranking over the full candidate pool (so type boosts
  // can surface on-type memories that ranked low semantically).
  if (
    queryIntent.wantsRecent ||
    queryIntent.asksForSearchHistory ||
    queryIntent.asksForGoals ||
    queryIntent.asksForPreferences ||
    queryIntent.asksForDecisions ||
    queryIntent.asksForInstructions ||
    queryIntent.asksForSolutions ||
    queryIntent.asksForWorkflows
  ) {
    const intentStart = Date.now();
    finalResults = rerankByIntent(candidatePool, questionDate, queryIntent).slice(0, topK);
    const intentMs = Date.now() - intentStart;
    timings.push({ step: "intent_rerank", duration: intentMs });
    tracer.record({ layer: "S2.intent", in: candidatePool.length, out: finalResults.length, ms: intentMs });
  }

  // Step 5: S3 delivery — map ranked memories into the public result shape.
  // ADR-015: this used to inject the source chunk of each memory (`injectSourceChunks`) so the
  // caller could read the surrounding document text, guarded by a latency budget. Margo is a
  // memory service: a memory may point at external material ("config lives in repo X, file Y"),
  // but it carries no chunks, so delivery is pure mapping and needs no guardrail.
  const results: MemorySearchResult[] = toMemorySearchResults(finalResults);
  const deliveryMs = 0;
  timings.push({ step: "delivery", duration: deliveryMs });
  tracer.record({ layer: "S3.delivery", in: finalResults.length, out: results.length, ms: deliveryMs });

  // Cache results for similar queries
  const cacheWriteStart = Date.now();
  if (!DISABLE_CACHE) await setInSemanticCache(queryEmbedding, results, 300);
  await setInCache(cacheKey, results, 300); // 5 min cache
  timings.push({ step: "cache_write", duration: Date.now() - cacheWriteStart });

  const total = Date.now() - startTotal;
  timings.push({ step: "TOTAL", duration: total });
  if (total > TOTAL_SLO_BUDGET_MS) {
    console.warn(`[MemorySearch] SLO miss: ${total}ms (budget=${TOTAL_SLO_BUDGET_MS}ms)`);
  }
  logTimings(timings, query);
  emitDiagnostics(params, timings, total, cacheHitType, effectiveFastMode, tracer.stages());

  return results;
}

/**
 * Vector search on memories table
 */
async function vectorSearchMemories(params: {
  embedding: number[];
  userId?: string;
  projectId: string;
  orgId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  scopes?: MemoryScopeTarget[];
  temporal: { hasTemporalConstraint: boolean; dateRange?: { start: Date; end: Date } };
  includeInactive: boolean;
  memoryTypes?: string[];
  namespace?: string;
  tags?: string[];
  limit: number;
}): Promise<any[]> {
  const {
    embedding,
    userId,
    projectId,
    orgId,
    sessionId,
    agentId,
    taskId,
    scopes,
    temporal,
    includeInactive,
    memoryTypes,
    namespace,
    tags,
    limit,
  } = params;

  // Build WHERE clause using parameterized Prisma.sql to prevent SQL injection
  let whereClause = Prisma.sql`"projectId" = ${projectId} AND ("validUntil" IS NULL OR "validUntil" > NOW())`;

  if (orgId) whereClause = Prisma.sql`${whereClause} AND "orgId" = ${orgId}`;
  if (scopes && scopes.length > 0) {
    whereClause = Prisma.sql`${whereClause} AND "scope" IN (${Prisma.join(scopes)})`;
  }
  const identityFilters: Prisma.Sql[] = [Prisma.sql`"scope" = 'PROJECT'`];
  if (userId) identityFilters.push(Prisma.sql`("scope" = 'USER' AND "userId" = ${userId})`);
  if (sessionId) identityFilters.push(Prisma.sql`("scope" = 'SESSION' AND "sessionId" = ${sessionId})`);
  if (agentId) identityFilters.push(Prisma.sql`("scope" = 'AGENT' AND "agentId" = ${agentId})`);
  if (taskId) identityFilters.push(Prisma.sql`("scope" = 'TASK' AND "taskId" = ${taskId})`);
  if (scopes?.includes("DOCUMENT")) {
    identityFilters.push(Prisma.sql`"scope" = 'DOCUMENT'`);
  }
  whereClause = Prisma.sql`${whereClause} AND (${Prisma.join(identityFilters, " OR ")})`;
  if (!includeInactive) whereClause = Prisma.sql`${whereClause} AND "isActive" = true`;
  if (memoryTypes && memoryTypes.length > 0) {
    whereClause = Prisma.sql`${whereClause} AND "memoryType" IN (${Prisma.join(memoryTypes)})`;
  }
  if (temporal.hasTemporalConstraint && temporal.dateRange) {
    whereClause = Prisma.sql`${whereClause} AND "documentDate" >= ${temporal.dateRange.start} AND "documentDate" <= ${temporal.dateRange.end}`;
  }
  if (namespace) {
    whereClause = Prisma.sql`${whereClause} AND metadata->>'namespace' = ${namespace}`;
  }
  if (tags && tags.length > 0) {
    const tagConditions = tags.map(tag => Prisma.sql`metadata->'tags' @> ${JSON.stringify([tag])}::jsonb`);
    whereClause = Prisma.sql`${whereClause} AND (${Prisma.join(tagConditions, " OR ")})`;
  }

  // Embedding is a float array from our own model (not user input) — safe to inline as vector literal
  const embeddingLiteral = Prisma.raw(`'[${embedding.join(",")}]'::vector`);
  const limitLiteral = Prisma.raw(String(Math.min(Math.max(1, Math.floor(limit)), 1000)));

  const results = await db.$transaction(async (tx: any) => {
    // ANN recall tuning (TD-001): set the search breadth for this query's
    // connection. set_config(..., true) is transaction-local.
    if (retrievalCfg.ann.type === "hnsw") {
      await tx.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(retrievalCfg.ann.efSearch)}, true)`;
    } else {
      await tx.$executeRaw`SELECT set_config('ivfflat.probes', ${String(retrievalCfg.ann.probes)}, true)`;
    }
    return tx.$queryRaw(Prisma.sql`
    SELECT
      id,
      content,
      "memoryType" as "memoryType",
      "entityMentions" as "entityMentions",
      confidence,
      version,
      scope,
      "userId" as "userId",
      "sessionId" as "sessionId",
      "agentId" as "agentId",
      "taskId" as "taskId",
      "documentDate" as "documentDate",
      "eventDate" as "eventDate",
      "validFrom" as "validFrom",
      "validUntil" as "validUntil",
      "createdAt" as "createdAt",
      "updatedAt" as "updatedAt",
      "sourceChunkId" as "sourceChunkId",
      metadata,
      1 - (embedding <=> ${embeddingLiteral}) as similarity
    FROM memories
    WHERE ${whereClause}
    ORDER BY embedding <=> ${embeddingLiteral}
    LIMIT ${limitLiteral}
  `);
  });

  return (results as any[]).map((r) => ({
    ...r,
    content: decrypt(r.content, orgId),
  }));
}

/**
 * Enrich memories with related memories via graph traversal
 * Optimized: Single query for relations + related memories
 */
async function enrichWithRelations(
  memories: any[],
  maxTotal: number,
  orgId?: string,
): Promise<any[]> {
  if (memories.length === 0) {
    return [];
  }

  const memoryIds = memories.map((m) => m.id);
  const memoryIdSet = new Set(memoryIds);

  let relationsQuery: unknown[];
  try {
  // Get relations and related memories in one query
  relationsQuery = await db.$queryRaw(Prisma.sql`
    SELECT 
      r.id as relation_id,
      r."fromMemoryId",
      r."toMemoryId",
      r."relationType",
      m.id,
      m.content,
      m."memoryType",
      m."entityMentions",
      m.confidence,
      m.version,
      m.scope,
      m."userId",
      m."sessionId",
      m."agentId",
      m."taskId",
      m."documentDate",
      m."eventDate",
      m."validFrom",
      m."validUntil",
      m."createdAt",
      m."updatedAt",
      m."sourceChunkId",
      m.metadata
    FROM "memory_relations" r
    LEFT JOIN memories m ON m.id = r."toMemoryId"
    WHERE r."fromMemoryId" IN (${Prisma.join(memoryIds)})
      AND m."isActive" = true
    LIMIT 100
  `);
  } catch (error) {
    console.warn("[MemorySearch] enrichWithRelations DB query failed — returning memories without relation enrichment:", error);
    return memories;
  }

  if (!relationsQuery || (relationsQuery as any[]).length === 0) {
    return memories;
  }

  // Collect unique related memory IDs
  const relatedIds = new Set<string>();
  const relationMap = new Map<string, any[]>();

  for (const row of relationsQuery as any[]) {
    if (row.toMemoryId && !memoryIdSet.has(row.toMemoryId)) {
      relatedIds.add(row.toMemoryId);
      
      if (!relationMap.has(row.fromMemoryId)) {
        relationMap.set(row.fromMemoryId, []);
      }
      relationMap.get(row.fromMemoryId)?.push({
        memoryId: row.toMemoryId,
        relationType: row.relationType,
        content: decrypt(row.content, orgId),
      });
    }
  }

  if (relatedIds.size === 0) {
    return memories;
  }

  // Fetch related memories in batch
  const relatedIdsList = Array.from(relatedIds);
  let relatedMemories: unknown[];
  try {
    relatedMemories = await db.$queryRaw(Prisma.sql`
      SELECT
        id,
        content,
        "memoryType" as "memoryType",
        "entityMentions" as "entityMentions",
        confidence,
        version,
        scope,
        "userId" as "userId",
        "sessionId" as "sessionId",
        "agentId" as "agentId",
        "taskId" as "taskId",
        "documentDate" as "documentDate",
        "eventDate" as "eventDate",
        "validFrom" as "validFrom",
        "validUntil" as "validUntil",
        "createdAt" as "createdAt",
        "updatedAt" as "updatedAt",
        "sourceChunkId" as "sourceChunkId",
        metadata
      FROM memories
      WHERE id IN (${Prisma.join(relatedIdsList)})
        AND "isActive" = true
      LIMIT ${Prisma.raw(String(Math.max(0, maxTotal - memories.length)))}
    `);
  } catch (error) {
    console.warn("[MemorySearch] enrichWithRelations related fetch failed — returning base memories:", error);
    return memories;
  }

  // Assign lower scores to related memories, decrypt content if encrypted
  const relatedWithScores = (relatedMemories as any[]).map((m) => ({
    ...m,
    content: decrypt(m.content, orgId),
    similarity: 0.6,
    isRelated: true,
    relations: relationMap.get(m.id) || [],
  }));

  return [...memories, ...relatedWithScores];
}

/**
 * Map ranked memories into the public search-result shape (S3 delivery).
 *
 * ADR-015: this replaced `injectSourceChunks`, which looked up `sourceChunkId` on each memory
 * and attached the surrounding document chunk (`db.chunk.findMany`). Margo is a memory service:
 * a memory may point at external material in its own content ("config lives in repo X, file Y"),
 * but it does not carry chunks — so delivery is pure mapping, with no per-query DB round-trip and
 * no latency guardrail around it.
 */
function toMemorySearchResults(memories: any[]): MemorySearchResult[] {
  return memories.map((m) => ({
    memory: {
      id: m.id,
      content: m.content,
      memoryType: m.memoryType,
      entityMentions: m.entityMentions || [],
      confidence: m.confidence,
      version: m.version,
      scope: m.scope,
      scopeTarget: m.scope,
      userId: m.userId ?? null,
      sessionId: m.sessionId ?? null,
      agentId: m.agentId ?? null,
      taskId: m.taskId ?? null,
      temporal: {
        documentDate: m.documentDate,
        eventDate: m.eventDate,
        validFrom: m.validFrom,
        validUntil: m.validUntil,
      },
    },
    similarity: m.similarity,
  }));
}

/**
 * Session-based memory query
 * Gets recent memories from a session for context building
 */
export async function getSessionMemories(params: {
  sessionId: string;
  projectId: string;
  limit?: number;
  sinceDate?: Date;
}): Promise<any[]> {
  const { sessionId, projectId, limit = 50, sinceDate } = params;

  const where: any = {
    sessionId,
    projectId,
    isActive: true,
    scope: "SESSION",
    OR: [
      { validUntil: null },
      { validUntil: { gt: new Date() } },
    ],
  };

  if (sinceDate) {
    where.createdAt = { gte: sinceDate };
  }

  return db.memory.findMany({
    where,
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
  });
}

/**
 * User profile memory query
 * Gets long-term user preferences and facts
 */
export async function getUserProfile(params: {
  userId: string;
  projectId: string;
  memoryTypes?: string[];
  limit?: number;
}): Promise<any[]> {
  const { userId, projectId, memoryTypes, limit = 50 } = params;

  const where: any = {
    userId,
    projectId,
    isActive: true,
    scope: "USER",
    OR: [
      { validUntil: null },
      { validUntil: { gt: new Date() } },
    ],
  };

  if (memoryTypes) {
    where.memoryType = { in: memoryTypes };
  }

  return db.memory.findMany({
    where,
    orderBy: { importance: "desc" },
    take: Math.min(limit, 100),
  });
}
