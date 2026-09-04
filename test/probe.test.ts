import { describe, it, expect } from "vitest";
import { wideningProbe } from "../src/reflect.js";
import { runReplay } from "../src/venues/replay.js";
import { DEFAULT_KNOBS, type StrategyKnobs } from "../src/strategy.js";
import type { Kline } from "../src/types.js";

/**
 * Synthetic 1h tape: flat, then three V-dips with mechanical bounces.
 * - Dip W bottoms at −6% (inside a tight 5/7 window — the baseline takes it).
 * - Dips A/B bottom at −4.5% (below the tight floor — the baseline never sees
 *   them; a dipPct 5→4 relaxation takes both as winners).
 * Declines are linear so RSI collapses; bounces clear the 2% target with room.
 */
function buildTape(): Kline[] {
  const out: Kline[] = [];
  let price = 100;
  const push = (close: number): void => {
    const open = price;
    price = close;
    out.push({
      openTime: out.length * 3_600_000,
      open,
      high: Math.max(open, close) * 1.0003,
      low: Math.min(open, close) * 0.9997,
      close,
      volume: 100,
    });
  };
  const flat = (n: number, at: number): void => {
    for (let i = 0; i < n; i++) push(at);
  };
  const decline = (n: number, from: number, to: number): void => {
    for (let i = 1; i <= n; i++) push(from + ((to - from) * i) / n);
  };
  const bounce = (n: number, from: number, pct: number): void => {
    for (let i = 1; i <= n; i++) push(from * (1 + (pct / 100) * (i / n)));
  };
  flat(48, 100);
  decline(24, 100, 94.8); // W: −5.2% — both windows take it cleanly
  bounce(4, 94.8, 3.5);
  decline(15, 98.12, 100); // recover
  flat(5, 100);
  decline(24, 100, 95.5); // A: −4.5%
  bounce(4, 95.5, 3.4);
  decline(15, 98.75, 100); // recover
  flat(5, 100);
  decline(24, 100, 95.5); // B: −4.5%
  bounce(4, 95.5, 3.4);
  flat(12, 98.75);
  return out;
}

const TIGHT: StrategyKnobs = { ...DEFAULT_KNOBS, dipPct: 5, maxDipPct: 7 };

describe("wideningProbe", () => {
  it("fires dipPct 5→4 when the floor strands two winners", () => {
    const klines = buildTape();
    const base = runReplay(klines, { symbol: "T", knobs: TIGHT, equity: 1000 });
    expect(base.trades.length).toBe(1); // only W — A/B are invisible to TIGHT
    expect(base.trades[0]?.pnl ?? 0).toBeGreaterThan(0);
    const p = wideningProbe(klines, TIGHT, base.trades, "T");
    expect(p).not.toBeNull();
    expect(p?.deltas.dipPct).toBe(4);
    expect(p?.lesson.section).toBe("SETUPS");
    expect(p?.detail).toContain("1→3 trades");
  });

  it("stays silent when everything is already taken", () => {
    const klines = buildTape();
    const wide = { ...DEFAULT_KNOBS, dipPct: 4 };
    const base = runReplay(klines, { symbol: "T", knobs: wide, equity: 1000 });
    expect(base.trades.length).toBe(3);
    expect(wideningProbe(klines, wide, base.trades, "T")).toBeNull();
  });

  it("stays silent with no baseline or no winners to argue from", () => {
    expect(wideningProbe(buildTape(), TIGHT, [], "T")).toBeNull();
    const klines = buildTape();
    const base = runReplay(klines, { symbol: "T", knobs: TIGHT, equity: 1000 });
    const losers = base.trades.map((t) => ({ ...t, pnl: -Math.abs(t.pnl) - 1 }));
    expect(wideningProbe(klines, TIGHT, losers, "T")).toBeNull();
  });
});
