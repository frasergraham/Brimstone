# Module Dependency Graph

## Dependency Layers

Modules are organized into layers. Each layer only imports from layers below it.

```
Layer 6 ─ Orchestration    main.js, server.js
Layer 5 ─ Integration      lobby.js, ui.js, admin.js
Layer 4 ─ Intelligence     ai-engine.js, hero-ai-engine.js, resolver.js
Layer 3 ─ Middleware        ai.js, renderer.js, state-sync.js, multiplayer.js
Layer 2 ─ Game Logic        game.js, actions.js, planner.js, factions.js, map.js
Layer 1 ─ Data Model        entities.js, tiles.js, battle-utils.js
Layer 0 ─ Primitives        hex.js, app-mode.js, version.js, loot.config.js, platform.js
```

## Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 6: Orchestration                                              │
│  main.js ─────────── server.js                                      │
└────┬──────────────────────┬─────────────────────────────────────────┘
     │                      │
┌────┴──────────────────────┴─────────────────────────────────────────┐
│ Layer 5: Integration                                                │
│  ui.js          lobby.js          admin.js        notifications.js  │
└────┬──────────────┬───────────────────┬─────────────────────────────┘
     │              │                   │
┌────┴──────────────┴───────────────────┴─────────────────────────────┐
│ Layer 4: Intelligence                                               │
│  ai-engine.js     hero-ai-engine.js     resolver.js                 │
└────┬──────────────────┬─────────────────────┬───────────────────────┘
     │                  │                     │
┌────┴──────────────────┴─────────────────────┴───────────────────────┐
│ Layer 3: Middleware                                                  │
│  ai.js        renderer.js      state-sync.js     multiplayer.js     │
└────┬──────────────┬─────────────────┬───────────────────────────────┘
     │              │                 │
┌────┴──────────────┴─────────────────┴───────────────────────────────┐
│ Layer 2: Game Logic                                                 │
│  game.js    actions.js    planner.js    factions.js    map.js       │
│  post-round-effects.js                                              │
└────┬────────────────────────────────────────────────────────────────┘
     │
┌────┴────────────────────────────────────────────────────────────────┐
│ Layer 1: Data Model                                                 │
│  entities.js          tiles.js          battle-utils.js             │
└────┬────────────────────────────────────────────────────────────────┘
     │
┌────┴────────────────────────────────────────────────────────────────┐
│ Layer 0: Primitives (no internal dependencies)                      │
│  hex.js   app-mode.js   version.js   loot.config.js   platform.js  │
│  ai-names.js   ui-elements.js   schema.js                          │
└─────────────────────────────────────────────────────────────────────┘
```

## Full Import Graph

### Client (`src/`)

```
main.js
 ├── game.js
 ├── renderer.js
 ├── ui.js
 ├── ai.js
 ├── ai-engine.js
 ├── hero-ai-engine.js
 ├── multiplayer.js
 ├── planner.js
 ├── playback.js               ← full-game replay loop + playbackDelay
 ├── replay-timeline.js        ← pure step-digest for the replay timeline overlay
 ├── conversation-player.js    ← campaign conversation playback (bubbles, card, NEXT)
 ├── campaign/conversation-registry.js  ← md loader + role→entity binding
 │    └── campaign/conversation-parser.js  ← pure conversations/*.md parser
 ├── campaign/scripted-actions.js       ← spawn/move/despawn/wait NPC actions
 ├── app-mode.js
 ├── keybindings.js            ← in-game keyboard shortcuts + debug command console
 ├── version.js
 └── server/resolver.js        ← cross-boundary import

game.js
 ├── map.js
 ├── entities.js
 ├── tiles.js
 ├── hex.js
 ├── actions.js
 ├── factions.js
 └── post-round-effects.js

actions.js
 ├── hex.js
 ├── tiles.js
 ├── entities.js
 ├── game.js
 └── factions.js

renderer.js
 ├── hex.js
 ├── tiles.js
 ├── entities.js
 ├── actions.js
 ├── factions.js
 └── game.js

ui.js
 ├── hex.js
 ├── tiles.js
 ├── entities.js
 ├── game.js
 ├── renderer.js
 ├── actions.js
 ├── planner.js
 ├── battle-utils.js
 ├── ui-elements.js
 ├── ui-render.js
 └── server/resolver.js        ← for ResEventType enum only

ai.js
 ├── hex.js
 ├── tiles.js
 ├── entities.js
 ├── game.js
 └── actions.js

ai-engine.js (Witch AI)
 ├── ai.js
 ├── hex.js
 ├── game.js
 ├── entities.js
 ├── tiles.js
 └── planner.js

hero-ai-engine.js
 ├── ai.js
 ├── ai-engine.js
 ├── hex.js
 ├── game.js
 ├── entities.js
 ├── tiles.js
 └── planner.js

planner.js
 ├── hex.js
 ├── actions.js
 ├── tiles.js
 └── entities.js

entities.js
 └── tiles.js

tiles.js
 └── loot.config.js

map.js
 ├── hex.js
 └── tiles.js

multiplayer.js
 ├── hex.js
 └── platform.js

factions.js
 ├── game.js
 ├── entities.js
 ├── tiles.js
 └── hex.js
```

### Server (`server/`)

```
server.js (entry point)
 ├── server/lobby.js
 ├── server/auth.js
 ├── server/magic-link.js
 ├── server/leaderboard.js
 ├── server/game-stats.js
 ├── server/saves.js
 ├── server/admin.js
 ├── server/async-game.js
 ├── server/state-sync.js
 ├── server/push.js
 ├── server/game-mode-config.js
 ├── server/campaign-saves.js
 ├── server/campaign-game-stats.js
 └── src/version.js

lobby.js
 ├── src/game.js               ← imports shared game logic
 ├── src/ai.js
 ├── src/ai-engine.js
 ├── src/hero-ai-engine.js
 ├── src/map.js
 ├── src/entities.js
 ├── src/planner.js
 ├── src/battle-utils.js
 ├── src/ai-names.js
 ├── src/version.js
 ├── server/resolver.js
 ├── server/state-sync.js
 ├── server/leaderboard.js
 ├── server/game-stats.js
 ├── server/saves.js
 ├── server/async-game.js
 ├── server/notifications.js
 └── server/db.js

resolver.js
 ├── src/actions.js
 ├── src/entities.js
 ├── src/hex.js
 ├── src/planner.js
 ├── src/game.js
 ├── src/tiles.js
 └── src/factions.js

state-sync.js
 ├── src/version.js
 ├── src/entities.js
 ├── src/game.js
 └── src/hex.js
```

### Database Layer

```
db.js ──→ db-backend.js ──→ better-sqlite3 (npm)
                  │
                  └──→ schema.js (DDL constants)

All server modules that need persistence import db.js:
  auth.js ──→ db.js
  saves.js ──→ db.js
  game-stats.js ──→ db.js
  leaderboard.js ──→ db.js
  async-game.js ──→ db.js
  push.js ──→ db.js
  magic-link.js ──→ db.js
  campaign-saves.js ──→ db.js
  campaign-game-stats.js ──→ db.js
  admin.js ──→ db.js
  notifications.js ──→ db.js
```

## Cross-Boundary Imports

The server and client share code through direct ES module imports:

```
┌──────────────┐          ┌──────────────┐
│    Client     │          │    Server    │
│   (src/)      │          │  (server/)   │
│               │          │              │
│  ui.js ───────┼─import──→│ resolver.js  │  (ResEventType enum)
│               │          │              │
│               │←─import──┼─ lobby.js    │  (game.js, ai.js, entities.js,
│               │          │              │   planner.js, map.js, etc.)
│               │          │              │
│               │←─import──┼─ resolver.js │  (actions.js, entities.js, hex.js,
│               │          │              │   planner.js, game.js, tiles.js)
│               │          │              │
│               │←─import──┼─ state-sync  │  (entities.js, game.js, hex.js)
└──────────────┘          └──────────────┘
```

This works because all shared `src/` modules are DOM/Canvas-free — they contain pure game logic with no browser APIs.

## Circular Dependencies

One known circular dependency exists:

```
game.js ──imports──→ factions.js
factions.js ──imports──→ game.js (for Phase enum)
```

This is safe because JavaScript ES modules resolve circular imports through hoisting — the `Phase` enum is available by the time `factions.js` executes. No runtime errors occur.

## File Size Distribution

| Category | Files | Role |
|----------|-------|------|
| **Core logic** (`src/`) | 20+ modules | Game rules, AI, rendering, UI |
| **Server** (`server/`) | 15+ modules | Networking, persistence, auth |
| **Scripts** (`scripts/`) | 5 scripts | Headless testing, release automation |
| **Config** | `loot.config.js`, `schema.js` | Tuning tables, DDL |
| **Entry points** | `index.html`, `server.js` | Browser shell, Node server |
