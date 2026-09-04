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

# 0. Data: 4 sample windows ship in data/ (BTC/ETH/SOL/BNB 1h, May–Jul 2026,
#    2208 bars each, public Binance klines). Regenerate or extend any of them:
tsx src/index.ts fetch --symbol SOLUSDT --interval 1h --start 2026-05-01 --end 2026-08-01 --out data/solusdt-1h.csv

# 1. Cold-start: replay 3 months of ETH 1h klines through playbook v0
tsx src/index.ts replay --csv data/ethusdt-1h.csv --symbol ETHUSDT --equity 1000

# 2. Reflect: grade every close, propose lessons (+knob deltas)
tsx src/index.ts reflect --llm false        # deterministic templates; drop flag for LLM

# 3. Curate: merge into playbook v1 (dry run first, then --apply)
tsx src/index.ts curate --apply --note "first evolution"

# 4. Prove it: walk-forward frozen-v0 vs evolved on held-out data
tsx src/index.ts ab --csv data/ethusdt-1h.csv --symbol ETHUSDT --train-frac 0.5 --base 0 --llm false

# 5. Full evidence table: 4 assets × 4 folds, deterministic, with significance
tsx src/index.ts sweep --base 0

# 6. Report + verify
tsx src/index.ts dashboard && tsx src/index.ts audit verify
```

Klines CSV: Binance `openTime,open,high,low,close,volume,...`, committed in `data/` and regenerable via `ratchet fetch` (public market data, no auth).

## Measured walk-forward (4 assets × 4 folds, May–Jul 2026 1h)

Train on the first fraction → reflect → curate → test frozen-v0 vs evolved on the held-out remainder (`sweep --base 0`). No peeking by construction — test bars never enter reflection. Every cell prints its Fisher exact p (win-rate significance) and an activity verdict (`ok` / `thin` / `degenerate` / `empty`), computed from the same counts as the table:

```
btcusdt-1h.csv f=0.5   9×+19.3  →  9×+19.3   Δ  +0.0  p=1.00 ok
ethusdt-1h.csv f=0.5  12×−8.9   → 11×+17.0   Δ +25.9  p=0.40 ok
solusdt-1h.csv f=0.5  15×−11.9  → 12×−5.4    Δ  +6.4  p=1.00 ok
bnbusdt-1h.csv f=0.5   6×+3.8   →  5×−0.7    Δ  −4.5  p=1.00 ok
```

Full table (`sweep --base 0`): 16 cells, 14 `ok`, median Δ **0.0**, mean Δ **+2.9**, 5 positive. Best p is 0.25 — **no cell reaches significance**, and we report that plainly: at ~5–15 trades per window, the honest statement is "consistent directional improvement on ETH, no statistical claim."

What the distribution actually says:

| Asset | Pattern | Reading |
|---|---|---|
| ETH | evolved beats frozen all 4 folds (+6 to +28) | the loop helps where the baseline bleeds |
| BTC | Δ 0.0 all folds (train was profitable) | nothing to learn, correctly learns nothing |
| SOL | 3 of 4 folds negative | train lessons overfit across a regime shift — the failure mode is visible, not hidden |
| BNB | 1–7 trades per window | too thin to evaluate; the harness says `thin`, not `ok` |

Entry-by-entry on the ETH showcase cell: evolution refused the entries that became the −$7.53 and −$7.37 stopped-out losers, and widened stops converted chop-exits into targets. Reproduce it: step 4 above prints the same numbers from any checkout.

Limits we do not hand-wave away: single strategy family (dip-buy), one 92-day window, n ≈ 10 per cell. The roadmap items below (regime-specific knobs, multi-symbol portfolios) are now evidence-backed next steps, not aspirations — the SOL cells show exactly why one global knob set is insufficient.

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
- `src/` — types, hash-chained journal, versioned playbook store, safety gates, replay executor, knob strategy, deterministic graders, LLM reflector w/ template fallback, widening probe (two-way ratchet), curator with coherence guards, klines fetcher, Fisher/activity stats, raw MCP client, CLI (`ab` + `sweep` share one `runAbCell`)
- `playbook/PLAYBOOK.v0.md` — genesis seed: conservative dip-buy priors, each knob a hypothesis
- `test/` — 10 suites, 45 tests; `pnpm test`
- `dashboard/report.html` — generated, self-contained, no dependencies

## Roadmap (post-hackathon)

Live executor against enumerated MCP tools · futures-aware trade models · regime-specific knob sets · multi-symbol portfolios · scheduled reflect via the Agent OS scheduler skill.

## Disclosures

Built Sept 2026 for the hackathon. Spot only, educational sizing, paper-first. Not financial advice — a framework for compounding *decisions*, not a promise of returns.
