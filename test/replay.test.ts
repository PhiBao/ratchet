import { describe, it, expect } from "vitest";
import { parseKlines, runReplay } from "../src/venues/replay.js";
import type { Kline } from "../src/types.js";

/** Flat market with a steady decline then recovery (hourly bars). */
function synthBars(): Kline[] {
  const bars: Kline[] = [];
  let price = 100;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 200; i++) {
    const drift = i < 60 ? 0 : i < 110 ? -0.004 : 0.004;
    const open = price;
    price = price * (1 + drift);
    bars.push({
      openTime: t0 + i * 3600000,
      open,
      high: Math.max(open, price) * 1.001,
      low: Math.min(open, price) * 0.999,
      close: price,
      volume: 1000,
    });
  }
  return bars;
}

function flatBars(n = 100): Kline[] {
  const bars: Kline[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    bars.push({ openTime: t0 + i * 3600000, open: 100, high: 100.1, low: 99.9, close: 100, volume: 100 });
  }
  return bars;
}

describe("Replay", () => {
  it("trades a trending decline and fills at next-bar open (no lookahead)", () => {
    const klines = synthBars();
    const { trades } = runReplay(klines, { symbol: "BTCUSDT", equity: 1000 });
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      const idx = klines.findIndex((k) => k.openTime === Date.parse(t.entry.ts));
      expect(idx).toBeGreaterThan(0);
      expect(t.entry.price).toBe(klines[idx]?.open); // next-bar-open discipline
    }
  });

  it("accounts fees exactly in pnl", () => {
    const klines = synthBars();
    const { trades } = runReplay(klines, { symbol: "BTCUSDT", equity: 1000, feeBps: 10 });
    const t = trades[0];
    if (!t) throw new Error("expected at least one trade");
    const expected = (t.exit.price - t.entry.price) * t.entry.qty - t.entry.fee - t.exit.fee;
    expect(Math.abs(t.pnl - expected)).toBeLessThan(1e-9);
  });

  it("equity conservation: final = start + sum(pnl)", () => {
    const klines = synthBars();
    const { trades, finalEquity } = runReplay(klines, { symbol: "BTCUSDT", equity: 1000 });
    const sum = trades.reduce((a, t) => a + t.pnl, 0);
    expect(Math.abs(finalEquity - (1000 + sum))).toBeLessThan(1e-6);
  });

  it("flat market produces no trades", () => {
    const { trades } = runReplay(flatBars(), { symbol: "BTCUSDT", equity: 1000 });
    expect(trades.length).toBe(0);
  });

  it("parseKlines reads Binance row format", () => {
    const ks = parseKlines([[1767225600000, "100", "101", "99", "100.5", "10", 1, 2, 3, 4, 5, 6]]);
    expect(ks[0]?.close).toBe(100.5);
    expect(ks[0]?.openTime).toBe(1767225600000);
  });
});
