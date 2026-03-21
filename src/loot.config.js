// ============================================================
//  LOOT CONFIGURATION — edit this file to tune drop rates.
//
//  Weights are relative integers (don't need to sum to 100).
//  Valid type strings:
//    Resources : 'wood' | 'metal' | 'herbs' | 'food' | 'silver' | 'scripture'
//    Weapons   : 'weapon:sword' | 'weapon:axe' | 'weapon:shield' |
//                'weapon:bow'   | 'weapon:staff' | 'weapon:dagger'
//    Special   : 'horse'     — found only in the Stable
//                'survivor'  — recruits a survivor to the party
//                'nothing'   — empty result
//
//  qty (optional, default 1): how many of that resource are found in one roll.
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
      { type: 'weapon:sword',  weight: 25 },
      { type: 'weapon:axe',    weight: 25 },
      { type: 'weapon:shield', weight: 20 },
      { type: 'metal',         weight: 20, qty: 2 },
      { type: 'wood',          weight: 8,  qty: 2 },
      { type: 'nothing',       weight:  2 },
    ],

    inn: [
      { type: 'food',          weight: 30, qty: 2 },
      { type: 'herbs',         weight: 25, qty: 2 },
      { type: 'survivor',      weight: 35 },
      { type: 'nothing',       weight:  2 },
      { type: 'food',          weight:  8, qty: 3 },
    ],

    church: [
      { type: 'scripture',     weight: 35, qty: 2 },
      { type: 'silver',        weight: 32, qty: 2 },
      { type: 'weapon:staff',  weight: 30 },
      { type: 'nothing',       weight:  3 },
    ],

    mill: [
      { type: 'wood',          weight: 45, qty: 3 },
      { type: 'food',          weight: 30, qty: 2 },
      { type: 'survivor',      weight: 22 },
      { type: 'nothing',       weight:  3 },
    ],

    barn: [
      { type: 'food',          weight: 40, qty: 3 },
      { type: 'wood',          weight: 25, qty: 2 },
      { type: 'survivor',      weight: 32 },
      { type: 'nothing',       weight:  3 },
    ],

    apothecary: [
      { type: 'herbs',         weight: 50, qty: 3 },
      { type: 'food',          weight: 25, qty: 2 },
      { type: 'silver',        weight: 22, qty: 2 },
      { type: 'nothing',       weight:  3 },
    ],

    watchtower: [
      { type: 'weapon:bow',    weight: 40 },
      { type: 'silver',        weight: 35, qty: 2 },
      { type: 'survivor',      weight: 22 },
      { type: 'nothing',       weight:  3 },
    ],

    storehouse: [
      { type: 'wood',          weight: 32, qty: 3 },
      { type: 'metal',         weight: 30, qty: 3 },
      { type: 'food',          weight: 25, qty: 2 },
      { type: 'nothing',       weight:  3 },
      { type: 'metal',         weight: 10, qty: 2 },
    ],

    // Primary find is a horse that doubles movement range
    stable: [
      { type: 'horse',         weight: 60 },
      { type: 'food',          weight: 22, qty: 2 },
      { type: 'wood',          weight: 15, qty: 2 },
      { type: 'nothing',       weight:  3 },
    ],

    dock: [
      { type: 'wood',          weight: 35, qty: 3 },
      { type: 'food',          weight: 32, qty: 2 },
      { type: 'survivor',      weight: 30 },
      { type: 'nothing',       weight:  3 },
    ],

    house: [
      { type: 'food',          weight: 28, qty: 2 },
      { type: 'herbs',         weight: 25, qty: 2 },
      { type: 'weapon:dagger', weight: 20 },
      { type: 'wood',          weight: 15, qty: 2 },
      { type: 'survivor',      weight: 10 },
      { type: 'nothing',       weight:  2 },
    ],

    graveyard: [
      { type: 'scripture',     weight: 45, qty: 2 },
      { type: 'herbs',         weight: 30, qty: 2 },
      { type: 'silver',        weight: 22, qty: 2 },
      { type: 'nothing',       weight:  3 },
    ],

    town_hall: [
      { type: 'silver',        weight: 22, qty: 2 },
      { type: 'wood',          weight: 25, qty: 2 },
      { type: 'food',          weight: 25, qty: 2 },
      { type: 'survivor',      weight: 25 },
      { type: 'nothing',       weight:  3 },
    ],

  },

  // ----------------------------------------------------------
  //  TERRAIN  (applies to any unexplored non-building tile)
  //  Survivors are rare here — they mostly hide in buildings.
  // ----------------------------------------------------------
  terrain: {

    grass: [
      { type: 'wood',          weight: 28, qty: 2 },
      { type: 'food',          weight: 25, qty: 2 },
      { type: 'herbs',         weight: 22, qty: 2 },
      { type: 'metal',         weight: 12, qty: 2 },
      { type: 'silver',        weight: 8,  qty: 2 },
      { type: 'survivor',      weight: 3 },
      { type: 'nothing',       weight: 2 },
    ],

    forest: [
      { type: 'wood',          weight: 45, qty: 3 },
      { type: 'herbs',         weight: 28, qty: 2 },
      { type: 'food',          weight: 12, qty: 2 },
      { type: 'silver',        weight: 8,  qty: 2 },
      { type: 'survivor',      weight: 5 },
      { type: 'nothing',       weight: 2 },
    ],

    road: [
      { type: 'food',          weight: 28, qty: 2 },
      { type: 'silver',        weight: 26, qty: 2 },
      { type: 'herbs',         weight: 18, qty: 2 },
      { type: 'wood',          weight: 12, qty: 2 },
      { type: 'survivor',      weight: 12 },
      { type: 'nothing',       weight: 2 },
      { type: 'metal',         weight: 2,  qty: 2 },
    ],

  },

};
