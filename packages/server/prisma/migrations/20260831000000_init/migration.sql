-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'READY', 'INDEXING', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'INDEXED', 'READY', 'ERROR');

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "connectorType" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" "SourceStatus" NOT NULL DEFAULT 'PENDING',
    "activeVersionId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "last_sync_at2" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "syncError" TEXT,
    "syncSchedule" TEXT,
    "syncMode" TEXT,
    "lastSyncStatus" TEXT,
    "deletedAt" TIMESTAMP(3),
    "documentCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncDurationMs" INTEGER,
    "syncErrorCount" INTEGER NOT NULL DEFAULT 0,
    "restoreUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_versions" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "orgId" TEXT,
    "projectId" TEXT,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STAGED',
    "documentCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "partialFailure" BOOLEAN NOT NULL DEFAULT false,
    "warningCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "syncJobId" TEXT,
    "promotedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "restoreUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceVersionId" TEXT,
    "projectId" TEXT,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "path" TEXT,
    "mimeType" TEXT,
    "contentHash" TEXT,
    "content" TEXT,
    "language" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "parseError" TEXT,
    "webUrl" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "indexedAt" TIMESTAMP(3),
    "lastModified" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "chunkingStrategy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT,
    "chunkIndex" INTEGER,
    "chunkOrder" INTEGER,
    "chunkType" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT,
    "searchContent" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "parentChunkId" TEXT,
    "sectionPath" TEXT,
    "headingPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embeddings" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "vector" vector NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "orgId" TEXT DEFAULT 'default',
    "userId" TEXT,
    "sessionId" TEXT,
    "agentId" TEXT,
    "taskId" TEXT,
    "memoryType" TEXT NOT NULL DEFAULT 'factual',
    "content" TEXT NOT NULL,
    "embedding" vector,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "scope" TEXT NOT NULL DEFAULT 'USER',
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "recallCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "documentDate" TIMESTAMP(3),
    "eventDate" TIMESTAMP(3),
    "entityMentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "sourceChunkId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "validFrom" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "supersededBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_relations" (
    "id" TEXT NOT NULL,
    "fromMemoryId" TEXT NOT NULL,
    "toMemoryId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "reasoning" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk_memories" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,

    CONSTRAINT "chunk_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityType" TEXT,
    "description" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embedding" vector,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_relations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "sessionId" TEXT,
    "userId" TEXT,
    "agentId" TEXT,
    "taskId" TEXT,
    "title" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_contexts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "title" TEXT,
    "sessionId" TEXT,
    "userId" TEXT,
    "shareUrl" TEXT,
    "memories" JSONB NOT NULL DEFAULT '[]',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "chunks" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "accessCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shared_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceVersionId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'INCREMENTAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "traceId" TEXT,
    "parentTraceId" TEXT,
    "error" TEXT,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_idempotency" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "endpoint" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_idempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_files" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "projectId" TEXT,
    "userId" TEXT,
    "agentId" TEXT,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" BIGINT NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'PROJECT',
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "memoryId" TEXT,
    "memoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "outputSchema" JSONB NOT NULL DEFAULT '{}',
    "template" TEXT,
    "schedule" TEXT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "credentials" JSONB NOT NULL DEFAULT '[]',
    "webhookUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "taskId" TEXT,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL DEFAULT '',
    "goal" TEXT NOT NULL,
    "plan" JSONB,
    "result" JSONB,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PLANNING',
    "totalSteps" INTEGER NOT NULL DEFAULT 0,
    "pagesVisited" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "hitlMessage" TEXT,
    "errorMsg" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_steps" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "screenshot" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_cache" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "html" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT,
    "links" JSONB NOT NULL DEFAULT '[]',
    "screenshot" TEXT,
    "lastFetched" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT NOW() + INTERVAL '1 day',

    CONSTRAINT "page_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_credentials" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "encrypted" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_agent_memories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "agentPersonality" TEXT NOT NULL DEFAULT 'helpful, thoughtful, curious, systematic',
    "learnedPreferences" JSONB NOT NULL DEFAULT '{}',
    "selfNotes" TEXT NOT NULL DEFAULT '',
    "interactionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_agent_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_research_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT,
    "projectId" TEXT,
    "query" TEXT NOT NULL,
    "answer" TEXT NOT NULL DEFAULT '',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "steps" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "isDeepResearch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_research_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "url" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredAt" TIMESTAMP(3),
    "lastDeliveredAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "eventId" TEXT,
    "action" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "statusCode" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "traceId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_slug_idx" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "sources_projectId_idx" ON "sources"("projectId");

-- CreateIndex
CREATE INDEX "sources_status_idx" ON "sources"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sources_projectId_name_key" ON "sources"("projectId", "name");

-- CreateIndex
CREATE INDEX "source_versions_sourceId_status_idx" ON "source_versions"("sourceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "source_versions_sourceId_versionNumber_key" ON "source_versions"("sourceId", "versionNumber");

-- CreateIndex
CREATE INDEX "documents_sourceId_idx" ON "documents"("sourceId");

-- CreateIndex
CREATE INDEX "documents_sourceVersionId_idx" ON "documents"("sourceVersionId");

-- CreateIndex
CREATE INDEX "documents_contentHash_idx" ON "documents"("contentHash");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status");

-- CreateIndex
CREATE INDEX "chunks_documentId_idx" ON "chunks"("documentId");

-- CreateIndex
CREATE INDEX "chunks_contentHash_idx" ON "chunks"("contentHash");

-- CreateIndex
CREATE INDEX "chunks_parentChunkId_idx" ON "chunks"("parentChunkId");

-- CreateIndex
CREATE INDEX "embeddings_chunkId_idx" ON "embeddings"("chunkId");

-- CreateIndex
CREATE INDEX "embeddings_model_idx" ON "embeddings"("model");

-- CreateIndex
CREATE INDEX "memories_projectId_idx" ON "memories"("projectId");

-- CreateIndex
CREATE INDEX "memories_orgId_idx" ON "memories"("orgId");

-- CreateIndex
CREATE INDEX "memories_userId_idx" ON "memories"("userId");

-- CreateIndex
CREATE INDEX "memories_sessionId_idx" ON "memories"("sessionId");

-- CreateIndex
CREATE INDEX "memories_agentId_idx" ON "memories"("agentId");

-- CreateIndex
CREATE INDEX "memories_taskId_idx" ON "memories"("taskId");

-- CreateIndex
CREATE INDEX "memories_memoryType_idx" ON "memories"("memoryType");

-- CreateIndex
CREATE INDEX "memories_scope_idx" ON "memories"("scope");

-- CreateIndex
CREATE INDEX "memories_isActive_idx" ON "memories"("isActive");

-- CreateIndex
CREATE INDEX "memories_expiresAt_idx" ON "memories"("expiresAt");

-- CreateIndex
CREATE INDEX "memories_validFrom_validUntil_idx" ON "memories"("validFrom", "validUntil");

-- CreateIndex
CREATE INDEX "memories_confidence_idx" ON "memories"("confidence");

-- CreateIndex
CREATE INDEX "memories_supersededBy_idx" ON "memories"("supersededBy");

-- CreateIndex
CREATE INDEX "memory_relations_fromMemoryId_idx" ON "memory_relations"("fromMemoryId");

-- CreateIndex
CREATE INDEX "memory_relations_toMemoryId_idx" ON "memory_relations"("toMemoryId");

-- CreateIndex
CREATE UNIQUE INDEX "memory_relations_fromMemoryId_toMemoryId_relationType_key" ON "memory_relations"("fromMemoryId", "toMemoryId", "relationType");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_memories_chunkId_memoryId_key" ON "chunk_memories"("chunkId", "memoryId");

-- CreateIndex
CREATE INDEX "entities_projectId_idx" ON "entities"("projectId");

-- CreateIndex
CREATE INDEX "entities_type_idx" ON "entities"("type");

-- CreateIndex
CREATE UNIQUE INDEX "entities_projectId_name_entityType_key" ON "entities"("projectId", "name", "entityType");

-- CreateIndex
CREATE INDEX "entity_relations_projectId_idx" ON "entity_relations"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "entity_relations_fromEntityId_toEntityId_relationType_key" ON "entity_relations"("fromEntityId", "toEntityId", "relationType");

-- CreateIndex
CREATE INDEX "sessions_projectId_idx" ON "sessions"("projectId");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_sessionId_idx" ON "sessions"("sessionId");

-- CreateIndex
CREATE INDEX "messages_sessionId_idx" ON "messages"("sessionId");

-- CreateIndex
CREATE INDEX "shared_contexts_projectId_idx" ON "shared_contexts"("projectId");

-- CreateIndex
CREATE INDEX "shared_contexts_shareUrl_idx" ON "shared_contexts"("shareUrl");

-- CreateIndex
CREATE INDEX "sync_jobs_sourceId_idx" ON "sync_jobs"("sourceId");

-- CreateIndex
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs"("status");

-- CreateIndex
CREATE INDEX "ingestion_jobs_projectId_idx" ON "ingestion_jobs"("projectId");

-- CreateIndex
CREATE INDEX "ingestion_jobs_status_idx" ON "ingestion_jobs"("status");

-- CreateIndex
CREATE INDEX "ingestion_jobs_type_idx" ON "ingestion_jobs"("type");

-- CreateIndex
CREATE INDEX "api_idempotency_expiresAt_idx" ON "api_idempotency"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_idempotency_orgId_endpoint_idempotencyKey_key" ON "api_idempotency"("orgId", "endpoint", "idempotencyKey");

-- CreateIndex
CREATE INDEX "shared_files_orgId_scope_idx" ON "shared_files"("orgId", "scope");

-- CreateIndex
CREATE INDEX "shared_files_orgId_agentId_idx" ON "shared_files"("orgId", "agentId");

-- CreateIndex
CREATE INDEX "shared_files_projectId_idx" ON "shared_files"("projectId");

-- CreateIndex
CREATE INDEX "shared_files_deletedAt_idx" ON "shared_files"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "shared_files_orgId_path_key" ON "shared_files"("orgId", "path");

-- CreateIndex
CREATE INDEX "agent_tasks_orgId_idx" ON "agent_tasks"("orgId");

-- CreateIndex
CREATE INDEX "agent_runs_orgId_idx" ON "agent_runs"("orgId");

-- CreateIndex
CREATE INDEX "agent_runs_taskId_idx" ON "agent_runs"("taskId");

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "agent_runs"("status");

-- CreateIndex
CREATE INDEX "agent_run_steps_runId_idx" ON "agent_run_steps"("runId");

-- CreateIndex
CREATE INDEX "page_cache_expiresAt_idx" ON "page_cache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "page_cache_orgId_url_key" ON "page_cache"("orgId", "url");

-- CreateIndex
CREATE INDEX "agent_credentials_orgId_idx" ON "agent_credentials"("orgId");

-- CreateIndex
CREATE INDEX "user_agent_memories_orgId_idx" ON "user_agent_memories"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "user_agent_memories_userId_orgId_key" ON "user_agent_memories"("userId", "orgId");

-- CreateIndex
CREATE INDEX "agent_research_sessions_userId_idx" ON "agent_research_sessions"("userId");

-- CreateIndex
CREATE INDEX "agent_research_sessions_orgId_idx" ON "agent_research_sessions"("orgId");

-- CreateIndex
CREATE INDEX "webhooks_orgId_idx" ON "webhooks"("orgId");

-- CreateIndex
CREATE INDEX "webhooks_projectId_idx" ON "webhooks"("projectId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhookId_idx" ON "webhook_deliveries"("webhookId");

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "source_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_parentChunkId_fkey" FOREIGN KEY ("parentChunkId") REFERENCES "chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_sourceChunkId_fkey" FOREIGN KEY ("sourceChunkId") REFERENCES "chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersededBy_fkey" FOREIGN KEY ("supersededBy") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_fromMemoryId_fkey" FOREIGN KEY ("fromMemoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_toMemoryId_fkey" FOREIGN KEY ("toMemoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk_memories" ADD CONSTRAINT "chunk_memories_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk_memories" ADD CONSTRAINT "chunk_memories_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_contexts" ADD CONSTRAINT "shared_contexts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_files" ADD CONSTRAINT "shared_files_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

