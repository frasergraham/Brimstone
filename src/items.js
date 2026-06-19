// ITEMS registry — single source of truth for all items.
//
// Phase 1 populates weapon entries only; WEAPON_STATS and WEAPON_LABEL in
// src/tiles.js derive from this registry. Phase 3 extends entries with
// combatTriggers (so staff-vs-undead moves out of Entity.resolveCombat)
// and folds in consumables (silver, food, herbs, scripture) and the horse
// mount. See docs/design/units-items-abilities-refactor.md.
//
// `category` — 'melee' | 'ranged'. Factions gate equipping per-category
// via Faction.canEquipWeaponItem (e.g. the rogue refuses melee weapons).
//
// `range` — the attack-target distance the weapon grants its wielder, in
// hexes. Omitted (melee weapons / unarmed) ⇒ range 1. A unit has NO innate
// range any more — Entity.getRange() reads it from the equipped weapon, so
// a bow turns any wielder into an archer (range 3) and an unarmed unit is
// melee. `projectileType` names the replay animation for ranged shots.
//
// `wielderFactions` — if present, only those faction ids may equip the
// weapon (e.g. Magic Bolt is witch/necromancer-only). `noLoot` marks
// weapons that are issued as starting gear and never appear in loot tables.
//
// `damage` — per-hit damage spec, either a fixed number or a dice roll
// `{ count, sides, flat }` (see normalizeDamage/rollDamage in entities.js).
// A landed hit deals tier × this roll (hit 1×, crush 2×, great crush 3×).
// Means are anchored near DAMAGE_SCALE (≈7) so weapons differ in feel/variance
// without shifting the balance baseline; ranged weapons can't crush, so a
// couple sit slightly higher to compensate. Unarmed has no entry and falls
// back to DEFAULT_ATTACK_DAMAGE (2D6) — see getWeaponDamage below.

import { DEFAULT_ATTACK_DAMAGE } from './balance.js';

export const ITEMS = Object.freeze({
  sword: {
    id: 'sword',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 2, defense: 0 },
    damage: { count: 2, sides: 6 },          // 2D6 (avg 7) — the workhorse blade
    label: '⚔ Sword (+2 ATK)',
  },
  axe: {
    id: 'axe',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 1, defense: 1 },
    damage: { count: 1, sides: 12, flat: 1 }, // 1D12+1 (avg 7.5) — swingy
    label: '🪓 Axe (+1 ATK, +1 DEF)',
  },
  bow: {
    id: 'bow',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 0, defense: 0 },
    damage: { count: 2, sides: 4 },          // 2D4 (avg 5) — ranged, no crush
    range: 3,
    projectileType: 'bolt',
    label: '🏹 Bow (range 3)',
  },
  crossbow: {
    id: 'crossbow',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 1, defense: 0 },
    damage: { count: 1, sides: 10 },         // 1D10 (avg 5.5)
    range: 2,
    projectileType: 'bolt',
    label: '🏹 Crossbow (+1 ATK, range 2)',
  },
  musket: {
    id: 'musket',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 2, defense: 0 },
    damage: { count: 2, sides: 8 },          // 2D8 (avg 9) — premium, no crush
    range: 2,
    projectileType: 'bolt',
    label: '🔫 Musket (+2 ATK, range 2)',
  },
  pistol: {
    id: 'pistol',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 1, defense: 0 },
    damage: { count: 1, sides: 10 },         // 1D10 (avg 5.5)
    range: 2,
    projectileType: 'bolt',
    label: '🔫 Flintlock (+1 ATK, range 2)',
  },
  sling: {
    id: 'sling',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 0, defense: 0 },
    damage: { count: 2, sides: 4 },          // 2D4 (avg 5)
    range: 2,
    projectileType: 'bolt',
    label: '🪨 Sling (range 2)',
  },
  shield: {
    id: 'shield',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 0, defense: 2 },
    damage: { count: 2, sides: 6 },          // 2D6 (avg 7) — defensive, normal dmg
    label: '🛡 Shield (+2 DEF)',
  },
  staff: {
    id: 'staff',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 1, defense: 0 },
    damage: { count: 2, sides: 6 },          // 2D6 (avg 7) — edge is the undead advantage
    label: '🪄 Staff (+1 ATK, advantage vs undead)',
    // Grants +1 attack advantage die vs undead defenders only (zombies).
    // Pre-refactor this also fired against minions and golems, but that
    // effectively made the staff a flat +adv vs every witch unit — not
    // the "specialist anti-undead weapon" its label suggests. Narrowed
    // to match the label.
    combatTriggers: [
      { when: 'attack', ifDefenderHasAnyTag: ['undead'], advantage: 1 },
    ],
  },
  dagger: {
    id: 'dagger',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 1, defense: 0 },
    damage: { count: 1, sides: 10 },         // 1D10 (avg 5.5) — fast, light
    label: '🗡 Dagger (+1 ATK)',
  },
  // ── Premium tier ──────────────────────────────────────────────────────────
  // Rarer, stronger weapons that only appear later in a game (gated by round
  // via LOOT_TIER_GATE in src/loot.config.js, enforced in _effectiveLoot).
  // Means sit ~10–11 vs the ~7 baseline. Melee premiums are hero-side by the
  // usual faction gate (witch only equips wielderFactions; rogue only ranged).
  greatsword: {
    id: 'greatsword',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 3, defense: 0 },
    damage: { count: 3, sides: 6 },          // 3D6 (avg 10.5) — heavy two-hander
    label: '⚔ Great Sword (+3 ATK)',
  },
  warhammer: {
    id: 'warhammer',
    kind: 'weapon',
    slot: 'weapon',
    category: 'melee',
    statMods: { attack: 2, defense: 1 },
    damage: { count: 1, sides: 12, flat: 4 }, // 1D12+4 (avg 10.5) — swingy, crushes hard
    label: '⚒ War Hammer (+2 ATK, +1 DEF)',
  },
  longrifle: {
    id: 'longrifle',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    statMods: { attack: 3, defense: 0 },
    damage: { count: 2, sides: 8, flat: 2 },  // 2D8+2 (avg 11) — premium marksman
    range: 3,
    projectileType: 'bolt',
    label: '🔫 Long Rifle (+3 ATK, range 3)',
  },
  // Witch / Necromancer innate ranged attack. Issued as starting gear via
  // Faction.innateLeaderWeapon; never looted (noLoot) and equippable only
  // by its wielderFactions.
  magic_bolt: {
    id: 'magic_bolt',
    kind: 'weapon',
    slot: 'weapon',
    category: 'ranged',
    // +1 ATK mirrors the Paladin's starting sword edge so the night side
    // keeps pace (witch effective ATK 3 vs paladin 4 — the same +1 gap as
    // the pre-overhaul baseline). Tuned via the balance sims.
    statMods: { attack: 1, defense: 0 },
    damage: { count: 2, sides: 6 },          // 2D6 (avg 7)
    range: 2,
    projectileType: 'sparkle',
    wielderFactions: ['witch', 'necromancer'],
    noLoot: true,
    label: '✨ Magic Bolt (+1 ATK, range 2)',
  },

  // ── Key items ────────────────────────────────────────────────────────────
  // `kind: 'key'` items are persistent enablers, not weapons or consumables:
  // holding one unlocks an action and using it never decrements the count.
  // They live in a unit's personal `items` pack (NOT the shared faction
  // inventory) and round-trip through normalizeItems / state-sync like any
  // other entry. The Horn enables the Sound Horn action — see executeSoundHorn
  // and the getValidActions gate in src/actions.js.
  horn: {
    id: 'horn',
    kind: 'key',
    label: '📯 Horn',
    noLoot: true,        // never rolls on a random loot table; placed by hand
  },
});

export function getItem(id) {
  return ITEMS[id];
}

// Discovered loot that isn't a registered ITEM (horse mount + raw resources)
// still wants a readable, stat-bearing label in the action card / round summary.
const NON_ITEM_LOOT_LABELS = Object.freeze({
  horse:     '🐴 Horse (+1 move)',
  herbs:     '🌿 Herbs',
  wood:      '🪵 Wood',
  metal:     '⚙ Metal',
  food:      '🍞 Food',
  silver:    '🥈 Silver',
  scripture: '📜 Scripture',
});

/**
 * Human-readable label for a discovered loot id, including its emoji and any
 * stat summary. Weapons/key items reuse their authored `label` (already in the
 * "⚔ Sword (+2 ATK)" form); horse + resources use a small fallback table.
 * Falls back to the raw id so an unknown loot id never renders blank.
 */
export function lootDisplayLabel(id) {
  return ITEMS[id]?.label ?? NON_ITEM_LOOT_LABELS[id] ?? String(id ?? '');
}

/**
 * The per-hit damage spec for an equipped weapon id. Unarmed units (null /
 * unknown weapon) fall back to DEFAULT_ATTACK_DAMAGE (2D6). Pair with
 * rollDamage(spec, s => state.nextDie(s)) in src/entities.js to roll a hit.
 */
export function getWeaponDamage(weaponId) {
  return ITEMS[weaponId]?.damage ?? DEFAULT_ATTACK_DAMAGE;
}
