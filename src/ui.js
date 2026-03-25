// UI controller: handles canvas clicks, sidepanel updates, action buttons
import { hexKey, hexToPixel, MAP_COLS, MAP_ROWS } from './hex.js';
import { TileType, BUILDING_LABEL, BUILDING_ICON, RESOURCE_LABEL, WEAPON_LABEL, ResourceType } from './tiles.js';
import { EntityType, SurvivorAbility, ENTITY_COLOR } from './entities.js';
import { Phase, Player, PHASE_ICON } from './game.js';
import { PAD_X, PAD_Y } from './renderer.js';
import {
  ActionType, getValidActions, getVisibleEnemyHexes, getVisibleHeroHexes,
  executeMove, executeExplore, executeBattle,
  executeFortify, executeSummon, executeUseItem, executeUseAbility,
} from './actions.js';
import { PlanActionType, computeGhostState } from './planner.js';

export class UIController {
  constructor(canvas, state, renderer, witchAI, onRedraw, heroAI = null, autoplay = false) {
    this.canvas    = canvas;
    this.state     = state;
    this.renderer  = renderer;
    this.ai        = witchAI;
    this.heroAI    = heroAI;
    this.onRedraw  = onRedraw;
    this.autoplay  = autoplay;
    this.mp        = null;  // set externally when in online mode

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

    this._lastHazardKey    = '';   // deduplicates hazard popups across state updates
    this._battleInterval   = null; // dice animation interval — cleared on new dialog

    // ── Planning mode state ──────────────────────────────────────────────────
    this._planMode      = false;   // true during simultaneous planning phase
    this._plan          = [];      // queued PlanActions for this round
    this._planFaction   = null;    // 'hero' or 'witch' — which faction we're planning for
    this._planBudget    = 0;       // total action budget for this round
    this._planSubmitted = false;   // true after plan is locked in
    this.onPlanSubmit   = null;    // callback(plan) — set by main.js

    // ── Multiplayer ──────────────────────────────────────────────────────────
    this.myPlayerId     = null;    // UUID of the local player (null in offline mode)
    this._players       = [];      // full player roster [{id,name,faction,isAI}]
    this._countdownTimer = null;   // setInterval handle for countdown display

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

    // Scroll wheel is disabled over the canvas (zoom via buttons instead)
    this.canvas.addEventListener('wheel', e => { e.preventDefault(); }, { passive: false });

    // Mouse drag-to-pan (desktop)
    this.canvas.addEventListener('mousedown', e => {
      this._mouseDown  = { clientX: e.clientX, clientY: e.clientY };
      this._didDragPan = false;
      this.canvas.style.cursor = 'grabbing';
    });
    // Listen on document so releasing outside the canvas always clears drag state
    document.addEventListener('mouseup', () => {
      if (this._mouseDown) {
        this._mouseDown = null;
        this.canvas.style.cursor = '';
      }
    });

    // Zoom control buttons (+, −, fit)
    const zoomStep = 1.25;
    document.getElementById('zoom-in')?.addEventListener('click', () => {
      const cx = this.canvas.width  / 2;
      const cy = this.canvas.height / 2;
      this.renderer.setZoom(this.renderer.zoomLevel * zoomStep, cx, cy);
      this.onRedraw();
    });
    document.getElementById('zoom-out')?.addEventListener('click', () => {
      const cx = this.canvas.width  / 2;
      const cy = this.canvas.height / 2;
      this.renderer.setZoom(this.renderer.zoomLevel / zoomStep, cx, cy);
      this.onRedraw();
    });
    document.getElementById('zoom-fit')?.addEventListener('click', () => {
      this.renderer.resetView();
      this.onRedraw();
    });
    document.getElementById('zoom-me')?.addEventListener('click', () => {
      const faction = this._planFaction ?? (!this.state.heroIsAI ? 'hero' : 'witch');
      const units   = this.state.entities.filter(e => e.alive && e.owner === faction);
      if (units.length > 0) this.renderer.frameHexes(units, { maxZoom: 1.8, paddingHexes: 2.5, duration: 400 });
      this.onRedraw();
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
          this.renderer._zoomAnim = null; // cancel auto-framing on manual pan
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

    // Chronicle overlay toggle
    document.getElementById('chronicle-btn')?.addEventListener('click', () => this._toggleChronicle());
    document.getElementById('chronicle-close')?.addEventListener('click', () => this._toggleChronicle());
    document.getElementById('chronicle-overlay')?.addEventListener('click', e => {
      if (e.target === document.getElementById('chronicle-overlay')) this._toggleChronicle();
    });

    // Inventory overlay toggle
    document.getElementById('inventory-btn')?.addEventListener('click', () => this._toggleInventory());
    document.getElementById('inventory-close')?.addEventListener('click', () => this._toggleInventory());
    document.getElementById('inventory-overlay')?.addEventListener('click', e => {
      if (e.target === document.getElementById('inventory-overlay')) this._toggleInventory();
    });

    // Tile zoom close
    document.getElementById('tile-zoom-close')?.addEventListener('click', () => this._hideTileDetail());
    document.getElementById('tile-zoom-overlay')?.addEventListener('click', e => {
      if (e.target === document.getElementById('tile-zoom-overlay')) this._hideTileDetail();
    });

    // Cancel-action pill (floating over canvas during battle/summon targeting)
    document.getElementById('cancel-action-btn')?.addEventListener('click', () => {
      const entity = this._selectedEntity;
      if (entity) {
        this._selectEntity(entity);
      } else {
        this._awaitingTarget = null;
        this.renderer.highlightHexes = [];
      }
      this._updateSidebar();
      this.onRedraw();
    });

    // End Turn / Submit Plan in header
    document.getElementById('end-turn-btn')?.addEventListener('click', () => {
      if (this.state.gameOver) return;
      if (this._planMode) { this._doSubmitPlan(); return; }
      if (this._isOpponentTurn()) return;
      this._doEndTurn();
    });

    // Plan panel buttons
    document.getElementById('plan-submit-btn')?.addEventListener('click', () => this._doSubmitPlan());
    document.getElementById('plan-clear-btn')?.addEventListener('click',  () => {
      if (this._planSubmitted) return;
      this._plan = [];
      this._refreshPlanOverlay();
      this._renderPlanPanel();
      if (this._selectedEntity) this._selectEntity(this._selectedEntity);
      this.onRedraw();
    });
    document.getElementById('plan-toggle-btn')?.addEventListener('click', () => this._togglePlanPanel());
    document.getElementById('plan-tab')?.addEventListener('click',        () => this._togglePlanPanel());
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
        this.renderer._zoomAnim = null; // cancel auto-framing on manual pan
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
    this.renderer.hoveredHex = (hex.col >= 0 && hex.col < MAP_COLS && hex.row >= 0 && hex.row < MAP_ROWS)
      ? hex : null;
    this.onRedraw();
  }

  // ── Online-mode helpers ───────────────────────────────────────────────────

  /** True when the current turn belongs to the remote opponent (not us). */
  _isOpponentTurn() {
    if (this._planMode) return false; // during planning, we're always active
    if (this.mp?.active) return this.state.activePlayer !== this.mp.myFaction;
    return (this.state.activePlayer === Player.WITCH && this.state.witchIsAI) ||
           (this.state.activePlayer === Player.HERO  && this.state.heroIsAI);
  }

  /** End the current turn — sends to server in online mode, executes locally otherwise. */
  _doEndTurn() {
    if (this.mp?.active) {
      this.mp.sendEndTurn();
      this._clearSelection();
      this._updateSidebar();
      return;
    }
    this._clearSelection();
    this.state.endTurn();
    this._triggerHazardFlashes();
    this._updateSidebar();
    this.onRedraw();
    this._maybeRunAI();
  }

  // ── Planning mode ─────────────────────────────────────────────────────────

  /**
   * Enter planning mode.
   * @param {'hero'|'witch'} faction  Which faction the human controls.
   * @param {number} budget           Action budget for this round.
   */
  enterPlanningMode(faction, budget, timeoutMs = 0) {
    this._planMode         = true;
    this._planFaction      = faction;
    this._planBudget       = budget;
    this._plan             = [];
    this._planSubmitted    = false;
    this._planFoodEnabled  = this.state?.inventory?.shared?.[ResourceType.FOOD] || 0;

    const panel = document.getElementById('plan-panel');
    if (panel) {
      panel.style.display = '';
      panel.classList.remove('plan-submitted');
      panel.dataset.witchMode = faction === 'witch' ? '1' : '';
      // Default to collapsed on narrow (phone) screens
      if (window.innerWidth <= 700) {
        panel.classList.add('collapsed');
      } else {
        panel.classList.remove('collapsed');
      }
    }

    this._clearSelection();

    // Auto-select the leader on round 1 so the player knows which unit is
    // theirs (especially important in team MP).  After round 1 it's annoying
    // because it overrides whatever the player was looking at.
    if ((this.state?.round ?? 1) <= 1) {
      const myLeader = this.state?.entities.find(e =>
        e.alive && e.owner === faction &&
        (e.type === 'hero' || e.type === 'witch') &&
        (!this.myPlayerId || e.ownerId === this.myPlayerId)
      );
      if (myLeader) this._selectEntity(myLeader);
    }

    this._refreshPlanOverlay();
    this._renderPlanPanel();
    this._updateSidebar();
    this.onRedraw();

    // Zoom to frame the planning faction's units at the start of every turn.
    // In online MP, frame only the local player's units; offline: whole faction.
    if (this.renderer) {
      const units = this.state.entities.filter(e => {
        if (!e.alive || e.owner !== faction) return false;
        return !this.myPlayerId || !e.ownerId || e.ownerId === this.myPlayerId;
      });
      if (units.length > 0) {
        this.renderer.frameHexes(units, { maxZoom: 1.8, paddingHexes: 2.5, duration: 550 });
      }
    }

    // Show a brief phase-info toast so the player always knows current conditions.
    this._showPhaseToast(faction);

    // If attrition just increased, show a blocking popup after the toast settles.
    if (this.state.attritionChanged && this.state.attritionLevel > 0) {
      this.state.attritionChanged = false; // consume the flag
      setTimeout(() => this._showAttritionPopup(), 400);
    }

    // Multiplayer: reset submission status panel and start countdown.
    // Clear previous-round submitted flags.
    if (this._players) this._players.forEach(p => { p._submitted = false; });
    this._renderPlayerStatus();
    if (timeoutMs > 0) this._startCountdown(timeoutMs);
  }

  /** Exit planning mode (called after resolution completes). */
  exitPlanningMode() {
    this._planMode      = false;
    this._planSubmitted = false;
    this._plan          = [];
    this._planFaction   = null;

    this._stopCountdown();

    const panel = document.getElementById('plan-panel');
    if (panel) { panel.style.display = 'none'; panel.classList.remove('collapsed'); }

    if (this.renderer) this.renderer.planGhostSteps = null;
    this._clearSelection();
    this._updateSidebar();
    this.onRedraw();
  }

  // ── Multiplayer player-status panel ────────────────────────────────────────

  /** Render the list of players and their submission state into #plan-players. */
  _renderPlayerStatus() {
    const el = document.getElementById('plan-players');
    if (!el) return;

    const players = this._players ?? [];
    if (players.length <= 1) {
      el.style.display = 'none';
      return;
    }

    el.style.display = '';
    let html = '';
    for (const p of players) {
      const isMe      = p.playerId === this.myPlayerId;
      const submitted = p._submitted ?? false;
      const icon      = submitted ? '✓' : '⋯';
      const cls       = submitted ? 'player-ready' : 'player-waiting';
      const label     = isMe ? `${p.name} (you)` : p.name;
      const fCls      = p.faction === 'hero' ? 'faction-hero' : 'faction-witch';
      const safeName  = String(label).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      html += `<div class="plan-player-row ${cls}">
        <span class="plan-player-icon ${fCls}">${p.faction === 'hero' ? '⚔' : '✦'}</span>
        <span class="plan-player-name">${safeName}</span>
        <span class="plan-player-status">${icon}</span>
      </div>`;
    }
    el.innerHTML = html;
  }

  /** Called when the server notifies that another player has submitted. */
  _onPlayerSubmitted(playerId, name, faction) {
    const p = this._players?.find(p => p.playerId === playerId);
    if (p) p._submitted = true;
    this._renderPlayerStatus();
  }

  /** Start a countdown timer showing seconds remaining until auto-submit. */
  _startCountdown(timeoutMs) {
    this._stopCountdown();
    const el    = document.getElementById('plan-countdown');
    if (!el) return;
    el.style.display = '';
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const secs = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      el.textContent = `${secs}s`;
      el.classList.toggle('countdown-urgent', secs <= 10);
      if (secs <= 0) this._stopCountdown();
    };
    tick();
    this._countdownTimer = setInterval(tick, 500);
  }

  /** Stop the countdown timer. */
  _stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
    const el = document.getElementById('plan-countdown');
    if (el) { el.style.display = 'none'; el.textContent = ''; }
  }

  /** Add one action to the plan queue. */
  _addToPlan(action) {
    if (this._planSubmitted) return;
    this._plan.push(action);
    this._refreshPlanOverlay();
    this._renderPlanPanel();
  }

  /** Recompute ghost overlay from the current plan and push to renderer. */
  _refreshPlanOverlay() {
    if (!this.renderer) return;
    const steps = computeGhostState(this.state, this._plan);
    // Annotate each step with whether it exceeds the action budget
    let runningCost = 0;
    for (const step of steps) {
      const isFree = step.action.type === PlanActionType.EQUIP_WEAPON
                  || step.action.type === PlanActionType.USE_ITEM;
      if (!isFree) runningCost++;
      step.overBudget = !isFree && runningCost > this._planBudget;
    }
    this.renderer.planGhostSteps = steps;
  }

  /** Submit the current plan. */
  _doSubmitPlan() {
    if (this._planSubmitted) return;
    this._planSubmitted = true;

    const panel = document.getElementById('plan-panel');
    if (panel) panel.classList.add('plan-submitted');

    const status = document.getElementById('plan-status');
    if (status) status.textContent = 'Waiting for opponents…';

    // Mark ourselves as submitted in the player list so the status panel updates.
    const me = this._players?.find(p => p.id === this.myPlayerId);
    if (me) me._submitted = true;
    this._renderPlayerStatus();

    this._updateSidebar();
    this.onRedraw();

    if (this.onPlanSubmit) this.onPlanSubmit([...this._plan]);
  }

  /** Render the plan panel steps list. */
  _renderPlanPanel() {
    const stepsEl  = document.getElementById('plan-steps');
    const budgeEl  = document.getElementById('plan-budget-badge');
    const statusEl = document.getElementById('plan-status');
    if (!stepsEl) return;

    // Count budget-consuming actions
    const budgetCost = this._plan.filter(a =>
      a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM
    ).length;
    const remaining = this._planBudget - budgetCost;

    if (budgeEl) budgeEl.textContent = `${Math.max(0, remaining)} left`;

    const ICONS = {
      [PlanActionType.MOVE]:        '↗',
      [PlanActionType.BATTLE_UNIT]: '⚔',
      [PlanActionType.BATTLE_HEX]:  '⚔',
      [PlanActionType.EXPLORE]:     '🔍',
      [PlanActionType.FORTIFY]:     '🪵',
      [PlanActionType.SUMMON]:      '✦',
      [PlanActionType.USE_ITEM]:    '🧪',
      [PlanActionType.EQUIP_WEAPON]:'⚔',
      [PlanActionType.USE_ABILITY]: '✦',
    };

    const describeAction = (a, i) => {
      const entity = this.state.entities.find(e => e.id === a.entityId);
      const who    = entity?.displayName ?? 'Unit';
      switch (a.type) {
        case PlanActionType.MOVE:
          return `${who} → (${a.toCol},${a.toRow})`;
        case PlanActionType.BATTLE_UNIT: {
          const target = this.state.entities.find(e => e.id === a.targetId);
          return `${who} attacks ${target?.displayName ?? '?'}`;
        }
        case PlanActionType.BATTLE_HEX:
          return `${who} attacks (${a.targetCol},${a.targetRow})`;
        case PlanActionType.EXPLORE:
          return `${who} explores`;
        case PlanActionType.FORTIFY:
          return `${who} fortifies`;
        case PlanActionType.SUMMON:
          return `${who} summons at (${a.toCol},${a.toRow})`;
        case PlanActionType.USE_ITEM:
          return `${who} uses ${a.item}`;
        case PlanActionType.EQUIP_WEAPON:
          return `${who} equips ${a.weapon}`;
        case PlanActionType.USE_ABILITY:
          return `${who} uses ability`;
        default:
          return `Step ${i + 1}`;
      }
    };

    // Track running cost to identify over-budget steps.
    // Over-budget steps are food-powered up to _planFoodEnabled, then truly over-budget.
    const foodAvailable = (this.state.inventory?.shared?.[ResourceType.FOOD] || 0);
    const foodEnabled   = Math.min(this._planFoodEnabled ?? foodAvailable, foodAvailable);
    let runningCost = 0;
    let foodUsed = 0;
    let html = '';
    this._plan.forEach((a, i) => {
      const isFree = a.type === PlanActionType.EQUIP_WEAPON || a.type === PlanActionType.USE_ITEM;
      if (!isFree) runningCost++;
      const overBudget = !isFree && runningCost > this._planBudget;
      const foodPowered = overBudget && foodUsed < foodEnabled;
      if (foodPowered) foodUsed++;
      const desc = describeAction(a, i);
      const foodTag = foodPowered ? ` <span class="plan-food-tag">-1 🍞</span>` : '';
      const rmBtn = this._planSubmitted
        ? ''
        : `<button class="plan-step-remove" data-plan-idx="${i}" title="Remove">✕</button>`;
      const cls = foodPowered ? ' food-powered' : overBudget ? ' over-budget' : '';
      html += `<div class="plan-step${cls}">
        <span class="plan-step-num">${i + 1}</span>
        <span class="plan-step-desc" title="${desc}">${desc}${foodTag}</span>
        ${rmBtn}
      </div>`;
    });
    if (!html) html = `<div class="plan-step"><span class="plan-step-desc" style="color:var(--muted)">No actions queued — click units to add</span></div>`;
    stepsEl.innerHTML = html;

    // Attach remove listeners
    stepsEl.querySelectorAll('.plan-step-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.planIdx);
        this._plan.splice(idx, 1);
        this._refreshPlanOverlay();
        this._renderPlanPanel();
        // Refresh highlights for the selected entity after plan changes
        if (this._selectedEntity) this._selectEntity(this._selectedEntity);
        this.onRedraw();
      });
    });

    // ── Food slots row ──────────────────────────────────────────────────────
    const foodRowEl = document.getElementById('plan-food-row');
    if (foodRowEl) {
      if (foodAvailable > 0 && !this._planSubmitted) {
        let slots = '';
        for (let i = 0; i < foodAvailable; i++) {
          const on = i < foodEnabled;
          slots += `<button class="plan-food-slot${on ? ' on' : ''}" data-food-idx="${i}" title="${on ? 'Click to disable this food ration' : 'Click to enable this food ration'}">🍞</button>`;
        }
        foodRowEl.innerHTML = `<span class="plan-food-label">Extra actions:</span>${slots}`;
        foodRowEl.querySelectorAll('.plan-food-slot').forEach(btn => {
          btn.addEventListener('click', e => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.foodIdx);
            // Toggle: if slot i is currently on, clicking it turns off i and above.
            // If slot i is off, clicking turns on up to i.
            this._planFoodEnabled = (idx < foodEnabled) ? idx : idx + 1;
            this._renderPlanPanel();
          });
        });
      } else {
        foodRowEl.innerHTML = '';
      }
    }

    if (statusEl && !this._planSubmitted) statusEl.textContent = '';

    // Keep the collapse-tab count badge in sync
    const tabCount = document.getElementById('plan-tab-count');
    if (tabCount) tabCount.textContent = this._plan.length > 0 ? this._plan.length : '';

    // Update collapse-button arrow direction
    const panel = document.getElementById('plan-panel');
    const toggleBtn = document.getElementById('plan-toggle-btn');
    if (toggleBtn && panel) {
      toggleBtn.textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
    }
  }

  /** Toggle the plan panel between expanded and collapsed. */
  _togglePlanPanel() {
    const panel = document.getElementById('plan-panel');
    if (!panel) return;
    panel.classList.toggle('collapsed');
    const isCollapsed = panel.classList.contains('collapsed');
    const toggleBtn = document.getElementById('plan-toggle-btn');
    if (toggleBtn) toggleBtn.textContent = isCollapsed ? '▶' : '◀';
  }

  _onClick(e) {
    if (this._didDragPan) { this._didDragPan = false; return; }
    if (this.state.gameOver) return;

    const { x, y } = this._canvasPos(e);
    const hex = this._canvasToHex(x, y);
    if (hex.col < 0 || hex.col >= MAP_COLS || hex.row < 0 || hex.row >= MAP_ROWS) return;

    // On opponent's turn, allow viewing tiles/units but block all actions
    if (!this._planMode && this._isOpponentTurn()) {
      this._clearSelection();
      this._showTileDetail(hex);
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    // During planning, same click-to-select/target flow — but actions go to plan queue
    if (this._planMode && this._planSubmitted) {
      // Plan locked — read-only view
      this._clearSelection();
      this._showTileDetail(hex);
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    // Tapping the selected unit's hex always toggles the action popup — this
    // check happens before the _awaitingTarget routing so it works whether the
    // default-MOVE awaiting is set or not, and regardless of how many units
    // share that hex.
    // In planning mode, use the projected (ghost) position rather than the real one.
    const _selDisplayHex = this._planMode && this._selectedEntity
      ? (this._getProjectedPos(this._selectedEntity.id) ?? this._selectedEntity)
      : this._selectedEntity;
    if (
      this._selectedEntity &&
      hex.col === _selDisplayHex.col && hex.row === _selDisplayHex.row
    ) {
      if (this._popupVisible) {
        // Third click — deselect entirely
        this._clearSelection();
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
    // In planning mode, filter by plan faction; otherwise by active player
    const ownerFilter = this._planMode ? this._planFaction : state.activePlayer;

    // In planning mode, entities may have a different projected (ghost) position
    // from their real position; use ghost positions for click detection.
    const lastGhostPos = this._planMode
      ? this.renderer?.planGhostSteps?.at(-1)?.positions
      : null;
    const clickedEntities = state.entities.filter(e => {
      if (!e.alive || e.owner !== ownerFilter) return false;
      // In online MP, only allow selecting entities owned by the local player.
      if (this.myPlayerId && e.ownerId && e.ownerId !== this.myPlayerId) return false;
      const ghostPos = lastGhostPos?.get(e.id);
      // In planning mode, if the entity has been moved in the plan, use ONLY the
      // ghost position — it should no longer appear on its real tile.
      const pos = (this._planMode && ghostPos) ? ghostPos : { col: e.col, row: e.row };
      return pos.col === hex.col && pos.row === hex.row;
    });

    if (clickedEntities.length === 0) {
      // Nothing selectable here — just deselect
      this._clearSelection();
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
        // New unit — select it, hide any open tile detail
        this._hideTileDetail();
        this._selectEntity(entity);
        this._pendingUnitPick = null;
      }
    } else {
      // Multiple units on hex — show simple picker popup
      this._selectedEntity  = null;
      this._popupVisible    = true;
      this._validActions    = [];
      this.renderer.selectedHex    = { col: hex.col, row: hex.row };
      this.renderer.highlightHexes = [];
      this._pendingUnitPick = { units: clickedEntities };
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

    // In planning mode, valid actions and highlights must use the entity's
    // projected position (after earlier MOVE steps in the plan), not the real one.
    let effectiveEntity = entity;
    if (this._planMode) {
      const proj = this._getProjectedPos(entity.id);
      if (proj && (proj.col !== entity.col || proj.row !== entity.row)) {
        effectiveEntity = { ...entity, col: proj.col, row: proj.row };
      }
    }

    this.renderer.selectedHex = { col: effectiveEntity.col, row: effectiveEntity.row };
    this._validActions = getValidActions(this.state, effectiveEntity);
    // Move is always the default awaiting action — clicking a green hex moves.
    const hasMoveAction = this._validActions.some(a => a.type === ActionType.MOVE);
    const actionsOk = this._planMode || this.state.actionsAvailable > 0;
    if (hasMoveAction && actionsOk) {
      // Store the real entity in actor so that actor.alive (a prototype getter) works correctly.
      // effectiveEntity is a plain spread-copy used only for position; it loses prototype methods.
      this._awaitingTarget = { actionType: ActionType.MOVE, actor: entity, isDefault: true };
    } else {
      this._awaitingTarget = null;
    }
    this._updateHighlights();
    // Popup is NOT shown here — user taps the unit a second time to open it
  }

  /** Return the latest projected position for an entity from the ghost overlay, or null. */
  _getProjectedPos(entityId) {
    const steps = this.renderer?.planGhostSteps;
    if (!steps || steps.length === 0) return null;
    return steps[steps.length - 1].positions.get(entityId) ?? null;
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
    this._hideTileDetail();
  }

  _updateHighlights() {
    const renderer = this.renderer;
    renderer.highlightHexes = [];
    if (!this._selectedEntity) return;

    const { actionType } = this._awaitingTarget || {};
    if (!actionType || actionType === ActionType.MOVE) {
      const a = this._validActions.find(a => a.type === ActionType.MOVE);
      if (a) renderer.highlightHexes = a.targets.map(t => ({ ...t, color: 'rgba(60,220,80,0.22)' }));
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
      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];

      // Planning mode: add to plan queue
      if (this._planMode) {
        this._addToPlan({ type: PlanActionType.MOVE, entityId: actor.id, toCol: hex.col, toRow: hex.row });
        if (actor.alive) this._selectEntity(actor);
        else this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
        return;
      }

      if (this.mp?.active) {
        this.mp.sendAction('move', { entityId: actor.id, col: hex.col, row: hex.row });
        this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
        return;
      }
      const result = executeMove(state, actor, hex.col, hex.row);
      for (const msg of result.log) state.addLog(msg);
      if (result.success) state.spendAction(result.cost);
      state.checkVictory();
      if (actor.alive && !result.encounterLog?.length) { this._selectEntity(actor); }
      else this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
      if (result.encounterLog?.length) {
        this._showResultDialog(result.encounterLog, () => {
          this._updateSidebar();
          this.onRedraw();
          this._maybeShowNoActionsDialog();
        }, result.encounterSurvivor);
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
        // Planning mode: add battle to plan, then keep battle highlights active
        // so tapping the same target again immediately stacks another attack.
        if (this._planMode) {
          this._addToPlan({ type: PlanActionType.BATTLE_UNIT, entityId: actor.id, targetId: target.id });
          // Recompute valid actions using projected position.
          const proj = this._getProjectedPos(actor.id);
          const eff  = proj ? { ...actor, col: proj.col, row: proj.row } : actor;
          this._validActions = getValidActions(this.state, eff);
          const hasBattle = this._validActions.some(a => a.type === ActionType.BATTLE);
          if (actor.alive && hasBattle) {
            // Keep attack mode active — next tap on same target stacks an attack.
            // Use real entity (actor) not the spread copy (eff); eff lacks prototype getters.
            this._awaitingTarget = { actionType: ActionType.BATTLE, actor: actor };
            this._updateHighlights();
          } else {
            if (actor.alive) this._selectEntity(actor);
            else this._clearSelection();
          }
          this._updateSidebar();
          this.onRedraw();
          return;
        }

        // Online mode: send to server and let stateUpdate drive the result
        if (this.mp?.active) {
          this.mp.sendAction('battle', { entityId: actor.id, targetId: target.id });
          this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
          return;
        }

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

        this.renderer.addAttackAnim(actorSnap.col, actorSnap.row, targetSnap.col, targetSnap.row);
        if (result.killed) {
          setTimeout(() => {
            const deadColor = targetSnap.owner === 'hero' ? '#d4a72c' : '#9b59b6';
            this.renderer.addDeathAnim(targetSnap.col, targetSnap.row, deadColor);
          }, 350);
        }

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
      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];

      if (this._planMode) {
        this._addToPlan({ type: PlanActionType.SUMMON, entityId: actor.id, toCol: hex.col, toRow: hex.row });
        if (actor.alive) this._selectEntity(actor);
        else this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
        return;
      }

      if (this.mp?.active) {
        this.mp.sendAction('summon', { entityId: actor.id, col: hex.col, row: hex.row });
        this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
        return;
      }
      const result = executeSummon(state, actor, hex.col, hex.row);
      for (const msg of result.log) state.addLog(msg);
      if (result.success) {
        state.spendAction(result.cost);
        this.renderer.addSpawnAnim(hex.col, hex.row, '#b39ddb');
      }
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
      let html = `<div class="popup-unit-name">Which unit to select?</div>`;
      for (const u of this._pendingUnitPick.units) {
        const col        = ENTITY_COLOR[u.type] || '#888';
        const portraitId = u.type === 'survivor' ? _SURVIVOR_TITLE_ASSET[u.title] : u.type;
        const src        = portraitId ? this.renderer.getPortraitDataURL(portraitId) : null;
        const portrait   = src
          ? `<img src="${src}" style="width:32px;height:32px;border-radius:50%;border:1.5px solid ${col};flex-shrink:0;margin-right:0.4rem;">`
          : '';
        html += `<button class="action-btn pick-unit" data-action="pick_unit" data-unit-id="${u.id}"
          style="border-left:3px solid ${col};display:flex;align-items:center;">${portrait}${u.displayName} — HP ${u.hp}/${u.maxHp}</button>`;
      }
      popup.innerHTML = html;
      _attachPopupListeners(popup, this);
      _positionPopup(popup, this);
      popup.style.display = 'block';
      return;
    }

    const ownerCheck = this._planMode ? this._planFaction : state.activePlayer;
    if (!entity || entity.owner !== ownerCheck || state.gameOver) {
      _hideActionPopup();
      return;
    }

    // In planning mode use projected position so attack is available after a planned move
    let effectiveEntity = entity;
    if (this._planMode) {
      const proj = this._getProjectedPos(entity.id);
      if (proj && (proj.col !== entity.col || proj.row !== entity.row)) {
        effectiveEntity = { ...entity, col: proj.col, row: proj.row };
      }
    }
    const actions = getValidActions(state, effectiveEntity);
    // In planning mode, always show actions (budget tracked separately)
    const hasAct  = this._planMode || state.actionsAvailable > 0;

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
            // Food is managed via the plan-panel food slots in planning mode.
            if (this._planMode && item.item === ResourceType.FOOD) continue;
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

    // Tile info always available — lets user inspect the current hex
    html += btn('🗺 Tile Info', 'tile-info', '', `data-action="tile_info"`);

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
    this._renderEndTurnBtn();
    this._renderInventory();
    this._renderLog();
    this._renderUnitStatsBar();
  }

  _renderUnitStatsBar() {
    const bar = document.getElementById('unit-stats-bar');
    if (!bar) return;

    const entity = this._selectedEntity;
    if (!entity) {
      bar.style.display = 'none';
      return;
    }

    const GLYPHS = {
      hero: '⚔', witch: '✦', survivor: '☺',
      zombie: '†', minion: '☠', wood_golem: '🪵', iron_golem: '⚙',
    };
    const COLORS = {
      hero: '#d4a72c', witch: '#9b59b6', survivor: '#4caf7d',
      zombie: '#7c9a57', minion: '#c0392b', wood_golem: '#8B5E3C', iron_golem: '#607D8B',
    };

    const glyph = GLYPHS[entity.type] ?? '?';
    const color = entity.color ?? COLORS[entity.type] ?? '#d4c9b0';
    const hpPct = Math.max(0, Math.min(100, (entity.hp / entity.maxHp) * 100));
    const hpColor = hpPct > 60 ? '#4caf7d' : hpPct > 30 ? '#f5c842' : '#c0392b';
    const weaponLabel = entity.weapon
      ? entity.weapon.charAt(0).toUpperCase() + entity.weapon.slice(1)
      : null;

    bar.style.display = 'flex';
    bar.innerHTML = `
      <span class="usb-glyph" style="color:${color}">${glyph}</span>
      <span class="usb-name" style="color:${color}">${entity.displayName}</span>
      <span class="usb-hp-wrap">
        <span class="usb-stat">HP</span>
        <span class="usb-hp-track">
          <span class="usb-hp-fill" style="width:${hpPct}%;background:${hpColor}"></span>
        </span>
        <span class="usb-stat-val">${entity.hp}/${entity.maxHp}</span>
      </span>
      <span class="usb-stat">ATK <span class="usb-stat-val">${entity.attack}</span></span>
      <span class="usb-stat">DEF <span class="usb-stat-val">${entity.defense}</span></span>
      ${weaponLabel ? `<span class="usb-weapon">⚔ ${weaponLabel}</span>` : ''}
      <button class="usb-deselect-btn" title="Deselect unit">✕</button>
    `;
    bar.querySelector('.usb-deselect-btn').addEventListener('click', () => {
      this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
    });
  }

  _renderTurnInfo() {
    const state = this.state;
    const el    = document.getElementById('turn-info');
    if (!el) return;

    // 8-step cycle — shared between header and cycle-bar
    const CYCLE_STEPS = [
      { phase: 'dawn',  icon: '🌅', label: 'Dawn',  desc: 'Hero +1 action · node scoring · attrition rises' },
      { phase: 'day',   icon: '☀️',  label: 'Day',   desc: 'Hero +1 ATK · Witch undead in the open suffer' },
      { phase: 'day',   icon: '☀️',  label: 'Day',   desc: 'Hero +1 ATK · Witch undead in the open suffer' },
      { phase: 'day',   icon: '☀️',  label: 'Day',   desc: 'Hero +1 ATK · Witch undead in the open suffer' },
      { phase: 'dusk',  icon: '🌇', label: 'Dusk',  desc: 'Node scoring · seek cover before night' },
      { phase: 'night', icon: '🌙', label: 'Night', desc: 'Witch +1 ATK · Survivors in the open suffer' },
      { phase: 'night', icon: '🌙', label: 'Night', desc: 'Witch +1 ATK · Survivors in the open suffer' },
      { phase: 'night', icon: '🌙', label: 'Night', desc: 'Witch +1 ATK · Survivors in the open suffer' },
    ];

    const roundInCycle = (state.round - 1) % 8;

    // Render always-visible cycle bar (compact icon row)
    const cycleBar = document.getElementById('cycle-bar');
    if (cycleBar) {
      const stepsHtml = CYCLE_STEPS.map((step, i) => {
        const active = i === roundInCycle;
        return `<div class="cycle-step phase-${step.phase} ${active ? 'cycle-active' : 'cycle-dim'}"
                     title="${step.desc}">${step.icon}${active ? `<span class="cycle-name">${step.label}</span>` : ''}</div>`;
      }).join('');
      // Preserve #node-status-bar (mobile node/score display) — re-inject after steps
      cycleBar.innerHTML = stepsHtml + `<div id="node-status-bar"></div>`;
    }

    // During planning phase, show planning info
    if (this._planMode) {
      const faction = this._planFaction;
      const budget  = this._planBudget;
      const used    = this._plan.filter(a => a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM).length;
      const diamonds = '◆'.repeat(Math.max(0, budget - used)) + '◇'.repeat(Math.max(0, used));
      const status  = this._planSubmitted ? '✓ Plan Submitted — Waiting…' : `📋 Planning Phase`;
      el.innerHTML = `
        <div class="turn-line">Round ${state.round}</div>
        <div class="turn-line player-${faction}">${status}</div>
        <div class="actions-remaining" title="Actions budget">${diamonds}</div>
      `;
      return;
    }

    const player = state.activePlayer === 'hero' ? 'Hero' : 'Witch';
    const isAI   = (state.activePlayer === 'witch' && state.witchIsAI) ||
                   (state.activePlayer === 'hero'  && state.heroIsAI);

    const diamonds = state.actionsLeft > 0
      ? '◆'.repeat(state.actionsLeft)
      : '◇';

    // On wider screens the cycle strip also lives in turn-info; on mobile it's
    // only shown in #cycle-bar so we omit it here to avoid duplication.
    el.innerHTML = `
      <div class="cycle-strip cycle-strip-header">${CYCLE_STEPS.map((step, i) => {
        const active = i === roundInCycle;
        return `<div class="cycle-step phase-${step.phase} ${active ? 'cycle-active' : 'cycle-dim'}"
                     title="${step.desc}">${step.icon}${active ? `<span class="cycle-name">${step.label}</span>` : ''}</div>`;
      }).join('')}</div>
      <div class="turn-line">Round ${state.round}</div>
      <div class="turn-line player-${state.activePlayer}">
        ${player}'s Turn ${isAI ? '<span class="ai-badge">AI</span>' : ''}
      </div>
      <div class="actions-remaining">${diamonds}</div>
    `;
  }

  _renderObjectives() {
    const el = document.getElementById('node-status');
    if (!el) return;
    const state = this.state;

    let nodeDots = '';
    let witchCount = 0, heroCount = 0;
    for (const obj of state.witchObjectives) {
      const witchHere = state.entities.find(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row);
      const heroHere  = state.entities.find(e => e.alive && e.owner === 'hero'  && e.col === obj.col && e.row === obj.row);
      let cls;
      if (witchHere)      { cls = 'witch'; witchCount++; }
      else if (heroHere)  { cls = 'hero';  heroCount++;  }
      else                { cls = 'neutral'; }
      nodeDots += `<span class="node-dot ${cls}" title="${obj.label}"></span>`;
    }

    const score     = state.nodeScore ?? { hero: 0, witch: 0 };
    const scoreMax  = 4;
    const heroPips  = Array.from({ length: scoreMax }, (_, i) =>
      `<span class="score-pip hero${i < score.hero ? ' filled' : ''}"></span>`).join('');
    const witchPips = Array.from({ length: scoreMax }, (_, i) =>
      `<span class="score-pip witch${i < score.witch ? ' filled' : ''}"></span>`).join('');

    const html =
      `<span class="score-track hero-track" title="Hero score: ${score.hero}/4">${heroPips}</span>` +
      `<span class="node-dots-group">${nodeDots}</span>` +
      `<span class="score-track witch-track" title="Witch score: ${score.witch}/4">${witchPips}</span>`;

    const title = witchCount === 3 ? '⚠ Witch holds all nodes!'
                : heroCount  === 3 ? '★ Hero holds all nodes!'
                : 'Power Nodes';

    el.innerHTML = html;
    el.title = title;

    // Mirror to cycle-bar version shown on mobile
    const elBar = document.getElementById('node-status-bar');
    if (elBar) { elBar.innerHTML = html; elBar.title = title; }
  }

  _renderActionPanel() {
    // Show/hide the floating cancel pill and update its hint text
    const wrap = document.getElementById('cancel-wrap');
    const hint = document.getElementById('target-hint');
    if (!wrap) return;

    const targeting = this._awaitingTarget && !this._awaitingTarget.isDefault;
    wrap.classList.toggle('visible', !!targeting);

    if (targeting && hint) {
      const labels = {
        [ActionType.BATTLE]: 'Tap an enemy to attack',
        [ActionType.SUMMON]: 'Tap an adjacent empty hex',
      };
      hint.textContent = labels[this._awaitingTarget.actionType] ?? '';
    }
  }

  _renderEndTurnBtn() {
    const btn = document.getElementById('end-turn-btn');
    if (!btn) return;
    const state = this.state;

    if (this._planMode) {
      btn.disabled = this._planSubmitted || state.gameOver;
      btn.classList.toggle('urgent', !this._planSubmitted && !state.gameOver);
      btn.title = this._planSubmitted ? 'Plan submitted' : 'Submit Plan';
      btn.textContent = this._planSubmitted ? '✓' : '✓ Submit';
      return;
    }

    btn.textContent = '↩';
    const isOpponent = this._isOpponentTurn();
    const noActs    = state.actionsAvailable === 0;
    btn.disabled = state.gameOver || isOpponent;
    btn.classList.toggle('urgent', noActs && !isOpponent && !state.gameOver);
    btn.title = noActs ? 'End Turn (no actions left)' : 'End Turn Early';
  }

  _handleActionButton(button) {
    const action = button.dataset.action;
    const state  = this.state;
    const entity = this._selectedEntity;

    if (action === 'end_turn') {
      this._doEndTurn();
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

    if (action === 'tile_info') {
      _hideActionPopup();
      this._popupVisible = false;
      if (entity) this._showTileDetail({ col: entity.col, row: entity.row });
      return;
    }

    // In planning mode the human controls their faction; outside it the active player
    // is enforced by the turn system.
    const allowedOwner = this._planMode ? this._planFaction : state.activePlayer;
    if (!entity || entity.owner !== allowedOwner) return;

    // Any action button click closes the popup
    this._popupVisible = false;

    switch (action) {
      case 'explore': {
        _hideActionPopup();
        if (this._planMode) {
          this._addToPlan({ type: PlanActionType.EXPLORE, entityId: entity.id });
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar(); this.onRedraw(); break;
        }
        if (this.mp?.active) {
          this.mp.sendAction('explore', { entityId: entity.id });
          this._clearSelection(); this._updateSidebar(); this.onRedraw(); break;
        }
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
        if (this._planMode) {
          this._addToPlan({ type: PlanActionType.FORTIFY, entityId: entity.id });
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar(); this.onRedraw(); break;
        }
        if (this.mp?.active) {
          this.mp.sendAction('fortify', { entityId: entity.id });
          this._clearSelection(); this._updateSidebar(); this.onRedraw(); break;
        }
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
        const item = button.dataset.item;
        if (this._planMode) {
          this._addToPlan({ type: PlanActionType.USE_ITEM, entityId: entity.id, item });
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar(); this.onRedraw(); break;
        }
        if (this.mp?.active) {
          this.mp.sendAction('use_item', { entityId: entity.id, item });
          this._clearSelection(); this._updateSidebar(); this.onRedraw(); break;
        }
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
        if (this._planMode) {
          this._addToPlan({ type: PlanActionType.USE_ABILITY, entityId: entity.id });
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar(); this.onRedraw(); break;
        }
        if (this.mp?.active) {
          this.mp.sendAction('use_ability', { entityId: entity.id });
          this._clearSelection(); this._updateSidebar(); this.onRedraw(); break;
        }
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

    // Deduplicate: in online mode each server action re-sends the same hazard
    // arrays until the next turn, so we must not pop the dialog on every update.
    const hazardKey = `${state.round}|${hazardLog.map(e => (e.text ?? e)).join('~')}`;
    if (hazardKey === this._lastHazardKey) return;
    this._lastHazardKey = hazardKey;

    for (const pos of nightPositions) {
      if (pos.isFort) {
        // Fort degradation: subtle grey flash, small number
        this.renderer.addFlash(pos.col, pos.row, '🏰-1', 'rgba(120,120,140,0.5)', 1600, 0.55, 'rgba(180,180,200,1)');
      } else {
        // Unit damage: big bold number
        const dmg = pos.dmg || 1;
        this.renderer.addFlash(pos.col, pos.row, `-${dmg}`, 'rgba(80,0,160,0.6)', 2200, 1.4, 'rgba(210,140,255,1)');
      }
    }
    for (const pos of dayPositions) {
      const dmg = pos.dmg || 1;
      this.renderer.addFlash(pos.col, pos.row, `-${dmg}`, 'rgba(255,180,0,0.6)', 2200, 1.4, 'rgba(255,230,80,1)');
    }

    // Animate flashes while showing the dialog (skip in autoplay)
    if (!this.autoplay) {
      const endTime = Date.now() + 2200;
      const loop = () => {
        this.onRedraw();
        if (Date.now() < endTime) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    // Show a dialog summarising what happened, filtered to this player's own units.
    if (hazardLog.length) {
      const myId    = this.myPlayerId;
      const myLines = hazardLog
        .filter(e => !myId || !e.ownerId || e.ownerId === myId)
        .map(e => e.text ?? e);
      if (myLines.length) {
        const isNight = nightPositions.length > 0;
        const header  = isNight
          ? '🌙 Night falls — unprotected survivors suffer!'
          : '☀ Dawn breaks — witch minions caught in the open suffer!';
        this._showResultDialog([header, ...myLines], () => {
          this._updateSidebar();
          this.onRedraw();
        });
      }
    }
  }

  // ── Attrition popup ──────────────────────────────────────────────────────

  _showAttritionPopup() {
    const level = this.state.attritionLevel;
    const desc  = level === 1
      ? 'Exposed units suffer 1 damage each day and night.'
      : level === 2
        ? 'Exposed units now suffer 2 damage each day and night.'
        : `Exposed units suffer ${level} damage each day and night.`;
    this._showResultDialog([
      `🌑 The curse deepens — Salem's mystical energy grows stronger!`,
      ``,
      desc,
      `☀ Day: witch undead in the open take ${level} damage`,
      `🌙 Night: survivors in the open take ${level} damage`,
      `🏰 All fortifications degrade by 1 each night (minimum 1)`,
    ], () => {});
  }

  // ── Phase toast ──────────────────────────────────────────────────────────

  _showPhaseToast(faction) {
    const phase = this.state.phase;
    const PHASE_INFO = {
      dawn:  { icon: '🌅', label: 'Dawn',  lines: ['Hero gains +1 action · Attrition rises', 'Power Nodes scored · Tiles reset'] },
      day:   { icon: '☀️',  label: 'Day',   lines: ['Hero +1 ATK · Build & fortify', 'Witch undead in the open suffer'] },
      dusk:  { icon: '🌇', label: 'Dusk',  lines: ['Power Nodes scored · Seek shelter', 'Night approaches…'] },
      night: { icon: '🌙', label: 'Night', lines: ['Witch +1 ATK · Raise undead', 'Survivors in the open suffer'] },
    };
    const info = PHASE_INFO[phase];
    if (!info) return;

    // Remove any existing toast first
    document.getElementById('phase-toast')?.remove();

    const toast = document.createElement('div');
    toast.id = 'phase-toast';
    toast.className = `phase-toast phase-toast-${phase}`;
    toast.innerHTML = `
      <span class="phase-toast-icon">${info.icon}</span>
      <div class="phase-toast-body">
        <div class="phase-toast-title">${info.label} — Round ${this.state.round}</div>
        <div class="phase-toast-lines">${info.lines.join(' · ')}</div>
      </div>
    `;
    document.getElementById('game-screen')?.appendChild(toast);

    // Auto-dismiss after 3.2s
    setTimeout(() => toast.classList.add('phase-toast-hide'), 3200);
    setTimeout(() => toast.remove(), 3700);
  }

  // ── Scoring toast (dawn / dusk checkpoints) ──────────────────────────────

  showScoringToast(prevScore) {
    const state      = this.state;
    const phase      = state.phase; // 'dawn' or 'dusk' — already advanced by endRound()
    const phaseIcon  = phase === 'dawn' ? '🌅' : '🌇';
    const phaseLabel = phase === 'dawn' ? 'Dawn Reckoning' : 'Dusk Reckoning';

    // Count nodes held by each faction right now (same snapshot scoring used).
    const witchCount = state.witchObjectives.filter(obj =>
      state.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
    ).length;
    const heroCount = state.witchObjectives.filter(obj =>
      state.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row)
    ).length;

    const heroDelta  = state.nodeScore.hero  - prevScore.hero;
    const witchDelta = state.nodeScore.witch - prevScore.witch;

    let resultLine;
    if (witchDelta > 0) {
      resultLine = `Witch holds ${witchCount}–${heroCount} · Witch scores! (${state.nodeScore.witch}/4)`;
    } else if (heroDelta > 0) {
      resultLine = `Hero holds ${heroCount}–${witchCount} · Hero scores! (${state.nodeScore.hero}/4)`;
    } else if (witchCount === 3 || heroCount === 3) {
      resultLine = `All three nodes held — instant win!`;
    } else {
      resultLine = `Nodes tied ${heroCount}–${witchCount} · No score awarded`;
    }

    const pip = (filled, cls) =>
      `<span class="score-pip ${cls}${filled ? ' filled' : ''}"></span>`;
    const heroPips  = Array.from({ length: 4 }, (_, i) => pip(i < state.nodeScore.hero,  'hero')).join('');
    const witchPips = Array.from({ length: 4 }, (_, i) => pip(i < state.nodeScore.witch, 'witch')).join('');

    document.getElementById('score-toast')?.remove();

    const toast = document.createElement('div');
    toast.id        = 'score-toast';
    toast.className = `phase-toast score-toast score-toast-${phase}`;
    toast.innerHTML = `
      <span class="phase-toast-icon">${phaseIcon}</span>
      <div class="phase-toast-body">
        <div class="phase-toast-title">${phaseLabel}</div>
        <div class="phase-toast-lines">${resultLine}</div>
        <div class="score-toast-track">⚔ ${heroPips}&nbsp;&nbsp;${witchPips} ✦</div>
      </div>
    `;
    document.getElementById('game-screen')?.appendChild(toast);

    setTimeout(() => toast.classList.add('phase-toast-hide'), 3200);
    setTimeout(() => toast.remove(), 3700);
  }

  // ── Dialogs ───────────────────────────────────────────────────────────────

  _showResultDialog(messages, onDismiss, encounterSurvivor = null) {
    const dialog = document.getElementById('result-dialog');
    // Collapse consecutive duplicate lines into "message (×N)"
    const collapsed = [];
    for (const msg of messages) {
      const last = collapsed[collapsed.length - 1];
      if (last?.msg === msg) last.count++;
      else collapsed.push({ msg, count: 1 });
    }
    document.getElementById('result-messages').textContent =
      collapsed.map(({ msg, count }) => count > 1 ? `${msg} (×${count})` : msg).join('\n');
    document.getElementById('result-dismiss-hint').style.display = this.autoplay ? 'none' : '';
    const btns = document.getElementById('result-buttons');
    btns.style.display = 'none';
    btns.innerHTML = '';

    // Survivor portrait
    const portraitEl = document.getElementById('result-portrait');
    if (portraitEl) {
      const assetId = encounterSurvivor?.title ? _SURVIVOR_TITLE_ASSET[encounterSurvivor.title] : null;
      const src     = assetId ? this.renderer.getPortraitDataURL(assetId) : null;
      if (src) {
        portraitEl.style.display = 'block';
        portraitEl.innerHTML = `<img src="${src}" style="width:80px;height:80px;border-radius:50%;border:2px solid #c8a96e;display:block;">`;
      } else {
        portraitEl.style.display = 'none';
        portraitEl.innerHTML = '';
      }
    }

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

    if (this.autoplay) {
      setTimeout(dismiss, 500);
    } else {
      dialog.addEventListener('click', dismiss);
      document.addEventListener('keydown', keyDismiss);
    }
  }

  _maybeShowNoActionsDialog() {
    const state = this.state;
    if (state.gameOver) return;
    if (this._planMode) return; // planning phase handles its own budget UI
    if (state.actionsAvailable > 0) return;
    if (this._isOpponentTurn()) return;
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
        dialog.style.display = 'none';
        hint.style.display = '';
        btns.style.display = 'none';
        btns.innerHTML = '';
        if (this.mp?.active) {
          this.mp.sendAction('use_item', { entityId: state.hero.id, item: ResourceType.FOOD });
        } else {
          const result = executeUseItem(state, state.hero, ResourceType.FOOD);
          for (const msg of result.log) state.addLog(msg);
        }
        this._updateSidebar();
        this.onRedraw();
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
      this._doEndTurn();
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
    // Cancel any in-flight dice animation from a previous battle dialog
    if (this._battleInterval) { clearInterval(this._battleInterval); this._battleInterval = null; }

    const dialog = document.getElementById('battle-dialog');
    const footer = document.getElementById('battle-footer');

    // Summary line: "[Actor] attacks [Target], aided by …"
    const summaryEl = document.getElementById('battle-summary');
    if (summaryEl) {
      let summary = `${actorSnap.name} attacks ${targetSnap.name}`;
      const bd = result?.breakdown;
      if (bd?.atkAllyNames?.length) {
        const allies = bd.atkAllyNames.length === 1
          ? bd.atkAllyNames[0]
          : `${bd.atkAllyNames.length} allies`;
        summary += `, aided by ${allies}`;
      }
      if (bd?.defAllyNames?.length) {
        const allies = bd.defAllyNames.length === 1
          ? bd.defAllyNames[0]
          : `${bd.defAllyNames.length} allies`;
        summary += `; ${targetSnap.name} defended by ${allies}`;
      }
      summaryEl.textContent = summary;
    }

    // Populate combatant panels
    const atkPortrait = this.renderer.getPortraitDataURL(_entityPortraitId(actorSnap));
    const defPortrait = this.renderer.getPortraitDataURL(_entityPortraitId(targetSnap));
    document.getElementById('battle-attacker').innerHTML = _combatantHTML(actorSnap, 'atk', atkPortrait);
    document.getElementById('battle-defender').innerHTML = _combatantHTML(targetSnap, 'def', defPortrait);

    const atkDie  = document.getElementById('battle-atk-die');
    const defDie  = document.getElementById('battle-def-die');
    const outcome = document.getElementById('battle-outcome');
    outcome.textContent = '';
    outcome.className   = 'battle-outcome';
    footer.innerHTML    = this.autoplay ? '' : '<div class="result-dismiss">— click to continue —</div>';

    // Reset breakdown columns (hidden until dice settle)
    const atkBkd = document.getElementById('battle-atk-breakdown');
    const defBkd = document.getElementById('battle-def-breakdown');
    if (atkBkd) { atkBkd.innerHTML = ''; atkBkd.classList.remove('visible'); }
    if (defBkd) { defBkd.innerHTML = ''; defBkd.classList.remove('visible'); }

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

    // Shared: populate result into the dialog once dice are "settled"
    const revealResult = () => {
      atkDie.textContent = result.attackRoll;
      defDie.textContent = result.defenseRoll;
      atkDie.className = 'die-display' + (result.hit ? ' atk-win' : '');
      defDie.className = 'die-display' + (!result.hit ? ' def-win' : '');

      // Populate and fade-in breakdown columns
      const bd = result.breakdown;
      if (bd) {
        document.getElementById('battle-atk-breakdown').innerHTML =
          _buildBreakdownHTML(actorSnap, bd, 'atk', result.attackRoll);
        document.getElementById('battle-def-breakdown').innerHTML =
          _buildBreakdownHTML(targetSnap, bd, 'def', result.defenseRoll);
        // Double-rAF ensures a paint happens before adding visible,
        // so the opacity 0→1 transition fires reliably.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.getElementById('battle-atk-breakdown').classList.add('visible');
          document.getElementById('battle-def-breakdown').classList.add('visible');
        }));
      }

      if (result.killed) {
        const dmgNote = result.damage > 0 ? ` (${result.damage} damage)` : '';
        outcome.textContent = `💀 ${targetSnap.name} is slain!${dmgNote}`;
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

      const fill = dialog.querySelector('.combatant-panel:last-of-type .combatant-hp-fill');
      if (fill) {
        const newHp = result.killed ? 0 : Math.max(0, targetSnap.hp - (result.damage || 0));
        fill.style.width = `${Math.max(0, (newHp / targetSnap.maxHp) * 100)}%`;
      }
      if (result.counterDmg > 0) {
        const atkFill = dialog.querySelector('.combatant-panel:first-of-type .combatant-hp-fill');
        if (atkFill) {
          const newHp = Math.max(0, actorSnap.hp - result.counterDmg);
          atkFill.style.width = `${Math.max(0, (newHp / actorSnap.maxHp) * 100)}%`;
        }
      }

      const left = this.state.actionsLeft;
      const actsEl = document.createElement('div');
      actsEl.className = 'battle-actions-left';
      actsEl.innerHTML = left > 0 ? '◆'.repeat(left) : '◇';
      footer.insertBefore(actsEl, footer.firstChild);

      if (onRematch && !this.autoplay) {
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
    };

    if (this.autoplay) {
      // Skip animation — show result immediately, auto-dismiss after 500ms
      atkDie.textContent = result.attackRoll;
      defDie.textContent = result.defenseRoll;
      atkDie.className = 'die-display' + (result.hit ? ' atk-win' : '');
      defDie.className = 'die-display' + (!result.hit ? ' def-win' : '');
      revealResult();
      setTimeout(dismiss, 500);
    } else {
      // Animated dice roll
      atkDie.textContent = '?';
      defDie.textContent = '?';
      atkDie.className   = 'die-display rolling';
      defDie.className   = 'die-display rolling';
      let ticks = 0;
      const maxTicks = 14;
      this._battleInterval = setInterval(() => {
        ticks++;
        atkDie.textContent = Math.ceil(Math.random() * 20);
        defDie.textContent = Math.ceil(Math.random() * 20);
        if (ticks >= maxTicks) {
          clearInterval(this._battleInterval);
          this._battleInterval = null;
          revealResult();
        }
      }, 55);
      // Allow dismiss only after dice settle
      setTimeout(() => {
        dialog.addEventListener('click', dismiss);
        document.addEventListener('keydown', keyDismiss);
      }, maxTicks * 55 + 200);
    }
  }

  // Single entry point for all AI turns — safe to call anytime
  _maybeRunAI(delayMs = 400) {
    if (this.state.gameOver) return;
    const ms = this.autoplay ? 50 : delayMs;
    const ap = this.state.activePlayer;
    if (ap === Player.WITCH && this.state.witchIsAI && this.ai) {
      setTimeout(() => this._runAI(), ms);
    } else if (ap === Player.HERO && this.state.heroIsAI && this.heroAI) {
      setTimeout(() => this._runHeroAI(), ms);
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

  _showTileDetail(hex) {
    const state   = this.state;
    const tile    = state.tiles.get(hexKey(hex.col, hex.row));
    const overlay = document.getElementById('tile-zoom-overlay');
    if (!overlay || !tile) return;

    // ── Tile color map matching renderer ──
    const TILE_COLOR_MAP = {
      [TileType.GRASS]:    '#3a5430',
      [TileType.FOREST]:   '#1b2e1a',
      [TileType.DIRT]:     '#7a6a48',
      [TileType.ROAD]:     '#6b5a3e',
      [TileType.RIVER]:    '#1a3d5c',
      [TileType.BRIDGE]:   '#1a3d5c',
      [TileType.BUILDING]: '#6e6e6e',
    };
    const TERRAIN_ICON = {
      [TileType.GRASS]:  '🌿',
      [TileType.FOREST]: '🌲',
      [TileType.DIRT]:   '🪨',
      [TileType.ROAD]:   '🛤',
      [TileType.RIVER]:  '💧',
      [TileType.BRIDGE]: '🌉',
    };

    // ── SVG hex elements ──
    const polyEl = document.getElementById('tile-zoom-poly');
    const fortEl = document.getElementById('tile-zoom-fort');
    const iconEl = document.getElementById('tile-zoom-icon');

    const fillColor = TILE_COLOR_MAP[tile.type] ?? '#3a5430';
    if (polyEl) polyEl.setAttribute('fill', fillColor);

    // Icon: building emoji or terrain fallback
    const icon = tile.building ? (BUILDING_ICON[tile.building] ?? '🏠')
                                : (TERRAIN_ICON[tile.type] ?? '');
    if (iconEl) iconEl.textContent = icon;

    // Fortification glow ring
    if (fortEl) {
      if (tile.explored && tile.fortifyLevel) {
        const isMetal = tile.fortifyLevel >= 2;
        fortEl.setAttribute('stroke', isMetal ? 'rgba(120,240,255,0.85)' : 'rgba(255,215,80,0.85)');
        fortEl.style.display = '';
      } else {
        fortEl.style.display = 'none';
      }
    }

    // ── Label box ──
    const nameEl  = document.getElementById('tile-zoom-tile-name');
    const linesEl = document.getElementById('tile-zoom-info-lines');

    if (nameEl) {
      nameEl.textContent = tile.building ? (BUILDING_LABEL[tile.building] ?? tile.type)
                                         : tile.type;
    }

    const obj       = state.witchObjectives.find(o => o.col === hex.col && o.row === hex.row);
    let linesHtml   = '';

    if (obj) {
      const witchHere = state.entities.find(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row);
      const heroHere  = state.entities.find(e => e.alive && e.owner === 'hero'  && e.col === obj.col && e.row === obj.row);
      const ctrl = witchHere ? '🔴 Witch' : heroHere ? '🔵 Hero' : '⭕ Contested';
      linesHtml += `<div class="tile-zoom-info-line node">⚔ Power Node — ${ctrl}</div>`;
    }
    if (tile.explored && tile.fortifyLevel) {
      const fl = tile.fortifyLevel >= 3 ? `⚙⚙ Heavily Reinforced (+${tile.fortifyLevel} DEF)`
               : tile.fortifyLevel >= 2 ? `⚙ Metal Reinforced (+${tile.fortifyLevel} DEF)`
               : `🪵 Fortified (+${tile.fortifyLevel} DEF)`;
      linesHtml += `<div class="tile-zoom-info-line fortified">${fl}</div>`;
    }
    if (!tile.explored) linesHtml += `<div class="tile-zoom-info-line">— unexplored —</div>`;
    if (!linesHtml) linesHtml = `<div class="tile-zoom-info-line" style="color:#554">(no special properties)</div>`;

    if (linesEl) linesEl.innerHTML = linesHtml;

    // ── Units ──
    const visible  = _visibleUnitsAt(state, hex.col, hex.row);
    const planOwner = this._planMode ? this._planFaction : state.activePlayer;
    const myUnits  = visible.filter(u => u.owner === planOwner);
    const foeUnits = visible.filter(u => u.owner !== planOwner);
    const unitsEl  = document.getElementById('tile-zoom-units');

    if (unitsEl) {
      let html = '';
      if (visible.length) html += `<div class="tile-units-heading">Units</div>`;
      for (const u of myUnits) {
        const col    = ENTITY_COLOR[u.type] || '#888';
        const hearts = '♥'.repeat(u.hp) + '♡'.repeat(Math.max(0, u.maxHp - u.hp));
        const atkStr = `${u.attack}${u.attackBonus ? `+${u.attackBonus}` : ''}`;
        const defStr = `${u.defense}${u.defenseBonus ? `+${u.defenseBonus}` : ''}`;
        const label  = u.type === EntityType.SURVIVOR && u.name ? u.name : u.displayName;
        html += `<div class="tile-unit-card selectable" data-unit-id="${u.id}">
          <span class="tile-unit-card-name" style="color:${col}">${label}</span>
          <span class="tile-unit-card-stats">${hearts} · ATK ${atkStr} · DEF ${defStr}</span>
        </div>`;
      }
      for (const u of foeUnits) {
        const col    = ENTITY_COLOR[u.type] || '#888';
        const hearts = '♥'.repeat(u.hp) + '♡'.repeat(Math.max(0, u.maxHp - u.hp));
        html += `<div class="tile-unit-card">
          <span class="tile-unit-card-name" style="color:${col}">${u.displayName}</span>
          <span class="tile-unit-card-stats">${hearts}</span>
        </div>`;
      }
      unitsEl.innerHTML = html;
      unitsEl.querySelectorAll('.tile-unit-card.selectable').forEach(card => {
        card.addEventListener('click', () => {
          const unit = state.entities.find(e => e.id === card.dataset.unitId);
          if (unit) {
            this._hideTileDetail();
            this._selectEntity(unit);
            this._updateSidebar();
            this.onRedraw();
          }
        });
      });
    }

    overlay.classList.add('visible');
  }

  _hideTileDetail() {
    document.getElementById('tile-zoom-overlay')?.classList.remove('visible');
  }

  _toggleChronicle() {
    const overlay = document.getElementById('chronicle-overlay');
    if (!overlay) return;
    overlay.classList.toggle('visible');
    if (overlay.classList.contains('visible')) {
      this._renderLog(); // rebuild full log before showing
    }
  }

  _renderInventory() {
    const el    = document.getElementById('inventory-content');
    const title = document.getElementById('inventory-title');
    if (!el) return;

    const state   = this.state;
    const faction = this._planFaction ?? (state.activePlayer === Player.HERO ? 'hero' : 'witch');
    const isHero  = faction === 'hero';
    const inv     = state.inventory;
    const stash  = isHero ? inv.shared : inv.witch;

    if (title) title.textContent = isHero ? '⚔ Hero Supplies' : '🕯 Witch Stores';

    const entries = Object.entries(stash).filter(([, v]) => v > 0);
    if (!entries.length) {
      el.innerHTML = `<div class="inv-empty">Nothing held.</div>`;
      return;
    }
    el.innerHTML = entries.map(([k, v]) =>
      `<div class="inv-resource-row">
        <span class="inv-resource-label">${RESOURCE_LABEL[k] || k}</span>
        <span class="inv-resource-val">×${v}</span>
      </div>`
    ).join('');
  }

  _toggleInventory() {
    const overlay = document.getElementById('inventory-overlay');
    if (!overlay) return;
    overlay.classList.toggle('visible');
    if (overlay.classList.contains('visible')) this._renderInventory();
  }

  /** Return the text of a log entry, handling both string and {text,owner} formats. */
  _logText(entry) {
    return typeof entry === 'string' ? entry : entry.text;
  }

  /** Filter log entries to only those the current player can see. */
  _visibleLog() {
    const log = this.state?.log ?? [];
    if (!this.state?.fogOfWar) return log;
    const myFaction = this._planFaction
      ?? (this.state.heroIsAI === false ? 'hero' : 'witch');
    return log.filter(entry => {
      if (typeof entry === 'string') return true; // untagged entries are always visible
      return !entry.owner || entry.owner === myFaction;
    });
  }

  _renderLog() {
    const el = document.getElementById('event-log');
    if (!el) return;
    const visible = this._visibleLog();
    el.innerHTML = visible.map(m =>
      `<div class="log-entry">${this._logText(m)}</div>`
    ).join('');
    el.scrollTop = el.scrollHeight;

    this._renderMiniChronicle();
  }

  _renderMiniChronicle() {
    const el = document.getElementById('chronicle-mini');
    if (!el) return;
    const visible = this._visibleLog();
    const last5 = visible.slice(-5);
    el.innerHTML = last5
      .map(m => `<div class="mini-log-entry">${this._logText(m)}</div>`)
      .join('');
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
  const myFaction    = state.myFaction;
  const humanIsHero  = myFaction ? myFaction === 'hero'  : (state.witchIsAI && !state.heroIsAI);
  const humanIsWitch = myFaction ? myFaction === 'witch' : (state.heroIsAI  && !state.witchIsAI);
  const revealed = humanIsHero  ? getVisibleEnemyHexes(state)
                 : humanIsWitch ? getVisibleHeroHexes(state)
                 : null;
  return state.entities.filter(e => {
    if (!e.alive || e.col !== col || e.row !== row) return false;
    if (revealed) {
      const hiddenOwner = humanIsHero ? 'witch' : 'hero';
      if (e.owner === hiddenOwner) return revealed.has(hexKey(col, row));
    }
    return true;
  });
}

// ── Tilemap sprite helpers ────────────────────────────────────────────────────

const _SURVIVOR_TITLE_ASSET = {
  'Innkeeper':        'survivor_innkeeper',
  'Nurse':            'survivor_nurse',
  'Blacksmith':       'survivor_blacksmith',
  'Herbalist':        'survivor_herbalist',
  'Militia Sergeant': 'survivor_militia',
  'Parish Priest':    'survivor_priest',
  'Baker':            'survivor_baker',
  'Trapper':          'survivor_trapper',
  'Schoolteacher':    'survivor_schoolteacher',
  'Gravedigger':      'survivor_gravedigger',
  'Midwife':          'survivor_midwife',
  'Farmhand':         'survivor_farmhand',
};

/** Return the tilemap asset id for any entity snap (uses title for survivors). */
function _entityPortraitId(snap) {
  if (snap.type === 'survivor') return _SURVIVOR_TITLE_ASSET[snap.title] ?? null;
  return snap.type; // 'hero', 'witch', 'zombie', etc.
}

function _snapEntity(e) {
  return { id: e.id, name: e.displayName, hp: e.hp, maxHp: e.maxHp, attack: e.attack, defense: e.defense, type: e.type, title: e.title ?? null };
}

function _combatantHTML(snap, role, portraitSrc = null) {
  const label      = role === 'atk' ? '⚔ Attacker' : '🛡 Defender';
  const color      = ENTITY_COLOR[snap.type] || '#888';
  const hpPct      = (snap.hp / snap.maxHp) * 100;
  const hpColor    = hpPct > 50 ? '#4caf50' : hpPct > 25 ? '#ff9800' : '#f44336';
  const portraitHtml = portraitSrc
    ? `<img src="${portraitSrc}" style="width:56px;height:56px;border-radius:50%;border:2px solid ${color};display:block;margin:0 auto 0.35rem;">`
    : '';
  return `
    ${portraitHtml}
    <div class="combatant-name" style="color:${color}">${snap.name}</div>
    <div style="font-size:0.68rem;color:#7a7060;margin-bottom:0.3rem">${label}</div>
    <div class="combatant-stats">HP: ${snap.hp}/${snap.maxHp} · ATK: ${snap.attack} · DEF: ${snap.defense}</div>
    <div class="combatant-hp-bar">
      <div class="combatant-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div>
    </div>
  `;
}

// Build the per-side roll breakdown HTML for the battle dialog.
// side: 'atk' | 'def'   total: the final roll total shown in the die box
function _buildBreakdownHTML(snap, bd, side, total) {
  const row = (label, val, isDie = false) => {
    const valHtml = isDie
      ? `<span class="bkd-val bkd-die">${val}</span>`
      : `<span class="bkd-val">${val >= 0 ? '+' + val : val}</span>`;
    return `<div class="bkd-row"><span class="bkd-label">${label}</span>${valHtml}</div>`;
  };

  const parts = [];
  if (side === 'atk') {
    parts.push(row('Base d6', bd.atkBaseDie, true));
    parts.push(row(`${snap.name} ATK`, snap.attack));
    if (bd.phaseBonus)    parts.push(row('☀ Day', bd.phaseBonus));
    if (bd.atkStaffBonus) parts.push(row('⚕ Staff (undead)', bd.atkStaffBonus));
    bd.atkExtraDice.forEach((r, i) => {
      parts.push(row(`${bd.atkAllyNames[i] ?? 'Ally'} (D3)`, r, true));
    });
  } else {
    parts.push(row('Base d6', bd.defBaseDie, true));
    parts.push(row(`${snap.name} DEF`, snap.defense));
    if (bd.fortBonus) parts.push(row(`🏰 Fort ×${bd.fortBonus}`, bd.fortBonus));
    bd.defExtraDice.forEach((r, i) => {
      parts.push(row(`${bd.defAllyNames[i] ?? 'Ally'} (D3)`, r, true));
    });
  }

  parts.push(`<hr class="bkd-divider">`);
  parts.push(`<div class="bkd-total-row"><span class="bkd-label">Total</span><span class="bkd-val">${total}</span></div>`);
  return parts.join('');
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

  // In planning mode, show popup at the entity's projected (ghost) position
  let displayCol = target.col;
  let displayRow = target.row;
  if (ui._planMode && ui._selectedEntity) {
    const proj = ui._getProjectedPos(ui._selectedEntity.id);
    if (proj) { displayCol = proj.col; displayRow = proj.row; }
  }

  const canvasRect = ui.canvas.getBoundingClientRect();
  const { x, y }   = ui.renderer.hexToCanvasPos(displayCol, displayRow);
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
