/** Core domain types for the Ratchet loop. */

export type Venue = "agentic-live" | "testnet" | "paper" | "replay";
export type Regime = "trend" | "range" | "volatile" | "unknown";
export type Verdict = "PASS" | "ESCALATE" | "VETO";
export type LuckLabel = "skilled" | "lucky" | "early-not-wrong" | "neutral";

/** A thesis-complete trade proposal. No thesis, no trade. */
export interface TradeIntent {
  id: string;
  symbol: string;
  side: "BUY";
  usdNotional: number;
  qty: number;
  entryRef: number;
  setup: string;
  target: number;
  invalidation: number;
  ruleIds: string[];
  regime: Regime;
  playbookVersion: number;
  venue: Venue;
  createdAt: string;
}

/** A confirmed fill — real or replay. Never fabricated. */
export interface Fill {
  intentId: string;
  venue: Venue;
  price: number;
  qty: number;
  fee: number;
  feeAsset: string;
  ts: string;
  orderId?: string;
}

/** A closed round-trip with excursion stats for the luck-vs-skill split. */
export interface ClosedTrade {
  id: string;
  intent: TradeIntent;
  entry: Fill;
  exit: Fill;
  /** Realized PnL in quote currency, net of fees. */
  pnl: number;
  /** Max favorable/adverse excursion as multiples of planned risk. */
  mfeR: number;
  maeR: number;
  holdingMinutes: number;
  closedAt: string;
  exitReason: "target" | "stop" | "time";
}

/** Deterministic decision-quality grade. Computed, never opined. */
export interface Grade {
  tradeId: string;
  thesisConfirmed: boolean;
  invalidationRespected: boolean;
  luck: LuckLabel;
  /** +1 good decision · 0 neutral · −1 discipline broke or luck reinforced. */
  decisionScore: 1 | 0 | -1;
  note: string;
}

/** A reflection candidate or watch note. */
export interface Lesson {
  text: string;
  section: "SETUPS" | "FILTERS" | "EXITS" | "SIZING" | "MISTAKES" | "WATCH";
  evidence: string[];
  regimes: Regime[];
  /** Bullet this votes on, if any (helpful on +1, harmful on −1). */
  votesOn?: string;
  vote?: "helpful" | "harmful";
}

/** One scored, evidence-backed rule in the playbook. */
export interface PlaybookBullet {
  id: string;
  section: string;
  text: string;
  helpful: number;
  harmful: number;
  regimes: Regime[];
  evidence: string[];
  retired: boolean;
  /** Machine-readable knobs, e.g. { maxDipPct: 8 }. */
  knobs: Record<string, number>;
}

export interface Playbook {
  version: number;
  bullets: PlaybookBullet[];
  createdAt: string;
  parentVersion: number | null;
  curationNote: string;
}

export interface SafetyMandate {
  spotOnly: boolean;
  venuesAllowed: Venue[];
  symbols: string[];
  maxPerTradeUsd: number;
  maxDailyLossUsd: number;
  confirmAboveUsd: number;
  killSwitchPath: string;
}

export interface SafetyResult {
  verdict: Verdict;
  rule: string;
  detail: string;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
