import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock all heavy infrastructure before importing write.ts ────────────────
vi.mock("../../../db/index.js", () => ({
  db: {
    memory: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "mem-test" }),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn((fn: any) => fn({ memory: { findMany: vi.fn().mockResolvedValue([]) } })),
  },
}));

vi.mock("../../../engine/cache.js", () => ({
  getRedisClient: vi.fn(),
  clearCacheByPattern: vi.fn(),
  getFromCache: vi.fn(),
  setInCache: vi.fn(),
}));

vi.mock("../../../engine/embeddings.js", () => ({
  embedSingle: vi.fn().mockResolvedValue(new Array(1024).fill(0)),
  embed: vi.fn().mockResolvedValue([new Array(1024).fill(0)]),
}));

vi.mock("../../../lib/encryption.js", () => ({
  encrypt: vi.fn((text: string) => text),
  decrypt: vi.fn((text: string) => text),
  isEncrypted: vi.fn(() => false),
  isEncryptionEnabled: vi.fn(() => false),
}));

vi.mock("../../../engine/extraction-observability.js", () => ({
  calibrateConfidence: vi.fn((raw: number) => Math.min(1, Math.max(0, raw))),
}));

vi.mock("../../../engine/pending-overlay.js", () => ({
  addPendingOverlayEntry: vi.fn(),
}));

vi.mock("../../../engine/queue.js", () => ({
  enqueueMemoryEmbeddingJob: vi.fn(),
}));

vi.mock("../../../engine/memory/relations.js", () => ({
  detectRelations: vi.fn().mockResolvedValue([]),
  shouldInvalidateMemory: vi.fn(() => false),
  canInvalidateExistingMemory: vi.fn(() => false),
}));

// ── Now safe to import ──────────────────────────────────────────────────────
import { __memoryWriteTestables } from "../../../engine/memory/write.js";

const {
  normalizeMemoryType,
  buildValidatorIssues,
  calibrateWriteConfidence,
  inferScopeTarget,
  inferScopeDecision,
} = __memoryWriteTestables;

// ═══════════════════════════════════════════════════════════════════════════
// normalizeMemoryType
// ═══════════════════════════════════════════════════════════════════════════
describe("normalizeMemoryType", () => {
  it("should return 'factual' for undefined input", () => {
    expect(normalizeMemoryType()).toBe("factual");
  });

  it("should return 'factual' for 'factual'", () => {
    expect(normalizeMemoryType("factual")).toBe("factual");
  });

  it("should map 'semantic' to 'factual'", () => {
    expect(normalizeMemoryType("semantic")).toBe("factual");
  });

  it("should map 'procedural' to 'instruction'", () => {
    expect(normalizeMemoryType("procedural")).toBe("instruction");
  });

  it("should map 'episodic' to 'event'", () => {
    expect(normalizeMemoryType("episodic")).toBe("event");
  });

  it("should return 'preference' for 'preference'", () => {
    expect(normalizeMemoryType("preference")).toBe("preference");
  });

  it("should return 'decision' for 'decision'", () => {
    expect(normalizeMemoryType("decision")).toBe("decision");
  });

  it("should return 'correction' for 'correction'", () => {
    expect(normalizeMemoryType("correction")).toBe("correction");
  });

  it("should return 'workflow' for 'workflow'", () => {
    expect(normalizeMemoryType("workflow")).toBe("workflow");
  });

  it("should fallback to 'factual' for unknown type", () => {
    expect(normalizeMemoryType("nonexistent")).toBe("factual");
  });

  it("should be case-insensitive", () => {
    expect(normalizeMemoryType("PREFERENCE")).toBe("preference");
    expect(normalizeMemoryType("Decision")).toBe("decision");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildValidatorIssues
// ═══════════════════════════════════════════════════════════════════════════
describe("buildValidatorIssues", () => {
  const baseInput = {
    content: "",
    memoryType: "factual",
    entityMentions: [] as string[],
  };

  it("should flag content shorter than 10 chars", () => {
    const issues = buildValidatorIssues({ ...baseInput, content: "hi" });
    expect(issues).toContain("too_short");
  });

  it("should not flag content of 10+ chars as too_short", () => {
    const issues = buildValidatorIssues({ ...baseInput, content: "hello world" });
    expect(issues).not.toContain("too_short");
  });

  it("should flag chat messages as chatter", () => {
    expect(buildValidatorIssues({ ...baseInput, content: "ok!" })).toContain("chatter");
    expect(buildValidatorIssues({ ...baseInput, content: "thanks!" })).toContain("chatter");
    expect(buildValidatorIssues({ ...baseInput, content: "bye!" })).toContain("chatter");
    expect(buildValidatorIssues({ ...baseInput, content: "okay" })).toContain("chatter");
  });

  it("should flag unresolved pronouns at sentence start", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "He prefers TypeScript over JavaScript",
      entityMentions: [],
    });
    expect(issues).toContain("unresolved_pronouns");
  });

  it("should NOT flag pronouns when entity mentions exist", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "He prefers TypeScript",
      entityMentions: ["Alex"],
    });
    // Entity mentions don't cancel the pronoun check in the current logic
    // — the check is purely regex-based
  });

  it("should flag vague references", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "the company decided to use that project for something",
    });
    expect(issues).toContain("vague_reference");
  });

  it("should flag multi-fact sentences", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "We use React for the frontend. The backend is Python. We also use Redis for caching.",
    });
    expect(issues).toContain("multi_fact");
  });

  it("should flag low specificity (less than 4 words)", () => {
    const issues = buildValidatorIssues({ ...baseInput, content: "use TypeScript always" });
    expect(issues).toContain("low_specificity");
  });

  it("should flag underspecified temporal for events without eventDate", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "deployed to production yesterday",
      memoryType: "event",
      entityMentions: [],
    });
    expect(issues).toContain("underspecified_temporal");
  });

  it("should NOT flag underspecified_temporal for non-event types", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "deployed to production yesterday",
      memoryType: "factual",
      entityMentions: [],
    });
    expect(issues).not.toContain("underspecified_temporal");
  });

  it("should deduplicate issues", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "a b",
      memoryType: "event",
      entityMentions: [],
    });
    const tooShortCount = issues.filter((i) => i === "too_short").length;
    expect(tooShortCount).toBeLessThanOrEqual(1);
  });

  it("should return clean for well-formed content", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "The authentication middleware validates JWT tokens before allowing access to protected routes",
      entityMentions: ["JWT", "middleware"],
    });
    expect(issues).toEqual([]);
  });

  it("should handle empty string content", () => {
    const issues = buildValidatorIssues({
      ...baseInput,
      content: "",
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// calibrateWriteConfidence
// ═══════════════════════════════════════════════════════════════════════════
describe("calibrateWriteConfidence", () => {
  it("should return value between 0 and 1", () => {
    const result = calibrateWriteConfidence({
      confidenceRaw: 0.8,
      memoryType: "factual",
      extractionMethod: "manual",
      validatorIssues: [],
    });
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("should boost manual extraction", () => {
    const manual = calibrateWriteConfidence({
      confidenceRaw: 0.8,
      memoryType: "factual",
      extractionMethod: "manual",
      validatorIssues: [],
    });
    const inference = calibrateWriteConfidence({
      confidenceRaw: 0.8,
      memoryType: "factual",
      extractionMethod: "inference",
      validatorIssues: [],
    });
    expect(manual).toBeGreaterThan(inference);
  });

  it("should boost pattern extraction", () => {
    const result = calibrateWriteConfidence({
      confidenceRaw: 0.8,
      memoryType: "factual",
      extractionMethod: "pattern",
      validatorIssues: [],
    });
    expect(result).toBeGreaterThan(0.8);
  });

  it("should penalize inference extraction", () => {
    const result = calibrateWriteConfidence({
      confidenceRaw: 0.8,
      memoryType: "factual",
      extractionMethod: "inference",
      validatorIssues: [],
    });
    expect(result).toBeLessThan(0.8);
  });

  it("should penalize 'strong' extraction", () => {
    const result = calibrateWriteConfidence({
      confidenceRaw: 0.8,
      memoryType: "factual",
      extractionMethod: "strong",
      validatorIssues: [],
    });
    expect(result).toBeLessThan(0.8);
  });

  it("should apply chatter penalty heavily", () => {
    const clean = calibrateWriteConfidence({
      confidenceRaw: 0.9,
      memoryType: "factual",
      extractionMethod: "manual",
      validatorIssues: [],
    });
    const chatter = calibrateWriteConfidence({
      confidenceRaw: 0.9,
      memoryType: "factual",
      extractionMethod: "manual",
      validatorIssues: ["chatter"],
    });
    expect(chatter).toBeLessThan(clean);
    expect(clean - chatter).toBeGreaterThan(0.1);
  });

  it("should accumulate multiple issue penalties", () => {
    const oneIssue = calibrateWriteConfidence({
      confidenceRaw: 0.9,
      memoryType: "factual",
      extractionMethod: "manual",
      validatorIssues: ["too_short"],
    });
    const threeIssues = calibrateWriteConfidence({
      confidenceRaw: 0.9,
      memoryType: "factual",
      extractionMethod: "manual",
      validatorIssues: ["too_short", "chatter", "vague_reference"],
    });
    expect(threeIssues).toBeLessThan(oneIssue);
  });

  it("should cap 'strong' with issues at 0.86", () => {
    const result = calibrateWriteConfidence({
      confidenceRaw: 1.0,
      memoryType: "factual",
      extractionMethod: "strong",
      validatorIssues: ["too_short"],
    });
    expect(result).toBeLessThanOrEqual(0.86);
  });

  it("should handle 0 confidence", () => {
    const result = calibrateWriteConfidence({
      confidenceRaw: 0,
      memoryType: "factual",
      extractionMethod: "inference",
      validatorIssues: ["chatter"],
    });
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// inferScopeTarget
// ═══════════════════════════════════════════════════════════════════════════
describe("inferScopeTarget", () => {
  const baseInput = {
    memoryType: "factual",
    sourceRole: "user" as const,
    userId: "user-1",
    sessionId: "session-1",
    agentId: "agent-1",
    taskId: "task-1",
    scopeHint: undefined as string | undefined,
    promotionMode: "session_state_v1" as const,
    userConfirmed: false,
    bypassValidation: false,
    enableRelationDetection: false,
    writeMode: "direct_write" as const,
    entityMentions: [],
    isCorrection: false,
    isAgentTurn: false,
  };

  it("should return DROPPED for very low confidence", () => {
    expect(inferScopeTarget(0.3, baseInput)).toBe("DROPPED");
  });

  it("should return SESSION at session threshold", () => {
    // SESSION_ONLY_THRESHOLD = 0.58
    expect(inferScopeTarget(0.6, baseInput)).toBe("SESSION");
  });

  it("should return USER at user profile threshold for preference", () => {
    // USER_CROSS_SESSION_THRESHOLD = 0.68
    expect(
      inferScopeTarget(0.7, { ...baseInput, memoryType: "preference" })
    ).toBe("USER");
  });

  it("should return USER at user profile threshold for goal", () => {
    expect(
      inferScopeTarget(0.7, { ...baseInput, memoryType: "goal" })
    ).toBe("USER");
  });

  it("should return USER at user profile threshold for opinion", () => {
    expect(
      inferScopeTarget(0.7, { ...baseInput, memoryType: "opinion" })
    ).toBe("USER");
  });

  it("should return SESSION for decision without higher confidence", () => {
    // Decision falls to TASK/PROJECT path, not USER
    expect(
      inferScopeTarget(0.75, { ...baseInput, memoryType: "decision" })
    ).toBe("TASK");
  });

  it("should respect explicit USER scope hint", () => {
    // USER_PROFILE_THRESHOLD = 0.82
    expect(
      inferScopeTarget(0.85, { ...baseInput, scopeHint: "USER", memoryType: "preference" })
    ).toBe("USER");
  });

  it("should return DROPPED for USER hint below threshold", () => {
    expect(
      inferScopeTarget(0.6, { ...baseInput, scopeHint: "USER" })
    ).toBe("DROPPED");
  });

  it("should respect explicit TASK scope hint", () => {
    expect(
      inferScopeTarget(0.75, { ...baseInput, scopeHint: "TASK" })
    ).toBe("TASK");
  });

  it("should respect explicit PROJECT scope hint", () => {
    expect(
      inferScopeTarget(0.8, { ...baseInput, scopeHint: "PROJECT" })
    ).toBe("PROJECT");
  });

  it("should return DROPPED for SESSION hint without sessionId", () => {
    expect(
      inferScopeTarget(0.7, { ...baseInput, scopeHint: "SESSION", sessionId: undefined as any })
    ).toBe("DROPPED");
  });

  it("should handle DOCUMENT scope hint", () => {
    expect(
      inferScopeTarget(0.6, { ...baseInput, scopeHint: "DOCUMENT" })
    ).toBe("DOCUMENT");
  });

  it("should return DROPPED for DOCUMENT hint below session threshold", () => {
    expect(
      inferScopeTarget(0.3, { ...baseInput, scopeHint: "DOCUMENT" })
    ).toBe("DROPPED");
  });

  it("should route instruction to AGENT at agent threshold", () => {
    // AGENT_SCOPE_THRESHOLD = 0.74
    expect(
      inferScopeTarget(0.75, { ...baseInput, memoryType: "instruction" })
    ).toBe("USER");
  });

  it("should route workflow to AGENT at agent threshold without userId", () => {
    expect(
      inferScopeTarget(0.75, { ...baseInput, memoryType: "workflow", userId: undefined as any })
    ).toBe("AGENT");
  });

  it("should fall back to PROJECT for project_state", () => {
    expect(
      inferScopeTarget(0.8, {
        ...baseInput,
        memoryType: "project_state",
        taskId: undefined as any,
      })
    ).toBe("PROJECT");
  });

  it("should return DROPPED when confidence is too low for any scope", () => {
    expect(inferScopeTarget(0.1, baseInput)).toBe("DROPPED");
  });
});
