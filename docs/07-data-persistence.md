# Data Persistence & Save System

## Database Layer

### Stack

Brimstone supports two storage backends selected at startup by the `DB_BACKEND`
environment variable:

- **SQLite (default)** — `better-sqlite3`, synchronous, WAL mode, stored in
  `data/brimstone.db` (configurable via `DB_PATH`). No extra setup required.
- **Postgres** — `pg-native` (libpq sync bindings), fully synchronous,
  connection string in `DATABASE_URL`. Requires the optional dep `pg-native`
  (and `libpq-dev` at build time) plus the `citext` extension.

Both backends expose the **same high-level data-access API** — consumers call
`db.players.getByToken(...)`, `db.saves.upsert(...)`, etc. and never see SQL.

### Layout (`server/db/`)

```
server/
  db.js                      ← compat shim, re-exports db/index.js
  db/
    index.js                 ← backend-selection singleton (DB_BACKEND switch)
    schema.js                ← DDL source of truth + sqlite→postgres transform
    sqlite/
      client.js              ← shared better-sqlite3 handle, migrations
      players.js             ← each domain is a file, declaring prepared
      saves.js                 statements at module load
      save-replay-rounds.js
      completed-games.js
      plans.js
      async.js
      identities.js
      magic-tokens.js
      game-stats.js
      campaign-stats.js
      campaign-saves.js
      device-tokens.js
      notifications.js
      admin.js
      index.js               ← aggregates all domains into the `db` object
    postgres/
      client.js              ← lazy pg-native client, sync query/runMutation
      <same domain files>    ← Postgres-dialect SQL for each domain
      index.js
```

### Data-access API shape

```js
import db from './db/index.js';       // or './db.js' (compat shim)

db.players.getByToken(token);         // → row | null
db.players.insert({ id, username, discriminator, token });
db.saves.upsert({ roomId, stateJson, … });
db.saves.get(roomId);                 // row with parsed `.state`
db.gameStats.insert(stats);
db.gameStats.countTotal();            // → number
db.plans.listForRound(roomId, round); // → rows
db.transaction(fn);                   // → callable that wraps fn in a tx
```

Every method is **synchronous**. Return rows are plain objects with identical
column names across backends. Booleans are stored as `0`/`1` integers on both
sides. BIGINT columns (unix timestamps) come back as `Number` on both sides.

### Backend selection

```js
// server/db/index.js
const backend = (process.env.DB_BACKEND || 'sqlite').toLowerCase();
if (backend === 'postgres') db = (await import('./postgres/index.js')).default;
else                        db = (await import('./sqlite/index.js')).default;
```

Running with the SQLite default:

```bash
DB_PATH=./data/brimstone.db npm run dev
```

Running against Postgres:

```bash
DB_BACKEND=postgres \
DATABASE_URL=postgresql://user:pass@localhost:5432/brimstone \
npm run dev
```

### Postgres setup

1. Install libpq dev headers (required to compile `pg-native`):
   ```bash
   # Debian/Ubuntu
   sudo apt-get install -y libpq-dev
   # macOS
   brew install libpq
   ```
2. Install the optional dep: `npm install pg-native`.
3. Create a database; the `citext` extension must be installable (standard
   contrib, already available on `postgres:16`).
4. Point the server at it:
   ```bash
   DB_BACKEND=postgres DATABASE_URL=postgresql://user:pass@host:5432/dbname \
     npm run dev
   ```

The schema (including `CREATE EXTENSION IF NOT EXISTS citext` and all
`CREATE TABLE IF NOT EXISTS` statements) is applied idempotently on every
startup by `server/db/postgres/client.js`.

### Dialect handling

`server/db/schema.js` keeps the SQLite DDL as the source of truth and derives
the Postgres DDL via deterministic regex transforms:

- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- `INTEGER NOT NULL DEFAULT (unixepoch())` → `BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)`
- `TEXT NOT NULL COLLATE NOCASE` → `CITEXT NOT NULL` (with `CREATE EXTENSION IF NOT EXISTS citext;` prepended)

Domain modules write native SQL for each dialect — the Postgres copies use
`$1, $2` placeholders, `EXTRACT(EPOCH FROM NOW())::BIGINT` for timestamps,
`ON CONFLICT … DO UPDATE` for upserts, and `(config_json::jsonb ->> 'isBattle')::int`
for JSON path extraction.

### Testing

- `npm test` runs the full SQLite suite.
- `PG_TEST_URL=postgresql://user:pass@host:5432/db node --test tests/db-postgres.test.js`
  runs the Postgres integration suite. When `PG_TEST_URL` is unset the suite
  is skipped, so `npm test` stays green on dev machines without Postgres.

---

## Database Schema

### Core Tables

```
┌─────────────────────────┐     ┌──────────────────────────┐
│        players           │     │    player_identities     │
├─────────────────────────┤     ├──────────────────────────┤
│ id          TEXT PK      │──┐  │ player_id   TEXT FK      │
│ username    TEXT          │  │  │ provider    TEXT          │
│ discriminator INTEGER    │  │  │ provider_id TEXT          │
│ token       TEXT UNIQUE  │  └─→│                          │
│ wins        INTEGER      │     │ PK(player_id, provider)  │
│ losses      INTEGER      │     └──────────────────────────┘
│ draws       INTEGER      │
│ is_admin    INTEGER      │
└─────────────────────────┘
```

### Game Persistence Tables

```
┌─────────────────────────────┐     ┌─────────────────────────┐
│         game_saves           │     │    save_replay_rounds    │
├─────────────────────────────┤     ├─────────────────────────┤
│ room_id        TEXT PK       │──┐  │ room_id    TEXT FK       │
│ hero_player_id TEXT FK       │  │  │ round_num  INTEGER       │
│ witch_player_id TEXT FK      │  │  │ pre_state_json TEXT      │
│ hero_name      TEXT          │  └─→│ steps_json     TEXT      │
│ witch_name     TEXT          │     │                         │
│ round          INTEGER       │     │ PK(room_id, round_num)  │
│ phase          TEXT          │     └─────────────────────────┘
│ game_version   TEXT          │
│ state_json     TEXT          │     ┌─────────────────────────┐
│ turn_deadline  INTEGER       │     │    game_plan_status      │
│ turn_interval_ms INTEGER     │     ├─────────────────────────┤
│ consecutive_timeouts INTEGER │     │ room_id    TEXT FK       │
│ config_json    TEXT          │     │ player_id  TEXT FK       │
│ players_json   TEXT          │     │ round      INTEGER       │
│ is_private     INTEGER       │     │ plan_json  TEXT          │
│ code           TEXT          │     │ submitted_at INTEGER     │
│ status         TEXT          │     └─────────────────────────┘
│   ('playing' | 'finished')  │
└─────────────────────────────┘

┌─────────────────────────────┐     ┌─────────────────────────┐
│       completed_games        │     │   game_replay_rounds    │
├─────────────────────────────┤     ├─────────────────────────┤
│ game_id     TEXT PK (UUID)   │──┐  │ game_id    TEXT FK       │
│ room_id     TEXT             │  │  │ round_num  INTEGER       │
│ hero_player_id TEXT FK       │  │  │ pre_state_json TEXT      │
│ witch_player_id TEXT FK      │  └─→│ steps_json     TEXT      │
│ winner       TEXT            │     │                         │
│ win_reason   TEXT            │     │ PK(game_id, round_num)  │
│ total_rounds INTEGER         │     └─────────────────────────┘
│ mode         TEXT            │
│ players_json TEXT            │
│ pinned       INTEGER         │
└─────────────────────────────┘
```

### Stats & Async Tables

```
┌─────────────────────────────┐     ┌─────────────────────────┐
│        game_stats            │     │       async_games       │
├─────────────────────────────┤     ├─────────────────────────┤
│ id             INTEGER PK    │     │ room_id    TEXT PK       │
│ winner         TEXT          │     │ (similar to game_saves)  │
│ rounds         INTEGER       │     │ Legacy — being migrated  │
│ hero_kills     INTEGER       │     │ into game_saves          │
│ witch_kills    INTEGER       │     └─────────────────────────┘
│ witch_summons  INTEGER       │
│ hero_personality TEXT        │     ┌─────────────────────────┐
│ witch_personality TEXT       │     │     device_tokens        │
│ map_size       TEXT          │     ├─────────────────────────┤
│ win_reason     TEXT          │     │ player_id  TEXT FK       │
│ duration_ms    INTEGER       │     │ token      TEXT          │
│ game_version   TEXT          │     │ platform   TEXT          │
│ mode           TEXT          │     │ created_at INTEGER       │
│ players        INTEGER       │     └─────────────────────────┘
│ created_at     DATETIME      │
└─────────────────────────────┘
```

---

## State Serialization

### Serialize (`serializeState`)

`server/state-sync.js` converts a live `GameState` into a plain JSON snapshot:

```
GameState (live)                    Snapshot (JSON)
─────────────────                   ─────────────────
state.tiles (Map)           →       tiles: [{ key, col, row, type,
                                      building, road, explored,
                                      resource, fortifyLevel,
                                      roadDirs: [...],
                                      footprintHexes: [...],
                                      buildingFootprintOf }, ...]

state.entities (Entity[])   →       entities: [{ id, type, owner,
                                      ownerId, col, row, hp, maxHp,
                                      attack, defense, weapon,
                                      items, name, title, ... }, ...]

state.phase, round, etc.    →       Scalar fields copied directly

state.exploredHexes (Map)   →       exploredHexes: { factionId: [...keys] }

state.players (Map)         →       players: [{ id, faction, ... }]
```

### Deserialize (`deserializeState`)

Reconstructs a full `GameState` with proper prototypes. The current `SAVE_VERSION` is **6** (`src/version.js`). Includes back-compat migrations for older save formats:

- **pre-`SAVE_VERSION=2`** — rewrites entity types of `'hero'` to `'paladin'` (the entity-type rename in the faction-expansion work; see `docs/design/faction-expansion.md`).
- **pre-`SAVE_VERSION=6` building footprints** — any tile that carries a `building` but has an empty/missing `footprintHexes` is auto-migrated to the two-hex compound (see [05-game-systems.md → Building Footprints](05-game-systems.md#building-footprints)). Buildings are processed in **sorted-key order** (row, then col) and each picks an eligible adjacent footprint via `pickFootprintNeighbor()` with **no `rand`** — i.e. the first eligible neighbour in odd-r direction order `0..5`. This is fully deterministic, so every client/server reconstructs the same footprints from the same legacy save. **Orphans** (a building with no eligible adjacent hex — wedged against river/edge/other buildings) are warned once and left as a valid 1-hex building (`footprintHexes: []`).

```
1. Create throwaway GameState (for prototype chain)
2. Restore tiles as Map<key, Tile>
   ├── Convert roadDirs arrays back to Sets
   └── Auto-migrate legacy buildings → footprints (pre-v6)
3. Restore entities as real Entity instances
   └── Attach methods: takeDamage(), heal(), etc.
4. Set leader references (state.hero, state.witch)
5. Restore player registry (or synthesize for legacy saves)
6. bumpEntityId() past all restored IDs (prevent collisions)
7. Restore scalar fields + reset planning state
```

---

## Save & Resume Flow

### When Games Are Saved

```
After each round completes
  └── lobby.js calls saves.upsertSave(roomId, state, config, players)
       ├── serializeState(state) → JSON
       ├── Upsert into game_saves table
       └── Insert replay round into save_replay_rounds

When all humans disconnect (long-timeout games)
  └── Room hibernates to DB immediately

On server restart
  └── pruneStaleAndIncompatibleSaves() removes outdated saves
```

### Resume Flow

```
Client                          Server
  │                               │
  │── resumeSave(roomId) ────────→│
  │                               │ Is room in memory?
  │                               │   ├── YES → _startPlanningPhase()
  │                               │   └── NO  → _recoverRoom(roomId)
  │                               │              ├── Load from game_saves
  │                               │              ├── deserializeState()
  │                               │              ├── Reconstruct seats
  │                               │              └── Fill AI opponents
  │                               │
  │                               │ handleReconnect(playerId, roomId, ws)
  │                               │   ├── Find seat
  │                               │   ├── If AI-replaced → swap back
  │                               │   └── Attach new WebSocket
  │                               │
  │←── reconnected ───────────────│
  │←── stateUpdate ───────────────│
  │←── planningPhase ─────────────│ (if in planning)
```

### Hibernation

When all humans leave a game:

```
All humans disconnected
  │
  ├── Short-timeout game (< 1 hour):
  │     Wait 60s → hibernate to DB → remove from memory
  │
  └── Long-timeout game (≥ 1 hour):
        Hibernate immediately to DB → remove from memory
        Background deadline checker auto-resolves expired turns
```

---

## Game Stats Recording

After each game ends, `server/game-stats.js` records:

```
recordGameStats({
  winner,              // 'hero' or 'witch'
  rounds,              // total rounds played
  heroKills,           // hero faction kills
  witchKills,          // witch faction kills
  witchSummons,        // total summons by witch
  heroPersonality,     // AI personality name
  witchPersonality,    // AI personality name
  mapSize,             // 'skirmish' | 'standard' | etc.
  winReason,           // WIN_REASON enum value
  durationMs,          // wall-clock game duration
  gameVersion,         // from src/version.js
  mode,                // 'local' | 'online' | 'headless'
  players              // player count
})
```

The `admin-stats.html` dashboard queries these stats via REST endpoints for aggregate analytics (win rates, round distributions, personality performance, etc.).

---

## Completed Games & Replay Storage

When a game finishes:

```
1. Insert completed_games record
   (game_id, room_id, players, winner, win_reason, total_rounds)

2. Copy all save_replay_rounds → game_replay_rounds
   (pre_state_json + steps_json per round)

3. Delete from game_saves (no longer in-progress)

4. pruneExpiredCompletedGames() runs periodically
   (keeps pinned games indefinitely, prunes old unpinned ones)
```

Completed game replays are available via the client's PLAYBACK mode — the full game can be rewatched from round 1 using the stored per-round snapshots.

---

## Authentication & Player Identity

### Token Flow

```
New player:
  Client sends: { type: 'auth', username: 'PlayerName' }
  Server: validate name → assign discriminator → generate UUID token
  Server stores: players row with token
  Client persists: token to localStorage as 'brimstone_session'

Returning player:
  Client sends: { type: 'auth', token: '<uuid>' }
  Server: lookup by token → return player record
```

### Multi-Identity Linking

```
┌─────────────┐
│   Player     │
│  (id, token) │
└──────┬──────┘
       │
       ├── identity: email (magic link login)
       ├── identity: gamecenter (iOS Game Center)
       └── (token-based is always present)
```

Players can link email and Game Center identities for cross-device access. Magic links (one-time tokens via email) provide passwordless authentication.

---

## JSON Mission Format (offline/campaign)

Campaign missions are **on-disk content**, not database rows: each mission is a JSON file under `src/campaign/missions/*.json` (8 migrated missions — the 7 Caleb's Hollow prologue missions + the tutorial). This is **offline/campaign-only** — campaigns run through `src/main.js`; `server/lobby.js` has no campaign path, so the loader has **no online parity concern** and never touches `state-sync.js` or the DB.

### `schema: 1` format

A mission JSON mirrors the runtime mission-def shape verbatim for every field *except* three that can't live in plain data (which become string keys), plus the new `map` sub-object:

| Field | Notes |
|-------|-------|
| `id`, `title`, `chapter`, `campaignId`, `requires` | identity / ordering |
| `briefing`, `victoryText`, `defeatText` | story text |
| `phaseCycle`, `mapSize`, `hasWitch`, `disableScoring`, `aiPersonality`, `aiBudgetBonus`, `startingResources`, `rewards`, `healBonus`, `lootOverrides`, survivor counts | scalars, passed through untouched |
| `enemyUnits`, `waves`, `survivorStartPositions`, `objectives` | mirror the runtime shape verbatim |
| `map` | **new** — `mode: "handmade"` or `"procedural"`; built by `buildMissionMap` (see [05-game-systems.md](05-game-systems.md#campaign-mission-maps-srccampaignmission-mapjs)) |
| `storyTriggers[].condition` | **string key** into the condition registry (`src/campaign/condition-registry.js`), resolved to a predicate fn |
| `conductor.scriptKey` | **string key** into the conductor-script registry (`src/campaign/conductor-scripts.js`), resolved to `{ steps, config }` |

`src/campaign/missions/Ch1M6.json` is the canonical example (a `handmade` map with a `notHoldingAllNodes` condition); `tutorial.json` is the canonical conducted example (`conductor.scriptKey: "tutorial"`). See [docs/design/campaign-mission-editor.md](design/campaign-mission-editor.md) for the full schema.

**Building footprints in mission tiles.** A tile def that carries a `building` is an **entrance** and lists its impassable footprint hex(es) in `footprintHexes: ["col,row", ...]`; the footprint tile def carries the `buildingFootprintOf: "col,row"` back-pointer (see [05-game-systems.md → Building Footprints](05-game-systems.md#building-footprints)). The loader (`_applyTileDef`, `src/campaign/mission-map.js`) copies both fields **verbatim** — it never auto-derives them. A building with no `footprintHexes` falls back to the Tile-constructor defaults (`[]` / `null`) and stays a valid 1-hex building, so pre-footprint missions still load. Runtime `validateMissionJSON` deliberately does **not** check footprints (backward compat); the stricter editor-only `validateBuildingFootprints` does.

**One-shot migration of bundled missions.** `scripts/migrate-building-footprints.js` rewrote the 8 bundled mission JSONs to add footprints. It is **one-shot/idempotent** (skips any mission whose tiles already carry `footprintHexes`), **deterministic** (uses the shared `pickFootprintNeighbor()` with no `rand` → first eligible neighbour in odd-r dir `0..5`), and **self-verifying** (re-runs each rewritten mission through `validateMissionJSON` → `loadMissionJSON` → `mapBuilderFn()` and aborts loudly on any failure). Orphan buildings are left 1-hex (`footprintHexes: []`). All 8 missions migrated; **3** then needed a post-migration hand-rotation off resource hexes (the deterministic picker had landed a footprint on a resource, making it unreachable once the footprint became impassable — commit `dc1b757`).

### Loader (`src/campaign/json-mission.js`)

`loadMissionJSON(parsed)` takes an **already-parsed** object (so the browser `fetch` path and the node `fs` path share one code path), validates it, then returns a runtime mission def indistinguishable from a hand-written JS mission:

- `map` → a lazy `mapBuilderFn` closure over `buildMissionMap` is attached; the raw `map` sub-object is preserved (main.js detects JSON missions by its presence).
- `storyTriggers[].condition` string → predicate fn via `resolveCondition`.
- `conductor.scriptKey` → surfaced as `conductorSteps` / `conductorConfig`; the `schema` / `conductor` fields are stripped.

`validateMissionJSON` throws a `MissionValidationError` on the first problem and applies four hardening checks: **(1)** every authored tile must sit inside the map extent (handmade `cols`/`rows`, or the procedural `mapSize` grid); **(2)** `objectives.win`/`objectives.lose` types must be in `KNOWN_OBJECTIVE_TYPES`; **(3)** a handmade map must define `heroStart` (and `witchStart` when `hasWitch`); **(4)** `map.roadSeed` is carried verbatim so handmade road-regen determinism survives save→load. `KNOWN_OBJECTIVE_TYPES` mirrors the full 17-case `switch` in `buildVictoryDelegate()` (`src/campaign/campaign.js`) — that switch is the source of truth, and a guard test pins the set equal to it.

> **Note (conductor scripting):** the tutorial's imperative scripting (`TUTORIAL_STEPS`, witch plan provider, forced dice) is **not** declarative and stays in `src/tutorial/tutorial-config.js`. The conductor-script registry only *aggregates* those pieces under the key `"tutorial"` — they are not physically relocated.

### Registration (`src/campaign/campaign-registry.js`)

The campaign defs (`prologue`, `calebs-hollow-prologue`) are thin shells; their `missions[]` and `mapBuilders` are populated at module init. `campaign-registry.js` declares `MIGRATED_MISSIONS` (mission id → campaign id, in canonical order) and registers each via `registerJSONMissions` → `registerMissionJSON`. Loading is environment-aware: **node** (`window` undefined → tests, headless runner) reads via `fs`; any **webview** (browser, Electron, Capacitor) reads via same-origin `fetch`. Both feed the same parsed object to `loadMissionJSON`. The module uses **top-level `await`**, so any importer (the app, headless scripts, tests) transparently waits for a fully populated registry.

## Data Flow Summary

```
                    ┌─────────────┐
                    │  Browser    │
                    │  Client     │
                    └──────┬──────┘
                           │ WebSocket
                           ▼
┌──────────────────────────────────────────────────┐
│                   server.js                       │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ lobby.js │  │ auth.js  │  │ game-stats.js │  │
│  │          │  │          │  │               │  │
│  │ rooms    │  │ tokens   │  │ analytics     │  │
│  │ planning │  │ identity │  │ recording     │  │
│  │ resolve  │  │ linking  │  │               │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │              │                │          │
│  ┌────┴──────────────┴────────────────┴───────┐  │
│  │           state-sync.js                    │  │
│  │     serialize ←→ deserialize               │  │
│  └────────────────────┬───────────────────────┘  │
│                       │                          │
│  ┌────────────────────┴───────────────────────┐  │
│  │              saves.js                      │  │
│  │  upsertSave / getSave / pruneStale         │  │
│  └────────────────────┬───────────────────────┘  │
│                       │                          │
│  ┌────────────────────┴───────────────────────┐  │
│  │     db.js → db/index.js (backend switch)   │  │
│  │  ┌──────────────┐     ┌──────────────────┐ │  │
│  │  │ sqlite/*.js  │ OR  │  postgres/*.js   │ │  │
│  │  │ better-      │     │  pg-native       │ │  │
│  │  │ sqlite3      │     │  (libpq sync)    │ │  │
│  │  └──────┬───────┘     └────────┬─────────┘ │  │
│  └─────────┼────────────────────── ┼───────────┘  │
│            │                       │              │
└────────────┼───────────────────────┼──────────────┘
             │                       │
             ▼                       ▼
     ┌──────────────┐         ┌──────────────────┐
     │ brimstone.db │         │ Postgres 13+ +   │
     │   (SQLite)   │         │ citext extension │
     └──────────────┘         └──────────────────┘
```
