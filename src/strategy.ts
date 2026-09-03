/**
 * Knob-driven dip-buy strategy. The SAME knobs live as `{knobs}` on playbook
 * bullets: the live LLM reads them as prose, the replay engine reads them as
 * numbers. One source of truth, two consumers.
 */
import type { Kline, Regime } from "./types.js";

export interface StrategyKnobs {
  /** Min 24h drop (%) to consider a dip buy. */
  dipPct: number;
  /** Max 24h drop (%) — beyond this it's a falling knife, not a dip. */
  maxDipPct: number;
  rsiPeriod: number;
  /** RSI must be at or under this to enter. */
  rsiMax: number;
  /** Take-profit distance (%) above entry. */
  takePct: number;
  /** Stop distance (%) below entry (= invalidation). */
  stopPct: number;
  /** Max bars to hold before time exit. */
  maxHoldBars: number;
  /** 24h range (%) above which regime reads volatile. */
  volHiPct: number;
  /** Bars to wait after a close before a new entry. */
  cooldownBars: number;
}

export const DEFAULT_KNOBS: StrategyKnobs = {
  dipPct: 3,
  maxDipPct: 12,
  rsiPeriod: 14,
  rsiMax: 35,
  takePct: 2,
  stopPct: 1.5,
  maxHoldBars: 48,
  volHiPct: 6,
  cooldownBars: 6,
};

export function rsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export interface MarketRead {
  drop24Pct: number;
  rsi: number;
  vol24Pct: number;
  regime: Regime;
}

/** Pure market read at bar index i (uses bars 0..i only — no lookahead). */
export function readMarket(klines: Kline[], i: number, knobs: StrategyKnobs): MarketRead | null {
  if (i < 48) return null;
  const closes = klines.slice(0, i + 1).map((k) => k.close);
  const ref = klines[i - 24]?.close ?? 0;
  const cur = klines[i]?.close ?? 0;
  if (ref <= 0 || cur <= 0) return null;
  const drop24Pct = ((cur - ref) / ref) * 100;
  const window = klines.slice(i - 23, i + 1);
  const hi = Math.max(...window.map((k) => k.high));
  const lo = Math.min(...window.map((k) => k.low));
  const vol24Pct = ((hi - lo) / cur) * 100;
  const fast = sma(closes, 12);
  const slow = sma(closes, 48);
  let regime: Regime = "range";
  if (vol24Pct > knobs.volHiPct) regime = "volatile";
  else if (fast > slow * 1.002) regime = "trend";
  return { drop24Pct, rsi: rsi(closes, knobs.rsiPeriod), vol24Pct, regime };
}

/** Entry signal evaluated on bar i's close; fills at bar i+1's open. */
export function entrySignal(
  klines: Kline[],
  i: number,
  knobs: StrategyKnobs,
): { regime: Regime; setup: string } | null {
  const read = readMarket(klines, i, knobs);
  if (!read) return null;
  const dip = -read.drop24Pct; // positive when price fell
  if (dip < knobs.dipPct || dip > knobs.maxDipPct) return null;
  if (read.rsi > knobs.rsiMax) return null;
  return {
    regime: read.regime,
    setup: `dip-buy: -${dip.toFixed(1)}% over 24h, RSI ${read.rsi.toFixed(0)} (${read.regime})`,
  };
}
