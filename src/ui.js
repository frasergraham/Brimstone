// UI controller: handles canvas clicks, sidepanel updates, action buttons
import { hexKey, hexToPixel } from './hex.js';
import { TileType, BUILDING_LABEL, RESOURCE_LABEL, WEAPON_LABEL, ResourceType } from './tiles.js';
import { EntityType, SurvivorAbility, ENTITY_COLOR } from './entities.js';
import { Phase, Player, PHASE_ICON } from './game.js';
import { PAD_X, PAD_Y } from './renderer.js';
import {
  ActionType, getValidActions, getVisibleEnemyHexes,
  executeMove, executeExplore, executeBattle,
  executeFortify, executeSummon, executeUseItem, executeUseAbility,
} from './actions.js';

export class UIController {
  constructor(canvas, state, renderer, witchAI, onRedraw, heroAI = null) {
    this.canvas   = canvas;
    this.state    = state;
    this.renderer = renderer;
    this.ai       = witchAI;
    this.heroAI   = heroAI;
    this.onRedraw = onRedraw;

    this._selectedEntity  = null;
    this._validActions    = [];
    this._awaitingTarget  = null;
    this._pendingUnitPick = null;
    this._popupVisible    = false;   // tracks whether the action popup is shown

    this._touchStart  = null;
    this._pinchDist   = null;
    this._isDragging  = false;
    this._mouseDown   = null;
    this._didDragPan  = false;

    this._bindEvents();
  }

  _bindEvents() {
    this.canvas.addEventListener('mousemove', e => this._onMouseMove(e));
    this.canvas.addEventListener('click',     e => this._onClick(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.renderer.hoveredHex = null;
      this._mouseDown = null;
      this._didDragPan = false;
      this.onRedraw();
      if (!this._selectedEntity) this._updateSidebar();
    });

    // Scroll-to-zoom (desktop)
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const { x, y } = this._canvasPos(e);
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.renderer.setZoom(this.renderer.zoomLevel * delta, x, y);
      this.onRedraw();
    }, { passive: false });

    // Mouse drag-to-pan (desktop)
    this.canvas.addEventListener('mousedown', e => {
      this._mouseDown  = { clientX: e.clientX, clientY: e.clientY };
      this._didDragPan = false;
    });
    this.canvas.addEventListener('mouseup', () => {
      this._mouseDown = null;
    });

    // Touch: tap, drag-to-pan, pinch-to-zoom (mobile)
    this.canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        this._pinchDist  = _touchDist(e.touches[0], e.touches[1]);
        this._touchStart = null;
        this._isDragging = false;
        e.preventDefault();
      } else {
        const t = e.touches[0];
        this._touchStart = { clientX: t.clientX, clientY: t.clientY, lastX: t.clientX, lastY: t.clientY };
        this._pinchDist  = null;
        this._isDragging = false;
      }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 2 && this._pinchDist !== null) {
        const newDist = _touchDist(e.touches[0], e.touches[1]);
        const midCX  = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midCY  = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const { x, y } = this._canvasPos({ clientX: midCX, clientY: midCY });
        this.renderer.setZoom(this.renderer.zoomLevel * (newDist / this._pinchDist), x, y);
        this._pinchDist = newDist;
        this.onRedraw();
      } else if (e.touches.length === 1 && this._touchStart) {
        const t  = e.touches[0];
        const dx = t.clientX - this._touchStart.lastX;
        const dy = t.clientY - this._touchStart.lastY;
        const total = Math.hypot(
          t.clientX - this._touchStart.clientX,
          t.clientY - this._touchStart.clientY
        );
        if (total > 10) this._isDragging = true;
        if (this._isDragging) {
          this.renderer._panX += dx;
          this.renderer._panY += dy;
          this.renderer._clampPan();
          this._touchStart.lastX = t.clientX;
          this._touchStart.lastY = t.clientY;
          this.onRedraw();
        }
      }
    }, { passive: false });

    this.canvas.addEventListener('touchend', e => {
      e.preventDefault();
      if (this._touchStart && !this._isDragging) {
        const t = e.changedTouches[0];
        this._onClick({ clientX: t.clientX, clientY: t.clientY });
      }
      this._touchStart = null;
      this._pinchDist  = null;
      this._isDragging = false;
    }, { passive: false });
  }

  _canvasPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.canvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (this.canvas.height / rect.height),
    };
  }

  _canvasToHex(x, y) { return this.renderer.canvasToHex(x, y); }

  _onMouseMove(e) {
    // Drag-to-pan when mouse button held
    if (this._mouseDown) {
      const dx = e.clientX - this._mouseDown.clientX;
      const dy = e.clientY - this._mouseDown.clientY;
      if (Math.hypot(dx, dy) > 5) {
        this._didDragPan = true;
        const rect   = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width  / rect.width;
        const scaleY = this.canvas.height / rect.height;
        this.renderer._panX += dx * scaleX;
        this.renderer._panY += dy * scaleY;
        this.renderer._clampPan();
        this._mouseDown = { clientX: e.clientX, clientY: e.clientY };
        this.onRedraw();
        return;
      }
    }

    const { x, y } = this._canvasPos(e);
    const hex = this._canvasToHex(x, y);
    this.renderer.hoveredHex = (hex.col >= 0 && hex.col < 13 && hex.row >= 0 && hex.row < 11)
      ? hex : null;
    this.onRedraw();
    this._renderSelectedInfo();
  }

  _onClick(e) {
    if (this._didDragPan) { this._didDragPan = false; return; }
    if (this.state.gameOver) return;
    if (this.state.activePlayer === Player.WITCH && this.state.witchIsAI) return;
    if (this.state.activePlayer === Player.HERO  && this.state.heroIsAI)  return;

    const { x, y } = this._canvasPos(e);
    const hex = this._canvasToHex(x, y);
    if (hex.col < 0 || hex.col >= 13 || hex.row < 0 || hex.row >= 11) return;

    // Tapping the selected unit's hex always toggles the action popup — this
    // check happens before the _awaitingTarget routing so it works whether the
    // default-MOVE awaiting is set or not, and regardless of how many units
    // share that hex.
    if (
      this._selectedEntity &&
      hex.col === this._selectedEntity.col &&
      hex.row === this._selectedEntity.row
    ) {
      if (this._popupVisible) {
        this._popupVisible = false;
        _hideActionPopup();
        // Restore move highlights after dismissing popup
        this._updateHighlights();
      } else {
        this._showActionPopup(this._selectedEntity);
        this._popupVisible = true;
      }
      this._updateSidebar();
      this.onRedraw();
      return;
    }

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
      // Tapping empty space while popup is open: close popup first, then deselect
      if (this._popupVisible) {
        this._popupVisible = false;
        _hideActionPopup();
        if (this._awaitingTarget?.isDefault) {
          // re-arm default move awaiting after closing popup
          this._updateHighlights();
        }
      } else {
        this._clearSelection();
      }
    } else if (clickedEntities.length === 1) {
      const entity = clickedEntities[0];
      if (entity === this._selectedEntity) {
        // Second tap → show popup; third tap → dismiss popup
        if (this._popupVisible) {
          this._popupVisible = false;
          _hideActionPopup();
        } else {
          this._showActionPopup(entity);
          this._popupVisible = true;
        }
      } else {
        // New unit — just select (no popup yet)
        this._selectEntity(entity);
        this._pendingUnitPick = null;
      }
    } else {
      // Multiple units on this hex — always show the picker to choose which unit.
      // (If the user tapped the already-selected unit, _onClick handles it before
      // we ever reach _handleSelection, so no extra check needed here.)
      this._pendingUnitPick = { units: clickedEntities };
      this._selectedEntity  = null;
      this._popupVisible    = true;
      this._validActions    = [];
      this.renderer.selectedHex    = { col: hex.col, row: hex.row };
      this.renderer.highlightHexes = [];
      this._showActionPopup(null);
    }

    this._updateSidebar();
    this.onRedraw();
  }

  _selectEntity(entity) {
    this._selectedEntity  = entity;
    this._pendingUnitPick = null;
    this._popupVisible    = false;
    _hideActionPopup();
    this.renderer.selectedHex = { col: entity.col, row: entity.row };
    this._validActions = getValidActions(this.state, entity);
    // Move is always the default awaiting action — clicking a green hex moves.
    const hasMoveAction = this._validActions.some(a => a.type === ActionType.MOVE);
    if (hasMoveAction && this.state.actionsAvailable > 0) {
      this._awaitingTarget = { actionType: ActionType.MOVE, actor: entity, isDefault: true };
    } else {
      this._awaitingTarget = null;
    }
    this._updateHighlights();
    // Popup is NOT shown here — user taps the unit a second time to open it
  }

  _clearSelection() {
    this._selectedEntity       = null;
    this._awaitingTarget       = null;
    this._validActions         = [];
    this._pendingUnitPick      = null;
    this._popupVisible         = false;
    this.renderer.selectedHex  = null;
    this.renderer.highlightHexes = [];
    _hideActionPopup();
  }

  _updateHighlights() {
    const renderer = this.renderer;
    renderer.highlightHexes = [];
    if (!this._selectedEntity) return;

    const { actionType } = this._awaitingTarget || {};
    if (!actionType || actionType === ActionType.MOVE) {
      const a = this._validActions.find(a => a.type === ActionType.MOVE);
      if (a) renderer.highlightHexes = a.targets.map(t => ({ ...t, color: 'rgba(60,220,80,0.55)' }));
    } else if (actionType === ActionType.BATTLE) {
      const a = this._validActions.find(a => a.type === ActionType.BATTLE);
      if (a) renderer.highlightHexes = a.targets.map(t => ({ col: t.col, row: t.row, color: 'rgba(220,60,60,0.55)' }));
    }
  }

  _handleTargetClick(hex) {
    if (!this._awaitingTarget) return;
    const { actionType, actor } = this._awaitingTarget;
    const state = this.state;

    if (actionType === ActionType.MOVE) {
      const moveAction = this._validActions.find(a => a.type === ActionType.MOVE);
      const isValidTarget = moveAction && moveAction.targets.some(t => t.col === hex.col && t.row === hex.row);
      if (!isValidTarget) {
        // Not a highlighted move hex — try re-selecting whatever is there
        this._handleSelection(hex);
        return;
      }
      const result = executeMove(state, actor, hex.col, hex.row);
      for (const msg of result.log) state.addLog(msg);
      if (result.success) state.spendAction(result.cost);
      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];
      state.checkVictory();
      if (actor.alive) { this._selectEntity(actor); }
      else this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
      if (result.encounterLog?.length) {
        this._showResultDialog(result.encounterLog, () => {
          this._updateSidebar();
          this.onRedraw();
          this._maybeShowNoActionsDialog();
        });
      } else {
        this._maybeShowNoActionsDialog();
      }

    } else if (actionType === ActionType.BATTLE) {
      const battleAction = this._validActions.find(a => a.type === ActionType.BATTLE);
      // All valid targets on the clicked hex
      const targetsAtHex = battleAction?.targets.filter(t => t.col === hex.col && t.row === hex.row) || [];
      if (!targetsAtHex.length) return;

      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];

      const executeFight = (target) => {
        const afterBattle = () => {
          state.checkVictory();
          if (actor.alive) { this._selectEntity(actor); }
          else this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
          this._maybeShowNoActionsDialog();
        };

        const doRematch = () => {
          if (!actor.alive || !target.alive || state.actionsAvailable === 0) {
            afterBattle();
            return;
          }
          const snap1 = _snapEntity(actor);
          const snap2 = _snapEntity(target);
          const r2 = executeBattle(state, actor, target);
          for (const msg of r2.log) state.addLog(msg);
          if (r2.success) state.spendAction(r2.cost);
          const canRematchAgain = !r2.killed && actor.alive && target.alive;
          this._showBattleDialog(snap1, snap2, r2, afterBattle, canRematchAgain ? doRematch : null);
        };

        const actorSnap  = _snapEntity(actor);
        const targetSnap = _snapEntity(target);
        const result = executeBattle(state, actor, target);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);

        const canRematch = !result.killed && actor.alive && target.alive;
        this._showBattleDialog(actorSnap, targetSnap, result, afterBattle, canRematch ? doRematch : null);
      };

      // If multiple defenders on the hex, show a picker dialog
      if (targetsAtHex.length > 1) {
        this._showDefenderPickerDialog(targetsAtHex, executeFight);
      } else {
        executeFight(targetsAtHex[0]);
      }

    } else if (actionType === ActionType.SUMMON) {
      const result = executeSummon(state, actor, hex.col, hex.row);
      for (const msg of result.log) state.addLog(msg);
      if (result.success) state.spendAction(result.cost);
      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];
      state.checkVictory();
      if (actor.alive) { this._selectEntity(actor); }
      else this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
      this._maybeShowNoActionsDialog();
    }
  }

  // ── Action popup (canvas overlay) ────────────────────────────────────────

  _showActionPopup(entity) {
    const state = this.state;
    const popup = document.getElementById('action-popup');

    // Unit picker mode
    if (this._pendingUnitPick) {
      let html = `<div class="popup-unit-name">Choose a unit:</div>`;
      for (const u of this._pendingUnitPick.units) {
        const col = ENTITY_COLOR[u.type] || '#888';
        html += `<button class="action-btn pick-unit" data-action="pick_unit" data-unit-id="${u.id}"
          style="border-left:3px solid ${col}">${u.displayName} — HP ${u.hp}/${u.maxHp}</button>`;
      }
      popup.innerHTML = html;
      _attachPopupListeners(popup, this);
      _positionPopup(popup, this);
      popup.style.display = 'block';
      return;
    }

    if (!entity || entity.owner !== state.activePlayer || state.gameOver) {
      _hideActionPopup();
      return;
    }

    const actions = getValidActions(state, entity);
    const hasAct  = state.actionsAvailable > 0;

    let regularHtml = '';
    let freeHtml    = '';

    for (const action of actions) {
      const dis = !hasAct ? 'disabled' : '';
      switch (action.type) {
        case ActionType.MOVE:
          // Move is the default click action — no button needed
          break;
        case ActionType.EXPLORE:
          regularHtml += btn('🔍 Explore', 'explore', dis, `data-action="explore"`);
          break;
        case ActionType.BATTLE:
          regularHtml += btn('⚔ Attack', 'battle', dis, `data-action="battle"`);
          break;
        case ActionType.FORTIFY: {
          const shared     = state.inventory.shared;
          const hasMetal   = (shared.metal || 0) > 0;
          const hasDoubler = entity.type === EntityType.SURVIVOR && entity.ability === SurvivorAbility.FORTIFY_DOUBLE;
          const tileData   = state.tiles.get(hexKey(entity.col, entity.row));
          const cur        = tileData ? tileData.fortifyLevel : 0;
          const lbl = hasMetal
            ? `⚙ Reinforce +${Math.min(4, cur + 2)} DEF`
            : hasDoubler
              ? `🪵 Fortify +${Math.min(4, cur + 2)} DEF ★`
              : `🪵 Fortify +${Math.min(4, cur + 1)} DEF`;
          regularHtml += btn(lbl, 'fortify', dis, `data-action="fortify"`);
          break;
        }
        case ActionType.SUMMON:
          regularHtml += btn(_summonLabel(state.inventory.witch), 'summon', dis, `data-action="summon"`);
          break;
        case ActionType.USE_ITEM:
          for (const item of action.usable) {
            regularHtml += btn(item.label, 'item', dis, `data-action="use_item" data-item="${item.item}"`);
          }
          break;
        case ActionType.EQUIP_WEAPON:
          for (const w of action.weapons) {
            regularHtml += btn(`⚔ Equip ${w.label}`, 'item', dis, `data-action="use_item" data-item="${w.key}"`);
          }
          break;
        case ActionType.USE_ABILITY: {
          const abilityLabels = {
            [SurvivorAbility.HEAL]:    '❤ Tend Wounds',
            [SurvivorAbility.INSPIRE]: '✦ Battle Cry',
            [SurvivorAbility.RALLY]:   '✦ Holy Sermon',
          };
          const lbl    = abilityLabels[action.ability] || 'Use Ability';
          const isFree = action.ability !== SurvivorAbility.HEAL;
          if (isFree) {
            freeHtml += btn(lbl, 'item ability free', '', `data-action="use_ability"`);
          } else {
            regularHtml += btn(lbl, 'item ability', !hasAct ? 'disabled' : '', `data-action="use_ability"`);
          }
          break;
        }
      }
    }

    let html = regularHtml;
    if (freeHtml) {
      html += `<div class="popup-section-label">Free</div>`;
      html += freeHtml;
    }
    // Show a no-op message if there's genuinely nothing to do
    if (!html) html = `<div class="popup-unit-name">No actions available</div>`;

    popup.innerHTML = html;
    _attachPopupListeners(popup, this);
    _positionPopup(popup, this);
    popup.style.display = 'block';
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
    const isAI   = (state.activePlayer === Player.WITCH && state.witchIsAI) ||
                   (state.activePlayer === Player.HERO  && state.heroIsAI);

    const phaseDesc = {
      [Phase.DAWN]:  'No bonuses — transition phase',
      [Phase.DAY]:   'Hero +1 ATK · Witch minions in the open suffer',
      [Phase.DUSK]:  'No bonuses — seek cover',
      [Phase.NIGHT]: 'Witch +1 ATK · Survivors in the open suffer',
    };

    const diamonds = state.actionsLeft > 0
      ? '◆'.repeat(state.actionsLeft)
      : '◇';

    el.innerHTML = `
      <div class="phase-badge phase-${phase}">${PHASE_ICON[phase]} ${phase.toUpperCase()}</div>
      <div class="turn-line phase-hint">${phaseDesc[phase]}</div>
      <div class="turn-line">Round ${state.round}</div>
      <div class="turn-line player-${state.activePlayer}">
        ${player}'s Turn ${isAI ? '<span class="ai-badge">AI</span>' : ''}
      </div>
      <div class="actions-remaining">${diamonds}</div>
    `;
  }

  _renderObjectives() {
    const el = document.getElementById('objectives');
    if (!el) return;
    const state = this.state;

    let html = '<div class="inv-title">⚔ Power Nodes</div>';
    let witchCount = 0, heroCount = 0;
    for (const obj of state.witchObjectives) {
      const witchHere = state.entities.find(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row);
      const heroHere  = state.entities.find(e => e.alive && e.owner === 'hero'  && e.col === obj.col && e.row === obj.row);
      let icon, style;
      if (witchHere)      { icon = '🔴'; style = 'color:#ff6666'; witchCount++; }
      else if (heroHere)  { icon = '🔵'; style = 'color:#66aaff'; heroCount++; }
      else                { icon = '⭕'; style = 'color:#aaaaaa'; }
      html += `<div class="inv-row" style="${style}">${icon} ${obj.label}</div>`;
    }
    if (witchCount === 3) html += `<div class="inv-row" style="color:#ff4444;font-weight:bold">⚠ Witch holds all! (wins at dawn)</div>`;
    if (heroCount  === 3) html += `<div class="inv-row" style="color:#66aaff;font-weight:bold">★ Hero holds all! (wins at dawn)</div>`;
    el.innerHTML = html;
  }

  _renderActionPanel() {
    const el = document.getElementById('action-panel');
    if (!el) return;

    const state = this.state;
    const isAI  = (state.activePlayer === Player.WITCH && state.witchIsAI) ||
                  (state.activePlayer === Player.HERO  && state.heroIsAI);

    if (isAI) {
      el.innerHTML = `<p class="hint" style="opacity:0.7">AI is thinking…</p>`;
      return;
    }

    const noActs   = state.actionsAvailable === 0;
    const endClass = noActs ? 'end-turn urgent' : 'end-turn';
    const endLabel = noActs ? 'End Turn ◀' : 'End Turn';

    let hint = '';
    if (this._awaitingTarget && !this._awaitingTarget.isDefault) {
      const labels = {
        [ActionType.BATTLE]: 'Click an enemy to attack.',
        [ActionType.SUMMON]: 'Click an adjacent empty hex.',
      };
      hint = `<p class="hint" style="margin-bottom:0.4rem">${labels[this._awaitingTarget.actionType] || ''}</p>
        ${btn('✕ Cancel', 'end-turn', '', `data-action="cancel"`)}`;
    } else if (this._selectedEntity) {
      hint = `<p class="hint">Green hex to move · tap unit again for actions.</p>`;
    } else {
      hint = `<p class="hint">Tap a unit to select.</p>`;
    }

    el.innerHTML = hint + btn(endLabel, endClass, state.gameOver ? 'disabled' : '', `data-action="end_turn"`);
    el.querySelectorAll('button[data-action]').forEach(b => b.addEventListener('click', () => this._handleActionButton(b)));
  }

  _handleActionButton(button) {
    const action = button.dataset.action;
    const state  = this.state;
    const entity = this._selectedEntity;

    if (action === 'end_turn') {
      this._clearSelection();
      state.endTurn();
      this._triggerHazardFlashes();
      this._updateSidebar();
      this.onRedraw();
      this._maybeRunAI();
      return;
    }

    if (action === 'cancel') {
      if (entity) {
        // Reselect to restore the default move-target state
        this._selectEntity(entity);
      } else {
        this._awaitingTarget = null;
        this.renderer.highlightHexes = [];
      }
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    if (action === 'pick_unit') {
      const unit = state.entities.find(e => e.id === button.dataset.unitId);
      if (unit) this._selectEntity(unit);
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    if (!entity || entity.owner !== state.activePlayer) return;

    // Any action button click closes the popup
    this._popupVisible = false;

    switch (action) {
      case 'explore': {
        _hideActionPopup();
        const result = executeExplore(state, entity);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);
        this._showResultDialog(result.log, () => {
          state.checkVictory();
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
          this._maybeShowNoActionsDialog();
        });
        break;
      }

      case 'battle':
        _hideActionPopup();
        this._awaitingTarget = { actionType: ActionType.BATTLE, actor: entity };
        this._updateHighlights();
        state.addLog('Click an enemy to attack.');
        this._updateSidebar();
        this.onRedraw();
        break;

      case 'fortify': {
        _hideActionPopup();
        const result = executeFortify(state, entity);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);
        this._showResultDialog(result.log, () => {
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
          this._maybeShowNoActionsDialog();
        });
        break;
      }

      case 'summon': {
        _hideActionPopup();
        this._awaitingTarget = { actionType: ActionType.SUMMON, actor: entity };
        const summonAction = this._validActions.find(a => a.type === ActionType.SUMMON);
        if (summonAction) {
          this.renderer.highlightHexes = summonAction.targets.map(t => ({ ...t, color: 'rgba(180,80,200,0.30)' }));
        }
        state.addLog('Click an adjacent empty hex to raise a unit.');
        this._updateSidebar();
        this.onRedraw();
        break;
      }

      case 'use_item': {
        _hideActionPopup();
        const item   = button.dataset.item;
        const result = executeUseItem(state, entity, item);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);
        this._showResultDialog(result.log, () => {
          state.checkVictory();
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
          this._maybeShowNoActionsDialog();
        });
        break;
      }

      case 'use_ability': {
        _hideActionPopup();
        const result = executeUseAbility(state, entity);
        for (const msg of result.log) state.addLog(msg);
        if (result.success) state.spendAction(result.cost);
        this._showResultDialog(result.log, () => {
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
          this._maybeShowNoActionsDialog();
        });
        break;
      }
    }
  }

  // ── Hazard flash animations ───────────────────────────────────────────────

  _triggerHazardFlashes() {
    const state = this.state;
    const nightPositions = state.lastNightDamage || [];
    const dayPositions   = state.lastDayDamage   || [];
    const hazardLog      = state.lastHazardLog    || [];

    if (!nightPositions.length && !dayPositions.length) return;

    for (const pos of nightPositions) {
      this.renderer.addFlash(pos.col, pos.row, '-1', 'rgba(80,0,160,0.8)', 2000);
    }
    for (const pos of dayPositions) {
      this.renderer.addFlash(pos.col, pos.row, '-1', 'rgba(255,180,0,0.8)', 2000);
    }

    // Animate flashes while showing the dialog
    const endTime = Date.now() + 2200;
    const loop = () => {
      this.onRedraw();
      if (Date.now() < endTime) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    // Show a dialog summarising what happened
    if (hazardLog.length) {
      const isNight = nightPositions.length > 0;
      const header  = isNight
        ? '🌙 Night falls — unprotected survivors suffer!'
        : '☀ Dawn breaks — witch minions caught in the open suffer!';
      this._showResultDialog([header, ...hazardLog], () => {
        this._updateSidebar();
        this.onRedraw();
      });
    }
  }

  // ── Dialogs ───────────────────────────────────────────────────────────────

  _showResultDialog(messages, onDismiss) {
    const dialog = document.getElementById('result-dialog');
    document.getElementById('result-messages').textContent = messages.join('\n');
    document.getElementById('result-dismiss-hint').style.display = '';
    const btns = document.getElementById('result-buttons');
    btns.style.display = 'none';
    btns.innerHTML = '';
    dialog.style.display = 'flex';

    const dismiss = () => {
      dialog.style.display = 'none';
      dialog.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', keyDismiss);
      if (onDismiss) onDismiss();
    };
    const keyDismiss = e => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') dismiss();
    };
    dialog.addEventListener('click', dismiss);
    document.addEventListener('keydown', keyDismiss);
  }

  _maybeShowNoActionsDialog() {
    const state = this.state;
    if (state.gameOver) return;
    if (state.actionsAvailable > 0) return;
    // Only show for human-controlled players
    const isHumanTurn =
      (state.activePlayer === Player.WITCH && !state.witchIsAI) ||
      (state.activePlayer === Player.HERO  && !state.heroIsAI);
    if (!isHumanTurn) return;
    this._showNoActionsDialog();
  }

  _showNoActionsDialog() {
    const state  = this.state;
    const dialog = document.getElementById('result-dialog');
    const hint   = document.getElementById('result-dismiss-hint');
    const btns   = document.getElementById('result-buttons');

    document.getElementById('result-messages').textContent = 'No more actions!';
    hint.style.display = 'none';
    btns.style.display = 'flex';
    btns.innerHTML = '';

    const food = (state.inventory.shared[ResourceType.FOOD] || 0);
    if (state.activePlayer === Player.HERO && food > 0) {
      const eatBtn = document.createElement('button');
      eatBtn.textContent = `🍞 Eat Food (+1 action)  [${food} left]`;
      eatBtn.addEventListener('click', e => {
        e.stopPropagation();
        const result = executeUseItem(state, state.hero, ResourceType.FOOD);
        for (const msg of result.log) state.addLog(msg);
        dialog.style.display = 'none';
        hint.style.display = '';
        btns.style.display = 'none';
        btns.innerHTML = '';
        this._updateSidebar();
        this.onRedraw();
        // Don't chain another no-actions dialog here; player now has actions
      });
      btns.appendChild(eatBtn);
    }

    const endBtn = document.createElement('button');
    endBtn.textContent = 'End Turn ◀';
    endBtn.className = 'btn-end-turn';
    endBtn.addEventListener('click', e => {
      e.stopPropagation();
      dialog.style.display = 'none';
      hint.style.display = '';
      btns.style.display = 'none';
      btns.innerHTML = '';
      this._clearSelection();
      state.endTurn();
      this._triggerHazardFlashes();
      this._updateSidebar();
      this.onRedraw();
      this._maybeRunAI();
    });
    btns.appendChild(endBtn);

    dialog.style.display = 'flex';
    // No click-to-dismiss on the backdrop for this dialog
  }

  _showDefenderPickerDialog(defenders, onPick) {
    const dialog = document.getElementById('result-dialog');
    const hint   = document.getElementById('result-dismiss-hint');
    const btns   = document.getElementById('result-buttons');

    document.getElementById('result-messages').textContent = 'Multiple enemies here — choose your target:';
    hint.style.display = 'none';
    btns.style.display = 'flex';
    btns.innerHTML = '';

    for (const def of defenders) {
      const btn = document.createElement('button');
      const col  = ENTITY_COLOR[def.type] || '#888';
      btn.style.borderLeft = `3px solid ${col}`;
      btn.textContent = `${def.displayName}  HP ${def.hp}/${def.maxHp}`;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        dialog.style.display = 'none';
        hint.style.display = '';
        btns.style.display = 'none';
        btns.innerHTML = '';
        onPick(def);
      });
      btns.appendChild(btn);
    }

    dialog.style.display = 'flex';
  }

  _showBattleDialog(actorSnap, targetSnap, result, onDismiss, onRematch = null) {
    const dialog = document.getElementById('battle-dialog');
    const footer = document.getElementById('battle-footer');

    // Populate combatant panels
    document.getElementById('battle-attacker').innerHTML = _combatantHTML(actorSnap, 'atk');
    document.getElementById('battle-defender').innerHTML = _combatantHTML(targetSnap, 'def');

    // Reset dice and footer
    const atkDie = document.getElementById('battle-atk-die');
    const defDie = document.getElementById('battle-def-die');
    const outcome = document.getElementById('battle-outcome');
    atkDie.textContent = '?';
    defDie.textContent = '?';
    atkDie.className   = 'die-display rolling';
    defDie.className   = 'die-display rolling';
    outcome.textContent = '';
    outcome.className   = 'battle-outcome';
    footer.innerHTML   = '<div class="result-dismiss">— click to continue —</div>';

    dialog.style.display = 'flex';

    // Animate dice then reveal result
    let ticks = 0;
    const maxTicks = 14;
    const interval = setInterval(() => {
      ticks++;
      atkDie.textContent = Math.ceil(Math.random() * 20);
      defDie.textContent = Math.ceil(Math.random() * 20);
      if (ticks >= maxTicks) {
        clearInterval(interval);
        atkDie.textContent = result.attackRoll;
        defDie.textContent = result.defenseRoll;
        atkDie.className = 'die-display' + (result.hit ? ' atk-win' : '');
        defDie.className = 'die-display' + (!result.hit ? ' def-win' : '');

        // Build outcome text accounting for fort absorption, multi-damage, counter
        if (result.killed) {
          outcome.textContent = `💀 ${targetSnap.name} is slain!`;
          outcome.className   = 'battle-outcome kill';
        } else if (result.hit) {
          if (result.fortAbsorbed > 0 && result.damage === 0) {
            outcome.textContent = `🏰 Fortifications absorb the blow!`;
            outcome.className   = 'battle-outcome miss';
          } else if (result.damage >= 2) {
            outcome.textContent = `💥💥 Crushing hit! ${targetSnap.name} takes ${result.damage} damage!`;
            outcome.className   = 'battle-outcome kill';
          } else if (result.fortAbsorbed > 0) {
            outcome.textContent = `🏰 Fort weakened! ${targetSnap.name} takes ${result.damage} damage`;
            outcome.className   = 'battle-outcome hit';
          } else {
            outcome.textContent = `💥 Hit! ${targetSnap.name} takes 1 damage`;
            outcome.className   = 'battle-outcome hit';
          }
        } else if (result.counterDmg > 0) {
          outcome.textContent = `⚔ Counter! ${actorSnap.name} takes 1 damage!`;
          outcome.className   = 'battle-outcome kill';
        } else {
          outcome.textContent = `🛡 ${targetSnap.name} defends!`;
          outcome.className   = 'battle-outcome miss';
        }

        // Update defender HP bar to reflect post-battle state
        const fill = dialog.querySelector('.combatant-panel:last-of-type .combatant-hp-fill');
        if (fill) {
          const newHp = result.killed ? 0 : Math.max(0, targetSnap.hp - (result.damage || 0));
          fill.style.width = `${Math.max(0, (newHp / targetSnap.maxHp) * 100)}%`;
        }

        // Update attacker HP bar if counter-attacked
        if (result.counterDmg > 0) {
          const atkFill = dialog.querySelector('.combatant-panel:first-of-type .combatant-hp-fill');
          if (atkFill) {
            const newHp = Math.max(0, actorSnap.hp - result.counterDmg);
            atkFill.style.width = `${Math.max(0, (newHp / actorSnap.maxHp) * 100)}%`;
          }
        }

        // Gang-up indicator — remove any note left from a previous battle first
        dialog.querySelectorAll('.battle-gang-note').forEach(el => el.remove());
        if ((result.attackerAllies || 0) > 0 || (result.defenderAllies || 0) > 0) {
          const noteEl = document.createElement('div');
          noteEl.className = 'battle-gang-note';
          const parts = [];
          if (result.attackerAllies > 0) parts.push(`Attacker has ${result.attackerAllies} ally (+1 ATK)`);
          if (result.defenderAllies  > 0) parts.push(`Defender has ${result.defenderAllies} ally (+1 DEF)`);
          noteEl.textContent = parts.join(' · ');
          outcome.after(noteEl);
        }

        // Actions remaining indicator
        const left = this.state.actionsLeft;
        const actsEl = document.createElement('div');
        actsEl.className = 'battle-actions-left';
        actsEl.innerHTML = left > 0 ? '◆'.repeat(left) : '◇';
        footer.insertBefore(actsEl, footer.firstChild);

        // Battle Again button (player battles only, when neither died)
        if (onRematch) {
          const hasActs = this.state.actionsAvailable > 0;
          const rematchBtn = document.createElement('button');
          rematchBtn.className = 'action-btn battle rematch-btn';
          rematchBtn.textContent = '⚔ Battle Again';
          rematchBtn.disabled = !hasActs;
          rematchBtn.addEventListener('click', e => {
            e.stopPropagation();
            dialog.style.display = 'none';
            document.removeEventListener('keydown', keyDismiss);
            onRematch();
          });
          footer.insertBefore(rematchBtn, footer.firstChild);
        }
      }
    }, 55);

    const dismiss = () => {
      dialog.style.display = 'none';
      dialog.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', keyDismiss);
      if (onDismiss) onDismiss();
    };
    const keyDismiss = e => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') dismiss();
    };
    // Only allow dismiss after dice settle
    setTimeout(() => {
      dialog.addEventListener('click', dismiss);
      document.addEventListener('keydown', keyDismiss);
    }, maxTicks * 55 + 200);
  }

  // Single entry point for all AI turns — safe to call anytime
  _maybeRunAI(delayMs = 400) {
    if (this.state.gameOver) return;
    const ap = this.state.activePlayer;
    if (ap === Player.WITCH && this.state.witchIsAI && this.ai) {
      setTimeout(() => this._runAI(), delayMs);
    } else if (ap === Player.HERO && this.state.heroIsAI && this.heroAI) {
      setTimeout(() => this._runHeroAI(), delayMs);
    }
  }

  async _runHeroAI() {
    if (!this.heroAI) return;
    await this.heroAI.takeTurn();
    this._updateSidebar();
    this.onRedraw();
    this._maybeRunAI();
  }

  async _runAI() {
    if (!this.ai) return;
    await this.ai.takeTurn();
    this._updateSidebar();
    this.onRedraw();
    this._maybeRunAI();
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
          if (obj) info += `<div style="color:#cc88ff">⚔ Power Node: ${obj.label} — control at dawn to win</div>`;
          if (tile.explored && tile.fortifyLevel) {
            const fl = tile.fortifyLevel >= 3 ? `⚙⚙ Heavily Reinforced (+${tile.fortifyLevel} DEF)`
              : tile.fortifyLevel >= 2 ? `⚙ Metal Reinforced (+${tile.fortifyLevel} DEF)`
              : `🪵 Fortified (+${tile.fortifyLevel} DEF)`;
            info += `<div class="fortified">${fl}</div>`;
          }
          if (!tile.explored) info += `<div class="unexplored">Unexplored</div>`;

          const visible = _visibleUnitsAt(state, h.col, h.row);
          if (visible.length) {
            info += `<div style="margin-top:0.3rem;font-size:0.8rem;color:#ccc">Units here:</div>`;
            for (const u of visible) {
              const col = ENTITY_COLOR[u.type] || '#888';
              info += `<div style="color:${col};font-size:0.78rem">${u.displayName} — HP ${u.hp}/${u.maxHp}</div>`;
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
      ? `<div class="entity-weapon">🗡 ${WEAPON_LABEL[entity.weapon] || entity.weapon}</div>` : '';

    const myItems    = entity.items || {};
    const itemEntries = Object.entries(myItems).filter(([, v]) => v > 0);
    const packLine   = itemEntries.length
      ? `<div class="entity-weapon" style="color:#88eeff">🎒 ${itemEntries.map(([k, v]) => {
          if (k.startsWith('weapon:')) return `${WEAPON_LABEL[k.replace('weapon:', '')] || k}×${v}`;
          return `${RESOURCE_LABEL[k] || k}×${v}`;
        }).join(', ')}</div>` : '';

    let survivorBlock = '';
    if (entity.type === EntityType.SURVIVOR && entity.name) {
      survivorBlock = `
        <div class="survivor-name">${entity.name}</div>
        <div class="survivor-title">${entity.title}</div>
        <div class="survivor-bio">${entity.bio}</div>
        ${entity.abilityLabel ? `<div class="survivor-ability">★ ${entity.abilityLabel}</div>` : ''}
      `;
    }

    el.innerHTML = `
      <div class="entity-name" style="color:${ENTITY_COLOR[entity.type]}">${entity.displayName}</div>
      ${survivorBlock}
      <div class="entity-stats">
        HP: ${'♥'.repeat(entity.hp)}${'♡'.repeat(entity.maxHp - entity.hp)} (${entity.hp}/${entity.maxHp})<br>
        ATK: ${entity.attack}${entity.attackBonus ? ` +${entity.attackBonus}` : ''}
        DEF: ${entity.defense}${entity.defenseBonus ? ` +${entity.defenseBonus}` : ''}
      </div>
      ${weaponLine}${packLine}
      <div class="entity-pos">Position: (${entity.col}, ${entity.row})</div>
    `;
  }

  _renderInventory() {
    const el = document.getElementById('inventory');
    if (!el) return;
    const inv = this.state.inventory;
    let html = '<div class="inv-title">Shared Supplies</div><div class="inv-row">';
    const shared = Object.entries(inv.shared).filter(([, v]) => v > 0);
    html += shared.length
      ? shared.map(([k, v]) => `${RESOURCE_LABEL[k] || k}×${v}`).join(', ')
      : '<span style="color:#4a4060">none</span>';
    html += '</div>';
    html += '<div class="inv-title" style="margin-top:0.4rem">Witch Stores</div><div class="inv-row">';
    const witch = Object.entries(inv.witch).filter(([, v]) => v > 0);
    html += witch.length
      ? witch.map(([k, v]) => `${RESOURCE_LABEL[k] || k}×${v}`).join(', ')
      : '<span style="color:#4a4060">none</span>';
    html += '</div>';
    el.innerHTML = html;
  }

  _renderLog() {
    const el = document.getElementById('event-log');
    if (!el) return;
    el.innerHTML = this.state.log.slice(-12).map(m => `<div class="log-entry">${m}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  refresh() {
    this._updateSidebar();
    this.onRedraw();
    this._maybeRunAI(800); // kick off first AI turn if applicable
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

function btn(label, cls, disabled = '', extra = '') {
  return `<button class="action-btn ${cls}" ${disabled} ${extra}>${label}</button>`;
}

function _summonLabel(witchInv) {
  if ((witchInv.metal || 0) > 0) return '🔩 Iron Golem';
  if ((witchInv.wood  || 0) > 0) return '🪵 Wood Golem';
  const res = Object.keys(witchInv).find(k => witchInv[k] > 0);
  return res ? `🌑 Summon Minion` : '🌑 Summon';
}

function _visibleUnitsAt(state, col, row) {
  if (!state.fogOfWar) return state.entities.filter(e => e.alive && e.col === col && e.row === row);
  const revealed = getVisibleEnemyHexes(state);
  return state.entities.filter(e => {
    if (!e.alive || e.col !== col || e.row !== row) return false;
    if (e.owner === 'witch') return revealed.has(hexKey(col, row));
    return true;
  });
}

function _snapEntity(e) {
  return { id: e.id, name: e.displayName, hp: e.hp, maxHp: e.maxHp, attack: e.attack, defense: e.defense, type: e.type };
}

function _combatantHTML(snap, role) {
  const label     = role === 'atk' ? '⚔ Attacker' : '🛡 Defender';
  const color     = ENTITY_COLOR[snap.type] || '#888';
  const hpPct     = (snap.hp / snap.maxHp) * 100;
  const hpColor   = hpPct > 50 ? '#4caf50' : hpPct > 25 ? '#ff9800' : '#f44336';
  return `
    <div class="combatant-name" style="color:${color}">${snap.name}</div>
    <div style="font-size:0.68rem;color:#7a7060;margin-bottom:0.3rem">${label}</div>
    <div class="combatant-stats">HP: ${snap.hp}/${snap.maxHp} · ATK: ${snap.attack} · DEF: ${snap.defense}</div>
    <div class="combatant-hp-bar">
      <div class="combatant-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div>
    </div>
  `;
}

function _hideActionPopup() {
  const p = document.getElementById('action-popup');
  if (p) p.style.display = 'none';
}

function _positionPopup(popup, ui) {
  if (!ui._selectedEntity && !ui._pendingUnitPick) return;
  const target = ui._selectedEntity || (ui._pendingUnitPick?.units[0]);
  if (!target) return;

  // Measure popup height while invisible so we can fit it in the viewport
  popup.style.visibility = 'hidden';
  popup.style.display    = 'block';
  const popupH = popup.offsetHeight || 180;
  popup.style.display    = 'none';
  popup.style.visibility = '';

  const POPUP_W = 210;
  const GAP     = 10;

  const canvasRect = ui.canvas.getBoundingClientRect();
  const { x, y }   = ui.renderer.hexToCanvasPos(target.col, target.row);
  const scale       = canvasRect.width / ui.canvas.width;
  const screenX     = canvasRect.left + x * scale;
  const screenY     = canvasRect.top  + y * scale;
  const hs          = ui.renderer.hexSize * scale;

  // Horizontal: centre on unit, clamped within viewport
  popup.style.left      = Math.max(8, Math.min(screenX - POPUP_W / 2, window.innerWidth  - POPUP_W - 8)) + 'px';
  popup.style.transform = 'none';

  // Vertical: prefer above the hex, flip below when there isn't enough room
  const hexTop     = screenY - hs * 0.55;
  const hexBot     = screenY + hs * 0.55;
  const spaceAbove = hexTop - GAP;
  const showBelow  = spaceAbove < popupH + 8;

  if (showBelow) {
    popup.classList.add('flipped');
    // Clamp so it doesn't run off the bottom
    popup.style.top = Math.min(hexBot + GAP, window.innerHeight - popupH - 8) + 'px';
  } else {
    popup.classList.remove('flipped');
    // Clamp so it doesn't run off the top
    popup.style.top = Math.max(8, hexTop - GAP - popupH) + 'px';
  }
}

function _attachPopupListeners(popup, ui) {
  popup.querySelectorAll('button[data-action]').forEach(b => {
    b.addEventListener('click', () => ui._handleActionButton(b));
  });
}

function _touchDist(t1, t2) {
  return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
}
