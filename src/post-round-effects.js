// Post-round effects pipeline — generic, extensible system for phase-based
// effects that fire after each round.  Each effect function receives the
// current GameState and returns an array of structured PostRoundEvent objects.
//
// To add a new effect, call registerPostRoundEffect(id, fn) at module scope.

import { Phase } from './game.js';
import { EntityType } from './entities.js';
import { TileType } from './tiles.js';
import { hexKey } from './hex.js';

// ── Event types ─────────────────────────────────────────────────────────────

export const PostRoundEventType = Object.freeze({
  DAMAGE:  'damage',
  KILL:    'kill',
  SHELTER: 'shelter',
  SAFE:    'safe',
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
    if (t && t.type === TileType.BUILDING) {
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

      const killed = e.takeDamage(dmg);
      const text = killed
        ? `💀 ${e.displayName} is consumed by the night!`
        : `🌙 ${e.displayName} suffers in the open! (-${dmg} HP, ${e.hp}/${e.maxHp} remaining)`;

      events.push({
        type:       killed ? PostRoundEventType.KILL : PostRoundEventType.DAMAGE,
        entityId:   e.id,
        ownerId:    e.ownerId ?? null,
        entityName: e.displayName,
        col: e.col, row: e.row,
        amount: dmg,
        killed,
        text,
        flash: {
          color:     'rgba(80,0,160,0.6)',
          textColor: 'rgba(210,140,255,1)',
          label:     `-${dmg}`,
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
