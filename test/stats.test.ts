import { describe, it, expect } from "vitest";
import { activityVerdict, fisherTwoSided } from "../src/stats.js";

describe("walk-forward stats", () => {
  it("Fisher flags the headline table as non-significant (p ≈ 0.40)", () => {
    // Evolved 8/11 vs frozen 6/12 — the advertised improvement.
    const p = fisherTwoSided(8, 3, 6, 6);
    expect(p).toBeGreaterThan(0.05);
    expect(p).toBeCloseTo(0.4, 1);
  });

  it("Fisher detects a real separation", () => {
    expect(fisherTwoSided(18, 2, 6, 14)).toBeLessThan(0.05);
  });

  it("Fisher returns 1 on empty rows instead of NaN", () => {
    expect(fisherTwoSided(0, 0, 6, 6)).toBe(1);
    expect(fisherTwoSided(8, 3, 0, 0)).toBe(1);
  });

  it("activity verdict names the failure modes", () => {
    expect(activityVerdict(12, 0)).toBe("degenerate");
    expect(activityVerdict(12, 2)).toBe("thin");
    expect(activityVerdict(12, 11)).toBe("ok");
    expect(activityVerdict(0, 0)).toBe("empty");
    expect(activityVerdict(2, 1)).toBe("thin"); // starved either side, not ok
    expect(activityVerdict(4, 4)).toBe("ok");
  });
});
