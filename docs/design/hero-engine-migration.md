# Hero AI Engine Migration

Port the Hero AI from the old greedy priority-list model to the same 5-stage pipeline used by the witch AI engine.

## What We Built for the Witch (Reference)

The witch engine (`src/ai-engine.js`) replaced 4 hand-coded classes (WitchAI, WitchBerserker, WitchHoarder, WitchSwarm — ~890 lines) with a single configurable engine (~900 lines) where personalities are just weight presets.

### Pipeline

```
EVALUATE  →  SCORE  →  ALLOCATE  →  GENERATE  →  ASSEMBLE
(board)     (goals)   (budget)    (tactics)    (final plan)
```

1. **EVALUATE** — `assessBoard(sim)` reads the simulation state into a flat `BoardAssessment` object: unit census, distances, node state, inventory, phase info. Pure function, no side effects.

2. **SCORE** — `scoreGoals(board, goalWeights)` computes 0.0–1.0 urgency for each of 5 goals. Phase multipliers shift priorities (night boosts combat, day boosts gathering). `goalWeights` from the personality config scale each score post-computation.

3. **ALLOCATE** — `allocateBudget(scores, totalBudget)` distributes AP across qualifying goals proportionally. Floor allocation + remainder to highest-urgency. Guarantees every qualifying goal gets ≥1 AP.

4. **GENERATE** — Five generator functions, each receives `(sim, board, budget, config?)` and emits `PlanAction[]` with `_priority` and `_goal` metadata. Generators mutate the simulation state (positions, commitments, resource ledger) so later generators see the projected world.

5. **ASSEMBLE** — `assemblePlan(allActions, sim, board, prevPositions)` merges all generator outputs: priority sort → anti-oscillation filter → deduplication → budget enforcement → gap-fill → strip metadata → truncate to MAX_PLAN_LENGTH.

### Personality Config Shape

```js
{
  goalWeights: { KILL_HERO: 1.8, CONTROL_NODES: 0.6, ... },
  fleeThreshold: 0.15,     // HP ratio below which to flee
  engageFloor: 'suicidal', // minimum combat classification to attack
}
```

Three presets (`balanced`, `aggressive`, `swarm`) produce clearly distinct playstyles from the same code.

### Key Supporting Infrastructure

- `EnginePlanSimState` extends `PlanSimState` with `departedHexes` (intra-plan anti-oscillation), `unitCommitments` (goal-locking), and `resourceLedger` (projected spend tracking).
- `estimateCombat(attacker, defender, board)` — expected-value model returning `{ favorability, classification }`.
- Cross-turn memory via `_prevPositions` Map on the engine instance.
- Self-registration pattern to break circular imports: `ai-engine.js` imports helpers from `ai.js` and registers personalities into `WITCH_PERSONALITIES` at module load time.

---

## Hero AI: Current State

### Architecture (what to replace)

`HeroAI` in `src/ai.js` (~600 lines) uses a `_decidePlanAction(sim)` method that returns one action at a time in a while loop. Three subclasses override `_decidePlanAction`:

| Class | Lines | Personality |
|-------|-------|-------------|
| `HeroAI` (base) | 157–751 | Balanced — day: hunt + nodes + explore; night: shelter + fortify |
| `HeroBerserker` | 999–1069 | Aggressive — day: charge witch; night: shelter; nodes only when losing |
| `HeroSentinel` | 1076–1158 | Defensive — race to node, entrench, fortify heavily |
| `HeroScavenger` | 1165–1241 | Explore-first — loot buildings, recruit survivors, pivot to nodes late |

Also includes `takeTurn()` (legacy sequential turn mode — can be removed, same as witch).

### Private helpers used by hero (keep or port)

| Function | Location | Purpose |
|----------|----------|---------|
| `_tryGuard(sim, entity)` | ai.js:758 | Guard if enemy within 2 hexes |
| `_nearestUnexploredBuilding(state, actor)` | ai.js:771 | Find closest unlooted building |
| `_undefendedNodes(state, holder)` | ai.js:784 | Nodes without any hero unit |
| `_bestNodeForHero(state, actor, claimedNodes)` | ai.js:797 | Best node target (neutral first, then witch-held) |
| `_makeHelpers(sim)` | ai.js:968 | Builds `tryMove`/`tryBattle`/`tryFortify` closures for subclass use |

### Key behavioral differences from witch

1. **Survivors** — hero recruits survivors (up to ~3) that act as independent sub-units. The hero needs to coordinate hero + survivors across nodes and buildings. Witch has minions summoned at will; hero discovers survivors through exploration.

2. **Fortification** — hero-specific mechanic. Costs wood/metal resources, increases defense on a building tile. Berserker fortifies at night up to level 3; Sentinel up to level 4; Scavenger up to level 3. There is no witch equivalent.

3. **Shelter-seeking** — at night/dusk, hero units take fatigue damage in the open. The hero AI must route units to buildings at night. Witch units don't have this constraint.

4. **Exploration priority** — hero explores buildings to recruit survivors and find items/weapons. Scavenger prioritizes this heavily; Berserker barely explores. Witch explores for summoning resources.

5. **No summoning** — hero doesn't create units. `BUILD_ARMY` equivalent is `RECRUIT` (explore buildings to find survivors).

6. **Items & weapons** — hero has herbs (healing), food (extra actions), weapons (equippable). `USE_ITEM` herbs is a free action. Weapons are equipped via `EQUIP_WEAPON` (also free).

---

## Proposed Hero Goals

Map the hero's strategic concerns to 5 goal categories, paralleling the witch engine:

| Goal | Description | Key Actions |
|------|-------------|-------------|
| `SLAY_WITCH` | Hunt and kill the witch to win | BATTLE (witch/minions), MOVE toward witch |
| `CONTROL_NODES` | Hold power nodes for scoring | MOVE to nodes, GUARD on nodes, dispatch survivors |
| `EXPLORE` | Loot buildings for survivors, items, weapons | MOVE to buildings, EXPLORE, EQUIP_WEAPON |
| `FORTIFY_POSITION` | Build defenses (night/dusk priority) | FORTIFY, MOVE to buildings for shelter |
| `PROTECT_HERO` | Keep hero alive | USE_ITEM herbs, MOVE away from threats (flee) |

### Phase multipliers (suggested starting values)

| Goal | Night | Day | Dawn/Dusk |
|------|-------|-----|-----------|
| SLAY_WITCH | ×0.5 | ×1.4 | ×1.0 |
| CONTROL_NODES | ×0.8 | ×1.0 | ×1.8 |
| EXPLORE | ×0.3 | ×1.5 | ×1.0 |
| FORTIFY_POSITION | ×2.0 | ×0.5 | ×1.5 |
| PROTECT_HERO | ×1.5 | ×0.8 | ×1.0 |

### Hero personality configs (suggested starting values)

```js
HERO_PERSONALITY_CONFIGS = {
  balanced: {
    goalWeights: { SLAY_WITCH: 1.0, CONTROL_NODES: 1.0, EXPLORE: 1.0, FORTIFY_POSITION: 1.0, PROTECT_HERO: 1.0 },
    engageFloor: 'unfavorable',
    shelterThreshold: 0.4,     // HP ratio below which hero seeks shelter even during day
    fortifyCapDay: 1,          // max fortification level to invest during day
    fortifyCapNight: 3,        // max fortification level to invest at night
  },
  aggressive: {
    goalWeights: { SLAY_WITCH: 2.0, CONTROL_NODES: 0.6, EXPLORE: 0.5, FORTIFY_POSITION: 0.4, PROTECT_HERO: 0.6 },
    engageFloor: 'suicidal',   // will fight unfavorable odds
    shelterThreshold: 0.2,
    fortifyCapDay: 0,
    fortifyCapNight: 3,
  },
  defensive: {
    goalWeights: { SLAY_WITCH: 0.4, CONTROL_NODES: 1.5, EXPLORE: 0.8, FORTIFY_POSITION: 2.0, PROTECT_HERO: 1.5 },
    engageFloor: 'unfavorable',
    shelterThreshold: 0.5,
    fortifyCapDay: 1,
    fortifyCapNight: 4,
  },
  explorer: {
    goalWeights: { SLAY_WITCH: 0.5, CONTROL_NODES: 0.8, EXPLORE: 2.0, FORTIFY_POSITION: 1.0, PROTECT_HERO: 1.0 },
    engageFloor: 'unfavorable',
    shelterThreshold: 0.5,
    fortifyCapDay: 1,
    fortifyCapNight: 3,
  },
}
```

---

## Implementation Plan

### Phase 1 — Foundation

#### Step 1.1: HeroAIEngine class skeleton + HeroEnginePlanSimState

Create `src/hero-ai-engine.js` (or extend `ai-engine.js` — see decision below).

```js
class HeroAIEngine {
  constructor(state, onStateChange, thinkDelay, playerId, config)
  generatePlan(allyContext) → PlanAction[]
}
```

`HeroEnginePlanSimState` extends `PlanSimState` with:
- `departedHexes` — same intra-plan anti-oscillation as witch engine
- `unitCommitments` — Map<entityId, goalName>
- `resourceLedger` — projected shared inventory (wood/metal for fortification)

#### Step 1.2: assessHeroBoard(sim) → HeroBoardAssessment

Flat data object:
- `phase`, `isNight`, `isDay`, `isDawnOrDusk`
- `hero` (ref), `heroHp`, `heroHpRatio`
- `survivors[]`, `survivorCount`
- `witch` (ref), `witchDistance`, `witchHpRatio`, `witchVisible`
- `witchMinions[]` (visible enemy units)
- `nodes[]` each with `{ obj, controller, heroPresent, witchPresent, distToHero, distToNearestHeroUnit }`
- `heroHeldCount`, `witchHeldCount`, `heroScore`, `witchScore`
- `heroItems` (herbs, food, weapons)
- `sharedInventory` (wood, metal for fortification)
- `unexploredBuildings[]`, `nearestUnexploredBuilding`
- `heroOnNode`, `heroInBuilding`, `heroTileExplored`, `heroTileFortLevel`
- `totalBudget`

#### Step 1.3: scoreHeroGoals(board, goalWeights) → GoalScores

Urgency formulas for 5 hero goals:

**PROTECT_HERO:**
- HP < 30% → 1.0; HP < 50% → 0.6
- Has herbs and injured → 0.3 base
- Witch within 2 hexes and HP < 50% → 1.0
- Phase mult: night ×1.5

**SLAY_WITCH:**
- Witch visible and close (≤1) → 0.9; (≤3) → 0.6; (≤5) → 0.3
- Witch low HP (< 40%) → +0.2
- Phase mult: day ×1.4, night ×0.5

**CONTROL_NODES:**
- Base 0.3
- Uncovered nodes: +0.15 per uncovered
- Witch holds 2+ nodes: +0.4 (urgent)
- Phase mult: dawn/dusk ×1.8

**EXPLORE:**
- Unexplored buildings nearby: 0.5 base
- No survivors recruited yet: +0.2
- Low resources (wood/metal < 2): +0.2
- Phase mult: day ×1.5, night ×0.3

**FORTIFY_POSITION:**
- Night + hero in building + fort level < cap: 0.7
- Night + hero NOT in building: 0.9 (need to move to shelter first)
- Day + hero in building + fort level 0: 0.3
- Phase mult: night ×2.0, day ×0.5

Apply `goalWeights` multipliers and clamp to [0, 1].

#### Step 1.4: allocateBudget

Reuse the existing `allocateBudget()` from `ai-engine.js` — same algorithm works for both factions.

#### Step 1.5: Tests

- `assessHeroBoard` returns expected fields
- `scoreHeroGoals` respects phase multipliers
- Budget allocation sums correctly

---

### Phase 2 — Tactic Generators

Five generators, each `(sim, board, budget, config?) → PlanAction[]`.

#### genProtectHero(sim, board, budget, config)

1. **Free herbs** — USE_ITEM herbs if injured (free action, don't count against budget)
2. **Free weapon equip** — EQUIP_WEAPON if hero has an unequipped weapon
3. **Flee** — if hero HP < `shelterThreshold` and witch/minion within 2 hexes, MOVE toward nearest building via `stepAwayFrom` or `nearestBuilding`
4. Priority: 0 (highest — survival prerequisite)

#### genSlayWitch(sim, board, budget, config)

1. **Battle adjacent** — if hero or survivor adjacent to witch/minion, emit BATTLE_UNIT (skip if below `engageFloor`)
2. **Chase witch** — MOVE hero toward witch (multi-step if budget allows)
3. **Survivors fight** — uncommitted survivors adjacent to enemies emit BATTLE_UNIT
4. Priority: 3

#### genControlNodes(sim, board, budget)

1. **Defend held nodes** — if hero/survivor on node with nearby witch threat, emit GUARD
2. **Contest uncovered nodes** — assign closest uncommitted unit to each undefended/witch-held node
3. **Dispatch survivors** — MOVE uncommitted survivors toward undefended nodes
4. Priority: 4–5

#### genExplore(sim, board, budget)

1. **Explore current building** — if hero on unexplored building, emit EXPLORE
2. **Move to nearest unexplored building** — MOVE hero toward it, then EXPLORE on arrival
3. Priority: 6

#### genFortifyPosition(sim, board, budget, config)

1. **Seek shelter** — if night and hero not in building, MOVE toward nearest building
2. **Fortify** — if in building and fort level < `fortifyCapNight` (night) or `fortifyCapDay` (day), and has wood/metal, emit FORTIFY. Deduct from resource ledger.
3. **Shelter survivors** — MOVE unsheltered survivors toward nearest building at night
4. Priority: 2 (high at night, low during day due to scoring)

#### estimateCombat

Reuse the existing `estimateCombat()` from `ai-engine.js` — same dice model works for both factions (just without night bonus for hero, and with fortification bonus for hero units on fortified tiles).

Adjust: hero doesn't get night ATK bonus, but does get fort DEF bonus. Add parameter or board flag.

---

### Phase 3 — Plan Assembly

Reuse `assemblePlan()` from `ai-engine.js`. The same logic applies:
1. Sort by `_priority`
2. Anti-oscillation filter (departedHexes + cross-turn prevPositions)
3. Deduplication
4. Budget enforcement (free actions: USE_ITEM herbs, EQUIP_WEAPON)
5. Gap-fill: guard if enemies nearby → explore current tile → move survivors to nodes → guard hero
6. Strip metadata, truncate to MAX_PLAN_LENGTH

---

### Phase 4 — Integration

#### Step 4.1: Wire into HeroAIEngine.generatePlan()

Same pattern as witch: construct sim → assessBoard → scoreGoals → allocateBudget → run generators → assemblePlan → update cross-turn memory.

#### Step 4.2: Register personalities

Self-registration pattern (same as witch):
```js
for (const name of Object.keys(HERO_PERSONALITY_CONFIGS)) {
  HERO_PERSONALITIES[name] = class extends HeroAIEngine { ... };
}
```

#### Step 4.3: Update consumers

- `src/main.js` — import `HeroAIEngine`, replace `new HeroAI(...)` calls
- `server/lobby.js` — use `HeroAIEngine` as default hero AI
- `scripts/headless.js`, `headless-mp.js` — import `HeroAIEngine`
- `src/ui.js` — remove hero `takeTurn()` path from `_maybeRunAI`/`_runHeroAI`

#### Step 4.4: Remove old HeroAI classes

Delete `HeroAI`, `HeroBerserker`, `HeroSentinel`, `HeroScavenger` from `ai.js`. Delete `_makeHelpers`, `_tryGuard`, `_nearestUnexploredBuilding`, `_undefendedNodes`, `_bestNodeForHero` (port the logic into generators/helpers).

#### Step 4.5: Run tests + simulations

```bash
npm test
node scripts/headless.js 500 standard
node scripts/combat-sim.js 200
node scripts/ai-matrix.js 50
node scripts/headless-mp.js 100
```

---

## File Decision: One Engine or Two?

**Option A: Single `ai-engine.js`** — both HeroAIEngine and WitchAIEngine in one file. Pros: shared code (assessBoard overlap, estimateCombat, assemblePlan, allocateBudget). Cons: large file (~1800 lines).

**Option B: Separate `hero-ai-engine.js`** — mirrors `ai-engine.js`. Import shared utilities from `ai-engine.js`. Pros: each file is focused (~900 lines). Cons: need to export shared internals.

**Recommendation: Option B** — create `src/hero-ai-engine.js`. Export shared utilities (`estimateCombat`, `allocateBudget`, `assemblePlan`, `EnginePlanSimState`) from `ai-engine.js` so the hero engine can import them. The goal-specific code (assessBoard, scoreGoals, generators) is faction-specific and belongs in separate files.

Shared exports to add to `ai-engine.js`:
- `allocateBudget` (already exported)
- `assemblePlan` (already exported)
- `estimateCombat` (already exported)
- `EnginePlanSimState` (already exported)
- `_fillGaps` — generalize or let hero engine define its own

---

## Reusable Existing Code

| From `ai-engine.js` | Reuse in hero engine |
|---------------------|---------------------|
| `EnginePlanSimState` | Extend or reuse directly |
| `estimateCombat()` | Adjust for hero (no night bonus, add fort bonus) |
| `allocateBudget()` | Reuse unchanged |
| `assemblePlan()` | Reuse unchanged |
| `PERSONALITY_CONFIGS` pattern | Copy pattern for hero configs |

| From `ai.js` (helpers) | Port or keep |
|------------------------|-------------|
| `stepToward()` | Keep (already exported) |
| `stepAwayFrom()` | Keep (already exported) |
| `nearestBuilding()` | Keep (already exported) |
| `isOnNode()` | Keep (already exported) |
| `inBuilding()` | Keep (already exported) |
| `_bestNodeForHero()` | Port into hero engine (hero-specific logic) |
| `_undefendedNodes()` | Port into hero engine |
| `_nearestUnexploredBuilding()` | Port into hero engine |
| `_tryGuard()` | Port into hero engine |

---

## Verification Checklist

- [ ] `npm test` passes (all existing + new hero-engine tests)
- [ ] Hero engine never returns empty plan (zero waste)
- [ ] No unit revisits a departed hex within same plan
- [ ] No unit ping-pongs across consecutive turns
- [ ] `headless.js 500 standard` completes without errors
- [ ] `ai-matrix.js 50` shows all hero personalities competitive
- [ ] `headless-mp.js 100` completes without errors
- [ ] No changes to planner.js, game.js, resolver.js, actions.js
- [ ] Hero personality configs produce distinct playstyles (kill rate, node rate, avg rounds differ)
- [ ] Old HeroAI, HeroBerserker, HeroSentinel, HeroScavenger fully removed
