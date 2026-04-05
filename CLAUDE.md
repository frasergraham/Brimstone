# Brimstone — Claude Context

## Development Guidelines

These directives apply to all code changes — follow them without exception.

### 1. Tests are mandatory (with exceptions)
- Every change must be accompanied by tests.
- When fixing a bug: **write a failing test first**, then make it pass (red → green).
- New features require tests covering the happy path and key edge cases.
- **Exception:** Small, visual-only changes (e.g. adding a label, tweaking CSS, rearranging UI elements) do not require tests. Use judgement — if there's no logic to verify, skip the test.
- Tests live in `tests/` and are run with `npm test`.
- Be conscious of test runtime. Avoid heavyweight DOM mocks or slow setup for trivial assertions. Keep the suite fast to support rapid iteration.

### 2. Run tests before every push
- Always run `npm test` before pushing. Do not push if tests fail.
- If a pre-existing test breaks due to your change, fix it — don't skip or delete it.

### 3. Gameplay changes require balance validation
- After any change to combat, actions, phase effects, entity stats, or map generation, run simulations:
  ```bash
  node scripts/headless.js 500 standard    # check win rates and game length
  node scripts/combat-sim.js 200           # verify hit/crush/counter rates
  node scripts/ai-matrix.js 50             # check cross-personality balance
  ```
- Compare results against the balance targets output by the scripts.
- Document simulation results in the PR/commit message if they differ meaningfully from baseline.

### 4. Online and offline parity
- Offline mode (`src/main.js`) and online mode (`server/lobby.js`) must stay in sync.
- Any change to game rules, state shape, planning flow, or AI behaviour needs to be applied to **both** orchestration layers.
- New state fields must be added to `server/state-sync.js` serialization or online mode will silently drop them.
- After parity-sensitive changes, verify with `node scripts/headless.js 100 standard --players 2` in addition to the standard headless runner.

---

## Project Overview

Browser-based, turn-based hex-grid strategy game set in cursed colonial New England (Salem). Two asymmetric factions — **Hero** vs **Witch** — fight across a procedurally-generated map.

**Win conditions:**
- Hero: slay the Witch, or hold more Power Nodes at enough dawn/dusk scoring checkpoints.
- Witch: slay the Hero, or seize all 3 Power Nodes, or win on node-score points.

**Game modes:** Human vs AI, Two Players, AI vs AI auto-play, **Online multiplayer (1–4 players per side).**

No build step. No dependencies. Pure vanilla JS ES modules, HTML5 Canvas, plain CSS.

---

## Run Commands

```bash
npm run dev    # Dev server via npx serve (port 3000)
npm start      # Python HTTP server fallback
npm test       # Run all tests

node scripts/headless.js [count] [size]   # AI-vs-AI balance testing; size: skirmish|standard|regional|campaign
node scripts/headless.js [count] [size] --players N  # N-player AI balance runner (1v1 to 4v4)
node scripts/headless.js --render [size] [--players N] [out.gif]  # Render game as animated GIF
node scripts/combat-sim.js [rounds]       # Combat stats report
node scripts/ai-matrix.js [count]         # Every hero personality vs every witch personality matrix
node scripts/release.js [patch|minor|major] [--dry-run]  # Bump version, tag, build+upload iOS to App Store Connect
node scripts/release.js patch --ios                      # Same, but also bump iOS MARKETING_VERSION (triggers App Store review)
```

### Local Dev Server with Persistence

```bash
npm run dev    # Starts server.js with DB_PATH=./data/brimstone.db (SQLite persistence)
```

This runs the full Express server on port 3000 with WebSocket support, game saves, leaderboard, and stats all persisting to `data/brimstone.db`. Open `http://localhost:3000` in a browser.

### Preferred Local Development Mode

The preferred workflow for local development is: run `npm run dev` on the laptop, then build and deploy the iOS app with `--env=local` so the phone connects to the local server. This gives full multiplayer/persistence testing on a real device against the local backend.

```bash
npm run dev                    # 1. Start local server (keep running)
npm run cap:sync:ios:local     # 2. Sync iOS build pointing at laptop's LAN IP
# 3. Build + deploy to phone (see iOS Build section below)
```

### iOS Build (Capacitor)

```bash
npm run cap:sync:ios           # Copy web assets to www/ (dev env) and sync to ios/
npm run cap:sync:ios:prod      # Same but with production server URL
npm run cap:sync:ios:local     # Same but pointing at local dev server
npm run cap:open:ios           # Open Xcode project for manual build/run
```

**Building and running on a physical device from CLI:**

```bash
npm run cap:sync:ios
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination "id=<DEVICE_UDID>" -derivedDataPath /tmp/brimstone-ios-build \
  clean build
xcrun devicectl device install app --device <DEVICE_UDID> \
  /tmp/brimstone-ios-build/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <DEVICE_UDID> com.calebshollow.game
```

List connected devices with `xcrun xctrace list devices`.

**Important:** Use `/tmp` (or another non-iCloud path) for `-derivedDataPath` — the project directory has iCloud/Finder extended attributes that break codesigning.

### Electron Build

```bash
npm run electron:dev           # Run Electron app in dev mode (local server)
npm run electron:dev:prod      # Run Electron app pointing at production server
npm run electron:package:mac   # Package for macOS (no publish)
npm run electron:package:win   # Package for Windows (no publish)
npm run electron:build:mac     # Build macOS distributable to /tmp/brimstone-electron-dist
npm run electron:build:win     # Build Windows distributable
```

---

## Directory Structure

```
index.html          # Single-page shell with all UI overlay elements
admin-stats.html    # Admin dashboard for game analytics and balance metrics
styles.css          # Dark gothic theme; CSS custom properties on :root
src/
  app-mode.js       # AppMode state machine — centralized mode enum and transitions
  main.js           # Entry point — wires all modules, setup screen flow, resize
  game.js           # GameState class: tiles, entities, phase cycle, turn/victory logic
  entities.js       # Entity class + factory functions; ownerId field; static resolveCombat()
  actions.js        # All action validation (getValidActions) and execution functions
  map.js            # Procedural map generator; MAP_SIZES export (4 sizes); generateMultipleStarts()
  renderer.js       # Canvas 2D renderer — multi-pass, zoom/pan, fog, animations, per-player outlines
  ui.js             # UIController — DOM events, click routing, popups, dialogs; player status panel
  ai.js             # WitchAI and HeroAI — plan generation + BFS pathfinding;
                    #   6 personality subclasses + HERO_PERSONALITIES / WITCH_PERSONALITIES registries
  multiplayer.js    # MultiplayerClient — WebSocket client, MirrorState, MirrorEntity
  tiles.js          # Tile/Building/Resource/Weapon enums, colors, icons, rollLoot()
  hex.js            # Pure hex math: offset↔axial, neighbors, distance, range, pixel; MAP_SIZES
  loot.config.js    # Externalized weighted loot tables (primary tuning file)
  planner.js        # PlanActionType enum, computeGhostState(), validatePlanAction(), snapEntity()
  version.js        # Game version string — used for save compatibility checks
server/
  resolver.js       # resolvePlans() (legacy 2P) + resolvePlansMP() (N-player); snapshotEntities()
  lobby.js          # Matchmaking, room lifecycle, N-player team seats, AI fill-in; resumeGame()
  state-sync.js     # serializeState() + deserializeState() — snapshot for network/save
  auth.js           # Player auth / session tokens
  db.js             # SQLite singleton — creates default DB backend
  db-backend.js     # DB abstraction layer wrapping better-sqlite3; supports in-memory DBs for testing
  schema.js         # Extracted DDL (table definitions for all DB tables)
  saves.js          # upsertSave / deleteSave / getSave / getActiveSaves / pruneStaleAndIncompatibleSaves
  game-stats.js     # Records per-game statistics (winner, rounds, kills, summons, personalities, map size)
  leaderboard.js    # Win/loss recording and ranking
scripts/
  headless.js       # Headless AI-vs-AI runner; supports 4 map sizes via argv; optionally records stats to DB
  headless-mp-net.js # N-player network-based headless runner
  combat-sim.js     # Scenario matrix: hit rates, crush rates, expected damage
  ai-matrix.js      # Runs every hero personality vs every witch personality; renders result matrix
  release.js        # Automated release: version bump, changelog generation, tag, fast-forward merge to master
```

---

## App Mode State Machine

The app uses a centralized mode enum (`src/app-mode.js`) instead of scattered boolean flags. All mode transitions go through `setMode()`, and every module queries the mode via helper functions.

### Modes

| Mode | Description |
|------|-------------|
| `MENU` | Browsing menus, lobby, game list. Game callbacks are no-ops. |
| `PLANNING` | In a game, building a plan (not yet submitted). |
| `SUBMITTED` | Plan locked, waiting for opponents. |
| `RESOLVING` | Watching turn resolution animation (current round). |
| `SUMMARY` | Post-resolution summary dialog. |
| `PLAYBACK` | Full-game replay viewer (completed games only, own HUD). |
| `SPECTATING` | Read-only live game view. |

### RESOLVING vs PLAYBACK

- **RESOLVING** is the current round's animation — happens live when both sides submit, on reconnect if a round was missed, or when the player taps "replay last turn". Uses the normal game renderer and UI.
- **PLAYBACK** is the full-game replay from round 1, only available after game-over. Has its own play/pause/ff/back/stop controls. Always exits to MENU.

### Transition Map

```
MENU → PLANNING       initOnline() or _startLocalPlanningPhase()
MENU → SPECTATING     initSpectator()
PLANNING → SUBMITTED  plan submitted
SUBMITTED → RESOLVING onResolutionComplete
RESOLVING → SUMMARY   animation completes
RESOLVING → PLANNING  inline last-turn replay finishes
SUMMARY → RESOLVING   user re-watches round
SUMMARY → PLANNING    user dismisses, next round
SUMMARY → PLAYBACK    game over, full replay
SUMMARY → MENU        game over, exit
PLAYBACK → MENU       replay ends or stopped
```

### Key helpers

- `isInGame()` — true when not MENU or SPECTATING
- `isAnimating()` — true when RESOLVING or PLAYBACK
- `shouldBufferMessages()` — true when RESOLVING, SUMMARY, or PLAYBACK (incoming server messages are queued)

### Rules

- **main.js owns all mode transitions** — ui.js reads the mode via `ui.appMode` property (synced by `onModeChange`) but never calls `setMode()`.
- **Playback sub-state** (`_playback` object in main.js) holds pause/abort/speed flags, only meaningful during PLAYBACK mode. Reset via `_resetPlayback()`.
- **`_autoplay`** remains a separate boolean — it's a game config flag, not a mode.

---

## Heartbeat State Sync

The server sends a JSON `heartbeat` message alongside the WebSocket ping every 15 seconds to clients in active games. Contains `roomId`, `round`, `planningPhase`, `gameOver`, and `playersReady`. The client compares this against local state and sends `requestState` if a mismatch is detected (e.g. missed a planning phase or game-over event). The server responds to `requestState` with a full state resync via `resumeGame()`.

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
- Execute functions return `{ success, log, cost }`; caller calls `state.spendAction(result.cost)`.
- Headless scripts import `src/` directly — all game logic is DOM/Canvas-free.
- Every entity has an `ownerId` (player UUID) linking it to a specific player in N-player games.

---

## Online vs Offline Modes

The game runs in two distinct modes sharing core logic but with separate orchestration layers. **Changes to one often require parallel changes in the other.**

### Shared code (affects both modes equally)
| File | What it governs |
|------|----------------|
| `src/game.js` | State lifecycle, phase cycle, scoring, `endRound()` |
| `src/actions.js` | All action validation and execution — single source of truth for rules |
| `src/entities.js` | Entity stats, combat resolution |
| `src/planner.js` | Plan validation, ghost-state projection |
| `server/resolver.js` | Lockstep plan resolution — imported by both `src/main.js` and `server/lobby.js` |
| `src/ai.js` | AI plan generation — imported by both modes |

### Parity rules
- **Rule changes** (combat, action costs, phase effects, scoring): edit `actions.js` or `game.js` — automatically applies to both modes.
- **New state fields**: must also be added to `server/state-sync.js` serialization, or online mode will silently drop them. Also verify `deserializeState()` restores the field correctly.
- **Planning flow changes** (phase triggers, timeout behavior, budget logic): `src/main.js` and `server/lobby.js` are the two orchestration layers — they must stay in sync manually.
- **UI-only changes** (`src/ui.js`) affect both modes' client display but not server logic.

---

## Simultaneous-Turn Planning System

Each round uses **simultaneous planning** instead of sequential turns:

1. **Planning phase** — both factions independently build an ordered action queue (`PlanAction[]`).
2. **Submission** — each side submits; the server (or local `main.js`) waits for both.
3. **Resolution** — `resolvePlans()` / `resolvePlansMP()` in `server/resolver.js` executes plans in paired lockstep steps.
4. **End of round** — `state.endRound()` advances phase, applies hazards, scores nodes.

### Key files

| File | Role |
|------|------|
| `src/planner.js` | `PlanActionType` enum, `computeGhostState()`, `validatePlanAction()` |
| `server/resolver.js` | Plan resolution → `StepRecord[]`; `ResEventType` enum |
| `src/game.js` | `startPlanning()`, `submitPlan()`, `endRound()` |
| `src/ai.js` | `WitchAI.generatePlan()`, `HeroAI.generatePlan()` |
| `src/main.js` | Local resolution loop |
| `server/lobby.js` | Online resolution loop |

### PlanAction types
`MOVE`, `BATTLE_UNIT`, `BATTLE_HEX`, `SUMMON`, `USE_ITEM`, `EQUIP_WEAPON`, `EXPLORE`, `FORTIFY`, `USE_ABILITY` — see `PlanActionType` enum in `src/planner.js`.

### Ghost overlay
`computeGhostState(state, plan)` projects entity positions through planned moves and returns `StepDescriptor[]`. The renderer draws dashed arrows with numbered badges via `_drawPlanOverlay()`. During planning, `_getProjectedPos(entityId)` in `ui.js` enables multi-move chaining within a single plan.

---

## Game Mechanics

### Phase Cycle
`DAWN (1) → DAY (3) → DUSK (1) → NIGHT (3)` — 8 rounds per cycle. Dawn/dusk trigger node scoring. Day favors Hero; night favors Witch. Phase effects (attrition, bonuses) are defined in `game.js` `endRound()`.

### Actions
Move, Explore, Battle, Fortify (hero), Summon (witch), Use Item, Equip Weapon, Use Ability. Costs and rules are defined in `src/actions.js` — refer to the code for current values as they are frequently tuned.

### Combat
Dice-based with attack/defense rolls, phase bonuses, gang-up bonuses, and fortification. See `Entity.resolveCombat()` in `src/entities.js` for the current formula. Key outcomes: hit (1 damage), crush (2 damage), counter (1 damage to attacker).

### Entity Types
Hero, Witch, Survivor (recruited by hero), Zombie (encountered), Minion/Wood Golem/Iron Golem (summoned by witch). Stats are defined in `src/entities.js` factory functions — check the code for current values.

### AI Personalities
6 personality subclasses in `src/ai.js`, registered in `HERO_PERSONALITIES` and `WITCH_PERSONALITIES`:
- **Hero:** Berserker (aggressive), Sentinel (defensive), Scavenger (explore-first)
- **Witch:** Berserker (combat-focused), Hoarder (resource + high-tier summons), Swarm (cheap minion spam)

### Fog of War
Active when any side is AI-controlled. Sight range varies by phase. AI logs replaced with atmospheric fog messages.

### Tracking Counters
`GameState` tracks `heroKills`, `witchKills`, and `witchSummonCount` — incremented in `actions.js`, persisted via state-sync, and recorded to the game stats database after each game.

---

## Map Generation

Seeded, procedural. Four preset sizes defined in `MAP_SIZES` (`src/hex.js`): Skirmish, Standard, Regional, Campaign. If you resize the map, recalibrate survivor count, node count, bridge count, and forest seed count proportionally.

Generation sequence: grass fill → river → buildings (INN + GRAVEYARD in opposite corners, clustered scatter) → MST road network with bridges → forest clusters → dirt patches → 3 Power Nodes → starting positions → hidden survivors.

---

## Save System (Online Mode)

Games are auto-persisted to SQLite (`data/brimstone.db`, override with `DB_PATH`) after every round via `server/saves.js`.

- `serializeState()` / `deserializeState()` in `server/state-sync.js` handle snapshot conversion.
- `deserializeState()` reconstructs a full `GameState` with proper prototypes and calls `bumpEntityId()` to prevent ID collisions.
- Stale/incompatible saves are pruned on server startup.
- Resume flow: client sends `resumeSave`, server reconstructs state, creates new room, fills opponent with AI if needed.

---

## Game Stats System

`server/game-stats.js` records per-game statistics to SQLite: winner, round count, kills, summons, personalities, map size, win reason, duration, and game version. Stats are recorded automatically for multiplayer and headless games. The `admin-stats.html` dashboard provides aggregate analytics via REST endpoints (`GET /admin/api/game-stats/*`).

---

## Database Layer

`server/db-backend.js` wraps `better-sqlite3` behind a minimal interface (`prepare`, `exec`, `close`). `server/db.js` is a slim singleton creating the default backend. `server/schema.js` contains all DDL. The abstraction supports in-memory databases for testing without changing consumer code.

---

## Release Process

`scripts/release.js` automates releases: bumps version in `src/version.js`, generates release notes from commits (categorized as feat/fix/perf/refactor/chore/docs), updates `CHANGELOG.json`, creates a git tag, and fast-forward merges to prod. Enforces a dev-first workflow. Use `--dry-run` to preview.

**iOS version policy:** The iOS `MARKETING_VERSION` is **not** bumped by default — changing it triggers a new App Store review which takes days. Only pass `--ios` when explicitly asked to bump the iOS version to match the web release. The build number (`CURRENT_PROJECT_VERSION`) always increments so TestFlight accepts new uploads regardless.

---

## Rendering System

Pointy-top hex grid, odd-r offset storage. Canvas fills wrapper div with computed hex size. Supports zoom (0.5×–4.0×), pan, and mobile pinch/drag.

Draw order: terrain → river (bezier curves) → roads/bridges → buildings → fog of war → objective glows/symbols → unit outlines → highlight hexes → entity stacks (glyphs, HP bars) → damage flash → plan ghost overlay.

---

## Coordinate System

Tiles stored in **offset coordinates** `(col, row)`, keyed as `"col,row"` strings via `hexKey()`. All hex math converts to/from **axial** internally.

---

## CSS Conventions

Palette colors as CSS custom properties on `:root`. Dark gothic theme. Canvas colors in `tiles.js`/`entities.js` mirror these manually.

---

## UI Terminology

Use these names consistently when modifying UI components.

**Screens:** Setup Screen (`#setup-screen`), Mode Card, New Game Card, How to Play Card, Options Card, Waiting Card, Game Over Screen (`#game-over`).

**HUD:** Game Header (`#game-header`), Turn Info (`#turn-info`), Node Status (`#node-status`), Cycle Bar (`#cycle-bar`), Mini Chronicle (`#chronicle-mini`), Zoom Controls (`#zoom-controls`), Unit Stats Bar (`#unit-stats-bar`).

**Plan Panel:** Plan Panel (`#plan-panel`), Plan Tab (`#plan-tab`), Plan Steps List (`#plan-steps`), Budget Badge, Food Row, Plan Status, Plan Players, Countdown.

**Overlays** (dim canvas, manually dismissed): Chronicle (`#chronicle-overlay`), Inventory (`#inventory-overlay`), Tile Detail (`#tile-zoom-overlay`).

**Dialogs** (require interaction): Action Popup (`#action-popup`), Cancel Bar (`#cancel-wrap`), Battle Dialog, Encounter Dialog, Result Dialog.

**Toasts** (auto-dismissed): Phase Toast, Score Toast, Battle Toast.

**Key distinctions:** Overlay dims the canvas. Dialog requires interaction. Popup is a small context menu near a hex. Toast auto-dismisses. Cycle Bar (not "turn bar"). Node Status (not "score bar"). Unit Stats Bar (not "entity panel"). Cancel Bar (not "cancel button").
