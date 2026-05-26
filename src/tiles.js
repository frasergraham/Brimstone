// Tile types, building types, resources, weapons, and their visual properties
import { LOOT_CONFIG } from './loot.config.js';

export const TileType = Object.freeze({
  GRASS:    'grass',
  FOREST:   'forest',
  DIRT:     'dirt',     // bare earth / gravel patches
  ROAD:     'road',
  RIVER:    'river',
  BRIDGE:   'bridge',   // road crossing over a river
  BUILDING: 'building',
});

export const BuildingType = Object.freeze({
  TOWN_HALL:   'town_hall',
  CHURCH:      'church',
  INN:         'inn',
  BLACKSMITH:  'blacksmith',
  GRAVEYARD:   'graveyard',
  MILL:        'mill',
  DOCK:        'dock',
  HOUSE:       'house',
  BARN:        'barn',
  WATCHTOWER:  'watchtower',
  APOTHECARY:  'apothecary',
  STOREHOUSE:  'storehouse',
  STABLE:      'stable',
});

export const ResourceType = Object.freeze({
  HERBS:     'herbs',     // Heal 2 HP (costs 1 action)
  SILVER:    'silver',    // Hero: +1 attack for next battle
  WOOD:      'wood',      // Fortify a building (+1 def) or raise Wood Golem
  METAL:     'metal',     // Reinforce a building (+2 def) or raise Iron Golem
  FOOD:      'food',      // Gain 1 extra action this turn
  SCRIPTURE: 'scripture', // Ward off a witch unit (push back 1 hex)
});

export const WeaponType = Object.freeze({
  SWORD:    'sword',     // +2 attack
  AXE:      'axe',       // +1 attack, +1 defense
  BOW:      'bow',       // +1 attack (ranged category)
  CROSSBOW: 'crossbow',  // +1 attack (ranged category)
  SHIELD:   'shield',    // +2 defense
  STAFF:    'staff',     // +1 attack, +1 advantage die vs undead
  DAGGER:   'dagger',    // +1 attack
});

// WEAPON_STATS and WEAPON_LABEL derive from the ITEMS registry
// (src/items.js), which is the single source of truth for all items.
// New code should read ITEMS[id] directly; these exports remain for
// existing call sites during the phased units/items/abilities refactor.
import { ITEMS as _ITEMS } from './items.js';

export const WEAPON_STATS = Object.freeze(
  Object.fromEntries(
    Object.values(_ITEMS)
      .filter(i => i.kind === 'weapon')
      .map(i => [i.id, {
        attackBonus:  i.statMods?.attack  ?? 0,
        defenseBonus: i.statMods?.defense ?? 0,
      }])
  )
);

export const WEAPON_LABEL = Object.freeze(
  Object.fromEntries(
    Object.values(_ITEMS)
      .filter(i => i.kind === 'weapon')
      .map(i => [i.id, i.label])
  )
);

// Passability: can entities move through this tile type?
export const TILE_PASSABLE = {
  [TileType.GRASS]:    true,
  [TileType.FOREST]:   true,
  [TileType.DIRT]:     true,
  [TileType.ROAD]:     true,
  [TileType.RIVER]:    false,
  [TileType.BRIDGE]:   true,   // passable crossing
  [TileType.BUILDING]: true,
};

// Visual colors (used by renderer)
export const TILE_COLOR = {
  [TileType.GRASS]:    '#3a5430',
  [TileType.FOREST]:   '#1b2e1a',
  [TileType.DIRT]:     '#7a6a48',   // bare earth / gravel
  [TileType.ROAD]:     '#6b5a3e',   // road strip color (base hex drawn as grass)
  [TileType.RIVER]:    '#1a3d5c',   // water ribbon color (base hex drawn as grass)
  [TileType.BRIDGE]:   '#1a3d5c',   // water base; road deck drawn on top
  [TileType.BUILDING]: '#4a3c2c',
};

// Per-building colours — distinct but cohesive with the dark medieval palette
export const BUILDING_COLOR = {
  [BuildingType.TOWN_HALL]:  '#8a7a5a', // dressed limestone
  [BuildingType.CHURCH]:     '#9aacaa', // pale cold stone
  [BuildingType.INN]:        '#a07050', // warm timber
  [BuildingType.BLACKSMITH]: '#7a5540', // sooty iron-brown
  [BuildingType.GRAVEYARD]:  '#4a5c4a', // dark mossy stone
  [BuildingType.MILL]:       '#c4a44a', // golden straw/wheat
  [BuildingType.DOCK]:       '#3a7080', // sea-grey blue
  [BuildingType.HOUSE]:      '#9a7060', // terracotta plaster
  [BuildingType.BARN]:       '#8a6030', // weathered timber
  [BuildingType.WATCHTOWER]: '#707060', // dark ashlar stone
  [BuildingType.APOTHECARY]: '#7a6080', // herb-jar purple-grey
  [BuildingType.STOREHOUSE]: '#907860', // dusty tan
  [BuildingType.STABLE]:     '#7a5c38', // saddle brown
};

// Icons shown on every building tile, always visible
export const BUILDING_ICON = {
  [BuildingType.TOWN_HALL]:  '🏛',
  [BuildingType.CHURCH]:     '⛪',
  [BuildingType.INN]:        '🏨',
  [BuildingType.BLACKSMITH]: '⚒',
  [BuildingType.GRAVEYARD]:  '🪦',
  [BuildingType.MILL]:       '⚙',
  [BuildingType.DOCK]:       '⚓',
  [BuildingType.HOUSE]:      '🏠',
  [BuildingType.BARN]:       '🌾',
  [BuildingType.WATCHTOWER]: '🗼',
  [BuildingType.APOTHECARY]: '⚗',
  [BuildingType.STOREHOUSE]: '📦',
  [BuildingType.STABLE]:     '🐎',
};

export const BUILDING_LABEL = {
  [BuildingType.TOWN_HALL]:  'Town Hall',
  [BuildingType.CHURCH]:     'Church',
  [BuildingType.INN]:        'Inn',
  [BuildingType.BLACKSMITH]: 'Smithy',
  [BuildingType.GRAVEYARD]:  'Graveyard',
  [BuildingType.MILL]:       'Mill',
  [BuildingType.DOCK]:       'Dock',
  [BuildingType.HOUSE]:      'House',
  [BuildingType.BARN]:       'Barn',
  [BuildingType.WATCHTOWER]: 'Watchtower',
  [BuildingType.APOTHECARY]: 'Apothecary',
  [BuildingType.STOREHOUSE]: 'Storehouse',
  [BuildingType.STABLE]:     'Stable',
};

export const RESOURCE_LABEL = {
  [ResourceType.HERBS]:     '🌿 Herbs',
  [ResourceType.SILVER]:    '⚔ Silver',
  [ResourceType.WOOD]:      '🪵 Wood',
  [ResourceType.METAL]:     '⚙ Metal',
  [ResourceType.FOOD]:      '🍞 Food',
  [ResourceType.SCRIPTURE]: '📜 Scripture',
  'horse':                  '🐴 Horse',
};

// Loot tables — sourced from loot.config.js (edit that file to tune rates).
// BUILDING_LOOT is keyed by BuildingType string (e.g. 'inn', 'blacksmith').
// TERRAIN_LOOT  is keyed by TileType  string (e.g. 'grass', 'forest', 'road').
export const BUILDING_LOOT = LOOT_CONFIG.buildings;
export const TERRAIN_LOOT  = LOOT_CONFIG.terrain;

// Roll a loot result from a weighted table using Math.random
export function rollLoot(table) {
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const entry of table) {
    r -= entry.weight;
    if (r <= 0) return entry.type;
  }
  return table[table.length - 1].type;
}

// ─────────────────────────────────────────────────────────────────────────
// Layered tile model (P0 of the tile-model refactor)
//
// A tile is split into THREE independent layers so that a road/river/building
// can sit on ANY base material (e.g. a road through forest):
//
//   base      ∈ {grass, forest, dirt}            — the terrain material
//   structure ∈ {none(null), 'building'}         — is there a building or not
//   path      ∈ {none(null), road, river, bridge}— overlaid path/water feature
//
// `building` (BuildingType) and `roadDirs` (Set of connected neighbours) stay
// as their own fields. The codebase reads/writes the explicit layers directly
// via the predicates below (baseOf / pathOf / structureOf / isRiver / isBridge /
// hasBuilding / …). The legacy single `tile.type` (TileType) is no longer a
// property of the Tile — the P0 get/set shim was removed in P7 once every reader
// had migrated. The two explicit helpers `decomposeTileType()` (write a legacy
// type → layers) and `legacyTileType()` (derive the legacy type ← layers) cover
// the remaining spots that genuinely need a single categorical value (legacy
// save/JSON reconstruction, display maps keyed by TileType).
//
// REPRESENTATION CHOICE: `structure` is a coarse marker — either null (none) or
// the string 'building'. The actual BuildingType lives in `building`, exactly
// as before. `structureOf()` treats a tile as having a building when EITHER
// `structure === 'building'` OR `building != null`, so existing code that sets
// `tile.building = X` directly (without touching `structure`) still reports a
// building. This keeps the layer accessors robust to both the new explicit
// writes and legacy direct-field writes.
// ─────────────────────────────────────────────────────────────────────────

// Path-layer values (in addition to null = none).
export const PathType = Object.freeze({
  ROAD:   'road',
  RIVER:  'river',
  BRIDGE: 'bridge',
});

// Structure-layer marker (in addition to null = none).
export const StructureType = Object.freeze({
  BUILDING: 'building',
});

export class Tile {
  constructor(col, row, type = TileType.GRASS) {
    this.col = col;
    this.row = row;
    // Explicit layers. Defaults are set before `type` is decomposed below.
    this.base = TileType.GRASS;   // 'grass' | 'forest' | 'dirt'
    this.structure = null;        // null (none) | 'building'
    this.path = null;             // null (none) | 'road' | 'river' | 'bridge'
    this.building = null;         // BuildingType or null
    // Decompose the legacy TileType arg into (base, structure, path). This is
    // the canonical way tiles are constructed (`new Tile(col, row, TileType.X)`)
    // throughout map-gen, missions, and tests — the explicit-layer fields above
    // stay as their authored defaults for the ROAD/RIVER/BRIDGE cases.
    decomposeTileType(this, type);
    this.explored = false;
    this.resource = null;   // ResourceType or null (on open tiles)
    this.fortifyLevel = 0;  // 0=none, 1..6=fortified (see getFortifyCombatBonus)
    this.roadDirs = new Set(); // hexKeys of road-connected neighbours (set at map gen time)
  }
}

// Decompose a legacy TileType value into the three explicit layers, in place.
// This is the WRITE-side inverse of `legacyTileType()` and the canonical way to
// import a single-`type` value (the Tile constructor, legacy save/mission JSON
// reconstruction). Replaces the old `set type()` shim — callers set layers
// explicitly via this named helper rather than through a hidden property setter.
export function decomposeTileType(tile, v) {
  switch (v) {
    case TileType.GRASS:
    case TileType.FOREST:
    case TileType.DIRT:
      tile.base = v;
      tile.structure = null;
      tile.path = null;
      break;
    case TileType.ROAD:
      tile.path = PathType.ROAD;     // base unchanged (defaults to grass)
      break;
    case TileType.RIVER:
      tile.path = PathType.RIVER;
      break;
    case TileType.BRIDGE:
      tile.path = PathType.BRIDGE;
      break;
    case TileType.BUILDING:
      // Buildings render on dirt today; default the base to match. Legacy
      // `type` is single-valued, so importing BUILDING must make the tile REPORT
      // building — clear the `path` layer (it sits above building in the
      // precedence). Road-through-building is carried by the separate `roadDirs`
      // Set (untouched here), which is how the renderer has always drawn it —
      // NOT by the `path` layer. So clearing `path` loses no road-through info.
      tile.base = TileType.DIRT;
      tile.structure = StructureType.BUILDING;
      tile.path = null;
      break;
    default:
      // Unknown value: store as base so nothing silently breaks.
      tile.base = v;
      tile.structure = null;
      tile.path = null;
  }
  return tile;
}

// ── Layer accessors ────────────────────────────────────────────────────────
// Tolerant of plain (non-Tile) serialized tile objects: fall back to defaults.

export function baseOf(tile) {
  return tile?.base ?? TileType.GRASS;
}

export function pathOf(tile) {
  return tile?.path ?? null;
}

export function structureOf(tile) {
  if (!tile) return null;
  // Either the explicit marker or a legacy direct `building` write counts.
  if (tile.structure === StructureType.BUILDING || tile.building != null) {
    return StructureType.BUILDING;
  }
  return null;
}

// Derive the single legacy TileType from the three layers — the READ-side
// inverse of `decomposeTileType()`. Replaces the old `get type()` shim for the
// few call sites that genuinely need one categorical value (display maps keyed
// by TileType, the back-compat `type` field in the serialized snapshot / JSON
// export). Precedence matches the old getter exactly: a path (river/bridge/road)
// wins over a building, which wins over the base material. Note PathType values
// are identical to the TileType ROAD/RIVER/BRIDGE values, so the path can be
// returned directly.
export function legacyTileType(tile) {
  const p = pathOf(tile);
  if (p) return p;
  if (hasBuilding(tile)) return TileType.BUILDING;
  return baseOf(tile);
}

// ── Predicate helpers ────────────────────────────────────────────────────────
// Later phases use these instead of comparing `tile.type` directly.

// A river is impassable water (no bridge).
export function isRiver(tile) {
  return pathOf(tile) === PathType.RIVER;
}

// A bridge crosses water and is passable.
export function isBridge(tile) {
  return pathOf(tile) === PathType.BRIDGE;
}

// Is there a building on this tile?
export function hasBuilding(tile) {
  return structureOf(tile) === StructureType.BUILDING;
}

// "Road-like" for movement cost (1 instead of 2): a road, a bridge, or any
// building tile. Mirrors the old inline `type === ROAD || BRIDGE || BUILDING`.
export function isPathRoadLike(tile) {
  const p = pathOf(tile);
  return p === PathType.ROAD || p === PathType.BRIDGE || hasBuilding(tile);
}

// Does this tile provide forest cover (defender +1 DEF vs ranged)?
//
// LOCKED operator decision: cover is granted whenever the BASE material is
// forest, REGARDLESS of any path or structure on top — i.e. a road or building
// over forest STILL gives cover. This differs from today's behaviour (where
// laying a road cleared the forest type); the gameplay change is adopted in a
// later phase (P4). Readers should switch to this predicate now.
export function isForestCover(tile) {
  return baseOf(tile) === TileType.FOREST;
}

// Hard cap on fortification level.
export const MAX_FORTIFY_LEVEL = 6;

// Level at (and above) which a fortification becomes an impassable wall.
// Level 1 is passable; level 2+ is a wall for factions that are blocked by walls
// (see `Faction.isBlockedByWalls()`). Walls below the threshold are just
// combat-bonus terrain and anyone may enter.
export const FORT_IMPASSABLE_THRESHOLD = 2;

// Terrain-only check: is this tile a wall strong enough to block movement?
// Faction-specific gating ("does this faction get blocked by walls?") lives
// on the Faction class — callers typically combine both:
//   isFortWall(tile) && getFaction(actor.owner).isBlockedByWalls()
export function isFortWall(tile) {
  return (tile?.fortifyLevel || 0) >= FORT_IMPASSABLE_THRESHOLD;
}

// Combat bonuses granted by a fortified hex. Hero units fighting from a
// fortified hex receive these bonuses (attacker rolls +attack, defender rolls
// +defense). Witch units never benefit from fortifications.
//
//   Level 1: +0 ATT, +1 DEF
//   Level 2: +0 ATT, +2 DEF
//   Level 3: +1 ATT, +2 DEF
//   Level 4: +2 ATT, +3 DEF
//   Level 5: +3 ATT, +4 DEF
//   Level 6: +4 ATT, +5 DEF
const FORTIFY_BONUS_TABLE = [
  { attack: 0, defense: 0 },
  { attack: 0, defense: 1 },
  { attack: 0, defense: 2 },
  { attack: 1, defense: 2 },
  { attack: 2, defense: 3 },
  { attack: 3, defense: 4 },
  { attack: 4, defense: 5 },
];

export function getFortifyCombatBonus(fortifyLevel) {
  const lvl = Math.max(0, Math.min(MAX_FORTIFY_LEVEL, fortifyLevel | 0));
  return FORTIFY_BONUS_TABLE[lvl];
}
