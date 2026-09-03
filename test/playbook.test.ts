import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlaybook, serializePlaybook, PlaybookStore } from "../src/playbook.js";

const SEED = readFileSync(join(process.cwd(), "playbook", "PLAYBOOK.v0.md"), "utf8");

describe("Playbook", () => {
  it("parses the v0 seed", () => {
    const pb = parsePlaybook(SEED, 0);
    expect(pb.bullets.length).toBe(7);
    expect(pb.bullets.map((b) => b.id)).toContain("set-00001");
    expect(pb.bullets.map((b) => b.id)).toContain("wat-00001");
  });

  it("extracts knobs from owners", () => {
    const store = new PlaybookStore(join(mkdtempSync(join(tmpdir(), "pb-"))));
    const pb = parsePlaybook(SEED, 0);
    const knobs = store.knobs(pb);
    expect(knobs["dipPct"]).toBe(3);
    expect(knobs["maxDipPct"]).toBe(12);
    expect(knobs["takePct"]).toBe(2);
    expect(knobs["rsiMax"]).toBe(35);
  });

  it("round-trips serialize → parse", () => {
    const pb = parsePlaybook(SEED, 0);
    const pb2 = parsePlaybook(serializePlaybook({ ...pb, version: 1, parentVersion: 0 }), 1);
    expect(pb2.bullets.map((b) => b.id)).toEqual(pb.bullets.map((b) => b.id));
    expect(pb2.bullets.map((b) => b.helpful)).toEqual(pb.bullets.map((b) => b.helpful));
  });

  it("rejects malformed bullets loudly", () => {
    expect(() => parsePlaybook("[bogus] no counters here :: evidence: \n", 0)).toThrow(/Malformed/);
  });

  it("versions sequentially and rejects forks on save", () => {
    const d = mkdtempSync(join(tmpdir(), "pb-"));
    const store = new PlaybookStore(d);
    const pb = parsePlaybook(SEED, 0);
    const v0 = store.saveNext({ ...pb, parentVersion: null }, "first");
    expect(v0.version).toBe(0);
    const v1 = store.saveNext({ ...v0, parentVersion: 0 }, "second");
    expect(v1.version).toBe(1);
    expect(() => store.saveNext({ ...v0, parentVersion: 0 }, "fork")).toThrow(/fork/);
    expect(store.load().version).toBe(1);
  });
});
