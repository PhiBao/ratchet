# Curate — evolve the playbook without breaking it (Ratchet module 4)

Curation turns reflection candidates into a new immutable playbook version. This is the ACE grow-and-refine step: accumulate, deduplicate, prune — never rewrite from scratch (rewriting erodes detail; that's context collapse).

## Bullet format (parsed by code — keep it exact)

```
## SECTION
[flt-00003] helpful=6 harmful=1 (trend, volatile) :: skip dip-buys when 24h drawdown exceeds {maxDipPct}% :: evidence: t042,t051,t057
```

- `id`: `section-#####`, stable across versions. New bullets take the next number; **retired bullets are struck through, never deleted** (history is auditable).
- `helpful/harmful`: counters. A trade relying on this bullet votes `helpful` on decision_score +1, `harmful` on −1. Curator applies reflection's votes, never its own.
- `(regimes)`: where the bullet held. A bullet that only works in `range` must say so — regime-scoped rules are features, not hedges.
- `:: evidence:` trade IDs. A bullet with no evidence after 3 versions gets pruned.
- `{knobs}`: optional machine-readable parameters (e.g. `{maxDipPct}`) that the replay strategy reads. The same bullet guides the live LLM in prose and the replay engine in numbers — one source of truth.

## Sections

`SETUPS` (when to act) · `FILTERS` (when to refuse — the most valuable section) · `EXITS` (how to leave) · `SIZING` (how much) · `MISTAKES` (discipline failures with their cost) · `WATCH` (underpowered observations, never acted on alone)

## Operations (each logged with rationale)

- **add**: from a reflection candidate that cleared minimum sample. Starts `helpful=0 harmful=0`.
- **amend**: tighten/loosen a knob or scope a regime. Old text preserved in the version diff.
- **retire**: `harmful > helpful` after ≥5 votes, or contradicted by newer evidence. Struck through with the retiring version noted.
- **prune**: `WATCH` items older than 3 versions with no new evidence.

A curation that changes nothing writes no new version and says so — churning versions to look busy is theater.
