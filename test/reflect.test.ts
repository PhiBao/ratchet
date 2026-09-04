import { describe, it, expect } from "vitest";
import { sanitizeKnobDeltas, validateKnobs, MIN_DIP_WINDOW } from "../src/reflect.js";
import { DEFAULT_KNOBS } from "../src/strategy.js";

describe("knob coherence", () => {
  it("drops a dip-window collapse (the 5/5 degenerate)", () => {
    const out = sanitizeKnobDeltas({ dipPct: 5, maxDipPct: 5 }, DEFAULT_KNOBS);
    expect(out).not.toHaveProperty("dipPct");
    expect(out).not.toHaveProperty("maxDipPct");
  });

  it("drops a single-sided delta that would breach the floor", () => {
    // Current v3-like state sits exactly on the floor (4/6).
    const tight = { ...DEFAULT_KNOBS, dipPct: 4, maxDipPct: 6 };
    expect(sanitizeKnobDeltas({ dipPct: 5 }, tight)).not.toHaveProperty("dipPct");
    expect(sanitizeKnobDeltas({ maxDipPct: 5 }, tight)).not.toHaveProperty("maxDipPct");
  });

  it("keeps coherent tightenings that respect the floor", () => {
    const out = sanitizeKnobDeltas({ maxDipPct: 10 }, DEFAULT_KNOBS);
    expect(out.maxDipPct).toBe(10);
  });

  it("still clamps per-knob ranges and rounds integers", () => {
    const out = sanitizeKnobDeltas({ rsiMax: 999, maxHoldBars: 50.7 }, DEFAULT_KNOBS);
    expect(out.rsiMax).toBe(50);
    expect(out.maxHoldBars).toBe(51);
  });

  it("validateKnobs flags sub-floor windows", () => {
    expect(validateKnobs({ ...DEFAULT_KNOBS, dipPct: 5, maxDipPct: 5 })).toHaveLength(1);
    expect(validateKnobs(DEFAULT_KNOBS)).toHaveLength(0);
    expect(MIN_DIP_WINDOW).toBe(2);
  });
});
