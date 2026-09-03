---
name: ratchet
description: Self-improving spot-trading loop on Binance Agent OS. Use for ANY trading request routed through Ratchet: proposing a trade, executing against the Agentic sub-account, or reviewing performance. Every trade carries a machine-checkable thesis citing playbook rule IDs; every closed trade is graded on decision quality (not just PnL); every session ends by reflecting lessons into the versioned playbook. Always load the current playbook first, always consult this skill before calling any Binance Agent OS MCP tool through Ratchet, and never skip the reflect step after a close.
---

# Ratchet — the loop that only turns one way

Ratchet turns an LLM + Binance Agent OS MCP into a trading loop that compounds experience into edge. Five modules; this file is the **router**.

| # | Module | Reference file | Trigger |
|---|--------|----------------|---------|
| 0 | Playbook | `playbook/PLAYBOOK.v{N}.md` (latest) | **Always load first.** The evolved context: scored rules with evidence. Behavior follows the playbook, not vibes. |
| 1 | Propose | `references/propose.md` | user wants to trade ("buy $X of Y", "should I long SOL") |
| 2 | Execute | `references/execute.md` | a thesis-complete intent passed safety — place via Agent OS MCP |
| 3 | Reflect | `references/reflect.md` | a trade closed, or session end — grade the decision, extract lessons |
| 4 | Curate | `references/curate.md` | new lessons exist — merge into a new playbook version |
| 5 | Safety | `references/safety.md` | **applies to every step above** — caps, kill switch, confirm gates, audit |

## The non-negotiable loop

```
LOAD playbook → PROPOSE (thesis + rule IDs) → SAFETY gate → EXECUTE
  → CLOSE → GRADE (decision quality) → REFLECT (lessons) → CURATE (playbook v+1)
```

- **No thesis, no trade.** A proposal without setup, invalidation, and cited rule IDs is incomplete — ask, don't invent.
- **Grade the decision, not the outcome.** A lucky win teaches nothing; a well-reasoned loss teaches a lot. Both get graded.
- **Never skip reflect-after-close.** An unreflected trade is experience thrown away. The loop is the product.
- **Playbook versions are immutable.** Curate writes `PLAYBOOK.v{N+1}.md`, never edits in place. Every journal entry pins the version it ran under, so improvement is attributable.
- **Say nothing without evidence.** Below minimum sample, report *insufficient data* and stop. (Same honesty rule as measurement: a bullet needs ≥3 supporting trades or 1 decisive one to be promoted; counters, not adjectives.)

## Data sharing

- Fetch MCP account/market data once per turn and reuse across modules.
- Journal (`data/journal.jsonl`, hash-chained) is the system of record. Exchange history via MCP is the cross-check — if they disagree, halt and say so.
- `ratchet` CLI mirrors every module for replay and batch runs: `replay`, `reflect`, `curate`, `ab`, `dashboard`, `audit verify`. Prefer the CLI for anything touching more than ~10 trades.
