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

### 4. Keep technical docs current
- Detailed technical documentation lives in `docs/`. When making architectural changes, update the relevant doc:
  - `docs/01-architecture-overview.md` — system diagrams, design principles, tech stack
  - `docs/02-module-dependencies.md` — import graph, dependency layers, cross-boundary imports
  - `docs/03-state-machines.md` — AppMode, phase cycle, turn lifecycle, victory conditions
  - `docs/04-network-protocol.md` — WebSocket messages, room lifecycle, reconnection, REST API
  - `docs/05-game-systems.md` — entities, combat, actions, tiles, resources, map generation, rendering
  - `docs/06-ai-architecture.md` — 5-stage pipeline, goals, personalities, combat estimation
  - `docs/07-data-persistence.md` — database schema, serialization, save/resume, auth
- **When to update:** Adding/removing modules, changing state machine transitions, adding WebSocket message types, modifying the DB schema, changing AI goals or pipeline stages, adding new entity types or action types.
- **When not to update:** Bug fixes, tuning constants, CSS changes, or other changes that don't alter the architecture described in the docs.

### 5. Online and offline parity
- Offline mode (`src/main.js`) and online mode (`server/lobby.js`) must stay in sync.
- Any change to game rules, state shape, planning flow, or AI behaviour needs to be applied to **both** orchestration layers.
- New state fields must be added to `server/state-sync.js` serialization or online mode will silently drop them.
- After parity-sensitive changes, verify with `node scripts/headless.js 100 standard --players 2` in addition to the standard headless runner.

---

## Project Overview

Browser-based, turn-based hex-grid strategy game set in cursed colonial New England (Caleb's Hollow). Two asymmetric factions — **Hero** vs **Witch** — fight across a procedurally-generated map.

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
docs/               # Technical documentation (see docs/*.md for architecture, state machines, protocols, etc.)
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
  release.js        # Automated release: version bump, changelog generation, tag, fast-forward merge to prod
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
Dice-based with attack/defense rolls. Each side rolls a pool of 1+K d6 (K = net advantage, capped at `ADVANTAGE_CAP=3`) and takes best (advantage) or worst (disadvantage). Gang-up allies grant +1 advantage die *and* +1 flat per ally (capped at `ADVANTAGE_CAP`). Phase bonus (witch at night), silver weapon, and fortification stay flat. Staff vs undead/minions/golems grants attacker advantage. See `Entity.resolveCombat()` in `src/entities.js` for the formula. Key outcomes: hit (1 damage), crush (2 damage), counter (1 damage to attacker).

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

All DB access lives in `server/db/` behind a high-level repository API grouped by domain (`db.players`, `db.saves`, `db.gameStats`, etc.) — no `server/*.js` consumer writes SQL. `server/db.js` is a compat shim that re-exports `server/db/index.js`, which picks a backend based on the `DB_BACKEND` environment variable:

- **`DB_BACKEND=sqlite`** (default) — `better-sqlite3`, WAL mode, path from `DB_PATH`, bootstrapped and migrated by `server/db/sqlite/client.js`.
- **`DB_BACKEND=postgres`** — `pg-native` (synchronous libpq bindings), connection string from `DATABASE_URL`, bootstrapped by `server/db/postgres/client.js`. Requires the optional dep `pg-native` and `libpq-dev` at build time. The `citext` extension is auto-created on startup.

`server/db/schema.js` keeps the SQLite DDL as the source of truth and derives the Postgres DDL via deterministic regex transforms (`unixepoch()` → `EXTRACT(EPOCH FROM NOW())::BIGINT`, `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`, `COLLATE NOCASE` → `CITEXT`). Each domain module has two copies — one under `sqlite/` and one under `postgres/` — with dialect-appropriate SQL. The domain set is: `players, identities, magicTokens, saves, saveReplayRounds, completedGames, plans, async, gameStats, campaignStats, campaignSaves, deviceTokens, notifications, admin`.

### Parity rule — keep the two backends in sync

**Any change to one backend MUST be applied to the other in the same commit.** The two implementations are intentionally duplicated (rather than built behind a SQL-dialect translator) so each dialect can be read and tuned independently, but that means drift is the main failure mode. When you add a method, change a query, fix a bug, or add a new domain:

1. Edit the SQLite module under `server/db/sqlite/<domain>.js`.
2. Edit the corresponding Postgres module under `server/db/postgres/<domain>.js` with dialect-appropriate SQL (`$1, $2` placeholders, `EXTRACT(EPOCH FROM NOW())::BIGINT` for timestamps, `(col::jsonb ->> 'key')::int` for JSON paths, explicit `ON CONFLICT … DO NOTHING/UPDATE` for upserts, `CITEXT` column behavior instead of `COLLATE NOCASE`, `GREATEST(a, b)` instead of scalar `MAX(a, b)`, `(x IS NOT NULL)::int` for boolean-as-int columns, appended `RETURNING 1` on DML where `.changes` is read).
3. If the method's return shape needs column-name normalization (e.g. BIGINT timestamps coming back as numbers), verify the Postgres client's `pg-types` parsers cover it.
4. Run **both** test suites before committing:
   - `npm test` — SQLite
   - `PG_TEST_URL=postgresql://… node --test tests/db-postgres.test.js` — Postgres integration
5. Never merge a PR that touches `server/db/sqlite/` without a matching change under `server/db/postgres/` (or vice versa). Review the diff as a pair.

If a change is genuinely SQLite-only (e.g. a legacy migration block in `sqlite/client.js`), add a comment explaining why it has no Postgres counterpart.

`db.prepare()` / `db.exec()` are retained as SQLite-only escape hatches for legacy test cleanup (`tests/*.test.js`); the Postgres backend deliberately does not expose them. `tests/db-postgres.test.js` exercises the Postgres backend against a live DB specified by `PG_TEST_URL` (skipped when unset).

To run the server against a local Postgres:
```bash
DB_BACKEND=postgres DATABASE_URL=postgresql://user:pass@host:5432/db npm run dev
```

---

## Release Process

**Branches:** `dev` is the main development branch. `prod` is the release/production branch. All work lands on `dev` first; releases fast-forward merge `dev` → `prod`.

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

## How to Add Content

The units/items/abilities refactor (Phases 1–6, landed in PR #294) made content additions data-driven. For common content additions, the following one-file (or near-one-file) edits are sufficient — `src/actions.js`, `server/resolver.js`, and `server/state-sync.js` should not need touches.

### New survivor

Append an entry to `SURVIVOR_ROSTER` in `src/content/survivors.js`:

```js
{
  name: 'Eliza Stone',
  title: 'Mason',
  bio: 'Cut stone blocks by hand until the world ended.',
  maxHp: 5, attack: 2, defense: 2,
  ability: SurvivorAbility.FORTIFY_DOUBLE,
  abilityLabel: 'Mason — fortifies a building to full strength with just Wood',
},
```

Optionally add a colour slot to `SURVIVOR_COLORS` above. Base stats are **pre-passive** — if the survivor has `BRAWLER` (+1 ATK) or `STURDY` (+1 DEF), write the un-baked number; `getAttack()` / `getDefense()` compose the passive at call time via `ABILITIES[id].statMods`.

### New weapon

Append an entry to `ITEMS` in `src/items.js`:

```js
spear: {
  id: 'spear',
  kind: 'weapon',
  slot: 'weapon',
  statMods: { attack: 1, defense: 1 },
  label: '🗡 Spear (+1 ATK, +1 DEF)',
  // optional conditional bonus via combatTriggers:
  combatTriggers: [
    { when: 'attack', ifDefenderHasAnyTag: ['construct'], advantage: 1 },
  ],
},
```

Add the id to any loot tables in `src/loot.config.js` that should roll it.

### New ability

Append an entry to `ABILITIES` in `src/abilities.js`:

- **Passive with stat bonus:** `{ id, kind: 'passive', label, description, statMods: { attack: 1 } }` — composed automatically by `Entity.getAttack()` / `getDefense()`.
- **Active:** `{ id, kind: 'active', label, description, validate(state, actor), execute(state, actor) }` — `validate` is called by `_buildAbilityActions` to decide whether the button shows; `execute` runs when the plan step resolves and returns `{ success, log, cost, budgetBonus? }`.

Then reference the id from a roster entry's `ability:` field (or push it onto a faction's `innateLeaderAbilities` for leader-only abilities).

### New unit type

1. Add the `EntityType` constant in `src/entities.js`.
2. Add a `UNIT_TYPES[key]` entry in `src/unit-types.js` with `baseStats`, `agility`, `color`, `tags`. Tags drive combat triggers (e.g. staff-vs-undead) and AI filtering — pick from `['living', 'leader', 'day-leader', 'night-leader', 'undead', 'minion', 'construct', 'summoned', 'soldier', ...]` or add a new one.
3. Add a factory wrapper in `src/entities.js`:
   ```js
   export function createSoldier(col, row, ownerId = null, state = null) {
     return new Entity(EntityType.SOLDIER, 'hero', col, row, ownerId, state);
   }
   ```
4. Add a glyph entry to the three `GLYPHS` maps in `src/ui.js` and the `entityGlyph` switch in `src/renderer.js`.

Combat, pathfinding, serialization, and plan-action validation flow through the generic machinery — no action/resolver/state-sync edits needed.

### New faction

Subclass `HeroFaction` or `WitchFaction` in `src/factions.js`, override `id` / `name` / `leaderType` / `_buildLeader`, register in the `FACTIONS` map, and add a leader factory in `src/entities.js`. If the faction has unique leader abilities, override `innateLeaderAbilities` to return the parent list plus the new ids — `Faction.createLeader()` pushes them onto the entity automatically. See `RogueFaction` / `CaptainFaction` in `factions.js` for the minimal stub pattern.

### New mission (JSON)

Campaign missions are **data-driven JSON** under `src/campaign/missions/*.json` (`schema: 1`). The format is **offline/campaign-only** — there is no server path and no online parity to keep (don't touch `server/`). Author missions in the **Mission Editor**, not by hand-writing tiles.

**Author via the editor** at `/admin/tools` (start the dev server, then the **Mission Editor** tab):
- Paint the map: terrain, buildings, resources, hidden survivors; place hero/witch starts and Power Nodes; place enemy units.
- Each building is a **two-hex compound** — a passable entrance (carries the `building`, loot, fortify, hidden-survivor, `roadDirs`) plus one impassable, sight-blocking **footprint** hex that holds the rendered model. Placing a building auto-claims an eligible adjacent footprint (`footprintHexes` on the entrance → a non-resource, non-road, non-river, in-bounds neighbour that back-points via `buildingFootprintOf`). Press **R** to rotate the footprint through the other eligible neighbours (hovered building, else last-placed). See `docs/05-game-systems.md` → "Building Footprints".
- Set extra road-node waypoints, then **Regenerate Roads** — roads (`ROAD`/`BRIDGE` + `roadDirs`) are *derived* from the road-node set (buildings & bridges are implicit nodes). On a handmade map the editor snapshots the derived `roadDirs` back into the tiles (no load-time regen).
- Author story triggers (round# or area hexes, with an optional `condition` from the registry), waves, objectives, briefing/victory/defeat text, phaseCycle, resources/rewards via the forms.
- **Preview in 3D** (hands the built `GameState` to `Renderer3D`), then **download** the JSON.

**Schema & loader:** see `src/campaign/missions/long_watch.json` for the canonical example, `docs/design/campaign-mission-editor.md` for the full spec, and `docs/07-data-persistence.md` → "JSON Mission Format". The `map` sub-object (`mode: "handmade"` | `"procedural"`) is built by `buildMissionMap` (`src/campaign/mission-map.js`); everything else mirrors the runtime mission shape verbatim.

**Two fields are string keys, not data:**
- `storyTriggers[].condition` → a named predicate in `src/campaign/condition-registry.js` (`CONDITIONS`). Add a new condition there (`(state) => boolean`, no mutation) before referencing it.
- `conductor.scriptKey` → `{ steps, config }` in `src/campaign/conductor-scripts.js` (e.g. `"tutorial"`, whose imperative scripting stays in `src/tutorial/tutorial-config.js` — the registry only aggregates it).

**Validation:** the editor runs the assembled JSON through `loadMissionJSON` / `validateMissionJSON` before download. The four hardening checks: (1) tiles in-bounds, (2) `objectives.win`/`lose` types in `KNOWN_OBJECTIVE_TYPES` (mirrors the 17-case switch in `buildVictoryDelegate`, `src/campaign/campaign.js`), (3) handmade maps define their starts, (4) `map.roadSeed` carried verbatim for regen determinism. The editor *also* runs the save-time `validateBuildingFootprints` (separate from the runtime checks, kept out of `validateMissionJSON` for backward compat) — it rejects any building with an empty `footprintHexes` or a footprint whose `buildingFootprintOf` doesn't back-point to its entrance (broken pair).

**Register it:** add the mission's `{ id, campaignId }` to `MIGRATED_MISSIONS` in `src/campaign/campaign-registry.js` and drop the file in `src/campaign/missions/`. It's loaded at module init (node via `fs`, browser via same-origin `fetch`) under a top-level `await`, so importers see a populated registry.

> **Admin tooling:** `/admin/tools` (`admin-tools.html`) is the unified **Caleb's Hollow Tools** page — **Assets** (Babylon 3D model browser) | **Lighting** (Renderer3D tuner) | **Mission Editor** tabs, each lazy-initialised on first activation.

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

---

## AI Balance Baseline & Tuning Methodology

**Last updated:** 2026-04-24 (NvN balance pass — per-witch AI thresholds + hidden-survivor scaling)

### Baseline Metrics (500 1v1 games, Standard 13×13)

| Metric | Value | Target |
|--------|-------|--------|
| Hero win rate | 49.2% | 38–62% (±12%) |
| Witch win rate | 50.8% | 38–62% (±12%) |
| Draws | 0.0% | — |
| Mean rounds | ~22 | 15–35 |

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
| 2v2  | 57.8% | 42.0% | ~6 units (1.3× 1v1) | ~13 units (1.75× 1v1) |
| 3v3  | 57.0% | 42.6% | ~8 units (1.7× 1v1) | ~20 units (2.7× 1v1) |
| 4v4  | 60.0% | 39.8% | ~9 units (1.9× 1v1) | ~25 units (3.5× 1v1) |

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

### AI Architecture

Both factions use a 5-stage pipeline: **EVALUATE → SCORE → ALLOCATE → GENERATE → ASSEMBLE**.

| Stage | Function | Description |
|-------|----------|-------------|
| EVALUATE | `assessBoard()` / `assessHeroBoard()` | Snapshot of board state, distances, threats, resources |
| SCORE | `scoreGoals()` / `scoreHeroGoals()` | Rate each goal 0–1 based on board state |
| ALLOCATE | `allocateBudget()` / `allocateHeroBudget()` | Divide action budget across goals proportionally |
| GENERATE | `gen*()` functions | Produce plan actions for each goal |
| ASSEMBLE | `generatePlan()` | Merge, deduplicate, fill gaps |

Key files: `src/ai-engine.js` (witch), `src/hero-ai-engine.js` (hero), `src/ai.js` (shared helpers, PlanSimState).

### Current AI Features

- **Scoring awareness:** Both AIs track `roundsUntilScoring()` and increase node control urgency near dawn/dusk scoring checkpoints.
- **Score-differential urgency (hero only):** Hero AI increases node priority when behind in score. Deliberately omitted for witch to maintain balance (witch already has unit-count advantage at nodes).
- **Node feasibility:** `scoreNodeFeasibility()` rates each node 0–1 based on distance advantage, force on/near the node, and current controller. Both AIs filter out hopeless nodes (hero threshold ≥0.1, witch threshold ≥0.15). Hero AI sorts nodes by feasibility; witch AI keeps priority-based sort (hero-held > neutral > threatened, then distance).
- **Multi-unit node assignment (hero only):** Hero can send 2 units to a high-feasibility node (≥0.6) when scoring is ≤2 rounds away.
- **Sound Horn:** Hero AI uses Sound Horn during exploration when food ≥1, ≥2 unexplored buildings, HP >30%, and <3 survivors.
- **NvN ally coordination:** `allyContext.claimedNodes` prevents allied players from targeting the same nodes. Updated after each player's plan generation.
- **Anti-oscillation:** Cross-turn memory (`previousPositions`) prevents units from returning to the hex they just left.

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
