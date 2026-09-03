import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "ratchet-"));

describe("Journal", () => {
  it("appends and verifies a clean chain", () => {
    const j = new Journal(join(dir(), "j.jsonl"));
    j.append("intent", { id: "i1" });
    j.append("close", { id: "t1" });
    const v = j.verify();
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(2);
  });

  it("detects tampering", () => {
    const p = join(dir(), "j.jsonl");
    const j = new Journal(p);
    j.append("intent", { id: "i1" });
    j.append("close", { id: "t1" });
    // Tamper: rewrite the first payload in place.
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const first = JSON.parse(lines[0] as string) as { payload: unknown };
    first.payload = { id: "EVIL" };
    lines[0] = JSON.stringify(first);
    writeFileSync(p, lines.join("\n") + "\n");
    const j2 = new Journal(p);
    expect(j2.verify().ok).toBe(false);
  });

  it("resume continues the sequence", () => {
    const p = join(dir(), "j.jsonl");
    new Journal(p).append("intent", { a: 1 });
    const j2 = new Journal(p);
    const e = j2.append("intent", { a: 2 });
    expect(e.seq).toBe(1);
    expect(j2.verify().ok).toBe(true);
  });
});
