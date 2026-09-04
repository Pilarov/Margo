-- Idempotent pgvector provisioning (ADR-006).
--
-- Prisma cannot express vector dimensions or ANN indexes; this script owns
-- those specifics. Run AFTER `prisma migrate deploy`. Safe to re-run:
--   ALTER COLUMN ... TYPE vector(1024) is a no-op when already applied,
--   and CREATE INDEX uses IF NOT EXISTS.
--
-- The canonical dimension is 1024 (openai text-embedding-3-small with
-- dimensions:1024, and local BGE-large). If you switch EMBEDDING_MODE=gemini
-- (768-dim), you must re-index and update EMBEDDING_DIM.

ALTER TABLE "memories" ALTER COLUMN "embedding" TYPE vector(1024);
ALTER TABLE "chunks"   ALTER COLUMN "embedding" TYPE vector(1024);
ALTER TABLE "entities" ALTER COLUMN "embedding" TYPE vector(1024);

CREATE INDEX IF NOT EXISTS "memories_embedding_idx"
  ON "memories" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "chunks_embedding_idx"
  ON "chunks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS "entities_embedding_idx"
  ON "entities" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
