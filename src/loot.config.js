// ============================================================
//  LOOT CONFIGURATION — edit this file to tune drop rates.
//
//  Weights are relative integers (don't need to sum to 100).
//  Valid type strings:
//    Resources : 'wood' | 'metal' | 'herbs' | 'food' | 'silver' | 'scripture'
//    Weapons   : 'sword' | 'axe' | 'shield' | 'bow' | 'crossbow'
//                | 'musket' | 'pistol' | 'sling' | 'staff' | 'dagger'
//                (weapon-vs-resource is determined via ITEMS[id].kind,
//                 not a 'weapon:' prefix — see src/items.js)
//                'magic_bolt' is the Witch/Necromancer's innate weapon —
//                issued as starting gear (noLoot) and never rolled here.
//    Special   : 'nothing'   — empty result
//
//  NOTE: 'horse' is intentionally NOT rolled as procedural loot — horses are
//  disabled as a drop until per-unit-skeleton animation support ships. The
//  HORSE concept (movement range 2, riding pose, equip handling) still works
//  for existing horses in older saves / authored missions; we just no longer
//  roll new ones into any weighted table below.
//
//  Survivors are NOT found via loot — they are pre-placed on the map
//  and encountered by stepping onto their tile.
//
//  Buildings (explored once, then exhausted):
//    Each key matches BuildingType values from tiles.js.
//
//  Terrain (rolled whenever an actor explores a non-building tile):
//    Keys are TileType values: 'grass' | 'forest' | 'road'
// ============================================================

export const LOOT_CONFIG = {

  // ----------------------------------------------------------
  //  BUILDINGS
  // ----------------------------------------------------------
  buildings: {

    blacksmith: [
      { type: 'sword',      weight: 18 },
      { type: 'axe',        weight: 18 },
      { type: 'shield',     weight: 14 },
      { type: 'crossbow',   weight:  8 },  // ranged — usable by Rogue
      { type: 'musket',     weight:  6 },  // ranged, +2 ATK — the prize drop
      { type: 'greatsword', weight:  3 },  // premium — gated to late game (LOOT_TIER_GATE)
      { type: 'warhammer',  weight:  2 },  // premium — gated to late game
      { type: 'metal',      weight: 26 },
      { type: 'wood',       weight: 10 },
    ],

    inn: [
      { type: 'food',          weight: 40 },
      { type: 'herbs',         weight: 19 },
      { type: 'silver',        weight: 13 },
      { type: 'nothing',       weight:  6 },
    ],

    church: [
      { type: 'scripture',     weight: 35 },
      { type: 'silver',        weight: 30 },
      { type: 'staff',  weight: 30 },
      { type: 'nothing',       weight:  5 },
    ],

    mill: [
      { type: 'wood',          weight: 55 },
      { type: 'food',          weight: 35 },
      { type: 'nothing',       weight: 10 },
    ],

    barn: [
      { type: 'food',          weight: 48 },
      { type: 'wood',          weight: 34 },
      { type: 'nothing',       weight:  6 },
    ],

    apothecary: [
      { type: 'herbs',         weight: 35 },
      { type: 'food',          weight: 25 },
      { type: 'silver',        weight: 20 },
      { type: 'metal',         weight: 15 },
      { type: 'nothing',       weight:  5 },
    ],

    watchtower: [
      { type: 'bow',      weight: 30 },
      { type: 'crossbow', weight: 12 },
      { type: 'musket',   weight:  8 },
      { type: 'longrifle', weight: 3 },  // premium ranged — gated to late game (LOOT_TIER_GATE)
      { type: 'silver',   weight: 35 },
      { type: 'nothing',  weight: 15 },
    ],

    storehouse: [
      { type: 'wood',          weight: 37 },
      { type: 'metal',         weight: 33 },
      { type: 'food',          weight: 25 },
      { type: 'nothing',       weight:  5 },
    ],

    // Formerly the best source of horses; horse drops are disabled, so the
    // stable now yields feed/supplies only until horses are re-enabled.
    stable: [
      { type: 'food',          weight: 20 },
      { type: 'wood',          weight: 11 },
      { type: 'nothing',       weight:  4 },
    ],

    dock: [
      { type: 'wood',          weight: 45 },
      { type: 'food',          weight: 45 },
      { type: 'nothing',       weight: 10 },
    ],

    house: [
      { type: 'food',          weight: 25 },
      { type: 'wood',          weight: 22 },
      { type: 'dagger',        weight: 15 },
      { type: 'pistol',        weight: 10 },  // ranged sidearm
      { type: 'sling',         weight:  8 },  // cheap ranged
      { type: 'metal',         weight: 12 },
      { type: 'herbs',         weight:  8 },
    ],

    graveyard: [
      { type: 'scripture',     weight: 45 },
      { type: 'silver',        weight: 30 },
      { type: 'metal',         weight: 15 },
      { type: 'herbs',         weight:  5 },
      { type: 'nothing',       weight:  5 },
    ],

    town_hall: [
      { type: 'silver',        weight: 26 },
      { type: 'pistol',        weight: 10 },  // a magistrate's flintlock
      { type: 'wood',          weight: 32 },
      { type: 'food',          weight: 32 },
      { type: 'nothing',       weight:  5 },
    ],

  },

  // ----------------------------------------------------------
  //  TERRAIN  (applies to any unexplored non-building tile)
  // ----------------------------------------------------------
  terrain: {

    grass: [
      { type: 'wood',          weight: 38 },
      { type: 'food',          weight: 30 },
      { type: 'metal',         weight: 22 },
      { type: 'herbs',         weight:  8 },
      { type: 'silver',        weight:  2 },
    ],

    forest: [
      { type: 'wood',          weight: 62 },
      { type: 'food',          weight: 15 },
      { type: 'metal',         weight: 10 },
      { type: 'herbs',         weight:  8 },
      { type: 'silver',        weight:  3 },
      { type: 'nothing',       weight:  2 },
    ],

    road: [
      { type: 'food',          weight: 34 },
      { type: 'silver',        weight: 28 },
      { type: 'metal',         weight: 20 },
      { type: 'wood',          weight: 11 },
      { type: 'herbs',         weight:  3 },
    ],

  },

};

// Premium-weapon progression gate: weaponId → earliest ROUND it may drop.
// Enforced in _effectiveLoot() (src/actions.js), which filters gated entries out
// of the weighted table when state.round is below the threshold — so these
// weapons simply can't roll early. Tunable. Mission lootOverrides still compose
// (a boss mission can override a table to force-include a premium sooner).
export const LOOT_TIER_GATE = Object.freeze({
  greatsword: 8,
  longrifle:  9,
  warhammer: 10,
});
