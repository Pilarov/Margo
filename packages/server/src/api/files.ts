/**
 * Shared File Storage API
 *
 * Routes:
 *   POST   /v1/files                    Upload a file (multipart/form-data)
 *   GET    /v1/files                    List files
 *   GET    /v1/files/:fileId            File metadata + rdb:// URI
 *   GET    /v1/files/:fileId/content    Stream / redirect to file content
 *   POST   /v1/files/:fileId/ingest     Chunk + embed + extract memories
 *   PUT    /v1/files/:fileId            Update path or metadata
 *   DELETE /v1/files/:fileId            Soft-delete (pass ?hard=true to purge)
 *
 * Scopes: USER | PROJECT | ORG | AGENT
 * Address scheme: rdb://files/{orgId}/{path}
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "../db/index.js";
import type { AuthContext } from "../middleware/auth.js";
import { rateLimitMiddleware, RateLimits } from "../middleware/rate-limit.js";
import { getStorageBackend, buildStorageKey, buildRdbUri } from "../lib/storage.js";
import { nanoid } from "nanoid";
import { syncPdf } from "../connectors/pdf.js";
import { syncText } from "../connectors/text.js";
import { extractMemories } from "../engine/memory/extractor-unified.js";
import { writeMemoryCanonical } from "../engine/memory/write.js";
import { ensureProject } from "./helpers.js";

type Variables = { auth: AuthContext };

export const fileRoutes = new Hono<{ Variables: Variables }>();

const FILE_SCOPE_VALUES = ["USER", "PROJECT", "ORG", "AGENT"] as const;
type FileScope = typeof FILE_SCOPE_VALUES[number];

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

function sanitisePath(raw: string): string {
  return (
    "/" +
    raw
      .replace(/\.\./g, "_")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "")
  );
}

function formatFile(f: {
  id: string;
  orgId: string;
  projectId: string | null;
  userId: string | null;
  agentId: string | null;
  path: string;
  name: string;
  mimeType: string | null;
  size: bigint;
  scope: string;
  isPublic: boolean;
  contentHash: string | null;
  metadata: unknown;
  memoryId: string | null;
  memoryIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: f.id,
    org_id: f.orgId,
    project_id: f.projectId,
    user_id: f.userId,
    agent_id: f.agentId,
    path: f.path,
    name: f.name,
    mime_type: f.mimeType,
    size: Number(f.size),
    scope: f.scope,
    is_public: f.isPublic,
    content_hash: f.contentHash,
    metadata: f.metadata,
    memory_id: f.memoryId,
    memory_ids: f.memoryIds ?? [],
    rdb_uri: buildRdbUri(f.orgId, f.path),
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
  };
}

// ─── Upload ───────────────────────────────────────────────────────────────────

fileRoutes.post(
  "/v1/files",
  rateLimitMiddleware(RateLimits.mutation),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const orgId = auth.orgId;

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ success: false, error: { code: "INVALID_BODY", message: "Expected multipart/form-data" } }, 400);
    }

    const fileEntry = formData.get("file");
    if (!fileEntry || typeof fileEntry === "string") {
      return c.json({ success: false, error: { code: "MISSING_FILE", message: "A 'file' field is required" } }, 400);
    }

    const file = fileEntry as File;
    const rawPath = (formData.get("path") as string | null) || `/${file.name}`;
    const scope = ((formData.get("scope") as string | null) || "PROJECT").toUpperCase() as FileScope;
    const projectId = (formData.get("project_id") as string | null) || null;
    const agentId = (formData.get("agent_id") as string | null) || null;
    const isPublic = (formData.get("is_public") as string | null) === "true";
    const metaRaw = formData.get("metadata") as string | null;
    let metadata: Prisma.InputJsonValue = {};
    if (metaRaw) {
      try { metadata = JSON.parse(metaRaw) as Prisma.InputJsonValue; } catch {}
    }

    if (!FILE_SCOPE_VALUES.includes(scope)) {
      return c.json({ success: false, error: { code: "INVALID_SCOPE", message: `scope must be one of: ${FILE_SCOPE_VALUES.join(", ")}` } }, 400);
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
      return c.json({ success: false, error: { code: "FILE_TOO_LARGE", message: "Maximum file size is 100 MB" } }, 413);
    }

    const path = sanitisePath(rawPath);
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const fileId = nanoid();
    const storageKey = buildStorageKey(orgId, fileId, file.name);

    const existing = await prisma.sharedFile.findUnique({ where: { orgId_path: { orgId, path } } });

    const storage = await getStorageBackend();
    await storage.put(storageKey, buffer, file.type || undefined);

    if (existing && existing.storageKey !== storageKey) {
      await storage.delete(existing.storageKey).catch(() => {});
    }

    const record = await prisma.sharedFile.upsert({
      where: { orgId_path: { orgId, path } },
      create: {
        id: fileId,
        orgId,
        projectId,
        userId: auth.userId || null,
        agentId,
        path,
        name: file.name,
        mimeType: file.type || null,
        size: BigInt(buffer.byteLength),
        storageKey,
        scope,
        isPublic,
        contentHash,
        metadata,
      },
      update: {
        name: file.name,
        mimeType: file.type || null,
        size: BigInt(buffer.byteLength),
        storageKey,
        scope,
        isPublic,
        contentHash,
        metadata,
        deletedAt: null,
      },
    });

    return c.json({ success: true, file: formatFile(record) }, 201);
  }
);

// ─── List ─────────────────────────────────────────────────────────────────────

fileRoutes.get(
  "/v1/files",
  rateLimitMiddleware(RateLimits.query),
  zValidator(
    "query",
    z.object({
      prefix: z.string().optional(),
      scope: z.enum(FILE_SCOPE_VALUES).optional(),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      include_deleted: z.enum(["true", "false"]).optional().default("false"),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
      offset: z.coerce.number().int().min(0).optional().default(0),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const { prefix, scope, project_id, agent_id, include_deleted, limit, offset } = c.req.valid("query");

    const where: Record<string, unknown> = { orgId: auth.orgId };

    if (include_deleted !== "true") where.deletedAt = null;
    if (scope) where.scope = scope;
    if (project_id) where.projectId = project_id;
    if (agent_id) where.agentId = agent_id;
    if (prefix) {
      const safe = sanitisePath(prefix);
      where.path = { startsWith: safe };
    }

    const [files, total] = await Promise.all([
      prisma.sharedFile.findMany({ where, orderBy: { path: "asc" }, take: limit, skip: offset }),
      prisma.sharedFile.count({ where }),
    ]);

    return c.json({ success: true, files: files.map(formatFile), total, limit, offset });
  }
);

// ─── Get metadata ─────────────────────────────────────────────────────────────

fileRoutes.get(
  "/v1/files/:fileId",
  rateLimitMiddleware(RateLimits.query),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const { fileId } = c.req.param();

    const file = await prisma.sharedFile.findFirst({
      where: { id: fileId, orgId: auth.orgId, deletedAt: null },
    });

    if (!file) {
      return c.json({ success: false, error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }

    const storage = await getStorageBackend();
    const signedUrl = await storage.presign(file.storageKey, 3600);

    return c.json({
      success: true,
      file: {
        ...formatFile(file),
        ...(signedUrl ? { download_url: signedUrl } : {}),
      },
    });
  }
);

// ─── Get content ─────────────────────────────────────────────────────────────

fileRoutes.get(
  "/v1/files/:fileId/content",
  rateLimitMiddleware(RateLimits.query),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const { fileId } = c.req.param();

    const file = await prisma.sharedFile.findFirst({
      where: { id: fileId, orgId: auth.orgId, deletedAt: null },
    });

    if (!file) {
      return c.json({ success: false, error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }

    const storage = await getStorageBackend();

    const signedUrl = await storage.presign(file.storageKey, 3600);
    if (signedUrl) {
      return c.redirect(signedUrl, 302);
    }

    let data: Buffer;
    try {
      data = await storage.get(file.storageKey);
    } catch {
      return c.json({ success: false, error: { code: "STORAGE_ERROR", message: "File content could not be retrieved" } }, 500);
    }

    const mimeType = file.mimeType || "application/octet-stream";
    c.header("Content-Type", mimeType);
    c.header("Content-Length", String(data.byteLength));
    c.header("Content-Disposition", `inline; filename="${file.name}"`);
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(data as unknown as ReadableStream);
  }
);

// ─── Ingest ───────────────────────────────────────────────────────────────────

fileRoutes.post(
  "/v1/files/:fileId/ingest",
  rateLimitMiddleware(RateLimits.mutation),
  zValidator(
    "json",
    z.object({
      project: z.string().optional(),
      user_id: z.string().optional(),
      agent_id: z.string().optional(),
      skip_memory_extraction: z.boolean().optional().default(false),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const { fileId } = c.req.param();
    const body = c.req.valid("json");

    const file = await prisma.sharedFile.findFirst({
      where: { id: fileId, orgId: auth.orgId, deletedAt: null },
    });
    if (!file) {
      return c.json({ success: false, error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }

    const project = await ensureProject(
      auth.orgId,
      body.project || file.projectId || "default",
      auth.isAdmin
    );
    const projectId = project.id;

    const storage = await getStorageBackend();
    let fileBuffer: Buffer;
    try {
      fileBuffer = await storage.get(file.storageKey);
    } catch {
      return c.json({ success: false, error: { code: "STORAGE_ERROR", message: "Could not retrieve file from storage" } }, 500);
    }

    const mime = (file.mimeType || "").toLowerCase();
    const isPdf = mime === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isText = mime.startsWith("text/") || /\.(md|txt|json|csv|yaml|yml|xml|html|htm)$/i.test(file.name);

    const sourceName = `shared-file:${file.id}`;
    let source = await prisma.source.findFirst({ where: { orgId: auth.orgId, name: sourceName } });
    if (!source) {
      source = await prisma.source.create({
        data: {
          orgId: auth.orgId,
          projectId,
          name: sourceName,
          type: isPdf ? "pdf" : "text",
          connectorType: "shared_file",
          status: "READY",
          config: { file_id: file.id, path: file.path },
        },
      });
    }

    let documentsIndexed = 0;
    let ingestError: string | null = null;
    let extractedText = "";

    try {
      if (isPdf) {
        try {
          const pdfParse = (await import("pdf-parse")).default;
          const parsed = await pdfParse(fileBuffer);
          extractedText = parsed.text || "";
        } catch {}
        const result = await syncPdf(source.id, projectId, {
          content: fileBuffer.toString("base64"),
          title: file.name,
        });
        documentsIndexed = result?.documentsIndexed ?? 1;
      } else if (isText) {
        extractedText = fileBuffer.toString("utf8");
        const result = await syncText(source.id, projectId, {
          title: file.name,
          content: extractedText,
          metadata: { file_id: file.id, path: file.path, mime_type: file.mimeType },
        });
        documentsIndexed = result?.documentsIndexed ?? 1;
      } else {
        extractedText = fileBuffer.toString("utf8");
        if (extractedText.trim().length > 10) {
          const result = await syncText(source.id, projectId, {
            title: file.name,
            content: extractedText,
            metadata: { file_id: file.id, path: file.path, mime_type: file.mimeType },
          });
          documentsIndexed = result?.documentsIndexed ?? 1;
        } else {
          ingestError = "File type is not supported for text extraction";
        }
      }
    } catch (err: any) {
      ingestError = err?.message || "Ingest pipeline error";
    }

    let memoriesCreated = 0;
    let linkedMemoryId = file.memoryId;
    const newMemoryIds: string[] = [];

    if (!body.skip_memory_extraction && !ingestError && documentsIndexed > 0) {
      const extractionText = extractedText.trim().length > 20
        ? extractedText.slice(0, 8000)
        : `Document: ${file.name}\nPath: ${file.path}\nSize: ${(fileBuffer.byteLength / 1024).toFixed(0)} KB`;

      const extraction = await extractMemories(extractionText, "", {
        enablePattern: true,
        enableInference: true,
        sourceRole: "document",
      });

      for (const mem of extraction.all) {
        try {
          const result = await writeMemoryCanonical({
            projectId,
            orgId: auth.orgId,
            userId: body.user_id || auth.userId || undefined,
            agentId: body.agent_id || file.agentId || undefined,
            content: mem.content,
            memoryType: mem.memoryType,
            confidenceRaw: mem.confidence,
            importance: mem.confidence * 0.9,
            entityMentions: mem.entityMentions,
            documentDate: new Date(),
            writeSource: "shared_file_ingest",
            writeMode: "source_extract",
            extractionMethod: extraction.extractionMethod,
            sourceRole: "document",
            scopeHint: "DOCUMENT",
            metadata: { file_id: file.id, file_path: file.path, rdb_uri: buildRdbUri(auth.orgId, file.path) },
          });

          if (result.outcome === "created" && result.memory) {
            memoriesCreated++;
            newMemoryIds.push(result.memory.id);
            if (!linkedMemoryId) linkedMemoryId = result.memory.id;
          }
        } catch {}
      }

      if (newMemoryIds.length > 0) {
        const existingIds: string[] = Array.isArray((file as any).memoryIds) ? (file as any).memoryIds : [];
        const mergedIds = Array.from(new Set([...existingIds, ...newMemoryIds]));
        await prisma.sharedFile.update({
          where: { id: file.id },
          data: { memoryId: linkedMemoryId, memoryIds: mergedIds },
        });
      }
    }

    return c.json({
      success: !ingestError,
      file_id: file.id,
      rdb_uri: buildRdbUri(auth.orgId, file.path),
      documents_indexed: documentsIndexed,
      memories_created: memoriesCreated,
      memory_id: linkedMemoryId,
      memory_ids: newMemoryIds,
      ...(ingestError ? { error: ingestError } : {}),
    });
  }
);

// ─── Update ───────────────────────────────────────────────────────────────────

fileRoutes.put(
  "/v1/files/:fileId",
  rateLimitMiddleware(RateLimits.mutation),
  zValidator(
    "json",
    z.object({
      path: z.string().optional(),
      scope: z.enum(FILE_SCOPE_VALUES).optional(),
      is_public: z.boolean().optional(),
      metadata: z.record(z.any()).optional(),
      agent_id: z.string().nullable().optional(),
    })
  ),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const { fileId } = c.req.param();
    const body = c.req.valid("json");

    const file = await prisma.sharedFile.findFirst({
      where: { id: fileId, orgId: auth.orgId, deletedAt: null },
    });

    if (!file) {
      return c.json({ success: false, error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }

    const updateData: Record<string, unknown> = {};
    if (body.path !== undefined) updateData.path = sanitisePath(body.path);
    if (body.scope !== undefined) updateData.scope = body.scope;
    if (body.is_public !== undefined) updateData.isPublic = body.is_public;
    if (body.metadata !== undefined) updateData.metadata = body.metadata;
    if (body.agent_id !== undefined) updateData.agentId = body.agent_id;

    if (body.path !== undefined) {
      const newPath = sanitisePath(body.path);
      const conflict = await prisma.sharedFile.findFirst({
        where: { orgId: auth.orgId, path: newPath, id: { not: fileId } },
      });
      if (conflict) {
        return c.json({ success: false, error: { code: "PATH_CONFLICT", message: `A file already exists at ${newPath}` } }, 409);
      }
    }

    const updated = await prisma.sharedFile.update({ where: { id: fileId }, data: updateData });
    return c.json({ success: true, file: formatFile(updated) });
  }
);

// ─── Delete ───────────────────────────────────────────────────────────────────

fileRoutes.delete(
  "/v1/files/:fileId",
  rateLimitMiddleware(RateLimits.mutation),
  async (c) => {
    const auth = c.get("auth") as AuthContext;
    const { fileId } = c.req.param();
    const hard = c.req.query("hard") === "true";

    const file = await prisma.sharedFile.findFirst({
      where: { id: fileId, orgId: auth.orgId, deletedAt: null },
    });

    if (!file) {
      return c.json({ success: false, error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }

    if (hard) {
      const storage = await getStorageBackend();
      await storage.delete(file.storageKey).catch(() => {});
      await prisma.sharedFile.delete({ where: { id: fileId } });
    } else {
      await prisma.sharedFile.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    }

    return c.json({ success: true, deleted: fileId });
  }
);
