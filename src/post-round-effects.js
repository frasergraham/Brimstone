// Post-round effects pipeline — generic, extensible system for phase-based
// effects that fire after each round.  Each effect function receives the
// current GameState and returns an array of structured PostRoundEvent objects.
//
// To add a new effect, call registerPostRoundEffect(id, fn) at module scope.

import { Phase } from './game.js';
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

  const dmg = state.attritionLevel;
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
      text: `🏠 ${e.displayName} is sheltered in the ${bName}.`,
      flash: null,
    });
  }

  if (dmg > 0) {
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
          text: `🏰 ${e.displayName} is sheltered by the fort! (level ${t.fortifyLevel})`,
          flash: null,
        });
        continue;
      }

      // Route through applyIncomingDamage so wounded etc. amplify attrition
      // the same way they amplify combat / DOTs.
      const incoming = e.applyIncomingDamage(dmg);
      const killed = e.takeDamage(incoming);
      const text = killed
        ? `💀 ${e.displayName} is consumed by the night!`
        : `🌙 ${e.displayName} suffers in the open! (-${incoming} HP, ${e.hp}/${e.maxHp} remaining)`;

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

      if (killed) state.entities = state.entities.filter(x => x.id !== e.id);
    }
  }

  if (allSurvivors.length === 0 || dmg === 0) {
    events.push({
      type:       PostRoundEventType.SAFE,
      entityId:   null,
      ownerId:    null,
      entityName: null,
      col: null, row: null,
      amount: 0,
      killed: false,
      text: `🌙 Night falls. Survivors are safe for now.`,
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
      flash: ev.killed ? null : {
        color:     'rgba(160,40,80,0.5)',
        textColor: 'rgba(255,180,200,1)',
        label:     `-${ev.amount} ${def?.icon ?? ''}`.trim(),
        duration:  1800,
        fontScale: 1.2,
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
