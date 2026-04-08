/**
 * Session Lifecycle — automatic multi-session memory
 *
 * Problem: SESSION-scoped memories die when a session goes cold.
 * After the threshold change, most user-identity memories now go straight to USER scope.
 * This module catches the rest: after 2h of inactivity it promotes eligible SESSION
 * memories to USER scope and writes a session summary as a USER-scoped factual memory.
 *
 * The summary automatically surfaces in future sessions via getContext() because
 * USER-scoped memories are always included in search when userId is present.
 *
 * Developer does nothing. runTurn() → memory persists → next session, it's there.
 */

import OpenAI from "openai";
import { prisma } from "../../db/index.js";
import { writeMemoryCanonical } from "./write.js";

const SESSION_INACTIVITY_MS = parseInt(
  process.env.SESSION_INACTIVITY_THRESHOLD_MS ?? "7200000", // 2h default
  10
);
const SUMMARY_MIN_MEMORIES = parseInt(process.env.SESSION_SUMMARY_MIN_MEMORIES ?? "2", 10);
const MAX_SESSIONS_PER_RUN = 20;
const PROMOTION_CONFIDENCE_FLOOR = 0.60;

// Types worth keeping at the user level
const PROMOTABLE_TYPES = new Set([
  "preference", "goal", "instruction", "factual",
  "opinion", "relationship", "constraint", "workflow",
]);

interface StaleSession {
  sessionId: string;
  userId: string | null;
  projectId: string;
  orgId: string | null;
  lastActivity: Date;
  memoryCount: bigint;
}

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? "",
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
}

function getSessionSummaryModel(): string {
  return process.env.SESSION_SUMMARY_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini";
}

function getMaxOutputTokensParam(model: string, maxTokens: number) {
  return /^gpt-5/i.test(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/**
 * Sessions where:
 * - last memory write was > SESSION_INACTIVITY_MS ago
 * - they have SESSION-scoped memories
 * - no summary has been written yet
 */
async function findStaleSessions(): Promise<StaleSession[]> {
  const cutoff = new Date(Date.now() - SESSION_INACTIVITY_MS);

  return prisma.$queryRaw<StaleSession[]>`
    SELECT
      m."sessionId"   AS "sessionId",
      m."userId"      AS "userId",
      m."projectId"   AS "projectId",
      m."orgId"       AS "orgId",
      MAX(m."createdAt") AS "lastActivity",
      COUNT(*)        AS "memoryCount"
    FROM memories m
    WHERE
      m."sessionId" IS NOT NULL
      AND m."scope"    = 'SESSION'
      AND m."isActive" = true
      AND NOT EXISTS (
        SELECT 1 FROM memories s
        WHERE s."userId"    = m."userId"
          AND s."projectId" = m."projectId"
          AND s."isActive"  = true
          AND (s.metadata->>'session_summary')::text = 'true'
          AND (s.metadata->>'source_session_id')::text = m."sessionId"
      )
    GROUP BY m."sessionId", m."userId", m."projectId", m."orgId"
    HAVING MAX(m."createdAt") < ${cutoff}
    ORDER BY MAX(m."createdAt") ASC
    LIMIT ${MAX_SESSIONS_PER_RUN}
  `;
}

/**
 * Promote SESSION memories to USER scope for sessions that have gone cold.
 * Only promotes types that carry user-level meaning and have sufficient confidence.
 */
async function promoteSessionMemories(
  session: StaleSession
): Promise<{ promoted: number; skipped: number }> {
  if (!session.userId) return { promoted: 0, skipped: 0 };

  const memories = await prisma.memory.findMany({
    where: {
      sessionId: session.sessionId,
      scope: "SESSION",
      isActive: true,
    },
  });

  let promoted = 0;
  let skipped = 0;

  for (const memory of memories) {
    const memType = String(memory.memoryType ?? "").toLowerCase();
    const confidence = Number(memory.confidence ?? 0);

    if (!PROMOTABLE_TYPES.has(memType) || confidence < PROMOTION_CONFIDENCE_FLOOR) {
      skipped++;
      continue;
    }

    // Skip if an equivalent USER memory already exists (exact content match)
    const alreadyExists = await prisma.memory.findFirst({
      where: {
        userId: session.userId,
        projectId: session.projectId,
        scope: "USER",
        isActive: true,
        content: memory.content,
      },
      select: { id: true },
    });

    if (alreadyExists) {
      skipped++;
      continue;
    }

    const existingMeta =
      typeof memory.metadata === "object" && memory.metadata !== null
        ? (memory.metadata as Record<string, unknown>)
        : {};

    await prisma.memory.update({
      where: { id: memory.id },
      data: {
        scope: "USER",
        metadata: {
          ...existingMeta,
          promoted_from_session: true,
          source_session_id: session.sessionId,
          promoted_at: new Date().toISOString(),
        },
      },
    });
    promoted++;
  }

  return { promoted, skipped };
}

/**
 * LLM-generates a dense single-sentence summary of the session and writes it
 * as a USER-scoped factual memory. Future sessions pick this up automatically
 * via the existing USER scope inclusion in searchMemories().
 */
async function generateSessionSummary(session: StaleSession): Promise<string | null> {
  if (!session.userId) return null;

  const memories = await prisma.memory.findMany({
    where: {
      sessionId: session.sessionId,
      isActive: true,
    },
    orderBy: { createdAt: "asc" },
    take: 60,
    select: { memoryType: true, content: true, createdAt: true },
  });

  if (memories.length < SUMMARY_MIN_MEMORIES) return null;

  const sessionDate = new Date(session.lastActivity).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const memoryLines = memories
    .map((m) => `[${m.memoryType}] ${m.content}`)
    .join("\n");

  try {
    const openai = getOpenAI();
    const model = getSessionSummaryModel();
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0,
      ...getMaxOutputTokensParam(model, 220),
      messages: [
        {
          role: "system",
          content:
            `You summarize a user session into ONE dense sentence (≤220 chars) for long-term memory. ` +
            `Capture: what was worked on, key decisions, important context that would help an AI assistant ` +
            `in a future session. Start with "Session ${sessionDate}:". Be specific — no generic phrases.`,
        },
        {
          role: "user",
          content: memoryLines,
        },
      ],
    });

    const summary = completion.choices[0]?.message?.content?.trim();
    if (!summary || summary.length < 20) return null;

    const result = await writeMemoryCanonical({
      projectId: session.projectId,
      orgId: session.orgId ?? undefined,
      userId: session.userId,
      sessionId: session.sessionId,
      content: summary,
      memoryType: "factual",
      confidenceRaw: 0.92,
      importance: 0.75,
      metadata: {
        session_summary: true,
        source_session_id: session.sessionId,
        session_date: sessionDate,
        memory_count: Number(session.memoryCount),
      },
      writeSource: "session_lifecycle",
      writeMode: "session_extract",
      extractionMethod: "session_summary",
      scopeHint: "USER",
      enableRelationDetection: false,
    });

    return result.memory?.id ?? null;
  } catch (err) {
    console.error(
      `[session-lifecycle] Summary generation failed for session ${session.sessionId}:`,
      err
    );
    return null;
  }
}

async function processSession(session: StaleSession): Promise<void> {
  const [promotionResult, summaryId] = await Promise.allSettled([
    promoteSessionMemories(session),
    generateSessionSummary(session),
  ]);

  const prom =
    promotionResult.status === "fulfilled"
      ? promotionResult.value
      : { promoted: 0, skipped: 0 };

  const sumId =
    summaryId.status === "fulfilled" ? summaryId.value : null;

  console.log(
    `[session-lifecycle] ${session.sessionId}: promoted=${prom.promoted} skipped=${prom.skipped} summary=${sumId ?? "skipped"}`
  );
}

let isRunning = false;

/**
 * Called by the scheduler every 10 minutes.
 * Finds cold sessions and promotes/summarizes them automatically.
 * All errors are caught per-session so one bad session never blocks others.
 */
export async function runSessionLifecycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const sessions = await findStaleSessions();
    if (sessions.length === 0) return;

    console.log(`[session-lifecycle] Processing ${sessions.length} stale session(s)`);

    for (const session of sessions) {
      await processSession(session).catch((err) =>
        console.error(`[session-lifecycle] Error on session ${session.sessionId}:`, err)
      );
    }
  } catch (err) {
    console.error("[session-lifecycle] Lifecycle run error:", err);
  } finally {
    isRunning = false;
  }
}
