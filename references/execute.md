# Execute — fills without fiction (Ratchet module 2)

Execution takes a thesis-complete intent that passed Safety and turns it into exactly one fill record. No simulation numbers ever mix with real fills: every record carries its `venue` (`agentic-live` | `testnet` | `paper` | `replay`).

## Live paths (two supported ones — custom OAuth clients are rejected by Binance, so there is no third)

**A. Agentic sub-account via a supported host (Claude / Cursor / ChatGPT).**
The host owns the OAuth dance to `https://agent.binance.com/mcp/agentic`; Ratchet owns the loop.
Connect first (`claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic`,
or the equivalent MCP-server entry in Cursor/ChatGPT), then load this skill in that session.

1. Re-read the intent. Re-check the kill switch and daily-loss halt **immediately before** placing — a PASS from ten minutes ago is stale.
2. Place a **market** order for the sized quantity (limit orders with fantasy fills are how backtests lie; live market orders are honest).
3. Read back the fill: executed price, quantity, fee, fee asset. If the broker response is ambiguous, recover by order ID — **never resubmit blindly** (duplicate submission is the classic agent-trading outage).
4. Append the fill to the journal with intent ID, playbook version, venue. Show the user a receipt: what was intended vs what actually filled (slippage is data — it feeds grading).

**B. Runner-driven via the official `binance-cli` (this repo's CLI).**
`ratchet live-buy` runs propose → safety → `spot new-order` against a CLI profile
(testnet first, real matching engine, virtual funds), recovers fills by exact order id,
and journals intent + verdict + fill. Keys never touch Ratchet — they live in the CLI's profile store.

## Paper path

Same flow against `paper` venue: real market data, simulated fills at next-tick price + fee model. Used for human-approved dry runs. Paper fills are clearly labeled and **never** merge into live performance stats.

## Replay path (CLI only)

Historical klines, fills at **next bar open** — never at the signal bar's own close (filling at the price you computed the signal from is phantom edge; this is the most common backtest lie and Ratchet refuses it). Fee model: 0.1% taker default, configurable. Tracks MFE/MAE per trade for the luck-vs-skill split in grading.

## What execution never does

- Never places an order without a journal-pinned intent ID.
- Never "fixes" a rejected order by widening size or loosening the stop.
- Never touches margin, futures, or withdrawals in v0 (spot only — enforced in code, not just policy).
