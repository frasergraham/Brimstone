// EFFECTS registry — runtime, time-bound augments applied to entities mid-mission.
//
// This module is the dynamic counterpart to ABILITIES (src/abilities.js).
// Permanent passives live on `entity.abilities[]`; transient state (wounded,
// frenzied, stunned, poisoned, …) lives on `entity.effects[]` as records of
// the form `{ id, duration, stacks, source? }`.
//
// Duration semantics:
//   duration > 0           — round counter; decremented at endRound, removed at 0.
//   duration === 'mission' — sticks until the mission ends (cleared on new mission).
//   duration === 'permanent' — never expires; campaign-persisted via campaign.js.
//                              Prefer pushing truly permanent effects onto
//                              entity.abilities[] instead — same composition
//                              path, same UI affordances.
//
// Stat composition runs alongside abilities/items in Entity.getAttack() /
// getDefense() / getRange(). Damage-taken modifiers and combat-side advantage
// modifiers are read directly by Entity.resolveCombat / executeBattle.
//
// New effects: append an entry below. No actions.js / resolver.js / state-sync
// edits are needed unless the effect introduces a brand-new mechanic class.

import { ABILITIES } from './abilities.js';
import { DAMAGE_SCALE } from './balance.js';

// Every effect declares a one-letter `badge` (unique across the registry) —
// rendered as a letter-in-a-circle status pip in the Unit Stats Bar and the
// plan panel's selected-unit detail (see buildEffectsHtml in ui-render.js).
export const EFFECTS = Object.freeze({
  // ── Negative ─────────────────────────────────────────────────────────────
  wounded: {
    id: 'wounded',
    label: 'Wounded',
    icon: '🩸',
    badge: 'W',
    description: 'Takes +1D6 damage from any source this round',
    // A fresh 1D6 per incoming blow (rolled through the game's deterministic
    // die stream) — wounds make follow-up damage spikier rather than a flat
    // guaranteed surcharge, and the window is one round, so the crush
    // follow-up tax has to be cashed in immediately.
    damageMods: { takenDice: 1 },
    defaultDuration: 1,
  },
  poisoned: {
    id: 'poisoned',
    label: 'Poisoned',
    icon: '☠',
    badge: 'P',
    description: '−1 DEF; takes damage at end of round',
    statMods: { defense: -1 },
    onRoundEnd: 'damageOne',
    defaultDuration: 3,
  },
  bleeding: {
    id: 'bleeding',
    label: 'Bleeding',
    icon: '💧',
    badge: 'B',
    description: 'Takes damage at end of round',
    onRoundEnd: 'damageOne',
    defaultDuration: 2,
  },
  stunned: {
    id: 'stunned',
    label: 'Stunned',
    icon: '💫',
    badge: 'Z',
    description: 'Cannot act this round',
    blocksActions: true,
    defaultDuration: 1,
  },
  slowed: {
    id: 'slowed',
    label: 'Slowed',
    icon: '🐌',
    badge: 'S',
    description: '−1 agility (resolves later in the lockstep order)',
    statMods: { agility: -1 },
    defaultDuration: 1,
  },
  marked: {
    id: 'marked',
    label: 'Marked',
    icon: '🎯',
    badge: 'M',
    description: 'Attackers gain +1 advantage die against this target',
    combatMods: { incomingAtkAdvantage: 1 },
    defaultDuration: 2,
  },
  cursed: {
    id: 'cursed',
    label: 'Cursed',
    icon: '🕯',
    badge: 'C',
    description: 'Cannot heal or be healed',
    blocksHeal: true,
    defaultDuration: 'mission',
  },

  // ── Positive ─────────────────────────────────────────────────────────────
  frenzied: {
    id: 'frenzied',
    label: 'Frenzied',
    icon: '🔥',
    badge: 'F',
    description: '+1 ATK, −1 DEF',
    statMods: { attack: 1, defense: -1 },
    defaultDuration: 1,
  },
  inspired: {
    id: 'inspired',
    label: 'Inspired',
    icon: '✨',
    badge: 'I',
    description: '+1 ATK',
    statMods: { attack: 1 },
    defaultDuration: 1,
  },
  fortified: {
    id: 'fortified',
    label: 'Fortified',
    icon: '🛡',
    badge: 'D',
    description: '+1 DEF',
    statMods: { defense: 1 },
    defaultDuration: 2,
  },
  eagle_eyed: {
    id: 'eagle_eyed',
    label: 'Eagle-Eyed',
    icon: '👁',
    badge: 'E',
    description: '+1 attack range',
    rangeMod: 1,
    defaultDuration: 'mission',
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Look up an effect definition by id (or undefined). */
export function getEffect(id) {
  return EFFECTS[id];
}

/** True iff the entity currently has at least one stack of `id`. */
export function hasEffect(entity, id) {
  if (!entity || !Array.isArray(entity.effects)) return false;
  return entity.effects.some(e => e.id === id);
}

/**
 * Apply an effect to an entity. Refresh-duration semantics by default:
 * re-applying an existing effect bumps duration to max(existing, new) and
 * leaves stacks untouched. Pass `{ stack: true }` to add a stack instead.
 *
 * Returns true on apply, false on no-op (unknown id, dead/missing entity).
 */
export function applyEffect(entity, id, options = {}) {
  if (!entity || !EFFECTS[id]) return false;
  if (!Array.isArray(entity.effects)) entity.effects = [];
  const def = EFFECTS[id];
  const dur = options.duration ?? def.defaultDuration ?? 1;
  const existing = entity.effects.find(e => e.id === id);
  if (existing) {
    if (options.stack) {
      existing.stacks = (existing.stacks ?? 1) + 1;
    }
    // For numeric durations, refresh to max; non-numeric (mission/permanent)
    // already wins over numeric.
    existing.duration = _maxDuration(existing.duration, dur);
    if (options.source != null) existing.source = options.source;
    return true;
  }
  const record = { id, duration: dur, stacks: 1 };
  if (options.source != null) record.source = options.source;
  entity.effects.push(record);
  return true;
}

/** Remove all stacks of an effect from an entity. Returns true if removed. */
export function removeEffect(entity, id) {
  if (!entity || !Array.isArray(entity.effects)) return false;
  const before = entity.effects.length;
  entity.effects = entity.effects.filter(e => e.id !== id);
  return entity.effects.length < before;
}

/** Sum of statMods for a given field across all of an entity's effects. */
export function effectStatMod(entity, field) {
  if (!entity || !Array.isArray(entity.effects)) return 0;
  let sum = 0;
  for (const rec of entity.effects) {
    const def = EFFECTS[rec.id];
    const mod = def?.statMods?.[field];
    if (typeof mod === 'number') sum += mod * (rec.stacks ?? 1);
  }
  return sum;
}

/** Sum of damageMods.takenFlat across an entity's effects. */
export function effectDamageTakenFlat(entity) {
  if (!entity || !Array.isArray(entity.effects)) return 0;
  let sum = 0;
  for (const rec of entity.effects) {
    const def = EFFECTS[rec.id];
    const mod = def?.damageMods?.takenFlat;
    if (typeof mod === 'number') sum += mod * (rec.stacks ?? 1);
  }
  return sum;
}

/** Number of bonus damage DICE (d6) added to any incoming blow — e.g.
 *  wounded → 1D6 per stack. Summed across effects × stacks; the caller rolls
 *  them through the deterministic die stream (see Entity.applyIncomingDamage). */
export function effectDamageTakenDice(entity) {
  if (!entity || !Array.isArray(entity.effects)) return 0;
  let dice = 0;
  for (const rec of entity.effects) {
    const def = EFFECTS[rec.id];
    const mod = def?.damageMods?.takenDice;
    if (typeof mod === 'number') dice += mod * (rec.stacks ?? 1);
  }
  return dice;
}

/** Sum of rangeMod across an entity's effects. */
export function effectRangeMod(entity) {
  if (!entity || !Array.isArray(entity.effects)) return 0;
  let sum = 0;
  for (const rec of entity.effects) {
    const def = EFFECTS[rec.id];
    const mod = def?.rangeMod;
    if (typeof mod === 'number') sum += mod * (rec.stacks ?? 1);
  }
  return sum;
}

/** Combat-side advantage granted to attackers targeting this defender. */
export function effectIncomingAtkAdvantage(entity) {
  if (!entity || !Array.isArray(entity.effects)) return 0;
  let sum = 0;
  for (const rec of entity.effects) {
    const def = EFFECTS[rec.id];
    const mod = def?.combatMods?.incomingAtkAdvantage;
    if (typeof mod === 'number') sum += mod * (rec.stacks ?? 1);
  }
  return sum;
}

/** True if any active effect blocks the entity from acting (e.g. stunned). */
export function effectsBlockActions(entity) {
  if (!entity || !Array.isArray(entity.effects)) return false;
  return entity.effects.some(rec => EFFECTS[rec.id]?.blocksActions);
}

/** True if any active effect blocks healing (cursed). */
export function effectsBlockHeal(entity) {
  if (!entity || !Array.isArray(entity.effects)) return false;
  return entity.effects.some(rec => EFFECTS[rec.id]?.blocksHeal);
}

// ── Round lifecycle ────────────────────────────────────────────────────────
//
// Called from src/post-round-effects.js. Returns events for each DOT tick
// and each effect that expired. Numeric durations decrement; mission/permanent
// effects do not.

/**
 * Apply round-end effects (DOTs) and decrement durations.
 * Returns { dotEvents, expiredEvents } — both arrays of objects suitable for
 * pushing into the post-round-events stream.
 *
 * DOT damage routes through `e.applyIncomingDamage(stacks)` so other effects
 * (wounded → +1) amplify it the same way they amplify combat damage.
 *
 * Lethal DOTs are NOT bookkept here — the caller (statusEffectsTick in
 * post-round-effects.js) reads `killed`/`killedEntity`/`source` off each
 * dot event and dispatches `trackKill`, the `kill` trigger on the source,
 * and `scatterPlayerUnits` for leader deaths. Keeping that logic in
 * post-round-effects avoids an `effects.js → factions.js → entities.js →
 * effects.js` import cycle.
 */
export function tickEffects(state) {
  const dotEvents = [];
  const expiredEvents = [];
  // Snapshot the entities to tick at the top — DOT deaths mutate
  // `state.entities` mid-loop, and any future change that pushes/removes
  // entities during the tick (multi-DOT chains, reactive spawns) would
  // otherwise produce silent skips or double-processing.
  const toTick = state.entities.filter(
    e => e.alive && Array.isArray(e.effects) && e.effects.length > 0
  );
  const dead = [];
  for (const e of toTick) {
    if (!e.alive) continue;
    // 1) Apply round-end effects (DOTs).
    for (const rec of e.effects.slice()) {
      const def = EFFECTS[rec.id];
      if (!def?.onRoundEnd) continue;
      if (def.onRoundEnd === 'damageOne') {
        const stacks = rec.stacks ?? 1;
        // One "tick" = DAMAGE_SCALE HP per stack (proportional to scaled pools).
        // Route through applyIncomingDamage so wounded etc. amplify DOTs.
        const incoming = e.applyIncomingDamage(stacks * DAMAGE_SCALE, (s) => state.nextDie(s));
        const killed = e.takeDamage(incoming);
        dotEvents.push({
          effectId: rec.id,
          entityId: e.id,
          entityName: e.displayName,
          ownerId: e.ownerId ?? null,
          col: e.col, row: e.row,
          amount: incoming,
          killed,
          // Surfaced for caller bookkeeping (kill credit, leader scatter,
          // kill triggers). May be null/undefined for environmental DOTs.
          killedEntity: killed ? e : null,
          source: rec.source ?? null,
          text: killed
            ? `${def.icon} ${e.displayName} succumbs to ${def.label.toLowerCase()}!`
            : `${def.icon} ${e.displayName} suffers from ${def.label.toLowerCase()}. (-${incoming} HP, ${e.hp}/${e.maxHp})`,
        });
        if (killed) {
          dead.push(e.id);
          break; // entity is gone — no further effects apply this tick
        }
      }
    }
    if (!e.alive) continue;
    // 2) Decrement durations + drop expired effects.
    const kept = [];
    for (const rec of e.effects) {
      if (typeof rec.duration === 'number') {
        const next = rec.duration - 1;
        if (next <= 0) {
          const def = EFFECTS[rec.id];
          expiredEvents.push({
            effectId: rec.id,
            entityId: e.id,
            entityName: e.displayName,
            ownerId: e.ownerId ?? null,
            col: e.col, row: e.row,
            text: `${def?.icon ?? ''} ${e.displayName}'s ${def?.label?.toLowerCase() ?? rec.id} fades.`.trim(),
          });
          continue;
        }
        kept.push({ ...rec, duration: next });
      } else {
        kept.push(rec); // 'mission' | 'permanent'
      }
    }
    e.effects = kept;
  }
  if (dead.length > 0) {
    const deadSet = new Set(dead);
    state.entities = state.entities.filter(e => !deadSet.has(e.id));
  }
  return { dotEvents, expiredEvents };
}

// ── Trigger dispatch ───────────────────────────────────────────────────────
//
// Called from action execution paths (kill/damage points) to fire any
// `triggers` arrays on the actor's abilities or effects. Triggers look like:
//   { on: 'kill' | 'damaged' | 'damaged-fatal' | 'round-start' | 'round-end',
//     condition?: 'killsThisRound>=2' | (actor, payload) => bool,
//     apply: 'frenzied',
//     applyOptions?: { duration: 1, ... } }
//
// Conditions are either a small DSL string (parsed below) or a raw fn.

const _CONDITION_RE = /^([a-zA-Z_]+)\s*(>=|<=|==|>|<)\s*(-?\d+)$/;

function _evalCondition(cond, actor, payload) {
  if (cond == null) return true;
  if (typeof cond === 'function') return !!cond(actor, payload);
  if (typeof cond !== 'string') return false;
  const m = cond.match(_CONDITION_RE);
  if (!m) return false;
  const [, field, op, rhsStr] = m;
  const rhs = Number(rhsStr);
  // Lookup order: payload first (event-specific overrides), then actor.
  const lhs = (payload != null && field in payload) ? payload[field] : actor?.[field];
  const lhsN = Number(lhs ?? 0);
  switch (op) {
    case '>=': return lhsN >= rhs;
    case '<=': return lhsN <= rhs;
    case '>':  return lhsN >  rhs;
    case '<':  return lhsN <  rhs;
    case '==': return lhsN === rhs;
  }
  return false;
}

/**
 * Fire any trigger handlers attached to the actor's abilities / effects for
 * this event. Triggers may apply effects, set fields, etc.
 *
 * Events currently emitted:
 *   - 'kill'         payload: { state, target }   — actor just killed target
 *   - 'damaged'      payload: { state, amount, source } — actor took damage
 *   - 'damaged-fatal' payload: same — the damage just killed the actor (pre-removal)
 *   - 'round-end'    payload: { state }
 */
export function dispatchTrigger(event, actor, payload = {}) {
  if (!actor) return;
  const sources = [];
  if (Array.isArray(actor.abilities)) {
    for (const id of actor.abilities) {
      const def = ABILITIES[id];
      if (def?.triggers) sources.push(def);
    }
  }
  if (Array.isArray(actor.effects)) {
    for (const rec of actor.effects) {
      const def = EFFECTS[rec.id];
      if (def?.triggers) sources.push(def);
    }
  }
  if (sources.length === 0) return;
  for (const src of sources) {
    for (const t of src.triggers) {
      if (t.on !== event) continue;
      if (!_evalCondition(t.condition, actor, payload)) continue;
      if (t.apply) applyEffect(actor, t.apply, t.applyOptions ?? {});
    }
  }
}

// ── Internal ───────────────────────────────────────────────────────────────

function _maxDuration(a, b) {
  // Non-numeric durations beat numeric: 'permanent' > 'mission' > number.
  const rank = (d) => d === 'permanent' ? Infinity : d === 'mission' ? 1e9 : Number(d) || 0;
  return rank(a) >= rank(b) ? a : b;
}
