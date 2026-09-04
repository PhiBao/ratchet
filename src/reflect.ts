/**
 * Reflector: grades closed trades deterministically, then asks the LLM to
 * narrate graded facts into candidate lessons. The model never sees raw
 * discretion — only the grade packet. Any lesson citing unknown trade IDs
 * or inventing numbers is rejected; reflection falls back to templates.
 */
import type { ClosedTrade, Grade, Kline, Lesson, Playbook } from "./types.js";
import { gradeTrade, summarizeGrades } from "./grade.js";
import { chatComplete } from "./llm.js";
import type { StrategyKnobs } from "./strategy.js";
import { runReplay } from "./venues/replay.js";

export interface Reflection {
  grades: Grade[];
  summary: ReturnType<typeof summarizeGrades>;
  lessons: Lesson[];
  knobDeltas: Partial<StrategyKnobs>;
  source: "llm" | "template";
}

interface LlmLesson {
  text: string;
  section: Lesson["section"];
  evidence: string[];
  regimes: string[];
  votesOn?: string;
  vote?: "helpful" | "harmful";
}

function gradePacket(trades: ClosedTrade[], grades: Grade[], takeR: number): string {
  const lines: string[] = [];
  for (const t of trades) {
    const g = grades.find((x) => x.tradeId === t.id);
    lines.push(
      `${t.id} ${t.intent.symbol} ${t.intent.regime} exit=${t.exitReason} pnl=${t.pnl.toFixed(2)} ` +
        `MFE=${t.mfeR.toFixed(2)}R MAE=${t.maeR.toFixed(2)}R thesis=${g?.thesisConfirmed} ` +
        `luck=${g?.luck} score=${g?.decisionScore} rules=[${t.intent.ruleIds.join(",")}]`,
    );
  }
  return lines.join("\n") + `\n takeR=${takeR}`;
}

const REFLECT_SYSTEM = `You are the Reflector in a self-improving trading loop. You receive COMPUTED grades for closed trades — these numbers are facts. Propose lessons that turn experience into rules.

Rules:
- Every lesson MUST cite evidence: trade IDs from the packet only. Unknown IDs invalidate the lesson.
- Propose at most 5 lessons. Prefer FILTERS (when to refuse) over SETUPS — refusing bad trades is the highest-value learning.
- A pattern needs >=3 supporting trades or 1 decisive discipline break to qualify. Otherwise put it in WATCH.
- knobDeltas may adjust ONLY these keys: dipPct, maxDipPct, rsiMax, takePct, stopPct, maxHoldBars. Each delta needs evidence (trade IDs) in its rationale. Ranges: dipPct 1-6, maxDipPct 4-20, rsiMax 25-50, takePct 1-5, stopPct 0.5-3, maxHoldBars 12-96. Coherence: maxDipPct − dipPct must stay ≥ 2 (a narrower window barely trades and will be rejected). Prefer widening a starved setup over tightening it — fewer than ~5 trades in the window is over-restriction, not discipline.
- votesOn must reference a bullet ID the trades relied on (see rules=[...] in the packet).
- Reply with JSON ONLY: {"lessons":[{"text","section","evidence":[],"regimes":[],"votesOn?","vote?"}],"knobDeltas":{},"knobRationale":"..."}`;

export async function reflectOnTrades(
  trades: ClosedTrade[],
  takeR: number,
  playbook: Playbook,
  knobs: StrategyKnobs,
  useLlm = true,
): Promise<Reflection> {
  const grades = trades.map((t) => gradeTrade(t, takeR));
  const summary = summarizeGrades(trades, grades);
  if (!useLlm) {
    return { grades, summary, ...templateLessons(trades, grades, knobs, takeR), source: "template" };
  }
  try {
    const raw = await chatComplete(
      REFLECT_SYSTEM,
      `PLAYBOOK v${playbook.version} bullets relied on:\n` +
        playbook.bullets
          .filter((b) => !b.retired)
          .map((b) => `${b.id} [${b.section}] helpful=${b.helpful} harmful=${b.harmful} :: ${b.text}`)
          .join("\n") +
        `\n\nCURRENT KNOBS: ${JSON.stringify(knobs)}\n\nGRADE PACKET (${trades.length} closed trades):\n${gradePacket(trades, grades, takeR)}`,
    );
    const parsed = JSON.parse(raw.replace(/^```json\n?/, "").replace(/\n?```$/, "")) as {
      lessons?: LlmLesson[];
      knobDeltas?: Partial<StrategyKnobs>;
    };
    const tradeIds = new Set(trades.map((t) => t.id));
    const bulletIds = new Set(playbook.bullets.map((b) => b.id));
    const lessons: Lesson[] = [];
    for (const l of parsed.lessons ?? []) {
      const evidence = (l.evidence ?? []).filter((id) => tradeIds.has(id));
      if (evidence.length === 0) continue; // no evidence, no lesson
      if (evidence.length < 3 && l.section !== "WATCH" && l.section !== "MISTAKES") {
        l.section = "WATCH";
      }
      const votesOn = l.votesOn && bulletIds.has(l.votesOn) ? l.votesOn : undefined;
      const vote = l.vote === "helpful" || l.vote === "harmful" ? l.vote : undefined;
      lessons.push({
        text: String(l.text).slice(0, 300),
        section: l.section,
        evidence,
        regimes: (l.regimes ?? []).filter((r) => ["trend", "range", "volatile", "unknown"].includes(r)) as Lesson["regimes"],
        ...(votesOn ? { votesOn } : {}),
        ...(vote ? { vote } : {}),
      });
    }
    const knobDeltas = sanitizeKnobDeltas(parsed.knobDeltas ?? {}, knobs);
    return { grades, summary, lessons: lessons.slice(0, 5), knobDeltas, source: "llm" };
  } catch {
    return { grades, summary, ...templateLessons(trades, grades, knobs, takeR), source: "template" };
  }
}

const KNOB_RANGES: Record<keyof StrategyKnobs, [number, number]> = {
  dipPct: [1, 6],
  maxDipPct: [4, 20],
  rsiPeriod: [7, 21],
  rsiMax: [25, 50],
  takePct: [1, 5],
  stopPct: [0.5, 3],
  maxHoldBars: [12, 96],
  volHiPct: [3, 12],
  cooldownBars: [0, 24],
};

/**
 * Minimum dip-window width (maxDipPct − dipPct). Below this the setup is a
 * razor edge that fires on almost nothing — the observed terminal state of a
 * tighten-only loop (dipPct=5, maxDipPct=5 → zero trades). Coherence checks
 * below refuse any delta set that would cross this floor.
 */
export const MIN_DIP_WINDOW = 2;

/** Integer-valued knobs — fractional values are noise, round them. */
const INT_KNOBS = new Set<keyof StrategyKnobs>(["rsiPeriod", "maxHoldBars", "cooldownBars"]);

/**
 * Cross-knob coherence over a full knob set. Returns human-readable
 * violations, empty when coherent. Pure — no side effects.
 */
export function validateKnobs(knobs: StrategyKnobs): string[] {
  const problems: string[] = [];
  const width = knobs.maxDipPct - knobs.dipPct;
  if (!(width >= MIN_DIP_WINDOW)) {
    problems.push(`dip window ${knobs.dipPct}/${knobs.maxDipPct} narrower than ${MIN_DIP_WINDOW}pp — setup can barely fire`);
  }
  if (!(knobs.takePct > 0 && knobs.stopPct > 0)) {
    problems.push("takePct and stopPct must stay positive (risk math divides by stop distance)");
  }
  return problems;
}

export function sanitizeKnobDeltas(deltas: Partial<StrategyKnobs>, current: StrategyKnobs): Partial<StrategyKnobs> {
  const out: Partial<StrategyKnobs> = {};
  for (const [k, v] of Object.entries(deltas)) {
    const key = k as keyof StrategyKnobs;
    if (!(key in KNOB_RANGES) || typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = KNOB_RANGES[key] ?? [0, 0];
    let clamped = Math.min(hi, Math.max(lo, v));
    if (INT_KNOBS.has(key)) clamped = Math.round(clamped);
    else clamped = Math.round(clamped * 100) / 100;
    if (clamped !== current[key]) (out as Record<string, number>)[key] = clamped;
  }
  // Coherence: a dip-side delta that would collapse the entry window is
  // dropped, not clamped into a 5/5-style degenerate. Dropping preserves the
  // last coherent state; clamping would ratify the collapse.
  if ("dipPct" in out || "maxDipPct" in out) {
    const prospective: StrategyKnobs = { ...current, ...out };
    if (validateKnobs(prospective).some((p) => p.startsWith("dip window"))) {
      delete out.dipPct;
      delete out.maxDipPct;
    }
  }
  return out;
}

export interface WideningProposal {
  deltas: Partial<StrategyKnobs>;
  lesson: Lesson;
  /** One-line measured rationale for CLI output, e.g. train 14→19 trades. */
  detail: string;
}

/**
 * Counter-pressure against tighten-only drift. Replays the SAME train window
 * under single-knob relaxations and keeps the best one that adds ≥2 trades
 * and ≥$2 PnL without collapsing the win rate. Numbers in the lesson are
 * measured counterfactuals on train data (never held-out); evidence IDs cite
 * real baseline winners, so the lesson stays inside the evidence contract.
 * Returns null when nothing relaxed beats the baseline — tightening stands.
 */
export function wideningProbe(
  klines: Kline[],
  knobs: StrategyKnobs,
  baselineTrades: ClosedTrade[],
  symbol = "PROBE",
): WideningProposal | null {
  if (baselineTrades.length === 0 || klines.length === 0) return null;
  const basePnl = baselineTrades.reduce((a, t) => a + t.pnl, 0);
  const baseWins = baselineTrades.filter((t) => t.pnl > 0).length;
  const baseRate = baseWins / baselineTrades.length;
  const winners = baselineTrades.filter((t) => t.pnl > 0).map((t) => t.id);
  if (winners.length === 0) return null; // nothing good to argue from — stay quiet

  const candidates: { key: keyof StrategyKnobs; value: number; label: string }[] = [
    { key: "maxDipPct", value: Math.min(20, knobs.maxDipPct + 2), label: `maxDipPct ${knobs.maxDipPct}→${Math.min(20, knobs.maxDipPct + 2)}` },
    { key: "dipPct", value: Math.max(1, knobs.dipPct - 1), label: `dipPct ${knobs.dipPct}→${Math.max(1, knobs.dipPct - 1)}` },
    { key: "rsiMax", value: Math.min(50, knobs.rsiMax + 5), label: `rsiMax ${knobs.rsiMax}→${Math.min(50, knobs.rsiMax + 5)}` },
  ];
  let best: { key: keyof StrategyKnobs; value: number; label: string; n: number; pnl: number; rate: number } | null = null;
  for (const c of candidates) {
    const deltas = sanitizeKnobDeltas({ [c.key]: c.value } as Partial<StrategyKnobs>, knobs);
    if (!(c.key in deltas)) continue; // incoherent or no-op — skip
    const run = runReplay(klines, { symbol, knobs: { ...knobs, ...deltas }, equity: 1000 });
    const pnl = run.finalEquity - 1000;
    const n = run.trades.length;
    const rate = n ? run.trades.filter((t) => t.pnl > 0).length / n : 0;
    if (n >= baselineTrades.length + 2 && pnl >= basePnl + 2) {
      if (baselineTrades.length >= 5 && rate < baseRate - 0.15) continue; // don't buy PnL with a far worse hit rate
      if (!best || pnl > best.pnl) best = { ...c, value: deltas[c.key] as number, n, pnl, rate };
    }
  }
  if (!best) return null;
  return {
    deltas: { [best.key]: best.value } as Partial<StrategyKnobs>,
    lesson: {
      text: `train-window probe: relaxing ${best.label} on the same bars adds ${best.n - baselineTrades.length} trades and $${(best.pnl - basePnl).toFixed(2)} PnL (${baselineTrades.length}→${best.n} trades) — the window is starved, widen it and re-measure`,
      section: "SETUPS",
      evidence: winners,
      regimes: [],
    },
    detail: `${best.label}: train ${baselineTrades.length}→${best.n} trades, PnL ${basePnl.toFixed(1)}→${best.pnl.toFixed(1)}`,
  };
}

/** Deterministic fallback: earns its keep from aggregates, never from vibes. */
export function templateLessons(
  trades: ClosedTrade[],
  grades: Grade[],
  knobs: StrategyKnobs,
  takeR: number,
): { lessons: Lesson[]; knobDeltas: Partial<StrategyKnobs> } {
  const lessons: Lesson[] = [];
  const knobDeltas: Partial<StrategyKnobs> = {};
  if (trades.length === 0) return { lessons, knobDeltas };

  // Starvation voice: a book this thin cannot support tightening. No delta is
  // proposed here (no klines in this path to measure a counterfactual) — the
  // WATCH text steers the curator/LLM toward widening instead.
  if (trades.length < 5) {
    lessons.push({
      text: `book starved: ${trades.length} trades over the whole window — the entry window is over-restrictive; widen (lower dipPct, raise maxDipPct/rsiMax), do not tighten further`,
      section: "WATCH",
      evidence: trades.map((t) => t.id),
      regimes: [],
    });
  }

  const byRegime = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const arr = byRegime.get(t.intent.regime) ?? [];
    arr.push(t);
    byRegime.set(t.intent.regime, arr);
  }
  const pnlOf = (arr: ClosedTrade[]): number => arr.reduce((a, t) => a + t.pnl, 0);
  for (const [regime, arr] of byRegime) {
    if (arr.length < 3) continue;
    const pnl = pnlOf(arr);
    if (pnl < 0) {
      lessons.push({
        text: `dip-buys in ${regime} regimes lost $${(-pnl).toFixed(2)} over ${arr.length} trades — refuse or demand deeper confirmation there`,
        section: "FILTERS",
        evidence: arr.map((t) => t.id),
        regimes: [regime as Lesson["regimes"][number]],
      });
    }
  }
  const lucky = grades.filter((g) => g.luck === "lucky");
  if (lucky.length > 0) {
    lessons.push({
      text: `${lucky.length} win(s) printed without thesis confirmation — exits left edge on the table; take profit mechanically at target instead of lingering`,
      section: "MISTAKES",
      evidence: lucky.map((g) => g.tradeId),
      regimes: [],
    });
  }
  // Volatile-regime bleed → demand deeper oversold (fewer, better entries in chop).
  const vol = byRegime.get("volatile") ?? [];
  if (vol.length >= 3 && pnlOf(vol) < 0 && knobs.rsiMax - 5 >= 25) {
    knobDeltas.rsiMax = knobs.rsiMax - 5;
    lessons.push({
      text: `volatile-regime entries lost $${(-pnlOf(vol)).toFixed(2)} over ${vol.length} trades — demand RSI ≤ ${knobs.rsiMax - 5} there (rsiMax ${knobs.rsiMax} → ${knobs.rsiMax - 5})`,
      section: "FILTERS",
      evidence: vol.map((t) => t.id),
      regimes: ["volatile"],
    });
  }
  // Thesis confirmed but timed out → give winners room.
  const timedOut = trades.filter((t) => t.exitReason === "time" && t.mfeR >= takeR * 0.999);
  if (timedOut.length >= 3 && knobs.maxHoldBars + 12 <= 96) {
    knobDeltas.maxHoldBars = knobs.maxHoldBars + 12;
    lessons.push({
      text: `${timedOut.length} time-exits had already confirmed the thesis — hold up to ${knobs.maxHoldBars + 12} bars instead of ${knobs.maxHoldBars}`,
      section: "EXITS",
      evidence: timedOut.map((t) => t.id),
      regimes: [],
    });
  }
  // Stop-dominated book → stops sit inside noise; widen.
  const stops = trades.filter((t) => t.exitReason === "stop");
  if (trades.length >= 5 && stops.length / trades.length > 0.5 && knobs.stopPct + 0.5 <= 3) {
    knobDeltas.stopPct = Math.round((knobs.stopPct + 0.5) * 100) / 100;
    lessons.push({
      text: `${stops.length}/${trades.length} exits were stops — invalidation inside noise; widen stop to ${knobDeltas.stopPct}% (sizing auto-shrinks: risk stays 1%)`,
      section: "EXITS",
      evidence: stops.map((t) => t.id),
      regimes: [],
    });
  }
  // Tighten the falling-knife guard if deep dips lose — but never below the
  // coherence floor (maxDipPct − dipPct ≥ 2). A tighter window that stops
  // trading is a shutdown, not a lesson.
  const dipped = trades.filter((t) => t.maeR > 1.5);
  if (dipped.length >= 3) {
    const pnl = pnlOf(dipped);
    if (pnl < 0) {
      const proposed = Math.max(4, knobs.maxDipPct - 2);
      // The lesson must not advocate a delta the coherence floor would block:
      // prose and knobs stay in agreement, or the curator hears double.
      if (proposed < knobs.maxDipPct && proposed - knobs.dipPct >= MIN_DIP_WINDOW) {
        knobDeltas.maxDipPct = proposed;
        lessons.push({
          text: `deep-dip entries (adverse excursion >1.5R) lost $${(-pnl).toFixed(2)} across ${dipped.length} trades — tighten maxDipPct to ${proposed}`,
          section: "FILTERS",
          evidence: dipped.map((t) => t.id),
          regimes: [],
        });
      }
    }
  }
  return { lessons: lessons.slice(0, 5), knobDeltas };
}
