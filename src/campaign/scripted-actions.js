// Scripted NPC actions for campaign cutscenes/conversations.
//
// Missions declare action lists (e.g. a conversation's `onComplete`) of plain
// JSON steps that spawn, move, despawn, or pause scripted NPCs. Validation is
// pure (used by json-mission.js and the Mission Editor); the executor is
// renderer-optional so headless/2D paths degrade to instant state changes.

import { createSurvivor } from '../entities.js';
import { playbackDelay } from '../playback.js';

export const SCRIPTED_ACTION_TYPES = Object.freeze(['spawn', 'move', 'despawn', 'wait']);

/**
 * Validate a scripted-action list (pure, throws on the first problem).
 * @param {object[]} actions — JSON action steps.
 * @param {{ ext?: {cols:number, rows:number}, npcIds?: string[]|Set<string> }} opts
 *   ext gates hex bounds checks (skipped when absent, e.g. procedural maps);
 *   npcIds gates `npc` references.
 */
export function validateScriptedActions(actions, { ext = null, npcIds = null } = {}) {
  if (!Array.isArray(actions)) throw new Error('scripted actions must be an array');
  const ids = npcIds ? new Set(npcIds) : null;
  const inBounds = (h, where) => {
    if (!h || !Number.isInteger(h.col) || !Number.isInteger(h.row)) {
      throw new Error(`scripted action ${where}: hex must have integer col/row`);
    }
    if (ext && (h.col < 0 || h.col >= ext.cols || h.row < 0 || h.row >= ext.rows)) {
      throw new Error(`scripted action ${where}: hex ${h.col},${h.row} out of bounds`);
    }
  };
  actions.forEach((a, idx) => {
    const where = `[${idx}]`;
    if (!SCRIPTED_ACTION_TYPES.includes(a.action)) {
      throw new Error(`scripted action ${where}: unknown action "${a.action}"`);
    }
    if (a.action === 'wait') {
      if (!Number.isFinite(a.ms) || a.ms < 0) throw new Error(`scripted action ${where}: wait needs ms >= 0`);
      return;
    }
    if (typeof a.npc !== 'string' || a.npc === '') {
      throw new Error(`scripted action ${where}: "${a.action}" needs an npc id`);
    }
    if (ids && !ids.has(a.npc)) {
      throw new Error(`scripted action ${where}: unknown npc "${a.npc}"`);
    }
    if (a.action === 'spawn') inBounds(a, `${where} spawn`);
    if (a.action === 'move') {
      if (!Array.isArray(a.path) || a.path.length === 0) {
        throw new Error(`scripted action ${where}: move needs a non-empty path`);
      }
      a.path.forEach((h, pi) => inBounds(h, `${where} path[${pi}]`));
    }
  });
}

/**
 * Create a scripted NPC entity from a mission `npcs[]` def (or a spawn action
 * merged with that def). Hero-owned survivor so it renders/fogs like an ally,
 * but tagged `isNpc` so planning, rosters, and victory counts skip it.
 */
export function spawnNpcEntity(npcDef, state) {
  const e = createSurvivor(npcDef.col, npcDef.row, 'hero', state, npcDef.survivorName ?? null);
  e.owner = 'hero'; // createSurvivor leaves faction null until recruited
  e.isNpc = true;
  e.npcId = npcDef.id;
  if (npcDef.displayTitle) e.title = npcDef.displayTitle;
  state.entities.push(e);
  if (e.name) state.markRosterUsedByName(e.name);
  return e;
}

/**
 * Run a scripted-action list sequentially, awaiting each animation.
 *
 * @param {object[]} actions — validated JSON steps.
 * @param {object} ctx
 *   state    — GameState (mutated: entities spawned/moved/despawned).
 *   renderer — optional; when absent (headless) or `instant`, state snaps.
 *   redraw   — optional () => void called after each visual change.
 *   npcDefs  — mission `npcs[]` defs, looked up by `spawn` actions.
 *   instant  — true when the player skipped: no animations or waits.
 */
export async function runScriptedActions(actions, ctx) {
  const { state, renderer = null, redraw = () => {}, npcDefs = [], instant = false } = ctx;
  const findNpc = (id) => state.entities.find(e => e.isNpc && e.npcId === id && e.alive !== false);

  for (const a of actions ?? []) {
    if (a.action === 'wait') {
      if (!instant) await playbackDelay(a.ms);
      continue;
    }
    if (a.action === 'spawn') {
      const def = npcDefs.find(n => n.id === a.npc) ?? {};
      if (findNpc(a.npc)) continue; // already on the map
      spawnNpcEntity({ ...def, id: a.npc, col: a.col, row: a.row }, state);
      redraw();
      if (!instant) await playbackDelay(300);
      continue;
    }
    const e = findNpc(a.npc);
    if (!e) continue; // missing actor — skip rather than crash a cutscene
    if (a.action === 'move') {
      const from = { col: e.col, row: e.row, slot: e.slot ?? 0 };
      const last = a.path[a.path.length - 1];
      e.col = last.col;
      e.row = last.row;
      e.slot = 0;
      if (renderer && !instant) {
        renderer.addMoveAnim(
          e.id, from.col, from.row, last.col, last.row,
          e.type, e.owner, e.title ?? null,
          renderer.is3D ? a.path : null, from.slot, 0,
        );
        redraw();
        if (renderer.waitForAnimations) await renderer.waitForAnimations();
      } else {
        redraw();
      }
      continue;
    }
    if (a.action === 'despawn') {
      if (!instant) await playbackDelay(200);
      const i = state.entities.indexOf(e);
      if (i >= 0) state.entities.splice(i, 1);
      redraw();
    }
  }
}
