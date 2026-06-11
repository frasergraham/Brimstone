// Central combat-scaling constants. Intentionally import-free so any module
// (entities, items, actions, effects, factions, AI, scripts) can pull it in
// without risking an import cycle.
//
// DAMAGE_SCALE multiplies every HP total and every *flat* HP delta — heals,
// damage-over-time ticks, night attrition, the wounded surcharge — so that
// once weapons deal rolled damage averaging ~DAMAGE_SCALE per hit, the average
// number of hits needed to kill a unit stays the same as the pre-dice
// baseline (a flat 1 damage per hit vs the old un-scaled HP pools).
//
// Anchor: the basic/unarmed attack is 2D6 (mean 7) and HP is ×7. 7 is chosen
// so every legacy integer HP value scales to another integer (14→98, 2→14).
export const DAMAGE_SCALE = 7;

// Unarmed / fallback attack damage. Weapons override this via their own
// `damage` field in src/items.js. Shape matches a normalized damage spec
// (see normalizeDamage/rollDamage in src/entities.js): roll `count` dice of
// `sides` faces and add `flat`.
export const DEFAULT_ATTACK_DAMAGE = Object.freeze({ count: 2, sides: 6, flat: 0 });

// ── Unit levels ──────────────────────────────────────────────────────────────
// A unit's `level` (≥1) scales its INTRINSIC stats — HP, ATK, DEF — but NOT its
// weapon damage (that stays weapon-driven; higher ATK simply lands more/bigger
// crushes, which multiply the rolled weapon damage). Used by campaign authoring
// to ramp difficulty without new unit types (Zombie L1/L2/L3…). "Standard" curve:
//   HP  × (1 + LEVEL_HP_PER·(L−1))   → L1 ×1, L2 ×1.5, L3 ×2.0
//   ATK + (L−1)                      → +1 per level
//   DEF + floor((L−1)/2)             → +1 every two levels
// See applyLevel() in src/entities.js (HP) and getAttack/getDefense (ATK/DEF).
export const LEVEL_HP_PER = 0.5;
// `level` may be undefined/NaN on plain stat mocks or AI sim copies — coerce to 1.
function _lvl(level) { return Math.max(1, Math.floor(level) || 1); }
export function hpForLevel(baseMaxHp, level) {
  return Math.round(baseMaxHp * (1 + LEVEL_HP_PER * (_lvl(level) - 1)));
}
export function atkBonusForLevel(level) { return _lvl(level) - 1; }
export function defBonusForLevel(level) { return Math.floor((_lvl(level) - 1) / 2); }
