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

// ── Experience & veterancy (campaign-only) ────────────────────────────────────
// XP is awarded only in campaign missions (gated on state.isCampaign). Earning
// enough XP raises a unit's `level`, which scales its intrinsic HP/ATK/DEF via
// the curves above. These award values are deliberately clean round numbers —
// Phase C tunes them in the headless balance pass.
export const XP_PER_EXPLORE            = 5;
export const XP_PER_FORTIFY_BASE       = 10; // flat XP for a fortify action…
export const XP_PER_FORTIFY_LEVEL_BONUS = 5; // …plus this × the tile's fortifyLevel
export const XP_PER_HIT                = 15; // landed a 1-damage hit
export const XP_PER_CRUSH              = 25; // landed a 2-damage crush
export const XP_PER_KILL               = 50; // dealt the killing blow
export const XP_PER_DEFEND             = 5;  // survived an attack while defending
export const XP_PER_COUNTER            = 15; // dealt counter damage to an attacker
// Fraction of an actor's combat XP also granted to each gang-up ally.
export const ALLY_XP_SHARE             = 0.25;

// Total cumulative XP required to REACH level L, counting from level 1.
//   xpForLevel(1) = 0, then (L-1)·(200 + 100·(L-2)) for L ≥ 2
//   → totals  0, 200, 600, 1200, 2000 …  (per-level cost 200, 400, 600, 800 …)
export function xpForLevel(L) {
  const lvl = Math.max(1, Math.floor(L) || 1);
  if (lvl <= 1) return 0;
  return (lvl - 1) * (200 + 100 * (lvl - 2));
}

// Inverse of xpForLevel: the highest level whose cumulative threshold is met by
// `xp`. Floors at level 1, caps at 99.
export function levelForXp(xp) {
  const x = Math.max(0, Math.floor(xp) || 0);
  let lvl = 1;
  while (lvl < 99 && xpForLevel(lvl + 1) <= x) lvl++;
  return lvl;
}
