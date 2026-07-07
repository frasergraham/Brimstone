---
name: faction-matrix
description: Run faction-matchup balance experiments — single-faction 1v1 smokes, mixed-composition NvN runs with per-seat faction lists, and the control-isolation pattern that attributes a win-rate shift to the format, one side's mix, or a single faction
argument-hint: [faction|mixed-3v3] [games]
---

# Faction Matchup Matrix

`balance-check` answers "did my diff move the baseline?". THIS skill answers
"how do factions and compositions actually stack up against each other?" —
via headless matchup experiments. Use it when adding/tuning a faction, when
someone asks "how does X vs Y shake out", or after AI-behavior changes that
alter how a faction plays.

## The tools

`scripts/headless.js` accepts per-side faction picks, and each side's flag
accepts a **comma-separated list assigned per seat** (seat i gets
`list[i % list.length]`):

```bash
node scripts/headless.js 300 standard --day=captain                 # 1v1: captain vs default witch
node scripts/headless.js 300 standard --night=necromancer           # 1v1: paladin vs necromancer
node scripts/headless.js 300 standard --players 3 \
  --day=hero,rogue,captain --night=witch,necromancer,brute          # mixed 3v3, one of each
```

Valid ids — day: `hero` (paladin), `rogue`, `captain`; night: `witch`,
`necromancer`, `brute` (`getFactionsForSide` in `src/factions.js` is the
source of truth). Mixed runs (>2 distinct factions on the board) append a
**"Leader fates by faction"** table after the report — per-faction leader
survival across all games. That table is where composition stories hide:
who gets fed to the score race, who turtles.

## The control-isolation pattern

A mixed-comp win rate alone is uninterpretable — NvN format lean and faction
effects are confounded. Always run the 2×2:

```bash
node scripts/headless.js 300 standard --players 3                          # A: pure control (format lean)
node scripts/headless.js 300 standard --players 3 --day=<mix>              # B: day mix only
node scripts/headless.js 300 standard --players 3 --night=<mix>            # C: night mix only
node scripts/headless.js 300 standard --players 3 --day=<mix> --night=<mix># D: full mix
```

Then: **day-mix effect ≈ B−A, night-mix effect ≈ C−A**, and the effects have
been near-additive in practice (D ≈ A + (B−A) + (C−A) within noise). Run all
four in ONE background Bash call (each 300-game 3v3 run takes ~25s; grep the
output for `Hero  |Witch |fates|imbalanced|healthy`).

## Sample size

300 games ≈ ±5.5pp at 95%; 200 ≈ ±7pp; 500 ≈ ±4.3pp; 1000 ≈ ±3pp. Treat any
comparison smaller than the pooled CI as noise — a 200-game "neutrality
check" CANNOT distinguish 50% from 57%; prove neutrality by code audit and
use aggregates only as a tripwire. For a number that gets written into
docs/06 as a baseline, use ≥1000 games.

## Interpreting

- **1v1 and NvN lean in OPPOSITE directions.** 1v1 Standard leans witch
  (~57%); 3v3 leans day (~55% pure control). Never compare a mixed-3v3
  number against the 1v1 band edges without the format control.
- Targets (band 38–62%, kill wins ≥20%, tiebreaks <10%, cap hits <5%) are
  defined for 1v1 — in NvN treat them as advisory and lean on the control
  delta instead.
- Check the **win-reason mix**, not just the rate: day sides tend to win
  almost exclusively on the 4-point node race; night kill-wins collapsing is
  an early sign a comp can't threaten leaders.
- **AI capability gaps bias everything.** A faction whose AI doesn't use its
  signature abilities under-measures. Check docs/06's generator list before
  attributing a gap to the faction itself.

## Reference numbers (2026-07-06, post faction-AI work, dev @ 2cc3aec4)

1v1 Standard, 300 games: necromancer 57% witch-side; captain 59% hero-side
(58.8% at n=1000); brute ~51%; default 55.3%-day pure-3v3 control.

Mixed 3v3 (hero+rogue+captain vs witch+necromancer+brute), 300 games each:
**full mix 75.3% day** — control A 55.3%, day-mix B 72.3% (+17pp!), night-mix
C 62.0% (night mix is ~7pp WORSE for night than three witches). Leader fates:
brute 98%/necromancer 91% survive but don't convert; captain survives 78%
while anchoring the day engine. In-band 1v1 factions compose into an
out-of-band team format — mixed 3v3 has a KNOWN day-side imbalance; treat it
as a format-level tuning problem (node-score pacing / comp rules), not a
reason to nerf a 1v1-balanced faction.

## Output

Report: the 2×2 table with deltas, the leader-fates table for the full mix,
win-reason mix, and an explicit noise statement (n and CI). If a number
disagrees with the reference block above by more than the pooled CI, say so
and update this file's reference block in the same commit.
