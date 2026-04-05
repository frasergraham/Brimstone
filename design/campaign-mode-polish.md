# Campaign Mode Polish — Design Document

## Overview

Polish and extend the Salem Prologue campaign from 3 to 6 missions with richer maps, full fog of war, a narrative story trigger system, and per-mission loot overrides.

## Goals

1. **Richer maps** — Use the procedural map generator's river, MST road, forest cluster, and dirt patch algorithms in campaign map builders
2. **Longer missions** — Add enemy waves to missions 1 and 3; extend mission 2 from 8 to 10 rounds
3. **Full fog of war** — Switch all campaign missions from `'partial'` to `'full'` fog
4. **Story triggers** — Show narrative text at key moments (specific rounds or when the hero enters specific hexes)
5. **Per-mission loot overrides** — Allow missions to remove items (e.g. no horses) or override specific building/terrain loot tables
6. **6 missions** — Add Gathering Survivors, The River Crossing, and Dark Ritual between the existing 3

---

## Progress So Far

### Completed

#### 1. Export map helpers from `src/map.js`

Renamed and exported 6 private functions so campaign map builders can reuse them:

| Old name | New exported name | Purpose |
|----------|------------------|---------|
| `rng` (was unexported) | `rng` | Seeded PRNG |
| `bfsPath` (was unexported) | `bfsPath` | Dijkstra road pathfinding with hub penalties |
| `_shuffle` | `shuffle` | Fisher-Yates shuffle |
| `_generateRiver` | `generateRiverNS` | North-south meandering river |
| `_generateRiverEW` | `generateRiverEW` | East-west meandering river |
| `_buildRiverMap` | `buildRiverMap` | Row/col lookup for river side checks |
| `_riverSide` | `riverSide` | Which side of river a hex is on |

All internal call sites in `generateMap()` updated to use new names.

#### 2. Loot override system

**`src/game.js`** — Added `this.lootOverrides = null` to `GameState` constructor.

**`src/actions.js`** — Added `_effectiveLoot(state, category, key, defaultTable)` helper that:
- Returns full table override if `state.lootOverrides[category][key]` exists
- Filters out items in `state.lootOverrides.remove` array
- Falls back to default table

Updated the explore action to call `_effectiveLoot()` before `rollLoot()`.

**`src/main.js`** — In `_initCampaignMission()`, applies `missionDef.lootOverrides` to `state.lootOverrides`.

**Mission config shape:**
```javascript
lootOverrides: {
  remove: ['horse'],                    // Remove from ALL tables
  buildings: { barn: [{...}] },         // Override specific building table
  terrain: { road: [{...}] },           // Override specific terrain table
}
```

#### 3. Full fog of war

**`src/main.js`** line 1929 — Changed `state.fogOfWar = 'partial'` to `state.fogOfWar = 'full'`.

Full fog was already fully implemented (explored hex tracking, 3-tier bright/dimmed/black rendering, planning ghost integration). `state.updateExploredHexes()` is already called in `_startLocalPlanningPhase()`.

#### 4. Story trigger system

**`src/campaign/missions.js`** — Added `processStoryTriggers(state, triggers, storyFlags)`:
- Checks each trigger against current round (type `'round'`) or hero position (type `'area'`)
- Returns array of `{title, text}` events to display
- Sets `storyFlags[trigger.flag]` to prevent re-firing
- Flags persist in the Campaign save

**`index.html`** — Added `#story-modal` element (card with title, text, continue button).

**`styles.css`** — Added `.story-modal-card` styles: dark parchment background (`#1a1510`), gold title (`#d4a857`), italic cream text (`#c4b89a`), responsive mobile override.

**`src/ui.js`** — Added `showStoryModal(title, text)` method returning a Promise that resolves on dismiss.

**`src/main.js`** — Refactored `_startLocalPlanningPhase()`:
- Extracted planning-mode entry into `_enterLocalPlanningMode()`
- Added story trigger check before entering planning mode
- `_showStorySequence(events)` shows modals sequentially via async/await
- Story triggers only fire between rounds (not mid-resolution)

**Import added:** `import { processStoryTriggers } from './campaign/missions.js'`

**Mission config shape:**
```javascript
storyTriggers: [
  { type: 'round', round: 1, title: 'A Grim Dawn', text: '...', flag: 'prologue_intro' },
  { type: 'area', hexes: [{col:5, row:3}], title: 'The Clearing', text: '...', flag: 'found_clearing' },
]
```

---

### Remaining Work

#### 5. Rewrite 3 existing map builders (`salem-prologue.js`)

Each existing builder needs to be rewritten to use the exported map helpers. The pattern:

```javascript
import { rng, bfsPath, generateRiverNS, generateRiverEW, buildRiverMap,
         shuffle, riverSide, NODE_COLORS } from '../../map.js';

function buildXxxMap() {
  const COLS = ..., ROWS = ...;
  setMapDimensions(COLS, ROWS);
  const rand = rng(FIXED_SEED);     // deterministic seed per mission
  const tiles = makeTiles(COLS, ROWS);

  // 1. Carve river
  const riverPath = generateRiverNS(rand);  // or generateRiverEW
  const riverMap = buildRiverMap(riverPath);
  for (const {col, row} of riverPath) {
    const t = tiles.get(hexKey(col, row));
    if (t) t.type = TileType.RIVER;
  }

  // 2. Place buildings (hand-authored positions — same as before)
  setBuilding(tiles, col, row, BuildingType.INN, 1);
  // ... etc

  // 3. MST road network between buildings
  const buildings = [{col, row}, ...];
  // Kruskal MST on building positions, then bfsPath() for each edge
  // Convert river crossings to bridges (limited count)

  // 4. Forest clusters from seed positions
  for (const seed of forestSeeds) {
    const neighbors = getNeighbors(seed.col, seed.row);
    for (const {col, row} of [seed, ...neighbors]) {
      const t = tiles.get(hexKey(col, row));
      if (t && t.type === TileType.GRASS && rand() < 0.70) {
        t.type = TileType.FOREST;
        for (const n of getNeighbors(col, row)) {
          const t2 = tiles.get(hexKey(n.col, n.row));
          if (t2 && t2.type === TileType.GRASS && rand() < 0.40) t2.type = TileType.FOREST;
        }
      }
    }
  }

  // 5. Dirt patches (3-5 per map)
  for (let i = 0; i < 4; i++) {
    const grassTiles = [...tiles.values()].filter(t => t.type === TileType.GRASS);
    shuffle(grassTiles, rand);
    if (!grassTiles.length) break;
    grassTiles[0].type = TileType.DIRT;
    // spread to 0-2 neighbors
  }

  // 6. Resources + hidden survivors (same as before)
  // 7. Return mapData
}
```

##### buildPrologueMap (9x9)
- Add N-S river
- Replace linear roads with MST-based network, 1 bridge
- Forest clusters from 4 seeds
- 3-4 dirt patches
- Keep: 5 buildings (INN, Church, House, Blacksmith, Barn), 2 resources, 1 hidden survivor

##### buildFirstNightMap (13x13)
- Add E-W river (enemies cross from graveyard side)
- MST roads with 1-2 bridges
- Forest clusters from 6 seeds
- 5 dirt patches
- Keep: 8 buildings, 3 resources, 1 hidden survivor, 1 power node

##### buildWitchsTrailMap (13x13)
- Add N-S river dividing the map
- MST roads with bridges as chokepoints
- Dense forest clusters from 8+ seeds (deep forest theme)
- Dirt patches
- Keep: 8 buildings, 4 resources, 1 hidden survivor, 2 power nodes

#### 6. Add waves and loot overrides to existing missions

##### Mission 1 ("The Awakening")
```javascript
waves: [
  { round: 3, units: [{ type: 'zombie', spawnAt: 'map_edge' }] },
  { round: 5, units: [{ type: 'zombie', spawnAt: 'map_edge' }, { type: 'zombie', spawnAt: 'map_edge' }] },
],
lootOverrides: { remove: ['horse'] },
storyTriggers: [
  { type: 'round', round: 1, title: 'A Grim Dawn',
    text: 'The streets of Salem are eerily silent. Through the morning mist, you can make out shambling figures — the dead have risen. The Salem Inn stands behind you, its doors battered but holding. You must clear the village before nightfall.',
    flag: 'prologue_intro' },
],
```

##### Mission 2 ("The First Night") — now mission 3
```javascript
// Add round 9 wave, increase survive_rounds from 8 to 10
{ round: 9, units: [
  { type: 'zombie', spawnAt: 'graveyard' },
  { type: 'minion', spawnAt: 'map_edge' },
  { type: 'zombie', spawnAt: 'map_edge' },
]},
lootOverrides: {
  remove: ['horse'],
  buildings: { barn: [{type:'wood',weight:60},{type:'food',weight:35},{type:'nothing',weight:5}] },
},
storyTriggers: [
  { type: 'round', round: 1, title: 'Darkness Falls',
    text: 'The sun dips below the treeline and the temperature drops. From the direction of the old graveyard, you hear the scraping of earth and the crack of coffin wood. They are coming.',
    flag: 'first_night_start' },
  { type: 'round', round: 5, title: 'The Witching Hour',
    text: 'Midnight. The attacks intensify. Something more than zombies stirs in the darkness — you catch a glimpse of unnatural movement at the tree line. Whatever drives these dead, it is close.',
    flag: 'witching_hour' },
],
```

##### Mission 3 ("The Witch's Trail") — now mission 6
```javascript
waves: [
  { round: 3, units: [{ type: 'minion', spawnAt: 'graveyard' }] },
  { round: 5, units: [{ type: 'minion', spawnAt: 'graveyard' }, { type: 'minion', spawnAt: 'map_edge' }] },
  { round: 7, units: [{ type: 'wood_golem', spawnAt: 'graveyard' }] },
  { round: 10, units: [{ type: 'minion', spawnAt: 'map_edge' }, { type: 'wood_golem', spawnAt: 'graveyard' }] },
],
storyTriggers: [
  { type: 'round', round: 1, title: 'Into the Dark',
    text: 'The trail of corruption leads deep into the forest. The trees here are twisted and blackened, pulsing with malice. Somewhere ahead, a witch bends the land to her will.',
    flag: 'witchs_trail_start' },
  { type: 'round', round: 6, title: 'The Ritual Intensifies',
    text: 'A shockwave of dark energy ripples through the forest. The witch grows stronger with each passing moment — you must press the attack.',
    flag: 'ritual_intensifies' },
],
```

#### 7. Add 3 new missions

##### New mission order (6 total):
1. `prologue` — "The Awakening" (existing, polished)
2. `gathering_survivors` — "Gathering Survivors" (NEW)
3. `first_night` — "The First Night" (existing, polished)
4. `river_crossing` — "The River Crossing" (NEW)
5. `dark_ritual` — "Dark Ritual" (NEW)
6. `witchs_trail` — "The Witch's Trail" (existing, polished)

##### Mission 2: "Gathering Survivors"
- **Map:** 11x11 with N-S river, 7 buildings (INN, Church, 2 Houses, Barn, Apothecary, Stable), MST roads, 1-2 bridges, forest clusters
- **Objective:** Win: `eliminate_all`. Lose: `hero_killed`.
- **Theme:** Explore buildings to find survivors while clearing light zombie presence
- **Enemies:** 2 zombies pre-placed + waves at rounds 3 (1 zombie) and 6 (2 zombies)
- **hasWitch:** false, **disableScoring:** true
- **Survivors:** missionSurvivors: 2, maxDiscoverableSurvivors: 3
- **Resources:** Starting: food:1, herbs:1. Reward: food:2, herbs:1, wood:2
- **lootOverrides:** none (generous exploration)
- **storyTriggers:**
  - Round 1: "Voices in the Fog" — searching for other survivors
  - Area trigger near church: "Sanctuary" — sign of life

##### Mission 4: "The River Crossing"
- **Map: 17x9** — long narrow corridor! Road runs west→east, N-S river cuts across near the east end. 1-2 bridges as chokepoints. INN at west (start), Graveyard + Watchtower on far side. Forests flank the road.
- **Objective:** Win: `reach_hex` (far east side beyond river). Lose: `hero_killed` or `rounds_exceeded` (15 rounds).
- **Theme:** Fight through a narrow forest gauntlet and cross a defended river
- **Enemies:** 3 zombies + 1 minion along the road/bridges. Waves: round 4 (1 zombie), round 7 (1 minion + 1 zombie), round 10 (1 wood_golem)
- **hasWitch:** false, **disableScoring:** true
- **Survivors:** maxSurvivorsFromRoster: 2, missionSurvivors: 1
- **Resources:** Starting: food:2, wood:1. Reward: metal:2, wood:1, herbs:1
- **storyTriggers:**
  - Round 1: "The Long Road" — a trail through the wilderness
  - Area trigger at bridge: "The Crossing" — danger at the river

##### Mission 5: "Dark Ritual"
- **Map:** 13x13 with N-S river, dense forests, Graveyard, Church, 2 power nodes
- **Objective:** Win: `control_nodes` (standard node scoring). Lose: `hero_killed` or `rounds_exceeded` (20 rounds).
- **Theme:** Capture power nodes before dark forces complete their ritual. Introduces node mechanics before the final boss.
- **Enemies:** 3 minions + 1 wood_golem pre-placed. Waves: round 3 (1 minion), round 6 (2 minions), round 9 (1 wood_golem), round 12 (1 iron_golem)
- **hasWitch:** false (autonomous ritual — minions guard nodes)
- **disableScoring: false** (this mission uses standard node scoring!)
- **Survivors:** maxSurvivorsFromRoster: 3, missionSurvivors: 1, minSurvivors: 1
- **Resources:** Starting: metal:1, food:1. Reward: silver:1, scripture:1, metal:1
- **AI personality:** hoarder
- **lootOverrides:** `{ remove: ['horse'] }`
- **storyTriggers:**
  - Round 1: "Dark Energy" — strange forces at the power nodes
  - Round 4: "The Ritual Grows" — urgency to capture nodes

Each new mission needs a `buildXxxMap()` function.

#### 8. Update campaign metadata

```javascript
description: 'A cursed village, the walking dead, and a witch pulling the strings. Six missions stand between Salem and oblivion.',
```

Update `requires` chains: prologue → gathering_survivors → first_night → river_crossing → dark_ritual → witchs_trail.

#### 9. Update tests (`tests/campaign.test.js`)

1. Change `'prologue campaign has 3 missions total'` → `6`
2. Add tests for 3 new map builders (valid mapData: tiles, heroStart, cols, rows)
3. Add tests for `processStoryTriggers()`:
   - Round trigger fires on correct round
   - Area trigger fires when hero is on hex
   - Flag prevents re-firing
   - Returns empty for null triggers
4. Add tests for `_effectiveLoot()` (loot override filtering)
5. Update `getMissionList` expectations for 6 missions
6. Add test for `reach_hex` + `rounds_exceeded` combo (mission 4)

---

## Files Modified

| File | Status | Changes |
|------|--------|---------|
| `src/map.js` | **DONE** | Exported 7 helper functions (rng, bfsPath, shuffle, generateRiverNS, generateRiverEW, buildRiverMap, riverSide) |
| `src/game.js` | **DONE** | Added `this.lootOverrides = null` to GameState constructor |
| `src/actions.js` | **DONE** | Added `_effectiveLoot()`, updated explore loot resolution |
| `src/campaign/missions.js` | **DONE** | Added `processStoryTriggers()` export |
| `src/ui.js` | **DONE** | Added `showStoryModal()` method |
| `index.html` | **DONE** | Added `#story-modal` HTML element |
| `styles.css` | **DONE** | Added story modal styles + mobile responsive |
| `src/main.js` | **DONE** | Full fog, loot overrides, story trigger hooks, refactored planning phase |
| `src/campaign/campaigns/salem-prologue.js` | **TODO** | Rewrite 3 map builders, add 3 new missions + builders, story triggers, loot overrides, waves |
| `tests/campaign.test.js` | **TODO** | Update mission count, add story/loot/new-mission tests |

---

## Key Design Decisions

1. **Export helpers, not full procedural gen** — Campaign map builders call individual helper functions (river, road pathfinding, shuffle) rather than `generateMap()`. This preserves hand-authored building placement and narrative map design while adding rich terrain.

2. **Non-standard map dimensions** — Campaign maps are not limited to square presets. The River Crossing uses a 17x9 corridor. `setMapDimensions()` accepts any cols/rows; the `mapSize` string only controls gameplay config (action budgets).

3. **Story triggers between rounds only** — Triggers fire at the start of planning phase, not mid-resolution. This avoids interrupting animations and keeps the implementation simple. Area triggers check hero position after the previous round resolves.

4. **Loot override layering** — Full table overrides take priority over item removal. If `overrides.buildings.barn` exists, it replaces the entire barn table. Otherwise, `overrides.remove` filters from the default table.

5. **Deterministic map seeds** — Each map builder uses `rng(FIXED_SEED)` for reproducible maps. Different seed per mission ensures variety.

6. **Mission progression** — Linear chain: prologue → gathering_survivors → first_night → river_crossing → dark_ritual → witchs_trail. Each mission's `requires` field gates unlock.

---

## How to Resume Implementation

The infrastructure (map helpers, loot overrides, story triggers, fog, UI) is all wired up. The remaining work is content authoring:

1. Open `src/campaign/campaigns/salem-prologue.js`
2. Import the new map helpers at the top
3. Rewrite each `buildXxxMap()` function following the pattern in "Rewrite 3 existing map builders" above
4. Add 3 new `buildXxxMap()` functions for the new missions
5. Update mission definitions with waves, storyTriggers, lootOverrides
6. Reorder MISSIONS array to the 6-mission sequence
7. Update `MAP_BUILDERS` to include new builders
8. Update `description` and `firstMission`
9. Update tests

The map builder pattern is consistent — just apply it 6 times with different building placements, river orientations, forest densities, and dimensions.
