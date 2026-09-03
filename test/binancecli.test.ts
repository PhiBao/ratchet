import { describe, it, expect } from "vitest";
import { fillFromOrder, parseJsonLoose } from "../src/venues/binancecli.js";
import type { TradeIntent } from "../src/types.js";

function intent(): TradeIntent {
  return {
    id: "live-1", symbol: "BTCUSDT", side: "BUY", usdNotional: 10, qty: 0,
    entryRef: 77000, setup: "test", target: 78540, invalidation: 75845,
    ruleIds: ["set-00001"], regime: "unknown", playbookVersion: 0,
    venue: "testnet", createdAt: new Date().toISOString(),
  };
}

describe("binance-cli venue", () => {
  it("averages fills into one honest fill record", () => {
    const f = fillFromOrder(intent(), "testnet", {
      symbol: "BTCUSDT",
      orderId: 123,
      transactTime: 1,
      fills: [
        { price: "77000.00", qty: "0.00006", commission: "0.00000462", commissionAsset: "BTC" },
        { price: "77010.00", qty: "0.00007", commission: "0.00000539", commissionAsset: "BTC" },
      ],
    }, "2026-09-03T00:00:00.000Z");
    expect(f.qty).toBeCloseTo(0.00013, 8);
    expect(f.price).toBeCloseTo((77000 * 0.00006 + 77010 * 0.00007) / 0.00013, 6);
    expect(f.orderId).toBe("123");
  });

  it("refuses to invent fills from an empty fill list", () => {
    expect(() => fillFromOrder(intent(), "testnet", {
      symbol: "BTCUSDT", orderId: 1, transactTime: 1, fills: [], status: "EXPIRED",
    }, "2026-09-03T00:00:00.000Z")).toThrow(/no fills/);
  });

  it("parses strict JSON and carves JSON out of prose", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('note here\n[{"a":1}]\ntrailer')).toEqual([{ a: 1 }]);
  });
});
