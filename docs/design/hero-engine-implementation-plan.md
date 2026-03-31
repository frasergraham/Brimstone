# Hero AI Engine — Implementation Plan

Execution plan for migrating the Hero AI from the legacy greedy priority-list
model to the same 5-stage pipeline used by the Witch AI engine. Also removes
leftover turn-based execution code.

Reference design: `docs/design/hero-engine-migration.md`

---

## Phase 1 — Foundation (`src/hero-ai-engine.js`)

Create the new file with skeleton, enums, configs, and the first two pipeline
stages.

### Step 1.1: File skeleton + imports

Create `src/hero-ai-engine.js`. Import shared utilities:

| From `ai-engine.js` | Symbol |
|----------------------|--------|
| `EnginePlanSimState` | Extend for hero resource ledger |
| `allocateBudget` | Reuse unchanged |
| `assemblePlan` | Reuse unchanged |
| `estimateCombat` | Reuse — hero doesn't get night ATK bonus (already handled by attacker.owner check) |

| From `ai.js` | Symbol |
|---------------|--------|
| `PlanSimState` | Base class for sim state |
| `stepToward`, `stepAwayFrom`, `nearestBuilding`, `isOnNode`, `inBuilding` | Pathfinding / query helpers |
| `HERO_PERSONALITIES` | Registration target |

### Step 1.2: `HeroGoal` enum

```js
export const HeroGoal = Object.freeze({
  SLAY_WITCH:       'SLAY_WITCH',
  CONTROL_NODES:    'CONTROL_NODES',
  EXPLORE:          'EXPLORE',
  FORTIFY_POSITION: 'FORTIFY_POSITION',
  PROTECT_HERO:     'PROTECT_HERO',
});
```

### Step 1.3: `HERO_PERSONALITY_CONFIGS`

Four presets: `balanced`, `aggressive`, `defensive`, `explorer`.
Each config has `goalWeights`, `engageFloor`, `shelterThreshold`,
`fortifyCapDay`, `fortifyCapNight`. Values from design doc §Personality Configs.

### Step 1.4: `assessHeroBoard(sim)` → flat object

Reads simulation state into a `HeroBoardAssessment`:

- **Phase**: `phase`, `isNight`, `isDay`, `isDawnOrDusk`
- **Hero**: `hero` ref, `heroHp`, `heroMaxHp`, `heroHpRatio`
- **Survivors**: `survivors[]`, `survivorCount`
- **Witch**: `witch` ref, `witchVisible`, `witchDistance`, `witchHpRatio`
- **Enemy units**: `witchMinions[]` (visible enemy non-witch units)
- **Nodes**: `nodes[]` each `{ obj, controller, heroPresent, witchPresent, distToHero, distToNearestHeroUnit }`, `heroHeldCount`, `witchHeldCount`, `heroScore`, `witchScore`
- **Inventory**: `heroItems` (herbs, food count), `heroWeapons[]` (unequipped weapons), `sharedInventory` (wood, metal for fortification)
- **Map**: `unexploredBuildings[]`, `nearestUnexploredBuilding`
- **Positional**: `heroOnNode`, `heroInBuilding`, `heroTileExplored`, `heroTileFortLevel`
- **Budget**: `totalBudget`

### Step 1.5: `scoreHeroGoals(board, goalWeights)` → GoalScores

Five urgency formulas (0.0–1.0) with phase multipliers:

| Goal | Phase multipliers |
|------|-------------------|
| `PROTECT_HERO` | Night ×1.5, Day ×0.8, Dawn/Dusk ×1.0 |
| `SLAY_WITCH` | Night ×0.5, Day ×1.4, Dawn/Dusk ×1.0 |
| `CONTROL_NODES` | Night ×0.8, Day ×1.0, Dawn/Dusk ×1.8 |
| `EXPLORE` | Night ×0.3, Day ×1.5, Dawn/Dusk ×1.0 |
| `FORTIFY_POSITION` | Night ×2.0, Day ×0.5, Dawn/Dusk ×1.5 |

Urgency formulas — see design doc §Step 1.3 for details. Apply `goalWeights`
multipliers post-computation, clamp to [0, 1].

### Step 1.6: Tests

Create `tests/hero-ai-engine.test.js`:

- `assessHeroBoard` returns all expected fields
- `scoreHeroGoals` phase sensitivity (night boosts FORTIFY, day boosts EXPLORE)
- `allocateBudget` integration (sums to total budget)

### Commit point

`feat: add hero AI engine foundation — enums, configs, board assessment, goal scoring`

---

## Phase 2 — Tactic Generators

Five generators, each `(sim, board, budget, config?) → PlanAction[]` with
`_priority` and `_goal` metadata.

### Step 2.1: Port hero-specific helpers

Move from `ai.js` private functions to module-level functions in
`hero-ai-engine.js`:

| Helper | Source | Purpose |
|--------|--------|---------|
| `bestNodeForHero(state, actor, claimedNodes)` | ai.js:797 | Best node target (neutral → witch-held) |
| `undefendedNodes(state, holder)` | ai.js:784 | Nodes without hero unit presence |
| `nearestUnexploredBuilding(state, actor)` | ai.js:771 | Closest unlooted building |
| `nearestClusterHex(actor, obj)` | ai.js:101 | Closest hex within a node cluster |

Also port `_tryGuard` logic (ai.js:758) inline into generators.

### Step 2.2: `genProtectHero(sim, board, budget, config)` — Priority 0

1. **Free herbs** — `USE_ITEM` herbs if hero injured (free action)
2. **Free weapon equip** — `EQUIP_WEAPON` if hero has unequipped weapon
3. **Flee** — if `heroHpRatio < shelterThreshold` and witch/minion within 2 hexes, `MOVE` toward nearest building via `stepAwayFrom`

### Step 2.3: `genFortifyPosition(sim, board, budget, config)` — Priority 2

1. **Seek shelter** — if night and hero not in building, `MOVE` toward nearest building
2. **Fortify** — if in building and fort level < cap (day/night), and has wood/metal, emit `FORTIFY`. Deduct from resource ledger.
3. **Shelter survivors** — `MOVE` unsheltered survivors toward nearest building at night

### Step 2.4: `genSlayWitch(sim, board, budget, config)` — Priority 3

1. **Battle adjacent** — hero/survivors adjacent to witch/minions emit `BATTLE_UNIT` (skip if below `engageFloor`)
2. **Chase witch** — `MOVE` hero toward witch (multi-step if budget allows)
3. **Survivors fight** — uncommitted survivors adjacent to enemies emit `BATTLE_UNIT`

### Step 2.5: `genControlNodes(sim, board, budget)` — Priority 4–5

1. **Defend held nodes** — hero/survivor on node with nearby witch threat → `GUARD`
2. **Contest uncovered nodes** — assign closest uncommitted unit to each undefended/witch-held node
3. **Dispatch survivors** — `MOVE` uncommitted survivors toward undefended nodes

### Step 2.6: `genExplore(sim, board, budget)` — Priority 6

1. **Explore current building** — if hero on unexplored building, emit `EXPLORE`
2. **Move to nearest unexplored** — `MOVE` hero toward it, then `EXPLORE` on arrival

### Step 2.7: Tests

- Each generator produces expected action types given minimal sim setups
- `genProtectHero` emits free herbs when hero is injured
- `genFortifyPosition` emits FORTIFY when in building with resources
- `genSlayWitch` respects `engageFloor` config
- `genControlNodes` dispatches survivors to undefended nodes
- `genExplore` moves hero toward unexplored building

### Commit point

`feat: add hero AI engine tactic generators`

---

## Phase 3 — Engine Class + Assembly

### Step 3.1: `HeroAIEngine` class

```
constructor(state, onStateChange, thinkDelay, playerId, config)
```

- `generatePlan(allyContext?)` — full pipeline:
  1. Construct `EnginePlanSimState` (hero variant with resource ledger for wood/metal)
  2. `assessHeroBoard(sim)`
  3. `scoreHeroGoals(board, config.goalWeights)`
  4. `allocateBudget(scores, board.totalBudget)`
  5. Run 5 generators in priority order (each mutates sim)
  6. `assemblePlan(allActions, sim, board, this._prevPositions)`
  7. Update cross-turn memory (`_prevPositions`)
- `onBattleResult` — unused stub (expected by consumers)

### Step 3.2: Hero-specific gap-fill

`assemblePlan` from `ai-engine.js` calls `_fillGaps` internally which is
witch-specific (references `board.witch`, `board.minions`). Two options:

**Option A**: Make `assemblePlan` accept an optional `fillGapsFn` parameter.
**Option B**: Hero engine defines its own `assemblePlan` wrapper that calls the
shared logic then appends hero-specific gap-fill.

Recommend **Option B** — simpler, no changes to existing witch code. The hero
`_fillGapsHero` function:
- Guard if enemies nearby
- Explore current tile if unexplored
- Move survivors toward nodes
- Guard hero as final fallback

### Step 3.3: Self-registration into `HERO_PERSONALITIES`

Same pattern as witch engine (ai-engine.js:954):

```js
import { HERO_PERSONALITIES } from './ai.js';

for (const name of Object.keys(HERO_PERSONALITY_CONFIGS)) {
  HERO_PERSONALITIES[name] = class extends HeroAIEngine {
    constructor(state, onStateChange, thinkDelay = 600, playerId = null) {
      super(state, onStateChange, thinkDelay, playerId, HERO_PERSONALITY_CONFIGS[name]);
    }
  };
}
```

### Step 3.4: Factory helper

```js
export function createHeroAI(personality, state, onStateChange, thinkDelay, playerId) {
  const cfg = HERO_PERSONALITY_CONFIGS[personality] ?? HERO_PERSONALITY_CONFIGS.balanced;
  return new HeroAIEngine(state, onStateChange, thinkDelay, playerId, cfg);
}
```

### Step 3.5: Tests

- `generatePlan()` returns non-empty plan on a standard board
- Different configs produce different plan compositions
- Cross-turn memory prevents oscillation
- Plan never exceeds `MAX_PLAN_LENGTH`

### Commit point

`feat: add HeroAIEngine class with full 5-stage pipeline`

---

## Phase 4 — Consumer Wiring + Legacy Removal

### Step 4.1: Update consumers

| File | Change |
|------|--------|
| `src/main.js:5` | Import `HeroAIEngine` from `./hero-ai-engine.js` (drop `HeroAI` import) |
| `src/main.js:99` | `new HeroAIEngine(state, redraw, thinkDelay)` |
| `src/main.js:1924` | `new HeroAIEngine(state, redraw)` |
| `src/main.js:2702` | `_HERO_PERSONALITIES = ['balanced', 'aggressive', 'defensive', 'explorer']` |
| `server/lobby.js:4` | Import `HeroAIEngine` from `../src/hero-ai-engine.js`; drop `HeroAI` import |
| `server/lobby.js:560` | Fallback: `HeroAIEngine` instead of `HeroAI` |
| `scripts/headless.js:10,42` | Import + use `HeroAIEngine` |
| `scripts/headless-mp.js:21,116` | Import + use `HeroAIEngine` |
| `scripts/ai-matrix.js` | Uses `HERO_PERSONALITIES` — works automatically via self-registration |

Ensure `hero-ai-engine.js` is imported as a side-effect in `main.js` and
`lobby.js` (same pattern as `ai-engine.js`) so personality registration runs.

### Step 4.2: Remove legacy code from `ui.js`

| Location | Code to remove |
|----------|---------------|
| ui.js:2388–2394 | `_maybeRunAI()` method |
| ui.js:2397–2403 | `_runHeroAI()` method |
| ui.js:3106 | `this._maybeRunAI(800)` call in `refresh()` |

Also remove the `heroAI` property from UIController if it's only used by these
dead paths.

### Step 4.3: Remove old Hero classes from `ai.js`

| Lines | What to delete |
|-------|---------------|
| 157–997 | `HeroAI` class (entire class including `takeTurn`, `_chooseAction`, `_executeBattleWithUI`, `_tryHeal`, `generatePlan`, `_decidePlanAction`) |
| 999–1069 | `HeroBerserker` |
| 1076–1158 | `HeroSentinel` |
| 1165–1241 | `HeroScavenger` |
| 758–769 | `_tryGuard()` |
| 771–781 | `_nearestUnexploredBuilding()` |
| 784–790 | `_undefendedNodes()` |
| 797–827 | `_bestNodeForHero()` |
| 968–992 | `_makeHelpers()` |
| 829–831 | `delay()` |
| 1245–1250 | Old `HERO_PERSONALITIES` entries (keep empty object, filled by hero-ai-engine.js) |

**Keep** in `ai.js`: `PlanSimState`, `stepToward`, `stepAwayFrom`,
`nearestBuilding`, `isOnNode`, `inBuilding`, `bestWitchObjective`,
`_nearestClusterHex`, `HERO_PERSONALITIES` (empty), `WITCH_PERSONALITIES`
(empty, filled by ai-engine.js).

### Step 4.4: Update existing tests

| Test file | Change |
|-----------|--------|
| `tests/ai-names.test.js` | Update expected hero personality names: `balanced`, `aggressive`, `defensive`, `explorer` |
| `tests/ui-personality.test.js` | Update if it references old personality names |
| Any test importing `HeroAI` | Switch to `HeroAIEngine` or remove |

### Commit point

`refactor: wire HeroAIEngine into all consumers, remove legacy HeroAI classes`

---

## Phase 5 — Validation

### Step 5.1: Unit tests

```bash
npm test
```

All existing + new hero-engine tests must pass.

### Step 5.2: Balance simulations

```bash
node scripts/headless.js 500 standard    # AI-vs-AI win rates and game length
node scripts/combat-sim.js 200           # hit/crush/counter rates (unchanged)
node scripts/ai-matrix.js 50             # cross-personality balance matrix
node scripts/headless-mp.js 100          # 2v2 multiplayer balance
```

Compare against balance targets output by each script. Document any meaningful
deviations in the commit/PR message.

### Step 5.3: Verification checklist

- [ ] `npm test` passes
- [ ] Hero engine never returns empty plan
- [ ] No unit revisits a departed hex within same plan
- [ ] No unit ping-pongs across consecutive turns
- [ ] `headless.js 500 standard` completes without errors
- [ ] `ai-matrix.js 50` shows all hero personalities competitive
- [ ] `headless-mp.js 100` completes without errors
- [ ] No changes to `planner.js`, `game.js`, `resolver.js`, `actions.js`
- [ ] Hero personality configs produce distinct playstyles
- [ ] Old `HeroAI`, `HeroBerserker`, `HeroSentinel`, `HeroScavenger` fully removed
- [ ] Legacy `takeTurn` / `_maybeRunAI` / `_runHeroAI` paths removed from `ui.js`

---

## Constraints

- **No changes** to `planner.js`, `game.js`, `resolver.js`, `actions.js`
- **No new dependencies** — pure vanilla JS ES modules
- **Online/offline parity** — `HeroAIEngine` used by both `main.js` and `lobby.js`
- **Personality name change**: `berserker` → `aggressive`, `sentinel` → `defensive`, `scavenger` → `explorer`

## File Summary

| File | Action |
|------|--------|
| `src/hero-ai-engine.js` | **CREATE** — new hero AI engine (~800–900 lines) |
| `tests/hero-ai-engine.test.js` | **CREATE** — comprehensive test suite |
| `src/ai.js` | **EDIT** — remove ~1100 lines (HeroAI + subclasses + helpers) |
| `src/main.js` | **EDIT** — swap imports, update personality list |
| `server/lobby.js` | **EDIT** — swap imports |
| `scripts/headless.js` | **EDIT** — swap imports |
| `scripts/headless-mp.js` | **EDIT** — swap imports |
| `src/ui.js` | **EDIT** — remove dead `_maybeRunAI` / `_runHeroAI` |
| `tests/ai-names.test.js` | **EDIT** — update expected personality names |
