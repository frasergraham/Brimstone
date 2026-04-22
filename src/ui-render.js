// Pure render helpers — no DOM access, no side effects.
// Each function takes plain data and returns an HTML string.
// Imported by UIController to keep rendering logic separate from DOM wiring.

import { PlanActionType } from './planner.js';
import { EntityType, ENTITY_COLOR } from './entities.js';
import { ResourceType } from './tiles.js';
import { nodeController } from './game.js';

// ── Plan action description ───────────────────────────────────────────────────

/**
 * Return a human-readable description of a single plan action.
 * @param {{ type: string, entityId: string, [key: string]: * }} action
 * @param {Array<{ id: string, displayName?: string }>} entities
 * @param {number} index  Zero-based step index (used for fallback label).
 */
export function describePlanAction(action, entities, index = 0) {
  const entity = entities.find(e => e.id === action.entityId);
  const who    = entity?.displayName ?? 'Unit';
  switch (action.type) {
    case PlanActionType.MOVE:
      return `${who} → (${action.toCol},${action.toRow})`;
    case PlanActionType.BATTLE_UNIT: {
      const target = entities.find(e => e.id === action.targetId);
      return `${who} attacks ${target?.displayName ?? '?'}`;
    }
    case PlanActionType.BATTLE_HEX:
      return `${who} attacks (${action.targetCol},${action.targetRow})`;
    case PlanActionType.EXPLORE:
      return `${who} explores`;
    case PlanActionType.FORTIFY:
      return `${who} fortifies`;
    case PlanActionType.GUARD:
      return `${who} guards`;
    case PlanActionType.SUMMON:
      return `${who} summons`;
    case PlanActionType.HEAL:
      return `${who} heals`;
    case PlanActionType.USE_ITEM:
      return `${who} uses ${action.item}`;
    case PlanActionType.EQUIP_WEAPON:
      return `${who} equips ${action.weapon}`;
    case PlanActionType.USE_ABILITY:
      return `${who} uses ability`;
    case PlanActionType.SOUND_HORN:
      return `${who} sounds the horn`;
    default:
      return `Step ${index + 1}`;
  }
}

// ── Plan steps list HTML ──────────────────────────────────────────────────────

const RES_ICON = {
  [ResourceType.WOOD]:      '🪵',
  [ResourceType.METAL]:     '⚙',
  [ResourceType.HERBS]:     '🌿',
  [ResourceType.FOOD]:      '🍞',
  [ResourceType.SILVER]:    '🥈',
  [ResourceType.SCRIPTURE]: '📜',
};

/**
 * Return a short cost badge string (e.g. "−2⚙") for a plan action, given the
 * projected inventory AT THAT STEP.  Returns '' for free / action-point-only actions.
 */
function _stepCostLabel(action, projShared, projWitch, projEntityItems) {
  switch (action.type) {
    case PlanActionType.SUMMON: {
      if ((projWitch[ResourceType.METAL] || 0) >= 2) return `−2${RES_ICON[ResourceType.METAL]}`;
      if ((projWitch[ResourceType.WOOD]  || 0) >= 2) return `−2${RES_ICON[ResourceType.WOOD]}`;
      return '−2 res';
    }
    case PlanActionType.FORTIFY:
      if ((projShared[ResourceType.METAL] || 0) > 0) return `−1${RES_ICON[ResourceType.METAL]}`;
      if ((projShared[ResourceType.WOOD]  || 0) > 0) return `−1${RES_ICON[ResourceType.WOOD]}`;
      return '';
    case PlanActionType.HEAL:
      return `−1${RES_ICON[ResourceType.HERBS]}`;
    case PlanActionType.USE_ITEM: {
      const item = action.item;
      if (!item || item.startsWith('weapon:')) return '';
      return `−1${RES_ICON[item] || item}`;
    }
    case PlanActionType.SOUND_HORN:
      return `−1${RES_ICON[ResourceType.FOOD]}`;
    default: return '';
  }
}

/**
 * Build the innerHTML for the #plan-steps list.
 *
 * @param {Array}   plan             Current plan action array.
 * @param {number}  budget           Total action budget for this round.
 * @param {number}  foodAvailable    Total food rations in inventory.
 * @param {boolean} submitted        Whether the plan has been locked in.
 * @param {Array}   entities         Live entity array (for name lookups).
 * @param {object}  [initialInv]     Starting inventory snapshot { shared, witch, entityItems }.
 *                                   When provided, each step shows a resource-cost badge and
 *                                   over-budget steps are marked accordingly.
 * @returns {string}  HTML string safe to assign to stepsEl.innerHTML.
 */
export function buildPlanStepsHtml(plan, budget, foodAvailable, submitted, entities, initialInv) {
  const ENTITY_GLYPH = {
    [EntityType.HERO]:       '⚔',
    [EntityType.WITCH]:      '✦',
    [EntityType.SURVIVOR]:   '☺',
    [EntityType.ZOMBIE]:     '†',
    [EntityType.MINION]:     '☠',
    [EntityType.WOOD_GOLEM]: '🪵',
    [EntityType.IRON_GOLEM]: '⚙',
  };

  // Projected inventory — updated as we walk through steps
  const projShared      = { ...(initialInv?.hero        ?? {}) };
  const projWitch       = { ...(initialInv?.witch       ?? {}) };
  const projEntityItems = {};
  if (initialInv?.entityItems) {
    for (const [id, items] of Object.entries(initialInv.entityItems)) {
      projEntityItems[id] = { ...items };
    }
  }

  let runningCost = 0;
  let foodUsed    = 0;
  let html        = '';

  plan.forEach((a, i) => {
    const isFree     = a.type === PlanActionType.EQUIP_WEAPON || a.type === PlanActionType.USE_ITEM;
    if (!isFree) runningCost++;
    const overBudget  = !isFree && runningCost > budget;
    // Food is auto-applied to over-budget actions until we run out
    const foodPowered = overBudget && foodUsed < foodAvailable;
    if (foodPowered) foodUsed++;

    const desc      = describePlanAction(a, entities, i);
    const foodTag   = foodPowered ? ` <span class="plan-food-tag">🍞</span>` : '';
    const rmBtn     = submitted
      ? ''
      : `<button class="plan-step-remove" data-plan-idx="${i}" title="Remove">✕</button>`;
    const cls       = foodPowered ? ' food-powered' : overBudget ? ' over-budget' : '';

    const stepEntity = entities.find(e => e.id === a.entityId);
    const stepGlyph  = stepEntity ? (ENTITY_GLYPH[stepEntity.type] || '?') : '';
    const stepColor  = stepEntity ? (ENTITY_COLOR[stepEntity.type]  || '#aaa') : '#aaa';
    const avatar     = stepEntity
      ? `<span class="plan-step-avatar" style="background:${stepColor}">${stepGlyph}</span>`
      : '';

    // Resource cost badge — only shown when inventory data is available
    const costLbl = initialInv ? _stepCostLabel(a, projShared, projWitch, projEntityItems) : '';
    const costTag = costLbl ? ` <span class="plan-step-cost">${costLbl}</span>` : '';

    html += `<div class="plan-step${cls}">
        <span class="plan-step-num">${i + 1}</span>
        ${avatar}
        <span class="plan-step-desc" title="${desc}">${desc}${foodTag}${costTag}</span>
        ${rmBtn}
      </div>`;

    // Advance projected inventory for subsequent steps
    switch (a.type) {
      case PlanActionType.SUMMON:
        if ((projWitch[ResourceType.METAL] || 0) >= 2) { projWitch[ResourceType.METAL] -= 2; }
        else if ((projWitch[ResourceType.WOOD] || 0) >= 2) { projWitch[ResourceType.WOOD] -= 2; }
        else {
          let rem = 2;
          for (const k of Object.keys(projWitch).sort((a, b) => projWitch[b] - projWitch[a])) {
            const spend = Math.min(projWitch[k] || 0, rem); projWitch[k] -= spend; rem -= spend;
            if (rem === 0) break;
          }
        }
        break;
      case PlanActionType.FORTIFY:
        if ((projShared[ResourceType.METAL] || 0) > 0) projShared[ResourceType.METAL]--;
        else if ((projShared[ResourceType.WOOD] || 0) > 0) projShared[ResourceType.WOOD]--;
        break;
      case PlanActionType.HEAL: {
        const healEnt = entities.find(e => e.id === a.entityId);
        const healPools = { hero: projShared, witch: projWitch };
        const healPool = healPools[healEnt?.owner] || projShared;
        if ((healPool[ResourceType.HERBS] || 0) > 0) healPool[ResourceType.HERBS]--;
        break;
      }
      case PlanActionType.USE_ITEM: {
        const item = a.item;
        if (!item || item.startsWith('weapon:')) break;
        if ((projShared[item] || 0) > 0) { projShared[item]--; }
        break;
      }
      case PlanActionType.SOUND_HORN:
        if ((projShared[ResourceType.FOOD] || 0) >= 1) projShared[ResourceType.FOOD] -= 1;
        break;
    }
  });

  return html || `<div class="plan-step"><span class="plan-step-desc" style="color:var(--muted)">No actions queued — click units to add</span></div>`;
}

// ── Per-unit plan blocks HTML ────────────────────────────────────────────────

const UNIT_GLYPH = {
  [EntityType.HERO]:       '⚔',
  [EntityType.WITCH]:      '✦',
  [EntityType.SURVIVOR]:   '☺',
  [EntityType.ZOMBIE]:     '†',
  [EntityType.MINION]:     '☠',
  [EntityType.WOOD_GOLEM]: '🪵',
  [EntityType.IRON_GOLEM]: '⚙',
};

/**
 * Build plan panel HTML with visually distinct blocks per unit.
 *
 * Renders a row for every controllable unit (even units with zero queued
 * actions), highlighting the currently selected unit. This lets the plan panel
 * double as a unit selector.
 *
 * @param {Map<string, Array>} unitPlans       Map of entityId → PlanAction[].
 * @param {number}  budget                     Total action budget for this round.
 * @param {number}  foodAvailable              Total food rations in inventory.
 * @param {boolean} submitted                  Whether the plan has been locked in.
 * @param {Array}   entities                   Live entity array (for name lookups).
 * @param {object}  [initialInv]               Starting inventory snapshot.
 * @param {Array}   [controllableUnits]        Every unit the local player controls, in display order.
 * @param {string}  [selectedEntityId]         Id of the currently selected unit (for highlight).
 * @param {Map<string,string>} [portraitMap]   entityId → portrait data URL (optional; falls back to glyph).
 * @returns {string}  HTML string safe to assign to stepsEl.innerHTML.
 */
export function buildUnitPlanBlocksHtml(
  unitPlans, budget, foodAvailable, submitted, entities, initialInv,
  controllableUnits, selectedEntityId, portraitMap,
) {
  // Pre-compute budget state and cost labels by walking actions in interleaved
  // order (matching resolution execution order).  Store results keyed by
  // "entityId:stepIdx" for lookup during per-unit rendering.
  const budgetState = new Map();   // key → 'ok' | 'food' | 'over'
  const costLabels  = new Map();   // key → string

  const projShared      = { ...(initialInv?.hero        ?? {}) };
  const projWitch       = { ...(initialInv?.witch       ?? {}) };
  const projEntityItems = {};
  if (initialInv?.entityItems) {
    for (const [id, items] of Object.entries(initialInv.entityItems)) {
      projEntityItems[id] = { ...items };
    }
  }

  const unitPlansMap = unitPlans ?? new Map();
  let runningCost = 0;
  let foodUsed    = 0;
  const unitIds = [...unitPlansMap.keys()];
  let step = 0;
  while (unitIds.length > 0) {
    let any = false;
    for (const eid of unitIds) {
      const actions = unitPlansMap.get(eid);
      if (step >= actions.length) continue;
      any = true;
      const a = actions[step];
      const key = `${eid}:${step}`;
      const isFree = a.type === PlanActionType.EQUIP_WEAPON || a.type === PlanActionType.USE_ITEM;
      if (!isFree) runningCost++;
      const overBudget  = !isFree && runningCost > budget;
      const foodPowered = overBudget && foodUsed < foodAvailable;
      if (foodPowered) foodUsed++;

      budgetState.set(key, foodPowered ? 'food' : overBudget ? 'over' : 'ok');
      costLabels.set(key, initialInv ? _stepCostLabel(a, projShared, projWitch, projEntityItems) : '');

      // Advance projected inventory
      _advanceProjectedInventory(a, projShared, projWitch, projEntityItems, entities);
    }
    if (!any) break;
    step++;
  }

  // Determine the render order. Prefer the full controllable-units list so
  // units without actions still appear; fall back to unitPlans keys otherwise.
  let renderOrder;
  if (controllableUnits && controllableUnits.length > 0) {
    const ids = controllableUnits.map(e => e.id);
    // Tail on any unit that has queued actions but isn't in the controllable
    // list (e.g. just-killed unit with pending plan steps) so actions never vanish.
    for (const id of unitPlansMap.keys()) {
      if (!ids.includes(id)) ids.push(id);
    }
    renderOrder = ids;
  } else {
    renderOrder = [...unitPlansMap.keys()];
  }

  if (renderOrder.length === 0) {
    return `<div class="plan-step"><span class="plan-step-desc" style="color:var(--muted)">No units to command</span></div>`;
  }

  // Render per-unit blocks
  let html = '';

  for (const entityId of renderOrder) {
    const entity = entities.find(e => e.id === entityId);
    const glyph  = entity ? (UNIT_GLYPH[entity.type] || '?') : '?';
    const color  = entity ? (ENTITY_COLOR[entity.type] || '#aaa') : '#aaa';
    const name   = entity?.displayName ?? 'Unit';
    const actions = unitPlansMap.get(entityId) ?? [];
    const count  = actions.filter(a =>
      a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM
    ).length;
    const isSelected = entityId === selectedEntityId;
    const selectedCls = isSelected ? ' plan-unit-selected' : '';

    const portraitSrc = portraitMap?.get(entityId);
    const avatarHtml = portraitSrc
      ? `<img class="plan-step-avatar" src="${portraitSrc}" style="border-color:${color}" alt="">`
      : `<span class="plan-step-avatar" style="background:${color}">${glyph}</span>`;

    html += `<div class="plan-unit-block${selectedCls}" data-entity-id="${entityId}">`;
    html += `<div class="plan-unit-header">`;
    html += avatarHtml;
    html += `<span class="plan-unit-name">${name}</span>`;
    html += `<span class="plan-unit-count">${count} action${count !== 1 ? 's' : ''}</span>`;
    html += `</div>`;
    html += `<div class="plan-unit-steps">`;

    if (actions.length === 0) {
      html += `<div class="plan-step plan-step-empty"><span class="plan-step-desc">No actions queued</span></div>`;
    } else {
      actions.forEach((a, idx) => {
        const key  = `${entityId}:${idx}`;
        const bst  = budgetState.get(key) ?? 'ok';
        const cls  = bst === 'food' ? ' food-powered' : bst === 'over' ? ' over-budget' : '';
        const desc = describePlanAction(a, entities, idx);
        const foodTag = bst === 'food' ? ` <span class="plan-food-tag">🍞</span>` : '';
        const rmBtn   = submitted
          ? ''
          : `<button class="plan-step-remove" data-entity-id="${entityId}" data-step-idx="${idx}" title="Remove">✕</button>`;
        const costLbl = costLabels.get(key) ?? '';
        const costTag = costLbl ? ` <span class="plan-step-cost">${costLbl}</span>` : '';

        html += `<div class="plan-step${cls}">
            <span class="plan-step-num">${idx + 1}</span>
            <span class="plan-step-desc" title="${desc}">${desc}${foodTag}${costTag}</span>
            ${rmBtn}
          </div>`;
      });
    }

    html += `</div></div>`;
  }

  return html;
}

/** Advance projected inventory for one action (shared between flat and per-unit renderers). */
function _advanceProjectedInventory(a, projShared, projWitch, projEntityItems, entities) {
  switch (a.type) {
    case PlanActionType.SUMMON:
      if ((projWitch[ResourceType.METAL] || 0) >= 2) { projWitch[ResourceType.METAL] -= 2; }
      else if ((projWitch[ResourceType.WOOD] || 0) >= 2) { projWitch[ResourceType.WOOD] -= 2; }
      else {
        let rem = 2;
        for (const k of Object.keys(projWitch).sort((a, b) => projWitch[b] - projWitch[a])) {
          const spend = Math.min(projWitch[k] || 0, rem); projWitch[k] -= spend; rem -= spend;
          if (rem === 0) break;
        }
      }
      break;
    case PlanActionType.FORTIFY:
      if ((projShared[ResourceType.METAL] || 0) > 0) projShared[ResourceType.METAL]--;
      else if ((projShared[ResourceType.WOOD] || 0) > 0) projShared[ResourceType.WOOD]--;
      break;
    case PlanActionType.HEAL: {
      const healEnt = entities?.find(e => e.id === a.entityId);
      const healPools = { hero: projShared, witch: projWitch };
      const healPool = healPools[healEnt?.owner] || projShared;
      if ((healPool[ResourceType.HERBS] || 0) > 0) healPool[ResourceType.HERBS]--;
      break;
    }
    case PlanActionType.USE_ITEM: {
      const item = a.item;
      if (!item || item.startsWith('weapon:')) break;
      if ((projShared[item] || 0) > 0) { projShared[item]--; }
      break;
    }
    case PlanActionType.SOUND_HORN:
      if ((projShared[ResourceType.FOOD] || 0) >= 1) projShared[ResourceType.FOOD] -= 1;
      break;
  }
}

// ── Player status panel HTML ──────────────────────────────────────────────────

/** Strict hex-color validator — guarantees no CSS/HTML injection via inline style. */
const PLAYER_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/**
 * Build the innerHTML for the #plan-players ready list.
 *
 * @param {Array<{ playerId: string, name: string, faction: string, color?: string|null, _submitted?: boolean }>} players
 * @param {{ myPlayerId?: string, nudgedSet?: Set<string> }} [nudgeCtx]
 *   When provided, renders a nudge button for other human players who haven't submitted.
 * @returns {string}  HTML string.
 */
export function buildPlayerStatusHtml(players, nudgeCtx) {
  const myId    = nudgeCtx?.myPlayerId ?? null;
  const nudged  = nudgeCtx?.nudgedSet ?? null;
  let html = '';
  for (const p of players) {
    const pid       = p.playerId ?? p.id;
    const submitted = p._submitted ?? false;
    const icon      = submitted ? '✓' : '⋯';
    const cls       = submitted ? 'player-ready' : 'player-waiting';
    const label     = p.name;
    const fCls      = p.faction === 'hero' ? 'faction-hero' : 'faction-witch';
    const safeName  = String(label)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Per-player color (matches map unit outlines). Validated to prevent injection —
    // falls back to the faction CSS class when absent or invalid.
    const safeColor  = (p.color && PLAYER_COLOR_RE.test(p.color)) ? p.color : null;
    const colorStyle = safeColor ? ` style="color: ${safeColor}"` : '';
    // Presence dot: green = active, yellow = connected but backgrounded, grey = disconnected
    const presenceCls = p.active ? 'presence-active'
      : p.connected ? 'presence-inactive'
      : 'presence-offline';
    const presenceDot = (p.isAI || p.connected === undefined) ? ''
      : `<span class="presence-dot ${presenceCls}"></span>`;

    // Nudge button: shown for other human players who haven't submitted
    let nudgeBtn = '';
    if (nudged && myId && pid !== myId && !p.isAI && !submitted) {
      const already = nudged.has(pid);
      nudgeBtn = already
        ? `<button class="nudge-btn nudge-sent" disabled title="Nudge sent">NUDGE</button>`
        : `<button class="nudge-btn" data-nudge-id="${pid}" title="Nudge">NUDGE</button>`;
    }

    html += `<div class="plan-player-row ${cls}">
        <span class="plan-player-icon ${fCls}"${colorStyle}>${p.faction === 'hero' ? '⚔' : '✦'}</span>
        ${presenceDot}<span class="plan-player-name"${colorStyle}>${safeName}</span>
        ${nudgeBtn}<span class="plan-player-status">${icon}</span>
      </div>`;
  }
  return html;
}

// ── Objectives / node-status HTML ────────────────────────────────────────────

/**
 * Build innerHTML for the #node-status element and return { html, title }.
 *
 * @param {{ col: number, row: number, label: string }[]} witchObjectives
 * @param {Array<{ alive: boolean, owner: string, col: number, row: number }>} entities
 * @param {{ hero: number, witch: number }} nodeScore
 * @returns {{ html: string, title: string }}
 */
export function buildObjectivesHtml(witchObjectives, entities, nodeScore, gameMode = 'standard') {
  let nodeDots  = '';
  let witchCount = 0, heroCount = 0;

  for (const obj of witchObjectives) {
    const ctrl = nodeController(obj, entities);
    let cls;
    if      (ctrl === 'witch')     { cls = 'witch';     witchCount++; }
    else if (ctrl === 'hero')      { cls = 'hero';       heroCount++;  }
    else if (ctrl === 'contested') { cls = 'contested'; }
    else                           { cls = 'neutral';   }
    const nodeColor = obj.color ?? '#888';
    nodeDots += `<span class="node-dot ${cls}" title="${obj.label ?? ''}" style="border-color:${nodeColor}"></span>`;
  }

  const score = nodeScore ?? { hero: 0, witch: 0 };
  let html;

  if (gameMode === 'battle') {
    // Battle mode: numeric score display (unbounded)
    html =
      `<span class="score-track hero-track battle-score" title="Hero score: ${score.hero}">` +
        `<span class="score-num hero">${score.hero}</span>` +
      `</span>` +
      `<span class="node-dots-group">${nodeDots}</span>` +
      `<span class="score-track witch-track battle-score" title="Witch score: ${score.witch}">` +
        `<span class="score-num witch">${score.witch}</span>` +
      `</span>`;
  } else {
    // Standard mode: pip-based score display (max 4)
    const scoreMax = 4;
    const heroPips  = Array.from({ length: scoreMax }, (_, i) =>
      `<span class="score-pip hero${i < score.hero ? ' filled' : ''}"></span>`).join('');
    const witchPips = Array.from({ length: scoreMax }, (_, i) =>
      `<span class="score-pip witch${i < score.witch ? ' filled' : ''}"></span>`).join('');
    html =
      `<span class="score-track hero-track" title="Hero score: ${score.hero}/4">${heroPips}</span>` +
      `<span class="node-dots-group">${nodeDots}</span>` +
      `<span class="score-track witch-track" title="Witch score: ${score.witch}/4">${witchPips}</span>`;
  }

  const title = witchCount === witchObjectives.length ? '⚠ Witch controls all nodes!'
              : heroCount  === witchObjectives.length ? '★ Hero controls all nodes!'
              : 'Power Nodes';

  return { html, title };
}
