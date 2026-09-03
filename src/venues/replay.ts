/**
 * Replay executor: historical klines, honest fills. Signals computed on bar
 * t fill at bar t+1's open — filling at the signal bar's own close is phantom
 * edge and Ratchet refuses it. Fee model is explicit. One spot long at a time.
 */
import type { ClosedTrade, Fill, Kline, TradeIntent } from "../types.js";
import { DEFAULT_KNOBS, entrySignal, type StrategyKnobs } from "../strategy.js";

export interface ReplayOpts {
  symbol: string;
  knobs?: Partial<StrategyKnobs>;
  /** Starting equity in quote currency. */
  equity?: number;
  /** Taker fee in basis points (10 = 0.1%). */
  feeBps?: number;
  playbookVersion?: number;
  /** Rule IDs every replay intent cites. */
  ruleIds?: string[];
  /** Cap notional as a fraction of equity. */
  maxNotionalFrac?: number;
}

export interface ReplayResult {
  trades: ClosedTrade[];
  equityCurve: { t: number; equity: number }[];
  finalEquity: number;
}

/** Parses Binance klines CSV/JSON-array rows: openTime,o,h,l,c,volume,... */
export function parseKlines(rows: (string | number)[][]): Kline[] {
  return rows.map((r) => {
    let t = Number(r[0]);
    if (t > 1e14) t = Math.floor(t / 1000); // microsecond timestamps → ms
    return {
      openTime: t,
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5] ?? 0),
    };
  });
}

let tradeSeq = 0;

export function runReplay(klines: Kline[], opts: ReplayOpts): ReplayResult {
  const knobs: StrategyKnobs = { ...DEFAULT_KNOBS, ...opts.knobs };
  const feeRate = (opts.feeBps ?? 10) / 10000;
  const symbol = opts.symbol;
  let equity = opts.equity ?? 1000;
  const maxNotionalFrac = opts.maxNotionalFrac ?? 0.25;
  const trades: ClosedTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];

  interface OpenPos {
    intent: TradeIntent;
    entry: Fill;
    entryBar: number;
    entryTime: number;
    riskPerUnit: number;
    maxHigh: number;
    minLow: number;
    target: number;
    stop: number;
  }
  let open: OpenPos | null = null;
  let cooldownUntil = -1;

  const closePosition = (barIdx: number, reason: ClosedTrade["exitReason"]): void => {
    if (!open) return;
    const bar = klines[barIdx];
    if (!bar) return;
    const price = bar.open; // next-bar-open fill discipline
    const proceeds = price * open.entry.qty;
    const fee = proceeds * feeRate;
    const exit: Fill = {
      intentId: open.intent.id,
      venue: "replay",
      price,
      qty: open.entry.qty,
      fee,
      feeAsset: "USDT",
      ts: new Date(bar.openTime).toISOString(),
    };
    const pnl = proceeds - open.entry.price * open.entry.qty - open.entry.fee - fee;
    equity += pnl;
    const mfeR = (open.maxHigh - open.entry.price) / open.riskPerUnit;
    const maeR = (open.entry.price - open.minLow) / open.riskPerUnit;
    trades.push({
      id: `t${String(tradeSeq++).padStart(3, "0")}`,
      intent: open.intent,
      entry: open.entry,
      exit,
      pnl,
      mfeR,
      maeR,
      holdingMinutes: Math.round((bar.openTime - open.entryTime) / 60000),
      closedAt: exit.ts,
      exitReason: reason,
    });
    open = null;
    cooldownUntil = barIdx + knobs.cooldownBars;
  };

  for (let i = 0; i < klines.length; i++) {
    const bar = klines[i];
    if (!bar) continue;

    if (open) {
      // Track excursion with completed bars only (bar i is fully known at decision time i).
      if (i > open.entryBar) {
        open.maxHigh = Math.max(open.maxHigh, bar.high);
        open.minLow = Math.min(open.minLow, bar.low);
      }
      // Exits trigger on bar i, fill at bar i+1 open. At the last bar, fill at close.
      const lastBar = i === klines.length - 1;
      if (bar.low <= open.stop) {
        if (lastBar) {
          // Settle at close: adjust by overwriting fill below.
          open.maxHigh = Math.max(open.maxHigh, bar.high);
          const price = bar.close;
          const proceeds = price * open.entry.qty;
          const fee = proceeds * feeRate;
          const exit: Fill = {
            intentId: open.intent.id, venue: "replay", price, qty: open.entry.qty,
            fee, feeAsset: "USDT", ts: new Date(bar.openTime).toISOString(),
          };
          const pnl = proceeds - open.entry.price * open.entry.qty - open.entry.fee - fee;
          equity += pnl;
          trades.push({
            id: `t${String(tradeSeq++).padStart(3, "0")}`, intent: open.intent, entry: open.entry,
            exit, pnl,
            mfeR: (open.maxHigh - open.entry.price) / open.riskPerUnit,
            maeR: (open.entry.price - open.minLow) / open.riskPerUnit,
            holdingMinutes: 0, closedAt: exit.ts, exitReason: "stop",
          });
          open = null;
        } else closePosition(i + 1, "stop");
      } else if (bar.high >= open.target) {
        if (lastBar) {
          const price = bar.close;
          const proceeds = price * open.entry.qty;
          const fee = proceeds * feeRate;
          const exit: Fill = {
            intentId: open.intent.id, venue: "replay", price, qty: open.entry.qty,
            fee, feeAsset: "USDT", ts: new Date(bar.openTime).toISOString(),
          };
          const pnl = proceeds - open.entry.price * open.entry.qty - open.entry.fee - fee;
          equity += pnl;
          trades.push({
            id: `t${String(tradeSeq++).padStart(3, "0")}`, intent: open.intent, entry: open.entry,
            exit, pnl,
            mfeR: (open.maxHigh - open.entry.price) / open.riskPerUnit,
            maeR: (open.entry.price - open.minLow) / open.riskPerUnit,
            holdingMinutes: 0, closedAt: exit.ts, exitReason: "target",
          });
          open = null;
        } else closePosition(i + 1, "target");
      } else if (i - open.entryBar >= knobs.maxHoldBars) {
        if (lastBar) {
          const price = bar.close;
          const proceeds = price * open.entry.qty;
          const fee = proceeds * feeRate;
          const exit: Fill = {
            intentId: open.intent.id, venue: "replay", price, qty: open.entry.qty,
            fee, feeAsset: "USDT", ts: new Date(bar.openTime).toISOString(),
          };
          const pnl = proceeds - open.entry.price * open.entry.qty - open.entry.fee - fee;
          equity += pnl;
          trades.push({
            id: `t${String(tradeSeq++).padStart(3, "0")}`, intent: open.intent, entry: open.entry,
            exit, pnl,
            mfeR: (open.maxHigh - open.entry.price) / open.riskPerUnit,
            maeR: (open.entry.price - open.minLow) / open.riskPerUnit,
            holdingMinutes: 0, closedAt: exit.ts, exitReason: "time",
          });
          open = null;
        } else closePosition(i + 1, "time");
      }
      equityCurve.push({ t: bar.openTime, equity });
      continue;
    }

    // Entry: signal on bar i close → intent → fill at bar i+1 open.
    if (i < klines.length - 1 && i >= cooldownUntil) {
      const sig = entrySignal(klines, i, knobs);
      if (sig) {
        const next = klines[i + 1];
        if (!next) continue;
        const entryPrice = next.open;
        const target = entryPrice * (1 + knobs.takePct / 100);
        const stop = entryPrice * (1 - knobs.stopPct / 100);
        const riskPerUnit = entryPrice - stop;
        const riskUsd = equity * 0.01;
        const qty = Math.min(riskUsd / riskPerUnit, (equity * maxNotionalFrac) / entryPrice);
        if (qty > 0 && qty * entryPrice >= 5) {
          const fee = qty * entryPrice * feeRate;
          const intent: TradeIntent = {
            id: `i${String(tradeSeq).padStart(3, "0")}`,
            symbol, side: "BUY",
            usdNotional: qty * entryPrice, qty,
            entryRef: entryPrice, setup: sig.setup,
            target, invalidation: stop,
            ruleIds: opts.ruleIds ?? ["set-00001"],
            regime: sig.regime,
            playbookVersion: opts.playbookVersion ?? 0,
            venue: "replay",
            createdAt: new Date(next.openTime).toISOString(),
          };
          const entry: Fill = {
            intentId: intent.id, venue: "replay", price: entryPrice, qty,
            fee, feeAsset: "USDT", ts: intent.createdAt,
          };
          open = { intent, entry, entryBar: i + 1, entryTime: next.openTime, riskPerUnit, maxHigh: Math.max(entryPrice, next.high), minLow: Math.min(entryPrice, next.low), target, stop };
        }
      }
    }
    equityCurve.push({ t: bar.openTime, equity });
  }

  return { trades, equityCurve, finalEquity: equity };
}
