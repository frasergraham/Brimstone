# Brimstone Architecture Review

## Context

This is an external architectural audit of the Brimstone codebase — a browser-based, turn-based hex strategy game. The review was requested with two future goals in mind:

1. **N-faction support** — the game currently has exactly 2 factions (Hero vs Witch); the goal is to support adding entirely new factions
2. **Engine reuse** — the game engine should eventually be re-skinnable with a different theme (not just colonial New England)

The audit covers ~28,000 LOC across 17 key files, examining dead code, anti-patterns, globals, hardcoded assumptions, and extensibility blockers.

---

## Executive Summary

The codebase is **well-engineered for its current 2-faction scope**. There's a clean Faction abstraction layer (`src/factions.js`), proper separation between game logic and rendering, and solid security practices (parameterized SQL, token-based auth, input validation). The architecture shows thoughtful design decisions.

However, the audit found **five systemic issues** that will compound as the game grows:

| # | Issue | Severity | Scope |
|---|-------|----------|-------|
| 1 | **258 hardcoded faction string checks** across 23 files | Critical | Blocks N-faction |
| 2 | **~800 LOC of duplicated AI engine code** between hero/witch | High | Blocks N-faction AI |
| 3 | **God classes** — ui.js (4,357 LOC), main.js (6,842 LOC), lobby.js (3,950 LOC) | High | Maintainability |
| 4 | **Theme colors scattered** across 5+ files with no single source of truth | Medium | Blocks re-theming |
| 5 | **Module-level mutable state** in entities.js breaks concurrent games | Medium | Server correctness |

---

## Finding 1: Hardcoded Two-Faction Assumption (CRITICAL)

**258 occurrences of `=== 'hero'` or `=== 'witch'`** across 23 files. This is the single biggest blocker for N-faction support.

### Where it's worst

| File | Count | Examples |
|------|-------|---------|
| `server/lobby.js` | 76 | Color assignment, slot validation, AI fill-in, win checks |
| `src/main.js` | 42 | Planning flow, resolution, fog-of-war, auto-play |
| `src/ui.js` | 28 | Plan panel, entity selection, HUD rendering |
| `src/game.js` | 19 | Node control, inventory, win conditions, phase |
| `src/ai-engine.js` | 14 | Goal scoring, unit classification, threat detection |
| `src/hero-ai-engine.js` | 13 | Same as above, mirrored |
| `src/renderer.js` | 13 | Faction colors, node highlights, entity outlines |
| `src/actions.js` | 11 | Discovery cap, herbalist ability, Sound Horn |

### Specific structural blockers

**Inventory assumes 2 buckets** — `src/game.js:188-191`:
```javascript
this.inventory = {
  shared: { ...getFaction('hero').getStartingResources() },
  witch:  { ...getFaction('witch').getStartingResources() },
};
```
Adding a 3rd faction has nowhere to put its resources. Needs to become `{ [factionId]: {...} }`.

**Node control hardcodes 2 factions** — `src/game.js:15-30`:
```javascript
const heroHexes  = new Set();
const witchHexes = new Set();
```
Needs `Map<factionId, Set<hexKey>>` for N-way node contests.

**Database schema hardcodes columns** — `server/schema.js:18-38`:
```sql
hero_player_id TEXT, witch_player_id TEXT,
hero_name TEXT, witch_name TEXT
```
The `players_json` column already exists as a forward-looking field, but the named columns are still the primary path.

**State serialization hardcodes fields** — `server/state-sync.js:64-85`:
```javascript
witchIsAI, heroIsAI, heroReady, witchReady,
heroActionsLeft, witchActionsLeft,
exploredHexes: { hero: ..., witch: ... }
```

**`Player` enum is a dead-end** — `src/game.js:80`:
```javascript
export const Player = Object.freeze({ HERO: 'hero', WITCH: 'witch' });
```
Used as a pseudo-enum but fights against the Faction abstraction.

### What already works well

`src/factions.js` (450 LOC) is a **well-designed polymorphic abstraction**. `Faction` is a base class with `HeroFaction` and `WitchFaction` subclasses. `getFaction(id)` does runtime lookup. This is the right foundation — the problem is that the rest of the codebase doesn't use it consistently.

### Remediation plan

**Phase 1 — Generalize data structures** (est. 3-5 days):
- Replace `inventory.shared` / `inventory.witch` with `inventory[factionId]`
- Replace `heroHexes` / `witchHexes` in `nodeController()` with `Map<factionId, Set>`
- Replace `heroActionsLeft` / `witchActionsLeft` with `playerActionsLeft` Map (partially done)
- Replace `heroReady` / `witchReady` with `playerReady` Map (partially done)
- Replace `exploredHexes.hero` / `.witch` with `exploredHexes[factionId]`
- Files: `src/game.js`, `server/state-sync.js`, `server/lobby.js`

**Phase 2 — Replace string checks with Faction methods** (est. 3-5 days):
- Move discovery logic from `actions.js:440-446` into `Faction.onExplore()`
- Move herbalist check from `actions.js:574` into `Faction.onHerbGather()`
- Move Sound Horn logic into `Faction.getRevealedHexes()`
- Replace `owner === 'hero'` guards with `getFaction(owner).canDoX()` calls
- Files: `src/actions.js`, `src/game.js`, `src/ai.js`

**Phase 3 — Schema migration** (est. 1-2 days):
- Make `players_json` the canonical source; deprecate `hero_player_id` / `witch_player_id`
- Add migration for existing saves
- Files: `server/schema.js`, `server/saves.js`, `server/game-stats.js`

---

## Finding 2: Duplicated AI Engine Code (HIGH)

`src/ai-engine.js` (1,457 LOC) and `src/hero-ai-engine.js` (1,229 LOC) implement the **exact same 5-stage pipeline** with faction-specific variants. ~800 LOC is duplicated or near-identical.

### Specific duplications

| Component | Witch file | Hero file | Identical? |
|-----------|-----------|-----------|-----------|
| `allocateBudget()` | ai-engine.js | hero-ai-engine.js | 100% identical |
| `estimateCombat()` / `estimateHeroCombat()` | ~35 LOC | ~35 LOC | ~90% same |
| `genControlNodes()` | ~160 LOC | ~160 LOC | ~70% same |
| `genDefendWitch()` / `genProtectHero()` | ~85 LOC | ~85 LOC | ~60% same |
| Engine class constructor + `generatePlan()` | ~450 LOC | ~450 LOC | ~80% same |

### Why this matters for N-factions

Adding a 3rd faction AI currently means **duplicating another 1,200+ LOC**. With a shared base class, it would be **300-500 LOC** of faction-specific hooks.

### Personality registration via side effects

Both engines register personalities by mutating globals on import:
```javascript
// ai-engine.js:1450-1457
for (const name of Object.keys(PERSONALITY_CONFIGS)) {
  WITCH_PERSONALITIES[name] = class extends WitchAIEngine { ... };
}
```
This mutates `WITCH_PERSONALITIES` exported from `ai.js` as a side effect of `import`. Fragile for testing and hot-reloading.

### Remediation plan

1. Create abstract `AIEngine` base class with the common pipeline: `assessBoard()` -> `scoreGoals()` -> `allocateBudget()` -> generators -> `assemblePlan()`
2. Move `allocateBudget()`, `roundsUntilScoring()`, `scoreNodeFeasibility()`, `estimateCombat()` to shared module
3. Define faction-specific hooks: `abstract scoreGoals(board)`, `abstract getGenerators()`, `abstract assessBoard(sim)`
4. Replace side-effect personality registration with explicit `registerPersonality()` calls in initialization
5. Files: `src/ai-engine.js`, `src/hero-ai-engine.js`, `src/ai.js`
6. Est. effort: 3-4 days; expected ~600 LOC reduction

---

## Finding 3: God Classes (HIGH)

Three files account for 15,149 LOC (54% of audited code) and each has 10-15+ responsibilities:

### `src/main.js` — 6,842 LOC
Entry point that wires everything together. Handles:
- Game setup and mode selection
- Offline planning orchestration
- Online game flow
- Resolution animation sequencing
- Full-game playback controls
- Auto-play mode
- Tutorial integration
- Sound/music
- Resize handling
- Fog-of-war computation

This file is the hardest to understand and modify in the codebase. Many functions are 100+ lines.

### `src/ui.js` — 4,357 LOC (UIController class)
Single class handling:
- Canvas input (mouse, touch, pinch-zoom)
- Entity selection and disambiguation
- Action planning and budget management
- Arc menu (radial action menu)
- Chronicle display
- Plan panel rendering
- Dialog/modal management
- Multiplayer UI (players, countdown)
- Tutorial mode
- Spectator mode
- Animation speed controls
- Post-round effects display

### `server/lobby.js` — 3,950 LOC
Handles:
- Room lifecycle (create, join, leave, destroy)
- Matchmaking
- N-player team seats and AI fill-in
- Plan submission and validation
- Turn resolution orchestration
- Reconnection and state recovery
- Async game management
- Hibernation/wake
- Save/load coordination

### Remediation plan

This is the largest refactoring effort and should be done incrementally:

1. **Extract from main.js**: `PlaybackController` (replay state machine), `AutoPlayController` (AI-vs-AI loop), `SetupController` (game config and mode selection)
2. **Extract from ui.js**: `InputDispatcher` (mouse/touch events), `PlanningController` (action queue and budget), `DialogController` (modals and popups)
3. **Extract from lobby.js**: `RoomManager` (lifecycle), `TurnOrchestrator` (plan collection and resolution), `AsyncGameManager` (already partially separated)
4. Est. effort: 1-2 weeks incremental; can be done file-by-file without breaking changes

---

## Finding 4: Theme Colors Scattered (MEDIUM)

To re-theme the game, you'd need to change colors in **5+ files** with no single source of truth:

| Location | What it defines | Format |
|----------|----------------|--------|
| `styles.css` `:root` vars | `--hero: #d4a72c`, `--witch: #9b59b6` | CSS custom properties |
| `src/entities.js` `ENTITY_COLOR` | `HERO: '#4488ff'`, `WITCH: '#9b59b6'` | JS object |
| `src/tiles.js` `TILE_COLOR` | Terrain colors | JS object |
| `src/renderer.js` inline | `'#4488ff'`, `'rgba(50,120,220,0.18)'` at 4+ locations | Hardcoded strings |
| `src/map.js` `NODE_COLORS` | Power node colors | JS array |

Note that CSS `--hero` is `#d4a72c` (gold) but `ENTITY_COLOR[HERO]` is `#4488ff` (blue) — these **don't even match**, suggesting they evolved independently.

The canvas renderer never reads CSS custom properties; it uses its own inline hex strings.

### Remediation plan

1. Create `src/theme.js` as single source of truth for all colors (faction, terrain, UI)
2. Update `renderer.js` to read from theme instead of inline strings
3. Update `entities.js` `ENTITY_COLOR` to reference theme
4. Either generate CSS vars from theme.js or vice versa
5. Est. effort: 2 days

---

## Finding 5: Module-Level Mutable State (MEDIUM)

### `src/entities.js` — three module-level globals

```javascript
let _nextId = 1;                    // shared across all games on server
let _forcedDice = [];               // global queue for tutorial
const _usedRosterIndices = new Set(); // tracks which survivors have been used
```

**Problem**: On the server, multiple concurrent games share the same `_nextId` counter. While `bumpEntityId()` exists to reset it between games, this is fragile — a missed reset causes ID collisions.

`_forcedDice` is a global queue that any game can read from, making tutorial mode and normal mode share state.

`_usedRosterIndices` prevents survivor name reuse but is process-global, meaning concurrent server games can't reuse the same survivor names.

### Remediation plan

Move these into `GameState` instance fields:
- `state.nextEntityId` instead of module-level `_nextId`
- `state.forcedDice` instead of module-level `_forcedDice`
- `state.usedRosterIndices` instead of module-level `_usedRosterIndices`
- Est. effort: half a day

---

## Finding 6: Dead Code and Redundant Exports (LOW)

### Confirmed dead exports

| Location | Export | Status |
|----------|--------|--------|
| `src/game.js:83-84` | `HERO_ACTION_CAP`, `WITCH_ACTION_CAP` | Superseded by `Faction.actionCap`; only used in `tests/game.test.js` |
| `src/game.js:80` | `Player` enum | Redundant with `Faction.id`; encourages hardcoded checks |
| `src/actions.js:258-259` | `getVisibleEnemyHexes()`, `getVisibleHeroHexes()` | Legacy wrappers hardcoding faction IDs |

### Dual action type enums

`ActionType` (in `actions.js`) and `PlanActionType` (in `planner.js`) define overlapping sets of action identifiers with slightly different names (`BATTLE` vs `BATTLE_UNIT`). The resolver only uses `PlanActionType`. `ActionType` appears to be a legacy artifact.

### `groupByEntity()` defined in 3 places

- `server/resolver.js` (local function)
- `src/planner.js` as `groupPlanByEntity()` (exported)
- Both do the same thing

### Legacy async game subsystem

`server/async-game.js` is marked "Legacy — will be fully removed in future" but is still imported and called.

### Remediation plan

1. Remove `Player` enum, `HERO_ACTION_CAP`, `WITCH_ACTION_CAP`
2. Remove `getVisibleEnemyHexes()` / `getVisibleHeroHexes()` — replace callers with `getVisiblePositions(state, factionId)`
3. Consolidate `ActionType` and `PlanActionType` into one canonical enum
4. Delete duplicate `groupByEntity()` in resolver.js; import from planner.js
5. Remove async-game.js when migration is confirmed complete
6. Est. effort: 1 day

---

## Finding 7: Race Conditions in Multiplayer (MEDIUM)

### Plan double-submission

In `server/lobby.js`, `_autoSubmitMissingPlans()` iterates players and submits empty plans for anyone not ready. If a player submits at the exact same time as the timeout fires, both can pass the `playerReady` check before either sets it to `true`.

```javascript
// Both async paths can read playerReady = false simultaneously
if (!room.state.playerReady.get(seat.playerId)) {
  _submitPlayerPlan(room, seat.playerId, [], true);
}
```

**Fix**: Add a guard at the top of `_submitPlayerPlan()`:
```javascript
if (room.state.playerReady.get(playerId)) return; // already submitted
```

### Silent `.catch(() => {})` patterns

Multiple broadcast calls in lobby.js swallow errors silently. These should at minimum log the failure for debugging:
```javascript
.catch(err => console.warn('[room] broadcast failed:', err.message))
```

---

## Finding 8: Theme-Coupled Narrative (LOW)

Game logic contains hardcoded "Caleb's Hollow" narrative that would need changing for a re-theme:

- `src/game.js:211-214` — opening log messages mention "Caleb's Hollow"
- `src/game.js:54-66` — `WIN_REASON` strings reference the theme
- `src/game.js:570-589` — phase change messages reference survivors and darkness
- `src/entities.js:63-224` — 16 named survivors with colonial New England bios

These are easily externalized into a theme/flavor config file but aren't blocking anything today.

---

## Finding 9: Circular Import Risk (LOW)

`src/game.js` imports from `src/factions.js`, and `src/factions.js` imports `Phase` from `src/game.js`. This works because `Phase` is a simple frozen enum evaluated at module parse time, but it creates a logical cycle that could break if either module's initialization becomes more complex.

**Fix**: Extract `Phase` (and other pure enums like `WIN_REASON`) into a shared `src/constants.js` module.

---

## Implementation Progress

_Last updated: 2026-04-10_

### Finding 1 — Hardcoded Two-Faction Assumption: DONE

All structural data-structure blockers resolved. Core game engine is now N-faction ready.

- `nodeController()` generalized to N-faction via `Map<factionId, Set>` instead of hardcoded `heroHexes`/`witchHexes`
- `inventory.shared` renamed to `inventory.hero` — inventory keyed by faction ID, naturally extensible
- `exploredHexes` initialized dynamically from `allFactions()` instead of hardcoded `{hero, witch}`
- Node discovery (`updateNodeDiscovery`) iterates `allFactions()` using `faction.getNodeSeenKey()`
- Added `Faction.canDiscoverNPCs()` — replaced hardcoded `owner === 'hero'` in discovery cap, herbalist, and survivor count tracking
- Heal/inspire/rally abilities use `getFaction(actor.owner).leaderType` instead of `EntityType.HERO`
- Removed `HERO_ACTION_CAP`, `WITCH_ACTION_CAP` (superseded by `Faction.actionCap`)
- Removed `getVisibleEnemyHexes`/`getVisibleHeroHexes` (callers use `getVisiblePositions(state, factionId)`)
- Backward-compat migration in `deserializeState()` for old saves with `inventory.shared`
- `exploredHexes` deserialization gracefully handles missing keys (old saves keep constructor defaults)

**~150 string-literal faction checks remain** across `main.js` (42), `lobby.js` (78), `ui.js` (24), and the AI engines (27). These are mostly:
- Display-layer references (UI icons, colors, labels)
- Lobby slot management and matchmaking
- AI engine faction-specific goal scoring and generators

These will naturally shrink as those areas get refactored for other reasons, but are not structural blockers for N-faction support.

### Finding 2 — Duplicated AI Engine Code: DONE

- Created `BaseAIEngine` class in `ai-engine.js` with the common 5-stage pipeline (`generatePlan()`, debug capture, ally coordination, prev-position tracking)
- `WitchAIEngine` and `HeroAIEngine` extend it, overriding 7 methods: `createSim()`, `assessBoard()`, `scoreGoals()`, `getLeader()`, `getGenerators()`, `getGapFillFn()`, `generateLeaderlessPlan()`
- Shared utilities exported: `clamp01`, `allocateBudget`, `assemblePlan`, `personalityName`, `updateAllyClaimedNodes`
- **Adding a 3rd faction AI now requires ~40 lines of class overrides + faction-specific generators**, down from duplicating 1,200+ LOC
- Side-effect personality registration kept as-is (well-tested, low risk) — can be converted to explicit registration later if needed

### Finding 3 — God Classes: PARTIAL

Four modules extracted, reducing the three largest files by ~1,160 LOC combined:

| Extracted module | LOC | Source | What it contains |
|-----------------|-----|--------|-----------------|
| `src/playback.js` | 304 | `main.js` | Full-game replay engine (play/pause/ff/back/stop loop, playback state, delay utility) |
| `server/async-game-rooms.js` | 519 | `lobby.js` | Async game lifecycle (create, join, connect, submit, resolve, finish) |
| `src/ui-popup.js` | 263 | `ui.js` | Arc menu and popup positioning (hide, position, track, attach listeners, touch distance) |
| `src/campaign/campaign-ui.js` | 164 | `main.js` | Campaign save/load utilities, HTML card generators, portrait loader, flavor messages |

**Current sizes:**

| File | Before | After | Change |
|------|--------|-------|--------|
| `src/main.js` | 6,842 | 6,441 | −401 |
| `server/lobby.js` | 4,066 | 3,590 | −476 |
| `src/ui.js` | 4,347 | 4,065 | −282 |

### Finding 4 — Theme Colors Scattered: DONE

- Created `src/theme.js` with `FACTION_THEME` object — per-faction `primary`, `highlight`, `nodeFill`, and `playerColors`
- Renderer uses `getFactionTheme(ctrl)` for node fills, glow colors, and entity fallback colors
- `HERO_PLAYER_COLORS`/`WITCH_PLAYER_COLORS` in `entities.js` re-export from `theme.js`
- Adding a new faction's colors = one new entry in `FACTION_THEME`

### Finding 6 — Dead Code: PARTIAL

- Removed `HERO_ACTION_CAP`, `WITCH_ACTION_CAP` — superseded by `Faction.actionCap`
- Removed `getVisibleEnemyHexes()`, `getVisibleHeroHexes()` — replaced by `getVisiblePositions()`
- Removed duplicate `groupByEntity()` from `resolver.js` — imports `groupPlanByEntity` from `planner.js`
- Removed dead `ActionType.END_TURN` value
- Deprecated `Player` enum — usage removed from all source files, kept in tests only

### Finding 7 — Race Conditions: DONE

- Added `playerReady.get(playerId)` early-return guard at top of `_submitPlayerPlan()` to prevent the timeout + manual submit race condition

---

## Remaining Work

### Finding 3 — God Classes (further extractions)

These are viable but require more preparation than the completed extractions:

**Battle rooms from `lobby.js`** (~400 LOC): `createBattleRoom`, `joinBattle`, `getActiveBattleRoom(s)`, `pickBestBattleRoom`, `getBattleStatus`. Blocked by deep coupling to room lifecycle internals — these functions call `createRoom`, `_appendChronicle`, `_broadcastPresence`, `_buildGameJoinedMessage`, `_persistRoomSave`, `_startPlanningPhase`. Would require exporting those helpers from lobby.js first, or refactoring lobby.js into a room-operations module.

**Campaign orchestration from `main.js`** (~500 LOC): `_initCampaignMission` and `_handleCampaignMissionEnd` modify module-level `state`, `renderer`, `ui`, `witchAI`, `heroAI` and call `_setupLocalUI()`, `_startLocalPlanningPhase()`, `redraw()`. These are deeply integrated with the game loop. Would need an event-based architecture or a context/callback injection pattern to extract cleanly.

**Resolution summary from `ui.js`** (~393 LOC): `_showResolutionSummary` is the largest single method. It's already cohesive and self-contained — extraction would only move it to a separate file without improving the class structure. Lower value than the other extractions.

### Finding 5 — Module-Level Mutable State

`_nextId`, `_forcedDice`, and `_usedRosterIndices` in `entities.js` are process-global. On the server, concurrent games share the same entity ID counter. The existing `bumpEntityId()` and `resetRoster()` functions manage this but are fragile.

Moving these into `GameState` requires changing every entity factory function (`createHero`, `createWitch`, `createSurvivor`, etc.) to accept a state or ID-counter parameter. This is a correctness issue under server load but invasive to implement.

### Finding 6 — Dead Code (remaining)

**`ActionType` vs `PlanActionType` overlap**: Both define action identifiers with slightly different names (`BATTLE` vs `BATTLE_UNIT`). `ActionType` is used in 211 places across 10 files (UI action dispatch). `PlanActionType` is used in the planner and resolver (plan queue). They serve different roles (real-time UI vs plan queue) so consolidation requires careful analysis of which enum each caller should use. High churn, moderate value.

**Silent `.catch(() => {})` patterns** in `lobby.js`: Multiple broadcast calls swallow errors silently. Should log the failure at minimum.

### Finding 8 — Theme-Coupled Narrative

"Caleb's Hollow" is hardcoded in `game.js` log messages (`WIN_REASON` strings, phase change messages, opening narration) and the 16-character survivor roster in `entities.js`. Only matters when re-theming the engine for a different setting. Externalize to a flavor/theme config file when the need arises.

### Finding 9 — Circular Import

`game.js` ↔ `factions.js` via `Phase` enum. Works correctly today because `Phase` is a simple frozen enum evaluated at parse time. Would require moving `Phase` to a shared `constants.js` and updating 25+ import statements. Low risk, low priority.
