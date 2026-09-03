# Safety — the boring part that lets the interesting part exist (Ratchet module 5)

Safety applies to **every** module, every venue, every session. It is enforced in code (`src/safety.ts`), not just policy — this file tells the agent what to expect and what to surface.

## Mandate (defaults; `.env` only tightens)

- **Spot only.** No margin, no futures, no leverage, no withdrawals. Ever in v0.
- **Agentic sub-account only.** Never the main account. Paper/testnet/replay for everything unconfirmed.
- **Max $50 per trade, max $100 daily loss.** A breached daily halt ends the session — no "one more to win it back."
- **Human confirm above $20** (live venue). The agent proposes; the human disposes.
- **Kill switch:** file `data/HALT` present → everything halts, including replay display of live intents. `ratchet halt` creates it; removing it requires typing the reason, which is audit-logged.

## Verdicts

`evaluate(intent)` → `PASS` | `ESCALATE` (needs human confirm) | `VETO` (rule failed — stated plainly, with the rule). A VETO is final for that intent; rephrase-and-retry of a vetoed trade is a discipline violation and gets journaled as one.

## Audit

Every verdict, fill, grade, and curation lands in hash-chained logs (`data/journal.jsonl`, `data/audit.log.jsonl`). `ratchet audit verify` replays the chain — a broken link means tampering or corruption, and the loop stops until it's explained.

## What to tell the user

- State the mandate once per session, briefly. Don't lecture every trade.
- A VETO names the rule and the number. No hedging, no apology paragraph.
- Safety never blocks journaling or reflection — recording what happened is always allowed, even mid-halt. Especially mid-halt.
