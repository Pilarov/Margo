/**
 * High-performance ingestion queue with parallel processing.
 *
 * Storage model (OSS schema): the `ingestion_jobs` table is a generic job table
 *   id, projectId, sourceId, status, type, payload (jsonb), result (jsonb),
 *   error, startedAt, finishedAt, createdAt, updatedAt
 * There is no `ingestion_documents` table in OSS, so the queued items live inside
 * `payload.items` and progress counters inside `payload.counts`.
 */

import { prisma } from "../db/index.js";
import { ingestDocument } from "./ingest.js";
import { ingestSession } from "./memory/index.js";
import { writeMemoryCanonical } from "./memory/write.js";
import { withRetryableWriteRetries } from "./memory/write-reliability.js";

export type IngestionJobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface IngestionJob {
  id: string;
  orgId: string;
  projectId: string;
  userId: string;
  status: IngestionJobStatus;
  totalDocuments: number;
  processedDocuments: number;
  totalChunks: number;
  processedChunks: number;
  webhookUrl?: string;
  metadata: Record<string, any>;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface IngestionDocument {
  title: string;
  content: string;
  url?: string;
  metadata?: Record<string, any>;
  namespace?: string;
  tags?: string[];
  ingestion_profile?: "auto" | "repo" | "web_docs" | "pdf_layout" | "video_transcript" | "plain_text";
  strategy_override?: "fixed" | "recursive" | "semantic" | "hierarchical" | "adaptive";
  profile_config?: Record<string, any>;
}

export interface IngestionMemory {
  content: string;
  memory_type?: string;
  user_id?: string;
  session_id?: string;
  agent_id?: string;
  task_id?: string;
  importance?: number;
  metadata?: Record<string, any>;
  expires_in_seconds?: number;
}

export interface IngestionConversation {
  session_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  title?: string;
  messages: Array<{ role: string; content: string }>;
  events?: Array<Record<string, any>>;
  metadata?: Record<string, any>;
}

interface QueuedItem {
  id: string;
  title: string;
  content: string;
  url: string | null;
  metadata: Record<string, any>;
  status: "PENDING" | "COMPLETED" | "FAILED";
  error?: string;
  documentId?: string;
}

interface JobPayload {
  orgId: string;
  userId: string;
  webhookUrl?: string;
  chunkSize: number;
  chunkOverlap: number;
  namespace?: string;
  tags: string[];
  ingestionProfile?: string;
  strategyOverride?: string;
  profileConfig?: Record<string, any>;
  counts: {
    totalDocuments: number;
    processedDocuments: number;
    totalChunks: number;
    processedChunks: number;
  };
  items: QueuedItem[];
}

const INGESTION_RETRY_MAX_ATTEMPTS = parseInt(process.env.INGESTION_RETRY_MAX_ATTEMPTS || "5", 10);
const INGESTION_RETRY_BACKOFF_MS = parseInt(process.env.INGESTION_RETRY_BACKOFF_MS || "750", 10);

class IngestionQueue {
  private processing = new Map<string, boolean>();
  private maxConcurrent = 50;

  async createJob(params: {
    orgId: string;
    projectId: string;
    userId: string;
    documents?: IngestionDocument[];
    memories?: IngestionMemory[];
    conversations?: IngestionConversation[];
    webhookUrl?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    namespace?: string;
    tags?: string[];
  }): Promise<string> {
    const { randomUUID } = await import("crypto");
    const jobId = randomUUID();

    const items: QueuedItem[] = [];

    for (const [idx, doc] of (params.documents ?? []).entries()) {
      items.push({
        id: randomUUID(),
        title: doc.title,
        content: doc.content,
        url: doc.url ?? null,
        metadata: {
          ...(doc.metadata || {}),
          type: "document",
          namespace: doc.namespace || params.namespace,
          tags: [...(doc.tags || []), ...(params.tags || [])],
          ingestion_profile: doc.ingestion_profile,
          strategy_override: doc.strategy_override,
          profile_config: doc.profile_config,
          index: idx,
        },
        status: "PENDING",
      });
    }

    for (const [idx, mem] of (params.memories ?? []).entries()) {
      items.push({
        id: randomUUID(),
        title: `Memory ${idx + 1}`,
        content: mem.content,
        url: null,
        metadata: {
          type: "memory",
          memory_type: mem.memory_type,
          user_id: mem.user_id,
          session_id: mem.session_id,
          agent_id: mem.agent_id,
          task_id: mem.task_id,
          importance: mem.importance,
          expires_in_seconds: mem.expires_in_seconds,
          namespace: mem.metadata?.namespace || params.namespace,
          tags: [...(mem.metadata?.tags || []), ...(params.tags || [])],
          index: idx,
        },
        status: "PENDING",
      });
    }

    for (const [idx, conv] of (params.conversations ?? []).entries()) {
      const content = conv.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
      items.push({
        id: randomUUID(),
        title: conv.title || `Conversation ${idx + 1}`,
        content,
        url: null,
        metadata: {
          type: "conversation",
          session_id: conv.session_id,
          user_id: conv.user_id,
          agent_id: conv.agent_id || conv.metadata?.agent_id,
          task_id: conv.task_id || conv.metadata?.task_id,
          events: conv.events || conv.metadata?.events || [],
          promotion_mode: conv.metadata?.promotion_mode,
          messages: conv.messages,
          namespace: conv.metadata?.namespace || params.namespace,
          tags: [...(conv.metadata?.tags || []), ...(params.tags || [])],
          index: idx,
        },
        status: "PENDING",
      });
    }

    const payload: JobPayload = {
      orgId: params.orgId,
      userId: params.userId,
      webhookUrl: params.webhookUrl,
      chunkSize: params.chunkSize || 1000,
      chunkOverlap: params.chunkOverlap || 200,
      namespace: params.namespace,
      tags: params.tags || [],
      ingestionProfile: params.documents?.[0]?.ingestion_profile,
      strategyOverride: params.documents?.[0]?.strategy_override,
      profileConfig: params.documents?.[0]?.profile_config,
      counts: {
        totalDocuments: items.length,
        processedDocuments: 0,
        totalChunks: 0,
        processedChunks: 0,
      },
      items,
    };

    await prisma.$executeRaw`
      INSERT INTO ingestion_jobs (id, "projectId", status, type, payload, "createdAt", "updatedAt")
      VALUES (
        ${jobId}, ${params.projectId}, 'PENDING', 'ingestion',
        ${JSON.stringify(payload)}::jsonb, NOW(), NOW()
      )
    `;

    // Fire-and-forget processing.
    this.processJob(jobId).catch((err) => {
      console.error(`[IngestionQueue] Job ${jobId} failed:`, err);
    });

    return jobId;
  }

  private async loadJob(jobId: string): Promise<{ id: string; projectId: string; payload: JobPayload } | null> {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT id, "projectId", payload FROM ingestion_jobs WHERE id = ${jobId}
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    const payload = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as JobPayload;
    return { id: row.id, projectId: row.projectId, payload };
  }

  private async saveCounts(jobId: string, counts: JobPayload["counts"]): Promise<void> {
    await prisma.$executeRaw`
      UPDATE ingestion_jobs
      SET payload = jsonb_set(payload, '{counts}', ${JSON.stringify(counts)}::jsonb),
          "updatedAt" = NOW()
      WHERE id = ${jobId}
    `;
  }

  private async processJob(jobId: string) {
    if (this.processing.get(jobId)) return;
    this.processing.set(jobId, true);

    try {
      const job = await this.loadJob(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);

      await prisma.$executeRaw`
        UPDATE ingestion_jobs
        SET status = 'PROCESSING', "startedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = ${jobId}
      `;

      await this.sendWebhook(job.payload.webhookUrl, {
        event: "ingestion.started",
        jobId,
        totalDocuments: job.payload.counts.totalDocuments,
        timestamp: new Date().toISOString(),
      });

      // Share the same counts object with processItem/incrementChunks so their
      // totalChunks updates are not clobbered by a stale copy here.
      const counts = job.payload.counts;
      const batchSize = this.maxConcurrent;

      for (let i = 0; i < job.payload.items.length; i += batchSize) {
        const batch = job.payload.items.slice(i, i + batchSize);

        const results = await Promise.allSettled(batch.map((item) => this.processItem(job, item)));
        for (const r of results) {
          if (r.status === "rejected") {
            console.error(`[IngestionQueue] Batch item failed:`, r.reason);
          }
        }

        counts.processedDocuments = Math.min(i + batchSize, job.payload.items.length);
        await this.saveCounts(jobId, counts);

        await this.sendWebhook(job.payload.webhookUrl, {
          event: "ingestion.progress",
          jobId,
          processedDocuments: counts.processedDocuments,
          totalDocuments: counts.totalDocuments,
          progress: counts.totalDocuments > 0 ? (counts.processedDocuments / counts.totalDocuments) * 100 : 100,
          timestamp: new Date().toISOString(),
        });
      }

      await prisma.$executeRaw`
        UPDATE ingestion_jobs
        SET status = 'COMPLETED', "finishedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = ${jobId}
      `;

      await this.sendWebhook(job.payload.webhookUrl, {
        event: "ingestion.completed",
        jobId,
        totalDocuments: counts.totalDocuments,
        totalChunks: counts.totalChunks,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error(`[IngestionQueue] Job ${jobId} failed:`, error);
      await prisma.$executeRaw`
        UPDATE ingestion_jobs
        SET status = 'FAILED', error = ${error?.message || String(error)},
            "finishedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = ${jobId}
      `.catch(() => { /* best-effort */ });

      const job = await this.loadJob(jobId).catch(() => null);
      await this.sendWebhook(job?.payload?.webhookUrl, {
        event: "ingestion.failed",
        jobId,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.processing.delete(jobId);
    }
  }

  private async incrementChunks(job: { id: string; payload: JobPayload }, delta: number): Promise<void> {
    job.payload.counts.totalChunks += delta;
    job.payload.counts.processedChunks += delta;
    await this.saveCounts(job.id, job.payload.counts);
  }

  private async processItem(job: { id: string; projectId: string; payload: JobPayload }, item: QueuedItem) {
    try {
      const metadata = item.metadata || {};
      const jobMeta = job.payload;
      const namespace = metadata.namespace || jobMeta.namespace;
      const tags = metadata.tags || jobMeta.tags || [];
      const type = metadata.type || "document";

      if (type === "memory") {
        const expiresAt = metadata.expires_in_seconds
          ? new Date(Date.now() + metadata.expires_in_seconds * 1000)
          : null;
        const documentDate = metadata.document_date ? new Date(metadata.document_date) : null;
        const eventDate = metadata.event_date ? new Date(metadata.event_date) : null;

        const writeResult = await withRetryableWriteRetries(
          () =>
            writeMemoryCanonical({
              projectId: job.projectId,
              orgId: jobMeta.orgId,
              userId: metadata.user_id || null,
              sessionId: metadata.session_id || null,
              agentId: metadata.agent_id || null,
              taskId: metadata.task_id || null,
              content: item.content,
              memoryType: metadata.memory_type || "factual",
              importance: metadata.importance || 0.5,
              confidenceRaw: metadata.confidence_raw || metadata.confidence || 0.8,
              entityMentions: metadata.entity_mentions || [],
              documentDate,
              eventDate,
              expiresAt,
              metadata: { ...(metadata || {}), namespace, tags },
              writeSource: metadata.write_source || "ingestion_queue.memory",
              writeMode: metadata.write_mode || "direct_write",
              extractionMethod: metadata.extraction_method || "manual",
              scopeHint: metadata.scope_target || undefined,
              promotionMode: metadata.promotion_mode || undefined,
              sessionRetentionDays: 14,
            }),
          {
            maxAttempts: INGESTION_RETRY_MAX_ATTEMPTS,
            baseDelayMs: INGESTION_RETRY_BACKOFF_MS,
            label: "IngestionQueue.writeMemory",
          }
        );

        if (writeResult.outcome === "dropped") {
          item.status = "FAILED";
          item.error = `memory dropped: ${writeResult.validatorIssues.join(", ")}`;
          return { success: false };
        }

        item.status = "COMPLETED";
        await this.incrementChunks(job, 1);
      } else if (type === "conversation") {
        const messages = Array.isArray(metadata.messages)
          ? metadata.messages.map((message: any) => ({
              role: String(message?.role || "user"),
              content: String(message?.content || ""),
              timestamp: message?.timestamp ? new Date(message.timestamp) : new Date(),
            }))
          : [];

        await ingestSession({
          sessionId: metadata.session_id || `session_${item.id}`,
          projectId: job.projectId,
          orgId: jobMeta.orgId,
          userId: metadata.user_id,
          agentId: metadata.agent_id,
          taskId: metadata.task_id,
          events: Array.isArray(metadata.events) ? metadata.events : [],
          promotionMode: metadata.promotion_mode,
          messages,
        });

        item.status = "COMPLETED";
        await this.incrementChunks(job, messages.length);
      } else {
        const sourceId = await this.ensureAsyncJobSource(job);
        const result = await ingestDocument({
          sourceId,
          projectId: job.projectId,
          externalId: item.id,
          title: item.title,
          content: item.content,
          metadata: metadata || {},
          url: item.url ?? undefined,
          filePath: metadata?.file_path,
          ingestionProfile: (metadata?.ingestion_profile || jobMeta.ingestionProfile) as any,
          strategyOverride: (metadata?.strategy_override || jobMeta.strategyOverride) as any,
          profileConfig: metadata?.profile_config || jobMeta.profileConfig,
        });

        item.status = "COMPLETED";
        item.documentId = result.documentId;
        await this.incrementChunks(job, result.chunksCreated || 1);
      }

      return { success: true };
    } catch (error: any) {
      console.error(`[IngestionQueue] Item ${item.id} failed:`, error);
      item.status = "FAILED";
      item.error = error?.message || String(error);
      return { success: false, error: item.error };
    }
  }

  private async sendWebhook(url: string | null | undefined, payload: any, attempt = 0) {
    if (!url) return;

    const MAX_ATTEMPTS = 4;
    const BACKOFF_BASE_MS = 500;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Event": payload.event },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (error: any) {
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        console.warn(`[Webhook] Attempt ${attempt + 1} failed for ${url}, retrying in ${delay}ms:`, error.message);
        await new Promise((r) => setTimeout(r, delay));
        return this.sendWebhook(url, payload, attempt + 1);
      }
      console.error(`[Webhook] All ${MAX_ATTEMPTS} attempts failed for ${url}:`, error.message);
    }
  }

  async getJobStatus(jobId: string): Promise<any> {
    const rows = await prisma.$queryRaw<any[]>`
      SELECT id, "projectId", status, payload, result, error, "startedAt", "finishedAt"
      FROM ingestion_jobs WHERE id = ${jobId}
    `;
    if (rows.length === 0) return null;

    const job = rows[0];
    const payload = (typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload) as JobPayload;
    const counts = payload?.counts ?? {
      totalDocuments: 0, processedDocuments: 0, totalChunks: 0, processedChunks: 0,
    };

    return {
      id: job.id,
      orgId: payload?.orgId,
      projectId: job.projectId,
      status: job.status,
      totalDocuments: counts.totalDocuments,
      processedDocuments: counts.processedDocuments,
      totalChunks: counts.totalChunks,
      processedChunks: counts.processedChunks,
      progress: counts.totalDocuments > 0 ? (counts.processedDocuments / counts.totalDocuments) * 100 : 0,
      startedAt: job.startedAt,
      completedAt: job.finishedAt,
      error: job.error,
      metadata: payload,
    };
  }

  private async ensureAsyncJobSource(job: { id: string; projectId: string; payload: JobPayload }): Promise<string> {
    const sourceName = `async-ingest-${job.id}`;
    const existing = await prisma.source.findFirst({
      where: {
        orgId: job.payload.orgId,
        projectId: job.projectId,
        connectorType: "custom",
        name: sourceName,
      },
      select: { id: true },
    });
    if (existing?.id) return existing.id;

    const created = await prisma.source.create({
      data: {
        orgId: job.payload.orgId,
        projectId: job.projectId,
        name: sourceName,
        type: "custom",
        connectorType: "custom",
        config: { async_job_id: job.id },
        status: "INDEXING",
      },
      select: { id: true },
    });
    return created.id;
  }
}

export const ingestionQueue = new IngestionQueue();
