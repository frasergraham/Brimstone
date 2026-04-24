# Architecture Overview

Brimstone is a browser-based, turn-based hex-grid strategy game. Two opposing **Sides** — **Day** and **Night** — fight across a procedurally-generated map set in cursed colonial New England. Each side has multiple selectable **Factions**: Day = Paladin / Rogue / Captain; Night = Witch / Necromancer / Brute. (See `docs/05-game-systems.md` for the per-faction stat tables and stub status.)

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser Client                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ renderer │ │   ui     │ │ planner  │ │  multiplayer  │  │
│  │ (Canvas) │ │  (DOM)   │ │ (ghost)  │ │  (WebSocket)  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬───────┘  │
│       │             │            │                │          │
│  ┌────┴─────────────┴────────────┴────┐          │          │
│  │           main.js (orchestrator)    │          │          │
│  └────┬──────────────────────────┬────┘          │          │
│       │                          │               │          │
│  ┌────┴─────┐  ┌─────────┐ ┌────┴────┐          │          │
│  │  game.js │  │actions.js│ │  ai.js  │          │          │
│  │ (state)  │  │ (rules) │ │ (plans) │          │          │
│  └────┬─────┘  └────┬────┘ └─────────┘          │          │
│       │              │                           │          │
│  ┌────┴──────────────┴───────────────┐           │          │
│  │  entities.js / tiles.js / hex.js  │           │          │
│  │         (data model layer)        │           │          │
│  └───────────────────────────────────┘           │          │
└──────────────────────────────────────────────────┼──────────┘
                                                   │ WebSocket
┌──────────────────────────────────────────────────┼──────────┐
│                    Node.js Server                 │          │
│  ┌───────────────────────────────────────────────┴───────┐  │
│  │              server.js (Express + WS router)          │  │
│  └──────┬────────────┬────────────┬──────────────────────┘  │
│         │            │            │                          │
│  ┌──────┴─────┐ ┌────┴─────┐ ┌───┴──────────┐              │
│  │  lobby.js  │ │ saves.js │ │  resolver.js │              │
│  │  (rooms)   │ │  (DB)    │ │  (lockstep)  │              │
│  └──────┬─────┘ └────┬─────┘ └──────────────┘              │
│         │            │                                      │
│  ┌──────┴────────────┴───────────────┐                      │
│  │  state-sync.js / auth.js / db.js │                      │
│  │       (persistence layer)         │                      │
│  └───────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

## Design Principles

1. **No build step.** Pure vanilla JS ES modules, HTML5 Canvas, plain CSS. No bundler, no transpiler, no framework.

2. **Server-authoritative state.** In online mode, the server owns all game state. Clients hold a read-only `MirrorState` snapshot and submit plans for server-side resolution.

3. **Shared game logic.** Core rules (`actions.js`, `entities.js`, `game.js`) are imported by both client and server. The resolver (`server/resolver.js`) runs identically in local and online modes.

4. **Strict separation of concerns:**

| Layer | Files | Responsibility |
|-------|-------|----------------|
| **Data model** | `hex.js`, `tiles.js`, `entities.js` | Coordinates, terrain, unit stats. No side effects. |
| **Game state** | `game.js` | Phase cycle, turn lifecycle, victory conditions. No rendering. |
| **Rules engine** | `actions.js` | All validation and execution. Pure `(state, actor, ...) → result`. |
| **Plan resolution** | `server/resolver.js` | Lockstep simultaneous-turn execution. Imported by both modes. |
| **AI** | `ai.js`, `ai-engine.js`, `hero-ai-engine.js` | Plan generation. Calls same `actions.js` functions as human players. |
| **Rendering** | `renderer.js` | Canvas 2D. Reads state, draws frames. Zero mutations. |
| **UI** | `ui.js` | Sole file touching DOM. Bridges user input to actions. |
| **Orchestration** | `main.js` | Wires everything. Owns mode transitions. Two code paths: local and online. |
| **Networking** | `multiplayer.js` (client), `lobby.js` (server) | WebSocket protocol, room management, reconnection. |
| **Persistence** | `state-sync.js`, `saves.js`, `db.js` | Serialize/deserialize, SQLite storage, save/resume. |

## Two Orchestration Paths

The game runs in two distinct modes that share core logic but have separate orchestration:

```
                    ┌─────────────────┐
                    │   Shared Core   │
                    │  game.js        │
                    │  actions.js     │
                    │  entities.js    │
                    │  resolver.js    │
                    │  planner.js     │
                    │  ai.js          │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
     ┌────────┴────────┐          ┌─────────┴────────┐
     │   Local Mode    │          │   Online Mode    │
     │   (main.js)     │          │   (lobby.js)     │
     │                 │          │                  │
     │ • AI vs AI      │          │ • 1v1 to 4v4    │
     │ • Human vs AI   │          │ • Lobbies        │
     │ • Human vs Human│          │ • Async games    │
     │ • Tutorials     │          │ • Spectating     │
     │ • Campaigns     │          │ • Save/Resume    │
     └─────────────────┘          └──────────────────┘
```

**Local mode** (`main.js`): Both factions resolve on the client. AI plans are generated locally. No network required.

**Online mode** (`lobby.js` + `main.js`): Server manages rooms, collects plans from all players, resolves on the server, and broadcasts results. Clients animate the resolution steps.

## Key Data Structures

| Structure | Type | Description |
|-----------|------|-------------|
| `state.tiles` | `Map<"col,row", Tile>` | O(1) hex lookup by string key |
| `state.entities` | `Entity[]` | All units (alive and dead) |
| `state.inventory` | `{ hero: {...}, witch: {...} }` | Side resource pools (storage keys remain `hero`/`witch`; access via `state.inventoryForSide('day'\|'night')`) |
| `state.nodeScore` | `{ hero: number, witch: number }` | Dawn/dusk scoring points (same side-keyed access via `state.nodeScoreForSide`) |
| `state.players` | `Map<playerId, PlayerRecord>` | N-player registry (online) |
| `PlanAction[]` | Array | Ordered queue of planned actions per player |
| `StepRecord[]` | Array | Resolution output: per-step events + entity snapshots |

## Technology Stack

- **Client:** Vanilla JS ES modules, HTML5 Canvas 2D, CSS custom properties
- **Server:** Node.js, Express (static + REST), `ws` (WebSocket)
- **Database:** SQLite via `better-sqlite3` (WAL mode)
- **Mobile:** Capacitor (iOS native shell)
- **Desktop:** Electron
- **Hosting:** Railway (with environment auto-discovery)
