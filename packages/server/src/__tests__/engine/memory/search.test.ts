import { describe, it, expect, vi } from "vitest";

vi.mock("../../../db/index.js", () => ({
  db: { $queryRaw: vi.fn() },
  prisma: {},
}));

vi.mock("../../../engine/cache.js", () => ({
  getFromCache: vi.fn(),
  setInCache: vi.fn(),
  getFromSemanticCache: vi.fn(),
  setInSemanticCache: vi.fn(),
}));

vi.mock("../../../engine/embeddings.js", () => ({
  embedSingle: vi.fn(),
}));

import { detectQueryIntent } from "../../../engine/memory/search.js";

describe("detectQueryIntent", () => {
  it("detects a goals intent", () => {
    expect(detectQueryIntent("What are the current project goals?").asksForGoals).toBe(true);
  });

  it("detects a preferences intent", () => {
    expect(detectQueryIntent("How should I format answers?").asksForPreferences).toBe(true);
  });

  it("detects a decisions/architecture intent", () => {
    expect(detectQueryIntent("What does the backend use?").asksForDecisions).toBe(true);
  });

  it("detects a recency intent", () => {
    expect(detectQueryIntent("What was the latest release?").wantsRecent).toBe(true);
  });

  it("does not flag unrelated queries", () => {
    const intent = detectQueryIntent("random text");
    expect(intent.asksForGoals).toBe(false);
    expect(intent.asksForPreferences).toBe(false);
    expect(intent.asksForDecisions).toBe(false);
  });
});
