# Ratchet — the trading agent that gets better every trade

**Binance Agent OS Mini Hackathon, Track A.** A self-improving spot-trading loop: every trade carries a machine-checkable thesis, every close is graded on *decision quality* (not just PnL), and every session curates lessons into a versioned playbook — so the next session behaves differently. Improvement is measured, not claimed: a walk-forward A/B harness pits the frozen v0 playbook against the evolved one on held-out data.

```
LOAD playbook → PROPOSE (thesis + rule IDs) → SAFETY gate → EXECUTE (Agent OS MCP)
  → CLOSE → GRADE (skill vs luck) → REFLECT (lessons) → CURATE (playbook v+1)
```

## Why this exists

Existing agent-trading work clusters in two places: **risk gates** (veto bad trades) and **retrospective analytics** (journal what happened). Both look backward or sideways. Nobody compounds experience *forward* into better future decisions — and fresh Agentic sub-accounts start with zero history, so backward-looking tools have nothing to read. Ratchet's answers:

1. **Forward improvement.** The playbook is evolving context (ACE pattern): scored bullets with helpful/harmful counters and trade-ID evidence. Behavior follows the playbook.
2. **Cold-start replay.** Months of experience over public klines before trade #1 — the playbook is already v3 on day one. Replay and live share one code path and one journal.
3. **Proof.** `ratchet ab` trains on window A, curates, then reports frozen-vs-evolved on held-out window B. No peeking, no phantom edge.

## Quickstart

```bash
pnpm install
cp .env.example .env   # no exchange keys needed — Agent OS uses OAuth

# 1. Cold-start: replay 6 months of BTC 1h klines through playbook v0
tsx src/index.ts replay --csv data/btcusdt-1h.csv --symbol BTCUSDT --equity 1000

# 2. Reflect: grade every close, propose lessons (+knob deltas)
tsx src/index.ts reflect --llm false        # deterministic templates; drop flag for LLM

# 3. Curate: merge into playbook v1 (dry run first, then --apply)
tsx src/index.ts curate --apply --note "first evolution"

# 4. Prove it: walk-forward frozen-v0 vs evolved on held-out data
tsx src/index.ts ab --csv data/btcusdt-1h.csv --train-frac 0.6

# 5. Report + verify
tsx src/index.ts dashboard && tsx src/index.ts audit verify
```

Klines CSV: Binance `openTime,open,high,low,close,volume,...` (grab from data.binance.vision — public, no auth).

## Measured walk-forward (ETH 1h, May–Jul 2026)

Train on the first half → reflect → curate → test frozen-v0 vs evolved on the held-out half (`ab --csv data/ethusdt-1h.csv --train-frac 0.5 --base 0`). No peeking by construction — the test bars never enter reflection:

| | trades | win rate | PnL | skilled |
|---|---|---|---|---|
| frozen v0 | 12 | 50.0% | −$8.9 | 6 |
| evolved | 11 | 72.7% | +$17.0 | 8 |

Entry-by-entry, evolution refused 3 dip-buys — two stopped-out losers (−$7.53, −$7.37) — and widened stops converted chop-exits into targets. Reproduce it: the command above prints the same table from any checkout (klines: `data.binance.vision`, public).

## Live trading (two supported paths)

Binance rejects custom OAuth clients (`3346001 agent not supported`), so Ratchet uses only sanctioned paths:

```bash
ratchet auth setup     # prints both paths below
```

**A. Runner (this CLI) via official `binance-cli`** — install once, trade testnet in minutes:
```bash
# 1. https://testnet.binance.vision (GitHub login) → create API key/secret
binance-cli profile create --name ratchet-testnet --api-key <k> --api-secret <s> --env testnet
ratchet account --profile ratchet-testnet
ratchet live-buy --symbol BTCUSDT --usd 10 --profile ratchet-testnet
```

**B. Agentic sub-account via a supported host** — the host owns OAuth, Ratchet owns the loop:
```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
# then load SKILL.md in that session
```
> Verified Sep 2026: Binance allowlists agent OAuth clients. Custom clients are rejected
> (`3346001 agent not supported`) via self-registered OAuth, via MCP-host DCR (e.g. opencode),
> and via published CIMD metadata alike. Only approved hosts (Claude/Cursor/ChatGPT) can OAuth
> to the Agentic MCP. Path A above is the way custom runners trade live.

Constraints inherited from Agent OS: OAuth is `authorization_code` with **no refresh token**, so Ratchet trades in human-gated sessions, never as an unattended daemon. Spot only, Agentic sub-account only, $50/trade, $100 daily halt, human confirm above $20, file kill-switch (`halt`/`resume --reason`), hash-chained audit log.

## Honest fills

Replay fills at **next-bar open** — never the signal bar's close. Signals computed on bar *t* cannot see bar *t+1*. Fees are explicit (default 10 bps taker). Every record carries its venue; replay numbers never mix with live stats. A lucky win grades **−1**: reinforcing luck teaches superstition.

## Repo map

- `SKILL.md` + `references/` — the agent-facing loop (propose/execute/reflect/curate/safety)
- `src/` — types, hash-chained journal, versioned playbook store, safety gates, replay executor, knob strategy, deterministic graders, LLM reflector w/ template fallback, curator, raw MCP client, CLI
- `playbook/PLAYBOOK.v0.md` — genesis seed: conservative dip-buy priors, each knob a hypothesis
- `test/` — 6 suites; `pnpm test`
- `dashboard/report.html` — generated, self-contained, no dependencies

## Roadmap (post-hackathon)

Live executor against enumerated MCP tools · futures-aware trade models · regime-specific knob sets · multi-symbol portfolios · scheduled reflect via the Agent OS scheduler skill.

## Disclosures

Built Sept 2026 for the hackathon. Spot only, educational sizing, paper-first. Not financial advice — a framework for compounding *decisions*, not a promise of returns.
