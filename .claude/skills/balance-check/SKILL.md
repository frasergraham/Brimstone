---
name: balance-check
description: Validate game balance after any change to combat, actions, phase effects, entity stats, AI, or map generation — runs the headless suite, compares against balance targets, and produces a paste-ready summary for the commit message
argument-hint: [quick|full] [--players N]
---

# Balance Validation

Guideline 3 in CLAUDE.md: any change to combat, actions, phase effects, entity
stats, AI goals/weights, or map generation must be validated against the
balance targets before pushing. This skill runs the standard battery,
interprets the numbers, and writes the summary the commit message needs.

## When to run

- Any edit to `src/actions.js`, `src/entities.js` (stats/combat), `src/game.js`
  (phase effects, scoring), `src/unit-types.js`, `src/items.js`,
  `src/loot.config.js`, `src/map.js`, `src/ai.js`, `src/ai-engine.js`,
  `src/hero-ai-engine.js`, or `server/resolver.js`.
- NOT needed for UI, renderer, docs, campaign-mission-content, or server
  plumbing changes.

## The battery

Run all three (this takes several minutes — run them sequentially in one
background Bash call and check on it, don't block):

```bash
node scripts/headless.js 500 standard    # win rates, game length, win reasons
node scripts/combat-sim.js 200           # hit/crush/counter rates per matchup
node scripts/ai-matrix.js 50             # hero × witch personality grid
```

`quick` argument → drop to `headless.js 200`, `combat-sim.js 100`,
`ai-matrix.js 25` for a fast smoke read; say in the summary that it was a
quick pass and the confidence interval is wide (200 games ≈ ±7pp on win rate).

If the change touches NvN scaling or anything gated on `playerCount > 1`, also
run for each affected N:

```bash
node scripts/headless.js 100 standard --players 2   # (and 3, 4 as relevant)
```

## Targets (from CLAUDE.md — the scripts also print them)

| Metric | Target |
|--------|--------|
| Win rate | 38–62% either side |
| Tiebreaks | <10% |
| Kill wins | ≥20% |
| Mean rounds | 15–35 |
| Round cap hits | <5% |

**Current baseline (2026-06-10, Standard 14×14):** Hero ~43% / Witch ~57%,
~22 mean rounds. The witch lean is a known map-size effect (bigger maps →
longer games → more night/summon time). Full baseline tables:
`docs/06-ai-architecture.md` → "Balance Baseline & Tuning Methodology".

## Interpreting deviations

- Compare against the **baseline**, not just the target band. A move from
  43% to 48% hero is a real shift even though both are in-band.
- With 500 games, one win-rate point ≈ 5 games; treat swings under ~4pp as
  noise unless combat-sim corroborates a mechanical change.
- Do NOT tune combat constants to compensate for map-size lean — CLAUDE.md
  says re-centering Standard means shrinking map area, not touching combat.
- If a personality cell in ai-matrix goes degenerate (>80/20), that's a
  regression even when the pooled rate looks fine.

## Output

End with a short **Balance** section suitable for pasting into the commit/PR
message: the three headline numbers (win rate, mean rounds, kill-win %), the
delta vs baseline, and one line explaining any meaningful deviation. If a
tuning pass moved the baseline on purpose, remind the user that
`docs/06-ai-architecture.md`'s baseline section must be updated in the same
commit.
