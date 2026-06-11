# Brimstone — Claude Context

> **⚠ Visual work MUST be validated with the `verifier-browser` skill** (`.claude/skills/verifier-browser/`): run the real game in headless Chromium, capture screenshots, and read them before pushing. Any change to the 3D renderer, UI overlays/HUD, replay/conversation presentation, `styles.css`, or `index.html` counts as visual work. See Guideline 7.

## Development Guidelines

These directives apply to all code changes — follow them without exception.

### 1. Tests are mandatory (with exceptions)
- Every change must be accompanied by tests. Bug fix: **write a failing test first**, then make it pass (red → green). New features: cover the happy path and key edge cases.
- **Exception:** small, visual-only changes (labels, CSS, rearranged UI) need no tests — if there's no logic to verify, skip it.
- Tests live in `tests/` (`npm test`) and `tests/ui/` (`npm run test:ui`). Keep the suite fast — no heavyweight DOM mocks or slow setup for trivial assertions.

### 2. Run tests before every push
- Always run `npm test` before pushing. Do not push if tests fail.
- If a pre-existing test breaks due to your change, fix it — don't skip or delete it.

### 3. Gameplay changes require balance validation
- After any change to combat, actions, phase effects, entity stats, or map generation:
  ```bash
  node scripts/headless.js 500 standard    # win rates and game length
  node scripts/combat-sim.js 200           # hit/crush/counter rates
  node scripts/ai-matrix.js 50             # cross-personality balance
  ```
- Compare against the balance targets output by the scripts (see "AI Balance" below). Document meaningful deviations in the PR/commit message.

### 4. Keep technical docs current
- Detailed technical documentation lives in `docs/`:
  - `01-architecture-overview.md` — system diagrams, design principles, tech stack
  - `02-module-dependencies.md` — import graph, dependency layers
  - `03-state-machines.md` — AppMode, phase cycle, turn lifecycle, victory conditions
  - `04-network-protocol.md` — WebSocket messages, room lifecycle, reconnection, REST API
  - `05-game-systems.md` — entities, combat, actions, tiles, map generation, rendering
  - `06-ai-architecture.md` — 5-stage pipeline, goals, personalities, balance baseline & tuning methodology
  - `07-data-persistence.md` — DB schema, serialization, save/resume, auth, JSON mission format
  - `08-content-authoring.md` — how to add survivors, weapons, abilities, unit types, factions, missions
- **Update when:** adding/removing modules, changing state machine transitions, adding WebSocket message types, modifying the DB schema, changing AI goals/pipeline, adding entity or action types.
- **Don't update for:** bug fixes, tuning constants, CSS changes.

### 5. Online and offline parity
- Offline (`src/main.js`) and online (`server/lobby.js`) are the two orchestration layers — game rules, state shape, planning flow, and AI changes must be applied to **both**.
- New state fields must be added to `server/state-sync.js` serialization (and verified in `deserializeState()`) or online mode will silently drop them.
- Rule changes in shared code (`src/actions.js`, `src/game.js`, `src/entities.js`, `src/planner.js`, `server/resolver.js`, `src/ai.js`) apply to both modes automatically.
- After parity-sensitive changes, also run `node scripts/headless.js 100 standard --players 2`.

### 6. Database backend parity
- `server/db/` has intentionally duplicated SQLite and Postgres implementations. **Any change under `server/db/sqlite/` must land with the matching change under `server/db/postgres/` in the same commit** (and vice versa) — see "Database Layer" below.

### 7. Visual changes require browser verification
- Any change to the 3D renderer, UI overlays/HUD, replay/conversation presentation, `styles.css`, or `index.html` must be verified by **running the game and looking at screenshots** before pushing — unit tests can't see a clipped billboard or a camera-framing bug.
- Use the **`verifier-browser` skill** (`.claude/skills/verifier-browser/`): it drives the real game in headless Chromium (SwiftShader WebGL) via `scripts/verify/browser-harness.mjs`, captures screenshots + console errors, and documents the menu/replay selectors. Capture before/after screenshots for fixes, and actually read the images.

---

## Project Overview

Browser-based, turn-based hex-grid strategy game set in cursed colonial New England (Caleb's Hollow). Two asymmetric factions — **Hero** vs **Witch** — fight across a procedurally-generated map.

**Win conditions:** Hero — slay the Witch, or hold the majority of Power Nodes at enough dawn/dusk scoring checkpoints (first to 4 points). Witch — slay the Hero, or win on node-score points. (The old "hold all 3 nodes at dawn/dusk" instant win was removed — it was too easy to stumble into accidentally.)

**Game modes:** Human vs AI, Two Players, AI vs AI auto-play, Online multiplayer (1–4 players per side), async correspondence games, and a single-player **Campaign** of data-driven JSON missions.

**Stack:** no build step — vanilla JS ES modules, plain CSS. Canvas 2D renderer plus a Babylon.js WebGL renderer (`renderer-3d.js`, lazily imported on first draw). Node/Express + WebSocket server with SQLite or Postgres persistence. Capacitor wraps iOS/Android; Electron wraps desktop.

---

## Core Terminology (canonical)

Use these terms consistently in code comments, UI, and discussion:

- **ROUND** — the top-level unit: every player submits a plan, and those plans execute, within a single day-cycle slot. Advances the phase (dawn/day/dusk/night). ⇒ in code today this is **`state.round`** / `_roundHistory` / `endRound()`.
- **TURN** — a single step within a ROUND: one lockstep slot of the resolution containing ACTIONS from multiple units across all factions (moves simultaneous, battles serialized). ⇒ in code today this is the resolver **"step"** (`stepIndex`, `steps[]`, `step.heroEvents/witchEvents/playerEvents`). The replay timeline shows one card per TURN.
- **ACTION** — a single unit's action within a TURN (move, attack, summon, explore, fortify, heal, …). ⇒ in code today this is a **`PlanAction`** (`PlanActionType`) when queued, resolving to a sub-event (`ResEventType`).

⚠️ The code's internal names predate this glossary and **collide** with it: the resolver/UI call a TURN a "step." When touching that code, prefer the canonical words above (or note the mapping); don't silently rename existing identifiers like `stepIndex` without a deliberate refactor.

---

## Run Commands

```bash
npm run dev        # Full server on :3000 (WebSocket, saves, leaderboard) with DB_PATH=./data/brimstone.db
npm start          # Bare node server.js
npm test           # Core suite (tests/*.test.js)
npm run test:ui    # UI suite (tests/ui/*.test.js); npm run test:all runs both
npm run validate   # scripts/validate.js

node scripts/headless.js [count] [size]              # AI-vs-AI balance runs; size: skirmish|standard|regional|campaign
node scripts/headless.js [count] [size] --players N  # NvN runner (1v1 to 4v4)
node scripts/headless.js --render [size] [out.gif]   # Render a game as an animated GIF
node scripts/headless-campaign.js [missionId|--all] [count]  # AI-plays campaign missions to gauge difficulty
node scripts/combat-sim.js [rounds]                  # Combat stats report
node scripts/ai-matrix.js [count]                    # Hero × Witch personality matrix
node scripts/release.js [patch|minor|major] [--dry-run]  # Release automation (see Release Process)
```

### Preferred local development mode

Run `npm run dev` on the laptop, then build/deploy the iOS app pointing at the local server — full multiplayer/persistence testing on a real device:

```bash
npm run dev                    # 1. Start local server (keep running)
npm run cap:sync:ios:local     # 2. Sync iOS build pointing at the laptop's LAN IP
# 3. Build + deploy to phone (below)
```

### iOS build (Capacitor)

`npm run cap:sync:ios` (dev) / `cap:sync:ios:prod` / `cap:sync:ios:local` copy web assets to `www/` and sync to `ios/`; `npm run cap:open:ios` opens Xcode. Android equivalents: `cap:sync:android`, `cap:sync:android:prod`, `cap:open:android`.

Build + run on a physical device from the CLI (`xcrun xctrace list devices` to find the UDID):

```bash
npm run cap:sync:ios
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination "id=<DEVICE_UDID>" -derivedDataPath /tmp/brimstone-ios-build clean build
xcrun devicectl device install app --device <DEVICE_UDID> \
  /tmp/brimstone-ios-build/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <DEVICE_UDID> com.calebshollow.game
```

**Important:** use `/tmp` (or another non-iCloud path) for `-derivedDataPath` — the project directory has iCloud/Finder extended attributes that break codesigning.

### Electron build

`npm run electron:dev` / `electron:dev:prod` to run; `electron:package:mac|win` to package; `electron:build:mac|win` for distributables (output in `/tmp/brimstone-electron-dist`).

---

## Directory Structure

Key entry points only — see `docs/02-module-dependencies.md` for the full module graph.

```
docs/                # Technical docs 01–08 + design/
index.html           # Single-page shell with all UI overlay elements
admin.html           # Admin dashboard — game analytics, balance metrics
admin-tools.html     # Caleb's Hollow Tools — Assets | Lighting | Mission Editor tabs
styles.css           # Dark gothic theme; CSS custom properties on :root
server.js            # Express + WebSocket server entry point
src/
  main.js            # Client entry — wires modules, setup flow, local resolution loop
  app-mode.js        # AppMode state machine (see docs/03)
  game.js            # GameState: tiles, entities, phase cycle, turn/victory logic
  entities.js        # Entity class + factories; static resolveCombat()
  actions.js         # All action validation + execution — single source of truth for rules
  planner.js         # PlanActionType enum, computeGhostState(), validatePlanAction()
  map.js, hex.js     # Procedural map generator; pure hex math + MAP_SIZES
  renderer.js        # Canvas 2D renderer — editor-only now; the 3D renderer is the game default, so 2D can be rough around the edges
  renderer-3d.js     # Babylon.js WebGL renderer (Babylon lazily imported on first draw)
  ui.js, ui-*.js     # UIController — the only DOM-touching layer
  ai.js              # WitchAI/HeroAI, personality registries, shared helpers, PlanSimState
  ai-engine.js       # Witch 5-stage goal pipeline
  hero-ai-engine.js  # Hero 5-stage goal pipeline
  multiplayer.js     # WebSocket client, MirrorState/MirrorEntity
  tiles.js, items.js, abilities.js, unit-types.js, factions.js  # Data-driven content tables
  loot.config.js     # Weighted loot tables (primary tuning file)
  campaign/          # Campaign system — missions/*.json, registry, mission-map, conductor scripts
  content/           # Survivor roster
  tutorial/          # Tutorial config + runner
  version.js         # Game version — save compatibility checks
server/
  lobby.js           # Matchmaking, room lifecycle, team seats, AI fill-in, online resolution loop
  resolver.js        # resolvePlans()/resolvePlansMP() — imported by both lobby.js and src/main.js
  state-sync.js      # serializeState()/deserializeState()
  auth.js, magic-link.js          # Player auth, session tokens, magic-link login
  db/                # Repository API; paired sqlite/ + postgres/ backends (see Database Layer)
  saves.js, game-stats.js, leaderboard.js, campaign-saves.js, campaign-game-stats.js
  async-game.js, async-game-rooms.js, battle-scheduler.js, remote-battle.js  # Async games
  push.js, notifications.js       # Push notifications
  admin.js           # Admin REST endpoints
scripts/             # headless.js, headless-campaign.js, headless-mp-net.js, combat-sim.js,
                     # ai-matrix.js, release.js, validate.js, asset/model generation tools
tests/               # node --test suites: tests/*.test.js, tests/ui/*.test.js
```

---

## Architecture

**Strict separation of concerns:**
- `game.js` owns state — no rendering or DOM. `renderer.js`/`renderer-3d.js` read state, draw — zero mutations. `ui.js` is the sole DOM-touching layer.
- **`renderer-3d.js` (Babylon) is the renderer the game ships with.** `renderer.js` (Canvas 2D) is now used **only by the editor/admin tools**, so it can be rough around the edges — prioritise the 3D renderer for gameplay polish, and don't block work on achieving 2D parity for player-facing visuals.
- `actions.js` holds all game-logic mutations as pure functions `(state, actor, ...)` returning `{ success, log, cost }` — UI and AI call the same functions.
- `server/resolver.js` is imported by both `server/lobby.js` (online) and `src/main.js` (local) — no DOM dependency. Headless scripts import `src/` directly; all game logic is DOM/Canvas-free.

**Key patterns:**
- Type constants are `Object.freeze()` enums.
- `state.tiles` is a `Map<"col,row", Tile>` keyed via `hexKey(col, row)`. Tiles use **offset coordinates** (pointy-top, odd-r); hex math converts to/from axial internally.
- Every entity has an `ownerId` (player UUID) for N-player games.

**App mode:** a centralized enum in `src/app-mode.js` (`MENU`, `PLANNING`, `SUBMITTED`, `RESOLVING`, `SUMMARY`, `PLAYBACK`, `SPECTATING`). `main.js` owns all `setMode()` transitions — `ui.js` only reads `ui.appMode`. Full transition map and helper semantics: `docs/03-state-machines.md`.

**Simultaneous-turn planning:** each round, both factions independently build an ordered `PlanAction[]` queue, submit, then `resolvePlans()`/`resolvePlansMP()` executes plans in paired lockstep steps and `state.endRound()` advances phase/scoring. Plan types (`MOVE`, `BATTLE_UNIT`, `SUMMON`, `USE_ABILITY`, …) live in the `PlanActionType` enum in `src/planner.js`. `computeGhostState()` projects planned moves for the renderer's ghost overlay; `_getProjectedPos()` in `ui.js` enables multi-move chaining within one plan.

**Heartbeat sync:** the server sends a `heartbeat` message every 15s to clients in active games (`roomId`, `round`, `planningPhase`, `gameOver`, `playersReady`); on mismatch the client sends `requestState` and gets a full resync via `resumeGame()`. Protocol details: `docs/04-network-protocol.md`.

---

## Game Mechanics

- **Phase cycle:** `DAWN (1) → DAY (3) → DUSK (1) → NIGHT (3)` — 8 rounds per cycle. Dawn/dusk trigger node scoring. Day favors Hero; night favors Witch. Phase effects live in `game.js` `endRound()`.
- **Actions:** Move, Explore, Battle, Fortify (hero), Summon (witch), Use Item, Equip Weapon, Use Ability. Costs/rules in `src/actions.js` — read the code for current values; they're tuned frequently.
- **Combat:** dice-based advantage system — each side rolls 1+K d6 (K = net advantage, capped at `ADVANTAGE_CAP=3`) taking best/worst. Gang-up allies grant +1 advantage die and +1 flat each. Phase bonus, silver weapon, and fortification stay flat. Outcomes: hit (1 dmg), crush (2 dmg), counter (1 dmg to attacker). Formula: `Entity.resolveCombat()` in `src/entities.js`.
- **Entities:** Hero, Witch, Survivor, Zombie, Minion/Wood Golem/Iron Golem (+ faction-specific leaders). Stats in `src/unit-types.js` / `src/entities.js`.
- **AI personalities:** 6 subclasses in `src/ai.js` — Hero: Berserker/Sentinel/Scavenger; Witch: Berserker/Hoarder/Swarm.
- **Fog of war:** active when any side is AI-controlled; sight range varies by phase.
- **Counters:** `GameState` tracks `heroKills`, `witchKills`, `witchSummonCount` — incremented in `actions.js`, persisted via state-sync, recorded to game stats.

**Map generation:** seeded, procedural; four sizes in `MAP_SIZES` (`src/hex.js`). Sequence: grass fill → river → buildings → MST road network with bridges → forests → dirt → 3 Power Nodes → starts → hidden survivors. If you resize a map, recalibrate survivor/node/bridge/forest counts proportionally. Details: `docs/05-game-systems.md`.

---

## Persistence, Saves & Stats

- Online games auto-persist to the DB after every round via `server/saves.js`; `server/state-sync.js` handles snapshot conversion and `deserializeState()` rebuilds a full `GameState` (prototypes restored, `bumpEntityId()` called). Stale/incompatible saves are pruned on startup. Resume: client sends `resumeSave`, server rebuilds state into a new room, AI fills empty seats.
- `server/game-stats.js` records per-game stats (winner, rounds, kills, summons, personalities, map size, win reason, duration, version) for multiplayer and headless games; `admin.html` shows aggregates via `GET /admin/api/*`.
- Full schema, replay storage, and auth flow: `docs/07-data-persistence.md`.

### Database Layer

All DB access goes through the repository API in `server/db/` (`db.players`, `db.saves`, `db.gameStats`, …) — no consumer writes SQL. Backend chosen by `DB_BACKEND`:
- **`sqlite`** (default) — `better-sqlite3`, WAL, path from `DB_PATH`.
- **`postgres`** — `pg-native`, connection from `DATABASE_URL` (`DB_BACKEND=postgres DATABASE_URL=… npm run dev`).

`server/db/schema.js` keeps the SQLite DDL as source of truth and derives Postgres DDL via deterministic regex transforms. Each domain module exists twice — `sqlite/<domain>.js` and `postgres/<domain>.js` — with dialect-appropriate SQL.

**Parity rule (Guideline 6):** edit both copies in the same commit. Postgres dialect notes: `$1` placeholders, `EXTRACT(EPOCH FROM NOW())::BIGINT` timestamps, explicit `ON CONFLICT … DO NOTHING/UPDATE`, `CITEXT` instead of `COLLATE NOCASE`, `GREATEST()` instead of scalar `MAX()`, `(x IS NOT NULL)::int` for boolean-as-int, `RETURNING 1` where `.changes` is read, `(col::jsonb ->> 'key')::int` for JSON paths. Run **both** suites before committing:
```bash
npm test                                                      # SQLite
PG_TEST_URL=postgresql://… node --test tests/db-postgres.test.js  # Postgres (skipped when unset)
```
If a change is genuinely SQLite-only (e.g. a legacy migration block), comment why. `db.prepare()`/`db.exec()` are SQLite-only escape hatches for legacy test cleanup.

---

## Release Process

**Branches:** `dev` is the main development branch; `prod` is the release branch. All work lands on `dev` first.

`scripts/release.js` bumps `src/version.js`, generates categorized release notes into `CHANGELOG.json`, tags, and fast-forward merges `dev` → `prod`. Use `--dry-run` to preview. In practice `prod` contains non-ff merge commits, so the final `--ff-only` merge can fail — finish manually (`git checkout prod && git merge dev`) and run the iOS/itch uploads by hand.

**iOS version policy:** `MARKETING_VERSION` is **not** bumped by default (it triggers a days-long App Store review) — only pass `--ios` when explicitly asked. The build number always increments so TestFlight accepts uploads.

---

## Adding Content

Content additions (survivors, weapons, abilities, unit types, factions, campaign missions) are data-driven, usually one-file edits — `src/actions.js`, `server/resolver.js`, and `server/state-sync.js` should not need touches. **Follow `docs/08-content-authoring.md`** for the per-type recipes. Campaign missions are authored in the Mission Editor at `/admin/tools` (never hand-write tiles) and registered in `src/campaign/campaign-registry.js`.

---

## UI Terminology

Use these names consistently: **Overlays** dim the canvas and are manually dismissed (Chronicle, Inventory, Tile Detail). **Dialogs** require interaction (Action Popup, Battle/Encounter/Result Dialog, Cancel Bar). **Toasts** auto-dismiss (Phase/Score/Battle Toast). HUD elements: Game Header, Turn Info, Node Status (not "score bar"), Cycle Bar (not "turn bar"), Mini Chronicle, Unit Stats Bar (not "entity panel"), Plan Panel/Tab/Steps List, Budget Badge. Screens: Setup Screen, Mode Card, New Game Card, Options Card, Waiting Card, Game Over Screen.

---

## AI Balance

Both factions use a 5-stage pipeline — **EVALUATE → SCORE → ALLOCATE → GENERATE → ASSEMBLE** — in `src/ai-engine.js` (witch) and `src/hero-ai-engine.js` (hero), with shared helpers in `src/ai.js`. Architecture details: `docs/06-ai-architecture.md`.

**Balance targets** (validate after any gameplay/AI change — Guideline 3):

| Metric | Target |
|--------|--------|
| Win rate | 38–62% either side |
| Tiebreaks | <10% |
| Kill wins | ≥20% |
| Mean rounds | 15–35 |
| Round cap hits | <5% |

Baseline (2026-06-10, post map-resize): Hero 48.8% / Witch 51.0% at ~23 mean rounds (600 1v1 games, Standard 14×14); 2v2 ~61% (within the NvN band). Map sizes were enlarged ~20% **by area** (Skirmish 10×10, Standard 14×14, Regional 19×19, Campaign 23×23; `battle` 42×42 now also player-selectable). Larger sizes lean witch (Skirmish ~59%, Regional ~64%) — an inherent map-size effect (longer games → more night/summon time); the default Standard stays centered. Prior baseline (2026-06-09, post weapons-overhaul, Standard 13×13): Hero 51.6% / Witch 48.4%; NvN 2v2 ~58%, 3v3 ~53%, 4v4 ~59%. Full baseline tables, NvN scaling notes, and the step-by-step tuning methodology live in `docs/06-ai-architecture.md` → "Balance Baseline & Tuning Methodology" — **update that baseline after any tuning pass**. NvN scaling is gated on `playerCount > 1`; don't remove it without re-running `node scripts/headless.js 500 standard --players N` for N ∈ {2, 3, 4}.
