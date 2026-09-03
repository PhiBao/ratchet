/**
 * Deterministic decision-quality graders. Computed from fills and excursion —
 * never from opinion. A lucky win scores 0 or −1: reinforcing luck teaches
 * superstition.
 */
import type { ClosedTrade, Grade } from "./types.js";

export function gradeTrade(trade: ClosedTrade, takeR: number): Grade {
  const win = trade.pnl > 0;
  // Thesis confirmed if price ever reached the full target distance (takeR multiples of risk).
  const thesisConfirmed = trade.mfeR >= takeR * 0.999;
  // Replay always respects the stop by construction; the live path detects
  // migration by comparing journaled invalidation vs actual exit. Assume kept
  // unless the exit printed far beyond the stop (gap/slippage flag, not a verdict).
  const invalidationRespected = true;

  let luck: Grade["luck"] = "neutral";
  if (win && thesisConfirmed) luck = "skilled";
  else if (win && !thesisConfirmed) luck = "lucky";
  else if (!win && thesisConfirmed) luck = "early-not-wrong";

  let decisionScore: Grade["decisionScore"] = 0;
  let note = "";
  if (!invalidationRespected) {
    decisionScore = -1;
    note = "stop migrated — discipline failure regardless of outcome";
  } else if (luck === "skilled") {
    decisionScore = 1;
    note = `thesis confirmed (MFE ${trade.mfeR.toFixed(2)}R), discipline kept`;
  } else if (luck === "lucky") {
    decisionScore = -1;
    note = `win without thesis confirmation (MFE ${trade.mfeR.toFixed(2)}R < ${takeR}R) — do not reinforce`;
  } else if (luck === "early-not-wrong") {
    decisionScore = 0;
    note = `direction right, timing/exit wrong (MFE ${trade.mfeR.toFixed(2)}R, closed ${trade.exitReason})`;
  } else {
    note = `thesis unconfirmed, closed ${trade.exitReason} at ${trade.mfeR.toFixed(2)}R MFE / ${trade.maeR.toFixed(2)}R MAE`;
  }
  return { tradeId: trade.id, thesisConfirmed, invalidationRespected, luck, decisionScore, note };
}

export interface GradeSummary {
  n: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  skilledWins: number;
  luckyWins: number;
  avgScore: number;
}

export function summarizeGrades(trades: ClosedTrade[], grades: Grade[]): GradeSummary {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const skilledWins = grades.filter((g) => g.luck === "skilled").length;
  const luckyWins = grades.filter((g) => g.luck === "lucky").length;
  const avgScore = grades.length ? grades.reduce((a, g) => a + g.decisionScore, 0) / grades.length : 0;
  return { n, wins, winRate: n ? wins / n : 0, totalPnl, skilledWins, luckyWins, avgScore };
}
