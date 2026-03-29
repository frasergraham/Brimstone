// UI controller: handles canvas clicks, sidepanel updates, action buttons
import { hexKey, hexToPixel, MAP_COLS, MAP_ROWS } from './hex.js';
import { TileType, BUILDING_LABEL, BUILDING_ICON, RESOURCE_LABEL, WEAPON_LABEL, ResourceType } from './tiles.js';
import { EntityType, SurvivorAbility, ENTITY_COLOR } from './entities.js';
import { Phase, Player, PHASE_ICON, nodeController } from './game.js';
import { PAD_X, PAD_Y } from './renderer.js';
import {
  ActionType, getValidActions, getVisibleEnemyHexes, getVisibleHeroHexes,
  executeMove, executeExplore, executeBattle,
  executeFortify, executeSummon, executeUseItem, executeUseAbility,
} from './actions.js';
import { PlanActionType, computeGhostState, computeProjectedInventory } from './planner.js';
import { compileTurnBattleSummary } from './battle-utils.js';
import { ResEventType } from '../server/resolver.js';
import { collectUIElements } from './ui-elements.js';
import { buildPlanStepsHtml, buildPlayerStatusHtml, buildObjectivesHtml } from './ui-render.js';

/** Enum of UI operating modes. */
export const UIMode = Object.freeze({ LOCAL: 'local', ONLINE: 'online', SPECTATOR: 'spectator' });

export class UIController {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object}            state
   * @param {object}            renderer
   * @param {object|null}       witchAI
   * @param {function}          onRedraw
   * @param {object|null}       [heroAI]
   * @param {boolean}           [autoplay]
   * @param {object|null}       [els]  Pre-collected element bag from collectUIElements().
   *                                   Pass a fake bag in tests to avoid touching document.
   */
  constructor(canvas, state, renderer, witchAI, onRedraw, heroAI = null, autoplay = false, els = null) {
    this.canvas    = canvas;
    this.state     = state;
    this.renderer  = renderer;
    this.ai        = witchAI;
    this.heroAI    = heroAI;
    this.onRedraw  = onRedraw;
    this.autoplay  = autoplay;
    this.mp        = null;  // set externally when in online mode

    // Injected element bag — tests supply fake elements keyed by DOM ID.
    // Falls back to document.getElementById at each call site when missing.
    this._els = els ?? {};

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
    this.speedMode         = 'cinematic'; // 'step' | 'cinematic' | 'fast' | 'vfast'
    this._stepResolve      = null;        // set while waiting for click-to-advance in step mode
    // Start with chronicle hidden on small screens (≤768px)
    this._chronicleMode    = window.innerWidth <= 768 ? 'none' : 'mini'; // 'none' | 'mini' | 'full'
    // When true, disable all planning/action UI — used for spectator mode
    this.spectator         = false;
    // When true, suppress phase modals and auto-select — used for tutorial mode
    this.tutorialMode      = false;

    // ── Planning mode state ──────────────────────────────────────────────────
    this._planMode      = false;   // true during simultaneous planning phase
    this._plan          = [];      // queued PlanActions for this round
    this._planFaction   = null;    // 'hero' or 'witch' — which faction we're planning for
    this._planBudget    = 0;       // total action budget for this round
    this._planSubmitted = false;   // true after plan is locked in
    this.onPlanSubmit   = null;    // callback(plan) — set by main.js

    // ── Multiplayer ──────────────────────────────────────────────────────────
    this.myPlayerId     = null;    // UUID of the local player (null in offline mode)
    this._players       = [];      // full player roster [{playerId,name,faction,isAI}]
    this._countdownTimer = null;   // setInterval handle for countdown display

    this._bindEvents();
  }

  // ── Element access ───────────────────────────────────────────────────────────

  /**
   * Look up a DOM element by its HTML id string.
   * Returns the element from the injected `_els` bag when available
   * (used in tests), otherwise falls back to document.getElementById.
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  _el(id) {
    return (id in this._els) ? this._els[id] : document.getElementById(id);
  }

  // ── Mode management ──────────────────────────────────────────────────────────

  /**
   * Switch UI operating mode at runtime.
   * Replaces the scattered `this.spectator` / `this.mp` / `this.myPlayerId`
   * flag checks with a single mode enum so transitions (e.g. dead → spectator)
   * can happen without a page reload.
   *
   * @param {string}       mode       UIMode.LOCAL | UIMode.ONLINE | UIMode.SPECTATOR
   * @param {object}       [opts]
   * @param {object|null}  [opts.mp]          MultiplayerClient reference (online only)
   * @param {string|null}  [opts.myPlayerId]  Local player UUID (online only)
   * @param {Array}        [opts.players]     Full player roster (online only)
   */
  setMode(mode, { mp = null, myPlayerId = null, players = [] } = {}) {
    this.spectator   = (mode === UIMode.SPECTATOR);
    this.mp          = mp;
    this.myPlayerId  = myPlayerId;
    this._players    = players;
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
      if (this.renderer.viewLocked) return;
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
    this._el('zoom-in')?.addEventListener('click', () => {
      const cx = this.canvas.width  / 2;
      const cy = this.canvas.height / 2;
      this.renderer.setZoom(this.renderer.zoomLevel * zoomStep, cx, cy);
      this.onRedraw();
    });
    this._el('zoom-out')?.addEventListener('click', () => {
      const cx = this.canvas.width  / 2;
      const cy = this.canvas.height / 2;
      this.renderer.setZoom(this.renderer.zoomLevel / zoomStep, cx, cy);
      this.onRedraw();
    });
    this._lastFitTapTime = 0;
    this._el('zoom-fit')?.addEventListener('click', () => {
      const now = Date.now();
      const isDoubleTap = (now - this._lastFitTapTime) < 400;
      this._lastFitTapTime = now;
      if (isDoubleTap) {
        // Double-tap: toggle view lock; fit map first if locking
        this.renderer.viewLocked = !this.renderer.viewLocked;
        if (this.renderer.viewLocked) {
          this.renderer.resize();
          this.renderer.resetView();
          this.renderer._zoomAnim = null;
        }
        this._updateFitBtnLockState();
        this.onRedraw();
      } else if (!this.renderer.viewLocked) {
        // Single-tap when unlocked: fit map
        this.renderer.resize();
        this.renderer.resetView();
        this.onRedraw();
      }
    });
    this._el('zoom-me')?.addEventListener('click', () => {
      if (this._selectedEntity && this._selectedEntity.alive) {
        // Zoom to selected unit
        const pos = this._planMode ? (this._getProjectedPos(this._selectedEntity.id) ?? this._selectedEntity) : this._selectedEntity;
        this.renderer.frameHexes([pos], { maxZoom: 2.0, paddingHexes: 3, duration: 400 });
      } else {
        // No selection — frame all player's units
        const faction = this._planFaction ?? (!this.state.heroIsAI ? 'hero' : 'witch');
        const units   = this.state.entities.filter(e => e.alive && e.owner === faction);
        if (units.length > 0) this.renderer.frameHexes(units, { maxZoom: 1.8, paddingHexes: 2.5, duration: 400 });
      }
      this.onRedraw();
    });
    this._el('speed-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleSpeedPopup();
    });
    // Speed popup option clicks
    this._el('speed-popup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.speed-option');
      if (btn) this._setSpeed(btn.dataset.mode);
    });
    // Step-by-step continue bar click
    this._el('step-continue-bar')?.addEventListener('click', () => this._clearStepContinue());

    // Close speed popup on outside click
    document.addEventListener('click', () => this._closeSpeedPopup());

    // Chronicle toggle in map controls area
    this._el('chronicle-toggle')?.addEventListener('click', () => this._cycleChronicle());

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
      if (this.renderer.viewLocked) return;
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

    // In-game menu
    this._el('menu-btn')?.addEventListener('click', () => {
      const popup = this._el('game-menu-popup');
      if (popup) popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
    });
    this._el('menu-quit-btn')?.addEventListener('click', () => {
      const popup = this._el('game-menu-popup');
      if (popup) popup.style.display = 'none';
      this.onQuitToMenu?.();
    });
    document.addEventListener('click', e => {
      const popup = this._el('game-menu-popup');
      if (!popup || popup.style.display === 'none') return;
      const btn = this._el('menu-btn');
      if (!popup.contains(e.target) && e.target !== btn) popup.style.display = 'none';
    });
    // Mobile: canvas touchend calls e.preventDefault() which suppresses the
    // synthesized click, so the click handler above never fires when tapping
    // the canvas with the menu open. Use touchstart (fires before preventDefault)
    // to close the popup on outside touches.
    document.addEventListener('touchstart', e => {
      const popup = this._el('game-menu-popup');
      if (!popup || popup.style.display === 'none') return;
      const btn = this._el('menu-btn');
      if (!popup.contains(e.target) && e.target !== btn) popup.style.display = 'none';
    }, { passive: true });

    // Edge swipe: swipe left from right edge opens plan panel, swipe right closes it
    this._edgeSwipe = null;
    document.addEventListener('touchstart', e => {
      if (!this._planMode || e.touches.length !== 1) return;
      const t = e.touches[0];
      const edgeZone = 30; // px from right edge
      const panel = this._el('plan-panel');
      if (!panel) return;
      const isCollapsed = panel.classList.contains('collapsed');
      // Start tracking if near right edge (to open) or panel is expanded (to close)
      if (t.clientX >= window.innerWidth - edgeZone || !isCollapsed) {
        this._edgeSwipe = { startX: t.clientX, startY: t.clientY, collapsed: isCollapsed };
      }
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!this._edgeSwipe) return;
      const t = e.touches[0];
      const dy = Math.abs(t.clientY - this._edgeSwipe.startY);
      // Cancel if vertical movement exceeds horizontal (scrolling)
      if (dy > 60) { this._edgeSwipe = null; }
    }, { passive: true });
    document.addEventListener('touchend', e => {
      if (!this._edgeSwipe) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - this._edgeSwipe.startX;
      const threshold = 50;
      const panel = this._el('plan-panel');
      if (panel && this._edgeSwipe.collapsed && dx < -threshold) {
        // Swiped left from right edge — open panel
        panel.classList.remove('collapsed');
        this._syncPlanInset();
        this._renderPlanPanel();
      } else if (panel && !this._edgeSwipe.collapsed && dx > threshold) {
        // Swiped right — close panel
        panel.classList.add('collapsed');
        this._syncPlanInset();
        this._renderPlanPanel();
      }
      this._edgeSwipe = null;
    }, { passive: true });

    // Chronicle: three-state button lives inside #chronicle-mini (wired on each render).
    // chronicle-close / chronicle-sidebar-close close back to 'none'.
    this._el('chronicle-close')?.addEventListener('click', () => {
      this._setChronicleMode('none');
    });
    this._el('chronicle-overlay')?.addEventListener('click', e => {
      if (e.target === this._el('chronicle-overlay')) this._setChronicleMode('none');
    });
    this._el('chronicle-sidebar-close')?.addEventListener('click', () => {
      this._setChronicleMode('none');
    });


    // Tile zoom close
    this._el('tile-zoom-close')?.addEventListener('click', () => this._hideTileDetail());
    this._el('tile-zoom-overlay')?.addEventListener('click', e => {
      if (e.target === this._el('tile-zoom-overlay')) this._hideTileDetail();
    });

    // Cancel-action pill (floating over canvas during battle/summon targeting)
    this._el('cancel-action-btn')?.addEventListener('click', () => {
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
    this._el('end-turn-btn')?.addEventListener('click', () => {
      if (this.state.gameOver) return;
      if (this._planMode) { this._doSubmitPlan(); return; }
      if (this._isOpponentTurn()) return;
      this._doEndTurn();
    });

    // Plan panel buttons
    this._el('plan-submit-btn')?.addEventListener('click', () => this._doSubmitPlan());
    this._el('plan-clear-btn')?.addEventListener('click',  () => {
      if (this._planSubmitted) return;
      this._plan = [];
      this._refreshPlanOverlay();
      this._renderPlanPanel();
      if (this._selectedEntity) this._selectEntity(this._selectedEntity);
      this.onRedraw();
    });
    this._el('plan-toggle-btn')?.addEventListener('click', () => this._togglePlanPanel());
    this._el('plan-tab')?.addEventListener('click',        () => this._togglePlanPanel());
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
    if (this._mouseDown && this.renderer.viewLocked) {
      this._mouseDown = null; // release drag if view was locked mid-drag
    }
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

    const panel = this._el('plan-panel');
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
    // Plan panel overlays the right side of the canvas — bias framing away from it
    this._syncPlanInset();

    this._clearSelection();

    // Auto-select the leader on round 1 so the player knows which unit is
    // theirs (especially important in team MP).  After round 1 it's annoying
    // because it overrides whatever the player was looking at.
    // Tutorial mode skips this — the "select your hero" step teaches clicking.
    if (!this.tutorialMode && (this.state?.round ?? 1) <= 1) {
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

    // Show a dismissible phase-info modal so the player always knows current conditions.
    this._showPhaseModal(faction, budget);

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

    const panel = this._el('plan-panel');
    if (panel) { panel.style.display = 'none'; panel.classList.remove('collapsed'); }

    if (this.renderer) {
      this.renderer.planGhostSteps = null;
      this.renderer.insetRight = 0;
    }
    this._clearSelection();
    this._updateSidebar();
    this.onRedraw();
  }

  // ── Multiplayer player-status panel ────────────────────────────────────────

  /** Render the list of players and their submission state into #plan-players. */
  _renderPlayerStatus() {
    const el = this._el('plan-players');
    if (!el) return;

    const players = this._players ?? [];
    if (players.length <= 1) {
      el.style.display = 'none';
      return;
    }

    el.style.display = '';
    el.innerHTML = buildPlayerStatusHtml(players, this.myPlayerId);
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
    const el    = this._el('plan-countdown');
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
    const el = this._el('plan-countdown');
    if (el) { el.style.display = 'none'; el.textContent = ''; }
  }

  /** Add one action to the plan queue. */
  _addToPlan(action) {
    if (this._planSubmitted) return;
    this._plan.push(action);
    this.onPlanActionAdded?.(action);
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

    const panel = this._el('plan-panel');
    if (panel) panel.classList.add('plan-submitted');

    const status = this._el('plan-status');
    if (status) status.textContent = 'Waiting for opponents…';

    // Mark ourselves as submitted in the player list so the status panel updates.
    const me = this._players?.find(p => p.playerId === this.myPlayerId);
    if (me) me._submitted = true;
    this._renderPlayerStatus();

    this._updateSidebar();
    this.onRedraw();

    if (this.onPlanSubmit) this.onPlanSubmit([...this._plan]);
  }

  /** Render the plan panel steps list. */
  _renderPlanPanel() {
    const stepsEl  = this._el('plan-steps');
    const budgeEl  = this._el('plan-budget-badge');
    const statusEl = this._el('plan-status');
    if (!stepsEl) return;

    // Count budget-consuming actions
    const budgetCost = this._plan.filter(a =>
      a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM
    ).length;
    const remaining = this._planBudget - budgetCost;

    if (budgeEl) budgeEl.textContent = `${Math.max(0, remaining)} left`;

    // Food is auto-applied to over-budget actions until exhausted.
    const foodAvailable = (this.state.inventory?.shared?.[ResourceType.FOOD] || 0);

    const initialInv = computeProjectedInventory(this.state, []);
    stepsEl.innerHTML = buildPlanStepsHtml(
      this._plan, this._planBudget, foodAvailable, foodAvailable,
      this._planSubmitted, this.state.entities ?? [], initialInv,
    );

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

    // Clear the old food row (food is now shown inline on over-budget actions)
    const foodRowEl = this._el('plan-food-row');
    if (foodRowEl) foodRowEl.innerHTML = '';

    if (statusEl && !this._planSubmitted) statusEl.textContent = '';

    // Keep the collapse-tab count badge in sync — show count and color by budget state
    const tabCount = this._el('plan-tab-count');
    if (tabCount) {
      const budgetCost = this._plan.filter(a =>
        a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM
      ).length;
      tabCount.textContent = budgetCost;
      const foodAvail = this.state?.inventory?.shared?.[ResourceType.FOOD] || 0;
      if (budgetCost > this._planBudget + foodAvail) {
        tabCount.className = 'plan-tab-count plan-tab-over';
      } else if (budgetCost > this._planBudget) {
        tabCount.className = 'plan-tab-count plan-tab-food';
      } else {
        tabCount.className = 'plan-tab-count plan-tab-ok';
      }
    }

    // Update collapse-button arrow direction
    const panel = this._el('plan-panel');
    const toggleBtn = this._el('plan-toggle-btn');
    if (toggleBtn && panel) {
      toggleBtn.textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
    }

    // Render inventory section at the bottom of the plan panel
    this._renderInventory();
  }

  /** Toggle the plan panel between expanded and collapsed. */
  _togglePlanPanel() {
    const panel = this._el('plan-panel');
    if (!panel) return;
    panel.classList.toggle('collapsed');
    const isCollapsed = panel.classList.contains('collapsed');
    const toggleBtn = this._el('plan-toggle-btn');
    if (toggleBtn) toggleBtn.textContent = isCollapsed ? '▶' : '◀';
    this._syncPlanInset();
  }

  /** Update renderer.insetRight based on whether the plan panel is visible and expanded. */
  _syncPlanInset() {
    if (!this.renderer) return;
    const panel = this._el('plan-panel');
    const visible = panel && panel.style.display !== 'none' && !panel.classList.contains('collapsed');
    this.renderer.insetRight = visible ? 220 : 0;
  }

  _onClick(e) {
    if (this._didDragPan) { this._didDragPan = false; return; }
    if (this._stepResolve) { this._stepResolve(); return; }
    if (this.state.gameOver) return;

    const { x, y } = this._canvasPos(e);
    const hex = this._canvasToHex(x, y);
    if (hex.col < 0 || hex.col >= MAP_COLS || hex.row < 0 || hex.row >= MAP_ROWS) return;

    // Spectators: view tile/unit info only — no actions or planning
    if (this.spectator) {
      this._showTileDetail(hex);
      this.onRedraw();
      return;
    }

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
        // Second tap on already-selected unit — deselect entirely
        this._clearSelection();
      } else {
        // Popup was dismissed; re-show it
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
        // New unit — first tap selects and shows highlights; second tap opens popup
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
    this.onEntitySelected?.(entity);
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

    this.renderer.selectedHex      = { col: effectiveEntity.col, row: effectiveEntity.row };
    this.renderer.selectedEntityId = entity.id;
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
    this.renderer.selectedHex      = null;
    this.renderer.selectedEntityId = null;
    this.renderer.highlightHexes   = [];
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
      // Highlight enemy hexes in red — but only VISIBLE ones when fog is active.
      // Fogged enemies must be attacked via the explicit "Attack Hex" action instead.
      const b = this._validActions.find(a => a.type === ActionType.BATTLE);
      if (b) {
        const state = this.state;
        let visTargets = b.targets;
        if (state.fogOfWar && this._selectedEntity) {
          const visHexes = this._selectedEntity.owner === 'hero'
            ? getVisibleEnemyHexes(state)
            : getVisibleHeroHexes(state);
          visTargets = b.targets.filter(t => visHexes.has(hexKey(t.col, t.row)));
        }
        renderer.highlightHexes = renderer.highlightHexes.concat(
          visTargets.map(t => ({ col: t.col, row: t.row, color: 'rgba(220,60,60,0.55)' }))
        );
      }
    } else if (actionType === ActionType.BATTLE) {
      const a = this._validActions.find(a => a.type === ActionType.BATTLE);
      if (a) {
        const state = this.state;
        let visTargets = a.targets;
        if (state.fogOfWar && this._selectedEntity) {
          const visHexes = this._selectedEntity.owner === 'hero'
            ? getVisibleEnemyHexes(state)
            : getVisibleHeroHexes(state);
          visTargets = a.targets.filter(t => visHexes.has(hexKey(t.col, t.row)));
        }
        renderer.highlightHexes = visTargets.map(t => ({ col: t.col, row: t.row, color: 'rgba(220,60,60,0.55)' }));
      }
    } else if (actionType === ActionType.BATTLE_HEX) {
      // Highlight all adjacent non-river hexes as potential targets
      renderer.highlightHexes = (this._awaitingTarget.hexTargets ?? [])
        .map(t => ({ col: t.col, row: t.row, color: 'rgba(220,120,40,0.50)' }));
    }
  }

  _handleTargetClick(hex) {
    if (!this._awaitingTarget) return;
    const { actionType, actor, summonType } = this._awaitingTarget;
    const state = this.state;

    if (actionType === ActionType.MOVE) {
      // If the clicked hex has a valid battle target, route directly to battle
      // without needing to open the action popup first.
      const battleActionForMove = this._validActions.find(a => a.type === ActionType.BATTLE);
      const battleTargetsAtHex  = battleActionForMove?.targets.filter(t => t.col === hex.col && t.row === hex.row) || [];
      if (battleTargetsAtHex.length > 0) {
        this._awaitingTarget = { actionType: ActionType.BATTLE, actor };
        this._handleTargetClick(hex);
        return;
      }

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
      if (result.encounterSurvivor) {
        this._showEncounterDialog(result.encounterSurvivor, () => {
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
        // Planning mode: add battle to plan, then re-select the actor so red
        // battle highlights refresh naturally — clicking the same enemy again stacks another attack.
        if (this._planMode) {
          this._addToPlan({ type: PlanActionType.BATTLE_UNIT, entityId: actor.id, targetId: target.id });
          if (actor.alive) this._selectEntity(actor);
          else this._clearSelection();
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
        // HP-change floaters from pre/post snapshot comparison
        this.renderer.addHpChangeFlash(actor.col,  actor.row,  actor.hp  - actorSnap.hp);
        this.renderer.addHpChangeFlash(target.col, target.row, target.hp - targetSnap.hp);
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

    } else if (actionType === ActionType.BATTLE_HEX) {
      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];

      if (this._planMode) {
        this._addToPlan({ type: PlanActionType.BATTLE_HEX, entityId: actor.id, targetCol: hex.col, targetRow: hex.row });
        if (actor.alive) this._selectEntity(actor);
        else this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
        return;
      }
      // In non-plan mode, execute immediately (used in direct-action / online mode)
      if (this.mp?.active) {
        this.mp.sendAction('battle_hex', { entityId: actor.id, targetCol: hex.col, targetRow: hex.row });
        this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
        return;
      }
      // Offline direct-action: attempt battle against whatever is on the hex
      const hexEnemies = state.entities.filter(
        e => e.alive && e.owner !== actor.owner && e.col === hex.col && e.row === hex.row
      );
      if (hexEnemies.length > 0) {
        const target = hexEnemies[Math.floor(Math.random() * hexEnemies.length)];
        this._awaitingTarget = { actionType: ActionType.BATTLE, actor };
        this._handleTargetClick(hex);
      } else {
        state.addLog('No enemy found on that hex.', actor.owner);
        state.spendAction(1);
      }
      if (actor.alive) this._selectEntity(actor);
      else this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
    }
  }

  // ── Action popup (canvas overlay) ────────────────────────────────────────

  _showActionPopup(entity) {
    const state = this.state;
    const popup = this._el('action-popup');

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

    // In planning mode, compute projected inventory after all queued steps so we can
    // disable resource-dependent actions the player can no longer afford.
    const projInv = this._planMode ? computeProjectedInventory(state, this._plan) : null;
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
          // Attack is triggered directly by clicking a red-highlighted visible-enemy hex — no popup button needed.
          break;
        case ActionType.BATTLE_HEX:
          // "Attack Hex" — lets the player attack a hex that may be hidden by fog of war.
          // Only show in planning mode (resolution handles the skip if the hex turns out empty).
          if (this._planMode) {
            regularHtml += btn('⚔ Attack Hex', 'battle-hex', dis, `data-action="attack_hex"`);
          }
          break;
        case ActionType.FORTIFY: {
          // Use projected inventory in plan mode so queued fortifies reduce affordability
          const fortInv    = projInv ? projInv.shared : state.inventory.shared;
          const hasMetal   = (fortInv.metal || 0) > 0;
          const hasWood    = (fortInv.wood  || 0) > 0;
          // Use action.affordable as fallback when projInv not available
          const cantAfford = projInv ? (!hasMetal && !hasWood) : !action.affordable;
          const hasDoubler = entity.type === EntityType.SURVIVOR && entity.ability === SurvivorAbility.FORTIFY_DOUBLE;
          const tileData   = state.tiles.get(hexKey(entity.col, entity.row));
          const cur        = tileData ? tileData.fortifyLevel : 0;
          const lbl = hasMetal
            ? `⚙ Reinforce +${Math.min(4, cur + 2)} DEF (1⚙)`
            : hasDoubler
              ? `🪵 Fortify +${Math.min(4, cur + 2)} DEF ★ (1🪵)`
              : `🪵 Fortify +${Math.min(4, cur + 1)} DEF (1🪵)`;
          regularHtml += btn(lbl, 'fortify', (cantAfford || !hasAct) ? 'disabled' : '', `data-action="fortify"`);
          break;
        }
        case ActionType.SUMMON:
          // Each SUMMON entry has a specific summonType — render all three as separate buttons.
          // De-duplicate: only render the first time we hit a SUMMON action (we'll loop all three).
          // (The loop handles this — each has a distinct summonType so we render each once.)
          {
            const projWitch = projInv ? projInv.witch : state.inventory.witch;
            const projMetal = projWitch[ResourceType.METAL] || 0;
            const projWood  = projWitch[ResourceType.WOOD]  || 0;
            const projTotal = Object.values(projWitch).reduce((s, v) => s + (v || 0), 0);
            const projAffordable = {
              [EntityType.IRON_GOLEM]: projMetal >= 2,
              [EntityType.WOOD_GOLEM]: projWood  >= 2,
              [EntityType.MINION]:     projTotal >= 2,
            };
            const SUMMON_LABEL = {
              [EntityType.IRON_GOLEM]: '🔩 Iron Golem (2⚙)',
              [EntityType.WOOD_GOLEM]: '🪵 Wood Golem (2🪵)',
              [EntityType.MINION]:     '🌑 Minion (2 res)',
            };
            const st = action.summonType;
            const canAfford = projAffordable[st] ?? action.affordable;
            const btnDis = (!canAfford || !hasAct) ? 'disabled' : '';
            regularHtml += btn(SUMMON_LABEL[st] ?? '🌑 Summon', 'summon', btnDis, `data-action="summon" data-summon-type="${st}"`);
          }
          break;
        case ActionType.USE_ITEM:
          for (const item of action.usable) {
            // Food is managed via the plan-panel food slots in planning mode.
            if (this._planMode && item.item === ResourceType.FOOD) continue;
            // Disable if projected inventory can't cover this item
            let itemDis = dis;
            if (projInv) {
              if (item.item === ResourceType.HERBS) {
                const eitems = projInv.entityItems[entity.id] ?? {};
                if ((eitems[ResourceType.HERBS] || 0) < 1) itemDis = 'disabled';
              } else if (!item.item.startsWith('weapon:')) {
                if ((projInv.shared[item.item] || 0) < 1) itemDis = 'disabled';
              }
            }
            regularHtml += btn(item.label, 'item', itemDis, `data-action="use_item" data-item="${item.item}"`);
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
    const bar = this._el('unit-stats-bar');
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
          <span class="usb-hp-fill" style="width:${hpPct}%;background:linear-gradient(to bottom,rgba(255,255,255,0.28) 0%,rgba(255,255,255,0) 55%),${hpColor}"></span>
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
    const el    = this._el('turn-info');
    if (!el) return;

    // 8-step cycle — shared between header and cycle-bar
    const CYCLE_STEPS = [
      { phase: 'dawn',  icon: '🌅', label: 'Dawn',  desc: 'Hero +1 action · node scoring · attrition rises' },
      { phase: 'day',   icon: '☀️',  label: 'Day',   desc: 'Witch undead in the open suffer' },
      { phase: 'day',   icon: '☀️',  label: 'Day',   desc: 'Witch undead in the open suffer' },
      { phase: 'day',   icon: '☀️',  label: 'Day',   desc: 'Witch undead in the open suffer' },
      { phase: 'dusk',  icon: '🌇', label: 'Dusk',  desc: 'Node scoring · seek cover before night' },
      { phase: 'night', icon: '🌙', label: 'Night', desc: 'Witch +2 ATK · Survivors in the open suffer' },
      { phase: 'night', icon: '🌙', label: 'Night', desc: 'Witch +2 ATK · Survivors in the open suffer' },
      { phase: 'night', icon: '🌙', label: 'Night', desc: 'Witch +2 ATK · Survivors in the open suffer' },
    ];

    const roundInCycle = (state.round - 1) % 8;
    const cycle        = Math.ceil(state.round / 8);
    const roundLabel   = `Day ${cycle} · Round ${roundInCycle + 1}`;

    // Render always-visible cycle bar (compact icon row)
    const cycleBar = this._el('cycle-bar');
    if (cycleBar) {
      cycleBar.innerHTML = CYCLE_STEPS.map((step, i) => {
        const active = i === roundInCycle;
        return `<div class="cycle-step phase-${step.phase} ${active ? 'cycle-active' : 'cycle-dim'}"
                     title="${step.desc}">${step.icon}${active ? `<span class="cycle-name">${step.label}</span>` : ''}</div>`;
      }).join('');
    }

    // Round label sits below the cycle bar
    const roundLabelEl = this._el('round-label');
    if (roundLabelEl) roundLabelEl.textContent = roundLabel;

    // During planning phase, show planning info
    if (this._planMode) {
      const faction = this._planFaction;
      const glyph   = faction === 'hero' ? '⚔' : '✦';
      const budget  = this._planBudget;
      const used    = this._plan.filter(a => a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM).length;
      const capped  = Math.min(used, budget); // don't render more diamonds than budget
      const diamonds = '◆'.repeat(Math.max(0, budget - capped)) + '◇'.repeat(capped);
      if (this._planSubmitted) {
        el.innerHTML = `
          <span class="turn-faction player-${faction}">${glyph}</span>
          <span class="turn-line">Waiting for opponent…</span>
        `;
      } else {
        el.innerHTML = `
          <span class="turn-faction player-${faction}">${glyph}</span>
          <div class="actions-remaining" title="Actions budget">${diamonds}</div>
        `;
      }
      return;
    }

    // During resolution, show neutral resolution label
    if (state.resolving) {
      el.innerHTML = `<span class="turn-line">Resolving Actions…</span>`;
      return;
    }

    const glyph  = state.activePlayer === 'hero' ? '⚔' : '✦';
    const player = state.activePlayer === 'hero' ? 'Hero' : 'Witch';
    const isAI   = (state.activePlayer === 'witch' && state.witchIsAI) ||
                   (state.activePlayer === 'hero'  && state.heroIsAI);

    const diamonds = state.actionsLeft > 0
      ? '◆'.repeat(state.actionsLeft)
      : '◇';

    el.innerHTML = `
      <span class="turn-faction player-${state.activePlayer}">${glyph}</span>
      <span class="turn-line">${player}'s Turn ${isAI ? '<span class="ai-badge">AI</span>' : ''}</span>
      <div class="actions-remaining">${diamonds}</div>
    `;
  }

  _renderObjectives() {
    const el = this._el('score-bar-content');
    if (!el) return;
    const state = this.state;

    const { html, title } = buildObjectivesHtml(
      state.witchObjectives, state.entities, state.nodeScore,
    );

    el.innerHTML = html;
    const bar = this._el('score-bar');
    if (bar) bar.title = title;
  }

  /**
   * Animate glow on score pips and node dots that changed since prevScore/prevNodes.
   */
  _animateScoreBar(prevScore, prevNodes) {
    if (!prevScore && !prevNodes) return;
    this._renderObjectives(); // ensure DOM is up to date

    const barEl = this._el('score-bar-content');
    if (!barEl) return;

    // Animate score pip changes
    if (prevScore) {
      const state = this.state;
      const heroPips  = barEl.querySelectorAll('.score-pip.hero');
      const witchPips = barEl.querySelectorAll('.score-pip.witch');
      for (let i = prevScore.hero; i < state.nodeScore.hero && i < heroPips.length; i++) {
        heroPips[i].classList.add('score-pip-glow');
      }
      for (let i = prevScore.witch; i < state.nodeScore.witch && i < witchPips.length; i++) {
        witchPips[i].classList.add('score-pip-glow');
      }
    }

    // Animate node dot changes
    if (prevNodes) {
      const dots = barEl.querySelectorAll('.node-dot');
      prevNodes.forEach((prev, i) => {
        if (i >= dots.length) return;
        const obj = this.state.witchObjectives.find(o => o.col === prev.col && o.row === prev.row);
        const currentOwner = obj ? nodeController(obj, this.state.entities) : 'neutral';
        if (currentOwner !== prev.owner) {
          dots[i].classList.add('node-dot-glow');
        }
      });
    }

    // Remove glow classes after animation completes
    setTimeout(() => {
      barEl.querySelectorAll('.score-pip-glow').forEach(el => el.classList.remove('score-pip-glow'));
      barEl.querySelectorAll('.node-dot-glow').forEach(el => el.classList.remove('node-dot-glow'));
    }, 2000);
  }

  _renderActionPanel() {
    // Show/hide the floating cancel pill and update its hint text
    const wrap = this._el('cancel-wrap');
    const hint = this._el('target-hint');
    if (!wrap) return;

    const targeting = this._awaitingTarget && !this._awaitingTarget.isDefault;
    wrap.classList.toggle('visible', !!targeting);

    if (targeting && hint) {
      const labels = {
        [ActionType.BATTLE]:     'Tap an enemy to attack',
        [ActionType.BATTLE_HEX]: 'Tap a hex to attack (skips if empty)',
      };
      hint.textContent = labels[this._awaitingTarget.actionType] ?? '';
    }
  }

  _renderEndTurnBtn() {
    const btn = this._el('end-turn-btn');
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
        this._showLootFlashes(entity, result.lootItems ?? []);
        state.checkVictory();
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
        this._maybeShowNoActionsDialog();
        break;
      }

      case 'battle':
        // Attack is triggered via red hex clicks — this case is no longer used.
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
        const summonType = button.dataset.summonType ?? null;
        if (this._planMode) {
          this._addToPlan({ type: PlanActionType.SUMMON, entityId: entity.id, summonType: summonType ?? undefined });
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
        } else if (this.mp?.active) {
          this.mp.sendAction('summon', { entityId: entity.id, summonType: summonType ?? undefined });
          this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
        } else {
          const result = executeSummon(state, entity, summonType ?? null);
          for (const msg of result.log) state.addLog(msg);
          if (result.success) {
            state.spendAction(result.cost);
            this.renderer.addSpawnAnim(entity.col, entity.row, '#b39ddb');
          }
          state.checkVictory();
          if (entity.alive) this._selectEntity(entity);
          else this._clearSelection();
          this._updateSidebar();
          this.onRedraw();
          this._maybeShowNoActionsDialog();
        }
        break;
      }

      case 'attack_hex': {
        _hideActionPopup();
        const bhAction = this._validActions.find(a => a.type === ActionType.BATTLE_HEX);
        const hexTargets = bhAction?.targets ?? [];
        this._awaitingTarget = { actionType: ActionType.BATTLE_HEX, actor: entity, hexTargets };
        renderer.highlightHexes = hexTargets.map(t => ({ col: t.col, row: t.row, color: 'rgba(220,120,40,0.50)' }));
        state.addLog('Click a hex to attack it (skips if empty).');
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
      const dmg = pos.dmg || 1;
      this.renderer.addFlash(pos.col, pos.row, `-${dmg}`, 'rgba(80,0,160,0.6)', 2200, 1.4, 'rgba(210,140,255,1)');
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

  // ── Speed popup ───────────────────────────────────────────────────────────

  static SPEED_LABELS = { step: 'Step by Step', cinematic: 'Cinematic', fast: 'Fast', vfast: 'Very Fast' };

  _toggleSpeedPopup() {
    const popup = this._el('speed-popup');
    if (!popup) return;
    const isOpen = popup.style.display !== 'none';
    if (isOpen) { this._closeSpeedPopup(); return; }
    // Mark active option
    popup.querySelectorAll('.speed-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === this.speedMode);
    });
    popup.style.display = 'flex';
  }

  _closeSpeedPopup() {
    const popup = this._el('speed-popup');
    if (popup) popup.style.display = 'none';
  }

  _setSpeed(mode) {
    if (!UIController.SPEED_LABELS[mode]) return;
    this.speedMode = mode;
    this._closeSpeedPopup();
    const btn = this._el('speed-toggle');
    if (btn) {
      btn.title = `Battle speed: ${UIController.SPEED_LABELS[mode]}`;
      btn.className = `zoom-btn speed-${mode}`;
    }
    this._showSpeedToast(`⚡ ${UIController.SPEED_LABELS[mode]}`);
  }

  _waitForStep() {
    return new Promise(resolve => {
      const bar = this._el('step-continue-bar');
      if (bar) bar.style.display = 'flex';
      this._stepResolve = () => {
        if (bar) bar.style.display = 'none';
        this._stepResolve = null;
        resolve();
      };
    });
  }

  _clearStepContinue() {
    if (this._stepResolve) this._stepResolve();
  }

  _showSpeedToast(text) {
    let toast = document.getElementById('speed-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'speed-toast';
      toast.className = 'speed-toast';
      const wrapper = this._el('canvas-wrapper');
      if (wrapper) wrapper.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.remove('speed-toast-out');
    clearTimeout(this._speedToastTimer);
    this._speedToastTimer = setTimeout(() => {
      toast.classList.add('speed-toast-out');
    }, 1500);
  }

  // ── Battle toast (minor skirmishes) ──────────────────────────────────────

  _showBattleToast(actorSnap, targetSnap, result) {
    const container = this._el('battle-toast-container');
    if (!container) return;

    const outcome = result.killed
      ? '💀 slain'
      : result.hit
        ? result.damage >= 2 ? `💥 crush −${result.damage}HP` : `⚔ hit −${result.damage}HP`
        : result.counterDmg > 0 ? '🛡 counter' : 'miss';

    const toast = document.createElement('div');
    toast.className = 'battle-toast' +
      (result.killed ? ' kill' : result.damage >= 2 ? ' crush' : '');
    toast.textContent =
      `${actorSnap.name} → ${targetSnap.name}  [${result.attackRoll}v${result.defenseRoll}]  ${outcome}`;
    container.appendChild(toast);

    const displayMs = this.speedMode === 'vfast' ? 500
                    : this.speedMode === 'fast'    ? 1200
                    :                               2000;
    setTimeout(() => {
      toast.style.animation = 'battle-toast-out 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, displayMs);
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
    ], () => {});
  }

  // ── Phase toast ──────────────────────────────────────────────────────────

  _showPhaseModal(faction, budget) {
    if (this.tutorialMode) return;

    const phase = this.state.phase;
    const PHASE_INFO = {
      dawn:  { icon: '🌅', label: 'Dawn',  lines: ['Hero gains +1 action · Attrition rises', 'Power Nodes scored · Tiles reset'] },
      day:   { icon: '☀️',  label: 'Day',   lines: ['Build & fortify', 'Witch undead in the open suffer'] },
      dusk:  { icon: '🌇', label: 'Dusk',  lines: ['Power Nodes scored · Seek shelter', 'Night approaches…'] },
      night: { icon: '🌙', label: 'Night', lines: ['Witch +2 ATK · Raise undead', 'Survivors in the open suffer'] },
    };
    const info = PHASE_INFO[phase];
    if (!info) return;

    const el = this._el('phase-modal');
    if (!el) return;

    // Compute action breakdown for display
    const actions  = budget ?? (faction === 'hero' ? this.state.heroActionsLeft : this.state.witchActionsLeft) ?? 0;
    const entities = this.state.entities;
    const inventory = this.state.inventory;
    const stash = faction === 'hero' ? inventory?.shared : inventory?.witch;
    const foodCount = stash?.food ?? 0;

    // Build line-item rows: { label, value }
    const rows = [];
    if (faction === 'hero') {
      const base = 3;
      const timeBonus     = (phase === 'day' || phase === 'dawn') ? 1 : 0;
      const survivorCount = entities.filter(e => e.alive && e.owner === 'hero' && e.type !== 'hero').length;
      const survivorBonus = Math.min(survivorCount, 5);
      rows.push({ label: 'Base', value: base });
      if (timeBonus)     rows.push({ label: `${info.icon} ${info.label} bonus`, value: timeBonus });
      if (survivorBonus) rows.push({ label: `☺ Survivor${survivorBonus !== 1 ? 's' : ''} (${survivorCount})`, value: survivorBonus });
    } else {
      const base = 4;
      const timeBonus = phase === 'night' ? 1 : 0;
      const unitCount = entities.filter(e => e.alive && e.owner === 'witch' && e.type !== 'witch').length;
      const unitBonus = Math.min(Math.floor(unitCount / 2), 4);
      rows.push({ label: 'Base', value: base });
      if (timeBonus) rows.push({ label: `${info.icon} ${info.label} bonus`, value: timeBonus });
      if (unitBonus) rows.push({ label: `☠ Minions (${unitCount})`, value: unitBonus });
    }

    // Set content
    const iconEl    = el.querySelector('.phase-modal-icon');
    const titleEl   = el.querySelector('.phase-modal-title');
    const effectsEl = el.querySelector('.phase-modal-effects');
    const budgetEl  = el.querySelector('.phase-modal-budget');
    if (iconEl)    iconEl.textContent   = info.icon;
    if (titleEl)   titleEl.textContent  = `${info.label} — Round ${this.state.round}`;
    if (effectsEl) effectsEl.innerHTML  = info.lines.map(l => `<div>${l}</div>`).join('');
    if (budgetEl) {
      const pips = Array.from({ length: actions }, () =>
        `<span class="action-pip">◆</span>`
      ).join('');

      let breakdownHtml = '<div class="action-breakdown-table">';
      for (const r of rows) {
        breakdownHtml += `<div class="abkd-row"><span class="abkd-label">${r.label}</span><span class="abkd-val">+${r.value}</span></div>`;
      }
      breakdownHtml += `<hr class="abkd-divider">`;
      breakdownHtml += `<div class="abkd-row abkd-total"><span class="abkd-label">Total</span><span class="abkd-val">${actions}</span></div>`;
      if (foodCount > 0) {
        breakdownHtml += `<div class="abkd-row abkd-food"><span class="abkd-label">🍞 Food ×${foodCount}</span><span class="abkd-val">(extra actions)</span></div>`;
      }
      breakdownHtml += '</div>';

      budgetEl.innerHTML =
        `<div class="action-pip-row">${pips}</div>` +
        breakdownHtml;
    }

    // Set phase accent class
    el.className = `visible phase-${phase}`;

    // Dismiss only on button click — no auto-dismiss, no backdrop click
    const continueBtn = this._el('phase-modal-continue');
    const dismiss = () => {
      el.classList.remove('visible');
      continueBtn?.removeEventListener('click', dismiss);
    };
    continueBtn?.addEventListener('click', dismiss);
  }

  // ── Dialogs ───────────────────────────────────────────────────────────────

  /** Show floating "+Item" text over a hex for each loot item found. */
  _showLootFlashes(entity, lootItems) {
    if (!lootItems.length) {
      this.renderer.addFlash(entity.col, entity.row, '—', 'rgba(120,110,90,0.15)', 1200, 0.6, 'rgba(160,148,124,0.9)');
      return;
    }
    lootItems.forEach((label, i) => {
      setTimeout(() => {
        this.renderer.addFlash(entity.col, entity.row, label, 'rgba(200,170,60,0.1)', 1800, 0.72, '#e8d48a');
        this.onRedraw();
      }, i * 420);
    });
  }

  /** Show a unit card popup for a newly-encountered survivor or zombie. */
  _showEncounterDialog(encounterUnit, onDismiss) {
    const dialog = this._el('encounter-dialog');
    const card   = this._el('encounter-card');

    const GLYPHS = { hero: '⚔', witch: '✦', survivor: '☺', zombie: '†', minion: '☠', wood_golem: '🪵', iron_golem: '⚙' };
    const glyph  = GLYPHS[encounterUnit.type] ?? '?';
    const color  = encounterUnit.color || '#d4c9b0';

    const assetId = encounterUnit.type === 'survivor'
      ? (_SURVIVOR_TITLE_ASSET[encounterUnit.title] ?? null)
      : encounterUnit.type;
    const src = assetId ? this.renderer.getPortraitDataURL(assetId) : null;

    const portraitHtml = src
      ? `<img src="${src}" style="width:72px;height:72px;border-radius:50%;border:2px solid ${color};display:block;">`
      : `<div style="font-size:2.8rem;line-height:1;color:${color};width:72px;text-align:center;">${glyph}</div>`;

    const titleHtml = encounterUnit.title
      ? `<div style="font-size:0.75rem;color:#9a8a7a;font-style:italic;margin-bottom:0.25rem;">${encounterUnit.title}</div>`
      : '';

    const abilityHtml = encounterUnit.abilityLabel
      ? `<div style="font-size:0.72rem;color:#88eeff;margin-top:0.3rem;">✦ ${encounterUnit.abilityLabel}</div>`
      : '';

    const hpPct   = encounterUnit.maxHp > 0 ? (encounterUnit.hp / encounterUnit.maxHp) * 100 : 100;
    const hpColor = hpPct > 60 ? '#4caf7d' : hpPct > 30 ? '#f5c842' : '#c0392b';

    const message = encounterUnit.type === 'survivor'
      ? `${encounterUnit.name} steps from the shadows and joins the party!`
      : `A cowering survivor is found… raised as a zombie by the witch!`;

    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.85rem;margin-bottom:0.75rem;">
        <div style="flex-shrink:0;">${portraitHtml}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:1rem;font-weight:bold;color:${color};margin-bottom:0.12rem;">${glyph} ${encounterUnit.name}</div>
          ${titleHtml}
          <div style="font-size:0.72rem;color:#c8b89a;">HP ${encounterUnit.hp}/${encounterUnit.maxHp} · ATK ${encounterUnit.attack} · DEF ${encounterUnit.defense}</div>
          <div style="background:#1e1e2a;border-radius:3px;height:5px;margin-top:0.3rem;overflow:hidden;">
            <div style="width:${hpPct}%;height:100%;background:${hpColor};border-radius:3px;"></div>
          </div>
          ${abilityHtml}
        </div>
      </div>
      <div style="font-size:0.82rem;color:#b8a88a;text-align:center;margin-bottom:0.5rem;">${message}</div>
      ${this.autoplay ? '' : '<div class="result-dismiss">— click anywhere to continue —</div>'}
    `;

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
      setTimeout(dismiss, 700);
    } else if (this.speedMode === 'fast' || this.speedMode === 'vfast') {
      setTimeout(dismiss, 600);
      dialog.addEventListener('click', dismiss);
      document.addEventListener('keydown', keyDismiss);
    } else {
      dialog.addEventListener('click', dismiss);
      document.addEventListener('keydown', keyDismiss);
    }
  }

  _showResultDialog(messages, onDismiss, encounterSurvivor = null) {
    const dialog = this._el('result-dialog');
    // Collapse consecutive duplicate lines into "message (×N)"
    const collapsed = [];
    for (const msg of messages) {
      const last = collapsed[collapsed.length - 1];
      if (last?.msg === msg) last.count++;
      else collapsed.push({ msg, count: 1 });
    }
    this._el('result-messages').textContent =
      collapsed.map(({ msg, count }) => count > 1 ? `${msg} (×${count})` : msg).join('\n');
    this._el('result-dismiss-hint').style.display = this.autoplay ? 'none' : '';
    const btns = this._el('result-buttons');
    btns.style.display = 'none';
    btns.innerHTML = '';

    // Survivor portrait
    const portraitEl = this._el('result-portrait');
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
    } else if (this.speedMode === 'fast' || this.speedMode === 'vfast') {
      setTimeout(dismiss, 800);
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
    const dialog = this._el('result-dialog');
    const hint   = this._el('result-dismiss-hint');
    const btns   = this._el('result-buttons');

    this._el('result-messages').textContent = 'No more actions!';
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
    const dialog = this._el('result-dialog');
    const hint   = this._el('result-dismiss-hint');
    const btns   = this._el('result-buttons');

    this._el('result-messages').textContent = 'Multiple enemies here — choose your target:';
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

    const dialog = this._el('battle-dialog');
    const footer = this._el('battle-footer');

    // Summary line: "[Actor] attacks [Target], aided by …"
    const summaryEl = this._el('battle-summary');
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
    this._el('battle-attacker').innerHTML = _combatantHTML(actorSnap, 'atk', atkPortrait);
    this._el('battle-defender').innerHTML = _combatantHTML(targetSnap, 'def', defPortrait);

    const atkDie  = this._el('battle-atk-die');
    const defDie  = this._el('battle-def-die');
    const outcome = this._el('battle-outcome');
    outcome.textContent = '';
    outcome.className   = 'battle-outcome';
    footer.innerHTML    = this.autoplay ? '' : '<div class="result-dismiss">— click to continue —</div>';

    // Reset breakdown columns (hidden until dice settle)
    const atkBkd = this._el('battle-atk-breakdown');
    const defBkd = this._el('battle-def-breakdown');
    if (atkBkd) { atkBkd.innerHTML = ''; atkBkd.classList.remove('visible'); }
    if (defBkd) { defBkd.innerHTML = ''; defBkd.classList.remove('visible'); }

    dialog.style.display = 'flex';
    const card = dialog.querySelector('.battle-card');

    const dismiss = () => {
      dialog.style.display = 'none';
      dialog.removeEventListener('click', dismiss);
      card?.removeEventListener('click', dismiss);
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
        this._el('battle-atk-breakdown').innerHTML =
          _buildBreakdownHTML(actorSnap, bd, 'atk', result.attackRoll);
        this._el('battle-def-breakdown').innerHTML =
          _buildBreakdownHTML(targetSnap, bd, 'def', result.defenseRoll);
        // Double-rAF ensures a paint happens before adding visible,
        // so the opacity 0→1 transition fires reliably.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          this._el('battle-atk-breakdown').classList.add('visible');
          this._el('battle-def-breakdown').classList.add('visible');
        }));
      }

      if (result.killed) {
        const dmgNote = result.damage > 0 ? ` (${result.damage} damage)` : '';
        outcome.textContent = `💀 ${targetSnap.name} is slain!${dmgNote}`;
        outcome.className   = 'battle-outcome kill';
      } else if (result.hit) {
        const fortNote = result.fortDamaged ? ` (-${result.fortDamaged} fortifications)` : '';
        if (result.damage >= 2) {
          outcome.textContent = `💥💥 Crushing hit! ${targetSnap.name} takes ${result.damage} damage!${fortNote}`;
          outcome.className   = 'battle-outcome kill';
        } else {
          outcome.textContent = `💥 Hit! ${targetSnap.name} takes 1 damage${fortNote}`;
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
      // Skip animation — show result immediately, auto-dismiss
      atkDie.textContent = result.attackRoll;
      defDie.textContent = result.defenseRoll;
      atkDie.className = 'die-display' + (result.hit ? ' atk-win' : '');
      defDie.className = 'die-display' + (!result.hit ? ' def-win' : '');
      revealResult();
      setTimeout(dismiss, 500);
    } else if (this.speedMode === 'fast') {
      // Skip dice animation — show result immediately, auto-dismiss after 800ms
      atkDie.textContent = result.attackRoll;
      defDie.textContent = result.defenseRoll;
      atkDie.className = 'die-display' + (result.hit ? ' atk-win' : '');
      defDie.className = 'die-display' + (!result.hit ? ' def-win' : '');
      revealResult();
      setTimeout(dismiss, 800);
    } else {
      // Cinematic: animated dice roll, manual click to dismiss
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
        card?.addEventListener('click', dismiss);
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
    const overlay = this._el('tile-zoom-overlay');
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
    const polyEl = this._el('tile-zoom-poly');
    const fortEl = this._el('tile-zoom-fort');
    const iconEl = this._el('tile-zoom-icon');

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
    const nameEl  = this._el('tile-zoom-tile-name');
    const linesEl = this._el('tile-zoom-info-lines');

    if (nameEl) {
      nameEl.textContent = tile.building ? (BUILDING_LABEL[tile.building] ?? tile.type)
                                         : tile.type;
    }

    const obj       = state.witchObjectives.find(o =>
      o.hexes.some(h => h.col === hex.col && h.row === hex.row)
    );
    let linesHtml   = '';

    if (obj) {
      const ctrl = nodeController(obj, state.entities);
      const ctrlStr = ctrl === 'hero'      ? '🔵 Hero'
                    : ctrl === 'witch'     ? '🔴 Witch'
                    : ctrl === 'contested' ? '⚡ Contested'
                    : '⭕ Uncontrolled';
      linesHtml += `<div class="tile-zoom-info-line node">⚔ Power Node (${obj.label}) — ${ctrlStr}</div>`;
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
    const unitsEl  = this._el('tile-zoom-units');

    if (unitsEl) {
      let html = '';
      if (visible.length) html += `<div class="tile-units-heading">Units</div>`;
      for (const u of myUnits) {
        html += _unitCardHTML(u, { renderer: this.renderer, selectable: true });
      }
      for (const u of foeUnits) {
        html += _unitCardHTML(u, { renderer: this.renderer, showStats: false });
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
    this._el('tile-zoom-overlay')?.classList.remove('visible');
  }

  /** Cycle chronicle through: none → mini → full → none */
  _cycleChronicle() {
    const modes = ['none', 'mini', 'full'];
    const next  = modes[(modes.indexOf(this._chronicleMode) + 1) % modes.length];
    this._setChronicleMode(next);
  }

  _setChronicleMode(mode) {
    this._chronicleMode = mode;
    const sidebar = this._el('chronicle-sidebar');
    if (sidebar) sidebar.style.display = mode === 'full' ? 'flex' : 'none';
    this._renderMiniChronicle();
    if (mode === 'full') this._renderSidebarLog();
    // Update renderer inset so framing avoids the sidebar area
    if (this.renderer) this.renderer.insetLeft = mode === 'full' ? 240 : 0;
    // Resize canvas to account for sidebar width change, then redraw
    this.renderer?.resize();
    this.onRedraw?.();
  }

  _renderSidebarLog() {
    const el = this._el('chronicle-sidebar-log');
    if (!el) return;
    const visible = this._visibleLog();
    el.innerHTML = visible.map(m => `<div class="log-entry">${this._logText(m)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  _renderInventory() {
    const el = this._el('plan-inventory');
    if (!el) return;

    const state   = this.state;
    const faction = this._planFaction ?? (state.activePlayer === Player.HERO ? 'hero' : 'witch');
    const isHero  = faction === 'hero';
    const inv     = state.inventory;
    const stash   = isHero ? inv.shared : inv.witch;
    const label   = isHero ? '⚔ Supplies' : '🕯 Stores';

    const entries = Object.entries(stash).filter(([, v]) => v > 0);
    const rows = entries.length
      ? entries.map(([k, v]) =>
          `<div class="inv-resource-row">
            <span class="inv-resource-label">${RESOURCE_LABEL[k] || k}</span>
            <span class="inv-resource-val">×${v}</span>
          </div>`
        ).join('')
      : `<div class="inv-empty">Nothing held.</div>`;

    el.innerHTML = `<div class="plan-inventory-title">${label}</div>${rows}`;
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
    const el = this._el('event-log');
    if (!el) return;
    const visible = this._visibleLog();
    el.innerHTML = visible.map(m =>
      `<div class="log-entry">${this._logText(m)}</div>`
    ).join('');
    el.scrollTop = el.scrollHeight;

    this._renderMiniChronicle();
    if (this._chronicleMode === 'full') this._renderSidebarLog();
  }

  _renderMiniChronicle() {
    const el = this._el('chronicle-mini');
    if (!el) return;
    const mode = this._chronicleMode ?? 'mini';

    if (mode === 'mini') {
      const visible = this._visibleLog();
      const last5   = visible.slice(-5);
      el.innerHTML  = last5.map(m => `<div class="mini-log-entry">${this._logText(m)}</div>`).join('');
    } else {
      el.innerHTML = '';
    }

    // Update active state on the chronicle toggle in map controls
    const toggleBtn = this._el('chronicle-toggle');
    if (toggleBtn) {
      toggleBtn.classList.toggle('chronicle-btn-active', mode !== 'none');
    }
  }

  /**
   * Show the post-resolution round summary modal.
   * Resolves with 'next' or 'replay'.
   * @param {object} [opts] - Optional scoring context (fog, node control, reckoning).
   */
  _showResolutionSummary(steps, roundNum, opts = {}) {
    return new Promise(resolve => {
      const el = this._el('round-summary');
      if (!el) { resolve('next'); return; }

      const { prevScore, prevNodes, humanFaction, fogOfWar, gameOver, winner, winReason, hasFullReplay } = opts;

      // Collect kills, survivors found, summons, and resource flows from steps.
      // Fog-of-war filtering: skip opponent-only events the player can't see.
      const kills     = [];
      const survivors = [];
      const summons   = [];
      const foundRes  = {}; // icon → count  (from explore loot)
      const usedRes   = {}; // icon → count  (from summon/fortify/use-item)
      const _addRes = (map, icon, n = 1) => { map[icon] = (map[icon] || 0) + n; };
      const RES_ICON_MAP = { wood: '🪵', metal: '⚙', food: '🍞', silver: '🥈', scripture: '📜', herbs: '🌿' };

      for (const step of steps ?? []) {
        // Tag each event with its faction for fog filtering
        const taggedEvents = [
          ...(step.heroEvents  ?? []).map(ev => ({ ...ev, _faction: 'hero' })),
          ...(step.witchEvents ?? []).map(ev => ({ ...ev, _faction: 'witch' })),
          ...(step.playerEvents ?? []).flatMap(pe =>
            (pe.events ?? []).map(ev => ({ ...ev, _faction: pe.faction }))
          ),
        ];
        for (const ev of taggedEvents) {
          // Fog filter: skip opponent events (but always show kills of our units)
          if (fogOfWar && humanFaction && ev._faction !== humanFaction) {
            // Exception: show kills where our unit was the target
            const isOurUnitKilled = ev.result?.killed &&
              (ev.battleSnaps?.targetSnap?.owner === humanFaction);
            if (!isOurUnitKilled) continue;
          }

          if (ev.result?.killed) {
            const snap = ev.battleSnaps?.targetSnap ?? ev.result.killed;
            let name;
            if (snap?.name && snap?.title) {
              name = `${snap.name} the ${snap.title}`;
            } else {
              name = snap?.name ?? snap?.title ?? snap?.type ?? 'Unit';
            }
            kills.push(name);
          }
          if (ev.result?.encounterSurvivor) {
            survivors.push(ev.result.encounterSurvivor);
          }
          if (ev.action?.type === 'summon' && ev.result?.success) {
            const logLine = ev.result?.log?.[0] ?? '';
            summons.push(logLine || 'Unit summoned');
          }

          // ── Resource tracking (player's faction only) ─────────────────
          if (ev.result?.success && (!humanFaction || ev._faction === humanFaction)) {
            // Resources found: collect lootItems from explore results
            if (ev.action?.type === 'explore') {
              for (const item of ev.result.lootItems ?? []) {
                if (!item.startsWith('+')) continue;
                const icon = item.slice(1);
                // Skip weapons (⚔) and horses (🐴) — not consumable resources
                if (icon !== '⚔' && icon !== '🐴') _addRes(foundRes, icon);
              }
            }
            // Resources spent: summon — use result.spent for exact breakdown
            if (ev.action?.type === 'summon') {
              for (const { type, amount } of ev.result?.spent ?? []) {
                const icon = RES_ICON_MAP[type] ?? type;
                _addRes(usedRes, icon, amount);
              }
            }
            // Resources spent: fortify
            if (ev.action?.type === 'fortify') {
              const log0 = ev.result?.log?.[0] ?? '';
              _addRes(usedRes, log0.includes('metal') ? '⚙' : '🪵');
            }
            // Resources spent: use-item (only trackable consumables)
            if (ev.action?.type === 'use_item') {
              const icon = RES_ICON_MAP[ev.action?.item];
              if (icon) _addRes(usedRes, icon);
            }
          }
        }
      }

      // Detect node control changes
      const nodeChanges = [];
      if (prevNodes) {
        const state = this.state;
        for (const prev of prevNodes) {
          const obj = state.witchObjectives.find(o => o.col === prev.col && o.row === prev.row);
          const currentOwner = obj ? nodeController(obj, state.entities) : 'neutral';
          if (currentOwner !== prev.owner) {
            nodeChanges.push({ label: prev.label, from: prev.owner, to: currentOwner });
          }
        }
      }

      const titleEl  = el.querySelector('.round-summary-title');
      const eventsEl = this._el('round-summary-events');
      if (titleEl) {
        if (gameOver) {
          if (!humanFaction) {
            titleEl.textContent = winner === 'hero' ? 'Hero Wins!' : 'Witch Wins!';
          } else {
            titleEl.textContent = winner === humanFaction ? 'Victory!' : 'Defeat';
          }
        } else {
          titleEl.textContent = `Round ${roundNum ?? ''} complete`;
        }
      }
      if (eventsEl) {
        let html = '';

        // Combat summary — aggregate damage between each pair of combatants
        const battleLines = compileTurnBattleSummary(
          steps ?? [], this.state.entities, ResEventType, PlanActionType,
        );
        for (const line of battleLines) {
          html += `<div class="summary-combat">${line}</div>`;
        }

        for (const n of kills) {
          html += `<div class="summary-kill">☠ ${n} slain</div>`;
        }
        for (const s of survivors) {
          if (s.type === 'zombie') {
            html += `<div class="summary-summon">† Zombie raised</div>`;
          } else {
            const label = s.title ? `${s.name} the ${s.title}` : s.name;
            html += `<div class="summary-survivor">☺ ${label} joined</div>`;
          }
        }
        for (const s of summons) {
          html += `<div class="summary-summon">✦ ${s}</div>`;
        }

        // Resource economy rows
        const foundEntries = Object.entries(foundRes);
        const usedEntries  = Object.entries(usedRes);
        if (foundEntries.length > 0) {
          const foundStr = foundEntries.map(([icon, n]) => `${n}${icon}`).join(' ');
          html += `<div class="summary-resources found">📦 Found: ${foundStr}</div>`;
        }
        if (usedEntries.length > 0) {
          const usedStr = usedEntries.map(([icon, n]) =>
            icon === 'res' ? `${n} res` : `${n}${icon}`
          ).join(' ');
          html += `<div class="summary-resources used">📤 Spent: ${usedStr}</div>`;
        }

        // Node control changes
        for (const nc of nodeChanges) {
          if (nc.to === 'hero') {
            html += `<div class="summary-node hero-text">⚔ Hero now controls ${nc.label}</div>`;
          } else if (nc.to === 'witch') {
            html += `<div class="summary-node witch-text">✦ Witch has seized ${nc.label}</div>`;
          } else if (nc.to === 'contested') {
            html += `<div class="summary-node">⚡ ${nc.label} is now contested</div>`;
          } else {
            html += `<div class="summary-node">◇ ${nc.label} is no longer controlled</div>`;
          }
        }

        // Reckoning section at dawn/dusk
        const state = this.state;
        if (prevScore && (state.phase === 'dawn' || state.phase === 'dusk')) {
          const heroDelta  = state.nodeScore.hero  - prevScore.hero;
          const witchDelta = state.nodeScore.witch - prevScore.witch;
          const witchCount = state.witchObjectives.filter(obj =>
            state.entities.some(e => e.alive && e.owner === 'witch' && e.col === obj.col && e.row === obj.row)
          ).length;
          const heroCount = state.witchObjectives.filter(obj =>
            state.entities.some(e => e.alive && e.owner === 'hero' && e.col === obj.col && e.row === obj.row)
          ).length;

          const phaseLabel = state.phase === 'dawn' ? '🌅 Dawn Reckoning' : '🌇 Dusk Reckoning';

          let reckoningLine;
          if (witchCount === 3 || heroCount === 3) {
            const who = witchCount === 3 ? 'Witch' : 'Hero';
            reckoningLine = `${who} holds all 3 Power Nodes!`;
          } else if (witchDelta > 0) {
            reckoningLine = `Witch holds ${witchCount} Power Node${witchCount !== 1 ? 's' : ''} to Hero's ${heroCount}. Witch scores 1 victory point.`;
          } else if (heroDelta > 0) {
            reckoningLine = `Hero holds ${heroCount} Power Node${heroCount !== 1 ? 's' : ''} to Witch's ${witchCount}. Hero scores 1 victory point.`;
          } else {
            reckoningLine = `Nodes tied ${heroCount}–${witchCount}. No points scored.`;
          }

          const pip = (filled, cls) =>
            `<span class="score-pip ${cls}${filled ? ' filled' : ''}"></span>`;
          const heroPips  = Array.from({ length: 4 }, (_, i) => pip(i < state.nodeScore.hero,  'hero')).join('');
          const witchPips = Array.from({ length: 4 }, (_, i) => pip(i < state.nodeScore.witch, 'witch')).join('');

          html += `<div class="summary-reckoning">
            <div class="summary-reckoning-title">${phaseLabel}</div>
            <div class="summary-reckoning-result">${reckoningLine}</div>
            <div class="summary-score-track">⚔ ${heroPips}&nbsp;&nbsp;${witchPips} ✦</div>
          </div>`;
        }

        // Game-over: insert win reason at the end
        if (gameOver && winReason) {
          const cls = winner === humanFaction ? 'hero-text' : 'witch-text';
          html += `<div class="summary-game-over ${cls}">${winReason}</div>`;
        }

        eventsEl.innerHTML = html || `<div class="summary-neutral">No notable events this round.</div>`;
      }

      // Render replay-speed mini-picker
      const speedRowEl = this._el('round-summary-speed-row');
      if (speedRowEl) {
        const modes = Object.entries(UIController.SPEED_LABELS);
        speedRowEl.innerHTML = modes.map(([mode, label]) =>
          `<button class="summary-speed-btn${this.speedMode === mode ? ' active' : ''}" data-mode="${mode}">${label}</button>`
        ).join('');
        speedRowEl.querySelectorAll('.summary-speed-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._setSpeed(btn.dataset.mode);
            speedRowEl.querySelectorAll('.summary-speed-btn').forEach(b =>
              b.classList.toggle('active', b.dataset.mode === this.speedMode)
            );
          });
        });
      }

      const nextBtn   = this._el('round-summary-next');
      const replayBtn = this._el('round-summary-replay');
      const actionsEl = el.querySelector('.round-summary-actions');

      // Game-over: replace normal actions with play-again / view-map buttons
      let gameOverBtns = null;
      if (gameOver && actionsEl) {
        // Hide normal buttons
        if (nextBtn)   nextBtn.style.display   = 'none';
        // Keep replay visible
        gameOverBtns = document.createElement('div');
        gameOverBtns.className = 'round-summary-gameover-btns';
        gameOverBtns.innerHTML =
          `<button class="plan-btn primary" data-action="restart">Play Again</button>` +
          `<button class="plan-btn secondary" data-action="viewmap">View Map</button>` +
          (hasFullReplay ? `<button class="plan-btn secondary" data-action="replay-full">Replay Full Game</button>` : '');
        actionsEl.appendChild(gameOverBtns);
      } else if (nextBtn) {
        nextBtn.style.display = '';
        nextBtn.textContent   = 'Next Turn →';
      }

      el.classList.add('visible');

      const cleanup = () => {
        el.classList.remove('visible');
        nextBtn?.removeEventListener('click', onNext);
        replayBtn?.removeEventListener('click', onReplay);
        if (gameOverBtns) gameOverBtns.remove();
        if (nextBtn) nextBtn.style.display = '';
      };
      const onNext   = () => { cleanup(); resolve('next'); };
      const onReplay = () => { cleanup(); resolve('replay'); };

      nextBtn?.addEventListener('click', onNext);
      replayBtn?.addEventListener('click', onReplay);
      if (gameOverBtns) {
        gameOverBtns.querySelector('[data-action="restart"]')?.addEventListener('click', () => { cleanup(); resolve('restart'); });
        gameOverBtns.querySelector('[data-action="viewmap"]')?.addEventListener('click', () => { cleanup(); resolve('viewmap'); });
        gameOverBtns.querySelector('[data-action="replay-full"]')?.addEventListener('click', () => { cleanup(); resolve('replay-full'); });
      }
    });
  }

  // ── Replay HUD ──────────────────────────────────────────────────────────────

  /**
   * Update the fit-button appearance to reflect the current view-lock state.
   */
  _updateFitBtnLockState() {
    const btn = this._el('zoom-fit');
    if (!btn) return;
    const locked = this.renderer?.viewLocked ?? false;
    btn.classList.toggle('view-locked', locked);
    btn.title = locked
      ? 'View locked — double-tap to unlock'
      : 'Fit map to screen (double-tap to lock view)';
  }

  /**
   * Show the replay progress HUD above the canvas.
   * @param {number}   totalRounds
   * @param {Function} onControl  — called with action string: 'back'|'play'|'pause'|'ff'|'vff'|'stop'
   */
  showReplayHUD(totalRounds, onControl) {
    const hud = this._el('replay-hud');
    if (!hud) return;
    hud.style.display = 'flex';
    this._replayOnControl = onControl;

    // Disable the in-game speed toggle while replaying
    const speedToggle = document.getElementById('speed-toggle');
    if (speedToggle) speedToggle.disabled = true;

    // Default to locked view for replay (fit map, no auto-zoom)
    this._preReplayViewLocked = this.renderer?.viewLocked ?? false;
    if (this.renderer && !this.renderer.viewLocked) {
      this.renderer.resize();
      this.renderer.resetView();
      this.renderer._zoomAnim = null;
      this.renderer.viewLocked = true;
    }
    this._updateFitBtnLockState();

    // Wire up control buttons
    const ids = ['back', 'play', 'pause', 'ff', 'vff', 'stop'];
    for (const action of ids) {
      const btn = document.getElementById(`replay-${action}-btn`);
      if (btn) btn.onclick = () => onControl?.(action);
    }

    this.setReplayPlayState('play');
  }

  /**
   * Highlight the currently active replay control button.
   * @param {string} activeAction — 'play'|'pause'|'ff'|'vff'|'back'|'stop'
   */
  setReplayPlayState(activeAction) {
    const ids = ['back', 'play', 'pause', 'ff', 'vff', 'stop'];
    for (const action of ids) {
      const btn = document.getElementById(`replay-${action}-btn`);
      if (btn) btn.classList.toggle('active', action === activeAction);
    }
  }

  /**
   * Sync the main turn-info header to the current state (called after each
   * replay round is restored so the header tracks replay progress).
   */
  updateReplayHUD() {
    this._renderTurnInfo();
  }

  /** Hide the replay HUD. */
  hideReplayHUD() {
    const hud = this._el('replay-hud');
    if (hud) hud.style.display = 'none';
    this._replayOnControl = null;

    // Re-enable the in-game speed toggle
    const speedToggle = document.getElementById('speed-toggle');
    if (speedToggle) speedToggle.disabled = false;

    // Restore view-lock state that existed before replay started
    if (this.renderer) {
      this.renderer.viewLocked = this._preReplayViewLocked ?? false;
      this._updateFitBtnLockState();
    }
  }

  /**
   * Update the live state reference (used by spectator mode and online reconnect).
   * Refreshes the renderer, log, and sidebar without triggering AI.
   */
  updateState(newState) {
    this.state = newState;
    if (this.renderer) this.renderer.state = newState;
    this._renderLog();
    this._updateTurnInfo?.();
    this.onRedraw?.();
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

/**
 * Render a unit card with circular portrait (or glyph fallback).
 * Single shared implementation used by tile-detail, dialogs, etc.
 *
 * @param {object} entity   Entity or snap with type/name/title/hp/maxHp/attack/defense.
 * @param {object} opts
 * @param {Renderer} [opts.renderer]   For portrait lookup. If null, glyph only.
 * @param {boolean} [opts.selectable]  Add `selectable` class + data-unit-id.
 * @param {boolean} [opts.showStats]   Show ATK/DEF stats (default true).
 * @param {number}  [opts.portraitSize] Portrait diameter in px (default 36).
 */
function _unitCardHTML(entity, { renderer = null, selectable = false, showStats = true, portraitSize = 36 } = {}) {
  const GLYPHS = { hero: '⚔', witch: '✦', survivor: '☺', zombie: '†', minion: '☠', wood_golem: '🪵', iron_golem: '⚙' };
  const color  = ENTITY_COLOR[entity.type] || '#888';
  const glyph  = GLYPHS[entity.type] ?? '?';
  const label  = (entity.type === 'survivor' && entity.name) ? entity.name
               : (entity.displayName ?? entity.name ?? entity.type);

  // Portrait image (circular), falling back to text glyph
  const assetId = _entityPortraitId(entity);
  const src     = (renderer && assetId) ? renderer.getPortraitDataURL(assetId, portraitSize * 2) : null;
  const portraitHtml = src
    ? `<img class="tile-unit-card-portrait" src="${src}" style="width:${portraitSize}px;height:${portraitSize}px;border-color:${color};" alt="">`
    : `<span class="tile-unit-card-icon" style="color:${color}">${glyph}</span>`;

  // Stats line
  const hearts = '♥'.repeat(entity.hp ?? 0) + '♡'.repeat(Math.max(0, (entity.maxHp ?? entity.hp ?? 0) - (entity.hp ?? 0)));
  let statsHtml = hearts;
  if (showStats && entity.attack !== undefined) {
    const atkStr = `${entity.attack}${entity.attackBonus ? `+${entity.attackBonus}` : ''}`;
    const defStr = `${entity.defense}${entity.defenseBonus ? `+${entity.defenseBonus}` : ''}`;
    statsHtml = `${hearts} · ATK ${atkStr} · DEF ${defStr}`;
  }

  const cls    = selectable ? 'tile-unit-card selectable' : 'tile-unit-card';
  const dataId = selectable ? ` data-unit-id="${entity.id}"` : '';

  return `<div class="${cls}"${dataId}>${portraitHtml}<span class="tile-unit-card-name" style="color:${color}">${label}</span><span class="tile-unit-card-stats">${statsHtml}</span></div>`;
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
    if (bd.phaseBonus)    parts.push(row('🌙 Night', bd.phaseBonus));
    if (bd.atkStaffBonus) parts.push(row('⚕ Staff (undead)', bd.atkStaffBonus));
    bd.atkExtraDice.forEach((r, i) => {
      parts.push(row(`${bd.atkAllyNames[i] ?? 'Ally'} (D3)`, r, true));
    });
  } else {
    parts.push(row('Base d6', bd.defBaseDie, true));
    parts.push(row(`${snap.name} DEF`, snap.defense));
    if (bd.fortBonus) parts.push(row(`🏰 Fort ×${bd.fortBonus}`, bd.fortBonus));
    if (bd.fatiguePenalty) parts.push(row('😓 Fatigue', -bd.fatiguePenalty));
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
