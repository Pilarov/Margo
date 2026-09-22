import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockExecuteRaw,
  mockQueryRaw,
  mockWriteMemory,
  mockIngestDocument,
  mockIngestSession,
  mockSourceFindFirst,
  mockSourceCreate,
} = vi.hoisted(() => ({
  mockExecuteRaw: vi.fn(),
  mockQueryRaw: vi.fn(),
  mockWriteMemory: vi.fn(),
  mockIngestDocument: vi.fn(),
  mockIngestSession: vi.fn(),
  mockSourceFindFirst: vi.fn(),
  mockSourceCreate: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  prisma: {
    $executeRaw: mockExecuteRaw,
    $queryRaw: mockQueryRaw,
    source: { findFirst: mockSourceFindFirst, create: mockSourceCreate },
  },
}));
vi.mock("../../engine/ingest.js", () => ({ ingestDocument: mockIngestDocument }));
vi.mock("../../engine/memory/index.js", () => ({ ingestSession: mockIngestSession }));
vi.mock("../../engine/memory/write.js", () => ({ writeMemoryCanonical: mockWriteMemory }));
vi.mock("../../engine/memory/write-reliability.js", () => ({
  withRetryableWriteRetries: (fn: () => unknown) => fn(),
}));

import { ingestionQueue } from "../../engine/ingestion-queue.js";

function sqlOf(call: unknown[]): string {
  const strings = call[0];
  return Array.isArray(strings) ? strings.join("?") : String(strings);
}

describe("ingestionQueue (OSS schema)", () => {
  beforeEach(() => {
    mockExecuteRaw.mockReset().mockResolvedValue(1);
    mockQueryRaw.mockReset().mockResolvedValue([]);
    mockWriteMemory.mockReset();
    mockIngestDocument.mockReset();
    mockIngestSession.mockReset();
    mockSourceFindFirst.mockReset();
    mockSourceCreate.mockReset();
  });

  it("createJob inserts into the OSS ingestion_jobs columns (no org_id/user_id)", async () => {
    const jobId = await ingestionQueue.createJob({
      orgId: "default",
      projectId: "p1",
      userId: "u1",
      memories: [{ content: "hello" }],
    });

    expect(typeof jobId).toBe("string");
    const insert = mockExecuteRaw.mock.calls.map(sqlOf).find((s) => s.includes("INSERT INTO ingestion_jobs"));
    expect(insert).toBeTruthy();
    expect(insert).toContain('"projectId"');
    expect(insert).toContain("payload");
    expect(insert).toContain("'ingestion'");
    expect(insert).not.toContain("org_id");
    expect(insert).not.toContain("user_id");
    expect(insert).not.toContain("total_documents");
  });

  it("does not touch a non-existent ingestion_documents table", async () => {
    await ingestionQueue.createJob({
      orgId: "default",
      projectId: "p1",
      userId: "u1",
      memories: [{ content: "hello" }],
    });

    for (const call of mockExecuteRaw.mock.calls) {
      expect(sqlOf(call)).not.toContain("ingestion_documents");
    }
  });

  it("getJobStatus maps counts/metadata out of payload", async () => {
    mockQueryRaw.mockResolvedValueOnce([{
      id: "j1",
      projectId: "p1",
      status: "COMPLETED",
      payload: {
        orgId: "default",
        userId: "u1",
        counts: { totalDocuments: 3, processedDocuments: 3, totalChunks: 5, processedChunks: 5 },
        items: [],
      },
      result: null,
      error: null,
      startedAt: "2026-09-22T00:00:00.000Z",
      finishedAt: "2026-09-22T00:01:00.000Z",
    }]);

    const status = await ingestionQueue.getJobStatus("j1");

    expect(status).toMatchObject({
      id: "j1",
      projectId: "p1",
      status: "COMPLETED",
      orgId: "default",
      totalDocuments: 3,
      processedDocuments: 3,
      totalChunks: 5,
      progress: 100,
    });
  });

  it("getJobStatus returns null for a missing job", async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    expect(await ingestionQueue.getJobStatus("nope")).toBeNull();
  });
});
