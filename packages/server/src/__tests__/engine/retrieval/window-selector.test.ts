import { describe, it, expect } from "vitest";
import {
  windowSelectors,
  selectWindow,
  isWindowStrategy,
  WINDOW_STRATEGY_NAMES,
} from "../../../engine/retrieval/window-selector.js";

const bounds = { min: 1, max: 100 };

describe("window selectors", () => {
  it("fixed returns params.k clamped", () => {
    expect(windowSelectors.fixed.select([0.9, 0.8], bounds, { k: 5 })).toBe(5);
    expect(windowSelectors.fixed.select([0.9, 0.8], { min: 1, max: 3 }, { k: 50 })).toBe(3);
  });

  it("relative-top keeps scores >= delta * top", () => {
    const scores = [0.95, 0.93, 0.91, 0.40, 0.30];
    // delta=0.7 → cut=0.665 → keeps first 3
    expect(windowSelectors["relative-top"].select(scores, bounds, { delta: 0.7 })).toBe(3);
  });

  it("median-gap stops at an outlier drop", () => {
    const scores = [0.95, 0.93, 0.91, 0.88, 0.45, 0.42, 0.40];
    // gaps: .02,.02,.03,.43,.03,.02 → median .025, tau=.075 → stop at .43 → 4
    expect(windowSelectors["median-gap"].select(scores, bounds, { k: 3 })).toBe(4);
  });

  it("curvature finds the knee", () => {
    // steep top cluster then long flat tail → knee at index 2 (ADR-013 example) → k=3
    const scores = [1.0, 0.98, 0.95, 0.55, 0.53, 0.52, 0.51, 0.50];
    expect(windowSelectors.curvature.select(scores, bounds)).toBe(3);
  });

  it("relative-top keeps everything above the threshold (clamped to max)", () => {
    // all scores above delta * top → the findIndex sentinel (-1) path
    expect(windowSelectors["relative-top"].select([0.9, 0.88, 0.86], { min: 1, max: 50 }, { delta: 0.5 })).toBe(3);
  });

  it("curvature falls back to min on empty and clamps small inputs", () => {
    expect(windowSelectors.curvature.select([], bounds)).toBe(1);
    expect(windowSelectors.curvature.select([0.9], bounds)).toBe(1);
  });

  it("selectWindow resolves an unknown strategy to the default, not to the widest window", () => {
    // review I3: an unknown name used to route through `fixed` with no params.k, i.e. to
    // bounds.max (the most expensive window); a typo in env must not buy the widest cut.
    const scores = [1.0, 0.98, 0.95, 0.55, 0.53, 0.52, 0.51, 0.50];
    const unknown = selectWindow("curvatur", scores, { min: 1, max: 100 }, { k: 4 });
    expect(unknown).toBe(windowSelectors.curvature.select(scores, { min: 1, max: 100 }));
    expect(unknown).not.toBe(4); // would be the fixed/params.k window
    expect(unknown).not.toBe(100); // would be the old bounds.max fallback
  });

  it("exposes the strategy registry for config validation", () => {
    expect(isWindowStrategy("curvature")).toBe(true);
    expect(isWindowStrategy("curvatur")).toBe(false);
    expect(WINDOW_STRATEGY_NAMES).toContain("median-gap");
  });

  it("selectWindow clamps to bounds", () => {
    expect(selectWindow("fixed", [0.9], { min: 5, max: 50 }, { k: 999 })).toBe(50);
  });
});
