/**
 * Curator: turns reflection output into a new immutable playbook version.
 * Grow-and-refine — accumulate, deduplicate, prune. Never rewrites history:
 * retired bullets are struck through, never deleted.
 */
import type { Lesson, Playbook, PlaybookBullet } from "./types.js";
import { DEFAULT_KNOBS } from "./strategy.js";
import { MIN_DIP_WINDOW } from "./reflect.js";

export interface CuratorInput {
  lessons: Lesson[];
  /** Votes derived from grades: +1 → helpful, −1 → harmful on cited ruleIds. */
  votes: { id: string; vote: "helpful" | "harmful" }[];
  knobDeltas: Record<string, number>;
  knobOwnerNote: string;
  curationNote: string;
}

export interface CurationResult {
  next: Playbook;
  ops: string[];
}

const PREFIX: Record<string, string> = {
  SETUPS: "set",
  FILTERS: "flt",
  EXITS: "exe",
  SIZING: "siz",
  MISTAKES: "mis",
  WATCH: "wat",
};

function nextId(pb: Playbook, section: string): string {
  const prefix = PREFIX[section] ?? "gen";
  let max = 0;
  for (const b of pb.bullets) {
    const m = new RegExp(`^${prefix}-(\\d{5})$`).exec(b.id);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(5, "0")}`;
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "and", "or", "for", "with",
  "at", "by", "is", "are", "it", "its", "as", "be", "your", "you",
]);

/** Near-duplicate detection: ≥70% of the smaller bullet's content words appear in the larger. */
function sameText(a: string, b: string): boolean {
  const toks = (s: string): Set<string> =>
    new Set(
      s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim()
        .split(" ")
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 || B.size === 0) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hit = 0;
  for (const w of small) if (big.has(w)) hit++;
  return hit / small.size >= 0.7;
}

export function applyCuration(pb: Playbook, input: CuratorInput): CurationResult {
  const ops: string[] = [];
  const bullets: PlaybookBullet[] = pb.bullets.map((b) => ({ ...b, knobs: { ...b.knobs } }));
  const byId = new Map(bullets.map((b) => [b.id, b]));
  const preExistingIds = new Set(bullets.map((b) => b.id));

  // 1. Votes from grades.
  for (const v of input.votes) {
    const b = byId.get(v.id);
    if (!b || b.retired) continue;
    if (v.vote === "helpful") b.helpful += 1;
    else b.harmful += 1;
  }
  if (input.votes.length) ops.push(`applied ${input.votes.length} grade votes`);

  // 2. Knob deltas land on the bullet that owns each knob.
  // Coherence second line of defense: sanitize() already drops window-collapsing
  // delta pairs, but LLM/file-sourced deltas can arrive here directly — so the
  // curator re-checks the effective dip window before each amendment.
  const effectiveDipMax = (): { dip: number; max: number } => {
    let dip = DEFAULT_KNOBS.dipPct;
    let max = DEFAULT_KNOBS.maxDipPct;
    for (const b of bullets) {
      if (b.retired) continue;
      if (typeof b.knobs["dipPct"] === "number") dip = b.knobs["dipPct"] as number;
      if (typeof b.knobs["maxDipPct"] === "number") max = b.knobs["maxDipPct"] as number;
    }
    return { dip, max };
  };
  for (const [key, value] of Object.entries(input.knobDeltas)) {
    const owner = bullets.find((b) => !b.retired && key in b.knobs);
    if (!owner) {
      ops.push(`knob ${key}=${value} has no owning bullet — dropped (no orphan knobs)`);
      continue;
    }
    if ((key === "dipPct" || key === "maxDipPct") && typeof value === "number") {
      const cur = effectiveDipMax();
      const prospectiveDip = key === "dipPct" ? value : cur.dip;
      const prospectiveMax = key === "maxDipPct" ? value : cur.max;
      if (prospectiveMax - prospectiveDip < MIN_DIP_WINDOW) {
        ops.push(`coherence: ${key} → ${value} would collapse dip window to ${prospectiveDip}/${prospectiveMax} — dropped (min width ${MIN_DIP_WINDOW})`);
        continue;
      }
    }
    owner.knobs[key] = value;
    ops.push(`amend ${owner.id}: ${key} → ${value} (${input.knobOwnerNote || "reflection"})`);
  }

  // 3. Lessons → new bullets (dedupe against near-identical text).
  for (const l of input.lessons) {
    const dup = bullets.find((b) => !b.retired && b.section === l.section && sameText(b.text, l.text));
    if (dup) {
      const newEv = l.evidence.filter((e) => !dup.evidence.includes(e));
      dup.evidence = [...dup.evidence, ...newEv];
      ops.push(`merge into ${dup.id}: +${newEv.length} evidence (dedupe)`);
      continue;
    }
    const id = nextId({ ...pb, bullets }, l.section);
    const nb: PlaybookBullet = {
      id,
      section: l.section,
      text: l.text,
      helpful: 0,
      harmful: 0,
      regimes: l.regimes.length ? l.regimes : (["unknown"] as PlaybookBullet["regimes"]),
      evidence: l.evidence,
      retired: false,
      knobs: {},
    };
    bullets.push(nb);
    byId.set(id, nb);
    ops.push(`add ${id} [${l.section}]: ${l.text.slice(0, 80)}…`);
  }

  // 4. Lesson votes on specific bullets.
  for (const l of input.lessons) {
    if (!l.votesOn || !l.vote) continue;
    const b = byId.get(l.votesOn);
    if (!b || b.retired) continue;
    if (l.vote === "helpful") b.helpful += 1;
    else b.harmful += 1;
  }

  // 5. Retire: harmful majority after >= 5 total votes.
  for (const b of bullets) {
    if (b.retired) continue;
    const total = b.helpful + b.harmful;
    if (total >= 5 && b.harmful > b.helpful) {
      b.retired = true;
      ops.push(`retire ${b.id}: harmful ${b.harmful} > helpful ${b.helpful} over ${total} votes`);
    }
  }

  // 6. Prune: WATCH bullets with no evidence that predate this curation.
  for (const b of bullets) {
    if (b.retired || b.section !== "WATCH" || b.evidence.length > 0) continue;
    if (preExistingIds.has(b.id)) {
      b.retired = true;
      ops.push(`prune ${b.id}: WATCH with no evidence after a full version`);
    }
  }

  const next: Playbook = {
    version: pb.version, // saveNext assigns the real number
    bullets,
    createdAt: new Date().toISOString(),
    parentVersion: pb.version,
    curationNote: input.curationNote,
  };
  return { next, ops };
}
