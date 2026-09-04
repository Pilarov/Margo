#!/usr/bin/env bash
# Provision a fresh Margo database (ADR-006).
#
# 1. Apply Prisma migrations (table structure).
# 2. Apply pgvector specifics (dimension + ivfflat indexes) that Prisma cannot
#    express, from packages/server/prisma/scripts/pgvector.sql.
#
# Requirements:
#   - PostgreSQL with pgvector extension available (e.g. pgvector/pgvector:pg16)
#   - DATABASE_URL exported (Prisma) and parseable by psql
#
# The `vector` extension must already exist in the database (pgvector is not a
# trusted extension on all builds, so it is created by a superuser at
# provisioning time — see CONFIGURATION.md).

set -euo pipefail
cd "$(dirname "$0")/.."

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
PGPASSWORD="${PGPASSWORD:-retaindb}"

echo "==> 1/2 Applying Prisma migrations"
(cd packages/server && pnpm prisma migrate deploy)

echo "==> 2/2 Applying pgvector indexes (dimension + ivfflat)"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f packages/server/prisma/scripts/pgvector.sql

echo "==> Done. Database is provisioned for Margo."
