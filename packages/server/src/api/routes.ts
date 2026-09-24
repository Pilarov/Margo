import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { prisma } from "../db/index.js";
import { embeddingToSql, dimensionCheck } from "../db/vector.js";
import { authMiddleware, type AuthContext } from "../middleware/auth.js";
import { rateLimitMiddleware, RateLimits } from "../middleware/rate-limit.js";
import { fireWebhookEvent } from "../engine/webhooks.js";
import { embedSingle } from "../engine/embeddings.js";
import { ingestSession as ingestMemorySession, searchMemories } from "../engine/memory/index.js";
import { ingestionQueue } from "../engine/ingestion-queue.js";
import { writeMemoryCanonical } from "../engine/memory/write.js";
import { judgeAnswer } from "../engine/memory/judge.js";
import { getDropOffSummary, resetTelemetry } from "../engine/telemetry/collector.js";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { memoryRoutes } from "./memory.js";
import { contextRoutes } from "./context.js";
import { optimizationRoutes } from "./optimization.js";
import { searchRoutes } from "./search.js";
import { fileRoutes } from "./files.js";
import { agentTaskRoutes } from "./agent-tasks.js";
import { researchAgentRoutes } from "./research-agent.js";
import { resolveProjectReference, ensureProject, getEffectiveOrgId } from "./helpers.js";
import { getContractHeaders, getPublicContractMetadata } from "../contracts/runtime.mjs";
import { getLatencySummary, getLatencyTraceConfig, getLatencyGateStatus, resetLatencySummary } from "../engine/latency-tracing.js";
import {
  getExtractionAlerts,
  getExtractionGateStatus,
  getExtractionPhase0Config,
  getExtractionStats,
  resetExtractionObservability,
} from "../engine/extraction-observability.js";
import { getTraceIdFromRequest } from "../lib/trace.js";
import {
  getIdempotencyKey,
  hashIdempotencyPayload,
  loadIdempotentResponse,
  storeIdempotentResponse,
} from "./idempotency.js";
import {
  buildRouteControlMatrix,
  assertRouteControlCoverage,
  getRouteControl,
} from "../security/route-controls.js";
import {
  getSourceVersion,
  listSourceVersions,
  serializeSourceVersion,
  restoreSource,
  softDeleteSource,
  markStaleSourceVersionsFailed,
} from "../engine/source-versions.js";
import { redeliverWebhookDelivery } from "../engine/webhooks.js";
import { exportIndexBundle } from "../engine/index-bundle.js";
import {
  evaluateOperationalAlerts,
  getConnectorHealthSummary,
  getOperationalCounters,
  getQueueHealthSummary,
  getRetrievalHealthSummary,
  getWebhookFailureSummary,
} from "../engine/ops-observability.js";

// Type augmentation for Hono context variables
type Variables = {
  auth: AuthContext;
  traceId: string;
};

export const api = new Hono<{ Variables: Variables }>();
const DEPLOY_REGION = process.env.DEPLOY_REGION || process.env.AWS_REGION || "us-east-1";
const STACK_NAME = process.env.RETAINDB_STACK || "ec2";
const ORGANIZATION_PLAN = {
  FREE: "FREE",
  OSS: "OSS",
  PAY_AS_YOU_GO: "PAY_AS_YOU_GO",
  PRO: "PRO",
  SCALE: "SCALE",
  ENTERPRISE: "ENTERPRISE",
} as const;
  ORGANIZATION_PLAN
type DeviceAuthRecord = {
  userCode: string;
  expiresAt: number;
  apiKey?: string;
};
const LEGACY_MEMORY_SUNSET = "Wed, 01 Jul 2026 00:00:00 GMT";

api.use("/*", async (c, next) => {
  const headers = getContractHeaders();
  for (const [name, value] of Object.entries(headers)) {
    c.header(name as any, value as any);
  }
  const traceId = getTraceIdFromRequest(c);
  c.set("traceId", traceId);
  c.header("x-trace-id", traceId);
  c.header("x-request-id", traceId);
  await next();
});

function getLegacyMemoryReplacement(method: string, path: string): string {
  const upperMethod = method.toUpperCase();
  if (path === "/v1/memories" && upperMethod === "POST") return "/v1/memory";
  if (path === "/v1/memories/search") return "/v1/memory/search";
  if (path === "/v1/memories" && upperMethod === "GET") {
    return "/v1/memory/profile/:userId or /v1/memory/session/:sessionId";
  }
  if (/^\/v1\/memories\/[^/]+$/.test(path)) return "/v1/memory/:memoryId";
  return "/v1/memory";
}

function markLegacyMemoryRoute(c: {
  req: { path: string; method: string };
  header: (name: string, value: string) => void;
}) {
  c.header("Deprecation", "true");
  c.header("Sunset", LEGACY_MEMORY_SUNSET);
  c.header("Link", `</docs/api-reference#legacy-memory-routes>; rel="deprecation"; type="text/markdown"`);
  c.header("X-RetainDB-Replacement-Route", getLegacyMemoryReplacement(c.req.method, c.req.path));
}

function bigIntJson(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return value.toString();
  if (Array.isArray(value)) return value.map(bigIntJson);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, bigIntJson(v)])
    );
  }
  return value;
}

function extractToken(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const bearer = trimmed.match(/^Bearer\s+(.+)$/i)?.[1];
  return (bearer || trimmed).trim();
}

function sanitizeWizardMetadata(input: unknown): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const blocked = new Set(["query", "content", "prompt", "file", "path", "token", "apiKey"]);
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(input as Record<string, any>)) {
    if (blocked.has(key)) continue;
    if (typeof value === "string") {
      out[key] = value.length > 180 ? `${value.slice(0, 180)}...` : value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
      continue;
    }
  }
  return out;
}

api.use("/*", authMiddleware);
api.use("/*", async (c, next) => {
  const auth = c.get("auth") as AuthContext;
  const traceId = c.get("traceId");
  const routeMatrix = getNodeRouteMatrix();
  const control = getRouteControl(routeMatrix, c.req.method, c.req.path);
  if (!control) {
    return c.json({ error: "Route control missing", trace_id: traceId }, 500);
  }
  if (control.authMode === "admin_only" && !auth.isAdmin) {
    return c.json({ error: "Admin access required", trace_id: traceId }, 403);
  }
  await next();
  if (control.auditRequired) {
  }
});

// ─── SOTA Routes ─────────────────────────────────────────────
// Mount SOTA memory, context, and optimization APIs
api.route("/", memoryRoutes);
api.route("/", contextRoutes);
api.route("/", optimizationRoutes);
api.route("/", searchRoutes);
api.route("/", fileRoutes);
api.route("/", agentTaskRoutes);
api.route("/", researchAgentRoutes);

// ─── Helper ──────────────────────────────────────────────────

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function getNodeRouteMatrix() {
  const routes = ((api as any).routes || []) as Array<{ method: string; path: string }>;
  const matrix = buildRouteControlMatrix(routes, "node");
  assertRouteControlCoverage(matrix, routes, "node");
  return matrix;
}

async function loadMutationReplay(
  c: any,
  auth: AuthContext,
  endpoint: string,
  payload: Record<string, any>
) {
  const idempotencyKey = getIdempotencyKey({
    "idempotency-key": c.req.header("idempotency-key"),
    "Idempotency-Key": c.req.header("Idempotency-Key"),
  });
  if (!idempotencyKey) return { idempotencyKey: null, requestHash: null, replay: null as any };

  const requestHash = hashIdempotencyPayload(payload);
  const replay = await loadIdempotentResponse({
    orgId: auth.orgId,
    endpoint,
    idempotencyKey,
    requestHash,
  });
  return { idempotencyKey, requestHash, replay };
}

async function storeMutationReplay(params: {
  auth: AuthContext;
  endpoint: string;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  statusCode: number;
  body: Record<string, any>;
  ttlSeconds?: number;
}) {
  if (!params.idempotencyKey || !params.requestHash) return;
  await storeIdempotentResponse({
    orgId: params.auth.orgId,
    endpoint: params.endpoint,
    idempotencyKey: params.idempotencyKey,
    requestHash: params.requestHash,
    statusCode: params.statusCode,
    body: params.body,
    ttlSeconds: params.ttlSeconds,
  });
}

// ADR-015: хелперы документной загрузки (/v1/learn, /v1/index) удалены вместе с маршрутами.
// Ниже осталось только то, что обслуживает памяти: авто-обучение из разговора.

/** Дебаунс авто-обучения из разговора — настройка памятей, раньше жила в learn-настройках. */
const LEARN_AUTO_DEBOUNCE_MS = Math.max(50, parseInt(process.env.LEARN_AUTO_DEBOUNCE_MS || "250", 10));
const learnAutoTimers = new Map<string, NodeJS.Timeout>();

function scheduleConversationAutoLearn(params: {
  auth: AuthContext;

  projectId: string;
  sessionId: string;
  userId?: string;
}) {
  const key = `${params.projectId}:${params.userId || "session_only"}:${params.sessionId}`;
  const existing = learnAutoTimers.get(key);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(async () => {
    learnAutoTimers.delete(key);
    try {
      const recentMessages = await prisma.message.findMany({
        where: { sessionId: params.sessionId },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          role: true,
          content: true,
          createdAt: true,
        },
      });
      if (recentMessages.length === 0) return;
      await ingestMemorySession({
        sessionId: params.sessionId,
        projectId: params.projectId,
        orgId: params.auth.orgId,
        userId: params.userId,
        messages: recentMessages.reverse().map((message) => ({
          role: message.role,
          content: message.content,
          timestamp: message.createdAt,
        })),
      });
    } catch (error) {
      console.warn("[Learn] conversation auto-learn failed:", error instanceof Error ? error.message : String(error));
    }
  }, LEARN_AUTO_DEBOUNCE_MS);
  learnAutoTimers.set(key, timeout);
}

function simpleClawProjectSlug(userId: string) {
  const base = slugify(`sc-${userId}`).slice(0, 56);
  return base || `sc-${nanoid(10).toLowerCase()}`;
}

function normalizeMemoryType(memoryType?: string) {
  const value = (memoryType || "").toLowerCase();
  const mapped: Record<string, "factual" | "preference" | "event" | "relationship" | "opinion" | "goal" | "instruction"> = {
    factual: "factual",
    episodic: "event",
    semantic: "factual",
    procedural: "instruction",
    preference: "preference",
    event: "event",
    relationship: "relationship",
    opinion: "opinion",
    goal: "goal",
    instruction: "instruction",
  };
  return mapped[value] || "factual";
}

// ─── Query Context ───────────────────────────────────────────

api.get("/v1/projects", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const orgFilter = c.req.query("orgId");
  const results = await prisma.project.findMany({
    where: auth.isAdmin
      ? (orgFilter ? { orgId: orgFilter } : {})
      : { orgId: auth.orgId },
  });
  return c.json(bigIntJson({ projects: results }));
});

api.get("/v1/projects/resolve", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const projectRef = (c.req.query("project") || "").trim();

  if (!projectRef) {
    return c.json({ error: "project query param is required" }, 400);
  }

  const project = await resolveProjectReference(auth.orgId, projectRef, auth.isAdmin);
  if (!project) return c.json({ error: "Project not found" }, 404);

  return c.json(bigIntJson({
    input: projectRef,
    resolved: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      orgId: project.orgId,
    },
  }));
});

api.get("/v1/projects/:id", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const projectRef = c.req.param("id");

  const project = await resolveProjectReference(auth.orgId, projectRef, auth.isAdmin);
  if (!project) return c.json(bigIntJson({ error: "Project not found" }), 404);

  const hydratedProject = await prisma.project.findFirst({
    where: { id: project.id },
  });

  if (!hydratedProject) return c.json(bigIntJson({ error: "Project not found" }), 404);

  return c.json(bigIntJson(hydratedProject));
});

api.delete("/v1/projects/:id", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const projectRef = c.req.param("id");

  const project = await resolveProjectReference(auth.orgId, projectRef, auth.isAdmin);

  if (!project) return c.json(bigIntJson({ error: "Project not found" }), 404);

  await prisma.project.delete({ where: { id: project.id } });
  return c.json(bigIntJson({ deleted: true }));
});

api.get("/v1/projects/:id/stats", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const projectRef = c.req.param("id");

  const project = await resolveProjectReference(auth.orgId, projectRef, auth.isAdmin);

  if (!project) return c.json(bigIntJson({ error: "Project not found" }), 404);

  // ADR-015: документных счётчиков (documents/chunks/sources) здесь больше нет — сервис
  // отдаёт памяти, по ним и считается статистика проекта.
  const [memoryCount, entityCount] = await Promise.all([
    prisma.memory.count({ where: { projectId: project.id, isActive: true } }),
    prisma.entity.count({ where: { projectId: project.id } }),
  ]);

  return c.json({
    memories: Number(memoryCount),
    entities: Number(entityCount),
  });
});

// ─── Memories ────────────────────────────────────────────────

api.post(
  "/v1/memories",
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      content: z.string().min(1).max(10000),
      memory_type: z.enum(["factual", "episodic", "semantic", "procedural"]).optional().default("factual"),
      user_id: z.string().optional(),
      session_id: z.string().optional(),
      agent_id: z.string().optional(),
      importance: z.number().min(0).max(1).optional().default(0.5),
      metadata: z.record(z.any()).optional(),
      expires_in_seconds: z.number().int().positive().optional(),
      webhook_url: z.string().url().optional(),
      namespace: z.string().optional(),
      tags: z.array(z.string()).optional(),
      async: z.boolean().optional().default(true), // Default to async
    })
  ),
  async (c) => {
    markLegacyMemoryRoute(c);
    try {
      const auth = c.get("auth") as AuthContext;
      const body = c.req.valid("json");

      const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

      // ASYNC BY DEFAULT (unless explicitly disabled)
      if (body.async !== false) {
        try {
          const jobId = await ingestionQueue.createJob({
            orgId: auth.orgId,
            projectId: project.id,
            userId: auth.userId || 'system',
            memories: [{
              content: body.content,
              memory_type: body.memory_type,
              user_id: body.user_id,
              session_id: body.session_id,
              agent_id: body.agent_id,
              importance: body.importance,
              metadata: {
                ...body.metadata,
                namespace: body.namespace,
                tags: body.tags,
              },
              expires_in_seconds: body.expires_in_seconds,
            }],
            webhookUrl: body.webhook_url,
            namespace: body.namespace,
            tags: body.tags,
          });

          return c.json({
            success: true,
            mode: 'async',
            jobId,
            status: 'PROCESSING',
            statusUrl: `/v1/jobs/${jobId}`,
            webhookUrl: body.webhook_url || null,
          }, 202);

        } catch (error: any) {
          console.error("[Memory] Async job creation failed:", error);
          return c.json({
            error: "Failed to queue memory creation",
            details: error.message
          }, 500);
        }
      }

      const writeResult = await writeMemoryCanonical({
        projectId: project.id,
        orgId: auth.orgId,
        userId: body.user_id,
        sessionId: body.session_id,
        agentId: body.agent_id,
        content: body.content,
        memoryType: body.memory_type,
        importance: body.importance,
        confidenceRaw: 0.9,
        metadata: {
          ...(body.metadata || {}),
          namespace: body.namespace,
          tags: body.tags,
        },
        expiresAt: body.expires_in_seconds
          ? new Date(Date.now() + body.expires_in_seconds * 1000)
          : null,
        writeSource: "api.legacy.memories",
        writeMode: "direct_write",
        extractionMethod: "manual",
      });

      if (!writeResult.memory || writeResult.outcome === "dropped") {
        return c.json(bigIntJson({
          error: "Memory write rejected by canonical validation policy",
          validator_issues: writeResult.validatorIssues,
        }), 422);
      }

      return c.json(bigIntJson({
        mode: 'sync',
        memory: writeResult.memory,
        write_outcome: writeResult.outcome,
        scope_decision: writeResult.scopeDecision,
      }), writeResult.outcome === "created" ? 201 : 200);
    } catch (error: any) {
      console.error("Memory creation error:", error);
      console.error("Error details:", error.message, error.stack);
      return c.json(bigIntJson({ error: "Failed to create memory", details: error.message }), 500);
    }
  }
);

api.post(
  "/v1/memories/search",
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      query: z.string().min(1).max(5000),
      user_id: z.string().optional(),
      session_id: z.string().optional(),
      agent_id: z.string().optional(),
      memory_type: z.enum(["factual", "episodic", "semantic", "procedural"]).optional(),
      top_k: z.number().int().min(1).max(50).optional().default(10),
    })
  ),
  async (c) => {
    markLegacyMemoryRoute(c);
    const auth = c.get("auth") as AuthContext;
    const body = c.req.valid("json");

    const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

    const queryEmbedding = await embedSingle(body.query);
    if (!dimensionCheck(queryEmbedding)) {
      return c.json({ memories: [] });
    }

    // Parameterized SQL (avoid interpolating user input into WHERE clauses).
    const conditions: any[] = [
      Prisma.sql`"projectId" = ${project.id}`,
      Prisma.sql`"isActive" = true`,
      Prisma.sql`("expiresAt" IS NULL OR "expiresAt" > NOW())`,
    ];
    if (body.user_id) conditions.push(Prisma.sql`"userId" = ${body.user_id}`);
    if (body.session_id) conditions.push(Prisma.sql`"sessionId" = ${body.session_id}`);
    if (body.agent_id) conditions.push(Prisma.sql`"agentId" = ${body.agent_id}`);
    if (body.memory_type) conditions.push(Prisma.sql`"memoryType" = ${body.memory_type}`);

    const whereSql = Prisma.join(conditions, " AND ");

    const memories = await prisma.$queryRaw(Prisma.sql`
      SELECT
        id, content, "memoryType", "userId",
        "sessionId", "agentId", importance,
        metadata, "accessCount", "createdAt",
        1 - (embedding <=> ${embeddingToSql(queryEmbedding)}) as similarity
      FROM memories
      WHERE ${whereSql}
      ORDER BY embedding <=> ${embeddingToSql(queryEmbedding)}
      LIMIT ${body.top_k}
    `);

    // Update access counts
    const memoryIds = (memories as any[]).map((r: any) => r.id);
    if (memoryIds.length > 0) {
      await prisma.memory.updateMany({
        where: { id: { in: memoryIds } },
        data: {
          accessCount: { increment: 1 },
          lastAccessedAt: new Date(),
        },
      });
    }

    return c.json({
      memories: (memories as any[]).map((r: any) => ({
        ...r,
        score: Math.round(r.similarity * 1000) / 1000,
      })),
    });
  }
);

api.get("/v1/memories", async (c) => {
  markLegacyMemoryRoute(c);
  const auth = c.get("auth") as AuthContext;
  const projectName = c.req.query("project");
  const userId = c.req.query("user_id");
  const sessionId = c.req.query("session_id");
  const agentId = c.req.query("agent_id");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);

  const project = await ensureProject(auth.orgId, projectName, auth.isAdmin);

  const memories = await prisma.memory.findMany({
    where: {
      projectId: project.id,
      isActive: true,
      ...(userId && { userId }),
      ...(sessionId && { sessionId }),
      ...(agentId && { agentId }),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      content: true,
      memoryType: true,
      userId: true,
      sessionId: true,
      agentId: true,
      importance: true,
      metadata: true,
      accessCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return c.json({ memories });
});

api.get("/v1/memories/:id", async (c) => {
  markLegacyMemoryRoute(c);
  const auth = c.get("auth") as AuthContext;
  const id = c.req.param("id");

  const memory = await prisma.memory.findFirst({
    where: { id, orgId: auth.orgId },
    select: {
      id: true,
      projectId: true,
      orgId: true,
      content: true,
      memoryType: true,
      userId: true,
      sessionId: true,
      agentId: true,
      importance: true,
      confidence: true,
      metadata: true,
      accessCount: true,
      createdAt: true,
      updatedAt: true,
      documentDate: true,
      eventDate: true,
      validFrom: true,
      validUntil: true,
      isActive: true,
    },
  });

  if (!memory) return c.json({ error: "Memory not found" }, 404);
  return c.json({ memory: bigIntJson(memory) });
});

api.put(
  "/v1/memories/:id",
  zValidator(
    "json",
    z.object({
      content: z.string().optional(),
      importance: z.number().min(0).max(1).optional(),
      metadata: z.record(z.any()).optional(),
    })
  ),
  async (c) => {
    markLegacyMemoryRoute(c);
    const auth = c.get("auth") as AuthContext;
    const id = c.req.param("id");
    const body = c.req.valid("json");

    // Verify ownership via project -> org
    const memory = await prisma.memory.findFirst({
      where: { id },
      include: { project: true },
    });

    if (!memory) return c.json({ error: "Memory not found" }, 404);
    if (!memory.project || memory.project.orgId !== auth.orgId) return c.json({ error: "Not authorized" }, 403);

    const updateData: any = { updatedAt: new Date() };
    if (body.content) {
      updateData.content = body.content;
      // Note: We don't update embedding for Unsupported("vector") type
    }
    if (body.importance !== undefined) updateData.importance = body.importance;
    if (body.metadata) updateData.metadata = body.metadata;

    const updated = await prisma.memory.update({
      where: { id },
      data: updateData,
    });

    return c.json(updated);
  }
);

api.delete("/v1/memories/:id", async (c) => {
  markLegacyMemoryRoute(c);
  const auth = c.get("auth") as AuthContext;
  const id = c.req.param("id");

  const memory = await prisma.memory.findFirst({
    where: { id },
    include: { project: true },
  });

  if (!memory) return c.json({ error: "Memory not found" }, 404);
  if (!memory.project || memory.project.orgId !== auth.orgId) return c.json({ error: "Not authorized" }, 403);

  await prisma.memory.update({
    where: { id },
    data: { isActive: false, updatedAt: new Date() },
  });

  return c.json({ deleted: true });
});

// ─── Conversations ───────────────────────────────────────────

api.post(
  "/v1/conversations",
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      session_id: z.string().optional(),
      user_id: z.string().optional(),
      agent_id: z.string().optional(),
      title: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const body = c.req.valid("json");

    const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

    const conv = await prisma.session.create({
      data: {
        projectId: project.id,
        sessionId: body.session_id,
        userId: body.user_id,
        agentId: body.agent_id,
        title: body.title,
        metadata: body.metadata || {},
      },
    });

    return c.json(conv, 201);
  }
);

api.get("/v1/conversations", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const projectName = c.req.query("project");
  const userId = c.req.query("user_id");
  const sessionId = c.req.query("session_id");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10), 1), 100);

  const project = await ensureProject(auth.orgId, projectName, auth.isAdmin);

  const results = await prisma.session.findMany({
    where: {
      projectId: project.id,
      ...(userId && { userId }),
      ...(sessionId && { sessionId }),
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });

  return c.json({ conversations: results });
});

api.get("/v1/conversations/:id", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const id = c.req.param("id");

  const conv = await prisma.session.findFirst({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });

  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  if (!conv.projectId) return c.json({ error: "Conversation not found" }, 404);

  const project = await prisma.project.findFirst({
    where: {
      id: conv.projectId,
      orgId: auth.orgId,
    },
  });

  if (!project) return c.json({ error: "Not authorized" }, 403);

  return c.json(conv);
});

// ─── Messages ────────────────────────────────────────────────

api.post(
  "/v1/conversations/:conversationId/messages",
  zValidator(
    "json",
    z.object({
      role: z.enum(["user", "assistant", "system", "tool"]),
      content: z.string().min(1),
      metadata: z.record(z.any()).optional(),
      auto_learn: z.boolean().optional().default(true),
      auto_extract_memories: z.boolean().optional().default(false),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const conversationId = c.req.param("conversationId");
    const body = c.req.valid("json");

    const conv = await prisma.session.findFirst({
      where: { id: conversationId },
      include: { project: true },
    });

    if (!conv) return c.json({ error: "Conversation not found" }, 404);

    if (!conv.project || conv.project.orgId !== auth.orgId) return c.json({ error: "Not authorized" }, 403);

    const msg = await prisma.message.create({
      data: {
        sessionId: conversationId,
        role: body.role,
        content: body.content,
        metadata: body.metadata || {},
      },
    });

    // Update conversation timestamp
    await prisma.session.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
      },
    });

    const shouldAutoLearn = body.auto_learn ?? body.auto_extract_memories ?? true;
    if (shouldAutoLearn && conv.projectId) {
      scheduleConversationAutoLearn({
        auth,
        projectId: conv.projectId,
        sessionId: conv.sessionId || conversationId,
        userId: conv.userId || undefined,
      });
    }

    return c.json(msg, 201);
  }
);

// ─── Graph: Entities & Relations ─────────────────────────────

api.post(
  "/v1/entities",
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      name: z.string().min(1),
      entity_type: z.string().min(1),
      description: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const body = c.req.valid("json");

    const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

    const embedding = await embedSingle(`${body.entity_type}: ${body.name}${body.description ? ` - ${body.description}` : ""}`);

    const entity = await prisma.entity.upsert({
      where: {
        projectId_name_entityType: {
          projectId: project.id,
          name: body.name,
          entityType: body.entity_type,
        },
      },
      update: {
        description: body.description,
        metadata: body.metadata || {},
        embedding,
        updatedAt: new Date(),
      } as any,
      create: {
        projectId: project.id,
        name: body.name,
        entityType: body.entity_type,
        description: body.description,
        metadata: body.metadata || {},
        embedding,
      } as any,
    });

    return c.json(entity, 201);
  }
);

api.post(
  "/v1/relations",
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      from_entity: z.string(),
      from_type: z.string(),
      to_entity: z.string(),
      to_type: z.string(),
      relation_type: z.enum([
        "imports", "exports", "calls", "implements", "extends",
        "references", "depends_on", "related_to", "part_of",
        "contradicts", "supersedes",
      ]),
      weight: z.number().min(0).max(1).optional(),
      metadata: z.record(z.any()).optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const body = c.req.valid("json");

    const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

    // Find or create entities
    const findOrCreateEntity = async (name: string, type: string) => {
      const existing = await prisma.entity.findFirst({
        where: {
          projectId: project.id,
          name,
          entityType: type,
        },
      });

      if (existing) return existing;

      const embedding = await embedSingle(`${type}: ${name}`);
      return await prisma.entity.create({
        data: { projectId: project.id, name, entityType: type, embedding } as any,
      });
    };

    const fromEntity = await findOrCreateEntity(body.from_entity, body.from_type);
    const toEntity = await findOrCreateEntity(body.to_entity, body.to_type);

    const relation = await prisma.entityRelation.upsert({
      where: {
        fromEntityId_toEntityId_relationType: {
          fromEntityId: fromEntity.id,
          toEntityId: toEntity.id,
          relationType: body.relation_type,
        },
      },
      update: {
        weight: body.weight,
        metadata: body.metadata || {},
      },
      create: {
        projectId: project.id,
        fromEntityId: fromEntity.id,
        toEntityId: toEntity.id,
        relationType: body.relation_type,
        weight: body.weight,
        metadata: body.metadata || {},
      },
    });

    return c.json(relation, 201);
  }
);

api.post(
  "/v1/graph/search",
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      query: z.string().min(1),
      entity_types: z.array(z.string()).optional(),
      depth: z.number().int().min(1).max(3).optional().default(1),
      top_k: z.number().int().min(1).max(50).optional().default(10),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const body = c.req.valid("json");

    const project = await ensureProject(auth.orgId, body.project, auth.isAdmin);

    const queryEmbedding = await embedSingle(body.query);
    if (!dimensionCheck(queryEmbedding)) {
      return c.json({ entities: [], relations: [] });
    }

    // Entity search with proper parameterization
    const relevantEntities = await prisma.$queryRaw(Prisma.sql`
      SELECT
        id, name, "entityType", description, metadata,
        1 - (embedding <=> ${embeddingToSql(queryEmbedding)}) as similarity
      FROM entities
      WHERE "projectId" = ${project.id}
        ${body.entity_types && body.entity_types.length > 0 
          ? Prisma.sql`AND "entityType" IN (${Prisma.join(body.entity_types)})` 
          : Prisma.sql``}
      ORDER BY embedding <=> ${embeddingToSql(queryEmbedding)}
      LIMIT ${body.top_k}
    `);

    // Get relations for found entities
    const entityIds = (relevantEntities as any[]).map((e: any) => e.id);
    let rels: any[] = [];

    if (entityIds.length > 0) {
      rels = await prisma.entityRelation.findMany({
        where: {
          projectId: project.id,
          OR: [
            { fromEntityId: { in: entityIds } },
            { toEntityId: { in: entityIds } },
          ],
        },
        select: {
          id: true,
          fromEntityId: true,
          toEntityId: true,
          relationType: true,
          weight: true,
        },
      });
    }

    return c.json({
      entities: (relevantEntities as any[]).map((e: any) => ({
        ...e,
        score: Math.round(e.similarity * 1000) / 1000,
      })),
      relations: rels,
    });
  }
);

// ─── Webhooks ────────────────────────────────────────────────

api.post(
  "/v1/webhooks",
  zValidator(
    "json",
    z.object({
      url: z.string().url(),
      events: z.array(z.string()).optional(),
      secret: z.string().optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const body = c.req.valid("json");

    const webhook = await prisma.webhook.create({
      data: {
        orgId: auth.orgId,
        url: body.url,
        secret: body.secret || nanoid(32),
        events: body.events || ["source.synced", "document.indexed", "memory.created"],
      },
    });

    return c.json(webhook, 201);
  }
);

api.get("/v1/webhooks", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const results = await prisma.webhook.findMany({
    where: { orgId: auth.orgId },
  });
  return c.json({ webhooks: results });
});

api.delete("/v1/webhooks/:id", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const id = c.req.param("id");

  const webhook = await prisma.webhook.findFirst({
    where: {
      id,
      orgId: auth.orgId,
    },
  });

  if (!webhook) return c.json({ error: "Webhook not found" }, 404);

  await prisma.webhook.delete({ where: { id } });
  return c.json({ deleted: true });
});

api.post("/v1/webhooks/:id/redeliver", async (c) => {
  const auth = c.get("auth") as AuthContext;
  const traceId = c.get("traceId");
  if (!auth.isAdmin) return c.json({ error: "Admin access required", trace_id: traceId }, 403);
  const webhookId = c.req.param("id");
  const endpoint = "/v1/webhooks/:id/redeliver";
  const replay = await loadMutationReplay(c, auth, endpoint, { webhookId });
  if (replay.replay?.type === "conflict") {
    return c.json({ error: "Idempotency payload mismatch", trace_id: traceId }, 409);
  }
  if (replay.replay?.type === "hit") {
    c.header("x-idempotency-replay", "true");
    return c.json(bigIntJson(replay.replay.body), replay.replay.statusCode as any);
  }

  // Verify the webhook belongs to this org before touching its deliveries (IDOR guard)
  const webhook = await prisma.webhook.findFirst({ where: { id: webhookId, orgId: auth.orgId } });
  if (!webhook) {
    return c.json({ error: "Webhook not found", trace_id: traceId }, 404);
  }

  const delivery = await prisma.webhookDelivery.findFirst({
    where: { webhookId },
    orderBy: { deliveredAt: "desc" },
  });
  if (!delivery) {
    return c.json({ error: "Webhook delivery not found", trace_id: traceId }, 404);
  }

  const result = await redeliverWebhookDelivery(delivery.id, {
    traceId,
    parentTraceId: delivery.traceId || traceId,
  });
  const responseBody = {
    redelivered: true,
    delivery_id: delivery.id,
    result,
    trace_id: traceId,
  };
  await storeMutationReplay({
    auth,
    endpoint,
    idempotencyKey: replay.idempotencyKey,
    requestHash: replay.requestHash,
    statusCode: 202,
    body: responseBody,
  });
  return c.json(responseBody, 202);
});

// ─── Usage / Stats ───────────────────────────────────────────

// ─── Organizations (self-service setup) ──────────────────────

// ─── API Keys ────────────────────────────────────────────────

// ─── Async Jobs ──────────────────────────────────────────────

api.get("/v1/admin/latency/stats", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);

  const top = Math.min(Math.max(parseInt(c.req.query("top") || "50", 10), 1), 500);
  const minCount = Math.min(Math.max(parseInt(c.req.query("min_count") || "1", 10), 1), 10000);
  const includeSlowEvents = /^true$/i.test(c.req.query("include_slow") || "false");

  return c.json(
    getLatencySummary({
      top,
      minCount,
      includeSlowEvents,
    })
  );
});

api.get("/v1/admin/latency/gates", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);

  const minCount = Math.min(Math.max(parseInt(c.req.query("min_count") || "20", 10), 1), 100000);
  return c.json(getLatencyGateStatus({ minCount }));
});

api.get("/v1/admin/latency/config", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json(getLatencyTraceConfig());
});

api.post("/v1/admin/latency/reset", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json(resetLatencySummary());
});

// ─── Benchmark: LLM-judge (ADR-010 §7) ──────────────────────
// Used by scripts/benchmark to score dialectic answers semantically instead of
// by anchor substrings. Reuses the dialectic LLM task.
api.post("/v1/admin/benchmark/judge", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const { question, reference_answer, candidate_answer } = body as Record<string, unknown>;
  if (!question || !reference_answer || !candidate_answer) {
    return c.json({ error: "question, reference_answer and candidate_answer are required" }, 400);
  }

  const anchors = Array.isArray((body as any).anchors)
    ? ((body as any).anchors as unknown[]).filter((a): a is string => typeof a === "string")
    : undefined;

  const result = await judgeAnswer({
    question: String(question),
    referenceAnswer: String(reference_answer),
    candidateAnswer: String(candidate_answer),
    anchors,
  });
  return c.json(result);
});

// ─── Telemetry: per-layer drop-off (ADR-011 §1) ─────────────
api.get("/v1/admin/telemetry/drop-off", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json(getDropOffSummary());
});

api.post("/v1/admin/telemetry/reset", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json(resetTelemetry());
});

api.get("/v1/admin/extraction/config", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json(getExtractionPhase0Config());
});

api.get("/v1/admin/extraction/stats", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);

  const lookbackDays = Math.min(Math.max(parseInt(c.req.query("lookback_days") || "14", 10), 1), 90);
  const tenantId = c.req.query("tenant_id") || undefined;
  const projectId = c.req.query("project_id") || undefined;
  return c.json(await getExtractionStats({ lookbackDays, tenantId, projectId }));
});

api.get("/v1/admin/extraction/gates", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);

  const tenantId = c.req.query("tenant_id") || undefined;
  const minDays = Math.min(Math.max(parseInt(c.req.query("min_days") || "7", 10), 1), 60);
  const minSamples = Math.min(Math.max(parseInt(c.req.query("min_samples") || "10000", 10), 1), 1_000_000);
  const lookbackDays = Math.min(Math.max(parseInt(c.req.query("lookback_days") || "30", 10), 1), 365);

  return c.json(await getExtractionGateStatus({ tenantId, minDays, minSamples, lookbackDays }));
});

api.get("/v1/admin/extraction/alerts", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);

  const lookbackHours = Math.min(Math.max(parseInt(c.req.query("lookback_hours") || "24", 10), 1), 168);
  return c.json(await getExtractionAlerts({ lookbackHours }));
});

api.post("/v1/admin/extraction/reset", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json(resetExtractionObservability());
});

api.get("/v1/admin/ops/routes", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json({
    routes: getNodeRouteMatrix(),
    latency: getLatencySummary({ top: 100, minCount: 1, includeSlowEvents: false }),
  });
});

api.get("/v1/admin/ops/retrieval", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json(getRetrievalHealthSummary());
});

api.get("/v1/admin/ops/counters", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  return c.json(await getOperationalCounters());
});

api.get("/v1/admin/ops/webhooks", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  const lookbackHours = Math.min(Math.max(parseInt(c.req.query("lookback_hours") || "24", 10), 1), 168);
  return c.json(await getWebhookFailureSummary({ lookbackHours }));
});

api.get("/v1/admin/ops/alerts", async (c) => {
  const auth = c.get("auth") as AuthContext;
  if (!auth.isAdmin) return c.json({ error: "Admin access required" }, 403);
  const lookbackHours = Math.min(Math.max(parseInt(c.req.query("lookback_hours") || "24", 10), 1), 168);
  return c.json(await evaluateOperationalAlerts({ lookbackHours }));
});
