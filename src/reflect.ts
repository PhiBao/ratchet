/**
 * Reflector: grades closed trades deterministically, then asks the LLM to
 * narrate graded facts into candidate lessons. The model never sees raw
 * discretion — only the grade packet. Any lesson citing unknown trade IDs
 * or inventing numbers is rejected; reflection falls back to templates.
 */
import type { ClosedTrade, Grade, Lesson, Playbook } from "./types.js";
import { gradeTrade, summarizeGrades } from "./grade.js";
import { chatComplete } from "./llm.js";
import type { StrategyKnobs } from "./strategy.js";

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
- knobDeltas may adjust ONLY these keys: dipPct, maxDipPct, rsiMax, takePct, stopPct, maxHoldBars. Each delta needs evidence (trade IDs) in its rationale. Ranges: dipPct 1-6, maxDipPct 4-20, rsiMax 25-50, takePct 1-5, stopPct 0.5-3, maxHoldBars 12-96.
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

export function sanitizeKnobDeltas(deltas: Partial<StrategyKnobs>, current: StrategyKnobs): Partial<StrategyKnobs> {
  const out: Partial<StrategyKnobs> = {};
  for (const [k, v] of Object.entries(deltas)) {
    const key = k as keyof StrategyKnobs;
    if (!(key in KNOB_RANGES) || typeof v !== "number" || !Number.isFinite(v)) continue;
    const [lo, hi] = KNOB_RANGES[key] ?? [0, 0];
    const clamped = Math.min(hi, Math.max(lo, v));
    if (clamped !== current[key]) (out as Record<string, number>)[key] = clamped;
  }
  return out;
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
  // Tighten the falling-knife guard if deep dips lose.
  const dipped = trades.filter((t) => t.maeR > 1.5);
  if (dipped.length >= 3) {
    const pnl = pnlOf(dipped);
    if (pnl < 0) {
      const proposed = Math.max(4, knobs.maxDipPct - 2);
      if (proposed < knobs.maxDipPct) knobDeltas.maxDipPct = proposed;
      lessons.push({
        text: `deep-dip entries (adverse excursion >1.5R) lost $${(-pnl).toFixed(2)} across ${dipped.length} trades — tighten maxDipPct to ${proposed}`,
        section: "FILTERS",
        evidence: dipped.map((t) => t.id),
        regimes: [],
      });
    }
  }
  return { lessons: lessons.slice(0, 5), knobDeltas };
}
