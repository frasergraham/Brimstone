# AI Engine — High-Level Goals

## Why Replace the Current AI

The existing AI (`src/ai.js`) uses a greedy priority-list: each action is chosen independently by scanning a hardcoded priority waterfall. This produces three recurring problems:

1. **Wasted actions** — when no priority matches, `_decidePlanAction` returns `null` and the remaining action budget is lost.
2. **Oscillation** — units move toward a target, then next turn re-evaluate and move back. No commitment tracking across steps or turns.
3. **No goal balancing** — a 6-action budget can't be split across "capture a node" AND "build an army". Whichever priority fires first consumes everything.

## Design Principles

- **Zero waste.** Every action point must produce something. If no strategic action exists, fall back to GUARD / EXPLORE / positional movement. Never return null.
- **Budget-first thinking.** The fixed per-turn action budget is the central constraint. Allocate it across goals proportionally, don't let one goal starve the others.
- **Multi-step coherence.** Actions within a goal form sequences (move-move-attack), not isolated greedy picks. A 3-action "approach and strike" is planned as a unit.
- **Decoupled from old AI.** New file (`src/ai-engine.js`), new class. The old `WitchAI` and all hero personalities remain untouched. The engine registers as a new personality and can be compared head-to-head.
- **Testable in isolation.** Each stage of the pipeline (evaluate, score, allocate, generate, merge) is a pure function that can be unit-tested with synthetic board states.

## Success Criteria

- Engine witch never idles (0 wasted actions in any observed game).
- Engine witch doesn't oscillate (no unit revisits a hex it left in the same turn, or ping-pongs the same two hexes across turns without cause).
- Engine witch balances node control, army building, and combat — doesn't tunnel-vision on one goal.
- Engine witch win rate against all hero personalities is competitive with or better than the existing balanced witch, validated via `scripts/ai-matrix.js`.
- No regressions: existing tests pass, headless simulations complete without errors.
