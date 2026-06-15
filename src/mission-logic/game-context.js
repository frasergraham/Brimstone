// ═══════════════════════════════════════════════════════════════════════════
// Mission Logic Graph — GameState-backed WorldContext
// ─────────────────────────────────────────────────────────────────────────────
// The production WorldContext (world-context.js documents the contract): adapts a
// live GameState so the engine's SIM nodes mutate authoritative state through the
// SAME game functions the legacy systems use — `resolveSpawnPosition` + the
// campaign's `createEnemyFn` for spawns, `buildVictoryDelegate` for objective
// evaluation — so a graph-driven mission stays at parity with the old fields.
//
// Reads are deterministic; the only randomness is `random` (pass the seeded game
// RNG). `emit` is the presentation sink — events are pushed onto a queue the
// orchestrator (main.js) drains and shows (docs/09 §3).
// ═══════════════════════════════════════════════════════════════════════════

import { buildVictoryDelegate, resolveSpawnPosition } from '../campaign/campaign.js';
import { applyLevel } from '../entities.js';

/**
 * @param {object} state - a live GameState.
 * @param {object} opts
 * @param {(type:string,col:number,row:number,state:object)=>object} opts.createEnemyFn
 *        - the campaign enemy factory (same one processWaves uses).
 * @param {(event:object)=>void} opts.emit - presentation sink.
 * @param {(key:string,value:any)=>void} [opts.setFlag] - campaign/story flag write.
 * @param {(key:string)=>any} [opts.getFlag] - campaign/story flag read.
 * @param {()=>number} [opts.random] - seeded RNG in [0,1).
 */
export function createGameContext(state, { createEnemyFn, emit, setFlag, getFlag, random } = {}) {
  // Memoize single-spec victory delegates so repeated polling is cheap.
  const delegateCache = new Map();
  const delegateFor = (spec, side) => {
    const key = `${side}:${JSON.stringify(spec)}`;
    let d = delegateCache.get(key);
    if (!d) { d = buildVictoryDelegate(side === 'lose' ? { lose: spec } : { win: spec }); delegateCache.set(key, d); }
    return d;
  };

  return {
    // ── reads ────────────────────────────────────────────────────────────────
    getState: () => state,
    getEntity: (id) => state.entities.find((e) => e.id === id),
    entitiesAt: (col, row) => state.entities.filter((e) => e.alive && e.col === col && e.row === row),
    getHero: () => state.hero,
    getFlag: (key) => (getFlag ? getFlag(key) : undefined),
    random: () => (random ? random() : Math.random()),

    // ── sim mutations (through the real game spawn path) ───────────────────────
    spawnUnit: (spec) => {
      const pos = resolveSpawnPosition(state, spec.spawnAt);
      if (!pos) return null;
      const entity = createEnemyFn?.(spec.type, pos.col, pos.row, state);
      if (!entity) return null;
      if (spec.level) applyLevel(entity, spec.level);     // level scaling first…
      if (spec.overrides) Object.assign(entity, spec.overrides); // …explicit overrides win
      state.entities.push(entity);
      return entity;
    },
    despawnUnit: (id) => {
      const i = state.entities.findIndex((e) => e.id === id);
      if (i >= 0) state.entities.splice(i, 1); // splice keeps the array identity (renderer caches)
    },
    setOutcome: (winner, reason) => {
      if (state.winner == null) { state.winner = winner; state.winReason = reason; }
    },
    setFlag: (key, value) => { setFlag?.(key, value); },

    // Delegates to the EXISTING victory logic so all 13 objective types behave
    // identically to the legacy path (docs/09 §4 — Win/Lose When).
    evaluateObjective: (spec, side = 'win') => !!delegateFor(spec, side)(state),

    // ── presentation sink ──────────────────────────────────────────────────────
    emit: (event) => { emit?.(event); },
  };
}
