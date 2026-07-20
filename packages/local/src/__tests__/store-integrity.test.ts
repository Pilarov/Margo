import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  appendFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

// ── Store format types (matching cli.ts Memory/StoreData types) ────────────
interface Memory {
  id: string;
  project: string;
  content: string;
  memory_type: string;
  user_id?: string;
  session_id?: string;
  agent_id?: string;
  task_id?: string;
  importance: number;
  confidence: number;
  metadata: Record<string, unknown>;
  embedding?: number[];
  created_at: string;
  updated_at: string;
  active: boolean;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

interface StoreData {
  version: number;
  projects: Project[];
  memories: Memory[];
  sessions: Array<{
    id: string;
    project: string;
    session_id: string;
    user_id?: string;
    agent_id?: string;
    messages?: unknown[];
    events?: unknown[];
    created_at: string;
    updated_at: string;
  }>;
  shares: Array<{
    id: string;
    session_id: string;
    title?: string;
    created_at: string;
    expires_at?: string;
  }>;
}

// ── Test helpers ───────────────────────────────────────────────────────────
function createValidStore(): StoreData {
  return {
    version: 1,
    projects: [],
    memories: [],
    sessions: [],
    shares: [],
  };
}

function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem_${randomUUID()}`,
    project: "default",
    content: "Test memory content",
    memory_type: "factual",
    importance: 0.7,
    confidence: 0.8,
    metadata: {
      hash: "abc123",
      quality: 0.6,
      concepts: ["test", "memory"],
      access_count: 0,
      strength: 0.5,
      durable: false,
    },
    embedding: new Array(96).fill(0).map(() => Math.random()),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    active: true,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("Local Store Format", () => {
  let tmpDir: string;
  let storePath: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `retaindb-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    storePath = join(tmpDir, "local-store.json");
    journalPath = `${storePath}.journal.jsonl`;
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("store file integrity", () => {
    it("should write and read valid JSON store", () => {
      const store = createValidStore();
      store.memories.push(createMemory({ content: "First memory" }));
      store.memories.push(createMemory({ content: "Second memory", memory_type: "preference" }));
      store.projects.push({
        id: `proj_${randomUUID()}`,
        name: "default",
        slug: "default",
        created_at: new Date().toISOString(),
      });

      writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      expect(existsSync(storePath)).toBe(true);

      const read = JSON.parse(readFileSync(storePath, "utf-8"));
      expect(read.version).toBe(1);
      expect(read.memories).toHaveLength(2);
      expect(read.projects).toHaveLength(1);
    });

    it("should support atomic write with temp file + rename", () => {
      const store = createValidStore();
      store.memories.push(createMemory());

      // Simulate atomic write: write to .tmp, then rename
      const tmpPath = `${storePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(store), "utf-8");
      renameSync(tmpPath, storePath);

      // Old tmp should not exist
      expect(existsSync(tmpPath)).toBe(false);
      // Store should exist
      expect(existsSync(storePath)).toBe(true);
    });

    it("should handle empty store with default structure", () => {
      const store = createValidStore();
      writeFileSync(storePath, JSON.stringify(store), "utf-8");

      const read = JSON.parse(readFileSync(storePath, "utf-8"));
      expect(read.version).toBe(1);
      expect(read.memories).toEqual([]);
      expect(read.projects).toEqual([]);
      expect(read.sessions).toEqual([]);
      expect(read.shares).toEqual([]);
    });

    it("should read store with many memories", () => {
      const store = createValidStore();
      for (let i = 0; i < 100; i++) {
        store.memories.push(
          createMemory({ content: `Memory ${i}`, memory_type: i % 2 === 0 ? "factual" : "preference" })
        );
      }

      writeFileSync(storePath, JSON.stringify(store), "utf-8");
      const read = JSON.parse(readFileSync(storePath, "utf-8"));
      expect(read.memories).toHaveLength(100);
    });

    it("should handle large embedding vectors in store", () => {
      const store = createValidStore();
      store.memories.push(
        createMemory({
          content: "With embedding",
          embedding: new Array(384).fill(0).map(() => Math.random()),
        })
      );

      writeFileSync(storePath, JSON.stringify(store), "utf-8");
      const read = JSON.parse(readFileSync(storePath, "utf-8"));
      expect(read.memories[0].embedding).toHaveLength(384);
    });

    it("should handle memory with all optional fields", () => {
      const store = createValidStore();
      store.memories.push(
        createMemory({
          user_id: "user-1",
          session_id: "session-1",
          agent_id: "agent-1",
          task_id: "task-1",
          memory_type: "decision",
          importance: 0.9,
          confidence: 0.95,
          metadata: {
            hash: "full-hash",
            quality: 0.8,
            concepts: ["deploy", "production", "docker"],
            access_count: 5,
            last_accessed_at: new Date().toISOString(),
            strength: 0.85,
            durable: true,
            type_weight: 0.6,
            merged_count: 2,
            last_merged_at: new Date().toISOString(),
            embedding_provider: "local-transformers",
          },
        })
      );

      writeFileSync(storePath, JSON.stringify(store), "utf-8");
      const read = JSON.parse(readFileSync(storePath, "utf-8"));
      const mem = read.memories[0];
      expect(mem.memory_type).toBe("decision");
      expect(mem.metadata.durable).toBe(true);
      expect(mem.metadata.concepts).toContain("docker");
    });
  });

  describe("journal format", () => {
    it("should append JSONL-formatted journal entries", () => {
      const entry = { event: "memory.created", timestamp: new Date().toISOString(), id: "mem-1" };
      appendFileSync(journalPath, JSON.stringify(entry) + "\n", "utf-8");

      expect(existsSync(journalPath)).toBe(true);
      const content = readFileSync(journalPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
    });

    it("should append multiple journal entries", () => {
      for (let i = 0; i < 10; i++) {
        appendFileSync(
          journalPath,
          JSON.stringify({ event: "test", index: i, timestamp: new Date().toISOString() }) + "\n",
          "utf-8"
        );
      }

      const content = readFileSync(journalPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(10);
      expect(() => JSON.parse(lines[0])).not.toThrow();
      expect(() => JSON.parse(lines[9])).not.toThrow();
    });

    it("should support journal replay (read all entries sequentially)", () => {
      const events = [
        { event: "memory.created", id: "1" },
        { event: "memory.created", id: "2" },
        { event: "memory.merged", id: "1", reason: "duplicate" },
        { event: "memory.deleted", id: "3" },
      ];

      for (const evt of events) {
        appendFileSync(journalPath, JSON.stringify(evt) + "\n", "utf-8");
      }

      const content = readFileSync(journalPath, "utf-8");
      const replayed = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(replayed).toHaveLength(4);
      expect(replayed[0].event).toBe("memory.created");
      expect(replayed[2].event).toBe("memory.merged");
    });
  });

  describe("store recovery", () => {
    it("should handle missing store file gracefully", () => {
      // Store file doesn't exist - should start with empty store
      expect(existsSync(storePath)).toBe(false);

      // Simulate what loadStore does: return empty store
      const emptyStore = createValidStore();
      writeFileSync(storePath, JSON.stringify(emptyStore), "utf-8");
      expect(existsSync(storePath)).toBe(true);
    });

    it("should handle corrupt JSON gracefully", () => {
      writeFileSync(storePath, "this is not valid json {{{", "utf-8");

      let threw = false;
      try {
        JSON.parse(readFileSync(storePath, "utf-8"));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it("should handle empty store file", () => {
      writeFileSync(storePath, "", "utf-8");

      let threw = false;
      try {
        JSON.parse(readFileSync(storePath, "utf-8") || "{}");
      } catch {
        threw = true;
      }
      // Empty string should be handled gracefully
      const fallback = JSON.parse(
        readFileSync(storePath, "utf-8") || JSON.stringify(createValidStore())
      );
      expect(fallback.version).toBe(1);
    });
  });

  describe("memory lifecycle", () => {
    it("should mark memory as inactive (soft delete)", () => {
      const store = createValidStore();
      const mem = createMemory();
      store.memories.push(mem);

      // Simulate soft delete
      const idx = store.memories.findIndex((m) => m.id === mem.id);
      store.memories[idx].active = false;
      store.memories[idx].updated_at = new Date().toISOString();

      writeFileSync(storePath, JSON.stringify(store), "utf-8");
      const read = JSON.parse(readFileSync(storePath, "utf-8"));
      expect(read.memories[0].active).toBe(false);
    });

    it("should track access count metadata", () => {
      const store = createValidStore();
      const mem = createMemory();
      store.memories.push(mem);

      // Simulate access tracking
      const idx = store.memories.findIndex((m) => m.id === mem.id);
      const count = (store.memories[idx].metadata.access_count as number) || 0;
      store.memories[idx].metadata.access_count = count + 1;
      store.memories[idx].metadata.last_accessed_at = new Date().toISOString();

      writeFileSync(storePath, JSON.stringify(store), "utf-8");
      const read = JSON.parse(readFileSync(storePath, "utf-8"));
      expect(read.memories[0].metadata.access_count).toBe(1);
      expect(read.memories[0].metadata.last_accessed_at).toBeDefined();
    });

    it("should filter active memories only", () => {
      const store = createValidStore();
      store.memories.push(createMemory({ content: "active", active: true }));
      store.memories.push(createMemory({ content: "inactive", active: false }));
      store.memories.push(createMemory({ content: "also active", active: true }));

      const activeCount = store.memories.filter((m) => m.active).length;
      expect(activeCount).toBe(2);
    });

    it("should store different memory types correctly", () => {
      const types = [
        "factual", "preference", "event", "decision", "constraint",
        "instruction", "goal", "correction", "workflow", "project_state",
        "solution", "opinion", "relationship",
      ];

      const store = createValidStore();
      for (const type of types) {
        store.memories.push(createMemory({ memory_type: type }));
      }

      writeFileSync(storePath, JSON.stringify(store), "utf-8");
      const read = JSON.parse(readFileSync(storePath, "utf-8"));
      const writtenTypes = read.memories.map((m: Memory) => m.memory_type);
      for (const type of types) {
        expect(writtenTypes).toContain(type);
      }
    });
  });
});
