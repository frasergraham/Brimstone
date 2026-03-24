# Brimstone — Claude Context

## Project Overview

Browser-based, turn-based hex-grid strategy game set in cursed colonial New England (Salem). Two asymmetric factions — **Hero** vs **Witch** — fight across a procedurally-generated map.

**Win conditions:**
- Hero: slay the Witch, or hold more Power Nodes at enough dawn/dusk scoring checkpoints (first to 3 cumulative score points).
- Witch: slay the Hero, or seize all 3 Power Nodes, or accumulate 3 node-score points.

**Game modes:** Human vs AI, Two Players, AI vs AI auto-play.

No build step. No dependencies. Pure vanilla JS ES modules, HTML5 Canvas, plain CSS.

---

## Git

**Active branch:** `claude/hex-game-framework-3U13Q`
**Push command:** `git push -u origin claude/hex-game-framework-3U13Q`

---

## Run Commands

```bash
npm run dev    # Dev server via npx serve (port 3000)
npm start      # Python HTTP server fallback

node scripts/headless.js [count]     # AI-vs-AI balance testing (default 1000 games)
node scripts/combat-sim.js [rounds]  # Combat stats report (default 100 samples)
```

---

## Directory Structure

```
index.html          # Single-page shell with all UI overlay elements
styles.css          # Dark gothic theme; CSS custom properties on :root
src/
  main.js           # Entry point — wires all modules, setup screen flow, resize
  game.js           # GameState class: tiles, entities, phase cycle, turn/victory logic
  entities.js       # Entity class + factory functions; static resolveCombat()
  actions.js        # All action validation (getValidActions) and execution functions
  map.js            # Procedural map generator (river, buildings, roads, MST, forests)
  renderer.js       # Canvas 2D renderer — multi-pass, zoom/pan, fog, animations
  ui.js             # UIController — DOM events, click routing, popups, dialogs
  ai.js             # WitchAI and HeroAI — plan generation + BFS pathfinding
  tiles.js          # Tile/Building/Resource/Weapon enums, colors, icons, rollLoot()
  hex.js            # Pure hex math: offset↔axial, neighbors, distance, range, pixel
  loot.config.js    # Externalized weighted loot tables (primary tuning file)
  planner.js        # PlanActionType enum, computeGhostState(), validatePlanAction()
server/
  resolver.js       # resolvePlans() — lockstep resolution engine (no DOM/WebSocket)
  lobby.js          # Matchmaking, room lifecycle, server-side AI, plan submission
  state-sync.js     # serializeState() — snapshot for network transmission
  auth.js           # Player auth / session tokens
  db.js             # SQLite persistence
  leaderboard.js    # Win/loss recording and ranking
scripts/
  headless.js       # Headless AI-vs-AI runner (imports src/ directly, no DOM)
  combat-sim.js     # Scenario matrix: hit rates, crush rates, expected damage
```

---

## Architecture

**Strict separation of concerns:**
- `game.js` — owns state; no rendering or DOM.
- `renderer.js` — reads state, draws canvas; zero state mutations.
- `actions.js` — all game-logic mutations as pure functions `(state, actor, ...)`. Both UI and AI call these same functions.
- `ui.js` — sole file touching DOM; bridges user input → actions.
- `ai.js` — calls the same `execute*` functions from `actions.js` as the UI; also generates synchronous `PlanAction[]` arrays via `generatePlan()`.
- `server/resolver.js` — imported by both `server/lobby.js` (online) and `src/main.js` (local) — no DOM dependency.

**Key patterns:**
- All type constants use `Object.freeze()` enums.
- `state.tiles` is a `Map<"col,row", Tile>` — O(1) lookup by hex key via `hexKey(col, row)`.
- Dead entities removed by filter: `state.entities = state.entities.filter(e => e.id !== dead.id)`.
- Execute functions return `{ success, log, cost }`; caller calls `state.spendAction(result.cost)`.
- Headless scripts import `src/` directly — all game logic is DOM/Canvas-free.

---

## Online vs Offline Modes

The game runs in two distinct modes that share core logic but have separate orchestration layers. **Changes to one often require parallel changes in the other.**

### Shared code (affects both modes equally)
| File | What it governs |
|------|----------------|
| `src/game.js` | State lifecycle, phase cycle, scoring, `endRound()` |
| `src/actions.js` | All action validation and execution — the single source of truth for rules |
| `src/entities.js` | Entity stats, combat resolution |
| `src/planner.js` | Plan validation, ghost-state projection |
| `server/resolver.js` | Lockstep plan resolution — imported by both `src/main.js` and `server/lobby.js` |
| `src/ai.js` | AI plan generation — imported by both `src/main.js` (offline) and `server/lobby.js` (online) |

### Offline mode (`src/main.js` orchestrates)
- Everything runs in the browser: state, AI, resolution, animation.
- Flow: `_startLocalPlanningPhase` → human submits → AI generates → `_runLocalResolution` → `state.endRound()` → repeat.
- No serialization — state object is passed directly to all functions.

### Online mode (`server/lobby.js` orchestrates)
- Server drives the planning phase, resolution, and AI; client renders and submits plans.
- State is serialized for network transmission via `server/state-sync.js`.
- Flow: `_startPlanningPhase` (server) → clients submit plans → `_executeResolution` (server) → broadcast `resolutionComplete { steps, finalState }` → clients animate and apply `finalState`.

### Parity rules
- **Rule changes** (combat formula, action costs, phase effects, scoring): edit `src/actions.js` or `src/game.js` — automatically applies to both modes. Verify `server/resolver.js` handles any new result shapes.
- **New state fields**: must also be added to `server/state-sync.js` serialization, or online mode will silently drop them.
- **Planning flow changes** (phase triggers, timeout behavior, budget logic): `src/main.js` (offline) and `server/lobby.js` (online) are the two orchestration layers — they must stay in sync manually.
- **UI-only changes** (`src/ui.js`) affect both modes' client display but not server logic.

---

## Simultaneous-Turn Planning System

The game uses a **simultaneous planning model** instead of sequential alternating turns. Each round:

1. **Planning phase** — both factions independently build an ordered action queue (a `PlanAction[]`).
2. **Submission** — each side submits their plan; the server (or local `main.js`) waits for both.
3. **Resolution** — `resolvePlans(state, heroPlan, witchPlan)` in `server/resolver.js` executes the plans in **paired lockstep steps** (one hero action, one witch action per step), applying skip/fail logic and budget enforcement.
4. **End of round** — `state.endRound()` advances phase, applies hazards, scores nodes.

### Key files

| File | Role |
|------|------|
| `src/planner.js` | `PlanActionType` enum, `computeGhostState()`, `validatePlanAction()`, `snapEntity()` |
| `server/resolver.js` | `resolvePlans(state, heroPlan, witchPlan)` → `StepRecord[]`; `ResEventType` enum |
| `src/game.js` | `state.startPlanning()`, `state.submitPlan(faction, plan)`, `state.endRound()` |
| `src/ai.js` | `WitchAI.generatePlan()`, `HeroAI.generatePlan()`, `PlanSimState` |
| `src/ui.js` | `enterPlanningMode()`, `exitPlanningMode()`, plan panel, ghost overlay |
| `src/main.js` | Local resolution loop (`_startLocalPlanningPhase` → `_runLocalResolution`); online callbacks |
| `server/lobby.js` | `_startPlanningPhase()`, `handlePlanSubmit()`, `_executeResolution()` |

### PlanAction shape

```js
{ type: PlanActionType, entityId: string, ...typeSpecificFields }
// MOVE:        toCol, toRow
// BATTLE_UNIT: targetId
// BATTLE_HEX:  targetCol, targetRow
// SUMMON:      toCol, toRow
// USE_ITEM:    item
// EQUIP_WEAPON: weapon
// EXPLORE / FORTIFY / USE_ABILITY: no extra fields
```

### Resolution event types (`ResEventType`)

| Value | Meaning |
|-------|---------|
| `action_ok` | Executed; `result` + optional `battleSnaps` attached |
| `action_skip` | Battle target gone/dead — free skip, next step runs immediately |
| `action_fail` | Hard failure (entity gone, wrong faction) — faction plan halts |
| `budget_cap` | Budget exhausted; remaining plan dropped |

### Ghost overlay

`computeGhostState(state, plan)` projects entity positions through all MOVE/SUMMON steps in the plan and returns a `StepDescriptor[]`:
```js
{ action, positions: Map<id,{col,row}>, arrow: {entityId,fromCol,fromRow,toCol,toRow}|null, stepNumber }
```
The renderer reads `renderer.planGhostSteps` and draws dashed arrows with numbered badges via `_drawPlanOverlay()`.

`_selectEntity()` in `ui.js` calls `_getProjectedPos(entityId)` to look up the latest ghost position and passes a position-proxy to `getValidActions()`, enabling multi-move chaining within a single plan.

### Planning state fields on `GameState`

```js
planningPhase:    bool    // true while both sides are building plans
resolving:        bool    // true while resolver is running
heroPlan / witchPlan: PlanAction[] | null
heroReady / witchReady: bool
heroActionsLeft / witchActionsLeft: number  // budgets computed at startPlanning()
```

### Local mode flow (`src/main.js`)

```
init()
  └─ _startLocalPlanningPhase()
       ├─ state.startPlanning()
       ├─ ui.enterPlanningMode(faction, budget)       [human vs AI]
       │    ui.onPlanSubmit = _onLocalHumanPlanSubmit
       └─ setTimeout(_runLocalAutoResolution)          [autoplay]

_onLocalHumanPlanSubmit(faction, plan)
  ├─ state.submitPlan(faction, plan)
  ├─ AI generates opponent plan via generatePlan()
  ├─ state.submitPlan(aiFaction, aiPlan)
  └─ _runLocalResolution()

_runLocalResolution()
  ├─ snapshot prePos
  ├─ resolvePlans(state, heroPlan, witchPlan) → steps
  ├─ _animateResolutionSteps(steps, prePos, redraw, humanFaction)
  ├─ state.endRound()
  └─ _startLocalPlanningPhase()   (or showGameOver)
```

### Online mode flow

Server: `_startPlanningPhase(room)` → broadcasts `stateUpdate` + `planningPhase` message → AI submits immediately → waits for human → `_executeResolution()` → broadcasts `resolutionComplete { steps, finalState }` → 100 ms → next `_startPlanningPhase`.

Client callbacks in `_createMpClient()`:
- `onPlanningPhase({ heroActionsLeft, witchActionsLeft })` → `ui.enterPlanningMode(myFaction, budget)`
- `onOpponentReady()` → update plan status text
- `onResolutionComplete({ steps, finalState })` → animate steps → apply `finalState`

### Plan panel UI

The collapsible right-side panel (`#plan-panel`) shows the queued action list.

- **Toggle:** `◀/▶` button in header or the always-visible left-edge tab (`#plan-tab`) with a live step-count badge.
- **Collapsed state:** `.collapsed` class — panel width transitions to 0; only the tab protrudes. Reset to expanded each new planning phase (`exitPlanningMode` removes `.collapsed`).
- `.plan-submitted` class disables clear/submit buttons and hides remove buttons when plan is locked.

---

## Rendering System

**Hex type:** Pointy-top, odd-r offset storage (13 cols × 11 rows).
**Canvas:** Fills wrapper div. Hex size computed to fit grid; centered via `_padX`/`_padY`.
**Zoom:** 0.5×–4.0×. Desktop: scroll wheel + drag. Mobile: pinch + single-finger drag.

**Draw order (each frame):**
1. Black background `#0d1117`
2. `ctx.save()` + apply zoom/pan transform
3. Pass 1: terrain tiles (grass, forest, dirt; road/river/bridge tiles draw grass base)
4. River layer: quadratic bezier curves at ~52% hex width; extends off-screen at endpoints
5. Road layer: bezier strips (straight-through / dead-end / junction); bridge water + wood railings on top
6. Pass 2: building tiles (drawn over roads)
7. Fog of war: 70% black overlay on hexes outside human player's sight
8. Objective glows: radial purple gradient at Power Node positions (always visible)
9. Objective symbols: `⛧` glyph + label
10. Unit presence outlines: orange (hero side) or purple (witch side)
11. Highlight hexes: green (move), red (battle)
12. Selected hex: gold outline
13. Hovered hex: white semi-transparent outline
14. Entity stacks: colored circles with glyph, HP bar, weapon dot, ability dot; `+N` badge for overflow
15. Damage flash: fading red hex overlay + rising damage text
16. Plan ghost overlay: dashed yellow arrows with numbered step badges (`_drawPlanOverlay`, reads `renderer.planGhostSteps`)
17. `ctx.restore()`

**Entity glyphs/colors:** ⚔ Hero (gold), ✦ Witch (purple), ☺ Survivor (green), † Zombie (olive), ☠ Minion (red), 🪵 Wood Golem (brown), ⚙ Iron Golem (blue-grey).

---

## Game Mechanics

### Phase Cycle (8 rounds per cycle)
`DAWN (1) → DAY (3) → DUSK (1) → NIGHT (3)`

| Phase | Effect |
|-------|--------|
| Dawn  | Hero +1 action; attrition level +1 (cap 3); tiles reset unexplored; node scoring |
| Day   | Hero +1 ATK; witch undead/golems in open take `attritionLevel` damage |
| Dusk  | No bonus; node scoring |
| Night | Witch +1 ATK; survivors in open take `attritionLevel` damage |

### Action Economy
- **Hero:** 3 base + 1 in DAY/DAWN + up to 2 extra from survivors.
- **Witch:** 4 base + 1 in NIGHT + 1 per 2 minions (cap +4).

### Actions
| Action | Cost | Notes |
|--------|------|-------|
| Move | 1 | 2 hexes with horse; cannot cross rivers except bridges |
| Explore | 1 | Reveals loot via weighted tables; HERBALIST also yields Herbs |
| Battle | 1 | Adjacent or co-located; dice-based with phase/ally/fortify bonuses |
| Fortify | 1 | Hero only; 1 Wood → +1 DEF (or +2 with FORTIFY_DOUBLE); 1 Metal → +2 DEF; max level 4 |
| Summon | 1 | Witch only, once/turn; Metal → Iron Golem, Wood → Wood Golem, other → Minion |
| Use Item | 0–1 | Herbs (free, heal 2), Food (1 action, +1 action), Silver (free, +1 ATK), Scripture (free, ward) |
| Equip Weapon | 0 | Free; moves weapon to equipped slot |
| Use Ability | 0–1 | HEAL (1), INSPIRE (free), RALLY (free) |

### Combat Formula
```
attackRoll  = d6 + attack + attackBonus + phaseBonus + staffBonus + Σ(gang-up d3s)
defenseRoll = d6 + defense + defenseBonus + fortBonus  + Σ(ally-def d3s)
hit         = attackRoll > defenseRoll
crush       = attackRoll >= 2 × defenseRoll  → 2 damage
counter     = defenseRoll >= 2 × attackRoll  → 1 damage to attacker
```
Gang-up d3: attacker has ≥1 ally adjacent to defender. Ally-def d3: defender has ≥1 ally adjacent to attacker.

### Entity Stats
| Type | HP | ATK | DEF |
|------|----|-----|-----|
| Hero | 14 | 3 | 2 |
| Witch | 10 | 2 | 2 |
| Survivor | 2–4 | 1–3 | 2–3 |
| Zombie | 2 | 2 | 0 |
| Minion | 2 | 1 | 0 |
| Wood Golem | 4 | 2 | 3 |
| Iron Golem | 6 | 3 | 4 |

### Fog of War
Active when any side is AI-controlled. Hero-side sight: 3 in DAY, 2 in DAWN/DUSK, 1 in NIGHT. SCOUT survivors add +1. AI logs replaced with atmospheric fog messages when active.

### Rest Healing
Hero ends turn in INN/CHURCH: +3 HP. Any other building: +1 HP. Power Node: +1 HP (including NIGHT).

### Node Scoring
Each dawn and dusk: whoever holds more nodes scores 1 point. Sweep all 3 at any checkpoint = instant win. First to 3 cumulative points wins.

---

## Map Generation

Seeded, procedural. Sequence:
1. Fill 13×11 with grass.
2. Carve a meandering single-tile river (cols 2–10, random drift).
3. INN + GRAVEYARD in opposite corners; scatter remaining buildings in clusters (65% clustering).
4. MST (Kruskal's) of all buildings; BFS road paths between edges; up to 4 river-crossing bridges.
5. Forest clusters from 12 seed positions (70% primary / 40% secondary spread).
6. 10 dirt patches for texture.
7. 3 Power Nodes (minimum separation, no buildings).
8. Hero starts at INN, Witch at GRAVEYARD.
9. 15 hidden survivors (13 in buildings, 2 on terrain) flagged as `tile.hiddenSurvivor = true`.

---

## Map Size, Balance & Game Length

### Map size rationale
The 13×11 grid (143 tiles) is intentionally compact. Design goals:

- **Early contact:** factions start in opposite corners (~10–14 hex distance). With normal movement, they can reach mid-map by round 3–5, keeping early exploration meaningful without a long setup phase.
- **Three contested zones:** the river acts as a soft dividing line; one node typically sits near each starting corner with a third in the mid-map, creating a natural three-way tug-of-war.
- **Resource density:** 15 survivors + loot across 143 tiles keeps the economy active without making either side resource-starved or overwhelmed.

If you resize the map, recalibrate: survivor count, node count, bridge count, and forest seed count proportionally. The river column range (`cols 2–10`) should also be adjusted to keep it centered.

### Target game length
A balanced game should last **15–25 rounds** (~2–3 full 8-round cycles). This gives:
- 4–6 scoring checkpoints (dawn + dusk per cycle), making the node track meaningful.
- Enough time for both sides to recruit survivors/minions and hit 2–3 resource runs before a decisive engagement.
- Typical kill-win games end around round 10–18; node-score wins around round 16–24.

Games consistently ending before round 10 suggest the map is too small, starting positions too close, or combat too lethal. Games running past round 30 suggest the map is too large, healing too strong, or win thresholds too high.

### Balance targets (measured via `scripts/headless.js`)
Run `node scripts/headless.js 1000` and check the output for:

| Metric | Healthy range | Notes |
|--------|---------------|-------|
| Hero win rate | 45–55% | Kill + node wins combined |
| Kill-win share | 40–60% of wins | Too high = map is a deathmatch; too low = node rushing dominant |
| Average game length | 15–25 rounds | See above |
| Witch node-sweep wins | < 20% of witch wins | Instant-sweep wins indicate node density is too easy to exploit |

Use `node scripts/combat-sim.js` to verify hit/crush/counter rates after any stat or formula changes. Expected baseline: ~45–55% hit rate, ~10–15% crush rate, ~8–12% counter rate in an even matchup.

---

## Key Tunable Constants

| Constant | File | Default | Purpose |
|----------|------|---------|---------|
| `MAP_COLS`, `MAP_ROWS` | `hex.js` | 13, 11 | Grid dimensions |
| `HEX_SIZE` | `hex.js` | 30 | Base hex radius (px) |
| `CYCLE_LENGTH` | `game.js` | 8 | Rounds per day/night cycle |
| `THINK_DELAY_MS` | `ai.js` | 600 | AI action delay (ms) — unused in planning model |
| `CLUSTER_CHANCE` | `map.js` | 0.65 | Building clustering probability |
| `TURN_TIMEOUT_MS` | `server/lobby.js` | 90 000 | Auto-submit empty plan if human times out |

Loot tables: edit `src/loot.config.js` — weights are relative integers; valid types: `wood`, `metal`, `herbs`, `food`, `silver`, `scripture`, `weapon:sword/axe/shield/bow/staff/dagger`, `horse`, `nothing`.

---

## Survivor Roster (12 characters, drawn without replacement per game)

| Name | Role | Ability |
|------|------|---------|
| John O'Connor | Innkeeper | FORTIFY_DOUBLE |
| Mary Quinn | Nurse | HEAL |
| Thomas Putnam | Blacksmith | BRAWLER |
| Abigail Foster | Herbalist | HERBALIST |
| Samuel Cooper | Militia Sergeant | INSPIRE |
| Father Crane | Parish Priest | RALLY |
| Hannah Marsh | Baker | STURDY |
| Ezra Boone | Trapper | SCOUT |
| Constance Bell | Schoolteacher | HERBALIST |
| Isaac Graves | Gravedigger | STURDY |
| Patience Cole | Midwife | HEAL |
| Silas Holt | Farmhand | BRAWLER |

---

## Coordinate System

Tiles stored and iterated in **offset coordinates** `(col, row)`, keyed as `"col,row"` strings.
All hex math (distance, range, neighbors) converts to/from **axial** internally.
`hexKey(col, row)` centralizes the string key format.

---

## CSS Conventions

All palette colors defined as CSS custom properties on `:root`: `--bg`, `--hero`, `--witch`, `--day`, `--night`, etc. Dark gothic theme: deep purples, aged golds, desaturated greens. Canvas colors in `tiles.js`/`entities.js` mirror these variables manually.
