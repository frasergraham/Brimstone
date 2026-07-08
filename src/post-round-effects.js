// Post-round effects pipeline — generic, extensible system for phase-based
// effects that fire after each round.  Each effect function receives the
// current GameState and returns an array of structured PostRoundEvent objects.
//
// To add a new effect, call registerPostRoundEffect(id, fn) at module scope.

import { Phase } from './game.js';
import { ICON } from './icons.js';
import { EntityType } from './entities.js';
import { hasBuilding } from './tiles.js';
import { hexKey } from './hex.js';
import { tickEffects, EFFECTS, dispatchTrigger } from './effects.js';
import { getFaction } from './factions.js';

// ── Event types ─────────────────────────────────────────────────────────────

export const PostRoundEventType = Object.freeze({
  DAMAGE:        'damage',
  KILL:          'kill',
  SHELTER:       'shelter',
  SAFE:          'safe',
  EFFECT_TICK:   'effect_tick',
  EFFECT_EXPIRE: 'effect_expire',
});

// ── Attrition schedule ──────────────────────────────────────────────────────
// Damage dealt per exposed unit per hazard phase each cycle.
//   Cycle 1:   1  — pressure from the start
//   Cycle 2:   1
//   Cycles 3-4: 2  — significant threat
//   Cycle 5+:  3  — lethal for most units in the open

export function attritionForCycle(cycle) {
  if (cycle <= 2) return 1;
  if (cycle <= 4) return 2;
  return 3;
}

// ── Effect registry ─────────────────────────────────────────────────────────

const _effects = [];

export function registerPostRoundEffect(id, fn) {
  _effects.push({ id, fn });
}

/** Run all registered effects against the current state.
 *  Returns a flat array of PostRoundEvent objects.
 *  Each event's `text` is also pushed to `state.addLog()`. */
export function applyPostRoundEffects(state) {
  const allEvents = [];
  for (const { id, fn } of _effects) {
    const events = fn(state);
    for (const ev of events) {
      ev.effectId = id;
      if (ev.text) state.addLog(ev.text);
      allEvents.push(ev);
    }
  }
  return allEvents;
}

// ── Night attrition effect ──────────────────────────────────────────────────
// Survivors caught in the open during NIGHT take attritionLevel damage.
// The hero leader is hardened against it.  Fortified hexes provide shelter.

function nightAttritionEffect(state) {
  if (state.phase !== Phase.NIGHT) return [];

  // attritionLevel is a 1–3 tier (see attritionForCycle). Each exposed survivor
  // now rolls 2d6 for the night's bite (replacing the old fixed DAMAGE_SCALE
  // base), scaled by the tier so later cycles still escalate. 2d6 averages 7 —
  // matching the prior tier-1 value (1 × DAMAGE_SCALE = 7) — but with variance.
  // The roll uses state.nextDie(6) (the game's deterministic die stream, forced
  // dice in tutorials) so resolution stays a pure fn of (state, plans, seed).
  // `attritionActive` gates the whole pass (tier 0 ⇒ no attrition).
  const attritionActive = state.attritionLevel > 0;
  const events = [];

  // All living survivors, split by shelter status.
  const allSurvivors = state.entities.filter(e =>
    e.alive && e.type === EntityType.SURVIVOR
  );

  // Survivors sheltered inside buildings (always safe).
  const inBuilding = [];
  // Survivors outside buildings (may be fortified or exposed).
  const exposed = [];
  for (const e of allSurvivors) {
    const t = state.tiles.get(hexKey(e.col, e.row));
    if (t && hasBuilding(t)) {
      inBuilding.push(e);
    } else {
      exposed.push(e);
    }
  }

  // Building shelter events
  for (const e of inBuilding) {
    const t = state.tiles.get(hexKey(e.col, e.row));
    const bName = t?.building ?? 'building';
    events.push({
      type:       PostRoundEventType.SHELTER,
      entityId:   e.id,
      ownerId:    e.ownerId ?? null,
      entityName: e.displayName,
      col: e.col, row: e.row,
      amount: 0,
      killed: false,
      text: `${ICON.shelter} ${e.displayName} is sheltered in the ${bName}.`,
      flash: null,
    });
  }

  if (attritionActive) {
    for (const e of exposed) {
      const t = state.tiles.get(hexKey(e.col, e.row));
      if (t && t.fortifyLevel > 0) {
        events.push({
          type:       PostRoundEventType.SHELTER,
          entityId:   e.id,
          ownerId:    e.ownerId ?? null,
          entityName: e.displayName,
          col: e.col, row: e.row,
          amount: 0,
          killed: false,
          text: `${ICON.fort} ${e.displayName} is sheltered by the fort! (level ${t.fortifyLevel})`,
          flash: null,
        });
        continue;
      }

      // Roll 2d6 for this survivor's night bite (deterministic via nextDie),
      // scaled by the attrition tier so later cycles still escalate.
      const dmg = (state.nextDie(6) + state.nextDie(6)) * state.attritionLevel;
      // Route through applyIncomingDamage so wounded etc. amplify attrition
      // the same way they amplify combat / DOTs.
      const incoming = e.applyIncomingDamage(dmg, (sd) => state.nextDie(sd));
      const killed = e.takeDamage(incoming);
      const text = killed
        ? `${ICON.defeat} ${e.displayName} is consumed by the night!`
        : `${ICON.night} ${e.displayName} suffers in the open! (-${incoming} HP, ${e.hp}/${e.maxHp} remaining)`;

      events.push({
        type:       killed ? PostRoundEventType.KILL : PostRoundEventType.DAMAGE,
        entityId:   e.id,
        ownerId:    e.ownerId ?? null,
        entityName: e.displayName,
        col: e.col, row: e.row,
        amount: incoming,
        killed,
        text,
        flash: {
          color:     'rgba(80,0,160,0.6)',
          textColor: 'rgba(210,140,255,1)',
          label:     `-${incoming}`,
          duration:  2200,
          fontScale: 1.4,
        },
      });

      if (killed) {
        state.recordCasualty?.(e);  // campaign permadeath: remember the dead before they vanish
        state.recordDeathLocation?.(e);  // necromancer RAISE DEAD: mark where the body fell
        state.entities = state.entities.filter(x => x.id !== e.id);
      }
    }
  }

  if (allSurvivors.length === 0 || !attritionActive) {
    events.push({
      type:       PostRoundEventType.SAFE,
      entityId:   null,
      ownerId:    null,
      entityName: null,
      col: null, row: null,
      amount: 0,
      killed: false,
      text: `${ICON.night} Night falls. Survivors are safe for now.`,
      flash: null,
    });
  }

  return events;
}

registerPostRoundEffect('night-attrition', nightAttritionEffect);

// ── Status effects tick ────────────────────────────────────────────────────
// Runs every round (regardless of phase): poisoned/bleeding deal DOT, then
// numeric durations decrement. Mission/permanent effects don't decrement.
//
// Registered AFTER night-attrition so a survivor doesn't simultaneously take
// night damage and bleed damage on the same round (rare in practice; this
// ordering preserves the existing attrition log/UX as the headline event).

function statusEffectsTick(state) {
  const { dotEvents, expiredEvents } = tickEffects(state);
  const events = [];
  for (const ev of dotEvents) {
    const def = EFFECTS[ev.effectId];

    // Kill bookkeeping for lethal DOTs — mirrors executeBattle's kill path.
    // Without this, bleeding/poisoned/cursed deaths skip kill credit, leader
    // scatter, and never fire the attacker's `kill` triggers (e.g. berserker).
    if (ev.killed && ev.killedEntity) {
      const killed = ev.killedEntity;
      const source = ev.source;
      // Source may be an Entity (most cases — applied during combat), a
      // string faction id, or null (environmental DOT). Only credit a real
      // kill when we can resolve a faction.
      if (source && typeof source === 'object' && source.owner) {
        const fac = getFaction(source.owner);
        if (fac) fac.trackKill(state);
        source.killsThisRound = (source.killsThisRound ?? 0) + 1;
        dispatchTrigger('kill', source, { state, target: killed });
      } else if (typeof source === 'string') {
        const fac = getFaction(source);
        if (fac) fac.trackKill(state);
      }
      // Leader-death scatter — same trigger as the resolver's
      // `_handleLeaderDeath`. Use the `leader` tag instead of importing
      // isLeaderType to avoid an effects/entities cycle.
      if (typeof killed.hasTag === 'function' && killed.hasTag('leader') && killed.ownerId) {
        if (typeof state.scatterPlayerUnits === 'function') {
          state.scatterPlayerUnits(killed.ownerId);
        }
      }
    }

    events.push({
      type:       ev.killed ? PostRoundEventType.KILL : PostRoundEventType.EFFECT_TICK,
      entityId:   ev.entityId,
      ownerId:    ev.ownerId,
      entityName: ev.entityName,
      col:        ev.col,
      row:        ev.row,
      amount:     ev.amount,
      killed:     ev.killed,
      text:       ev.text,
      // Kills flash too — without one the unit silently vanishes from the
      // map with nothing to explain why (operator report: "both of them
      // vanished, I don't know why").
      flash: {
        color:     'rgba(160,40,80,0.5)',
        textColor: 'rgba(255,180,200,1)',
        label:     ev.killed
          ? `-${ev.amount} ${def?.icon ?? ''} ${ICON.defeat}`.replace(/\s+/g, ' ').trim()
          : `-${ev.amount} ${def?.icon ?? ''}`.trim(),
        duration:  ev.killed ? 2200 : 1800,
        fontScale: ev.killed ? 1.4 : 1.2,
      },
    });
  }
  for (const ev of expiredEvents) {
    events.push({
      type:       PostRoundEventType.EFFECT_EXPIRE,
      entityId:   ev.entityId,
      ownerId:    ev.ownerId,
      entityName: ev.entityName,
      col:        ev.col,
      row:        ev.row,
      amount:     0,
      killed:     false,
      text:       ev.text,
      flash:      null,
    });
  }
  return events;
}

registerPostRoundEffect('status-effects', statusEffectsTick);

/**
 * Wrap-up card rows from a round's post-round events. KILL events are listed
 * for EITHER side — the player just watched that unit vanish from the map, so
 * the summary must explain it (cause rides in `text`, e.g. "🩸 Zombie succumbs
 * to bleeding!"). DAMAGE/SHELTER stay scoped to the viewing player's units
 * (`myId`; null ⇒ offline, keep everything). Pure — shared by the offline and
 * online wrap-up builders.
 */
export function collectWrapUpAttrition(postRoundEvents, myId = null) {
  const rows = [];
  for (const ev of postRoundEvents ?? []) {
    if (ev.type === PostRoundEventType.KILL) {
      rows.push({ kind: 'kill', name: ev.entityName, amount: ev.amount, text: ev.text ?? null });
      continue;
    }
    if (myId && ev.ownerId && ev.ownerId !== myId) continue;
    if (ev.type === PostRoundEventType.DAMAGE) {
      rows.push({ kind: 'damage', name: ev.entityName, amount: ev.amount, text: ev.text ?? null });
    } else if (ev.type === PostRoundEventType.SHELTER) {
      rows.push({
        kind: 'shelter', name: ev.entityName,
        shelter: ev.text?.startsWith('\uE03C') ? 'building' : 'fort',
      });
    }
  }
  return rows;
}
