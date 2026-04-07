# Data Persistence & Save System

## Database Layer

### Stack

- **Engine:** SQLite via `better-sqlite3` (synchronous, WAL mode)
- **Abstraction:** `server/db-backend.js` wraps better-sqlite3 behind a minimal interface
- **Singleton:** `server/db.js` creates the default backend
- **Schema:** `server/schema.js` contains all DDL (table definitions)
- **Storage:** `data/brimstone.db` (configurable via `DB_PATH` env var)

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Consumer modules                                        │
│  (auth, saves, leaderboard, game-stats, push, etc.)      │
│                                                          │
│  All import:  import db from './db.js'                   │
│  All call:    db.prepare(sql).run(...)                   │
│               db.prepare(sql).get(...)                   │
│               db.prepare(sql).all(...)                   │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  db.js (singleton)                                       │
│  Creates default DbBackend with DB_PATH or in-memory     │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  db-backend.js (DbBackend class)                         │
│  ├── prepare(sql) → Statement                            │
│  ├── exec(sql)    → run raw SQL                          │
│  ├── close()      → close connection                     │
│  └── constructor runs schema.js DDL on init              │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  better-sqlite3 (npm)                                    │
│  WAL mode enabled for concurrent read/write              │
│  Supports in-memory databases for testing                │
└──────────────────────────────────────────────────────────┘
```

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
                                      roadDirs: [...] }, ...]

state.entities (Entity[])   →       entities: [{ id, type, owner,
                                      ownerId, col, row, hp, maxHp,
                                      attack, defense, weapon,
                                      items, name, title, ... }, ...]

state.phase, round, etc.    →       Scalar fields copied directly

state.exploredHexes (Map)   →       exploredHexes: { factionId: [...keys] }

state.players (Map)         →       players: [{ id, faction, ... }]
```

### Deserialize (`deserializeState`)

Reconstructs a full `GameState` with proper prototypes:

```
1. Create throwaway GameState (for prototype chain)
2. Restore tiles as Map<key, Tile>
   └── Convert roadDirs arrays back to Sets
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
│  │           db.js → db-backend.js            │  │
│  │              better-sqlite3                │  │
│  └────────────────────┬───────────────────────┘  │
│                       │                          │
└───────────────────────┼──────────────────────────┘
                        │
                        ▼
                 ┌──────────────┐
                 │ brimstone.db │
                 │   (SQLite)   │
                 └──────────────┘
```
