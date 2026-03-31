# AI Engine — Architecture

## Pipeline Overview

The engine generates a complete `PlanAction[]` in a single synchronous call through a 5-stage pipeline:

```
Board State
    |
[1. EVALUATE]   Snapshot board into a BoardAssessment struct
    |
[2. SCORE]      Rate 5 competing goals (0.0–1.0 urgency each)
    |
[3. ALLOCATE]   Distribute the action budget across goals proportionally
    |
[4. GENERATE]   Per-goal tactic generators produce action sequences
    |
[5. ASSEMBLE]   Merge sequences, validate resources, fill gaps
    |
PlanAction[]
```

Each stage is a pure function. The pipeline is deterministic given the same game state.

---

## Stage 1 — Board Evaluation

A single `assessBoard(sim)` call produces a flat data object summarizing everything the later stages need. Computed once, read many times.

Key fields:
- **Phase info**: current phase, isNight, rounds until next scoring window (dawn/dusk)
- **Unit census**: witch leader ref, minion list, visible hero units, army strength ratio
- **Node state**: per-node controller, witch/hero presence, distance from nearest witch unit
- **Scores**: witchScore, heroScore (accumulated node-score points)
- **Resources**: witch inventory totals, canAffordSummon, best affordable summon type
- **Threat**: hero distance to witch, witch HP ratio, nearby enemy count

---

## Stage 2 — Goal Scoring

Five goals, each scored independently:

| Goal | What it drives | Key urgency factors |
|------|---------------|-------------------|
| KILL_HERO | Hunt and kill the hero leader | Hero visible + close + wounded + night ATK bonus |
| CONTROL_NODES | Capture/hold power nodes for scoring | Scoring imminent + near 3-node sweep + hero score threatening |
| BUILD_ARMY | Summon units | Low army count + resources available |
| GATHER_RESOURCES | Explore tiles for loot | Low resources + unexplored tiles nearby |
| DEFEND_WITCH | Flee or heal to survive | Hero close + witch HP critical |

Phase multipliers shift priorities:
- **Night**: KILL_HERO x1.5 (ATK bonus), GATHER x0.5
- **Day**: KILL_HERO x0.6, GATHER x1.5
- **Dawn/Dusk** (scoring rounds): CONTROL_NODES x1.8

Each goal produces a score between 0.0 and 1.0. Scores above 0.05 qualify for budget allocation.

---

## Stage 3 — Budget Allocation

Given N scored goals and B total action points:

1. Normalize urgency scores to sum to 1.0
2. Multiply each by B, floor the result → raw allocation
3. Distribute remainder (B - sum of floors) to highest-urgency goals
4. Guarantee: every goal with urgency > threshold gets at least 1 AP (steal from lowest if needed)

Example — 6 AP, night, hero visible at distance 2:
```
KILL_HERO:        0.70 urgency → 3 AP  (move, move, battle)
CONTROL_NODES:    0.40 urgency → 2 AP  (move minion A, move minion B)
BUILD_ARMY:       0.15 urgency → 1 AP  (summon)
GATHER_RESOURCES: 0.05 urgency → 0 AP  (below threshold)
DEFEND_WITCH:     0.00 urgency → 0 AP  (witch is healthy)
```

---

## Stage 4 — Tactic Generators

Each goal has a dedicated generator: `_genKillHero(sim, board, budget)`, etc. Generators:

- Receive a shared `PlanSimState` so each sees projected positions from earlier generators
- Produce an ordered `PlanAction[]` consuming up to their allocated budget
- Tag each action with a merge priority (used in Stage 5)
- Only command real entities (skip `sim-*` IDs from in-plan summons)

### Generator summaries

**killHero**: Battle adjacent enemies first (immediate value), then move witch + escort toward hero. Coordinates gang-up by routing multiple units to the hero's hex.

**controlNodes**: Assign closest uncommitted unit to each uncovered node. Generate MOVE sequences. GUARD if already on a node with nearby threats.

**buildArmy**: Check resource ledger, pick best summon type (Iron Golem > Wood Golem > Minion), emit SUMMON. Tracks resource consumption so multiple summons in one plan don't over-spend.

**gatherResources**: EXPLORE current tile if unexplored, or MOVE toward nearest unexplored building then EXPLORE.

**defendWitch**: Flee away from hero if HP critical. Emit USE_ITEM (herbs) if injured — this is free and always worth doing. Interpose minions as shields.

---

## Stage 5 — Plan Assembly

### Merge ordering

Actions from all generators are interleaved by priority:
1. Free actions (USE_ITEM herbs) — always first, cost 0 AP
2. Defensive flee — survival is prerequisite
3. Summons — new units become available for resolution
4. Battles — hit enemies before they can move
5. Node-control moves — strategic positioning
6. Kill-hero moves — offensive advancement
7. Explore/gather — lowest priority filler

### Resource validation

A resource ledger tracks projected witch inventory across the plan. Any SUMMON that would overdraw is removed.

### Anti-oscillation

1. **Unit commitments**: once assigned to a goal+target in Stage 4, a unit stays committed. No mid-plan re-evaluation.
2. **Move history**: track hexes each entity departs during this plan. Reject moves that return to a departed hex.
3. **Cross-turn memory**: store previous-turn positions on the engine instance. Reject moves that return to last turn's position without new cause.
4. **Node-departure cooldown**: preserve existing `_justLeft` tracking from PlanSimState.

### Gap filling (zero-waste guarantee)

After merge, if costed actions < budget:
```
GUARD (if enemies within 2 hexes)
→ EXPLORE (if on unexplored tile)
→ MOVE toward nearest unexplored building
→ MOVE idle minion toward uncovered node
→ GUARD witch unconditionally (last resort)
```

---

## Combat Estimation

Lightweight expected-value model used by killHero and defendWitch to avoid suicidal engagements:

```
expectedAtk = attacker.attack + 3.5 + nightBonus + gangUpDice * 2
expectedDef = defender.defense + 3.5 + fortLevel + allyDice * 2
favorability = expectedAtk - expectedDef
```

Classifications: favorable (> 0), overwhelming (> 3), unfavorable (< 0), suicidal (< -3). Skip suicidal attacks.

---

## Files

| File | Role |
|------|------|
| `src/ai-engine.js` | **New.** Full engine: WitchAIEngine class, all 5 stages, EnginePlanSimState |
| `src/ai.js` | **Modified.** Export PlanSimState (1 word change). Add `engine` to WITCH_PERSONALITIES |
| `tests/ai-engine.test.js` | **New.** Unit tests for each pipeline stage |

No changes to `planner.js`, `game.js`, `resolver.js`, `actions.js`, or `main.js`. The engine is a drop-in personality that produces the same `PlanAction[]` format.

---

## Implementation Phases

### Phase 1 — Foundation
EnginePlanSimState, assessBoard, scoreGoals, allocateBudget. Pure data logic. Write tests.

### Phase 2 — Tactic Generators
The 5 generators. Write tests verifying each produces valid PlanActions for synthetic boards.

### Phase 3 — Plan Assembly
Merge, validate, anti-oscillation, gap-fill. Write tests verifying zero-waste and no oscillation.

### Phase 4 — Integration & Tuning
Wire into WITCH_PERSONALITIES. Run `ai-matrix.js` and `headless.js`. Tune urgency weights.
