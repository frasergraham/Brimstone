# AI Architecture

## Overview

Both factions use a shared 5-stage pipeline architecture for plan generation. The AI calls the same `actions.js` functions as human players — no special rules or cheats.

Key files:
- `src/ai.js` — Shared helpers, `PlanSimState`, personality registries
- `src/ai-engine.js` — Witch AI (`WitchAIEngine`)
- `src/hero-ai-engine.js` — Hero AI (`HeroAIEngine`)

---

## 5-Stage Pipeline

Both `WitchAIEngine` and `HeroAIEngine` follow the same pipeline:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Stage 1: EVALUATE                                               │
│  assessBoard() / assessHeroBoard()                               │
│  ──────────────────────────────                                  │
│  Snapshot the board: unit positions, distances, threats,         │
│  resources, node state, scoring timing, visible enemies          │
│                                                                  │
│  Output: board object (read-only analysis)                       │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Stage 2: SCORE                                                  │
│  scoreGoals() / scoreHeroGoals()                                 │
│  ──────────────────────────────                                  │
│  Rate each goal 0.0 — 1.0 based on board state.                 │
│  Higher = more urgent.                                           │
│                                                                  │
│  Witch goals: BUILD_ARMY, CONTROL_NODES, DEFEND_WITCH            │
│  Hero goals:  EXPLORE, CONTROL_NODES, PROTECT_HERO               │
│                                                                  │
│  Output: { goal → score } map                                    │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Stage 3: ALLOCATE                                               │
│  allocateBudget(scores, totalBudget)                             │
│  ────────────────────────────────                                │
│  Divide the action budget across goals proportionally.           │
│  Filter goals below urgency threshold (0.05).                    │
│  Enforce minimum 2 actions per active goal.                      │
│                                                                  │
│  Output: { goal → actionCount } map                              │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Stage 4: GENERATE                                               │
│  gen*() functions (one per goal)                                 │
│  ──────────────────────────────                                  │
│  Produce PlanAction[] for each goal within its budget.           │
│  Uses PlanSimState to project moves without mutating real state. │
│                                                                  │
│  Witch: genBuildArmy(), genControlNodes(), genDefendWitch()      │
│  Hero:  genExplore(), genControlNodes(), genProtectHero()        │
│                                                                  │
│  Output: PlanAction[] per goal (with priority tags)              │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Stage 5: ASSEMBLE                                               │
│  assemblePlan(allActions, sim, board, prevPositions)              │
│  ─────────────────────────────────────────────────               │
│  1. Sort by priority (lower = first)                             │
│  2. Anti-oscillation filter (remove returns to just-left hexes)  │
│  3. Deduplicate by action key                                    │
│  4. Enforce action point budget                                  │
│  5. Gap-fill with exploratory movement & node coverage           │
│  6. Truncate to MAX_PLAN_LENGTH (12)                             │
│                                                                  │
│  Output: final PlanAction[] submitted for resolution             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Witch AI Goals

### DEFEND_WITCH
**Trigger:** Low HP (<30%), outnumbered near hero
**Actions:** Heal if herbs available, flee from threats, interpose minions between witch and hero

### BUILD_ARMY
**Trigger:** Few minions, high resources, unexplored buildings
**Actions:** Summon units (prioritize iron golem > wood golem > minion by affordability), explore buildings, move toward unexplored areas

### CONTROL_NODES
**Trigger:** Uncontrolled nodes, approaching scoring checkpoint, hero holding nodes
**Actions:** Move minions to nodes, fight adjacent enemies at nodes, guard when threatened

### Goal Scoring Factors

```
DEFEND_WITCH score:
  ├── High at low witch HP (<30%)
  ├── High when outnumbered near hero
  └── Boosted when hero is adjacent

BUILD_ARMY score:
  ├── High when minion count < node count
  ├── Boosted by available resources
  └── Boosted by unexplored buildings

CONTROL_NODES score:
  ├── Scales with uncaptured nodes
  ├── Boosted near dawn/dusk scoring
  └── Boosted when behind in score
```

---

## Hero AI Goals

### PROTECT_HERO
**Trigger:** Low HP, enemies nearby, night phase
**Actions:** Heal, equip weapon, flee if HP critically low, shelter at night

### EXPLORE
**Trigger:** Few survivors, unexplored buildings, daylight
**Actions:** Explore current hex, sound horn (recruit), move to buildings, fortify

### CONTROL_NODES
**Trigger:** Always active (0.5 base score), scoring proximity, contested nodes
**Actions:** Send hero + survivors to nodes, fight enemies en route, fortify node buildings

### Goal Scoring Factors

```
PROTECT_HERO score:
  ├── High at low HP (<30%)
  ├── Boosted with herbs available
  ├── Boosted when enemies near
  └── Higher at night

EXPLORE score:
  ├── High when no survivors (needs recruiting)
  ├── Scales with unexplored buildings
  └── Boosted during daylight

CONTROL_NODES score:
  ├── Base 0.5 (always somewhat important)
  ├── Scales with contested node count
  ├── Boosted near scoring checkpoints
  └── Boosted when behind in score (score-differential urgency)
```

---

## Difficulty Tiers

Human-vs-AI games carry `state.aiDifficulty` (`'easy' | 'normal' | 'hard'`,
default `normal`; persisted via state-sync). The tier shifts how many actions
the AI *plans* each round — the same lever campaign missions use via
`campaignAIBudgetBonus`: easy −1, normal 0, hard +1, floored at 1
(`AI_DIFFICULTY_BUDGET_DELTA` in `src/ai.js`, applied to `totalBudget` in both
engines' assess stage via `PlanSimState.aiDifficultyDelta`). `normal` is the
tuned balance baseline — AI-vs-AI balance runs never set the field, so all
headless numbers in this doc are at normal.

Online AI fill-in picks a random personality from the matrix-validated pool
(`RANDOM_PERSONALITY_POOL` in `server/lobby.js`): hero
balanced/aggressive/defensive/explorer, witch balanced/aggressive/swarm.
`node_denier`, `witch_hunter`, and `evasive` are excluded from random rotation
until they get an ai-matrix pass of their own.

---

## Personality System

Each side primary (Hero / Witch) has 3 personality variants that adjust goal weights and engagement thresholds. Stub factions (Rogue / Captain on day; Necromancer / Brute on night) inherit their parent side's personality registry for now — `Faction.getPersonalities()` returns the parent registry until a stub gets its own implementation. See `docs/design/faction-expansion.md`.

### Witch Personalities

```
              BUILD_ARMY  CONTROL_NODES  DEFEND_WITCH  fleeThreshold
  ┌──────────┬──────────┬──────────────┬─────────────┬──────────────┐
  │ Balanced │   1.0    │     1.0      │     1.0     │    0.30      │
  │Aggressive│   0.8    │     0.6      │     0.5     │    0.15      │
  │  Swarm   │   1.5    │     1.2      │     1.3     │    0.40      │
  └──────────┴──────────┴──────────────┴─────────────┴──────────────┘
```

- **Balanced (default):** Equal attention to all goals
- **Aggressive (Berserker):** Low flee threshold, less defensive, combative
- **Swarm:** Heavy army building, defensive, produces many cheap minions

### Hero Personalities

```
              EXPLORE  CONTROL_NODES  PROTECT_HERO  engageFloor
  ┌──────────┬────────┬──────────────┬─────────────┬────────────┐
  │ Balanced │  1.0   │     1.0      │     1.0     │unfavorable │
  │Aggressive│  0.6   │     1.5      │     0.5     │  suicidal  │
  │Defensive │  0.8   │     1.2      │     1.5     │unfavorable │
  │ Explorer │  2.0   │     0.8      │     1.0     │unfavorable │
  └──────────┴────────┴──────────────┴─────────────┴────────────┘
```

- **Balanced (Sentinel):** Even split across goals
- **Aggressive (Berserker):** Fights everything, low self-preservation
- **Defensive:** Higher protection priority, cautious combat
- **Explorer (Scavenger):** Maximal exploration, resource gathering first

### Engagement Floor

Controls combat risk tolerance:

```
  suicidal    → attack unless combat is suicidal (≤-3 margin)
  unfavorable → attack only if favorable or overwhelming
  favorable   → attack only if overwhelming (>+3 margin)
```

---

## Combat Estimation

Both AIs estimate combat outcomes before committing:

```
estimateCombat(attacker, defender, board):

  Expected ATK = attacker.attack + 3.5 (avg d6)
                + gang-up dice × 2
                + night bonus (witch only)
                + weapon bonus

  Expected DEF = defender.defense + 3.5 (avg d6)
                + fortification
                + weapon bonus

  Margin = ATK - DEF

  Classification:
    margin > +3  → 'overwhelming'
    margin > 0   → 'favorable'
    margin > -3  → 'unfavorable'
    margin ≤ -3  → 'suicidal'
```

---

## PlanSimState

A lightweight clone of `GameState` used during plan generation. Allows the AI to project moves without mutating the real game state.

```
PlanSimState
  ├── tiles (reference — not cloned)
  ├── entities (shallow clone, alive only)
  ├── phase, round, inventory
  ├── hero / witch (leader references)
  ├── actionsLeft (budget tracking)
  ├── _explored Set (in-plan explored tiles)
  └── _justLeft (anti-oscillation memory)

Methods:
  applyMove(entity, col, row)      Update position in projection
  applyBattle(attacker, defender)   Estimate outcome, deduct HP
  applyExplore(entity)             Mark hex explored in projection
  applySummon(type)                Deduct resources, add entity
  applyGuard(entity)               Set guarding state
  applySoundHorn(entity)           Mark horn used
```

### EnginePlanSimState (extends PlanSimState)

Used by `WitchAIEngine` and `HeroAIEngine` with additional tracking:

```
EnginePlanSimState
  ├── departedHexes Map     Track unit departure points (anti-oscillation)
  ├── unitCommitments Map   Lock unit to goal (prevent double-assignment)
  └── resourceLedger        Independent copy for projected spending
```

---

## Multiplayer AI Coordination

In N-player games (2v2, 3v3, 4v4), ally AIs coordinate via `allyContext`:

```
Player 1 generates plan
  → claims nodes A, B in allyContext.claimedNodes

Player 2 generates plan
  → sees A, B already claimed
  → targets node C instead (or assists at A/B if needed)

Player 3 generates plan
  → sees A, B, C claimed
  → fills gaps or supports weakest position
```

This prevents multiple ally AIs from sending all their units to the same node.

---

## Anti-Oscillation

Cross-turn memory prevents units from ping-ponging between hexes:

```
Round N:   unit at hex A → moves to hex B
Round N+1: previousPositions[unit] = A
           assemblePlan() filters out moves back to A
           unit continues forward instead of returning
```

---

## Terrain-Aware Pathing & Sight

Buildings are two-hex compounds — a passable entrance plus an **impassable footprint** hex (`isBuildingFootprint`, capacity 0; see [05-game-systems.md → Building Footprints](05-game-systems.md#building-footprints)). The AI handles them the same way it handles rivers:

- **Goal/transit filtering** — gap-fill exploration drops footprint hexes from the candidate set alongside rivers (`if (isRiver(t) || isBuildingFootprint(t)) continue;` in `src/ai-engine.js` and `src/hero-ai-engine.js`). Step-toward pathing additionally never lands on a footprint because capacity-0 hexes fail the move gate.
- **Sight** — Hero-AI board assessment calls the shared `computeLineOfSight` (`src/actions.js`), which uses `blocksLineOfSight` — footprint hexes block vision, **building entrances do not** (the doorway is transparent). Same rule as the renderers and fog.

---

## Scoring Awareness

Both AIs track `roundsUntilScoring()` and adjust behavior near dawn/dusk:

```
Rounds to scoring:  4+  → normal behavior
                    2-3 → increased node urgency
                    0-1 → maximum node priority

Hero-specific:  score-differential urgency
  If hero behind in score → CONTROL_NODES priority boosted further
  (Deliberately NOT applied to witch — witch already has unit-count advantage)
```

---

## Node Feasibility

`scoreNodeFeasibility(node, myFaction, entities)` rates each node 0–1:

```
Factors:
  ├── Distance advantage (closer = higher)
  ├── Force on/near node (own units present = higher)
  └── Current controller (uncontrolled = higher)

Thresholds:
  Hero:  filter out nodes below 0.1 feasibility
  Witch: filter out nodes below 0.15 feasibility

Hero sorts by:  feasibility score (most winnable first)
Witch sorts by: priority (hero-held > neutral > threatened, then distance)
```

When scoring is ≤2 rounds away and a node has feasibility ≥0.6, the hero AI can send 2 units to that node for a stronger claim.

---

## Balance Baseline & Tuning Methodology

**Last updated:** 2026-06-10 (damage-dice overhaul — weapons roll damage, HP ×7; see note below)

### Baseline Metrics (500 1v1 games, Standard 14×14)

| Metric | Value | Target |
|--------|-------|--------|
| Hero win rate | ~43% | 38–62% (±12%) |
| Witch win rate | ~57% | 38–62% (±12%) |
| Kill wins | ~50% | ≥20% |
| Tiebreaks | 0.2% | <10% |
| Round-cap hits | 0.2% | <5% |
| Mean rounds | ~22 | 15–35 |

> Damage-dice overhaul note (2026-06-10): weapons now deal rolled damage (fixed
> or dice; e.g. unarmed/sword 2D6, musket 2D8) and all HP is ×`DAMAGE_SCALE` (7),
> chosen so average hits-to-kill matches the pre-dice era. Combat is markedly
> more lethal — kill-wins rose to ~50%. The dice overhaul itself was **balance-
> neutral** on 14×14 (post-bisect 2026-06-16: 43.4% → 43.5% Hero on `facb710` vs
> `faa819c`, 1000 games each); the **balanced-vs-balanced** matchup also stays
> centered at H50%/W50% in `ai-matrix`. The ~6pt witch tilt that landed in this
> window came from the **+20% map resize one commit earlier** (`facb710`), not
> the dice change: 13×13 Hero ~49.6% → 14×14 Hero ~43.4% (longer games → more
> night/summon time, especially benefiting the aggressive-witch outlier).
> Recentring lever if a tuning pass is wanted: reduce Standard map area
> (toward 13×13). Tuning combat constants won't move the win-rate split.

> Weapons-overhaul note: ranged weapons only benefit the hero's roster (summons/zombies/golems can't equip), which skewed NvN toward the hero. The witch's `unitBonusCap` was raised 3→4 so its swarm converts to actions and keeps contesting nodes; Magic Bolt carries +1 ATK so the witch leader keeps the same ~1-ATK duel gap vs the now-sword-armed Paladin.

### Combat & Economy Baseline

| Metric | Value |
|--------|-------|
| Hero battles/game | 20.5 |
| Hero kills/game | 3.9 |
| Witch battles/game | 16.2 |
| Witch kills/game | 1.6 |
| Hero HP at end | 10.1 |
| Witch HP at end | 7.1 |
| Peak hero survivors | 3.8 |
| Peak witch minions | 6.0 |
| Witch summons/game | 8.1 |
| Hero fortifies/game | 2.3 |

### Action Mix Baseline

| Action | % of all actions |
|--------|-----------------|
| move | 47.6% |
| guard | 31.0% |
| explore | 10.4% |
| battle-unit | 6.0% |
| summon | 2.7% |
| sound-horn | 1.0% |
| fortify | 0.8% |
| use-item | 0.6% |

### Win Reason Breakdown

| Reason | % |
|--------|---|
| Witch 3-point score | 41.6% |
| Hero kills witch | 31.8% |
| Hero 3-point score | 14.8% |
| Witch kills hero | 5.4% |
| Witch sweeps nodes | 3.6% |
| Hero sweeps nodes | 1.2% |

### NvN Baseline (500 games each, Standard 13×13)

| Mode | Hero win rate | Witch win rate | Peak hero force | Peak witch force |
|------|---------------|----------------|------------------|-------------------|
| 2v2  | 58.3% (400g) | 41.8% | ~6 units (1.3× 1v1) | ~13 units (1.75× 1v1) |
| 3v3  | 53.0% (100g) | 47.0% | ~8 units (1.7× 1v1) | ~20 units (2.7× 1v1) |
| 4v4  | 59.0% (100g) | 41.0% | ~9 units (1.9× 1v1) | ~25 units (3.5× 1v1) |

NvN scales up unit density on both sides (so 4v4 doesn't feel sparse on the
13×13 map) while keeping balance in the ±12% target band. All NvN scaling is
gated on `playerCount > 1`, so 1v1 behavior is mathematically unchanged.

- **Scaled witch minion cap** (`src/ai-engine.js:_trySummons`): `base + 4×(witchPlayerCount−1)` so a 3-witch team isn't rationed to the solo-witch 7/10 ceiling. 4v4 night cap = 22.
- **Per-witch BUILD_ARMY / CONTROL_NODES scoring** (`scoreGoals`): thresholds divide `minionCount` by `witchPlayerCount`; node base bumped 0.45→0.60 so extra minions actually reach nodes rather than clustering near witches.
- **Scaled witch `unitsPerNode`** (`genControlNodes`): 1v1→1, 2v2→2, 3v3+→3 baseline; ensures the expanded minion supply disperses across nodes instead of piling up.
- **Hero concentration cap** (`hero-ai-engine.js:genControlNodes`): `unitsForNode` capped at 2 in NvN so hero teams don't over-commit to one contested node.
- **NvN explore loot bonus** (`executeExplore`): extra loot rolls scale with side size — 2v2 +30% chance, 3v3 +1 roll, 4v4 +1 roll +30% chance. Raises resource inflow proportionally so both sides can actually spend on summons/equipment.
- **Hero Sound Horn tightened** (`hero-ai-engine.js:genExplore`): survivor ceiling nodeCount→nodeCount when heroCount>1 (no growth beyond 1v1 pool).

Do not remove these without re-running `node scripts/headless.js 500 standard --players N` for N ∈ {2, 3, 4}.

### Tuning Methodology — How to Iterate on AI Balance

Follow this process for any AI change. The goal is to stay within the balance targets while improving AI behavior.

#### Step 1: Establish pre-change baseline
```bash
node scripts/headless.js 500 standard          # 1v1 baseline
node scripts/headless.js 100 standard --players 2  # 2v2 baseline
```
Record Hero/Witch win rates, kill %, tiebreak %, mean rounds. Compare against the baseline table above.

#### Step 2: Make changes and run quick validation
```bash
node scripts/headless.js 100 standard          # fast check — look for gross regressions
```
If win rate shifts >10% from baseline, investigate before scaling up.

#### Step 3: Full validation
```bash
node scripts/headless.js 500 standard          # 1v1 — primary balance metric
node scripts/headless.js 100 standard --players 2  # 2v2 — ally coordination check
node scripts/ai-matrix.js 50                   # personality cross-balance
```

#### Step 4: Check balance targets
| Metric | Target | Action if violated |
|--------|--------|--------------------|
| Win rate | 38–62% either side | Tune the stronger side down or weaker side up |
| Tiebreaks | <10% | Games are stalling — check round cap, node contest logic |
| Kill wins | ≥20% | Combat is too weak or nodes too dominant — check combat stats |
| Mean rounds | 15–35 | Too short = snowball; too long = stalemate |
| Round cap hits | <5% | Games aren't resolving — check AI aggression |

#### Step 5: Asymmetric tuning
Key lesson learned: applying the same improvement to both factions often helps one side more than the other due to asymmetric unit counts and playstyle.

- **Witch has more units** → improvements to per-node force scoring or multi-unit assignment disproportionately help witch.
- **Hero has stronger individuals** → improvements to combat targeting or kill-seeking help hero more.
- **If witch is too strong:** remove/reduce witch-side bonuses first; add hero-side urgency bonuses; try asymmetric thresholds.
- **If hero is too strong:** reduce hero urgency bonuses; give witch more scoring awareness; check if hero combat stats are too high.

#### Step 6: Update this baseline
After tuning is complete and balance is within targets, update the baseline tables above with new 500-game results. Include the date and a brief description of what changed.
