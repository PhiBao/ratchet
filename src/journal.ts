/**
 * Append-only, hash-chained journal. Every entry links to the previous hash,
 * so tampering or corruption breaks the chain and `audit verify` catches it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  seq: number;
  ts: string;
  kind: "intent" | "fill" | "close" | "grade" | "lesson" | "curation" | "verdict" | "halt";
  payload: unknown;
  prevHash: string;
  hash: string;
}

const GENESIS = "RATCHET-GENESIS";

export function hashEntry(seq: number, ts: string, kind: string, payload: unknown, prevHash: string): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ seq, ts, kind, payload, prevHash }));
  return h.digest("hex");
}

export class Journal {
  private path: string;
  private seq: number;
  private lastHash: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.seq = 0;
    this.lastHash = GENESIS;
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line) as JournalEntry;
        this.seq = e.seq + 1;
        this.lastHash = e.hash;
      }
    }
  }

  append(kind: JournalEntry["kind"], payload: unknown): JournalEntry {
    const ts = new Date().toISOString();
    const entry: JournalEntry = {
      seq: this.seq,
      ts,
      kind,
      payload,
      prevHash: this.lastHash,
      hash: hashEntry(this.seq, ts, kind, payload, this.lastHash),
    };
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.seq += 1;
    this.lastHash = entry.hash;
    return entry;
  }

  readAll(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JournalEntry);
  }

  /** Replays the chain. Returns the first broken seq, or -1 if intact. */
  verify(): { ok: boolean; brokenAt: number; entries: number } {
    const entries = this.readAll();
    let prev = GENESIS;
    for (const e of entries) {
      if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, entries: entries.length };
      const recomputed = hashEntry(e.seq, e.ts, e.kind, e.payload, e.prevHash);
      if (recomputed !== e.hash) return { ok: false, brokenAt: e.seq, entries: entries.length };
      prev = e.hash;
    }
    return { ok: true, brokenAt: -1, entries: entries.length };
  }

  ofKind(kind: JournalEntry["kind"]): JournalEntry[] {
    return this.readAll().filter((e) => e.kind === kind);
  }
}
