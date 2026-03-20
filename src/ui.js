// UI controller: handles canvas clicks, sidepanel updates, action buttons
import { hexKey } from './hex.js';
import { TileType, BUILDING_LABEL, RESOURCE_LABEL, WEAPON_LABEL } from './tiles.js';
import { EntityType, SurvivorAbility, ENTITY_COLOR } from './entities.js';
import { Phase, Player, PHASE_ICON } from './game.js';
import { PAD_X, PAD_Y } from './renderer.js';
import {
  ActionType, getValidActions, getVisibleEnemyHexes,
  executeMove, executeExplore, executeBattle,
  executeFortify, executeSummon, executeUseItem, executeUseAbility,
} from './actions.js';

export class UIController {
  constructor(canvas, state, renderer, ai, onRedraw) {
    this.canvas   = canvas;
    this.state    = state;
    this.renderer = renderer;
    this.ai       = ai;
    this.onRedraw = onRedraw;

    this._selectedEntity = null;
    this._validActions   = [];
    this._awaitingTarget = null;
    this._pendingUnitPick = null; // { units: [...] } when multiple units on a hex

    this._bindEvents();
  }

  _bindEvents() {
    this.canvas.addEventListener('mousemove', e => this._onMouseMove(e));
    this.canvas.addEventListener('click',     e => this._onClick(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.renderer.hoveredHex = null;
      this.onRedraw();
      if (!this._selectedEntity) this._updateSidebar();
    });

    this.canvas.addEventListener('touchstart', e => {
      const t = e.touches[0];
      this._touchStart = { clientX: t.clientX, clientY: t.clientY };
    });

    this.canvas.addEventListener('touchend', e => {
      e.preventDefault();
      if (!this._touchStart) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - this._touchStart.clientX;
      const dy = t.clientY - this._touchStart.clientY;
      if (Math.sqrt(dx * dx + dy * dy) < 10) {
        this._onClick({ clientX: t.clientX, clientY: t.clientY });
      }
      this._touchStart = null;
    }, { passive: false });
  }

  _canvasPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.canvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (this.canvas.height / rect.height),
    };
  }

  _canvasToHex(x, y) {
    return this.renderer.canvasToHex(x, y);
  }

  _onMouseMove(e) {
    const { x, y } = this._canvasPos(e);
    const hex = this._canvasToHex(x, y);
    if (hex.col < 0 || hex.col >= 13 || hex.row < 0 || hex.row >= 11) {
      this.renderer.hoveredHex = null;
    } else {
      this.renderer.hoveredHex = hex;
    }
    this.onRedraw();
    // Always refresh info panel when hovering (shows hovered hex info if nothing selected)
    this._renderSelectedInfo();
  }

  _onClick(e) {
    if (this.state.gameOver) return;
    if (this.state.activePlayer === Player.WITCH && this.state.witchIsAI) return;

    const { x, y } = this._canvasPos(e);
    const hex = this._canvasToHex(x, y);
    if (hex.col < 0 || hex.col >= 13 || hex.row < 0 || hex.row >= 11) return;

    if (this._awaitingTarget) {
      this._handleTargetClick(hex);
    } else {
      this._handleSelection(hex);
    }
  }

  _handleSelection(hex) {
    const state = this.state;
    const clickedEntities = state.entities.filter(
      e => e.alive && e.col === hex.col && e.row === hex.row && e.owner === state.activePlayer
    );

    if (clickedEntities.length === 0) {
      this._clearSelection();
    } else if (clickedEntities.length === 1) {
      this._selectEntity(clickedEntities[0]);
      this._pendingUnitPick = null;
    } else {
      // Multiple units on same hex — show picker
      this._pendingUnitPick = { units: clickedEntities };
      this._selectedEntity = null;
      this._validActions   = [];
      this.renderer.selectedHex  = { col: hex.col, row: hex.row };
      this.renderer.highlightHexes = [];
    }

    this._updateSidebar();
    this.onRedraw();
  }

  _selectEntity(entity) {
    this._selectedEntity  = entity;
    this._pendingUnitPick = null;
    this.renderer.selectedHex = { col: entity.col, row: entity.row };
    this._validActions = getValidActions(this.state, entity);
    this._updateHighlights();
  }

  _clearSelection() {
    this._selectedEntity       = null;
    this._awaitingTarget       = null;
    this._validActions         = [];
    this._pendingUnitPick      = null;
    this.renderer.selectedHex  = null;
    this.renderer.highlightHexes = [];
  }

  _updateHighlights() {
    const renderer = this.renderer;
    renderer.highlightHexes = [];
    if (!this._awaitingTarget || !this._selectedEntity) return;

    const { actionType } = this._awaitingTarget;
    if (actionType === ActionType.MOVE) {
      const moveAction = this._validActions.find(a => a.type === ActionType.MOVE);
      if (moveAction) {
        renderer.highlightHexes = moveAction.targets.map(t => ({
          ...t, color: 'rgba(60,220,80,0.55)',
        }));
      }
    } else if (actionType === ActionType.BATTLE) {
      const battleAction = this._validActions.find(a => a.type === ActionType.BATTLE);
      if (battleAction) {
        renderer.highlightHexes = battleAction.targets.map(t => ({
          col: t.col, row: t.row, color: 'rgba(220,60,60,0.55)',
        }));
      }
    }
  }

  _handleTargetClick(hex) {
    if (!this._awaitingTarget) return;
    const { actionType, actor } = this._awaitingTarget;
    const state = this.state;
    let result;

    if (actionType === ActionType.MOVE) {
      result = executeMove(state, actor, hex.col, hex.row);
      if (result.success) {
        state.spendAction(result.cost);
        this._selectEntity(actor);
      }
    } else if (actionType === ActionType.BATTLE) {
      const battleAction = this._validActions.find(a => a.type === ActionType.BATTLE);
      const target = battleAction?.targets.find(t => t.col === hex.col && t.row === hex.row);
      if (target) {
        result = executeBattle(state, actor, target);
        if (result.success) state.spendAction(result.cost);
      }
    } else if (actionType === ActionType.SUMMON) {
      result = executeSummon(state, actor, hex.col, hex.row);
      if (result.success) state.spendAction(result.cost);
    }

    if (result) for (const msg of result.log) state.addLog(msg);

    this._awaitingTarget = null;
    this.renderer.highlightHexes = [];
    state.checkVictory();

    if (this._selectedEntity?.alive) this._selectEntity(this._selectedEntity);
    else this._clearSelection();

    this._updateSidebar();
    this.onRedraw();
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────

  _updateSidebar() {
    this._renderTurnInfo();
    this._renderObjectives();
    this._renderActionPanel();
    this._renderSelectedInfo();
    this._renderInventory();
    this._renderLog();
  }

  _renderTurnInfo() {
    const state = this.state;
    const el    = document.getElementById('turn-info');
    if (!el) return;

    const phase  = state.phase;
    const player = state.activePlayer === Player.HERO ? 'Hero' : 'Witch';
    const isAI   = state.activePlayer === Player.WITCH && state.witchIsAI;

    const phaseDesc = {
      [Phase.DAWN]:  'No bonuses — find shelter',
      [Phase.DAY]:   'Hero +1 ATK in combat',
      [Phase.DUSK]:  'No bonuses — seek cover',
      [Phase.NIGHT]: 'Witch +1 ATK · Unfortified heroes suffer',
    };

    // Survivor bonus info
    const survivorCount = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    ).length;
    const survivorNote = survivorCount > 0
      ? `<span style="color:#4caf7d;font-size:0.75rem"> +${survivorCount} from survivors</span>`
      : '';

    el.innerHTML = `
      <div class="phase-badge phase-${phase}">
        ${PHASE_ICON[phase]} ${phase.toUpperCase()}
      </div>
      <div class="turn-line phase-hint">${phaseDesc[phase]}</div>
      <div class="turn-line">Round ${state.round}</div>
      <div class="turn-line player-${state.activePlayer}">
        ${player}'s Turn ${isAI ? '<span class="ai-badge">AI</span>' : ''}
      </div>
      <div class="actions-remaining">
        ${'◆'.repeat(state.actionsLeft)}${'◇'.repeat(Math.max(0, 4 - state.actionsLeft))}
        ${survivorNote}
        ${state.bonusActions > 0 ? `<span class="bonus">+${state.bonusActions}</span>` : ''}
      </div>
    `;
  }

  _renderObjectives() {
    const el = document.getElementById('objectives');
    if (!el) return;
    const state = this.state;

    let html = '<div class="inv-title">⛧ Power Nodes</div>';
    for (const obj of state.witchObjectives) {
      const held = state.entities.find(
        e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row
      );
      const icon  = held ? '🔴' : '⭕';
      const style = held ? 'color:#ff6666' : 'color:#aaaaaa';
      html += `<div class="inv-row" style="${style}">${icon} ${obj.label}</div>`;
    }
    const allHeld = state.witchObjectives.every(obj =>
      state.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    );
    if (allHeld) {
      html += `<div class="inv-row" style="color:#ff4444;font-weight:bold">⚠ ALL NODES SEIZED! (wins at dawn)</div>`;
    }
    el.innerHTML = html;
  }

  _renderActionPanel() {
    const el = document.getElementById('action-panel');
    if (!el) return;

    const state  = this.state;
    const entity = this._selectedEntity;
    const hasActions = state.actionsAvailable > 0;

    // ── Unit picker (multiple units on same hex) ───────────────────────────
    if (this._pendingUnitPick) {
      let html = `<div class="action-title">Choose a unit:</div>`;
      for (const u of this._pendingUnitPick.units) {
        const color = ENTITY_COLOR[u.type] || '#888';
        html += `<button class="action-btn pick-unit" data-action="pick_unit" data-unit-id="${u.id}"
          style="border-left: 3px solid ${color}">
          ${u.displayName} — HP: ${u.hp}/${u.maxHp}
        </button>`;
      }
      html += btn('End Turn', 'end-turn', '', `data-action="end_turn"`);
      el.innerHTML = html;
      el.querySelectorAll('button[data-action]').forEach(b => {
        b.addEventListener('click', () => this._handleActionButton(b));
      });
      return;
    }

    // ── End Turn always visible ───────────────────────────────────────────
    let endTurnHtml = btn('End Turn', 'end-turn', state.gameOver ? 'disabled' : '', `data-action="end_turn"`);

    if (state.gameOver) {
      el.innerHTML = endTurnHtml;
      el.querySelectorAll('button[data-action]').forEach(b => {
        b.addEventListener('click', () => this._handleActionButton(b));
      });
      return;
    }

    const isPlayerTurn = entity && entity.owner === state.activePlayer;

    if (!entity || !isPlayerTurn) {
      el.innerHTML = (entity
        ? `<p class="hint">Not your turn.</p>`
        : `<p class="hint">Select one of your units.</p>`)
        + endTurnHtml;
      el.querySelectorAll('button[data-action]').forEach(b => {
        b.addEventListener('click', () => this._handleActionButton(b));
      });
      return;
    }

    let html = `<div class="action-title">Actions — ${entity.displayName}</div>`;
    const actions = getValidActions(state, entity);

    for (const action of actions) {
      const dis = !hasActions ? 'disabled' : '';

      switch (action.type) {
        case ActionType.MOVE:
          html += btn('Move (1)', 'move', dis, `data-action="move"`);
          break;
        case ActionType.EXPLORE:
          html += btn('Explore (1)', 'explore', dis, `data-action="explore"`);
          break;
        case ActionType.BATTLE:
          html += btn('Battle (1)', 'battle', dis, `data-action="battle"`);
          break;
        case ActionType.FORTIFY: {
          const shared    = state.inventory.shared;
          const hasMetal  = (shared.metal || 0) > 0;
          const hasDoubler = entity.type === EntityType.SURVIVOR &&
            entity.ability === SurvivorAbility.FORTIFY_DOUBLE;
          const tile = state.tiles.get(hexKey(entity.col, entity.row));
          const curLevel = tile ? tile.fortifyLevel : 0;
          const lbl = hasMetal
            ? `Reinforce (Metal, +2 DEF → ${Math.min(4, curLevel + 2)})`
            : hasDoubler
              ? `Fortify (Wood, +2 DEF ★ → ${Math.min(4, curLevel + 2)})`
              : `Fortify (Wood, +1 DEF → ${Math.min(4, curLevel + 1)})`;
          html += btn(lbl, 'fortify', dis, `data-action="fortify"`);
          break;
        }
        case ActionType.SUMMON: {
          const lbl = _summonLabel(state.inventory.witch);
          html += btn(lbl, 'summon', dis, `data-action="summon"`);
          break;
        }
        case ActionType.USE_ITEM:
          for (const item of action.usable) {
            html += btn(item.label, 'item', dis,
              `data-action="use_item" data-item="${item.item}"`);
          }
          break;
        case ActionType.EQUIP_WEAPON:
          for (const w of action.weapons) {
            html += btn(`Equip ${w.label}`, 'item', dis,
              `data-action="use_item" data-item="${w.key}"`);
          }
          break;
        case ActionType.USE_ABILITY: {
          const abilityLabels = {
            [SurvivorAbility.HEAL]:    'Tend Wounds — heal hero 1 HP (1 action)',
            [SurvivorAbility.INSPIRE]: 'Battle Cry — hero +1 ATK (free)',
            [SurvivorAbility.RALLY]:   'Holy Sermon — hero +1 action (free)',
          };
          const lbl = abilityLabels[action.ability] || 'Use Ability';
          const costDis = action.ability === SurvivorAbility.HEAL && !hasActions ? 'disabled' : '';
          html += btn(lbl, 'item ability', costDis, `data-action="use_ability"`);
          break;
        }
      }
    }

    html += endTurnHtml;
    el.innerHTML = html;

    el.querySelectorAll('button[data-action]').forEach(b => {
      b.addEventListener('click', () => this._handleActionButton(b));
    });
  }

  _handleActionButton(button) {
    const action = button.dataset.action;
    const state  = this.state;
    const entity = this._selectedEntity;

    if (action === 'end_turn') {
      this._clearSelection();
      state.endTurn();
      this._updateSidebar();
      this.onRedraw();
      if (state.activePlayer === Player.WITCH && state.witchIsAI && !state.gameOver) {
        setTimeout(() => this._runAI(), 400);
      }
      return;
    }

    if (action === 'pick_unit') {
      const unitId = button.dataset.unitId;
      const unit = state.entities.find(e => e.id === unitId);
      if (unit) this._selectEntity(unit);
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    if (!entity || entity.owner !== state.activePlayer) return;

    switch (action) {
      case 'move':
        this._awaitingTarget = { actionType: ActionType.MOVE, actor: entity };
        this._updateHighlights();
        state.addLog('Click a highlighted hex to move.');
        break;

      case 'explore': {
        const result = executeExplore(state, entity);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);
        if (this._selectedEntity?.alive) this._selectEntity(this._selectedEntity);
        else this._clearSelection();
        break;
      }

      case 'battle':
        this._awaitingTarget = { actionType: ActionType.BATTLE, actor: entity };
        this._updateHighlights();
        state.addLog('Click an enemy to attack.');
        break;

      case 'fortify': {
        const result = executeFortify(state, entity);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);
        break;
      }

      case 'summon': {
        this._awaitingTarget = { actionType: ActionType.SUMMON, actor: entity };
        const summonAction = this._validActions.find(a => a.type === ActionType.SUMMON);
        if (summonAction) {
          this.renderer.highlightHexes = summonAction.targets.map(t => ({
            ...t, color: 'rgba(180,80,200,0.30)',
          }));
        }
        state.addLog('Click an adjacent empty hex to raise a unit.');
        break;
      }

      case 'use_item': {
        const item = button.dataset.item;
        const result = executeUseItem(state, entity, item);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);
        if (this._selectedEntity?.alive) this._selectEntity(this._selectedEntity);
        else this._clearSelection();
        break;
      }

      case 'use_ability': {
        const result = executeUseAbility(state, entity);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);
        break;
      }
    }

    state.checkVictory();
    this._updateSidebar();
    this.onRedraw();
  }

  async _runAI() {
    await this.ai.takeTurn();
    this._updateSidebar();
    this.onRedraw();
  }

  _renderSelectedInfo() {
    const el = document.getElementById('selected-info');
    if (!el) return;

    const entity = this._selectedEntity;

    if (!entity) {
      const h = this.renderer.hoveredHex;
      if (h) {
        const tile  = this.state.tiles.get(hexKey(h.col, h.row));
        const state = this.state;
        if (tile) {
          const obj = state.witchObjectives.find(o => o.col === h.col && o.row === h.row);
          let info = `<div class="tile-type">${tile.type}`;
          if (tile.building) info += ` — ${BUILDING_LABEL[tile.building]}`;
          info += `</div>`;
          if (obj) info += `<div style="color:#cc88ff">⛧ Power Node: ${obj.label}</div>`;
          if (tile.explored && tile.fortifyLevel) {
            const fl = tile.fortifyLevel >= 3
              ? `⚙⚙ Heavily Reinforced (+${tile.fortifyLevel} DEF)`
              : tile.fortifyLevel >= 2
                ? `⚙ Metal Reinforced (+${tile.fortifyLevel} DEF)`
                : `🪵 Fortified (+${tile.fortifyLevel} DEF)`;
            info += `<div class="fortified">${fl}</div>`;
          }
          if (!tile.explored) info += `<div class="unexplored">Unexplored</div>`;

          // Show visible units on hovered hex
          const visible = _visibleUnitsAt(state, h.col, h.row);
          if (visible.length) {
            info += `<div style="margin-top:0.3rem;font-size:0.8rem;color:#ccc">Units here:</div>`;
            for (const u of visible) {
              const col = ENTITY_COLOR[u.type] || '#888';
              info += `<div style="color:${col};font-size:0.78rem">
                ${u.displayName} — HP ${u.hp}/${u.maxHp}
              </div>`;
            }
          }

          el.innerHTML = info;
          return;
        }
      }
      el.innerHTML = '';
      return;
    }

    const weaponLine = entity.weapon
      ? `<div class="entity-weapon">🗡 ${WEAPON_LABEL[entity.weapon] || entity.weapon}</div>`
      : '';

    // Personal backpack
    const myItems = entity.items || {};
    const itemEntries = Object.entries(myItems).filter(([, v]) => v > 0);
    let packLine = '';
    if (itemEntries.length) {
      const itemStr = itemEntries.map(([k, v]) => {
        if (k.startsWith('weapon:')) return `${WEAPON_LABEL[k.replace('weapon:', '')] || k}×${v}`;
        return `${RESOURCE_LABEL[k] || k}×${v}`;
      }).join(', ');
      packLine = `<div class="entity-weapon" style="color:#88eeff">🎒 ${itemStr}</div>`;
    }

    let survivorBlock = '';
    if (entity.type === EntityType.SURVIVOR && entity.name) {
      survivorBlock = `
        <div class="survivor-name">${entity.name}</div>
        <div class="survivor-title">${entity.title}</div>
        <div class="survivor-bio">${entity.bio}</div>
        ${entity.abilityLabel
          ? `<div class="survivor-ability">★ ${entity.abilityLabel}</div>`
          : ''}
      `;
    }

    el.innerHTML = `
      <div class="entity-name" style="color:${ENTITY_COLOR[entity.type]}">
        ${entity.displayName}
      </div>
      ${survivorBlock}
      <div class="entity-stats">
        HP: ${'♥'.repeat(entity.hp)}${'♡'.repeat(entity.maxHp - entity.hp)} (${entity.hp}/${entity.maxHp})<br>
        ATK: ${entity.attack}${entity.attackBonus ? ` +${entity.attackBonus}` : ''}
        DEF: ${entity.defense}${entity.defenseBonus ? ` +${entity.defenseBonus}` : ''}
      </div>
      ${weaponLine}
      ${packLine}
      <div class="entity-pos">Position: (${entity.col}, ${entity.row})</div>
    `;
  }

  _renderInventory() {
    const el = document.getElementById('inventory');
    if (!el) return;

    const inv = this.state.inventory;
    let html = '<div class="inv-title">Shared Supplies</div>';

    const sharedItems = Object.entries(inv.shared).filter(([, v]) => v > 0);
    html += '<div class="inv-row">';
    html += sharedItems.length
      ? sharedItems.map(([k, v]) => `${RESOURCE_LABEL[k] || k}×${v}`).join(', ')
      : '<span style="color:#4a4060">none</span>';
    html += '</div>';

    html += '<div class="inv-title" style="margin-top:0.4rem">Witch Stores</div>';
    const witchItems = Object.entries(inv.witch).filter(([, v]) => v > 0);
    html += '<div class="inv-row">';
    html += witchItems.length
      ? witchItems.map(([k, v]) => `${RESOURCE_LABEL[k] || k}×${v}`).join(', ')
      : '<span style="color:#4a4060">none</span>';
    html += '</div>';

    el.innerHTML = html;
  }

  _renderLog() {
    const el = document.getElementById('event-log');
    if (!el) return;
    const recent = this.state.log.slice(-12);
    el.innerHTML = recent.map(m => `<div class="log-entry">${m}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  refresh() {
    this._updateSidebar();
    this.onRedraw();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function btn(label, cls, disabled = '', extra = '') {
  return `<button class="action-btn ${cls}" ${disabled} ${extra}>${label}</button>`;
}

function _summonLabel(witchInv) {
  if ((witchInv.metal || 0) > 0) return 'Raise Iron Golem (1 Metal)';
  if ((witchInv.wood  || 0) > 0) return 'Raise Wood Golem (1 Wood)';
  const res = Object.keys(witchInv).find(k => witchInv[k] > 0);
  return res ? `Summon Minion (1 ${res})` : 'Summon Minion';
}

// Returns units at a hex that are currently visible (respects fog of war)
function _visibleUnitsAt(state, col, row) {
  if (!state.fogOfWar) {
    return state.entities.filter(e => e.alive && e.col === col && e.row === row);
  }
  const revealed = getVisibleEnemyHexes(state);
  return state.entities.filter(e => {
    if (!e.alive || e.col !== col || e.row !== row) return false;
    if (e.owner === 'witch') return revealed.has(hexKey(col, row));
    return true;
  });
}
