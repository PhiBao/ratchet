/**
 * Safety mandate enforcement. Deterministic, fail-closed: any missing input
 * or breached rule vetoes. Rephrase-and-retry of a veto is journaled.
 */
import { existsSync } from "node:fs";
import type { SafetyMandate, SafetyResult, TradeIntent } from "./types.js";

export function defaultMandate(): SafetyMandate {
  return {
    spotOnly: true,
    venuesAllowed: ["paper", "replay", "testnet", "agentic-live"],
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"],
    maxPerTradeUsd: Number(process.env["RATCHET_MAX_PER_TRADE_USD"] ?? 50),
    maxDailyLossUsd: Number(process.env["RATCHET_MAX_DAILY_LOSS_USD"] ?? 100),
    confirmAboveUsd: Number(process.env["RATCHET_CONFIRM_ABOVE_USD"] ?? 20),
    killSwitchPath: process.env["RATCHET_KILL_SWITCH"] ?? "data/HALT",
  };
}

export interface GateContext {
  mandate: SafetyMandate;
  /** Realized day PnL in USD for the venue (negative = loss). */
  dayPnlUsd: number;
  halted: boolean;
}

export function halted(mandate: SafetyMandate): boolean {
  return existsSync(mandate.killSwitchPath);
}

export function evaluate(intent: TradeIntent, ctx: GateContext): SafetyResult {
  const m = ctx.mandate;
  if (ctx.halted || halted(m)) {
    return { verdict: "VETO", rule: "kill-switch", detail: "HALT file present — all trading stopped." };
  }
  if (m.spotOnly && intent.side !== "BUY") {
    return { verdict: "VETO", rule: "spot-only", detail: `Side ${intent.side} rejected: spot BUY only in v0.` };
  }
  if (!m.venuesAllowed.includes(intent.venue)) {
    return { verdict: "VETO", rule: "venue", detail: `Venue ${intent.venue} not in allowlist.` };
  }
  if (!m.symbols.includes(intent.symbol)) {
    return { verdict: "VETO", rule: "allowlist", detail: `Symbol ${intent.symbol} not allowlisted.` };
  }
  if (!(intent.usdNotional > 0)) {
    return { verdict: "VETO", rule: "size-positive", detail: "Notional must be positive." };
  }
  if (intent.usdNotional > m.maxPerTradeUsd) {
    return {
      verdict: "VETO",
      rule: "per-trade-cap",
      detail: `$${intent.usdNotional} exceeds per-trade cap $${m.maxPerTradeUsd}.`,
    };
  }
  if (intent.ruleIds.length === 0) {
    return { verdict: "VETO", rule: "thesis-required", detail: "No playbook rule IDs cited — no thesis, no trade." };
  }
  if (!(intent.invalidation > 0) || !(intent.target > 0)) {
    return { verdict: "VETO", rule: "invalidation-required", detail: "Target and invalidation must be positive prices." };
  }
  if (intent.invalidation >= intent.entryRef) {
    return { verdict: "VETO", rule: "stop-below-entry", detail: "Invalidation must sit below entry for a spot BUY." };
  }
  if (ctx.dayPnlUsd <= -m.maxDailyLossUsd) {
    return {
      verdict: "VETO",
      rule: "daily-halt",
      detail: `Day PnL $${ctx.dayPnlUsd.toFixed(2)} breached daily halt $${m.maxDailyLossUsd}. Session over.`,
    };
  }
  if (intent.venue === "agentic-live" && intent.usdNotional > m.confirmAboveUsd) {
    return {
      verdict: "ESCALATE",
      rule: "human-confirm",
      detail: `Live order $${intent.usdNotional} exceeds confirm threshold $${m.confirmAboveUsd} — human must approve.`,
    };
  }
  return { verdict: "PASS", rule: "all-checks", detail: "Mandate satisfied." };
}
