// ============================================================
//  LOOT CONFIGURATION — edit this file to tune drop rates.
//
//  Weights are relative integers (don't need to sum to 100).
//  Valid type strings:
//    Resources : 'wood' | 'metal' | 'herbs' | 'food' | 'silver' | 'scripture'
//    Weapons   : 'sword' | 'axe' | 'shield' | 'bow' | 'staff' | 'dagger'
//                (weapon-vs-resource is determined via ITEMS[id].kind,
//                 not a 'weapon:' prefix — see src/items.js)
//    Special   : 'horse'     — found in the Stable (most likely), Inn, and some Houses
//                'nothing'   — empty result
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
      { type: 'sword',  weight: 22 },
      { type: 'axe',    weight: 22 },
      { type: 'shield', weight: 18 },
      { type: 'metal',         weight: 28 },
      { type: 'wood',          weight: 10 },
    ],

    inn: [
      { type: 'food',          weight: 40 },
      { type: 'herbs',         weight: 19 },
      { type: 'silver',        weight: 13 },
      { type: 'horse',         weight: 22 },
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
      { type: 'horse',         weight: 12 },
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
      { type: 'bow',    weight: 45 },
      { type: 'silver',        weight: 40 },
      { type: 'nothing',       weight: 15 },
    ],

    storehouse: [
      { type: 'wood',          weight: 37 },
      { type: 'metal',         weight: 33 },
      { type: 'food',          weight: 25 },
      { type: 'nothing',       weight:  5 },
    ],

    // Best chance for a horse (also found at inn, barn, and houses)
    stable: [
      { type: 'horse',         weight: 65 },
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
      { type: 'food',          weight: 27 },
      { type: 'wood',          weight: 24 },
      { type: 'dagger', weight: 17 },
      { type: 'metal',         weight: 13 },
      { type: 'herbs',         weight:  8 },
      { type: 'horse',         weight: 11 },
    ],

    graveyard: [
      { type: 'scripture',     weight: 45 },
      { type: 'silver',        weight: 30 },
      { type: 'metal',         weight: 15 },
      { type: 'herbs',         weight:  5 },
      { type: 'nothing',       weight:  5 },
    ],

    town_hall: [
      { type: 'silver',        weight: 28 },
      { type: 'wood',          weight: 34 },
      { type: 'food',          weight: 33 },
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
      { type: 'horse',         weight:  4 },
    ],

  },

};
