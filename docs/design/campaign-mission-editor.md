# Caleb's Hollow Tools — Unified Editor + Campaign Mission Editor

> **Status:** Approved design, not yet implemented. This document is the spec for a
> future agent to build against. It was produced after a full exploration of the
> existing tools, campaign runtime, and map/tile systems.

## Context

Brimstone has two standalone admin tools today — an **Asset Viewer** (`admin-assets.html`,
Babylon 3D model browser) and a **Lighting Tuner** (`admin-lighting.html`, Renderer3D +
GameState). We want to merge them into a single tabbed **Caleb's Hollow Tools** page and
add a third, much larger tab: a **Campaign Mission Editor**.

The campaign runtime already exists and is largely declarative: `src/campaign/` holds a
Campaign class, a registry, a victory-delegate system, wave/story-trigger processors, and a
7-mission campaign (`calebs-hollow-prologue.js`) plus a scripted tutorial (`prologue.js`).
Mission definitions are plain objects (id/title/briefing/victoryText/defeatText/phaseCycle/
mapSize/enemyUnits/waves/objectives/storyTriggers/…), and `mapBuilder` is already a **string
key** into a per-campaign builder registry. The gaps are: (1) maps are produced by imperative
`buildXMap()` functions, not data; (2) there is no authoring UI; (3) there is no on-disk,
editor-friendly mission format.

**Goal:** a data-driven JSON mission format + a runtime loader, a unified tools page, a 2D
tile-painting/event-authoring editor with a 3D preview, and a **migration of the existing
missions to JSON** so they can be tweaked in the editor.

### Decisions locked with the product owner
- **Editor map canvas:** 2D authoring via `src/renderer.js` (`new Renderer(canvas, state)`,
  `renderer.canvasToHex(x,y)` for click→hex), plus a **"Preview in 3D"** button that
  instantiates `Renderer3D` on the built GameState (same pattern as the lighting tab).
- **File I/O:** browser **file picker + download** only. **No server read/write endpoints.**
  (Adding a static route to *serve* the new HTML page is fine and required.)
- **Format:** declarative **JSON** missions + a runtime loader, registered alongside the
  existing JS campaigns.
- **Migration:** migrate the current missions to JSON (primary goal, not optional). The owner
  intends to use the editor to tweak the existing mission set.

## Key existing code to reuse (do not reinvent)
- `src/map.js` — `generateMap(seed, mapSize, nodeCount)` → `{tiles, witchObjectives, heroStart,
  witchStart, mapSize, season, survivorCounts}`; `MAP_SIZES`; `rng`, `bfsPath`, `shuffle`,
  river/forest helpers. The MST road-network logic is **duplicated** here and in
  `calebs-hollow-prologue.js` (`buildRoadNetwork`).
- `src/tiles.js` — `Tile{col,row,type,building,explored,resource,fortifyLevel,roadDirs:Set}`
  + ad-hoc `tile.hiddenSurvivor`; `TileType`, `BuildingType`, `ResourceType` enums.
- `src/hex.js` — `hexKey`, `setMapDimensions`, `getNeighbors`, `hexDistance`,
  `pixelToHex`/`hexToPixel`.
- `src/campaign/campaign.js` — `buildVictoryDelegate(objectives)` (`~:92`),
  `processWaves(state, waves, createEnemyFn)` (`~:328`), `getMapBuilder`/`getMissionDef`.
- `src/campaign/missions.js` — `processStoryTriggers(state, triggers, storyFlags)`, `ObjectiveType`.
- `src/main.js` — `_initCampaignMission(missionDef)` (`~:2869`): builds GameState from a mission
  def. This is the integration point.
- `server/state-sync.js` — `serializeState`/`deserializeState` (already serialize `roadDirs`).
- `server.js` (`~:689–693`) — static admin routes pattern.

## Imperative code that must find a home (from current missions)
1. **7 map builders** (`buildPrologueMap` … `~:161–663`): seeded but hand-rolled (do **not**
   call `generateMap`). → migrate via **snapshot to `handmade` maps** (lossless; loses
   seed-regen for those maps, acceptable since they're bespoke and edited directly).
2. **One closure** `notHoldingAllNodes` → moves to a **condition registry**, referenced by name.
3. **Tutorial conductor scripting** (`TUTORIAL_STEPS`, `witchPlanProvider`, `forcedDice`,
   spotlights) → cannot be declarative. Stays JS, referenced from JSON by **`conductor.scriptKey`**;
   its map/dialog/waves still author in the editor.

---

## Mission JSON schema (v1)

```jsonc
{
  "schema": 1,
  "id": "prologue", "title": "The Awakening", "chapter": 1,
  "campaignId": "calebs-hollow-prologue", "requires": null,
  "briefing": "…", "victoryText": "…", "defeatText": "…",
  "phaseCycle": { "phases": ["dawn","day","day","day"], "loop": true },
  "mapSize": "skirmish", "hasWitch": false, "disableScoring": true,
  "aiPersonality": "balanced", "aiBudgetBonus": 0,
  "maxSurvivorsFromRoster": 0, "missionSurvivors": 1, "maxDiscoverableSurvivors": 0,
  "startingResources": { "food":1 }, "rewards": { "herbs":2 }, "healBonus": 2,
  "lootOverrides": { "remove": ["horse"] },
  "map": { /* see below */ },
  "enemyUnits": [ { "type":"zombie", "col":3, "row":2, "overrides":{"attack":1} } ],
  "waves": [ { "trigger":"hero_kills", "count":3, "units":[ … ] } ],
  "survivorStartPositions": [ { "col":2, "row":7 } ],
  "objectives": { "win": { "type":"eliminate_all", "reason":"…" }, "lose": { "type":"hero_killed" } },
  "storyTriggers": [
    { "type":"round", "round":1, "title":"…", "text":"…", "flag":"intro" },
    { "type":"area",  "hexes":[{"col":4,"row":7}], "title":"…", "text":"…", "flag":"found" },
    { "type":"round", "round":4, "condition":"notHoldingAllNodes", "title":"…", "text":"…" }
  ],
  "conductor": { "scriptKey": "tutorial" }   // optional
}
```

`enemyUnits`, `waves`, `survivorStartPositions`, `objectives`, `storyTriggers` mirror the
**current** runtime shape verbatim (so the loader is a thin pass-through). Only `map` is new,
and `condition`/`conductor` become string keys.

### `map` sub-schema (the "slight change to the map system")

**Handmade** (full explicit tiles — migration target):
```jsonc
"map": {
  "mode": "handmade", "cols": 9, "rows": 9,
  "heroStart": {"col":2,"row":7}, "witchStart": {"col":7,"row":1},
  "witchObjectives": [ { "col":5,"row":4, "hexes":[{"col":5,"row":4}, …] } ],
  "roadNodes": ["2,7","4,5", …],     // tiles flagged as road-graph waypoints
  "tiles": [ { "col":2,"row":7, "type":"BUILDING","building":"INN","fortifyLevel":1,
               "resource":null, "hiddenSurvivor":false, "roadDirs":["3,6"] }, … ]
}
```

**Procedural + overlay** (requirement #7):
```jsonc
"map": {
  "mode": "procedural", "seed": 12345, "mapSize": "standard", "nodeCount": 3,
  "overlay": {
    "tiles":   [ { "col":4,"row":5,"type":"BUILDING","building":"CHURCH" }, … ],  // replaces base tiles
    "roadNodes": { "add": ["4,5"], "remove": ["7,2"] },
    "heroStart": {"col":…}, "witchStart": {"col":…},     // optional overrides
    "hiddenSurvivors": { "add": ["3,4"], "remove": ["8,1"] },
    "witchObjectives": [ … ]                              // optional node overrides
  }
}
```

**Road-graph model (requirement #2):** the source of truth for connectivity is the
**road-node set**. Buildings and bridges are **implicitly** nodes; the editor toggles
additional tiles on/off. Roads (`ROAD`/`BRIDGE` tile types + `roadDirs`) are **derived** by the
shared connector and re-derived on demand via a "Regenerate Roads" action. Handmade tiles
persist the derived `roadDirs` so loading is lossless without forcing a regen.

---

## Implementation

### New files
- `src/road-network.js` — extracted shared road builder (see P0).
- `src/campaign/mission-map.js` — `buildMissionMap(mapDef)` (handmade + procedural/overlay).
- `src/campaign/json-mission.js` — `loadMissionJSON(parsed)` → runtime mission def; mission
  fetch/registration helpers.
- `src/campaign/condition-registry.js` — `CONDITIONS = { notHoldingAllNodes }`.
- `src/campaign/conductor-scripts.js` — `CONDUCTOR_SCRIPTS = { tutorial: { steps, config } }`
  (moved from `prologue.js`).
- `src/campaign/missions/*.json` — migrated mission files (loaded at runtime via same-origin `fetch`).
- `scripts/migrate-missions.js` — one-shot exporter (JS missions → JSON).
- `admin-tools.html` — unified tabbed tools page.
- `src/tools/mission-editor.js` — editor controller (model, 2D renderer, click→hex edit loop, undo).
- `src/tools/mission-editor-ui.js` — DOM panels (palette, forms, load/save, 3D preview).
- Tests under `tests/`.

### Modified files
- `src/map.js` — call the extracted `src/road-network.js` (no behavior change).
- `src/campaign/campaigns/calebs-hollow-prologue.js` — use shared road builder; eventually
  replaced by JSON.
- `src/campaign/campaign.js` / `campaign-registry.js` — load JSON missions alongside JS;
  resolve `mapDef`/`condition`/`conductor.scriptKey`.
- `src/main.js` — `_initCampaignMission` accepts a resolved map def (call `buildMissionMap`)
  and resolved conditions.
- `server.js` — add `app.get('/admin/tools', …res.sendFile('admin-tools.html'))` and a link
  from `admin.html`.

### `buildMissionMap(mapDef)` contract
Returns the **same shape** existing builders return: `{ tiles:Map, heroStart, witchStart,
witchObjectives, mapSize, survivorCounts, cols, rows }`.
- handmade: `setMapDimensions`; rebuild `Map<key,Tile>` from `tiles` (roadDirs→Set); apply
  starts/objectives.
- procedural: `base = generateMap(seed,mapSize,nodeCount)`; apply `overlay.tiles`; apply
  `roadNodes add/remove` then re-derive roads via `src/road-network.js`; apply
  start/hiddenSurvivor/objective deltas.

### Editor tool palette (requirements #1–#3)
Paint Tile (type) · Set Building · Set Resource · Place Hidden Survivor · Place Enemy Unit
(type+overrides) · Set Hero/Witch Start · Mark Road Node (+ "Regenerate Roads") · Place/Edit
Power Node. Mode toggle handmade↔procedural + seed field. Click → `renderer.canvasToHex` →
apply edit to model → `renderer.draw()`.

### Event/dialog authoring (requirements #4–#6)
Form panels over the existing schema: storyTriggers (round# OR area hexes, title/text/flag,
optional `condition` dropdown from registry), waves (trigger round/hero_kills/area + units +
spawnAt), objectives (win/lose over `ObjectiveType` + params), briefing/victoryText/defeatText
textareas, phaseCycle, resources/rewards. Validate the assembled JSON through `loadMissionJSON`
before download.

### Tab shell
`admin-tools.html`: tab bar (Assets | Lighting | Mission Editor). Port the two existing pages'
bodies into panels; **lazy-init each tab's canvas on first activation** (Assets = isolated
Babylon UMD; Lighting = Renderer3D; Editor = 2D Renderer, 3D preview on demand). Share
`/styles.css`.

---

## Phasing (each lands independently with tests)
- **P0 — Extract road builder** into `src/road-network.js`; rewire `map.js` + campaign file.
  Refactor only. Verify: `npm test`, `node scripts/headless.js 500 standard` within balance targets.
- **P1 — `buildMissionMap` + schema + condition registry.** Unit tests: handmade build,
  procedural overlay layering, road regen from nodes (symmetric `roadDirs`, bridges only over
  rivers, buildings/bridges auto-included).
- **P2 — Runtime loader + registration.** `loadMissionJSON`, fetch-based registration;
  `_initCampaignMission` accepts resolved map def. Tests: parsed JSON → valid mission object
  with resolved condition/conductor.
- **P3 — Migration.** `scripts/migrate-missions.js` emits the 7 prologue missions (snapshot
  `handmade` maps) + tutorial (JSON map/dialog/waves + `conductor.scriptKey:"tutorial"`).
  Round-trip equivalence test per mission (tiles, starts, enemyUnits, objectives, triggers,
  waves). Switch registry to JSON; remove JS originals once green.
- **P4 — Tab shell.** `admin-tools.html` + route + admin link; port Assets & Lighting tabs
  unchanged; empty Editor tab.
- **P5 — Editor core.** 2D render, tile painting, road-node toggle + regenerate,
  unit/survivor/start/power-node placement.
- **P6 — Authoring panels.** Events/dialog/objectives/waves/phaseCycle/resources forms + load
  (file picker) + save (download) + validation.
- **P7 — 3D preview** button (Renderer3D on built GameState).
- **P8 — Docs.** Update `docs/05-game-systems.md` (map gen), `docs/07-data-persistence.md` if
  needed, and CLAUDE.md "How to Add Content" → "New mission (JSON)".

## Risks & parity
- **`hiddenSurvivor` serialization:** confirm `serializeState`/`deserializeState` carry
  `tile.hiddenSurvivor`; if not, add it (missions depend on it).
- **`roadNode` is authoring-only** — lives in mission JSON, not GameState; verify nothing at
  runtime needs it post-build.
- **Offline-only:** campaigns run through `src/main.js` (offline). Confirm `server/lobby.js`
  has no campaign path, so loader changes don't need online parity. Still run
  `node scripts/headless.js 100 standard` after P0/P1.
- **No-build runtime JSON:** browser loads missions via same-origin `fetch` (dev server serves
  `src/`); node tests/migration read via `fs`. The loader takes a *parsed object* so both paths
  share it.
- **Snapshot fidelity:** migrated maps are frozen handmade snapshots — re-running the old
  builder is no longer their source of truth. Intentional.

## Verification
- `npm test` (incl. new map/loader/migration tests) green before each push.
- Balance unchanged after P0/P1: `node scripts/headless.js 500 standard`,
  `node scripts/combat-sim.js 200`.
- Manual: serve `npm run dev`, open `/admin/tools`; in Editor — load a migrated mission, paint
  tiles, toggle a road node + regenerate, place a survivor/enemy, edit a story trigger +
  objective, download JSON, reload it; "Preview in 3D"; then start the migrated mission
  in-game and confirm it plays identically to the JS original.
