import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { defaultMandate, evaluate } from "../src/safety.js";
import type { TradeIntent } from "../src/types.js";

const KILL = "/tmp/ratchet-test-HALT";

function mkIntent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: "i1", symbol: "BTCUSDT", side: "BUY", usdNotional: 40, qty: 0.001,
    entryRef: 50000, setup: "dip", target: 51000, invalidation: 49250,
    ruleIds: ["set-00001"], regime: "range", playbookVersion: 0,
    venue: "paper", createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("Safety", () => {
  beforeEach(() => {
    process.env["RATCHET_KILL_SWITCH"] = KILL;
    if (existsSync(KILL)) unlinkSync(KILL);
  });
  afterEach(() => {
    if (existsSync(KILL)) unlinkSync(KILL);
    delete process.env["RATCHET_KILL_SWITCH"];
  });

  it("passes a sane paper intent", () => {
    const r = evaluate(mkIntent(), { mandate: defaultMandate(), dayPnlUsd: 0, halted: false });
    expect(r.verdict).toBe("PASS");
  });

  it("vetoes oversize trades", () => {
    const r = evaluate(mkIntent({ usdNotional: 500 }), { mandate: defaultMandate(), dayPnlUsd: 0, halted: false });
    expect(r.verdict).toBe("VETO");
    expect(r.rule).toBe("per-trade-cap");
  });

  it("vetoes thesiless intents", () => {
    const r = evaluate(mkIntent({ ruleIds: [] }), { mandate: defaultMandate(), dayPnlUsd: 0, halted: false });
    expect(r.verdict).toBe("VETO");
    expect(r.rule).toBe("thesis-required");
  });

  it("vetoes off-allowlist symbols", () => {
    const r = evaluate(mkIntent({ symbol: "DOGEUSDT" }), { mandate: defaultMandate(), dayPnlUsd: 0, halted: false });
    expect(r.verdict).toBe("VETO");
  });

  it("vetoes when the kill switch is present", () => {
    writeFileSync(KILL, "test halt");
    const r = evaluate(mkIntent(), { mandate: defaultMandate(), dayPnlUsd: 0, halted: false });
    expect(r.verdict).toBe("VETO");
    expect(r.rule).toBe("kill-switch");
  });

  it("vetoes past the daily loss halt", () => {
    const r = evaluate(mkIntent(), { mandate: defaultMandate(), dayPnlUsd: -100, halted: false });
    expect(r.verdict).toBe("VETO");
    expect(r.rule).toBe("daily-halt");
  });

  it("escalates large live orders for human confirm", () => {
    const r = evaluate(mkIntent({ venue: "agentic-live", usdNotional: 30 }), {
      mandate: defaultMandate(), dayPnlUsd: 0, halted: false,
    });
    expect(r.verdict).toBe("ESCALATE");
  });
});
