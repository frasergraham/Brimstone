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
      { type: 'weapon:sword',  weight: 22 },
      { type: 'weapon:axe',    weight: 22 },
      { type: 'weapon:shield', weight: 18 },
      { type: 'metal',         weight: 23 },
      { type: 'wood',          weight: 10 },
      { type: 'nothing',       weight:  5 },
    ],

    inn: [
      { type: 'food',          weight: 45 },
      { type: 'herbs',         weight: 12 },
      { type: 'survivor',      weight: 38 },
      { type: 'nothing',       weight:  5 },
    ],

    church: [
      { type: 'scripture',     weight: 35 },
      { type: 'silver',        weight: 30 },
      { type: 'weapon:staff',  weight: 30 },
      { type: 'nothing',       weight:  5 },
    ],

    mill: [
      { type: 'wood',          weight: 50 },
      { type: 'food',          weight: 30 },
      { type: 'survivor',      weight: 15 },
      { type: 'nothing',       weight:  5 },
    ],

    barn: [
      { type: 'food',          weight: 45 },
      { type: 'wood',          weight: 25 },
      { type: 'survivor',      weight: 25 },
      { type: 'nothing',       weight:  5 },
    ],

    apothecary: [
      { type: 'herbs',         weight: 35 },
      { type: 'food',          weight: 25 },
      { type: 'silver',        weight: 20 },
      { type: 'metal',         weight: 15 },
      { type: 'nothing',       weight:  5 },
    ],

    watchtower: [
      { type: 'weapon:bow',    weight: 38 },
      { type: 'silver',        weight: 32 },
      { type: 'survivor',      weight: 25 },
      { type: 'nothing',       weight:  5 },
    ],

    storehouse: [
      { type: 'wood',          weight: 37 },
      { type: 'metal',         weight: 33 },
      { type: 'food',          weight: 25 },
      { type: 'nothing',       weight:  5 },
    ],

    // Primary find is a horse that doubles movement range
    stable: [
      { type: 'horse',         weight: 55 },
      { type: 'food',          weight: 25 },
      { type: 'wood',          weight: 15 },
      { type: 'nothing',       weight:  5 },
    ],

    dock: [
      { type: 'wood',          weight: 35 },
      { type: 'food',          weight: 35 },
      { type: 'survivor',      weight: 25 },
      { type: 'nothing',       weight:  5 },
    ],

    house: [
      { type: 'food',          weight: 28 },
      { type: 'wood',          weight: 25 },
      { type: 'weapon:dagger', weight: 20 },
      { type: 'metal',         weight: 12 },
      { type: 'herbs',         weight:  8 },
      { type: 'survivor',      weight:  5 },
      { type: 'nothing',       weight:  2 },
    ],

    graveyard: [
      { type: 'scripture',     weight: 45 },
      { type: 'silver',        weight: 30 },
      { type: 'metal',         weight: 15 },
      { type: 'herbs',         weight:  5 },
      { type: 'nothing',       weight:  5 },
    ],

    town_hall: [
      { type: 'silver',        weight: 22 },
      { type: 'wood',          weight: 27 },
      { type: 'food',          weight: 27 },
      { type: 'survivor',      weight: 19 },
      { type: 'nothing',       weight:  5 },
    ],

  },

  // ----------------------------------------------------------
  //  TERRAIN  (applies to any unexplored non-building tile)
  //  Survivors are rare here — they mostly hide in buildings.
  // ----------------------------------------------------------
  terrain: {

    grass: [
      { type: 'wood',          weight: 35 },
      { type: 'food',          weight: 28 },
      { type: 'metal',         weight: 20 },
      { type: 'herbs',         weight:  8 },
      { type: 'silver',        weight:  5 },
      { type: 'survivor',      weight:  2 },
      { type: 'nothing',       weight:  2 },
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
      { type: 'food',          weight: 32 },
      { type: 'silver',        weight: 28 },
      { type: 'metal',         weight: 18 },
      { type: 'wood',          weight: 12 },
      { type: 'herbs',         weight:  5 },
      { type: 'survivor',      weight:  3 },
      { type: 'nothing',       weight:  2 },
    ],

  },

};
