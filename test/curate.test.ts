import { describe, it, expect } from "vitest";
import { applyCuration } from "../src/curate.js";
import type { Playbook } from "../src/types.js";

function base(): Playbook {
  return {
    version: 0,
    createdAt: new Date().toISOString(),
    parentVersion: null,
    curationNote: "test",
    bullets: [
      { id: "flt-00001", section: "FILTERS", text: "skip dips beyond maxDipPct", helpful: 3, harmful: 0, regimes: ["volatile"], evidence: ["t001"], retired: false, knobs: { maxDipPct: 12 } },
      { id: "wat-00001", section: "WATCH", text: "stale note with no proof", helpful: 0, harmful: 0, regimes: [], evidence: [], retired: false, knobs: {} },
      { id: "mis-00001", section: "MISTAKES", text: "bad rule everyone hates", helpful: 1, harmful: 5, regimes: [], evidence: ["t1"], retired: false, knobs: {} },
    ],
  };
}

describe("Curator", () => {
  it("amends knobs on the owning bullet", () => {
    const { next, ops } = applyCuration(base(), {
      lessons: [], votes: [], knobDeltas: { maxDipPct: 8 }, knobOwnerNote: "t", curationNote: "t",
    });
    expect(next.bullets.find((b) => b.id === "flt-00001")?.knobs["maxDipPct"]).toBe(8);
    expect(ops.join(" ")).toContain("amend flt-00001");
  });

  it("drops orphan knob deltas instead of inventing owners", () => {
    const { next, ops } = applyCuration(base(), {
      lessons: [], votes: [], knobDeltas: { noSuchKnob: 3 }, knobOwnerNote: "t", curationNote: "t",
    });
    expect(ops.join(" ")).toContain("no owning bullet");
    expect(next.bullets.length).toBe(3);
  });

  it("retires harmful-majority bullets and prunes empty WATCH", () => {
    const { next } = applyCuration(base(), {
      lessons: [], votes: [], knobDeltas: {}, knobOwnerNote: "t", curationNote: "t",
    });
    expect(next.bullets.find((b) => b.id === "mis-00001")?.retired).toBe(true);
    expect(next.bullets.find((b) => b.id === "wat-00001")?.retired).toBe(true);
    expect(next.bullets.find((b) => b.id === "flt-00001")?.retired).toBe(false);
  });

  it("dedupes near-identical lessons into evidence merges", () => {
    const { next, ops } = applyCuration(base(), {
      lessons: [{ text: "skip dips beyond the maxDipPct guard", section: "FILTERS", evidence: ["t009"], regimes: [] }],
      votes: [], knobDeltas: {}, knobOwnerNote: "t", curationNote: "t",
    });
    expect(next.bullets.length).toBe(3); // no new bullet
    expect(next.bullets.find((b) => b.id === "flt-00001")?.evidence).toContain("t009");
    expect(ops.join(" ")).toContain("dedupe");
  });

  it("drops dip-window-collapsing amendments at the curator (second line of defense)", () => {
    const pb = base();
    // Give the SETUPS bullet dip ownership like the real playbook.
    pb.bullets.push({
      id: "set-00001", section: "SETUPS", text: "dip setup", helpful: 0, harmful: 0,
      regimes: [], evidence: [], retired: false, knobs: { dipPct: 4, maxDipPct: 6 },
    });
    const { next, ops } = applyCuration(pb, {
      lessons: [], votes: [], knobDeltas: { dipPct: 5 }, knobOwnerNote: "t", curationNote: "t",
    });
    expect(next.bullets.find((b) => b.id === "set-00001")?.knobs["dipPct"]).toBe(4);
    expect(ops.join(" ")).toContain("coherence");
  });

  it("adds genuinely new lessons with next sequence numbers", () => {
    const { next } = applyCuration(base(), {
      lessons: [{ text: "take profit mechanically at target in range regimes", section: "EXITS", evidence: ["t010", "t011", "t012"], regimes: ["range"] }],
      votes: [], knobDeltas: {}, knobOwnerNote: "t", curationNote: "t",
    });
    const added = next.bullets.find((b) => b.id === "exe-00001");
    expect(added?.text).toContain("take profit mechanically");
    expect(added?.evidence).toEqual(["t010", "t011", "t012"]);
  });
});
