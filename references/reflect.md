# Reflect — grade the decision, extract the lesson (Ratchet module 3)

Reflection runs after every close and at session end. It answers two questions: **was this a good decision?** and **what should the playbook learn?**

## Step 1 — Grade deterministically (no LLM)

Computed from the journal + market data, never from opinion:

| Grade | Test |
|---|---|
| `thesis_confirmed` | did price reach `target` before `invalidation`? (win on thesis, not just win) |
| `invalidation_respected` | was the exit at/before invalidation, or did the stop migrate? (migrated stop = discipline failure even if the trade later won) |
| `luck_vs_skill` | `win && !thesis_confirmed` → **lucky** (do not reinforce); `loss && thesis_confirmed_later` → **early, not wrong** (timing lesson, not direction lesson). MFE/MAE decide borderline cases: captured <30% of MFE = exit lesson; MAE >2× planned risk = sizing/stop lesson. |
| `decision_score` | +1 thesis confirmed & discipline kept · 0 neutral · −1 discipline broke or lucky win acted on |

A lucky win scores **0 or −1**, never +1. Reinforcing luck is how agents learn superstition.

## Step 2 — Extract lessons (LLM narrates graded facts only)

The model receives the computed grades and proposes lesson bullets. It may not invent numbers — any figure not in the grade packet is rejected and reflection falls back to templates. Each lesson carries: text, `evidence` (trade IDs), `section`, and the regime it held in.

Minimum sample: a pattern needs **≥3 supporting trades or 1 decisive, pre-registered invalidation break** to leave reflection as a candidate. Otherwise it stays a `watch` note, never a bullet.

## Step 3 — Hand to Curate

Reflection outputs candidate lessons + updated helpful/harmful votes for bullets the trades relied on (`ruleIds`). It never edits the playbook itself — curation is a separate, reviewable step.
