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
    case PlanActionType.USE_ITEM:
      return `${who} uses ${action.item}`;
    case PlanActionType.EQUIP_WEAPON:
      return `${who} equips ${action.weapon}`;
    case PlanActionType.USE_ABILITY:
      return `${who} uses ability`;
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
    case PlanActionType.USE_ITEM: {
      const item = action.item;
      if (!item || item.startsWith('weapon:')) return '';
      return `−1${RES_ICON[item] || item}`;
    }
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
  const projShared      = { ...(initialInv?.shared      ?? {}) };
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
      case PlanActionType.USE_ITEM: {
        const item = a.item;
        if (!item || item.startsWith('weapon:')) break;
        if (item === ResourceType.HERBS) {
          const eitems = projEntityItems[a.entityId];
          if (eitems && (eitems[item] || 0) > 0) eitems[item]--;
        } else if ((projShared[item] || 0) > 0) { projShared[item]--; }
        break;
      }
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
 * @param {Map<string, Array>} unitPlans  Map of entityId → PlanAction[].
 * @param {number}  budget           Total action budget for this round.
 * @param {number}  foodAvailable    Total food rations in inventory.
 * @param {boolean} submitted        Whether the plan has been locked in.
 * @param {Array}   entities         Live entity array (for name lookups).
 * @param {object}  [initialInv]     Starting inventory snapshot.
 * @returns {string}  HTML string safe to assign to stepsEl.innerHTML.
 */
export function buildUnitPlanBlocksHtml(unitPlans, budget, foodAvailable, submitted, entities, initialInv) {
  if (!unitPlans || unitPlans.size === 0) {
    return `<div class="plan-step"><span class="plan-step-desc" style="color:var(--muted)">No actions queued — click units to add</span></div>`;
  }

  // Pre-compute budget state and cost labels by walking actions in interleaved
  // order (matching resolution execution order).  Store results keyed by
  // "entityId:stepIdx" for lookup during per-unit rendering.
  const budgetState = new Map();   // key → 'ok' | 'food' | 'over'
  const costLabels  = new Map();   // key → string

  const projShared      = { ...(initialInv?.shared      ?? {}) };
  const projWitch       = { ...(initialInv?.witch       ?? {}) };
  const projEntityItems = {};
  if (initialInv?.entityItems) {
    for (const [id, items] of Object.entries(initialInv.entityItems)) {
      projEntityItems[id] = { ...items };
    }
  }

  let runningCost = 0;
  let foodUsed    = 0;
  const unitIds = [...unitPlans.keys()];
  let step = 0;
  while (true) {
    let any = false;
    for (const eid of unitIds) {
      const actions = unitPlans.get(eid);
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
      _advanceProjectedInventory(a, projShared, projWitch, projEntityItems);
    }
    if (!any) break;
    step++;
  }

  // Render per-unit blocks
  let html = '';

  for (const [entityId, actions] of unitPlans) {
    const entity = entities.find(e => e.id === entityId);
    const glyph  = entity ? (UNIT_GLYPH[entity.type] || '?') : '?';
    const color  = entity ? (ENTITY_COLOR[entity.type] || '#aaa') : '#aaa';
    const name   = entity?.displayName ?? 'Unit';
    const count  = actions.filter(a =>
      a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM
    ).length;

    html += `<div class="plan-unit-block" data-entity-id="${entityId}">`;
    html += `<div class="plan-unit-header">`;
    html += `<span class="plan-step-avatar" style="background:${color}">${glyph}</span>`;
    html += `<span class="plan-unit-name">${name}</span>`;
    html += `<span class="plan-unit-count">${count} action${count !== 1 ? 's' : ''}</span>`;
    html += `</div>`;
    html += `<div class="plan-unit-steps">`;

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

    html += `</div></div>`;
  }

  return html;
}

/** Advance projected inventory for one action (shared between flat and per-unit renderers). */
function _advanceProjectedInventory(a, projShared, projWitch, projEntityItems) {
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
    case PlanActionType.USE_ITEM: {
      const item = a.item;
      if (!item || item.startsWith('weapon:')) break;
      if (item === ResourceType.HERBS) {
        const eitems = projEntityItems[a.entityId];
        if (eitems && (eitems[item] || 0) > 0) eitems[item]--;
      } else if ((projShared[item] || 0) > 0) { projShared[item]--; }
      break;
    }
  }
}

// ── Player status panel HTML ──────────────────────────────────────────────────

/**
 * Build the innerHTML for the #plan-players ready list.
 *
 * @param {Array<{ playerId: string, name: string, faction: string, _submitted?: boolean }>} players
 * @returns {string}  HTML string.
 */
export function buildPlayerStatusHtml(players) {
  let html = '';
  for (const p of players) {
    const submitted = p._submitted ?? false;
    const icon      = submitted ? '✓' : '⋯';
    const cls       = submitted ? 'player-ready' : 'player-waiting';
    const label     = p.name;
    const fCls      = p.faction === 'hero' ? 'faction-hero' : 'faction-witch';
    const safeName  = String(label)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Presence dot: green = active, yellow = connected but backgrounded, grey = disconnected
    const presenceCls = p.active ? 'presence-active'
      : p.connected ? 'presence-inactive'
      : 'presence-offline';
    const presenceDot = (p.isAI || p.connected === undefined) ? ''
      : `<span class="presence-dot ${presenceCls}"></span>`;
    html += `<div class="plan-player-row ${cls}">
        <span class="plan-player-icon ${fCls}">${p.faction === 'hero' ? '⚔' : '✦'}</span>
        ${presenceDot}<span class="plan-player-name">${safeName}</span>
        <span class="plan-player-status">${icon}</span>
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
export function buildObjectivesHtml(witchObjectives, entities, nodeScore) {
  const scoreMax = 4;
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

  const score     = nodeScore ?? { hero: 0, witch: 0 };
  const heroPips  = Array.from({ length: scoreMax }, (_, i) =>
    `<span class="score-pip hero${i < score.hero ? ' filled' : ''}"></span>`).join('');
  const witchPips = Array.from({ length: scoreMax }, (_, i) =>
    `<span class="score-pip witch${i < score.witch ? ' filled' : ''}"></span>`).join('');

  const html =
    `<span class="score-track hero-track" title="Hero score: ${score.hero}/4">${heroPips}</span>` +
    `<span class="node-dots-group">${nodeDots}</span>` +
    `<span class="score-track witch-track" title="Witch score: ${score.witch}/4">${witchPips}</span>`;

  const title = witchCount === witchObjectives.length ? '⚠ Witch controls all nodes!'
              : heroCount  === witchObjectives.length ? '★ Hero controls all nodes!'
              : 'Power Nodes';

  return { html, title };
}
