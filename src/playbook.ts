/**
 * Versioned playbook store. Versions are immutable files; curation writes
 * v(n+1), never edits in place. Format is parsed strictly — a malformed
 * bullet fails loudly rather than degrading silently.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Playbook, PlaybookBullet, Regime } from "./types.js";

const BULLET_RE =
  /^(~~)?\[([a-z]+-\d{5})\]\s+helpful=(\d+)\s+harmful=(\d+)(?:\s+\(([a-z,\s]+)\))?\s+::\s+(.+?)\s+::\s+evidence:\s*(.*?)(~~)?$/;
const SECTION_RE = /^##\s+([A-Z_]+)\s*$/;
const KNOB_ANN_RE = /\s*knobs:\s*([A-Za-z0-9_=., \-]+)\s*$/;

export function parsePlaybook(text: string, version: number): Playbook {
  const bullets: PlaybookBullet[] = [];
  let section = "UNCATEGORIZED";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("# ") || line.startsWith(">")) continue;
    const sec = SECTION_RE.exec(line);
    if (sec?.[1]) {
      section = sec[1];
      continue;
    }
    if (!line.startsWith("~~") && !line.startsWith("[")) continue;
    const m = BULLET_RE.exec(line);
    if (!m) throw new Error(`Malformed playbook bullet: ${line}`);
    const retired = m[1] === "~~" || m[8] === "~~";
    const knobs: Record<string, number> = {};
    const knobAnn = KNOB_ANN_RE.exec(m[6] ?? "");
    if (knobAnn?.[1]) {
      for (const pair of knobAnn[1].split(",")) {
        const [k, v] = pair.trim().split("=");
        if (k && v !== undefined && v !== "" && !Number.isNaN(Number(v))) knobs[k.trim()] = Number(v);
      }
    }
    const textBody = (m[6] ?? "").replace(KNOB_ANN_RE, "").trim();
    bullets.push({
      id: m[2] ?? "",
      section,
      text: textBody,
      helpful: Number(m[3]),
      harmful: Number(m[4]),
      regimes: (m[5] ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Regime[],
      evidence: (m[7] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      retired,
      knobs,
    });
  }
  return { version, bullets, createdAt: new Date().toISOString(), parentVersion: null, curationNote: "" };
}

export function serializePlaybook(pb: Playbook): string {
  const out: string[] = [
    `# Ratchet Playbook v${pb.version}`,
    ``,
    `> Evolved context. Immutable — curation writes v${pb.version + 1}, never edits.`,
    `> Parent: ${pb.parentVersion === null ? "genesis" : "v" + pb.parentVersion} · ${pb.createdAt}`,
    ...(pb.curationNote ? [`> Curation: ${pb.curationNote}`] : []),
    ``,
  ];
  const sections: string[] = [];
  for (const b of pb.bullets) {
    if (!sections.includes(b.section)) sections.push(b.section);
  }
  for (const s of sections) {
    out.push(`## ${s}`, ``);
    for (const b of pb.bullets.filter((x) => x.section === s)) {
      const knobStr = Object.entries(b.knobs)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      const body = knobStr ? `${b.text} knobs: ${knobStr}` : b.text;
      const line = `[${b.id}] helpful=${b.helpful} harmful=${b.harmful} (${b.regimes.join(", ")}) :: ${body} :: evidence: ${b.evidence.join(",")}`;
      out.push(b.retired ? `~~${line}~~` : line);
    }
    out.push(``);
  }
  return out.join("\n");
}

export class PlaybookStore {
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private fileName(v: number): string {
    return join(this.dir, `PLAYBOOK.v${v}.md`);
  }

  latestVersion(): number {
    if (!existsSync(this.dir)) return -1;
    const versions = readdirSync(this.dir)
      .map((f) => /^PLAYBOOK\.v(\d+)\.md$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    return versions.length ? Math.max(...versions) : -1;
  }

  load(version?: number): Playbook {
    const v = version ?? this.latestVersion();
    if (v < 0) throw new Error("No playbook versions found");
    const pb = parsePlaybook(readFileSync(this.fileName(v), "utf8"), v);
    pb.version = v;
    return pb;
  }

  /** Writes the next version. Throws if parent isn't the current latest (no forks). */
  saveNext(pb: Playbook, curationNote: string): Playbook {
    const latest = this.latestVersion();
    const parent = pb.parentVersion ?? latest;
    if (parent !== latest) {
      throw new Error(`Playbook fork rejected: parent v${parent} but latest is v${latest}`);
    }
    const next: Playbook = {
      ...pb,
      version: latest + 1,
      parentVersion: latest,
      createdAt: new Date().toISOString(),
      curationNote,
    };
    writeFileSync(this.fileName(next.version), serializePlaybook(next));
    return next;
  }

  /** Extracts knob defaults: later bullets override earlier ones. */
  knobs(pb: Playbook): Record<string, number> {
    const out: Record<string, number> = {};
    for (const b of pb.bullets) {
      if (b.retired) continue;
      Object.assign(out, b.knobs);
    }
    return out;
  }

  bullet(pb: Playbook, id: string): PlaybookBullet | undefined {
    return pb.bullets.find((b) => b.id === id);
  }
}
