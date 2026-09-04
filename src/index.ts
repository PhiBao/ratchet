/**
 * ratchet CLI — every loop module, runnable headless for replay and batch.
 *   fetch     download historical klines from Binance public market data
 *   replay    run the knob strategy over klines CSV (honest fills)
 *   reflect   grade journaled closes, propose lessons (+knob deltas)
 *   curate    merge reflection into a new playbook version
 *   ab        walk-forward proof: train → curate → frozen-v0 vs evolved on held-out
 *   sweep     walk-forward table across datasets × folds (deterministic)
 *   dashboard emit a self-contained HTML report
 *   audit     verify hash chains
 *   auth      OAuth login / status / list live MCP tools (Day-1 spike)
 *   halt|resume  kill switch
 *   playbook  show | diff
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Journal } from "./journal.js";
import { PlaybookStore } from "./playbook.js";
import { applyCuration } from "./curate.js";
import { reflectOnTrades, wideningProbe } from "./reflect.js";
import { activityVerdict, fisherTwoSided, type ActivityVerdict } from "./stats.js";
import { gradeTrade, summarizeGrades } from "./grade.js";
import { DEFAULT_KNOBS, type StrategyKnobs } from "./strategy.js";
import { parseKlines, runReplay } from "./venues/replay.js";
import { checkGaps, fetchKlines, INTERVAL_MS, toCsv } from "./venues/klines.js";
import { BinanceCliVenue, cliPresence } from "./venues/binancecli.js";
import { defaultMandate, evaluate } from "./safety.js";
import { listTools, MCP_URL, type McpToken } from "./mcp.js";
import type { ClosedTrade, Grade, Kline, Lesson, Playbook, TradeIntent } from "./types.js";

const ROOT = process.cwd();
const DATA = join(ROOT, "data");
const JOURNAL_PATH = join(DATA, "journal.jsonl");
const AUDIT_PATH = join(DATA, "audit.log.jsonl");
const TOKEN_PATH = join(DATA, "token.json");

/** Minimal .env loader (no dependency). */
function loadEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = process.argv.slice(3);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] ?? "";
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = raw[i + 1] && !raw[i + 1]?.startsWith("--") ? (raw[i + 1] as string) : "true";
      out[k] = v;
      if (v !== "true") i++;
    }
  }
  return out;
}

function loadCsv(path: string): (string | number)[][] {
  if (!existsSync(path)) {
    // Point at the right symbol when the filename follows the
    // <symbol>-<interval>.csv convention, else fall back to BTCUSDT.
    const guessed = inferSymbol(path);
    const symbol = defaultMandate().symbols.includes(guessed) ? guessed : "BTCUSDT";
    throw new Error(
      `no klines at ${path} — fetch them first:\n` +
        `  ratchet fetch --symbol ${symbol} --interval 1h --months 12 --out ${path}`,
    );
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("open_time"))
    .map((l) => l.split(",").map((c) => {
      const n = Number(c);
      return Number.isFinite(n) && c.trim() !== "" ? n : c;
    }));
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

function votesFromGrades(trades: ClosedTrade[], grades: Grade[]): { id: string; vote: "helpful" | "harmful" }[] {
  const votes: { id: string; vote: "helpful" | "harmful" }[] = [];
  for (const t of trades) {
    const g = grades.find((x) => x.tradeId === t.id);
    if (!g || g.decisionScore === 0) continue;
    for (const id of t.intent.ruleIds) {
      votes.push({ id, vote: g.decisionScore > 0 ? "helpful" : "harmful" });
    }
  }
  return votes;
}

// --- commands ---

/** Parses --start/--end as YYYY-MM-DD or epoch ms. */
function parseWhen(v: string, label: string): number {
  const asNum = Number(v);
  if (Number.isFinite(asNum) && asNum > 1e10) return asNum;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(t)) throw new Error(`${label}: cannot parse "${v}" (use YYYY-MM-DD or epoch ms)`);
  return t;
}

async function cmdFetch(a: Record<string, string>): Promise<void> {
  const symbol = (a["symbol"] ?? "BTCUSDT").toUpperCase();
  const interval = a["interval"] ?? "1h";
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`fetch: unsupported --interval ${interval} (have: ${Object.keys(INTERVAL_MS).join(",")})`);

  // Window: explicit --start/--end wins, else --months/--bars back from --end (default now).
  const end = a["end"] ? parseWhen(a["end"], "--end") : Date.now();
  let start: number;
  if (a["start"]) start = parseWhen(a["start"], "--start");
  else if (a["bars"]) start = end - Number(a["bars"]) * step;
  else start = end - Number(a["months"] ?? 12) * 30 * 86_400_000;
  if (!(start < end)) throw new Error("fetch: --start must precede --end");

  const out = a["out"] ?? join(DATA, `${symbol.toLowerCase()}-${interval}.csv`);
  // Redraw progress in place only on a real terminal; piped stderr gets no escapes.
  const tty = process.stderr.isTTY === true;
  process.stderr.write(`fetching ${symbol} ${interval} ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}\n`);
  const rows = await fetchKlines({
    symbol,
    interval,
    startMs: start,
    endMs: end,
    onProgress: (n, through) => {
      if (!tty) return;
      process.stderr.write(`\r\x1b[K  ${n} bars … ${new Date(through).toISOString().slice(0, 10)}`);
    },
  });
  if (tty) process.stderr.write("\r\x1b[K");
  if (rows.length === 0) throw new Error(`fetch: no bars returned for ${symbol} ${interval} in that window`);

  const g = checkGaps(rows, interval);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toCsv(rows));
  console.log(`wrote ${out}`);
  console.log(
    `${g.bars} bars ${new Date(g.firstMs).toISOString().slice(0, 10)} → ${new Date(g.lastMs).toISOString().slice(0, 10)}` +
      ` (${(g.bars * step / 86_400_000).toFixed(0)} days)` +
      (g.missing > 0 ? ` — WARNING ${g.missing} missing bars vs gapless series` : " — no gaps"),
  );
}

async function cmdReplay(a: Record<string, string>): Promise<void> {
  const csv = a["csv"];
  if (!csv) throw new Error("replay --csv <klines.csv> [--symbol BTCUSDT] [--knobs '{...}'] [--equity 1000]");
  const store = new PlaybookStore(join(ROOT, "playbook"));
  const pb = store.load();
  const knobs: StrategyKnobs = { ...DEFAULT_KNOBS, ...store.knobs(pb), ...(a["knobs"] ? (JSON.parse(a["knobs"]) as Record<string, number>) : {}) };
  const symbol = a["symbol"] ?? "BTCUSDT";
  const klines = parseKlines(loadCsv(csv));
  const { trades, finalEquity } = runReplay(klines, {
    symbol,
    knobs,
    equity: Number(a["equity"] ?? 1000),
    playbookVersion: pb.version,
    ruleIds: pb.bullets.filter((b) => !b.retired && b.section === "SETUPS").map((b) => b.id),
  });
  const journal = new Journal(JOURNAL_PATH);
  for (const t of trades) {
    journal.append("intent", t.intent);
    journal.append("fill", t.entry);
    journal.append("fill", t.exit);
    journal.append("close", t);
  }
  const takeR = knobs.takePct / knobs.stopPct;
  const grades = trades.map((t) => gradeTrade(t, takeR));
  for (const g of grades) journal.append("grade", g);
  const s = summarizeGrades(trades, grades);
  console.log(`replay ${symbol}: ${klines.length} bars, playbook v${pb.version}`);
  console.log(`trades=${s.n} winRate=${(s.winRate * 100).toFixed(1)}% pnl=${fmt(s.totalPnl)} skilled=${s.skilledWins} lucky=${s.luckyWins} avgScore=${fmt(s.avgScore)} equity=${fmt(finalEquity)}`);
}

async function cmdReflect(a: Record<string, string>): Promise<void> {
  const journal = new Journal(JOURNAL_PATH);
  const since = a["since"] ? new Date(a["since"]).getTime() : 0;
  const trades = journal
    .ofKind("close")
    .map((e) => e.payload as ClosedTrade)
    .filter((t) => new Date(t.closedAt).getTime() >= since);
  if (trades.length === 0) {
    console.log("no closed trades to reflect on");
    return;
  }
  const store = new PlaybookStore(join(ROOT, "playbook"));
  const pb = store.load();
  const knobs = { ...DEFAULT_KNOBS, ...store.knobs(pb) };
  const takeR = knobs.takePct / knobs.stopPct;
  const r = await reflectOnTrades(trades, takeR, pb, knobs, a["llm"] !== "false");
  for (const g of r.grades) journal.append("grade", g);
  console.log(`reflected on ${trades.length} trades (source=${r.source})`);
  console.log(`pnl=${fmt(r.summary.totalPnl)} winRate=${(r.summary.winRate * 100).toFixed(1)}% skilled=${r.summary.skilledWins} lucky=${r.summary.luckyWins}`);
  for (const l of r.lessons) {
    console.log(`- [${l.section}] ${l.text} (ev: ${l.evidence.join(",")})`);
  }
  if (Object.keys(r.knobDeltas).length) console.log(`knobDeltas: ${JSON.stringify(r.knobDeltas)}`);
  const out = join(DATA, `reflection-${Date.now()}.json`);
  mkdirSync(DATA, { recursive: true });
  writeFileSync(out, JSON.stringify({ trades: trades.map((t) => t.id), lessons: r.lessons, knobDeltas: r.knobDeltas, votes: votesFromGrades(trades, r.grades) }, null, 2));
  console.log(`saved ${out}`);
}

async function cmdCurate(a: Record<string, string>): Promise<void> {
  const files = readdirSync(DATA).filter((f) => f.startsWith("reflection-") && f.endsWith(".json")).sort();
  const from = a["from"] ?? (files.length ? join(DATA, files[files.length - 1] as string) : undefined);
  if (!from || !existsSync(from)) throw new Error("no reflection found — run `reflect` first or pass --from <file>");
  const refl = JSON.parse(readFileSync(from, "utf8")) as {
    lessons: Lesson[];
    votes: { id: string; vote: "helpful" | "harmful" }[];
    knobDeltas: Record<string, number>;
  };
  const store = new PlaybookStore(join(ROOT, "playbook"));
  const pb = store.load();
  const { next, ops } = applyCuration(pb, {
    lessons: refl.lessons,
    votes: refl.votes,
    knobDeltas: refl.knobDeltas,
    knobOwnerNote: `reflection ${from.split("/").pop()}`,
    curationNote: a["note"] ?? `curated from ${refl.lessons.length} lessons, ${refl.votes.length} votes`,
  });
  console.log(`curation ops (parent v${pb.version}):`);
  for (const op of ops) console.log(`  ${op}`);
  if (ops.length === 0) {
    console.log("nothing changed — no new version written");
    return;
  }
  if (a["apply"] !== "true") {
    console.log("dry run — pass --apply to write the new version");
    return;
  }
  const saved = store.saveNext(next, next.curationNote);
  new Journal(JOURNAL_PATH).append("curation", { version: saved.version, ops });
  console.log(`wrote playbook v${saved.version}`);
}

/** One walk-forward cell, shared by `ab` (verbose) and `sweep` (tabular). Pure except LLM use. */
export interface AbCell {
  trainBars: number;
  testBars: number;
  trainTrades: number;
  source: "llm" | "template";
  ops: string[];
  probeNotes: string[];
  frozenN: number;
  frozenWins: number;
  frozenPnl: number;
  frozenSkilled: number;
  frozenEquity: number;
  evolvedN: number;
  evolvedWins: number;
  evolvedPnl: number;
  evolvedSkilled: number;
  evolvedEquity: number;
  deltaPnl: number;
  fisherP: number;
  activity: ActivityVerdict;
}

export async function runAbCell(args: {
  train: Kline[];
  test: Kline[];
  symbol: string;
  equity: number;
  base: Playbook;
  knobs0: StrategyKnobs;
  ruleIds: string[];
  useLlm: boolean;
}): Promise<AbCell> {
  const { train, test, symbol, equity, base, knobs0, ruleIds, useLlm } = args;
  const takeR0 = knobs0.takePct / knobs0.stopPct;
  const tr = runReplay(train, { symbol, knobs: knobs0, equity, playbookVersion: base.version, ruleIds });
  const r = await reflectOnTrades(tr.trades, takeR0, base, knobs0, useLlm);
  // Two-way ratchet: the widening probe replays the same train window under
  // relaxed knobs. When starvation is the problem it overrides a conflicting
  // tightening on the same key — train data decides the direction, not habit.
  const lessons = [...r.lessons];
  const probeNotes: string[] = [];
  const mergedDeltas: Record<string, number> = { ...(r.knobDeltas as Record<string, number>) };
  const probe = wideningProbe(train, knobs0, tr.trades, symbol);
  if (probe) {
    for (const [k, v] of Object.entries(probe.deltas)) {
      probeNotes.push(
        k in mergedDeltas
          ? `widening probe overrides ${k} ${mergedDeltas[k]} → ${v} (${probe.detail})`
          : `widening probe: ${probe.detail}`,
      );
      mergedDeltas[k] = v as number;
    }
    lessons.push(probe.lesson);
  }
  const { ops } = applyCuration(base, {
    lessons,
    votes: votesFromGrades(tr.trades, r.grades),
    knobDeltas: mergedDeltas,
    knobOwnerNote: "ab-train",
    curationNote: `ab walk-forward from ${tr.trades.length} train trades`,
  });

  // Evolved knobs = v0 knobs + deltas applied to owners (mirror of curate, no write).
  const evolved = { ...knobs0 };
  for (const [k, v] of Object.entries(mergedDeltas)) {
    (evolved as Record<string, number>)[k] = v as number;
  }

  // Held-out test: frozen vs evolved.
  const frozen = runReplay(test, { symbol, knobs: knobs0, equity, playbookVersion: base.version, ruleIds });
  const evolvedRun = runReplay(test, { symbol, knobs: evolved, equity, playbookVersion: base.version, ruleIds });
  const gf = frozen.trades.map((t) => gradeTrade(t, takeR0));
  const takeRe = evolved.takePct / evolved.stopPct;
  const ge = evolvedRun.trades.map((t) => gradeTrade(t, takeRe));
  const sf = summarizeGrades(frozen.trades, gf);
  const se = summarizeGrades(evolvedRun.trades, ge);
  return {
    trainBars: train.length,
    testBars: test.length,
    trainTrades: tr.trades.length,
    source: r.source,
    ops,
    probeNotes,
    frozenN: sf.n,
    frozenWins: sf.wins,
    frozenPnl: sf.totalPnl,
    frozenSkilled: sf.skilledWins,
    frozenEquity: frozen.finalEquity,
    evolvedN: se.n,
    evolvedWins: se.wins,
    evolvedPnl: se.totalPnl,
    evolvedSkilled: se.skilledWins,
    evolvedEquity: evolvedRun.finalEquity,
    deltaPnl: se.totalPnl - sf.totalPnl,
    fisherP: fisherTwoSided(se.wins, se.n - se.wins, sf.wins, sf.n - sf.wins),
    activity: activityVerdict(sf.n, se.n),
  };
}

async function cmdAb(a: Record<string, string>): Promise<void> {
  const csv = a["csv"];
  if (!csv) throw new Error("ab --csv <klines.csv> [--symbol BTCUSDT] [--train-frac 0.6] [--equity 1000] [--llm false]");
  const frac = Number(a["train-frac"] ?? 0.6);
  const symbol = a["symbol"] ?? "BTCUSDT";
  const equity = Number(a["equity"] ?? 1000);
  const klines = parseKlines(loadCsv(csv));
  const cut = Math.floor(klines.length * frac);
  const train = klines.slice(0, cut);
  const test = klines.slice(cut);
  const store = new PlaybookStore(join(ROOT, "playbook"));
  // --base pins the frozen baseline version (default: latest). The demo pins v0
  // so the advertised walk-forward numbers reproduce bit-for-bit from any repo state.
  const v0 = store.load(a["base"] !== undefined ? Number(a["base"]) : undefined);
  const knobs0 = { ...DEFAULT_KNOBS, ...store.knobs(v0) };

  // Train with frozen v0.
  const ruleIds = v0.bullets.filter((b) => !b.retired && b.section === "SETUPS").map((b) => b.id);
  const cell = await runAbCell({
    train, test, symbol, equity, base: v0, knobs0, ruleIds, useLlm: a["llm"] !== "false",
  });
  for (const note of cell.probeNotes) console.log(`  ${note}`);
  console.log(`train: ${cell.trainTrades} trades, ${cell.ops.length} curation ops (${cell.source})`);
  for (const op of cell.ops) console.log(`  ${op}`);
  const sf = { n: cell.frozenN, wins: cell.frozenWins, winRate: cell.frozenN ? cell.frozenWins / cell.frozenN : 0, totalPnl: cell.frozenPnl, skilledWins: cell.frozenSkilled, luckyWins: 0, avgScore: 0 };
  const se = { n: cell.evolvedN, wins: cell.evolvedWins, winRate: cell.evolvedN ? cell.evolvedWins / cell.evolvedN : 0, totalPnl: cell.evolvedPnl, skilledWins: cell.evolvedSkilled, luckyWins: 0, avgScore: 0 };
  const row = (name: string, s: typeof sf, eq: number): string =>
    `${name.padEnd(8)} trades=${String(s.n).padStart(3)} winRate=${(s.winRate * 100).toFixed(1).padStart(5)}% pnl=${fmt(s.totalPnl, 1).padStart(8)} skilled=${s.skilledWins} lucky=${s.luckyWins} equity=${fmt(eq, 1)}`;
  console.log(`held-out test: ${test.length} bars`);
  console.log(row("frozen", sf, cell.frozenEquity));
  console.log(row("evolved", se, cell.evolvedEquity));
  console.log(`delta pnl=${fmt(se.totalPnl - sf.totalPnl, 1)} (train ${train.length} bars → test ${test.length} bars, no peeking)`);
  // Honest stats, computed from the same counts as the table above.
  const p = cell.fisherP;
  const act = cell.activity;
  console.log(
    `stats: win-rate Fisher two-sided p=${p.toFixed(2)} (${se.wins}/${se.n} vs ${sf.wins}/${sf.n}` +
      (p >= 0.05 ? " — n too small to claim significance" : " — significant at 5%") +
      `)`,
  );
  if (act === "empty") {
    console.log(`activity: NO EVIDENCE — neither baseline traded on this window; pick a window both can trade or no claim is possible`);
  } else if (act === "degenerate") {
    console.log(`activity: DEGENERATE — evolved took 0 trades while frozen took ${sf.n}; the loop produced a shutdown, not a strategy`);
  } else if (act === "thin") {
    console.log(`activity: THIN — evolved took ${se.n} trades from ${sf.n} frozen; too little activity to claim decision-quality gains`);
  } else {
    console.log(`activity: ok (${se.n} evolved vs ${sf.n} frozen trades)`);
  }
}

/** Derives BTCUSDT from data/btcusdt-1h.csv (basename, strip trailing -<interval>). */
function inferSymbol(csvPath: string): string {
  const base = (csvPath.split("/").pop() ?? csvPath).replace(/\.[^.]+$/, "");
  return base.replace(/-\d+[mhdw]$/i, "").toUpperCase();
}

async function cmdSweep(a: Record<string, string>): Promise<void> {
  const defaultCsvs = [join(DATA, "btcusdt-1h.csv"), join(DATA, "ethusdt-1h.csv")].filter((p) => existsSync(p));
  const csvs = (a["csvs"] ? a["csvs"].split(",").map((s) => s.trim()).filter(Boolean) : defaultCsvs);
  if (csvs.length === 0) {
    throw new Error("sweep: no CSVs — pass --csvs a.csv,b.csv or fetch data first (`ratchet fetch --help`)");
  }
  const fracs = (a["fracs"] ?? "0.4,0.5,0.6,0.7").split(",").map(Number);
  if (fracs.some((f) => !(f > 0 && f < 1))) throw new Error("sweep: --fracs must be comma-separated fractions in (0,1)");
  const explicitSymbols = a["symbols"] ? a["symbols"].split(",").map((s) => s.trim().toUpperCase()) : [];
  if (explicitSymbols.length > 0 && explicitSymbols.length !== csvs.length) {
    throw new Error("sweep: --symbols must list one symbol per CSV (or omit to infer from filenames)");
  }
  const equity = Number(a["equity"] ?? 1000);
  const store = new PlaybookStore(join(ROOT, "playbook"));
  const base = store.load(a["base"] !== undefined ? Number(a["base"]) : undefined);
  const knobs0 = { ...DEFAULT_KNOBS, ...store.knobs(base) };
  const ruleIds = base.bullets.filter((b) => !b.retired && b.section === "SETUPS").map((b) => b.id);
  // Deterministic by design: a proof table must reproduce bit-for-bit.
  console.log(`sweep: ${csvs.length} dataset(s) × ${fracs.length} fold(s), base v${base.version}, deterministic templates (LLM off)`);

  const rows: { csv: string; symbol: string; frac: number; cell: AbCell }[] = [];
  for (const csv of csvs) {
    const symbol = explicitSymbols[csvs.indexOf(csv) as number] ?? inferSymbol(csv as string);
    const klines = parseKlines(loadCsv(csv as string));
    for (const frac of fracs) {
      const cut = Math.floor(klines.length * (frac as number));
      const cell = await runAbCell({
        train: klines.slice(0, cut),
        test: klines.slice(cut),
        symbol,
        equity,
        base,
        knobs0,
        ruleIds,
        useLlm: false,
      });
      rows.push({ csv: (csv as string).split("/").pop() ?? (csv as string), symbol, frac: frac as number, cell });
    }
  }
  const name = (csv: string, frac: number): string => `${csv} f=${frac}`;
  console.log(`${"cell".padEnd(28)} ${"frozen".padStart(14)} ${"evolved".padStart(14)} ${"Δ pnl".padStart(8)} ${"p".padStart(6)} activity`);
  for (const r of rows) {
    const f = `${r.cell.frozenN}×${fmt(r.cell.frozenPnl, 1)}`;
    const e = `${r.cell.evolvedN}×${fmt(r.cell.evolvedPnl, 1)}`;
    console.log(
      `${name(r.csv, r.frac).padEnd(28)} ${f.padStart(14)} ${e.padStart(14)} ` +
        `${fmt(r.cell.deltaPnl, 1).padStart(8)} ${r.cell.fisherP.toFixed(2).padStart(6)} ${r.cell.activity}`,
    );
  }
  const ok = rows.filter((r) => r.cell.activity === "ok");
  const deltas = ok.map((r) => r.cell.deltaPnl).sort((x, y) => x - y);
  const median = deltas.length ? (deltas[Math.floor((deltas.length - 1) / 2)] as number) : 0;
  const mean = deltas.length ? deltas.reduce((x, y) => x + y, 0) / deltas.length : 0;
  const pos = ok.filter((r) => r.cell.deltaPnl > 0).length;
  const verdicts = ["ok", "thin", "degenerate", "empty"].map((v) => `${v}=${rows.filter((r) => r.cell.activity === v).length}`).join(" ");
  console.log(
    `summary: ${rows.length} cells (${verdicts}); over ${ok.length} ok cells ` +
      `median Δ ${fmt(median, 1)}, mean Δ ${fmt(mean, 1)}, ${pos} positive` +
      (ok.length < rows.length ? " — non-ok cells excluded from median/mean, listed above" : ""),
  );
}

async function cmdDashboard(): Promise<void> {
  const journal = new Journal(JOURNAL_PATH);
  const closes = journal.ofKind("close").map((e) => e.payload as ClosedTrade);
  // Cumulative realized PnL from the journaled trades (venue-agnostic, no baseline fiction).
  let cum = 0;
  const pts: { i: number; cum: number }[] = closes.map((t, i) => {
    cum += t.pnl;
    return { i, cum };
  });
  const finalCum = pts.length ? (pts[pts.length - 1]?.cum ?? 0) : 0;
  const lo = Math.min(0, ...pts.map((p) => p.cum));
  const hi = Math.max(0, ...pts.map((p) => p.cum));
  const span = Math.max(hi - lo, 1e-9);
  const W = 720;
  const H = 220;
  const path = pts
    .map((p, i) => {
      const px = closes.length < 2 ? W / 2 : (i / (closes.length - 1)) * (W - 20) + 10;
      const py = H - 10 - ((p.cum - lo) / span) * (H - 20);
      return `${i === 0 ? "M" : "L"}${px.toFixed(1)},${Math.max(5, Math.min(H - 5, py)).toFixed(1)}`;
    })
    .join(" ");
  const rows = closes
    .map((t) => `<tr><td>${t.id}</td><td>${t.intent.symbol}</td><td>${t.intent.regime}</td><td>${t.exitReason}</td><td>${fmt(t.pnl)}</td><td>${t.mfeR.toFixed(1)}R</td></tr>`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf8"><title>Ratchet — loop report</title></head><body style="font-family:system-ui;max-width:900px;margin:2rem auto;color:#111">` +
    `<h1>Ratchet — every trade ratchets forward</h1>` +
    `<p>${closes.length} closed trades · cumulative realized PnL ${fmt(finalCum)} USDT</p>` +
    `<svg width="${W}" height="${H}" style="border:1px solid #ccc"><path d="${path}" fill="none" stroke="#0a7" stroke-width="2"/></svg>` +
    `<table border="1" cellpadding="6" style="border-collapse:collapse;margin-top:1rem"><tr><th>id</th><th>symbol</th><th>regime</th><th>exit</th><th>pnl</th><th>mfe</th></tr>${rows}</table>` +
    `<p style="color:#555">Not financial advice. Replay fills use next-bar-open discipline + fees; live fills are journaled with their venue.</p>` +
    `</body></html>`;
  const out = join(ROOT, "dashboard", "report.html");
  writeFileSync(out, html);
  console.log(`wrote ${out}`);
}

async function cmdAudit(): Promise<void> {
  for (const p of [JOURNAL_PATH, AUDIT_PATH]) {
    const j = new Journal(p);
    const v = j.verify();
    console.log(`${p}: ${v.ok ? `OK (${v.entries} entries)` : `BROKEN at seq ${v.brokenAt} — halt and investigate`}`);
  }
}

async function cmdAuth(a: Record<string, string>): Promise<void> {
  const sub = a["_"] ?? "status";
  if (sub === "status") {
    const cli = await cliPresence();
    console.log(`binance-cli: ${cli.installed ? cli.version : "NOT INSTALLED (see \`ratchet auth setup\`)"}`);
    console.log(`MCP token file: ${existsSync(TOKEN_PATH) ? "present" : "absent (only needed for host-issued tokens)"}`);
    return;
  }
  if (sub === "setup") {
    console.log(
      [
        "Ratchet connects through Binance's supported paths (custom OAuth clients are rejected",
        "by Binance with 3346001 'agent not supported' — self-registered OAuth is a dead end):",
        "",
        "A. Runner trading (this CLI) — official binance-cli, keys stay in its profile store:",
        "   1. Log into https://testnet.binance.vision with GitHub → create an API key/secret.",
        "   2. binance-cli profile create --name ratchet-testnet --api-key <k> --api-secret <s> --env testnet",
        "   3. ratchet account --profile ratchet-testnet   # verify balances",
        "   4. ratchet live-buy --symbol BTCUSDT --usd 10 --profile ratchet-testnet",
        "",
        "B. Agentic sub-account (Agent OS MCP) — approved host agents only:",
        "   Claude: claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic",
        "   Cursor/ChatGPT: add the same URL as an MCP server (host handles OAuth).",
        "   Then load this repo's SKILL.md in that session — Ratchet provides the loop, the host provides auth.",
      ].join("\n"),
    );
    return;
  }
  if (sub === "tools") {
    // Only works with a token issued to an approved host that exposes it.
    const fromEnv = process.env["RATCHET_MCP_TOKEN"];
    const fromFile = existsSync(TOKEN_PATH)
      ? (JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as McpToken)
      : undefined;
    if (!fromEnv && !fromFile) {
      throw new Error("no MCP token — connect via a supported host first (see `ratchet auth setup` B)");
    }
    const tok: McpToken = fromEnv
      ? { access_token: fromEnv, token_type: "Bearer", obtained_at: Date.now() }
      : (fromFile as McpToken);
    const { tools } = await listTools(tok);
    console.log(`live MCP tools at ${MCP_URL}:`);
    for (const tool of tools) console.log(`- ${tool.name}${tool.description ? ` — ${tool.description.slice(0, 100)}` : ""}`);
    return;
  }
  throw new Error(`unknown auth subcommand: ${sub} (status|setup|tools)`);
}

function dayPnlUsd(journal: Journal, venue: string): number {
  const day = new Date().toISOString().slice(0, 10);
  return journal
    .ofKind("close")
    .map((e) => e.payload as ClosedTrade)
    .filter((t) => t.intent.venue === venue && t.closedAt.slice(0, 10) === day)
    .reduce((a, t) => a + t.pnl, 0);
}

async function cmdAccount(a: Record<string, string>): Promise<void> {
  const profile = a["profile"];
  if (!profile) throw new Error("account --profile <name>");
  const venue = new BinanceCliVenue({ profile, venue: "testnet" });
  const bals = await venue.balances();
  if (!bals.length) {
    console.log("no non-zero balances");
    return;
  }
  for (const b of bals) console.log(`${b.asset}: free=${b.free} locked=${b.locked}`);
}

async function cmdLiveBuy(a: Record<string, string>): Promise<void> {
  const symbol = a["symbol"] ?? "BTCUSDT";
  const usd = Number(a["usd"] ?? 10);
  const profile = a["profile"];
  if (!profile) throw new Error("live-buy --symbol BTCUSDT --usd 10 --profile <name> [--rule <id>] [--setup <text>]");
  if (!(usd > 0)) throw new Error("--usd must be positive");
  const mandate = defaultMandate();
  const store = new PlaybookStore(join(ROOT, "playbook"));
  const pb = store.load();
  const knobs: StrategyKnobs = { ...DEFAULT_KNOBS, ...store.knobs(pb) };
  const venue = new BinanceCliVenue({ profile, venue: "testnet" });
  const price = await venue.price(symbol);
  const target = price * (1 + knobs.takePct / 100);
  const invalidation = price * (1 - knobs.stopPct / 100);
  const setupIds = pb.bullets.filter((b) => !b.retired && b.section === "SETUPS").map((b) => b.id);
  const intent: TradeIntent = {
    id: `live-${Date.now()}`,
    symbol,
    side: "BUY",
    usdNotional: Math.min(usd, mandate.maxPerTradeUsd),
    qty: 0, // filled by broker response
    entryRef: price,
    setup: a["setup"] ?? `dip-buy one-shot at ${price} (playbook v${pb.version})`,
    target,
    invalidation,
    ruleIds: a["rule"] ? [a["rule"]] : setupIds,
    regime: "unknown",
    playbookVersion: pb.version,
    venue: "testnet",
    createdAt: new Date().toISOString(),
  };
  const journal = new Journal(JOURNAL_PATH);
  const verdict = evaluate(intent, { mandate, dayPnlUsd: dayPnlUsd(journal, "testnet"), halted: false });
  journal.append("verdict", { intentId: intent.id, ...verdict });
  console.log(`safety: ${verdict.verdict} (${verdict.rule}) — ${verdict.detail}`);
  if (verdict.verdict !== "PASS") return;
  const fill = await venue.marketBuy(intent, `rch-${intent.id}`.slice(0, 32));
  journal.append("intent", intent);
  journal.append("fill", fill);
  console.log(`filled ${fill.qty} ${symbol} @ ${fill.price} (fee ${fill.fee} ${fill.feeAsset}, order ${fill.orderId ?? "?"})`);
}

async function cmdPlaybook(a: Record<string, string>): Promise<void> {
  const store = new PlaybookStore(join(ROOT, "playbook"));
  const sub = a["_"] ?? "show";
  if (sub === "show") {
    const pb = store.load(a["v"] ? Number(a["v"]) : undefined);
    const active = pb.bullets.filter((b) => !b.retired);
    console.log(`playbook v${pb.version}: ${active.length} active / ${pb.bullets.length} total bullets`);
    for (const b of active) {
      console.log(`[${b.id}] h=${b.helpful} x=${b.harmful} (${b.regimes.join(",")}) :: ${b.text.slice(0, 100)}`);
    }
    return;
  }
  throw new Error(`unknown playbook subcommand: ${sub}`);
}

async function main(): Promise<void> {
  loadEnv();
  mkdirSync(DATA, { recursive: true });
  const cmd = process.argv[2] ?? "help";
  const a = args();
  // subcommand captured as first non-flag token
  const sub = process.argv.slice(3).find((x) => !x.startsWith("--") && !Object.values(a).includes(x));
  if (sub) a["_"] = sub;
  switch (cmd) {
    case "fetch": await cmdFetch(a); break;
    case "replay": await cmdReplay(a); break;
    case "reflect": await cmdReflect(a); break;
    case "curate": await cmdCurate(a); break;
    case "ab": await cmdAb(a); break;
    case "sweep": await cmdSweep(a); break;
    case "dashboard": await cmdDashboard(); break;
    case "audit": await cmdAudit(); break;
    case "auth": await cmdAuth(a); break;
    case "account": await cmdAccount(a); break;
    case "live-buy": await cmdLiveBuy(a); break;
    case "halt":
      writeFileSync(defaultMandate().killSwitchPath, `halted at ${new Date().toISOString()} — remove only with a stated reason\n`);
      new Journal(AUDIT_PATH).append("halt", { at: new Date().toISOString() });
      console.log("HALTED");
      break;
    case "resume": {
      const p = defaultMandate().killSwitchPath;
      if (!existsSync(p)) { console.log("not halted"); break; }
      const reason = a["reason"];
      if (!reason) throw new Error("resume requires --reason (audit-logged)");
      unlinkSync(p);
      new Journal(AUDIT_PATH).append("halt", { resumed: true, reason });
      console.log("resumed");
      break;
    }
    case "playbook": await cmdPlaybook(a); break;
    default:
      console.log("ratchet — the loop that only turns one way");
      console.log("fetch|replay|reflect|curate|ab|sweep|dashboard|audit|auth|account|live-buy|halt|resume|playbook");
  }
}

main().catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
