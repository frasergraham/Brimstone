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

## Dual Renderer (2D / 3D)

The client supports two renderer implementations behind a common interface: the production 2D Canvas renderer (`src/renderer.js`) and an experimental Babylon.js 3D renderer (`src/renderer-3d.js`). `main.js` picks one at boot based on the `brimstone:renderer` localStorage value (`'2d'` is the default; the toggle lives in the **Options** setup card). Both classes share the constructor signature `(canvas, state)` and expose the same public method surface — `tests/renderer-interface.test.js` pins that contract so a new method on `Renderer` cannot land without a matching stub on `Renderer3D`. Babylon is loaded lazily from a pinned CDN ESM bundle inside the 3D renderer's first `draw()` call, which keeps the module importable in node-test and keeps page load free of Babylon for the 2D path. Phase 2 fills in terrain: every tile in `state.tiles` is built as a 6-sided cylinder mesh parented to a `mapRoot` TransformNode, with road decks, bridge planks, and building boxes layered on top; materials are cached by colour and each tile mesh tags its `{col,row}` in `metadata` so `canvasToHex` can use Babylon picking. The camera frames the whole map at startup and supports pan + zoom.

Phase 3 adds entity standees and selection. Each living entity in `state.entities` renders as a Y-axis-billboarded plane (portrait texture cropped from `assets/tilemap.png`) sitting on a coloured cylinder base whose colour comes from the owning player's slot palette (`Entity.color`, set by the game on leaders and propagated to summons/recruits). Leader entities scale up 1.2× width / 1.3× height. Standees are diffed against the live entity list on every `draw()` — new units spawn, dead units dispose, kept units re-position — and each plane stores `{kind:'entity', entityId, col, row}` in `metadata` so `canvasToHex` returns the standee's hex when a click would otherwise hit a neighbouring tile (standees sit above the tile prism so Babylon's closest-hit picker prefers them). Selection state continues to flow through `renderer.selectedEntityId` — `ui.js` writes it the same way for both renderers — and the 3D path responds by swapping the selected standee's base material to an emissive cyan and easing the camera target onto the unit via the consolidated Phase 4 `_focusCamera` animation.

Phase 4 unlocks yaw and consolidates focus animation. The alpha limits on the `ArcRotateCamera` are released so left-mouse drag (and two-finger touch drag) rotate around the vertical axis, while beta stays hard-locked at the isometric tilt so the board can't be flipped. Critically, the *camera* rotates rather than `mapRoot`, which keeps world space stable — `hexToCanvasPos` can keep passing `Matrix.Identity()` to `Vector3.Project` and picking remains correct under rotation. `frameHexes`, `resetView`, and the selection-driven focus shift all funnel through `_focusCamera(target, radius, opts)`, which animates target+radius over ~300ms via Babylon's `Animation` system with a cubic ease-in-out (constants `FOCUS_ANIM_FRAMES` / `FOCUS_EPSILON` exported from `renderer-3d.js`); shifts smaller than `FOCUS_EPSILON` short-circuit to a direct assignment, and `opts.instant` skips the animation entirely (used on first frame). Fog of war, plan overlays, and combat animations remain stubbed and land in subsequent phases.

Phase 5 fills in playback animations, plan-ghost arrows, HP bars, and floating combat text. The animation contract `main.js`/`ui.js` already expects from the 2D renderer (`addMoveAnim`, `addLungeAnim`, `addProjectileAnim`, `addAttackAnim`, `addFlash`, `addHpChangeFlash`, `returnAllLungeAnims`, `waitForAnimations`) now has a working 3D implementation. Internally the renderer tracks an `_animPromises` Set: each `addX()` builds one Promise that resolves when its underlying Babylon `beginDirectAnimation` fires its `onEnd` callback (or when a `setTimeout` fires for material-only effects like attack-hex flashes); `waitForAnimations()` awaits `Promise.all` of a snapshot of the set and each promise self-removes when it settles, so the queue drains cleanly between rounds. Move and lunge animations drive `position.x`/`position.z` on the entity's standee + base disc, and while the entity id is in `_activeMoveIds` / `_activeLungeIds` the per-frame `_syncEntityStandees` skips its `_positionStandee` snap so the animation isn't yanked back to the state position on the next redraw. Projectiles spawn a small sphere (colour by type — green sparkle for the witch, brown for hero ranged) that arcs between hex world positions then disposes. HP bars are always-on: a 0.6×0.12 billboarded plane parented to each standee's base disc, backed by a `DynamicTexture` that only redraws when `hp`/`maxHp` changes — colour is red below 33%, yellow below 66%, green at or above (constants `HP_RED_BELOW` / `HP_YELLOW_BELOW`). Plan ghost arrows rebuild every `draw()` from `this.planGhostSteps` using Babylon's `MeshBuilder.CreateDashedLines` (in-shader dashes — no manual segment-slicing) with a numbered badge plane at the destination hex. Pure helpers used by these systems (`interpolatePosition`, `planArrowPolyline`, `hpBarColor`, `floatingTextTransform`, `projectileColor01`, plus duration constants `MOVE_ANIM_MS` / `LUNGE_ANIM_MS` / `PROJECTILE_ANIM_MS` / `FLOAT_TEXT_MS`) are exported from `renderer-3d.js` and exercised by `tests/renderer-3d-anim.test.js` without instantiating a Babylon scene.

## Technology Stack

- **Client:** Vanilla JS ES modules, HTML5 Canvas 2D, CSS custom properties
- **Server:** Node.js, Express (static + REST), `ws` (WebSocket)
- **Database:** SQLite via `better-sqlite3` (WAL mode)
- **Mobile:** Capacitor (iOS native shell)
- **Desktop:** Electron
- **Hosting:** Railway (with environment auto-discovery)
