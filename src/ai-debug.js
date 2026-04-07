// AI Debug Visualization — data store, color map, hex mapping helpers, panel DOM
//
// Admin-only feature for single-player games. Captures the AI's internal
// decision pipeline (goal scores, budget allocations, per-action goals,
// node feasibility, combat estimates) and renders overlays on the hex map
// plus a left-sidebar info panel.

import { hexKey, hexDistance } from './hex.js';
import { describePlanAction } from './ui-render.js';

// ── Goal color map ──────────────────────────────────────────────────────────
// Shared across witch and hero goals. Goals with the same semantic role share
// a color (e.g. KILL_HERO / SLAY_WITCH are both red).

export const GOAL_COLORS = Object.freeze({
  // Witch goals
  KILL_HERO:        '#e04040',
  CONTROL_NODES:    '#4080e0',
  BUILD_ARMY:       '#a040e0',
  GATHER_RESOURCES: '#40c070',
  DEFEND_WITCH:     '#e0c040',
  HUNT_HEROES:      '#e06040',
  // Hero goals
  SLAY_WITCH:       '#e04040',
  EXPLORE:          '#40c070',
  FORTIFY_POSITION: '#e0a030',
  PROTECT_HERO:     '#e0c040',
  // Fallback
  'gap-fill':       '#808080',
});

// ── Module state ────────────────────────────────────────────────────────────

let _active = false;
let _debugData = null;

export function setAIDebugActive(on) { _active = !!on; }
export function isAIDebugActive()    { return _active; }

/**
 * Store debug snapshot captured from the AI engine after plan generation.
 * @param {object} data - { faction, personality, board, scores, budget, actions, config, unitCommitments, combatEstimates }
 */
export function setAIDebugData(data) { _debugData = data; }
export function getAIDebugData()     { return _debugData; }
export function clearAIDebugData()   { _debugData = null; }

// ── Hex goal map ────────────────────────────────────────────────────────────
// Build a Map<hexKey, Array<{goal, priority, actionType}>> from the actions
// array (which still has _goal and _priority attached).

export function buildHexGoalMap(actions) {
  const map = new Map();
  for (const a of actions) {
    const goal = a._goal || 'gap-fill';
    const priority = a._priority ?? 99;
    const actionType = a.type;

    // Determine the hex this action targets
    let col, row;
    if (a.toCol !== undefined && a.toRow !== undefined) {
      col = a.toCol; row = a.toRow;   // MOVE targets
    } else if (a.col !== undefined && a.row !== undefined) {
      col = a.col; row = a.row;       // SUMMON, EXPLORE, FORTIFY
    } else {
      continue; // BATTLE_UNIT, USE_ITEM, EQUIP_WEAPON — no hex target
    }

    const key = hexKey(col, row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ goal, priority, actionType, col, row });
  }
  return map;
}

// ── Move arrows ─────────────────────────────────────────────────────────────
// Build arrow data for MOVE actions, chaining consecutive moves per entity
// so the renderer can draw from→to arrows like the planning overlay.

export function buildMoveArrows(actions, entities) {
  // Track current position per entity (start from real positions)
  const pos = new Map();
  for (const e of entities) {
    if (e.alive) pos.set(e.id, { col: e.col, row: e.row });
  }

  const arrows = [];
  let stepNum = 0;
  for (const a of actions) {
    if (a.type !== 'move' || a.toCol === undefined) continue;
    const from = pos.get(a.entityId);
    if (!from) continue;
    stepNum++;
    arrows.push({
      entityId: a.entityId,
      fromCol: from.col, fromRow: from.row,
      toCol: a.toCol, toRow: a.toRow,
      stepNumber: stepNum,
      goal: a._goal || 'gap-fill',
    });
    // Update tracked position for chaining
    pos.set(a.entityId, { col: a.toCol, row: a.toRow });
  }
  return arrows;
}

// ── Intent markers ──────────────────────────────────────────────────────────
// Derive the ultimate destination each unit is trying to reach, based on the
// goal commitment and board state. Shows WHERE the AI wants to go, not just
// how far it planned this turn.

export function buildIntentMarkers(actions, board, unitCommitments, faction) {
  if (!board) return [];
  const markers = [];
  const seen = new Set();

  const enemies = faction === 'witch'
    ? (board.visibleHeroes || [])
    : [board.witch, ...(board.witchMinions || board.minions || [])].filter(e => e?.alive);
  const nodes = board.nodes || [];
  const unexplored = board.unexploredBuildings || [];

  if (!unitCommitments) return markers;

  for (const [entityId, goal] of unitCommitments) {
    if (seen.has(entityId)) continue;
    seen.add(entityId);

    // Find the unit's projected end position (after all its planned moves)
    let unitPos = null;
    for (const a of actions) {
      if (a.entityId === entityId && a.type === 'move' && a.toCol !== undefined) {
        unitPos = { col: a.toCol, row: a.toRow };
      }
    }
    if (!unitPos) continue;

    let target = null;
    let label = '';

    if (goal === 'CONTROL_NODES') {
      let bestDist = Infinity;
      for (const n of nodes) {
        const d = hexDistance(unitPos.col, unitPos.row, n.obj.col, n.obj.row);
        if (d < bestDist) { bestDist = d; target = { col: n.obj.col, row: n.obj.row }; }
      }
      if (target && bestDist > 0) label = 'Node';
      else target = null;
    } else if (goal === 'KILL_HERO' || goal === 'SLAY_WITCH') {
      let bestDist = Infinity;
      for (const e of enemies) {
        if (!e?.alive) continue;
        const d = hexDistance(unitPos.col, unitPos.row, e.col, e.row);
        if (d < bestDist) { bestDist = d; target = { col: e.col, row: e.row }; }
      }
      if (target && bestDist > 0) label = goal === 'KILL_HERO' ? 'Hero' : 'Witch';
      else target = null;
    } else if (goal === 'GATHER_RESOURCES' || goal === 'EXPLORE') {
      let bestDist = Infinity;
      for (const b of unexplored) {
        const d = hexDistance(unitPos.col, unitPos.row, b.col, b.row);
        if (d < bestDist) { bestDist = d; target = { col: b.col, row: b.row }; }
      }
      if (target && bestDist > 0) label = 'Explore';
      else target = null;
    }

    if (target) {
      markers.push({ entityId, col: target.col, row: target.row, goal, label });
    }
  }
  return markers;
}

// ── Node feasibility map ──────────────────────────────────��─────────────────

export function buildNodeFeasibilityMap(board) {
  if (!board?.nodes) return [];
  return board.nodes.map(n => ({
    col: n.obj.col,
    row: n.obj.row,
    feasibility: n.feasibility ?? null,
    controller: n.controller,
    witchPresent: n.witchPresent,
    heroPresent: n.heroPresent,
  }));
}

// ── Panel DOM update ────────────────────────────────────────────────────────

/**
 * Populate the #ai-debug-panel DOM with current debug data.
 * @param {object} data - Debug snapshot from AI engine
 * @param {Array} [entities] - Live entity list for action descriptions
 */
export function updateAIDebugPanel(data, entities = []) {
  const panel = document.getElementById('ai-debug-panel');
  if (!panel || !data) return;

  panel.style.display = '';

  // Faction + personality header
  const factionRow = document.getElementById('ai-debug-faction-row');
  if (factionRow) {
    const glyph = data.faction === 'witch' ? '✦' : '⚔';
    const name = data.personality || 'balanced';
    factionRow.textContent = `${glyph} ${_capitalize(data.faction)} — ${_capitalize(name)}`;
  }

  // Goal scores: stacked horizontal bars
  const goalsEl = document.getElementById('ai-debug-goals');
  if (goalsEl && data.scores) {
    goalsEl.innerHTML = '<div class="ai-debug-section-title">Goal Scores</div>';
    const sorted = Object.entries(data.scores).sort((a, b) => b[1] - a[1]);
    for (const [goal, score] of sorted) {
      const color = GOAL_COLORS[goal] || '#888';
      const row = document.createElement('div');
      row.className = 'ai-debug-bar-row';
      row.innerHTML =
        `<span class="ai-debug-bar-label">${_goalLabel(goal)}</span>` +
        `<div class="ai-debug-bar-track">` +
          `<div class="ai-debug-bar-fill" style="width:${(score * 100).toFixed(0)}%;background:${color}"></div>` +
        `</div>` +
        `<span class="ai-debug-bar-value">${score.toFixed(2)}</span>`;
      goalsEl.appendChild(row);
    }
  }

  // Budget allocation: segmented bar
  const budgetEl = document.getElementById('ai-debug-budget');
  if (budgetEl && data.budget) {
    budgetEl.innerHTML = '<div class="ai-debug-section-title">Budget Allocation</div>';
    const totalAP = Object.values(data.budget).reduce((s, v) => s + v, 0);
    if (totalAP > 0) {
      const segBar = document.createElement('div');
      segBar.className = 'ai-debug-seg-bar';
      const sorted = Object.entries(data.budget)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [goal, ap] of sorted) {
        const color = GOAL_COLORS[goal] || '#888';
        const pct = (ap / totalAP * 100).toFixed(1);
        const seg = document.createElement('div');
        seg.className = 'ai-debug-seg';
        seg.style.cssText = `width:${pct}%;background:${color}`;
        seg.title = `${_goalLabel(goal)}: ${ap} AP`;
        seg.textContent = ap;
        segBar.appendChild(seg);
      }
      budgetEl.appendChild(segBar);

      // Legend below bar
      const legend = document.createElement('div');
      legend.className = 'ai-debug-seg-legend';
      for (const [goal, ap] of sorted) {
        const color = GOAL_COLORS[goal] || '#888';
        legend.innerHTML +=
          `<span class="ai-debug-legend-item">` +
            `<span class="ai-debug-legend-dot" style="background:${color}"></span>` +
            `${_goalLabel(goal)} (${ap})` +
          `</span>`;
      }
      budgetEl.appendChild(legend);
    }
  }

  // Board summary: compact key-value grid
  const boardEl = document.getElementById('ai-debug-board');
  if (boardEl && data.board) {
    boardEl.innerHTML = '<div class="ai-debug-section-title">Board State</div>';
    const b = data.board;
    const rows = _buildBoardSummaryRows(data.faction, b);
    const grid = document.createElement('div');
    grid.className = 'ai-debug-kv-grid';
    for (const [label, value] of rows) {
      grid.innerHTML +=
        `<span class="ai-debug-kv-label">${label}</span>` +
        `<span class="ai-debug-kv-value">${value}</span>`;
    }
    boardEl.appendChild(grid);
  }

  // Action list: grouped by unit, each action showing its goal
  const actionsEl = document.getElementById('ai-debug-actions');
  if (actionsEl && data.actions) {
    actionsEl.innerHTML = '<div class="ai-debug-section-title">AI Actions</div>';
    _renderActionList(actionsEl, data.actions, entities);
  }
}

export function hideAIDebugPanel() {
  const panel = document.getElementById('ai-debug-panel');
  if (panel) panel.style.display = 'none';
}

// ── Internal helpers ────────────────────────────────────────────────────────

function _capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function _goalLabel(goal) {
  return goal.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _buildBoardSummaryRows(faction, b) {
  const rows = [];
  if (faction === 'witch') {
    rows.push(['HP', `${b.witchHp ?? '?'}/${b.witchMaxHp ?? '?'} (${_pct(b.witchHpRatio)})`]);
    rows.push(['Army', `${b.minionCount ?? 0} minions`]);
    rows.push(['Strength', `${(b.armyStrength ?? 0).toFixed(1)}`]);
    rows.push(['Resources', `🪵${b.woodCount ?? 0} ⚙${b.metalCount ?? 0}`]);
    rows.push(['Hero dist', `${b.heroDistance ?? '?'} hex`]);
    rows.push(['Hero HP', _pct(b.heroHpRatio)]);
  } else {
    rows.push(['HP', `${b.heroHp ?? '?'}/${b.heroMaxHp ?? '?'} (${_pct(b.heroHpRatio)})`]);
    rows.push(['Survivors', `${b.survivorCount ?? 0}`]);
    rows.push(['Items', `🌿${b.herbCount ?? 0} 🍖${b.foodCount ?? 0}`]);
    rows.push(['Resources', `🪵${b.woodCount ?? 0} ⚙${b.metalCount ?? 0}`]);
    rows.push(['Witch dist', `${b.witchDistance ?? '?'} hex`]);
    rows.push(['Witch HP', _pct(b.witchHpRatio)]);
  }
  // Shared
  rows.push(['Nodes', `H:${b.heroHeldCount ?? 0} W:${b.witchHeldCount ?? 0}`]);
  rows.push(['Score', `H:${b.heroScore ?? b.nodeScore?.hero ?? 0} W:${b.witchScore ?? b.nodeScore?.witch ?? 0}`]);
  rows.push(['Phase', b.phase || '?']);
  rows.push(['Scoring in', `${b.roundsToScoring ?? '?'} rounds`]);
  rows.push(['Budget', `${b.totalBudget ?? '?'} AP`]);
  return rows;
}

function _pct(ratio) {
  return ratio != null ? `${(ratio * 100).toFixed(0)}%` : '?';
}

/**
 * Render the AI's action list grouped by unit, each action tagged with its goal.
 * Actions are sorted by priority (execution order), matching what assemblePlan produces.
 */
function _renderActionList(container, actions, entities) {
  // Group actions by entityId, preserving priority order
  const sorted = [...actions].sort((a, b) => (a._priority ?? 99) - (b._priority ?? 99));
  const byUnit = new Map();
  for (const a of sorted) {
    const eid = a.entityId;
    if (!byUnit.has(eid)) byUnit.set(eid, []);
    byUnit.get(eid).push(a);
  }

  for (const [entityId, unitActions] of byUnit) {
    const entity = entities.find(e => e.id === entityId);
    const name = entity?.displayName ?? entityId;

    const block = document.createElement('div');
    block.className = 'ai-debug-unit-block';

    // Unit header
    const header = document.createElement('div');
    header.className = 'ai-debug-unit-header';
    header.textContent = name;
    block.appendChild(header);

    // Action rows
    for (let i = 0; i < unitActions.length; i++) {
      const a = unitActions[i];
      const goal = a._goal || 'gap-fill';
      const color = GOAL_COLORS[goal] || '#888';
      const desc = describePlanAction(a, entities, i);
      const goalTag = _goalLabel(goal);

      const row = document.createElement('div');
      row.className = 'ai-debug-action-row';
      row.innerHTML =
        `<span class="ai-debug-action-num">${i + 1}</span>` +
        `<span class="ai-debug-action-desc">${desc}</span>` +
        `<span class="ai-debug-action-goal" style="color:${color}">${goalTag}</span>`;
      block.appendChild(row);
    }

    container.appendChild(block);
  }

  if (byUnit.size === 0) {
    container.innerHTML += '<div class="ai-debug-action-empty">No actions generated</div>';
  }
}
