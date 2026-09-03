import { describe, it, expect } from "vitest";
import { gradeTrade } from "../src/grade.js";
import type { ClosedTrade } from "../src/types.js";

function mkTrade(over: Partial<ClosedTrade>): ClosedTrade {
  return {
    id: "t001",
    intent: {
      id: "i001", symbol: "BTCUSDT", side: "BUY", usdNotional: 50, qty: 0.001,
      entryRef: 50000, setup: "test", target: 51000, invalidation: 49250,
      ruleIds: ["set-00001"], regime: "range", playbookVersion: 0,
      venue: "replay", createdAt: new Date().toISOString(),
    },
    entry: { intentId: "i001", venue: "replay", price: 50000, qty: 0.001, fee: 0.05, feeAsset: "USDT", ts: new Date().toISOString() },
    exit: { intentId: "i001", venue: "replay", price: 51000, qty: 0.001, fee: 0.05, feeAsset: "USDT", ts: new Date().toISOString() },
    pnl: 0.9, mfeR: 1.5, maeR: 0.2, holdingMinutes: 60, closedAt: new Date().toISOString(),
    exitReason: "target",
    ...over,
  };
}

describe("Grader", () => {
  it("scores a thesis-confirmed win +1 (skilled)", () => {
    const g = gradeTrade(mkTrade({}), 2 / 1.5);
    expect(g.thesisConfirmed).toBe(true);
    expect(g.luck).toBe("skilled");
    expect(g.decisionScore).toBe(1);
  });

  it("scores a lucky win −1 (never reinforce luck)", () => {
    const g = gradeTrade(mkTrade({ pnl: 0.3, mfeR: 0.5, exitReason: "time" }), 2 / 1.5);
    expect(g.luck).toBe("lucky");
    expect(g.decisionScore).toBe(-1);
  });

  it("scores a confirmed-direction loss 0 (early, not wrong)", () => {
    const g = gradeTrade(mkTrade({ pnl: -0.4, mfeR: 1.6, exitReason: "time" }), 2 / 1.5);
    expect(g.luck).toBe("early-not-wrong");
    expect(g.decisionScore).toBe(0);
  });

  it("scores a stopped-out trade 0 with unconfirmed thesis", () => {
    const g = gradeTrade(mkTrade({ pnl: -0.8, mfeR: 0.3, maeR: 1.1, exitReason: "stop" }), 2 / 1.5);
    expect(g.thesisConfirmed).toBe(false);
    expect(g.decisionScore).toBe(0);
  });
});
