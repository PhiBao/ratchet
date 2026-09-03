# Propose — thesis-required trade intents (Ratchet module 1)

Every trade starts as an **intent**. Intents are cheap; fills are not. The intent is where discipline lives.

## Intent schema (all fields required)

| Field | Meaning |
|---|---|
| `symbol` | e.g. `BTCUSDT`. Must be on the allowlist. |
| `side` | `BUY` (spot only in v0 — no shorts, no leverage) |
| `usdNotional` | size; must satisfy position-sizing rule, not a round number from nowhere |
| `setup` | one sentence: what market structure justifies this *now* |
| `target` | price or condition that confirms the thesis |
| `invalidation` | price or condition that kills the thesis — **this becomes the stop** |
| `ruleIds` | playbook bullets this trade relies on, e.g. `[flt-00003, exe-00001]` |
| `regime` | `trend` / `range` / `volatile` / `unknown` — from current market read |
| `playbookVersion` | pinned automatically from the loaded playbook |

## The three-hat pass (analyst → critic → risk)

1. **Analyst** (favors action): market read → setup, target, regime. Must cite at least one playbook rule.
2. **Critic** (favors inaction): steelman the no-trade case. Checks: is this revenge-sizing after a loss? Is the "setup" just a round number? Would this trade have violated any *retired* bullet? If the critic wins, output is `NO_TRADE` with the reason — a legitimate, first-class outcome.
3. **Risk** (favors survival): position size via volatility targeting (`risk ≈ 1% of equity per invalidation distance`, capped by mandate), never a fixed dollar amount by habit. Verifies invalidation distance is real (beyond noise/ATR, not inside the spread).

Only an intent all three hats sign goes to Safety → Execute.

## Sizing rule (deterministic, not vibes)

```
riskUsd   = min(equity * 0.01, mandate.maxPerTradeUsd)
qty       = riskUsd / |entry - invalidation|
usdNotional = qty * entry   (must clear exchange MIN_NOTIONAL)
```

If `|entry - invalidation|` is so tight the size rounds to dust, or so wide the notional breaches the cap — the setup is untradeable under the mandate. Say so; don't fudge the stop to fit the size.

## NO_TRADE is a real answer

Gated the same way `bstocks`-style screens do: plausibility first ("is this safe to consider"), worthiness second ("is it actually worth doing"). When nothing clears both bars, return `NO_TRADE` with the specific failed check. Never downgrade into a trade just because the user asked.
