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

import { __cutRecallWindow } from "../../../engine/memory/search.js";

const fixed = (k: number) => ({ strategy: "fixed", min: 1, max: 100, params: { k } });

describe("S1 recall window order (ADR-013 / review I4)", () => {
  it("applies the scope boost before the window cuts", () => {
    // A matching TASK scope is worth +0.3, so the second candidate ends up on top once
    // the boost is applied: 0.8 + 0.3 = 1.1 > 0.9 + 0.1. Cutting on the raw similarity
    // first (the pre-fix order) would keep "plain" and drop "task-scoped" before the
    // boost could lift it.
    const candidates = [
      { id: "plain", similarity: 0.9, scope: "PROJECT" },
      { id: "task-scoped", similarity: 0.8, scope: "TASK", taskId: "t1" },
    ];
    const { kept, k, in: inCount } = __cutRecallWindow(candidates, fixed(1), { taskId: "t1" });
    expect(inCount).toBe(2);
    expect(k).toBe(1);
    expect(kept.map((r: any) => r.id)).toEqual(["task-scoped"]);
  });

  it("ranks on finalScore when a candidate already carries one", () => {
    const candidates = [
      { id: "a", similarity: 0.2, finalScore: 0.95 },
      { id: "b", similarity: 0.9 },
    ];
    const { kept } = __cutRecallWindow(candidates, fixed(2), {});
    expect(kept.map((r: any) => r.id)).toEqual(["a", "b"]);
  });

  it("clamps an oversized window to the configured bounds", () => {
    const candidates = [{ id: "a", similarity: 0.9 }, { id: "b", similarity: 0.8 }];
    const { kept, k } = __cutRecallWindow(candidates, { strategy: "fixed", min: 1, max: 2, params: { k: 50 } }, {});
    expect(k).toBe(2);
    expect(kept).toHaveLength(2);
  });
});
