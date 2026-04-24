// UI controller: handles canvas clicks, sidepanel updates, action buttons
import { hexKey, hexToPixel, MAP_COLS, MAP_ROWS } from './hex.js';
import { TileType, BUILDING_LABEL, BUILDING_ICON, RESOURCE_LABEL, WEAPON_LABEL, ResourceType, MAX_FORTIFY_LEVEL, getFortifyCombatBonus } from './tiles.js';
import { EntityType, SurvivorAbility, ENTITY_COLOR, isLeaderType } from './entities.js';
import { Phase, PHASE_ICON, phaseForRound, DEFAULT_CYCLE_PHASES, nodeController, countHeldNodes } from './game.js';
import { PAD_X, PAD_Y, Renderer } from './renderer.js';
import {
  ActionType, getValidActions, getVisiblePositions,
  buildFogMovementHexes,
} from './actions.js';
import { PlanActionType, actionCosts, computeGhostState, computeProjectedInventory, interleavePlan } from './planner.js';
import { compileTurnBattleSummary } from './battle-utils.js';
import { ResEventType } from '../server/resolver.js';
import { collectUIElements } from './ui-elements.js';
import { buildPlanStepsHtml, buildUnitPlanBlocksHtml, buildPlayerStatusHtml, buildObjectivesHtml } from './ui-render.js';
import {
  hideActionPopup, getEntityScreenPos, computeArcPositions,
  positionArcPopup, startArcTracking, positionPopup,
  attachPopupListeners, touchDist,
} from './ui-popup.js';

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
    this._pendingUnitPick    = null;
    this._pendingDisambig    = null;
    this._pendingDefenderPick = null; // { defenders[], onPick(def) }
    this._pendingEnemyPick   = null;  // { units[] } — enemy info disambiguation
    this._popupVisible    = false;   // tracks whether the action popup is shown
    this._selectedTile    = null;    // { col, row } — tile-only selection (no entity)
    this._arcCloseTimer   = null;    // setTimeout id for arc close animation
    this._arcTrackingRaf  = null;    // rAF id for pan/zoom tracking loop
    this._arcItems        = null;    // current arc item descriptors (for line drawing)
    this._arcEntityCol    = null;    // hex col of arc menu origin
    this._arcEntityRow    = null;    // hex row of arc menu origin

    this._undoBtnRaf      = null;    // rAF id for undo-button pan/zoom tracking
    this._pendingUndoPick = null;    // { entityIds[] } — disambig in flight

    this._touchStart  = null;
    this._pinchDist   = null;
    this._isDragging  = false;
    this._mouseDown   = null;
    this._didDragPan  = false;

    this._lastPostRoundKey = '';   // deduplicates post-round effect animations across state updates
    this._battleInterval   = null; // dice animation interval — cleared on new dialog
    this._autoDismissTimer = null; // battle dialog auto-dismiss timer — cleared on new dialog
    this.speedMode         = this._loadDefaultSpeed(); // 'cinematic' | 'fast' | 'vfast'
    // Start with chronicle hidden by default
    this._chronicleMode    = 'none'; // 'none' | 'mini' | 'full'
    // When true, disable all planning/action UI — used for spectator mode
    this.spectator         = false;
    // When true, suppress phase modals and auto-select — used for tutorial mode
    this.tutorialMode      = false;
    // When true, block all map clicks (set by MissionConductor during dialog steps)
    this.tutorialClickBlocked = false;
    // When true, block the plan submit button (set by MissionConductor until plan_submitted step)
    this.tutorialSubmitBlocked = false;

    // ── App mode (set by main.js via onModeChange) ───────────────────────────
    this.appMode        = 'MENU';  // mirrors AppMode enum from app-mode.js

    // ── Planning mode state ──────────────────────────────────────────────────
    this._planMode      = false;   // true during simultaneous planning phase
    this._unitPlans     = new Map(); // Map<entityId, PlanAction[]> — per-unit queues
    this._planFaction   = null;    // 'hero' or 'witch' — which faction we're planning for
    this._planBudget    = 0;       // total action budget for this round
    this._planSubmitted = false;   // true after plan is locked in
    this.onPlanSubmit   = null;    // callback(plan) — set by main.js

    // ── Multiplayer ──────────────────────────────────────────────────────────
    this.myPlayerId     = null;    // UUID of the local player (null in offline mode)
    this._players       = [];      // full player roster [{playerId,name,faction,isAI}]
    this._countdownTimer = null;   // setInterval handle for countdown display
    this._nudgedThisRound = new Set(); // player IDs nudged this round (reset on planning start)
    this._isAsync       = false;   // true when in an async multiplayer game

    // AbortController for all event listeners bound in _bindEvents().
    // Calling destroy() aborts this signal, removing every listener at once.
    this._eventsAC = new AbortController();

    this._bindEvents();
  }

  /** Remove all event listeners and clean up timers. Call before discarding. */
  destroy() {
    this._eventsAC.abort();
    this._stopCountdown();
    this._dismissGraceDialog();
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
    const sig = { signal: this._eventsAC.signal };

    this.canvas.addEventListener('mousemove', e => this._onMouseMove(e), sig);
    this.canvas.addEventListener('click',     e => this._onClick(e), sig);
    this.canvas.addEventListener('mouseleave', () => {
      this.renderer.hoveredHex = null;
      this._mouseDown = null;
      this._didDragPan = false;
      this.onRedraw();
      if (!this._selectedEntity) this._updateSidebar();
    }, sig);

    // Scroll wheel is disabled over the canvas (zoom via buttons instead)
    this.canvas.addEventListener('wheel', e => { e.preventDefault(); }, { passive: false, ...sig });

    // Mouse drag-to-pan (desktop)
    this.canvas.addEventListener('mousedown', e => {
      if (this.renderer.viewLocked) return;
      this._mouseDown  = { clientX: e.clientX, clientY: e.clientY };
      this._didDragPan = false;
      this.canvas.style.cursor = 'grabbing';
    }, sig);
    // Listen on document so releasing outside the canvas always clears drag state
    document.addEventListener('mouseup', () => {
      if (this._mouseDown) {
        this._mouseDown = null;
        this.canvas.style.cursor = '';
      }
    }, sig);

    // Zoom control buttons (+, −, fit)
    const zoomStep = 1.25;
    this._el('zoom-in')?.addEventListener('click', () => {
      const cx = this.canvas.width  / 2;
      const cy = this.canvas.height / 2;
      this.renderer.setZoom(this.renderer.zoomLevel * zoomStep, cx, cy);
      this.onRedraw();
    }, sig);
    this._el('zoom-out')?.addEventListener('click', () => {
      const cx = this.canvas.width  / 2;
      const cy = this.canvas.height / 2;
      this.renderer.setZoom(this.renderer.zoomLevel / zoomStep, cx, cy);
      this.onRedraw();
    }, sig);
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
    }, sig);
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
    }, sig);
    this._el('speed-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleSpeedPopup();
    }, sig);
    // Speed popup option clicks
    this._el('speed-popup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.speed-option');
      if (btn) this._setSpeed(btn.dataset.mode);
    }, sig);

    // Close speed popup on outside click
    document.addEventListener('click', () => {
      this._closeSpeedPopup();
      this._closeMapOptionsPopup();
    }, sig);

    // Chronicle toggle in map controls area
    this._el('chronicle-toggle')?.addEventListener('click', () => this._cycleChronicle(), sig);

    // Map options toggle
    this._el('map-options-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleMapOptionsPopup();
    }, sig);
    this._el('map-options-popup')?.addEventListener('click', (e) => e.stopPropagation(), sig);
    this._el('opt-tile-images')?.addEventListener('change', (e) => {
      this.renderer.useTileImages = e.target.checked;
      this.renderer.draw();
    }, sig);

    // Touch: tap, drag-to-pan, pinch-to-zoom (mobile)
    this.canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        this._pinchDist  = touchDist(e.touches[0], e.touches[1]);
        this._touchStart = null;
        this._isDragging = false;
        e.preventDefault();
      } else {
        const t = e.touches[0];
        this._touchStart = { clientX: t.clientX, clientY: t.clientY, lastX: t.clientX, lastY: t.clientY };
        this._pinchDist  = null;
        this._isDragging = false;
      }
    }, { passive: false, ...sig });

    this.canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (this.renderer.viewLocked) return;
      if (e.touches.length === 2 && this._pinchDist !== null) {
        const newDist = touchDist(e.touches[0], e.touches[1]);
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
    }, { passive: false, ...sig });

    this.canvas.addEventListener('touchend', e => {
      e.preventDefault();
      if (this._touchStart && !this._isDragging) {
        const t = e.changedTouches[0];
        this._onClick({ clientX: t.clientX, clientY: t.clientY });
      }
      this._touchStart = null;
      this._pinchDist  = null;
      this._isDragging = false;
    }, { passive: false, ...sig });

    // In-game menu modal
    const closeMenu = () => {
      const backdrop = this._el('game-menu-backdrop');
      if (backdrop) backdrop.style.display = 'none';
    };
    this._el('mission-info-btn')?.addEventListener('click', () => {
      this.onMissionInfo?.();
    }, sig);
    this._el('menu-btn')?.addEventListener('click', () => {
      const backdrop = this._el('game-menu-backdrop');
      if (backdrop) backdrop.style.display = backdrop.style.display === 'none' ? 'flex' : 'none';
    }, sig);
    this._el('menu-close-btn')?.addEventListener('click', closeMenu, sig);
    this._el('menu-replay-turn-btn')?.addEventListener('click', () => {
      closeMenu();
      this.onReplayLastTurn?.();
    }, sig);
    this._el('menu-quit-btn')?.addEventListener('click', () => {
      closeMenu();
      this.onQuitToMenu?.();
    }, sig);
    this._el('menu-resign-btn')?.addEventListener('click', () => {
      closeMenu();
      this.onResignGame?.();
    }, sig);
    // Close on backdrop click (not modal itself)
    this._el('game-menu-backdrop')?.addEventListener('click', e => {
      if (e.target === this._el('game-menu-backdrop')) closeMenu();
    }, sig);
    this._el('game-menu-backdrop')?.addEventListener('touchstart', e => {
      if (e.target === this._el('game-menu-backdrop')) closeMenu();
    }, { passive: true, ...sig });

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
    }, { passive: true, ...sig });
    document.addEventListener('touchmove', e => {
      if (!this._edgeSwipe) return;
      const t = e.touches[0];
      const dy = Math.abs(t.clientY - this._edgeSwipe.startY);
      // Cancel if vertical movement exceeds horizontal (scrolling)
      if (dy > 60) { this._edgeSwipe = null; }
    }, { passive: true, ...sig });
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
        this._renderEndTurnBtn();
      } else if (panel && !this._edgeSwipe.collapsed && dx > threshold) {
        // Swiped right — close panel
        panel.classList.add('collapsed');
        this._syncPlanInset();
        this._renderPlanPanel();
        this._renderEndTurnBtn();
      }
      this._edgeSwipe = null;
    }, { passive: true, ...sig });

    // Chronicle: three-state button lives inside #chronicle-mini (wired on each render).
    // chronicle-close / chronicle-sidebar-close close back to 'none'.
    this._el('chronicle-close')?.addEventListener('click', () => {
      this._setChronicleMode('none');
    }, sig);
    this._el('chronicle-overlay')?.addEventListener('click', e => {
      if (e.target === this._el('chronicle-overlay')) this._setChronicleMode('none');
    }, sig);
    this._el('chronicle-sidebar-toggle')?.addEventListener('click', () => {
      this._cycleChronicle();
    }, sig);


    // Tile zoom close
    this._el('tile-zoom-close')?.addEventListener('click', () => this._hideTileDetail(), sig);
    this._el('tile-zoom-overlay')?.addEventListener('click', e => {
      if (e.target === this._el('tile-zoom-overlay')) this._hideTileDetail();
    }, sig);

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
    }, sig);

    // Submit Plan button in header — submit only (separate return-to-menu button)
    const _submitHandler = () => {
      if (this.state.gameOver) return;
      if (this._planMode) this._doSubmitPlan();
    };
    this._el('end-turn-btn')?.addEventListener('click', _submitHandler, sig);
    this._el('end-turn-btn')?.addEventListener('touchend', e => {
      e.preventDefault(); _submitHandler();
    }, { passive: false, ...sig });

    // Return-to-menu button in header — shown only after plan submission
    const _returnHandler = () => { if (this.onReturnToMenu) this.onReturnToMenu(); };
    this._el('plan-return-btn')?.addEventListener('click', _returnHandler, sig);
    this._el('plan-return-btn')?.addEventListener('touchend', e => {
      e.preventDefault(); _returnHandler();
    }, { passive: false, ...sig });

    // Replay last turn button in header
    const _replayHandler = () => { if (this.onReplayLastTurn) this.onReplayLastTurn(); };
    this._el('replay-turn-btn')?.addEventListener('click', _replayHandler, sig);
    this._el('replay-turn-btn')?.addEventListener('touchend', e => {
      e.preventDefault(); _replayHandler();
    }, { passive: false, ...sig });

    // Plan panel buttons — touchend for instant mobile response
    const _tap = (el, fn) => {
      el?.addEventListener('click', fn, sig);
      el?.addEventListener('touchend', e => { e.preventDefault(); fn(); }, { passive: false, ...sig });
    };
    _tap(this._el('plan-submit-btn'), () => this._doSubmitPlan());
    _tap(this._el('plan-menu-btn'), () => { if (this.onReturnToMenu) this.onReturnToMenu(); });
    _tap(this._el('plan-clear-btn'),  () => {
      if (this._planSubmitted) return;
      this._unitPlans = new Map();
      this._refreshPlanOverlay();
      this._renderPlanPanel();
      if (this._selectedEntity) this._selectEntity(this._selectedEntity);
      this.onRedraw();
    });
    _tap(this._el('plan-toggle-btn'), () => this._togglePlanPanel());
    _tap(this._el('plan-tab'),        () => this._togglePlanPanel());

    // Delegated click handler for nudge buttons inside the player list
    this._el('plan-players')?.addEventListener('click', e => {
      const btn = e.target.closest('.nudge-btn');
      if (!btn || btn.disabled) return;
      const targetId = btn.dataset.nudgeId;
      if (!targetId || !this.mp) return;
      this.mp.sendNudge(targetId);
      this._nudgedThisRound.add(targetId);
      this._renderPlayerStatus();
    }, sig);
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

  // ── Planning mode ─────────────────────────────────────────────────────────

  /**
   * Enter planning mode.
   * @param {'hero'|'witch'} faction  Which faction the human controls.
   * @param {number} budget           Action budget for this round.
   */
  enterPlanningMode(faction, budget, timeoutMs = 0) {
    console.log(`[ui] enterPlanningMode: faction=${faction} budget=${budget} timeoutMs=${timeoutMs}`);
    this._planMode         = true;
    this._planFaction      = faction;
    this._planBudget       = budget;
    this._unitPlans        = new Map();
    // Clear state-recovery flag if a recovery was pending
    this._stateRecoveryPending = false;
    if (this._stateRecoveryTimer) { clearTimeout(this._stateRecoveryTimer); this._stateRecoveryTimer = null; }
    this._planSubmitted    = false;

    // Clear stale waiting status text from previous round/session
    const statusEl = this._el('plan-status');
    if (statusEl) statusEl.textContent = '';

    // Reset footer buttons
    const submitBtn = this._el('plan-submit-btn');
    if (submitBtn) submitBtn.style.display = '';
    const clearBtn = this._el('plan-clear-btn');
    if (clearBtn) clearBtn.style.display = '';
    const menuBtn = this._el('plan-menu-btn');
    if (menuBtn) menuBtn.style.display = 'none';
    const returnBtn = this._el('plan-return-btn');
    if (returnBtn) returnBtn.style.display = 'none';

    // Show replay button if there's history to replay
    const replayBtn = this._el('replay-turn-btn');
    if (replayBtn) replayBtn.style.display = this._hasReplayHistory ? '' : 'none';

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
        e.alive && e.owner === faction && isLeaderType(e.type) &&
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
    // Skip when re-entering planning after an inline replay (player already saw it this round).
    // Phase info is now shown in the merged resolution summary dialog

    // If attrition just increased, show a blocking popup after the toast settles.
    if (this.state.attritionChanged && this.state.attritionLevel > 0) {
      this.state.attritionChanged = false; // consume the flag
      setTimeout(() => this._showAttritionPopup(), 400);
    }

    // Multiplayer: reset submission status panel and start countdown.
    // Clear previous-round submitted flags and nudge state.
    if (this._players) this._players.forEach(p => { p._submitted = !!p.submitted; });
    this._nudgedThisRound.clear();
    this._renderPlayerStatus();
    if (timeoutMs > 0) this._startCountdown(timeoutMs);
  }

  /** Exit planning mode (called after resolution completes). */
  exitPlanningMode() {
    this._stopUndoBtnTracking();
    this._planMode      = false;
    // NOTE: _planSubmitted is intentionally NOT reset here. It guards against
    // a double-fire of the submit button (touchend + click on mobile, or a
    // fast double-click) — the offline/campaign plan-submit handler calls
    // exitPlanningMode synchronously before state.submitPlan returns, so
    // resetting here would let the stray second tap fire _doSubmitPlan again
    // with a cleared _unitPlans, producing a "0 steps" submit and sometimes
    // a "Not in planning phase" throw. enterPlanningMode() resets
    // _planSubmitted at the start of the next round, which is the correct
    // lifecycle for the flag.
    this._unitPlans     = new Map();
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
    // Hide player list for 1v1 standard games; always show for battle mode
    if (players.length <= 1 && this.state?.gameMode !== 'battle') {
      el.style.display = 'none';
      return;
    }

    el.style.display = '';
    const nudgeCtx = this._isAsync && this.myPlayerId
      ? { myPlayerId: this.myPlayerId, nudgedSet: this._nudgedThisRound }
      : undefined;
    el.innerHTML = buildPlayerStatusHtml(players, nudgeCtx);
  }

  /** Called when the server notifies that another player has submitted. */
  _onPlayerSubmitted(playerId, name, faction) {
    const p = this._players?.find(pl => (pl.playerId ?? pl.id) === playerId);
    if (p) p._submitted = true;
    this._renderPlayerStatus();
    if (this._planSubmitted) this._updateWaitingStatus();
  }

  /**
   * Update #plan-status with waiting message, optional player count, and countdown.
   * Called on submission, on playerSubmitted events, and from the countdown tick.
   * @param {number} [totalSecs] - seconds remaining; omit to derive from _countdownEnd
   */
  _updateWaitingStatus(totalSecs) {
    const status = this._el('plan-status');
    if (!status) return;

    // Build player-count fragment: "2/4" if multiplayer
    const players = this._players ?? [];
    const total = players.length;
    const submitted = players.filter(p => p._submitted).length;
    const countPart = total > 1 ? `${submitted}/${total}` : '';

    // Build countdown fragment
    if (totalSecs === undefined && this._countdownEnd) {
      totalSecs = Math.max(0, Math.ceil((this._countdownEnd - Date.now()) / 1000));
    }
    const timePart = totalSecs > 0 ? _formatCountdown(totalSecs) : '';

    // Assemble: "Waiting for opponents… 2/4 · 1:23"
    let text = 'Waiting for opponents\u2026';
    const details = [countPart, timePart].filter(Boolean).join(' \u00b7 ');
    if (details) text += ' ' + details;
    status.textContent = text;
  }

  /** Called when the server broadcasts updated player presence. */
  _onPlayerPresence(players) {
    if (!this._players) return;
    // Check if the roster has changed (new players joined, AI replaced, etc.)
    const knownIds = new Set(this._players.map(p => p.playerId ?? p.id));
    const incomingIds = new Set(players.map(p => p.playerId ?? p.id));
    const rosterChanged = players.length !== this._players.length ||
      players.some(p => !knownIds.has(p.playerId ?? p.id));

    if (rosterChanged) {
      // Full roster replacement — a late-joiner replaced a placeholder AI
      this._players = players.map(p => ({ ...p, _submitted: !!p.submitted }));
    } else {
      for (const update of players) {
        const p = this._players.find(pl => (pl.playerId ?? pl.id) === update.playerId);
        if (p) {
          p.connected = update.connected;
          p.active    = update.active;
          p.name      = update.name;
          p.isAI      = update.isAI;
          if ('submitted' in update) p._submitted = !!update.submitted;
        }
      }
    }
    this._renderPlayerStatus();
  }

  /** Start a countdown timer — progress bar on submit button + floating button. */
  _startCountdown(timeoutMs) {
    console.log(`[ui] _startCountdown: timeoutMs=${timeoutMs}`);
    this._stopCountdown();
    const submitBtn = this._el('plan-submit-btn');
    if (!submitBtn) return;

    const GRACE_PERIOD = 5000;
    const end = Date.now() + timeoutMs;
    this._countdownEnd   = end;
    this._countdownTotal = timeoutMs;

    const floatBtn = this._el('end-turn-btn');

    const tick = () => {
      const remaining = Math.max(0, end - Date.now());
      const totalSecs = Math.ceil(remaining / 1000);
      const pct  = (remaining / timeoutMs) * 100;

      if (this._planSubmitted) {
        // After submission: show countdown in plan-status text instead of buttons
        this._updateWaitingStatus(totalSecs);
        if (remaining <= 0) {
          this._stopCountdownTimer();
        }
        return;
      }

      const label = totalSecs > 0 ? `\u2713 Submit ${_formatCountdown(totalSecs)}` : '\u2713 Submit';

      submitBtn.style.setProperty('--progress', pct + '%');
      submitBtn.textContent = label;
      submitBtn.classList.toggle('countdown-urgent', totalSecs <= 10);

      // Mirror progress on the floating submit button
      if (floatBtn) {
        floatBtn.style.setProperty('--progress', pct + '%');
        floatBtn.textContent = label;
        floatBtn.classList.toggle('countdown-urgent', totalSecs <= 10);
      }

      if (remaining <= GRACE_PERIOD && !this._graceActive) {
        this._stopCountdownTimer();
        this._showGraceDialog(remaining);
      }
    };
    tick();
    this._countdownTimer = setInterval(tick, 500);
  }

  /** Reset the countdown to a new deadline (called when the server extends the timer). */
  resetCountdown(timeoutMs) {
    if (this._planMode && timeoutMs > 0) {
      this._startCountdown(timeoutMs);
    }
  }

  /** Stop just the main countdown interval (not the grace dialog). */
  _stopCountdownTimer() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  }

  /** Stop countdown and reset submit button / floating button to default state. */
  _stopCountdown() {
    this._stopCountdownTimer();
    this._countdownEnd   = null;
    this._countdownTotal = null;

    const submitBtn = this._el('plan-submit-btn');
    if (submitBtn) {
      submitBtn.style.removeProperty('--progress');
      submitBtn.textContent = '\u2713 Submit';
      submitBtn.classList.remove('countdown-urgent');
    }

    const floatBtn = this._el('end-turn-btn');
    if (floatBtn) {
      floatBtn.style.removeProperty('--progress');
      floatBtn.classList.remove('countdown-urgent');
    }

    this._dismissGraceDialog();
  }

  /** Show grace dialog when planning time expires; auto-submits current plan. */
  _showGraceDialog(remainingMs) {
    if (this._planSubmitted) return;
    this._graceActive = true;

    const dialog    = this._el('grace-dialog');
    const secsSpan  = this._el('grace-seconds');
    const submitBtn = this._el('plan-submit-btn');
    if (!dialog) return;
    dialog.classList.add('visible');

    const graceEnd = Date.now() + remainingMs;

    // Wire button handlers via AbortController for clean teardown
    const ac = new AbortController();
    this._graceAbort = ac;

    this._el('grace-submit-current')?.addEventListener('click', () => {
      this._dismissGraceDialog();
      this._doSubmitPlan();
    }, { signal: ac.signal });

    this._el('grace-submit-empty')?.addEventListener('click', () => {
      console.log('[ui] grace-submit-empty clicked — clearing plan');
      this._dismissGraceDialog();
      this._unitPlans = new Map();
      this._doSubmitPlan();
    }, { signal: ac.signal });

    this._graceTimer = setInterval(() => {
      const left = Math.max(0, graceEnd - Date.now());
      const s = Math.ceil(left / 1000);
      if (secsSpan) secsSpan.textContent = String(s);

      // Keep draining the submit buttons to 0
      const graceLabel = `\u2713 Submit 00:0${s}`;
      if (submitBtn) {
        submitBtn.style.setProperty('--progress', '0%');
        submitBtn.textContent = graceLabel;
      }
      const floatBtnGrace = this._el('end-turn-btn');
      if (floatBtnGrace) {
        floatBtnGrace.style.setProperty('--progress', '0%');
        floatBtnGrace.textContent = graceLabel;
      }

      if (left <= 0) {
        console.log('[ui] grace timer expired — auto-submitting current plan');
        this._dismissGraceDialog();
        this._doSubmitPlan(); // default: submit current plan
      }
    }, 250);
  }

  /** Dismiss the grace dialog and clean up timers/listeners. */
  _dismissGraceDialog() {
    this._graceActive = false;
    if (this._graceTimer) {
      clearInterval(this._graceTimer);
      this._graceTimer = null;
    }
    if (this._graceAbort) {
      this._graceAbort.abort();
      this._graceAbort = null;
    }
    const dialog = this._el('grace-dialog');
    if (dialog) dialog.classList.remove('visible');
  }

  /** Add one action to the per-unit plan queue. */
  _addToPlan(action) {
    if (this._planSubmitted) return;

    // ── Plan cap: 1.5× (budget + food) — prevent runaway queues ────────
    const isFreeAction = action.type === PlanActionType.EQUIP_WEAPON
                      || action.type === PlanActionType.USE_ITEM;
    if (!isFreeAction) {
      const flatPlan = interleavePlan(this._unitPlans);
      const currentCost = flatPlan.filter(a => actionCosts(a.type)).length;
      const foodAvailable = (this.state.inventory?.hero?.[ResourceType.FOOD] || 0);
      const cap = Math.ceil((this._planBudget + foodAvailable) * 1.5);

      if (currentCost >= cap) {
        this._showPlanToast('Plan is full — no more actions can be added.');
        return;
      }

      const newCost = currentCost + 1;
      if (newCost > this._planBudget && newCost <= this._planBudget + foodAvailable) {
        this._showPlanToast('Over budget — this action will consume food.');
      } else if (newCost > this._planBudget + foodAvailable) {
        this._showPlanToast('Over budget & food — this action may not execute.');
      }

      // Check if plan is now full after adding
      if (newCost >= cap) {
        // Defer so the "food" toast above doesn't get immediately replaced
        setTimeout(() => this._showPlanToast('Plan is full — cap reached.'), 100);
      }
    }

    if (!this._unitPlans.has(action.entityId)) {
      this._unitPlans.set(action.entityId, []);
    }
    this._unitPlans.get(action.entityId).push(action);
    console.log(`[ui] _addPlanAction: type=${action.type} entityId=${action.entityId} totalActions=${[...this._unitPlans.values()].reduce((n, q) => n + q.length, 0)}`);
    this.onPlanActionAdded?.(action);
    this._refreshPlanOverlay();
    this._renderPlanPanel();
    this._refreshUndoButtons();
    this._startUndoBtnTracking();
  }

  /** Recompute ghost overlay from the current plan and push to renderer. */
  _refreshPlanOverlay() {
    if (!this.renderer) return;
    const flatPlan = interleavePlan(this._unitPlans);
    const steps = computeGhostState(this.state, flatPlan);
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

  /**
   * Return the hex (if any) where the currently selected unit's last planned
   * action resolves, so a single floating [UNDO] button can be placed above it.
   * The UNDO button is only shown for the active selected unit — other units'
   * queued actions are undone by selecting those units first.
   * @returns {Array<{col:number,row:number,entityIds:any[]}>} zero or one bucket.
   */
  _computeLastActionHexes() {
    if (!this._planMode || this._planSubmitted) return [];

    const selectedId = this._selectedEntity?.id;
    if (selectedId == null || this._isEnemySelection) return [];

    const queue = this._unitPlans.get(selectedId);
    if (!queue || queue.length < 1) return [];

    const steps = this.renderer?.planGhostSteps;
    const finalPositions = steps?.length ? steps[steps.length - 1].positions : null;

    let pos = finalPositions?.get(selectedId) ?? null;
    if (!pos) {
      const ent = this.state?.entities?.find(e => e.id === selectedId);
      if (ent) pos = { col: ent.col, row: ent.row };
    }
    if (!pos) return [];

    return [{ col: pos.col, row: pos.row, entityIds: [selectedId] }];
  }

  /**
   * Attach layer-level click/touchend delegation once. Buttons carry a
   * `data-key` ("col,row"); the handler looks up the live bucket at event
   * time so we don't need to rebind handlers each frame.
   */
  _initUndoLayerEvents() {
    if (this._undoLayerInited) return;
    const layer = this._el('undo-button-layer');
    if (!layer || typeof layer.addEventListener !== 'function') return;
    this._undoLayerInited = true;
    const handle = (e) => {
      const btn = e.target?.closest?.('.undo-float-btn');
      if (!btn) return;
      if (e.type === 'touchend' && typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      const key = btn.dataset?.key;
      if (!key) return;
      const bucket = this._computeLastActionHexes()
        .find(b => `${b.col},${b.row}` === key);
      if (bucket) this._onUndoButtonClicked(bucket);
    };
    layer.addEventListener('click', handle);
    layer.addEventListener('touchend', handle, { passive: false });
  }

  /** Render (or clear) floating UNDO buttons for the current plan state. */
  _refreshUndoButtons() {
    const layer = this._el('undo-button-layer');
    if (!layer) return;
    this._initUndoLayerEvents();

    if (!this._planMode || this._planSubmitted || !this.renderer || !this.canvas) {
      if ((layer.childNodes?.length ?? 0)) layer.innerHTML = '';
      return;
    }

    const buckets = this._computeLastActionHexes();
    if (buckets.length === 0) {
      if ((layer.childNodes?.length ?? 0)) layer.innerHTML = '';
      return;
    }

    const canvasRect = this.canvas.getBoundingClientRect();
    const scale = canvasRect.width / this.canvas.width;
    const hexScreenPx = this.renderer.hexSize * scale * this.renderer.zoomLevel;

    // Suppress buttons that would draw behind the plan panel (visible only).
    const planPanel = this._el('plan-panel');
    let panelLeft = Infinity;
    if (planPanel && typeof planPanel.getBoundingClientRect === 'function') {
      const pr = planPanel.getBoundingClientRect();
      if (pr && pr.width > 0 && pr.height > 0) panelLeft = pr.left;
    }

    // Build desired state keyed by hex.
    const desired = new Map();
    for (const b of buckets) {
      const { x, y } = this.renderer.hexToCanvasPos(b.col, b.row);
      const sx = canvasRect.left + x * scale;
      const sy = canvasRect.top  + y * scale - hexScreenPx * 0.85;
      if (sx >= panelLeft) continue;
      desired.set(`${b.col},${b.row}`, { sx, sy });
    }

    // Reconcile existing children with desired state. Mutating in place
    // (instead of rebuilding innerHTML at 60fps) keeps each button as a
    // stable touch target across frames — otherwise a tap is destroyed
    // mid-gesture and the UNDO press never registers on mobile.
    const existing = new Map();
    const children = Array.from(layer.children || []);
    for (const child of children) {
      const k = child.dataset?.key;
      if (k && desired.has(k)) existing.set(k, child);
      else if (typeof child.remove === 'function') child.remove();
    }
    for (const [key, { sx, sy }] of desired) {
      let btn = existing.get(key);
      if (btn) {
        btn.style.left = `${sx}px`;
        btn.style.top  = `${sy}px`;
        continue;
      }
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'undo-float-btn';
      btn.textContent = 'UNDO';
      btn.dataset.key = key;
      btn.style.left = `${sx}px`;
      btn.style.top  = `${sy}px`;
      layer.appendChild(btn);
    }
  }

  /** Dispatch an undo click — single unit → undo; multiple → disambig popup. */
  _onUndoButtonClicked(bucket) {
    if (!bucket || !bucket.entityIds || bucket.entityIds.length === 0) return;
    if (bucket.entityIds.length === 1) {
      this._undoLastActionFor(bucket.entityIds[0]);
    } else {
      this._showUndoDisambig(bucket);
    }
  }

  /** Pop the last planned action for the given entity and refresh UI. */
  _undoLastActionFor(entityId) {
    const queue = this._unitPlans.get(entityId);
    if (!queue || queue.length === 0) return;
    queue.pop();
    if (queue.length === 0) this._unitPlans.delete(entityId);

    // Spec: clicking undo also deselects the unit.
    this._clearSelection();
    this._refreshPlanOverlay();
    this._renderPlanPanel();
    this._refreshUndoButtons();
    this.onRedraw();
  }

  /** Show the arc disambig popup for choosing which unit to undo on a shared hex. */
  _showUndoDisambig(bucket) {
    const units = bucket.entityIds
      .map(id => this.state?.entities?.find(e => e.id === id))
      .filter(u => u);
    if (units.length === 0) return;
    this._pendingUndoPick = { entityIds: bucket.entityIds.slice() };
    this._showArcDisambig(units, 'undo_pick', { col: bucket.col, row: bucket.row }, [
      { label: 'Undo', action: 'undo_cancel', color: '#d23c3c' },
    ]);
  }

  /**
   * RAF loop: keep undo buttons pinned to their hexes during pan/zoom.
   * Self-terminates when the plan becomes empty or planning mode exits —
   * re-started on demand by `_refreshUndoButtons()` whenever buttons are drawn.
   */
  _startUndoBtnTracking() {
    if (this._undoBtnRaf) return;
    const tick = () => {
      this._undoBtnRaf = null;
      if (!this._planMode || this._planSubmitted) {
        const layer = this._el('undo-button-layer');
        if (layer && (layer.childNodes?.length ?? 0)) layer.innerHTML = '';
        return;
      }
      // If there are no buttons to show, stop the loop — _refreshUndoButtons()
      // will restart it the next time a plan action is added.
      if (this._unitPlans.size === 0) {
        const layer = this._el('undo-button-layer');
        if (layer && (layer.childNodes?.length ?? 0)) layer.innerHTML = '';
        return;
      }
      this._refreshUndoButtons();
      // Only keep ticking while there are buttons on screen.
      const layer = this._el('undo-button-layer');
      if (layer && (layer.childNodes?.length ?? 0) > 0) {
        this._undoBtnRaf = requestAnimationFrame(tick);
      }
    };
    this._undoBtnRaf = requestAnimationFrame(tick);
  }

  _stopUndoBtnTracking() {
    if (this._undoBtnRaf) {
      cancelAnimationFrame(this._undoBtnRaf);
      this._undoBtnRaf = null;
    }
    const layer = this._el('undo-button-layer');
    if (layer && (layer.childNodes?.length ?? 0)) layer.innerHTML = '';
  }

  /** Submit the current plan (flattened to interleaved PlanAction[]). */
  _doSubmitPlan() {
    if (this._planSubmitted) return;
    if (this.tutorialSubmitBlocked) return;
    const plan = interleavePlan(this._unitPlans);
    console.log(`[ui] _doSubmitPlan: ${plan.length} actions [${plan.map(a => a.type).join(', ')}]`);
    this.markPlanSubmitted();
    if (this.onPlanSubmit) this.onPlanSubmit(plan);
  }

  /** Mark the plan as submitted (read-only wait state) without firing onPlanSubmit. */
  markPlanSubmitted() {
    if (this._planSubmitted) return;
    this._planSubmitted = true;
    this._stopUndoBtnTracking();
    this._clearSelection();

    const panel = this._el('plan-panel');
    if (panel) panel.classList.add('plan-submitted');

    // Update waiting status text (countdown will keep ticking via _startCountdown)
    this._updateWaitingStatus();

    // Mark ourselves as submitted in the player list so the status panel updates.
    const me = this._players?.find(p => (p.playerId ?? p.id) === this.myPlayerId);
    if (me) me._submitted = true;
    this._renderPlayerStatus();

    this._updateSidebar();
    this.onRedraw();
  }

  /** Render the plan panel steps list (per-unit blocks). */
  _renderPlanPanel() {
    const stepsEl  = this._el('plan-steps');
    const budgeEl  = this._el('plan-budget-badge');
    const statusEl = this._el('plan-status');
    if (!stepsEl) return;

    // Count budget-consuming actions across all unit queues
    const flatPlan = interleavePlan(this._unitPlans);
    const budgetCost = flatPlan.filter(a =>
      a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM
    ).length;
    const remaining = this._planBudget - budgetCost;

    if (budgeEl) budgeEl.textContent = `${Math.max(0, remaining)} left`;

    // Food is auto-applied to over-budget actions until exhausted.
    const foodAvailable = (this.state.inventory?.hero?.[ResourceType.FOOD] || 0);

    const initialInv = computeProjectedInventory(this.state, []);

    // Gather controllable units + build a portrait map so the plan panel can
    // show a row for every unit the local player owns (even units with zero
    // queued actions) and use actual portraits instead of glyphs.
    const controllable = this._getControllableUnits();
    const portraitMap = new Map();
    for (const e of controllable) {
      const assetId = _entityPortraitId(e);
      if (assetId && this.renderer) {
        portraitMap.set(e.id, this.renderer.getPortraitDataURL(assetId, 48));
      }
    }

    stepsEl.innerHTML = buildUnitPlanBlocksHtml(
      this._unitPlans, this._planBudget, foodAvailable,
      this._planSubmitted, this.state.entities ?? [], initialInv,
      controllable, this._selectedEntity?.id ?? null, portraitMap,
    );

    // Attach remove listeners — per-unit: data-entity-id + data-step-idx
    stepsEl.querySelectorAll('.plan-step-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const entityId = btn.dataset.entityId;
        const idx = parseInt(btn.dataset.stepIdx);
        const queue = this._unitPlans.get(entityId);
        if (queue) {
          queue.splice(idx, 1);
          if (queue.length === 0) this._unitPlans.delete(entityId);
        }
        this._refreshPlanOverlay();
        this._renderPlanPanel();
        this._refreshUndoButtons();
        // Refresh highlights for the selected entity after plan changes
        if (this._selectedEntity) this._selectEntity(this._selectedEntity);
        this.onRedraw();
      });
    });

    // Click on a unit block → select that unit on the map.
    stepsEl.querySelectorAll('.plan-unit-block').forEach(block => {
      block.addEventListener('click', e => {
        // Don't steal clicks meant for the per-step remove ✕.
        if (e.target.closest('.plan-step-remove')) return;
        const id = block.dataset.entityId;
        const entity = this.state.entities.find(x => x.id === id && x.alive);
        if (!entity) return;
        this._selectEntity(entity);
        this._updateSidebar();
        this.onRedraw();
        this._centerOnEntity(entity);
      });
    });

    // Clear the old food row (food is now shown inline on over-budget actions)
    const foodRowEl = this._el('plan-food-row');
    if (foodRowEl) foodRowEl.innerHTML = '';

    if (statusEl && !this._planSubmitted) statusEl.textContent = '';

    // Keep the collapse-tab count badge in sync — show count and color by budget state
    const tabCount = this._el('plan-tab-count');
    if (tabCount) {
      tabCount.textContent = budgetCost;
      const foodAvail = this.state?.inventory?.hero?.[ResourceType.FOOD] || 0;
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
    // Update the side-tab +/- affordance to match collapsed state
    const tabToggle = this._el('plan-tab-toggle');
    if (tabToggle && panel) {
      tabToggle.textContent = panel.classList.contains('collapsed') ? '+' : '\u2212';
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
    const tabToggle = this._el('plan-tab-toggle');
    if (tabToggle) tabToggle.textContent = isCollapsed ? '+' : '\u2212';
    this._syncPlanInset();
    this._renderEndTurnBtn();
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
    if (this.tutorialClickBlocked) return;
    if (this.state.gameOver) return;

    const { x, y } = this._canvasPos(e);
    const hex = this._canvasToHex(x, y);
    if (hex.col < 0 || hex.col >= MAP_COLS || hex.row < 0 || hex.row >= MAP_ROWS) return;

    // Full fog: clicking a fully black (unexplored) hex does nothing.
    if (this._isFullyFogged(hex.col, hex.row)) return;

    // Spectators: view tile/unit info only — no actions or planning
    if (this.spectator) {
      this._showTileDetail(hex);
      this.onRedraw();
      return;
    }

    // Outside planning mode, allow viewing tiles/units but block all actions.
    // During resolution/summary/playback, ignore clicks entirely.
    // If appMode is PLANNING but _planMode hasn't been set yet (race between
    // mode transition and enterPlanningMode call), ignore clicks rather than
    // falling through to tile-detail which blocks all UI interaction.
    if (!this._planMode) {
      if (this.appMode === 'RESOLVING' || this.appMode === 'SUMMARY' ||
          this.appMode === 'PLAYBACK' || this.appMode === 'PLANNING') return;
      // SUBMITTED or MENU: view-only unit inspection + tile info
      this._handleViewOnlyClick(hex);
      return;
    }

    // During planning, same click-to-select/target flow — but actions go to plan queue
    if (this._planMode && this._planSubmitted) {
      // Plan locked — view-only unit inspection + tile info
      this._handleViewOnlyClick(hex);
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
      if (this._isEnemySelection) {
        // Enemy unit: second tap deselects, no popup
        this._clearSelection();
      } else if (this._popupVisible) {
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
      if (this.myPlayerId && e.ownerId && e.ownerId !== this.myPlayerId) {
        // Diagnostic: when a friendly entity is rejected by ownerId, log
        // the mismatch exactly once per entity so we can tell whether the
        // client's myPlayerId drifted from the entity's ownerId.
        if (e.col === hex.col && e.row === hex.row && !this._loggedOwnerMismatch?.has(e.id)) {
          this._loggedOwnerMismatch = this._loggedOwnerMismatch ?? new Set();
          this._loggedOwnerMismatch.add(e.id);
          console.warn(`[ui] selection rejected as ally: entity ${e.id} (${e.type}, owner=${e.owner}) ownerId=${e.ownerId} ≠ myPlayerId=${this.myPlayerId}`);
        }
        return false;
      }
      const ghostPos = lastGhostPos?.get(e.id);
      // In planning mode, if the entity has been moved in the plan, use ONLY the
      // ghost position — it should no longer appear on its real tile.
      const pos = (this._planMode && ghostPos) ? ghostPos : { col: e.col, row: e.row };
      return pos.col === hex.col && pos.row === hex.row;
    });

    if (clickedEntities.length === 0) {
      // No controllable units — check for any visible non-controllable units
      // (enemies OR allied teammates' units in N-player MP) for view-only selection.
      const viewOnlyEntities = _visibleUnitsAt(state, hex.col, hex.row)
        .filter(e => {
          // Enemy faction → always view-only
          if (e.owner !== ownerFilter) return true;
          // Same faction but a different player → ally, view-only
          if (this.myPlayerId && e.ownerId && e.ownerId !== this.myPlayerId) return true;
          return false;
        });
      if (viewOnlyEntities.length > 1) {
        this._hideTileDetail();
        this._selectedEntity       = null;
        this._popupVisible         = true;
        this._validActions         = [];
        this.renderer.selectedHex    = { col: hex.col, row: hex.row };
        this.renderer.highlightHexes = [];
        this._pendingEnemyPick = { units: viewOnlyEntities };
        this._showActionPopup(null);
      } else if (viewOnlyEntities.length === 1) {
        this._hideTileDetail();
        this._selectEnemyEntity(viewOnlyEntities[0]);
      } else {
        // Empty hex — show tile info in stats bar
        this._clearSelection();
        this._selectedTile = { col: hex.col, row: hex.row };
        this.renderer.selectedHex = { col: hex.col, row: hex.row };
      }
    } else if (clickedEntities.length === 1) {
      const entity = clickedEntities[0];
      if (entity === this._selectedEntity) {
        // Second tap → show popup; third tap → dismiss popup
        if (this._popupVisible) {
          this._popupVisible = false;
          hideActionPopup(this);
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

  /** View-only click handler — select units for inspection or show tile info. No actions. */
  _handleViewOnlyClick(hex) {
    // Tap already-selected entity's hex → deselect
    if (this._selectedEntity &&
        hex.col === this._selectedEntity.col && hex.row === this._selectedEntity.row) {
      this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
      return;
    }
    this._clearSelection();
    const viewUnits = _visibleUnitsAt(this.state, hex.col, hex.row);
    if (viewUnits.length > 1) {
      // Multiple units on hex — show picker popup
      this._popupVisible = true;
      this._validActions = [];
      this.renderer.selectedHex = { col: hex.col, row: hex.row };
      this.renderer.highlightHexes = [];
      this._pendingEnemyPick = { units: viewUnits };
      this._showActionPopup(null);
    } else if (viewUnits.length === 1) {
      this._selectEnemyEntity(viewUnits[0]);
    } else {
      // Empty hex — show tile info
      this._selectedTile = { col: hex.col, row: hex.row };
      this.renderer.selectedHex = { col: hex.col, row: hex.row };
    }
    this._updateSidebar();
    this.onRedraw();
  }

  _selectEntity(entity) {
    this._selectedEntity  = entity;
    this._isEnemySelection = false;
    this.onEntitySelected?.(entity);
    this._pendingUnitPick = null;
    this._popupVisible    = false;
    hideActionPopup(this);

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
    // Refresh the plan panel so its selection highlight tracks the selected
    // unit. Only during planning mode (when the panel is visible).
    if (this._planMode) {
      this._renderPlanPanel();
      this._refreshUndoButtons();
      this._startUndoBtnTracking();
    }
    // Popup is NOT shown here — user taps the unit a second time to open it
  }

  /** Select an enemy entity for view-only inspection (stats bar, no actions). */
  _selectEnemyEntity(entity) {
    this._selectedEntity       = entity;
    this._isEnemySelection     = true;
    this._pendingUnitPick      = null;
    this._popupVisible         = false;
    this._awaitingTarget       = null;
    this._validActions         = [];
    hideActionPopup(this);

    this.renderer.selectedHex      = { col: entity.col, row: entity.row };
    this.renderer.selectedEntityId = entity.id;
    this.renderer.highlightHexes   = [];

    this.onEntitySelected?.(entity);
    if (this._planMode) this._refreshUndoButtons();
    // No _startUndoBtnTracking: enemy selection hides the button.
  }

  /** Return the latest projected position for an entity from the ghost overlay, or null. */
  _getProjectedPos(entityId) {
    const steps = this.renderer?.planGhostSteps;
    if (!steps || steps.length === 0) return null;
    return steps[steps.length - 1].positions.get(entityId) ?? null;
  }

  /**
   * Return the list of alive entities the local player can control in the
   * current context, in a stable order (by id). Mirrors the owner filter used
   * by _handleSelection so the cycle/plan-panel lists match what tapping the
   * canvas would select.
   */
  _getControllableUnits() {
    const state = this.state;
    if (!state) return [];
    const ownerFilter = this._planMode ? this._planFaction : state.activePlayer;
    const list = state.entities.filter(e => {
      if (!e.alive || e.owner !== ownerFilter) return false;
      if (this.myPlayerId && e.ownerId && e.ownerId !== this.myPlayerId) return false;
      return true;
    });
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return list;
  }

  /** Cycle the selected unit forward (+1) or backward (-1) through controllable units. */
  _cycleSelection(dir) {
    const list = this._getControllableUnits();
    if (list.length === 0) return;
    const currentId = this._selectedEntity?.id;
    let idx = list.findIndex(e => e.id === currentId);
    if (idx < 0) idx = 0;
    else idx = (idx + dir + list.length) % list.length;
    const next = list[idx];
    this._selectEntity(next);
    this._updateSidebar();
    this.onRedraw();
    this._centerOnEntity(next);
  }

  /**
   * Smoothly pan the camera to center on the given entity without changing
   * zoom. Used when the player picks a unit via the cycle arrows or the
   * plan panel — both of which are "jump to this unit" affordances.
   */
  _centerOnEntity(entity) {
    if (!entity || !this.renderer?.frameHexes) return;
    const proj = this._planMode ? this._getProjectedPos(entity.id) : null;
    const col = proj?.col ?? entity.col;
    const row = proj?.row ?? entity.row;
    this.renderer.frameHexes([{ col, row }], {
      paddingHexes: 5,
      maxZoom: this.renderer.zoomLevel,
      duration: 300,
    });
  }

  _clearSelection() {
    this._selectedEntity       = null;
    this._selectedTile         = null;
    this._isEnemySelection     = false;
    this._awaitingTarget       = null;
    this._validActions         = [];
    this._pendingUnitPick      = null;
    this._pendingDisambig      = null;
    this._pendingDefenderPick  = null;
    this._pendingEnemyPick     = null;
    this._popupVisible         = false;
    this.renderer.selectedHex      = null;
    this.renderer.selectedEntityId = null;
    this.renderer.highlightHexes   = [];
    hideActionPopup(this);
    this._hideTileDetail();
    // Refresh plan panel so selection highlight clears from the unit rows.
    if (this._planMode) {
      this._renderPlanPanel();
      this._refreshUndoButtons();
    }
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
        if (state.fogOfWar !== 'none' && this._selectedEntity) {
          const visHexes = getVisiblePositions(state, this._selectedEntity.owner);
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
        if (state.fogOfWar !== 'none' && this._selectedEntity) {
          const visHexes = getVisiblePositions(state, this._selectedEntity.owner);
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

      // Clicking any hex with a valid MOVE target is treated as a move, even
      // if the hex contains an allied unit. (The move-disambiguation popup is
      // intentionally skipped — see _pendingDisambig / _showDisambigPopup which
      // are kept around but no longer triggered from the move path.)
      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];

      // Add to plan queue (only reachable in planning mode)
      this._addToPlan({ type: PlanActionType.MOVE, entityId: actor.id, toCol: hex.col, toRow: hex.row });
      if (actor.alive) this._selectEntity(actor);
      else this._clearSelection();
      this._updateSidebar();
      this.onRedraw();

    } else if (actionType === ActionType.BATTLE) {
      const battleAction = this._validActions.find(a => a.type === ActionType.BATTLE);
      // All valid targets on the clicked hex
      const targetsAtHex = battleAction?.targets.filter(t => t.col === hex.col && t.row === hex.row) || [];
      if (!targetsAtHex.length) return;

      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];

      const executeFight = (target) => {
        // Add battle to plan, then re-select the actor so red
        // battle highlights refresh naturally — clicking the same enemy again stacks another attack.
        this._addToPlan({ type: PlanActionType.BATTLE_UNIT, entityId: actor.id, targetId: target.id, targetCol: target.col, targetRow: target.row });
        if (actor.alive) this._selectEntity(actor);
        else this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
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

      this._addToPlan({ type: PlanActionType.BATTLE_HEX, entityId: actor.id, targetCol: hex.col, targetRow: hex.row });
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

    // Cancel any pending close animation
    if (this._arcCloseTimer) { clearTimeout(this._arcCloseTimer); this._arcCloseTimer = null; }
    popup.classList.remove('arc-open', 'arc-closing', 'popup-list-mode');

    // Unit picker mode (friendly units, defender targets, or enemy info)
    // → use arc portrait disambiguation
    const pickerUnits = this._pendingUnitPick?.units
      || this._pendingDefenderPick?.defenders
      || this._pendingEnemyPick?.units;
    if (pickerUnits) {
      const actionTag = this._pendingDefenderPick ? 'pick_defender'
        : this._pendingEnemyPick ? 'pick_enemy'
        : 'pick_unit';
      // Determine origin hex for the arc popup:
      // - Unit picker (clicking a hex with multiple friendlies): use selectedHex
      //   which reflects the clicked hex (correct for ghost positions in plan mode).
      // - Defender/enemy picker: use the targets' position (they share a hex).
      //   In plan mode, use ghost position if available.
      let originHex;
      if (this._pendingUnitPick && this.renderer.selectedHex) {
        originHex = this.renderer.selectedHex;
      } else {
        const u = pickerUnits[0];
        const ghost = this._planMode ? this._getProjectedPos(u.id) : null;
        originHex = ghost || { col: u.col, row: u.row };
      }
      this._showArcDisambig(pickerUnits, actionTag, originHex);
      return;
    }

    const ownerCheck = this._planMode ? this._planFaction : state.activePlayer;
    if (!entity || entity.owner !== ownerCheck || state.gameOver) {
      hideActionPopup(this);
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
    const projInv = this._planMode ? computeProjectedInventory(state, interleavePlan(this._unitPlans)) : null;
    // In planning mode, always show actions (budget tracked separately)
    const hasAct  = this._planMode || state.actionsAvailable > 0;

    // Build a flat list of arc action descriptors, grouped by category
    // Groups: scout, defense, summon, combat, items
    const arcItems = [];

    for (const action of actions) {
      const dis = !hasAct;
      switch (action.type) {
        case ActionType.MOVE:
        case ActionType.BATTLE:
          break; // handled via hex clicks
        case ActionType.EXPLORE:
          arcItems.push({ group: 'scout', label: 'Explore', fullLabel: 'Explore tile',
            color: '#7eccd6', dis, cost: 1, attrs: 'data-action="explore"' });
          break;
        case ActionType.SOUND_HORN:
          arcItems.push({ group: 'scout', label: 'Sound Horn', fullLabel: 'Sound Horn (1 food)',
            color: '#7eccd6', dis: !action.affordable || dis, cost: 1, resCost: '1🍞', attrs: 'data-action="sound_horn"' });
          break;
        case ActionType.GUARD: {
          const charges = action.currentCharges || 0;
          const lbl = charges > 0 ? `Guard +${charges + 1}` : 'Guard';
          arcItems.push({ group: 'defense', label: lbl, fullLabel: lbl,
            color: '#8888cc', dis, cost: 1, attrs: 'data-action="guard"' });
          break;
        }
        case ActionType.FORTIFY: {
          const fortInv    = projInv ? projInv.hero : state.inventory.hero;
          const hasMetal   = (fortInv.metal || 0) > 0;
          const hasWood    = (fortInv.wood  || 0) > 0;
          const cantAfford = projInv ? (!hasMetal && !hasWood) : !action.affordable;
          const hasDoubler = entity.type === EntityType.SURVIVOR && entity.ability === SurvivorAbility.FORTIFY_DOUBLE;
          const tileData   = state.tiles.get(hexKey(entity.col, entity.row));
          const cur        = tileData ? tileData.fortifyLevel : 0;
          const metalGain   = Math.min(MAX_FORTIFY_LEVEL, cur + 2) - cur;
          const doublerGain = Math.min(MAX_FORTIFY_LEVEL, cur + 2) - cur;
          const woodGain    = Math.min(MAX_FORTIFY_LEVEL, cur + 1) - cur;
          const shortLbl = hasMetal ? 'Reinforce Hex' : 'Fortify Hex';
          const fortRes = hasMetal ? '1⚙' : '1🪵';
          const fullLbl = hasMetal
            ? `Reinforce +${metalGain} lvl (1 metal)`
            : hasDoubler
              ? `Fortify +${doublerGain} lvl (1 wood)`
              : `Fortify +${woodGain} lvl (1 wood)`;
          arcItems.push({ group: 'defense', label: shortLbl, fullLabel: fullLbl,
            color: '#e0a832', dis: cantAfford || dis, cost: 1, resCost: fortRes, attrs: 'data-action="fortify"' });
          break;
        }
        case ActionType.BATTLE_HEX:
          if (this._planMode) {
            arcItems.push({ group: 'combat', label: 'Attack Hex', fullLabel: 'Attack Hex',
              color: '#c0392b', dis, cost: 1, attrs: 'data-action="attack_hex"' });
          }
          break;
        case ActionType.SUMMON:
          // Handled below — we always show all 3 summon types
          break;
        case ActionType.HEAL: {
          let healDis = dis || action.atFullHp;
          if (projInv) {
            const healPool = entity.owner === 'witch' ? projInv.witch : projInv.hero;
            if ((healPool[ResourceType.HERBS] || 0) < 1) healDis = true;
          }
          arcItems.push({ group: 'items', label: 'Heal', fullLabel: action.atFullHp ? 'Already at full HP' : 'Herbs (heal 2 HP)',
            color: '#55cc55', dis: healDis, cost: 1, resCost: '1🌿',
            attrs: 'data-action="heal"' });
          break;
        }
        case ActionType.USE_ITEM:
          for (const item of action.usable) {
            if (this._planMode && item.item === ResourceType.FOOD) continue;
            let itemDis = dis;
            if (projInv) {
              if (!item.item.startsWith('weapon:')) {
                if ((projInv.hero[item.item] || 0) < 1) itemDis = true;
              }
            }
            // Strip leading emoji from item labels
            const cleanLabel = item.label.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '');
            arcItems.push({ group: 'items', label: cleanLabel, fullLabel: item.label,
              color: '#b0b0b0', dis: itemDis, free: true, cost: 0,
              attrs: `data-action="use_item" data-item="${item.item}"` });
          }
          break;
        case ActionType.EQUIP_WEAPON:
          for (const w of action.weapons) {
            arcItems.push({ group: 'items', label: w.label, fullLabel: `Equip ${w.label}`,
              color: '#b0b0b0', dis, free: true, cost: 0,
              attrs: `data-action="use_item" data-item="${w.key}"` });
          }
          break;
        case ActionType.USE_ABILITY: {
          const abilityLabels = {
            [SurvivorAbility.HEAL]:    'Tend Wounds',
            [SurvivorAbility.INSPIRE]: 'Battle Cry',
            [SurvivorAbility.RALLY]:   'Holy Sermon',
          };
          const fullLabels = abilityLabels;
          const isFree = action.ability !== SurvivorAbility.HEAL;
          arcItems.push({ group: 'items',
            label: abilityLabels[action.ability] || 'Ability',
            fullLabel: fullLabels[action.ability] || 'Use Ability',
            color: '#88eeff', dis: !isFree && dis, free: isFree, cost: isFree ? 0 : 1,
            attrs: 'data-action="use_ability"' });
          break;
        }
      }
    }

    // Always show all 3 summon types for any night-side leader (Witch /
    // Necromancer / Brute), greyed out if unaffordable.
    if (isLeaderType(entity.type) && entity.owner === 'witch' && actions.some(a => a.type === ActionType.SUMMON || a.type === ActionType.GUARD)) {
      const projWitch = projInv ? projInv.witch : state.inventory.witch;
      const projMetal = projWitch?.[ResourceType.METAL] || 0;
      const projWood  = projWitch?.[ResourceType.WOOD]  || 0;
      const projTotal = projWitch ? Object.values(projWitch).reduce((s, v) => s + (v || 0), 0) : 0;
      const ALL_SUMMONS = [
        { st: EntityType.IRON_GOLEM, label: 'Summon Iron Golem',  full: 'Summon Iron Golem (2 metal)',  afford: projMetal >= 2, res: '2⚙' },
        { st: EntityType.WOOD_GOLEM, label: 'Summon Wood Golem', full: 'Summon Wood Golem (2 wood)',   afford: projWood >= 2, res: '2🪵' },
        { st: EntityType.MINION,     label: 'Summon Minion',      full: 'Summon Minion (2 any resource)', afford: projTotal >= 2, res: '2 res' },
      ];
      for (const s of ALL_SUMMONS) {
        arcItems.push({ group: 'summon', label: s.label, fullLabel: s.full,
          color: '#9b59b6', dis: !s.afford || !hasAct, cost: 1, resCost: s.res,
          attrs: `data-action="summon" data-summon-type="${s.st}"` });
      }
    }

    if (arcItems.length === 0) {
      // Nothing to show — use list mode with a message
      popup.classList.add('popup-list-mode');
      popup.innerHTML = `<div class="popup-unit-name">No actions available</div>`;
      positionPopup(popup, this);
      popup.style.display = 'block';
      return;
    }

    // Compute arc layout — vertical stack with horizontal arc to avoid origin hex
    const screenPos = getEntityScreenPos(this, entity);
    if (!screenPos) return;

    const openRight = screenPos.x < window.innerWidth / 2;
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasScale = canvasRect.width / this.canvas.width;
    const hexScreenPx = this.renderer.hexSize * canvasScale * this.renderer.zoomLevel;

    const totalItems = arcItems.length;
    for (let i = 0; i < totalItems; i++) {
      arcItems[i]._idx = i;
    }

    // Generate arc item HTML — positions set after measurement
    let html = '';
    for (const item of arcItems) {
      const delay = item._idx * 30;
      const disAttr = item.dis ? 'disabled' : '';
      const freeCls = item.free ? ' arc-free' : '';
      const resTag = item.resCost ? `<span class="arc-res-cost">${item.resCost}</span>` : '';
      const costTag = item.free ? '<span class="arc-cost arc-cost-free">FREE</span>'
        : item.cost === 1 ? '<span class="arc-cost">◆</span>'
        : '';
      html += `<button class="arc-item${freeCls}" title="${item.fullLabel}"
        style="--arc-x:0px;--arc-y:0px;--arc-delay:${delay}ms;--arc-color:${item.color};--arc-hover:${item.color};--arc-glow:${item.color}33"
        ${disAttr} ${item.attrs}>${item.label}${resTag}${costTag}</button>`;
    }

    popup.innerHTML = html;

    // Store arc state for pan/zoom tracking and canvas line drawing
    this._arcEntityCol = effectiveEntity.col;
    this._arcEntityRow = effectiveEntity.row;
    this._arcItems = arcItems;
    this._arcOpenRight = openRight;

    // Position popup centered on entity
    positionArcPopup(popup, this);
    popup.style.display = 'block';

    // Measure buttons at full scale
    const btns = popup.querySelectorAll('.arc-item');
    for (const btn of btns) {
      btn.style.transition = 'none';
      btn.style.transform = 'translate(-50%, -50%) scale(1)';
      btn.style.opacity = '0';
    }
    popup.offsetHeight; // force layout

    // Compute positions: stack vertically with consistent gap, arc outward to clear hex
    computeArcPositions(popup, this, hexScreenPx);

    // Reset to pre-animation state then let CSS transition to final spot
    for (const btn of btns) {
      btn.style.transform = '';
      btn.style.opacity = '';
      btn.style.transition = '';
    }

    attachPopupListeners(popup, this);

    // Trigger open animation on next frame — positions are already set, just animate
    requestAnimationFrame(() => {
      popup.classList.add('arc-open');
      this.onRedraw();
    });

    // Start tracking pan/zoom — reposition popup each frame while visible
    startArcTracking(this);
  }

  /**
   * Show an arc-based disambiguation menu with portrait items for each unit.
   * @param {Array} units - entities to display as portrait arc items
   * @param {string} actionTag - data-action value (pick_unit, pick_defender, pick_enemy)
   * @param {{col:number, row:number}} originHex - hex to center the arc on
   * @param {Array} [extraItems] - optional non-portrait arc items (e.g. "Move" button)
   */
  _showArcDisambig(units, actionTag, originHex, extraItems) {
    const popup = this._el('action-popup');
    if (this._arcCloseTimer) { clearTimeout(this._arcCloseTimer); this._arcCloseTimer = null; }
    popup.classList.remove('arc-open', 'arc-closing', 'popup-list-mode');
    this._popupVisible = true;

    // Build arc items — extra items first, then portrait items for each unit
    const arcItems = [];

    if (extraItems) {
      for (const ei of extraItems) {
        arcItems.push({
          group: 'disambig',
          label: ei.label,
          fullLabel: ei.label,
          color: ei.color || '#888',
          dis: false,
          free: false,
          attrs: `data-action="${ei.action}"`,
          _portrait: false,
        });
      }
    }

    // Count queued attacks per target entity ID (for defender badges)
    const attacksPerTarget = new Map();
    if (actionTag === 'pick_defender') {
      for (const [, queue] of this._unitPlans) {
        for (const a of queue) {
          if (a.type === PlanActionType.BATTLE_UNIT && a.targetId) {
            attacksPerTarget.set(a.targetId, (attacksPerTarget.get(a.targetId) ?? 0) + 1);
          }
        }
      }
    }

    for (const u of units) {
      const col        = ENTITY_COLOR[u.type] || '#888';
      const portraitId  = u.type === 'survivor' ? Renderer.survivorAssetId(u.title) : u.type;
      const src         = portraitId ? this.renderer.getPortraitDataURL(portraitId) : null;
      const pct         = u.maxHp > 0 ? u.hp / u.maxHp : 0;
      const hpColor     = pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ff9800' : '#f44336';

      const imgHtml = src
        ? `<img class="arc-portrait-img" src="${src}">`
        : `<div class="arc-portrait-img" style="display:flex;align-items:center;justify-content:center;font-size:1.2rem;background:rgba(20,16,32,0.8);">${u.displayName.charAt(0)}</div>`;

      const atkCount = attacksPerTarget.get(u.id) ?? 0;
      const badgeHtml = atkCount > 0
        ? `<span class="arc-portrait-badge">\u00d7${atkCount}</span>`
        : '';

      arcItems.push({
        group: 'disambig',
        label: `<div class="arc-portrait-img-wrap">${imgHtml}${badgeHtml}</div><div class="arc-portrait-hp"><div class="arc-portrait-hp-fill" style="width:${(pct * 100).toFixed(0)}%;background:${hpColor};"></div></div><span class="arc-portrait-name">${u.displayName}</span>`,
        fullLabel: `${u.displayName} — HP ${u.hp}/${u.maxHp}`,
        color: col,
        dis: false,
        free: false,
        attrs: `data-action="${actionTag}" data-unit-id="${u.id}"`,
        _portrait: true,
      });
    }

    // Compute layout
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasScale = canvasRect.width / this.canvas.width;
    const hexScreenPx = this.renderer.hexSize * canvasScale * this.renderer.zoomLevel;

    const { x: hx } = this.renderer.hexToCanvasPos(originHex.col, originHex.row);
    const scale = canvasRect.width / this.canvas.width;
    const screenX = canvasRect.left + hx * scale;
    const openRight = screenX < window.innerWidth / 2;

    const totalItems = arcItems.length;
    for (let i = 0; i < totalItems; i++) {
      arcItems[i]._idx = i;
    }

    // Compute entity screen positions at originHex for canvas-origin animation.
    // All disambiguated entities are treated as a stack at originHex regardless
    // of their real positions (in plan mode, entities may have ghost positions here).
    const entityPositions = this.renderer.getEntityScreenPositions(
      originHex.col, originHex.row, units, canvasRect
    );
    const posById = new Map(entityPositions.map(p => [p.entityId, p]));

    // Hide entities from canvas that are physically at originHex.
    // Entities at ghost positions (moved earlier in the plan) stay visible
    // at their real positions — the animation origin is at originHex regardless.
    this.renderer.disambigHiddenIds = new Set(
      units.filter(u => u.col === originHex.col && u.row === originHex.row).map(u => u.id)
    );
    this.onRedraw();

    // Store arc state for pan/zoom tracking and canvas line drawing
    this._arcEntityCol = originHex.col;
    this._arcEntityRow = originHex.row;
    this._arcItems = arcItems;
    this._arcOpenRight = openRight;

    // Position popup centered on hex — need this first to compute relative offsets
    positionArcPopup(popup, this);
    const popupX = parseFloat(popup.style.left) || 0;
    const popupY = parseFloat(popup.style.top) || 0;

    // Compute start positions relative to popup anchor for each portrait item
    // and store origins for close animation
    this._disambigOrigins = [];
    for (const item of arcItems) {
      if (!item._portrait) continue;
      const unitId = parseInt(item.attrs.match(/data-unit-id="(\d+)"/)?.[1]);
      const pos = posById.get(unitId);
      if (pos) {
        item._startX = pos.screenX - popupX;
        item._startY = pos.screenY - popupY;
        item._startR = pos.screenR;
        this._disambigOrigins.push({
          entityId: unitId,
          startX: item._startX,
          startY: item._startY,
          startR: pos.screenR,
        });
      }
    }

    // Generate HTML — portrait items get arc-from-canvas class with start position vars
    let html = '';
    for (const item of arcItems) {
      const delay = item._idx * 30;
      const isCanvas = item._portrait && item._startX != null;
      const portraitCls = item._portrait ? ' arc-portrait' : '';
      const canvasCls = isCanvas ? ' arc-from-canvas' : '';
      // Portrait size: double the canvas entity circle diameter
      const portraitSize = isCanvas ? Math.round(Math.max(44, Math.min(88, item._startR * 4))) : 44;
      const startScale = isCanvas ? ((item._startR * 2) / portraitSize).toFixed(3) : '0.3';
      const startX = isCanvas ? item._startX.toFixed(1) : '0';
      const startY = isCanvas ? item._startY.toFixed(1) : '0';
      html += `<button class="arc-item${portraitCls}${canvasCls}" title="${item.fullLabel}"
        style="--arc-x:0px;--arc-y:0px;--arc-delay:${delay}ms;--arc-color:${item.color};--arc-hover:${item.color};--arc-glow:${item.color}33;--start-x:${startX}px;--start-y:${startY}px;--start-scale:${startScale};--portrait-size:${portraitSize}px"
        ${item.attrs}>${item.label}</button>`;
    }

    popup.innerHTML = html;
    popup.style.display = 'block';

    // Measure buttons at full scale
    const btns = popup.querySelectorAll('.arc-item');
    for (const btn of btns) {
      btn.style.transition = 'none';
      btn.style.transform = 'translate(-50%, -50%) scale(1)';
      btn.style.opacity = '0';
    }
    popup.offsetHeight; // force layout

    computeArcPositions(popup, this, hexScreenPx);

    // Reset to pre-animation state then let CSS transition to final spot
    for (const btn of btns) {
      btn.style.transform = '';
      btn.style.opacity = '';
      btn.style.transition = '';
    }

    attachPopupListeners(popup, this);

    requestAnimationFrame(() => {
      popup.classList.add('arc-open');
      this.onRedraw();
    });

    startArcTracking(this);
  }

  _showDisambigPopup() {
    const { actor, hex, allies } = this._pendingDisambig;
    this._showArcDisambig(allies, 'pick_unit', hex, [
      { label: `Move ${actor.displayName} \u279C`, action: 'disambig_move', color: ENTITY_COLOR[actor.type] || '#888' },
    ]);
  }

  /** Re-evaluate affordability of arc items after a stackable action (summon/fortify). */
  _refreshArcAffordability() {
    const popup = this._el('action-popup');
    if (!popup || !popup.classList.contains('arc-open')) return;
    const projInv = this._planMode ? computeProjectedInventory(this.state, interleavePlan(this._unitPlans)) : null;
    if (!projInv) return;
    popup.querySelectorAll('.arc-item[data-action="summon"]').forEach(btn => {
      const st = btn.dataset.summonType;
      const projWitch = projInv.witch;
      const projMetal = projWitch[ResourceType.METAL] || 0;
      const projWood  = projWitch[ResourceType.WOOD]  || 0;
      const projTotal = Object.values(projWitch).reduce((s, v) => s + (v || 0), 0);
      const affordable = st === EntityType.IRON_GOLEM ? projMetal >= 2
        : st === EntityType.WOOD_GOLEM ? projWood >= 2
        : projTotal >= 2;
      btn.disabled = !affordable;
    });
    popup.querySelectorAll('.arc-item[data-action="fortify"]').forEach(btn => {
      const shared = projInv.hero;
      const hasMetal = (shared.metal || 0) > 0;
      const hasWood  = (shared.wood  || 0) > 0;
      btn.disabled = !hasMetal && !hasWood;
    });
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
    const tileSelection = this._selectedTile;

    // Tile-only selection (no entity)
    if (!entity && tileSelection) {
      const tile = this.state.tiles.get(hexKey(tileSelection.col, tileSelection.row));
      if (!tile) { bar.style.display = 'none'; return; }
      const terrainBadge = _buildTerrainBadge(tile);
      const TERRAIN_ICON = {
        [TileType.GRASS]: '🌿', [TileType.FOREST]: '🌲', [TileType.DIRT]: '🪨',
        [TileType.ROAD]: '🛤', [TileType.RIVER]: '💧', [TileType.BRIDGE]: '🌉',
      };
      const icon = tile.building ? (BUILDING_ICON[tile.building] ?? '🏠') : (TERRAIN_ICON[tile.type] ?? '🌿');
      const label = tile.building ? (BUILDING_LABEL[tile.building] ?? 'Building') : (tile.type ?? 'terrain');
      const tileSrc = this.renderer.getTileDataURL(tile, tileSelection.col, tileSelection.row, 56);
      const tileImgHtml = tileSrc
        ? `<img class="usb-terrain-hex" src="${tileSrc}" alt="">`
        : `<span class="usb-icon" style="background:#3a4a3a;font-size:1.1rem">${icon}</span>`;
      bar.style.display = 'flex';
      bar.innerHTML = `
        ${tileImgHtml}
        <span class="usb-tile-info">
          <span class="usb-tile-name">${label}</span>
          <span class="usb-tile-details">${terrainBadge}</span>
        </span>
        <button class="usb-deselect-btn" title="Deselect">✕</button>
      `;
      bar.querySelector('.usb-deselect-btn').addEventListener('click', () => {
        this._clearSelection();
        this._updateSidebar();
        this.onRedraw();
      });
      return;
    }

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

    // Portrait image with glyph fallback
    const assetId = _entityPortraitId(entity);
    const src = assetId ? this.renderer.getPortraitDataURL(assetId, 84) : null;
    const portraitHtml = src
      ? `<img class="usb-portrait" src="${src}" style="border-color:${color};" alt="">`
      : `<span class="usb-icon" style="background:${color}">${glyph}</span>`;

    // Cycle arrows — only when viewing a controllable friendly unit and there
    // are multiple controllable units to cycle between.
    const ownerFilter = this._planMode ? this._planFaction : this.state.activePlayer;
    const isMine = entity.owner === ownerFilter &&
      (!this.myPlayerId || !entity.ownerId || entity.ownerId === this.myPlayerId);
    const showCycle = isMine && !this._isEnemySelection
      && this._getControllableUnits().length > 1;
    const cyclePrevHtml = showCycle
      ? `<button class="usb-cycle-btn usb-cycle-prev" title="Previous unit">\u2039</button>`
      : '';
    const cycleNextHtml = showCycle
      ? `<button class="usb-cycle-btn usb-cycle-next" title="Next unit">\u203A</button>`
      : '';

    // Terrain row for the entity's current hex
    const entCol = this._planMode ? (this._getProjectedPos(entity.id)?.col ?? entity.col) : entity.col;
    const entRow = this._planMode ? (this._getProjectedPos(entity.id)?.row ?? entity.row) : entity.row;
    const tile = this.state.tiles.get(hexKey(entCol, entRow));
    let terrainRowHtml = '';
    if (tile) {
      const tileSrc = this.renderer.getTileDataURL(tile, entCol, entRow, 56);
      const tileImgHtml = tileSrc ? `<img class="usb-terrain-hex" src="${tileSrc}" alt="">` : '';
      terrainRowHtml = `<span class="usb-terrain-row">${tileImgHtml}${_buildTerrainBadge(tile)}</span>`;
    }

    bar.style.display = 'flex';
    bar.innerHTML = `
      ${cyclePrevHtml}
      ${portraitHtml}
      ${cycleNextHtml}
      <span class="usb-info">
        <span class="usb-name" style="color:${color}">${entity.displayName}</span>
        <span class="usb-details">
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
        </span>
        ${terrainRowHtml}
      </span>
      <button class="usb-deselect-btn" title="Deselect unit">✕</button>
    `;
    bar.querySelector('.usb-deselect-btn').addEventListener('click', () => {
      this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
    });
    bar.querySelector('.usb-cycle-prev')?.addEventListener('click', () => this._cycleSelection(-1));
    bar.querySelector('.usb-cycle-next')?.addEventListener('click', () => this._cycleSelection(+1));
  }

  _renderTurnInfo() {
    const state = this.state;
    const el    = this._el('turn-info');
    if (!el) return;

    // Derive cycle steps from custom cycleConfig or use the default 8-step cycle
    const PHASE_META = {
      dawn:  { sprite: 'cycle_dawn',  label: 'Dawn',  desc: 'Hero +1 action · node scoring · attrition rises' },
      day:   { sprite: 'cycle_day',   label: 'Day',   desc: 'Witch undead in the open suffer' },
      dusk:  { sprite: 'cycle_dusk',  label: 'Dusk',  desc: 'Node scoring · seek cover before night' },
      night: { sprite: 'cycle_night', label: 'Night', desc: 'Witch +2 ATK · Survivors in the open suffer' },
    };
    const cyclePhases = state.cycleConfig?.phases ?? DEFAULT_CYCLE_PHASES;
    const CYCLE_STEPS = cyclePhases.map(p => ({ phase: p, ...PHASE_META[p] }));

    const cycleLen     = CYCLE_STEPS.length;
    const roundInCycle = (state.round - 1) % cycleLen;
    const cycle        = Math.ceil(state.round / cycleLen);
    const roundLabel   = state.cycleConfig && !state.cycleConfig.loop
      ? `Round ${state.round} of ${cyclePhases.length}`
      : `Day ${cycle} · Round ${roundInCycle + 1}`;

    // Render always-visible cycle bar (compact icon row)
    const cycleBar = this._el('cycle-bar');
    if (cycleBar) {
      cycleBar.innerHTML = CYCLE_STEPS.map((step, i) => {
        const active = i === roundInCycle;
        const imgSrc = this.renderer.getPortraitDataURL(step.sprite, 64);
        const iconHtml = imgSrc
          ? `<img class="cycle-icon" src="${imgSrc}" alt="${step.label}">`
          : step.label.charAt(0);
        return `<div class="cycle-step phase-${step.phase} ${active ? 'cycle-active' : 'cycle-dim'}"
                     title="${step.desc}">${iconHtml}${active ? `<span class="cycle-name">${step.label}</span>` : ''}</div>`;
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
      const used    = interleavePlan(this._unitPlans).filter(a => a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM).length;
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
          <span class="actions-label">Actions</span>
          <div class="actions-remaining" title="Tap for breakdown">${diamonds}</div>
        `;
        const pipsEl = el.querySelector('.actions-remaining');
        if (pipsEl) pipsEl.addEventListener('click', () => this._showBudgetBreakdown());
      }
      return;
    }

    // During resolution, show neutral resolution label
    if (state.resolving) {
      el.innerHTML = `<span class="turn-line">Resolving Actions…</span>`;
      return;
    }

    // Online mode: if we reach here without plan mode or resolving, the client
    // may be in a transient state (summary, animation) or genuinely stuck.
    // Only attempt recovery if we're supposed to be in PLANNING mode.
    if (this.mp) {
      if (this.appMode === 'PLANNING' && !this._stateRecoveryPending) {
        this._stateRecoveryPending = true;
        // Delay before requesting state — gives enterPlanningMode time to fire
        this._stateRecoveryTimer = setTimeout(() => {
          this._stateRecoveryPending = false;
          if (this._planMode || this.state.resolving || this.appMode !== 'PLANNING') return;
          console.warn('[ui] Invalid online state — requesting state refresh.');
          this.mp._send({ type: 'requestState' });
          // If still stuck after another 5 seconds, bail to menu
          this._stateRecoveryTimer = setTimeout(() => {
            if (!this._planMode && !this.state.resolving && this.appMode === 'PLANNING') {
              console.error('[ui] State recovery failed — returning to menu');
              if (this.onQuitToMenu) this.onQuitToMenu();
            }
          }, 5000);
        }, 2000);
      }
      // Show appropriate label based on current app mode
      if (this.appMode === 'SUMMARY') {
        el.innerHTML = `<span class="turn-line">Round Summary</span>`;
      } else {
        el.innerHTML = `<span class="turn-line" style="color:var(--muted)">Syncing…</span>`;
      }
      return;
    }

    // Offline / local mode: show legacy sequential-turn display
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
      <span class="actions-label">Actions</span>
      <div class="actions-remaining">${diamonds}</div>
    `;
  }

  _renderObjectives() {
    const bar = this._el('score-bar');
    if (bar && this.state.disableScoring) {
      bar.style.display = 'none';
      return;
    }
    const el = this._el('score-bar-content');
    if (!el) return;
    const state = this.state;

    const { html, title } = buildObjectivesHtml(
      state.witchObjectives, state.entities, state.nodeScore, state.gameMode,
    );

    el.innerHTML = html;
    if (bar) { bar.style.display = ''; bar.title = title; }
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
    const returnBtn = this._el('plan-return-btn');
    if (!btn) return;
    const state = this.state;

    if (!this._planMode) {
      // Outside planning mode, hide both buttons entirely and clear classes
      btn.disabled = true;
      btn.style.display = 'none';
      btn.classList.remove('planning-active', 'urgent', 'plan-open', 'countdown-urgent');
      if (returnBtn) returnBtn.style.display = 'none';
      return;
    }

    // Hide when plan panel is expanded (not collapsed)
    const panel = this._el('plan-panel');
    const panelOpen = panel && panel.style.display !== 'none'
                   && !panel.classList.contains('collapsed');

    if (this._planSubmitted) {
      // After submission: hide submit, show return-to-menu
      btn.style.display = 'none';
      if (returnBtn) {
        returnBtn.style.display = panelOpen ? 'none' : '';
      }
    } else {
      // During planning: show submit, hide return-to-menu
      btn.style.display = '';
      btn.disabled = state.gameOver;
      btn.classList.toggle('urgent', !state.gameOver);
      btn.classList.add('planning-active');
      btn.title = 'Submit Plan';
      if (!this._countdownTimer && !this._graceActive) {
        btn.textContent = '✓ Submit';
      }
      btn.classList.toggle('plan-open', !!panelOpen);
      if (returnBtn) returnBtn.style.display = 'none';
    }
  }

  _handleActionButton(button) {
    const action = button.dataset.action;
    const state  = this.state;
    const entity = this._selectedEntity;

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
      this._pendingDisambig = null;
      const unit = state.entities.find(e => e.id === button.dataset.unitId);
      if (unit) this._selectEntity(unit);
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    if (action === 'undo_pick') {
      const pick = this._pendingUndoPick;
      this._pendingUndoPick = null;
      hideActionPopup(this);
      if (!pick) return;
      const rawId = button.dataset.unitId;
      // Entity IDs in _unitPlans may be numbers or strings; dataset values are strings.
      const entityId = pick.entityIds.find(id => String(id) === String(rawId)) ?? rawId;
      this._undoLastActionFor(entityId);
      return;
    }

    if (action === 'undo_cancel') {
      this._pendingUndoPick = null;
      hideActionPopup(this);
      return;
    }

    if (action === 'pick_defender') {
      const pick = this._pendingDefenderPick;
      this._pendingDefenderPick = null;
      if (!pick) return;
      const def = pick.defenders.find(e => e.id === button.dataset.unitId);
      if (def) pick.onPick(def);
      return;
    }

    if (action === 'pick_enemy') {
      this._pendingEnemyPick = null;
      const unit = state.entities.find(e => e.id === button.dataset.unitId);
      if (unit) this._selectEnemyEntity(unit);
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    if (action === 'disambig_move') {
      const disambig = this._pendingDisambig;
      this._pendingDisambig = null;
      hideActionPopup(this);
      if (!disambig) return;
      const { actor, hex } = disambig;
      this._awaitingTarget = null;
      this.renderer.highlightHexes = [];

      this._addToPlan({ type: PlanActionType.MOVE, entityId: actor.id, toCol: hex.col, toRow: hex.row });
      if (actor.alive) this._selectEntity(actor);
      else this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    if (!entity || !this._planMode) return;
    if (entity.owner !== this._planFaction) return;

    // Stackable actions: keep the arc menu open, just pulse the button
    const STACKABLE = new Set(['guard', 'summon', 'fortify']);
    const isStackable = STACKABLE.has(action);

    // Pulse the clicked arc item
    const isArcItem = button.classList.contains('arc-item');
    if (isArcItem) {
      button.classList.remove('arc-pulse');
      void button.offsetWidth; // force reflow to restart animation
      button.classList.add('arc-pulse');
    }

    if (!isStackable) {
      this._popupVisible = false;
    }

    // Helper: delayed hide — let the pulse animation finish (200ms) before closing
    const delayedHide = () => {
      if (isArcItem) {
        setTimeout(() => hideActionPopup(this), 220);
      } else {
        hideActionPopup(this);
      }
    };

    switch (action) {
      case 'explore': {
        this._addToPlan({ type: PlanActionType.EXPLORE, entityId: entity.id });
        delayedHide();
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar(); this.onRedraw(); break;
      }

      case 'battle':
        // Attack is triggered via red hex clicks — this case is no longer used.
        break;

      case 'fortify': {
        this._addToPlan({ type: PlanActionType.FORTIFY, entityId: entity.id });
        if (!isStackable) delayedHide();
        else this._refreshArcAffordability();
        this._updateSidebar(); this.onRedraw(); break;
      }

      case 'guard': {
        this._addToPlan({ type: PlanActionType.GUARD, entityId: entity.id });
        if (!isStackable) delayedHide();
        this._updateSidebar(); this.onRedraw(); break;
      }

      case 'sound_horn': {
        this._addToPlan({ type: PlanActionType.SOUND_HORN, entityId: entity.id });
        delayedHide();
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar(); this.onRedraw(); break;
      }

      case 'summon': {
        const summonType = button.dataset.summonType ?? null;
        this._addToPlan({ type: PlanActionType.SUMMON, entityId: entity.id, summonType: summonType ?? undefined });
        if (!isStackable) delayedHide();
        else this._refreshArcAffordability();
        this._updateSidebar();
        this.onRedraw();
        break;
      }

      case 'attack_hex': {
        delayedHide();
        const bhAction = this._validActions.find(a => a.type === ActionType.BATTLE_HEX);
        const hexTargets = bhAction?.targets ?? [];
        this._awaitingTarget = { actionType: ActionType.BATTLE_HEX, actor: entity, hexTargets };
        this.renderer.highlightHexes = hexTargets.map(t => ({ col: t.col, row: t.row, color: 'rgba(220,120,40,0.50)' }));
        state.addLog('Click a hex to attack it (skips if empty).');
        this._updateSidebar();
        this.onRedraw();
        break;
      }

      case 'heal': {
        this._addToPlan({ type: PlanActionType.HEAL, entityId: entity.id });
        delayedHide();
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar(); this.onRedraw(); break;
      }

      case 'use_item': {
        this._addToPlan({ type: PlanActionType.USE_ITEM, entityId: entity.id, item: button.dataset.item });
        delayedHide();
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar(); this.onRedraw(); break;
      }

      case 'use_ability': {
        this._addToPlan({ type: PlanActionType.USE_ABILITY, entityId: entity.id });
        delayedHide();
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar(); this.onRedraw(); break;
      }
    }
  }

  // ── Hazard flash animations ───────────────────────────────────────────────

  async _triggerPostRoundEffects() {
    const state = this.state;
    const events = state.postRoundEvents || [];
    const positionedEvents = events.filter(ev => ev.col != null && ev.type !== 'safe');
    if (!positionedEvents.length) return;

    // Deduplicate: in online mode each server action re-sends the same state
    // until the next turn, so we must not re-fire on every update.
    const key = `${state.round}|${events.map(e => e.text).join('~')}`;
    if (key === this._lastPostRoundKey) return;
    this._lastPostRoundKey = key;

    // Frame camera on all affected units before animating
    if (!this.autoplay && this.renderer) {
      const positions = positionedEvents.map(ev => ({ col: ev.col, row: ev.row }));
      this.renderer.frameHexes(positions, { paddingHexes: 2.5, maxZoom: 2.0, duration: 400 });
      await new Promise(r => setTimeout(r, 420));
    }

    const flashEvents = positionedEvents.filter(ev => ev.flash);
    for (const ev of flashEvents) {
      const f = ev.flash;
      this.renderer.addFlash(
        ev.col, ev.row, f.label,
        f.color, f.duration ?? 2200, f.fontScale ?? 1.4, f.textColor,
      );
    }

    // Drive animation loop and wait for flashes to finish (skip in autoplay)
    if (!this.autoplay && flashEvents.length) {
      this.onRedraw();
      await this.renderer.waitForAnimations();
    }
  }

  // ── Speed popup ───────────────────────────────────────────────────────────

  static SPEED_LABELS = { cinematic: 'Cinematic', fast: 'Fast', vfast: 'Very Fast' };

  _loadDefaultSpeed() {
    try {
      const saved = localStorage.getItem('brimstone-default-speed');
      if (saved && UIController.SPEED_LABELS[saved]) return saved;
    } catch (_) { /* localStorage unavailable */ }
    return 'cinematic';
  }

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

  _toggleMapOptionsPopup() {
    const popup = this._el('map-options-popup');
    if (!popup) return;
    const isOpen = popup.style.display !== 'none';
    popup.style.display = isOpen ? 'none' : 'flex';
  }

  _closeMapOptionsPopup() {
    const popup = this._el('map-options-popup');
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

  /** Show a plan-related toast (food warning, plan full). */
  _showPlanToast(text) {
    let toast = document.getElementById('plan-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'plan-toast';
      toast.className = 'plan-toast';
      const wrapper = this._el('canvas-wrapper');
      if (wrapper) wrapper.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.remove('plan-toast-out');
    clearTimeout(this._planToastTimer);
    this._planToastTimer = setTimeout(() => {
      toast.classList.add('plan-toast-out');
    }, 3000);
  }

  /** Show a brief toast when another player nudges us. */
  _showNudgeToast(fromName) {
    let toast = document.getElementById('nudge-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'nudge-toast';
      toast.className = 'nudge-toast';
      const wrapper = this._el('canvas-wrapper');
      if (wrapper) wrapper.appendChild(toast);
    }
    toast.textContent = `${fromName} nudged you!`;
    toast.classList.remove('nudge-toast-out');
    clearTimeout(this._nudgeToastTimer);
    this._nudgeToastTimer = setTimeout(() => {
      toast.classList.add('nudge-toast-out');
    }, 3000);
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
    const splashNote = result.splashHits?.length
      ? ` +💢${result.splashHits.length} splashed`
      : '';
    toast.textContent =
      `${actorSnap.name} → ${targetSnap.name}  [${result.attackRoll}v${result.defenseRoll}]  ${outcome}${splashNote}`;
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
      ? 'Exposed survivors suffer 1 damage each night.'
      : `Exposed survivors now suffer ${level} damage each night.`;
    this._showResultDialog([
      `🌑 The curse deepens — Caleb's Hollow's mystical energy grows stronger!`,
      ``,
      desc,
      `🌙 Night: survivors in the open take ${level} damage`,
    ], () => {});
  }

  // ── Budget breakdown popup ───────────────────────────────────────────────

  /** Show a small popup with the action budget breakdown (triggered by tapping action pips). */
  _dismissBudgetBreakdown() {
    const el = this._el('budget-breakdown');
    if (el) el.classList.remove('visible');
    if (this._budgetDismiss) {
      document.removeEventListener('click', this._budgetDismiss, true);
      this._budgetDismiss = null;
    }
  }

  _showBudgetBreakdown() {
    const el = this._el('budget-breakdown');
    if (!el || !this._planMode) return;

    // Toggle off
    if (el.classList.contains('visible')) {
      this._dismissBudgetBreakdown();
      return;
    }

    // Reparent into the actions-remaining div so absolute positioning anchors correctly
    const pipsEl = document.querySelector('.actions-remaining');
    if (pipsEl && el.parentElement !== pipsEl) pipsEl.appendChild(el);

    const faction = this._planFaction;
    const phase = this.state.phase;
    const phaseIcon = PHASE_ICON[phase] ?? '';
    const phaseLabel = phase ? phase.charAt(0).toUpperCase() + phase.slice(1) : '';
    const actions = this._planBudget ?? 0;
    const entities = this.state.entities;
    const inventory = this.state.inventory;
    const stash = faction === 'hero' ? inventory?.hero : inventory?.witch;
    const foodCount = stash?.food ?? 0;

    const rows = [];
    if (faction === 'hero') {
      const timeBonus     = (phase === 'day' || phase === 'dawn') ? 1 : 0;
      const survivorCount = entities.filter(e => e.alive && e.owner === 'hero' && e.type !== 'hero').length;
      const survivorBonus = Math.min(survivorCount, 5);
      rows.push({ label: 'Base', value: 3 });
      if (timeBonus)     rows.push({ label: `${phaseIcon} ${phaseLabel} bonus`, value: timeBonus });
      if (survivorBonus) rows.push({ label: `☺ Survivor${survivorBonus !== 1 ? 's' : ''} (${survivorCount})`, value: survivorBonus });
    } else {
      const timeBonus = phase === 'night' ? 1 : 0;
      const unitCount = entities.filter(e => e.alive && e.owner === 'witch' && e.type !== 'witch').length;
      const unitBonus = Math.min(unitCount, 3);
      rows.push({ label: 'Base', value: 3 });
      if (timeBonus) rows.push({ label: `${phaseIcon} ${phaseLabel} bonus`, value: timeBonus });
      if (unitBonus) rows.push({ label: `☠ Minion${unitBonus !== 1 ? 's' : ''} (${unitCount})`, value: unitBonus });
    }
    const nodeBonus = countHeldNodes(faction, this.state.witchObjectives ?? [], entities);
    if (nodeBonus) {
      rows.push({ label: `◆ Power Node${nodeBonus !== 1 ? 's' : ''} (${nodeBonus})`, value: nodeBonus });
    }

    let html = '<div class="action-breakdown-table">';
    for (const r of rows) {
      html += `<div class="abkd-row"><span class="abkd-label">${r.label}</span><span class="abkd-val">+${r.value}</span></div>`;
    }
    html += `<hr class="abkd-divider">`;
    html += `<div class="abkd-row abkd-total"><span class="abkd-label">Total</span><span class="abkd-val">${actions}</span></div>`;
    if (foodCount > 0) {
      html += `<div class="abkd-row abkd-food"><span class="abkd-label">🍞 Food ×${foodCount}</span><span class="abkd-val">(extra actions)</span></div>`;
    }
    html += '</div>';
    el.innerHTML = html;
    el.classList.add('visible');

    // Dismiss on click outside (but not on the pips themselves — that's handled by toggle above)
    this._budgetDismiss = (e) => {
      // Ignore clicks on the pips trigger — the toggle handles those
      if (pipsEl?.contains(e.target)) return;
      this._dismissBudgetBreakdown();
    };
    // Use setTimeout so the current click event finishes before the listener activates
    setTimeout(() => {
      if (el.classList.contains('visible')) {
        document.addEventListener('click', this._budgetDismiss, true);
      }
    }, 0);
  }

  /** Toggle visibility of the mission info header button. */
  showMissionInfoBtn(visible) {
    const btn = this._el('mission-info-btn');
    if (btn) btn.style.display = visible ? '' : 'none';
  }

  /**
   * Show a narrative story modal (campaign triggers).
   * Returns a Promise that resolves when the player dismisses it.
   */
  showStoryModal(title, text) {
    return new Promise(resolve => {
      const el = this._el('story-modal');
      if (!el) { resolve(); return; }
      el.querySelector('.story-modal-title').textContent = title;
      el.querySelector('.story-modal-text').textContent = text;
      el.classList.add('visible');
      const btn = this._el('story-modal-continue');
      const handler = () => {
        btn.removeEventListener('click', handler);
        el.classList.remove('visible');
        resolve();
      };
      btn.addEventListener('click', handler);
    });
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

  /**
   * Show a unit card popup for a newly-encountered survivor or zombie.
   * @param {'explore'|'horn'|'power_node'} [discoveryMethod='explore'] How the survivor was found.
   */
  _showEncounterDialog(encounterUnit, onDismiss, discoveryMethod = 'explore') {
    const dialog = this._el('encounter-dialog');
    const card   = this._el('encounter-card');

    const GLYPHS = { hero: '⚔', witch: '✦', survivor: '☺', zombie: '†', minion: '☠', wood_golem: '🪵', iron_golem: '⚙' };
    const glyph  = GLYPHS[encounterUnit.type] ?? '?';
    const color  = encounterUnit.color || '#d4c9b0';

    const assetId = encounterUnit.type === 'survivor'
      ? Renderer.survivorAssetId(encounterUnit.title)
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

    let message;
    if (encounterUnit.type === 'survivor') {
      const prefix = discoveryMethod === 'horn'
        ? 'Drawn by the horn\'s call, '
        : discoveryMethod === 'power_node'
          ? 'Drawn to the power node, '
          : '';
      message = prefix
        ? `${prefix}${encounterUnit.name} steps from the shadows and joins the party!`
        : `${encounterUnit.name} steps from the shadows and joins the party!`;
    } else {
      message = `A cowering survivor is found… raised as a zombie by the witch!`;
    }

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

    dialog.addEventListener('click', dismiss);
    document.addEventListener('keydown', keyDismiss);
    if (this.autoplay) {
      setTimeout(dismiss, 700);
    } else if (this.speedMode === 'fast') {
      setTimeout(dismiss, 4000);
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
      const assetId = encounterSurvivor?.title ? Renderer.survivorAssetId(encounterSurvivor.title) : null;
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

    dialog.addEventListener('click', dismiss);
    document.addEventListener('keydown', keyDismiss);
    if (this.autoplay) {
      setTimeout(dismiss, 500);
    } else if (this.speedMode === 'fast') {
      setTimeout(dismiss, 4000);
    }
  }

  _showDefenderPickerDialog(defenders, onPick) {
    this._pendingDefenderPick = { defenders, onPick };
    this._popupVisible = true;
    this._showActionPopup(null);
  }

  _showBattleDialog(actorSnap, targetSnap, result, onDismiss, onRematch = null) {
    // Cancel any in-flight dice animation or auto-dismiss from a previous battle dialog
    if (this._battleInterval)  { clearInterval(this._battleInterval);  this._battleInterval  = null; }
    if (this._autoDismissTimer) { clearTimeout(this._autoDismissTimer); this._autoDismissTimer = null; }
    if (this._battleAnim)       { this._battleAnim.clear(); this._battleAnim = null; }

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

    const outcome = this._el('battle-outcome');
    outcome.textContent = '';
    outcome.className   = 'battle-outcome';
    // Remove stale splash damage line from previous battle
    const oldSplash = dialog.querySelector('.battle-splash');
    if (oldSplash) oldSplash.remove();
    footer.innerHTML    = (this.autoplay || this.speedMode !== 'cinematic')
      ? ''
      : '<div class="result-dismiss">— click to skip —</div>' +
        '<button class="battle-enable-fast" type="button">⏩ Click to enable fast mode and skip battle dialogs</button>';

    // Reset breakdown columns (rendered muted upfront; glow as anim progresses)
    const atkBkd = this._el('battle-atk-breakdown');
    const defBkd = this._el('battle-def-breakdown');
    for (const col of [atkBkd, defBkd]) {
      if (!col) continue;
      col.innerHTML = '';
      col.classList.add('visible');
      col.classList.remove('bkd-col-winner', 'bkd-col-loser', 'bkd-col-tie');
    }

    dialog.style.display = 'flex';
    const card = dialog.querySelector('.battle-card');

    // Guards a stale dismiss closure from mutating a later dialog's state if
    // leaked listeners fire after this dialog is gone.
    let _dismissed = false;
    // Pause state only freezes the auto-dismiss timer; the animation sequence
    // always runs to completion.
    let _dismissPaused = false;
    let _dismissTimerId = null;
    let _dismissStartedAt = 0;
    let _dismissRemaining = 0;
    const _clearDismissTimer = () => {
      if (_dismissTimerId !== null) { clearTimeout(_dismissTimerId); _dismissTimerId = null; }
    };
    const dismiss = () => {
      if (_dismissed) return;
      _dismissed = true;
      _clearDismissTimer();
      if (this._autoDismissTimer) { clearTimeout(this._autoDismissTimer); this._autoDismissTimer = null; }
      if (this._battleInterval)   { clearInterval(this._battleInterval);  this._battleInterval   = null; }
      if (this._battleAnim)       { this._battleAnim.clear(); this._battleAnim = null; }
      dialog.style.display = 'none';
      dialog.removeEventListener('click', dismiss);
      card?.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', keyDismiss);
      if (onDismiss) onDismiss();
    };
    const keyDismiss = e => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') dismiss();
    };

    // Apply speed factor via CSS custom property so all keyframe durations
    // scale together. cinematic=1, fast=0.5, vfast=0.25.
    const factor = _speedFactor(this.speedMode);
    card?.style.setProperty('--bkd-speed', String(factor));

    // Per-dialog timer bag with pause/resume support.
    const anim = _makeAnimBag();
    this._battleAnim = anim;

    // Instant render of both breakdown columns (no animation). Used for
    // autoplay/skip.
    const renderInstant = () => {
      const bd = result.breakdown;
      if (bd) {
        const atkD = _breakdownData(actorSnap,  bd, 'atk', result.attackRoll);
        const defD = _breakdownData(targetSnap, bd, 'def', result.defenseRoll);
        const padTo = Math.max(atkD.rows.length, defD.rows.length);
        this._el('battle-atk-breakdown').innerHTML =
          _buildBreakdownHTML(actorSnap, bd, 'atk', result.attackRoll, padTo);
        this._el('battle-def-breakdown').innerHTML =
          _buildBreakdownHTML(targetSnap, bd, 'def', result.defenseRoll, padTo);
        this._el('battle-atk-breakdown').classList.add('visible');
        this._el('battle-def-breakdown').classList.add('visible');
        _applyWinnerClass(
          this._el('battle-atk-breakdown'),
          this._el('battle-def-breakdown'),
          result.attackRoll,
          result.defenseRoll,
        );
      }
    };

    // Render the final outcome line + HP bars + splash + rematch.
    const revealOutcome = () => {
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
      outcome.classList.add('battle-outcome-pulse');

      // Splash damage line(s) below main outcome
      if (result.splashHits?.length) {
        const splashEl = document.createElement('div');
        splashEl.className = 'battle-splash';
        const lines = result.splashHits.map(h =>
          h.killed ? `💢 ${h.name} is slain by splash!` : `💢 ${h.name} takes −1 splash damage`
        );
        splashEl.textContent = lines.join('  ·  ');
        outcome.insertAdjacentElement('afterend', splashEl);
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
          if (_dismissed) return;
          _dismissed = true;
          if (this._autoDismissTimer) { clearTimeout(this._autoDismissTimer); this._autoDismissTimer = null; }
          dialog.style.display = 'none';
          dialog.removeEventListener('click', dismiss);
          card?.removeEventListener('click', dismiss);
          document.removeEventListener('keydown', keyDismiss);
          onRematch();
        });
        footer.insertBefore(rematchBtn, footer.firstChild);
      }
    };

    // Hide pause/redo during autoplay — there's nothing to pause or replay.
    const pauseBtnInit = this._el('battle-pause-btn');
    const redoBtnInit  = this._el('battle-redo-btn');
    if (pauseBtnInit) pauseBtnInit.style.display = this.autoplay ? 'none' : '';
    if (redoBtnInit)  redoBtnInit.style.display  = this.autoplay ? 'none' : '';

    if (this.autoplay) {
      // Skip animation entirely.
      renderInstant();
      revealOutcome();
      setTimeout(dismiss, 500);
      return;
    }

    const atkBkdEl = this._el('battle-atk-breakdown');
    const defBkdEl = this._el('battle-def-breakdown');
    atkBkdEl.classList.add('visible');
    defBkdEl.classList.add('visible');

    let _clickDismissWired = false;
    const unwireClickDismiss = () => {
      if (!_clickDismissWired) return;
      _clickDismissWired = false;
      dialog.removeEventListener('click', dismiss);
      card?.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', keyDismiss);
    };

    // Capture initial footer HTML so Redo can restore it (revealOutcome
    // mutates footer with rematch button + action pips).
    const initialFooterHtml = footer.innerHTML;
    const rewireFooter = () => {
      footer.innerHTML = initialFooterHtml;
      const fastBtn = footer.querySelector('.battle-enable-fast');
      if (fastBtn) {
        fastBtn.addEventListener('click', e => {
          e.stopPropagation();
          this._setSpeed('fast');
          dismiss();
        });
      }
    };

    const scheduleDismiss = (ms) => {
      _clearDismissTimer();
      if (_dismissed) return;
      _dismissRemaining = ms;
      _dismissStartedAt = Date.now();
      if (!_dismissPaused) {
        _dismissTimerId = setTimeout(() => { _dismissTimerId = null; dismiss(); }, ms);
      }
    };
    const pauseDismiss = () => {
      if (_dismissPaused) return;
      _dismissPaused = true;
      if (_dismissTimerId !== null) {
        clearTimeout(_dismissTimerId);
        _dismissTimerId = null;
        _dismissRemaining = Math.max(0, _dismissRemaining - (Date.now() - _dismissStartedAt));
      }
    };
    const resumeDismiss = () => {
      if (!_dismissPaused) return;
      _dismissPaused = false;
      if (_dismissRemaining > 0 && !_dismissed) {
        _dismissStartedAt = Date.now();
        _dismissTimerId = setTimeout(() => { _dismissTimerId = null; dismiss(); }, _dismissRemaining);
      }
    };

    // playAnimation runs the staged reveal. Called at start and on Redo.
    const playAnimation = () => {
      anim.reset();
      unwireClickDismiss();
      _clearDismissTimer();
      if (this._autoDismissTimer) { clearTimeout(this._autoDismissTimer); this._autoDismissTimer = null; }
      atkBkdEl.innerHTML = '';
      defBkdEl.innerHTML = '';
      outcome.textContent = '';
      outcome.className   = 'battle-outcome';
      rewireFooter();
      const stale = dialog.querySelector('.battle-splash');
      if (stale) stale.remove();
      // Restore HP fills in case redo fires after HP mutation.
      dialog.querySelectorAll('.combatant-hp-fill').forEach(fill => {
        const panel = fill.closest('.combatant-panel');
        const isAtk = panel?.id === 'battle-attacker';
        const snap = isAtk ? actorSnap : targetSnap;
        const pct = Math.max(0, (snap.hp / snap.maxHp) * 100);
        fill.style.width = `${pct}%`;
      });

      const bd = result.breakdown;
      let padTo = 0;
      if (bd) {
        const atkD = _breakdownData(actorSnap,  bd, 'atk', result.attackRoll);
        const defD = _breakdownData(targetSnap, bd, 'def', result.defenseRoll);
        padTo = Math.max(atkD.rows.length, defD.rows.length);
      }
      const sidePromises = bd
        ? [
            _animateBreakdownSide(atkBkdEl, actorSnap,  bd, 'atk', result.attackRoll,  factor, anim, padTo),
            _animateBreakdownSide(defBkdEl, targetSnap, bd, 'def', result.defenseRoll, factor, anim, padTo),
          ]
        : [Promise.resolve(), Promise.resolve()];

      Promise.all(sidePromises).then(() => {
        if (_dismissed || anim.cancelled) return;
        if (bd) {
          _applyWinnerClass(atkBkdEl, defBkdEl, result.attackRoll, result.defenseRoll);
        }
        const delay = Math.max(80, _BKD_TIMINGS.outcomeDelay * factor);
        anim.timeout(delay, () => {
          if (_dismissed) return;
          revealOutcome();
          // Wire click/key dismiss and schedule auto-dismiss (pausable).
          dialog.addEventListener('click', dismiss);
          card?.addEventListener('click', dismiss);
          document.addEventListener('keydown', keyDismiss);
          _clickDismissWired = true;
          const hasEnabledRematch = onRematch && this.state.actionsAvailable > 0;
          const baseMs = hasEnabledRematch ? 5000 : 3000;
          const autoMs = this.speedMode === 'vfast' ? 1200
                       : this.speedMode === 'fast'  ? 2000
                       : baseMs;
          scheduleDismiss(autoMs);
        });
      });
    };

    // Wire pause/redo buttons.
    const pauseBtn = this._el('battle-pause-btn');
    const redoBtn  = this._el('battle-redo-btn');
    const setPauseLabel = () => {
      if (!pauseBtn) return;
      pauseBtn.textContent = _dismissPaused ? '▶' : '⏸';
      pauseBtn.title = _dismissPaused ? 'Resume' : 'Pause';
      pauseBtn.setAttribute('aria-label', _dismissPaused ? 'Resume' : 'Pause');
    };
    setPauseLabel();
    const onPauseClick = e => {
      e.stopPropagation();
      if (_dismissPaused) resumeDismiss(); else pauseDismiss();
      setPauseLabel();
    };
    const onRedoClick = e => {
      e.stopPropagation();
      if (_dismissPaused) { resumeDismiss(); setPauseLabel(); }
      playAnimation();
    };
    pauseBtn?.addEventListener('click', onPauseClick);
    redoBtn?.addEventListener('click', onRedoClick);
    anim.onClear = () => {
      pauseBtn?.removeEventListener('click', onPauseClick);
      redoBtn?.removeEventListener('click', onRedoClick);
    };

    playAnimation();
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
      const { attack: fAtk, defense: fDef } = getFortifyCombatBonus(tile.fortifyLevel);
      const bonusStr = fAtk > 0 ? `+${fAtk} ATT, +${fDef} DEF` : `+${fDef} DEF`;
      const fl = tile.fortifyLevel >= 5 ? `⚙⚙⚙ Bastion (lvl ${tile.fortifyLevel}: ${bonusStr})`
               : tile.fortifyLevel >= 3 ? `⚙⚙ Heavily Reinforced (lvl ${tile.fortifyLevel}: ${bonusStr})`
               : tile.fortifyLevel >= 2 ? `⚙ Metal Reinforced (lvl ${tile.fortifyLevel}: ${bonusStr})`
               : `🪵 Fortified (lvl ${tile.fortifyLevel}: ${bonusStr})`;
      linesHtml += `<div class="tile-zoom-info-line fortified">${fl}</div>`;
    }
    if (!tile.explored) linesHtml += `<div class="tile-zoom-info-line">— unexplored —</div>`;
    if (!linesHtml) linesHtml = `<div class="tile-zoom-info-line" style="color:#554">(no special properties)</div>`;

    if (linesEl) linesEl.innerHTML = linesHtml;

    // ── Units ──
    const visible  = _visibleUnitsAt(state, hex.col, hex.row);
    const planOwner = this._planMode ? this._planFaction : state.activePlayer;
    const isAllyUnit = (u) =>
      u.owner === planOwner &&
      this.myPlayerId && u.ownerId && u.ownerId !== this.myPlayerId;
    const myUnits   = visible.filter(u =>
      u.owner === planOwner && !isAllyUnit(u));
    const allyUnits = visible.filter(u => isAllyUnit(u));
    const foeUnits  = visible.filter(u => u.owner !== planOwner);
    const unitsEl   = this._el('tile-zoom-units');

    if (unitsEl) {
      let html = '';
      if (visible.length) html += `<div class="tile-units-heading">Units</div>`;
      for (const u of myUnits) {
        html += _unitCardHTML(u, { renderer: this.renderer, selectable: true });
      }
      for (const u of allyUnits) {
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
            if (isAllyUnit(unit)) this._selectEnemyEntity(unit);
            else                  this._selectEntity(unit);
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
    // Hide standalone button when full sidebar is open (button lives in sidebar header instead)
    const standaloneBtn = this._el('chronicle-toggle');
    if (standaloneBtn) standaloneBtn.style.display = mode === 'full' ? 'none' : '';
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
    el.innerHTML = visible.map(m => `<div class="log-entry ${this._logEntryModifier(m)}"${this._logEntryStyle(m)}>${this._logText(m)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  _renderInventory() {
    const el = this._el('plan-inventory');
    if (!el) return;

    const state   = this.state;
    const faction = this._planFaction ?? (state.activePlayer === 'hero' ? 'hero' : 'witch');
    const isHero  = faction === 'hero';
    const inv     = state.inventory;
    const stash   = isHero ? inv.hero : inv.witch;
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

  /** Return CSS modifier class(es) for a log entry (round separator + faction fallback). */
  _logEntryModifier(entry) {
    if (typeof entry === 'string') {
      return /^Round \d+/.test(entry) ? 'log-round-separator' : '';
    }
    // If entry carries an explicit color, we use inline style — no class needed
    if (entry.color) return '';
    if (entry.owner === 'hero') return 'log-hero';
    if (entry.owner === 'witch') return 'log-witch';
    return '';
  }

  /** Return an inline style attribute for entries with an explicit player color. */
  _logEntryStyle(entry) {
    if (typeof entry === 'object' && entry.color) return ` style="color:${entry.color}"`;
    return '';
  }

  /** Filter log entries to only those the current player can see. */
  _visibleLog() {
    const log = this.state?.log ?? [];
    if (this.state?.fogOfWar === 'none') return log;
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
      `<div class="log-entry ${this._logEntryModifier(m)}"${this._logEntryStyle(m)}>${this._logText(m)}</div>`
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
      el.innerHTML  = last5.map(m => `<div class="mini-log-entry ${this._logEntryModifier(m)}"${this._logEntryStyle(m)}>${this._logText(m)}</div>`).join('');
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

      const { prevScore, prevNodes, humanFaction, fogOfWar, gameOver, winner, winReason, hasFullReplay, isCampaign } = opts;

      // Collect kills, survivors found, summons, and resource flows from steps.
      // Fog-of-war filtering: skip opponent-only events the player can't see.
      const kills      = [];
      const survivors  = [];
      const summons    = [];
      const blockedMoves = []; // movement interrupted by enemy
      const equipFinds = []; // dedicated lines for horse/weapon discoveries
      const foundRes   = {}; // icon → count  (from explore loot)
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
          if (fogOfWar !== 'none' && humanFaction && ev._faction !== humanFaction) {
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
          if (ev.result?.encounterSurvivors?.length) {
            survivors.push(...ev.result.encounterSurvivors);
          } else if (ev.result?.encounterSurvivor) {
            survivors.push(ev.result.encounterSurvivor);
          }
          if (ev.action?.type === 'summon' && ev.result?.success) {
            const logLine = ev.result?.log?.[0] ?? '';
            summons.push(logLine || 'Unit summoned');
          }
          // Movement blocked by enemy — partial move (ACTION_OK with blockedBy)
          if (ev.type === ResEventType.ACTION_OK &&
              ev.action?.type === PlanActionType.MOVE &&
              ev.result?.blockedBy) {
            const actor = this.state.entities.find(e => e.id === ev.action.entityId);
            const actorName = actor?.displayName ?? 'Unit';
            const blockerName = ev.result.blockedBy.displayName ?? 'enemy';
            blockedMoves.push({ actorName, blockerName });
          }
          // Movement blocked by fortifications — partial move (ACTION_OK with blockedByFort)
          if (ev.type === ResEventType.ACTION_OK &&
              ev.action?.type === PlanActionType.MOVE &&
              ev.result?.blockedByFort) {
            const actor = this.state.entities.find(e => e.id === ev.action.entityId);
            const actorName = actor?.displayName ?? 'Unit';
            blockedMoves.push({ actorName, blockerName: 'fortifications' });
          }
          // Movement blocked by enemy — full block (ACTION_FAIL with blockedBy)
          if (ev.type === ResEventType.ACTION_FAIL &&
              ev.action?.type === PlanActionType.MOVE &&
              ev.blockedBy) {
            const actor = this.state.entities.find(e => e.id === ev.action.entityId);
            const actorName = actor?.displayName ?? 'Unit';
            const blockerName = ev.blockedBy.displayName ?? 'enemy';
            blockedMoves.push({ actorName, blockerName });
          }
          // Movement blocked by fortifications — full block (ACTION_FAIL with blockedByFort)
          if (ev.type === ResEventType.ACTION_FAIL &&
              ev.action?.type === PlanActionType.MOVE &&
              ev.blockedByFort) {
            const actor = this.state.entities.find(e => e.id === ev.action.entityId);
            const actorName = actor?.displayName ?? 'Unit';
            blockedMoves.push({ actorName, blockerName: 'fortifications' });
          }

          // ── Resource tracking (player's faction only) ─────────────────
          if (ev.result?.success && (!humanFaction || ev._faction === humanFaction)) {
            // Resources found: collect lootItems from explore results
            if (ev.action?.type === 'explore') {
              for (const item of ev.result.lootItems ?? []) {
                if (!item.startsWith('+')) continue;
                const icon = item.slice(1);
                if (icon === '🐴' || icon === '⚔') {
                  // Extract the descriptive log line for this equipment find
                  const keyword = icon === '🐴' ? 'horse' : 'Found a ';
                  const logLine = (ev.result.log ?? []).find(l => l.toLowerCase().includes(keyword));
                  equipFinds.push({ icon, log: logLine || (icon === '🐴' ? 'Found a horse!' : 'Found a weapon!') });
                } else {
                  _addRes(foundRes, icon);
                }
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

      // Include survivors spawned at power nodes during endRound
      for (const s of (this.state.nodeSpawnedSurvivors ?? [])) {
        survivors.push(s);
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
          // Show the upcoming phase + round instead of "Round N complete"
          const nextRound = (roundNum ?? 0) + 1;
          const nextPhase = phaseForRound(nextRound, this.state?.cycleConfig);
          const icon = PHASE_ICON[nextPhase] ?? '';
          titleEl.textContent = `${icon} ${nextPhase.charAt(0).toUpperCase() + nextPhase.slice(1)} — Round ${nextRound}`;
        }
      }
      if (eventsEl) {
        let html = '';

        // Phase effects line for the upcoming turn (non-game-over only)
        if (!gameOver) {
          const PHASE_EFFECTS = {
            dawn:  'Hero gains +1 action · Power Nodes scored',
            day:   'Build & fortify · Witch undead in the open suffer',
            dusk:  'Power Nodes scored · Night approaches',
            night: 'Witch +2 ATK · Survivors in the open suffer',
          };
          const nextPhase = phaseForRound((roundNum ?? 0) + 1, this.state?.cycleConfig);
          const fx = PHASE_EFFECTS[nextPhase];
          if (fx) html += `<div class="summary-phase-effects">${fx}</div>`;
        }

        // Game-over: insert win reason at the TOP so it's immediately visible
        if (gameOver && winReason) {
          const cls = winner === humanFaction ? 'hero-text' : 'witch-text';
          html += `<div class="summary-game-over ${cls}">${winReason}</div>`;
        }

        // Combat summary — aggregate damage between each pair of combatants
        const battleLines = compileTurnBattleSummary(
          steps ?? [], this.state.entities, ResEventType, PlanActionType,
        );
        for (const line of battleLines) {
          html += `<div class="summary-combat">${line}</div>`;
        }

        for (const bm of blockedMoves) {
          html += `<div class="summary-blocked">\u26CC ${bm.actorName} movement blocked by ${bm.blockerName}</div>`;
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

        for (const eq of equipFinds) {
          html += `<div class="summary-equip">${eq.icon === '🐴' ? '🐴' : '⚔'} ${eq.log}</div>`;
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

        // Post-round effects (night attrition, etc.)
        const postEvents = this.state.postRoundEvents || [];
        const myId = this.myPlayerId;
        const visiblePostEvents = postEvents.filter(ev =>
          ev.type !== 'safe' && (!myId || !ev.ownerId || ev.ownerId === myId)
        );
        if (visiblePostEvents.length) {
          html += `<div class="summary-hazard-header">🌙 Night Attrition</div>`;
          for (const ev of visiblePostEvents) {
            if (ev.type === 'kill') {
              html += `<div class="summary-hazard">💀 ${ev.entityName} −${ev.amount} HP (unsheltered at night) — killed</div>`;
            } else if (ev.type === 'damage') {
              html += `<div class="summary-hazard">🌙 ${ev.entityName} −${ev.amount} HP (unsheltered at night)</div>`;
            } else if (ev.type === 'shelter') {
              const isBuilding = ev.text.startsWith('🏠');
              const desc = isBuilding ? 'sheltered in building' : 'sheltered by fortifications';
              html += `<div class="summary-shelter">${isBuilding ? '🏠' : '🏰'} ${ev.entityName} ${desc}</div>`;
            }
          }
        }

        // Reckoning section at dawn/dusk (skip when scoring is disabled, e.g. campaign missions)
        const state = this.state;
        if (!state.disableScoring && prevScore && (state.phase === 'dawn' || state.phase === 'dusk')) {
          const heroDelta  = state.nodeScore.hero  - prevScore.hero;
          const witchDelta = state.nodeScore.witch - prevScore.witch;
          const witchCount = state.witchObjectives.filter(obj =>
            nodeController(obj, state.entities) === 'witch').length;
          const heroCount = state.witchObjectives.filter(obj =>
            nodeController(obj, state.entities) === 'hero').length;

          const phaseLabel = state.phase === 'dawn' ? '🌅 Dawn Reckoning' : '🌇 Dusk Reckoning';

          let reckoningLine;
          const totalNodes = state.witchObjectives.length;
          if (witchCount === totalNodes || heroCount === totalNodes) {
            const who = witchCount === totalNodes ? 'Witch' : 'Hero';
            reckoningLine = `${who} holds all Power Nodes!`;
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



        // AI takeover messages (from consecutive timeout)
        const takeoverMsgs = this.state._takeoverMessages || [];
        for (const msg of takeoverMsgs) {
          html += `<div class="summary-takeover">🤖 ${msg}</div>`;
        }
        // Clear after showing
        if (this.state._takeoverMessages) this.state._takeoverMessages = [];

        eventsEl.innerHTML = html || `<div class="summary-neutral">No notable events this round.</div>`;
      }

      // Render replay-speed dropdown (compact single-button toggle + popup)
      const speedRowEl = this._el('round-summary-speed-row');
      if (speedRowEl) {
        const SPEED_ICONS = { cinematic: '🎬', fast: '⏩', vfast: '⏭' };
        const SPEED_DESCS = { cinematic: 'Dialog for important battles', fast: 'Cinematic pace, no popups', vfast: '1.5× speed, no popups' };
        const modes = Object.entries(UIController.SPEED_LABELS);

        speedRowEl.innerHTML =
          `<button class="summary-speed-toggle" title="Battle speed">⚡ ${UIController.SPEED_LABELS[this.speedMode]}</button>` +
          `<div class="summary-speed-popup" style="display:none">` +
          modes.map(([mode, label]) =>
            `<button class="speed-option${this.speedMode === mode ? ' active' : ''}" data-mode="${mode}">` +
            `<span class="speed-option-icon">${SPEED_ICONS[mode]}</span>` +
            `<span class="speed-option-label">${label}</span>` +
            `<span class="speed-option-desc">${SPEED_DESCS[mode]}</span>` +
            `</button>`
          ).join('') +
          `</div>`;

        const toggleBtn = speedRowEl.querySelector('.summary-speed-toggle');
        const popup = speedRowEl.querySelector('.summary-speed-popup');

        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = popup.style.display !== 'none';
          popup.style.display = open ? 'none' : 'flex';
          if (!open) {
            popup.querySelectorAll('.speed-option').forEach(b =>
              b.classList.toggle('active', b.dataset.mode === this.speedMode)
            );
          }
        });
        popup.addEventListener('click', (e) => {
          const btn = e.target.closest('.speed-option');
          if (!btn) return;
          e.stopPropagation();
          this._setSpeed(btn.dataset.mode);
          toggleBtn.textContent = `⚡ ${UIController.SPEED_LABELS[this.speedMode]}`;
          popup.querySelectorAll('.speed-option').forEach(b =>
            b.classList.toggle('active', b.dataset.mode === this.speedMode)
          );
          popup.style.display = 'none';
        });
        // Close popup when clicking outside
        const closePopup = () => { popup.style.display = 'none'; };
        document.addEventListener('click', closePopup);
        // Store cleanup ref so we can remove it when dialog closes
        speedRowEl._closePopup = closePopup;
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
          `<button class="plan-btn primary" data-action="restart">Return to Menu</button>` +
          (hasFullReplay && !isCampaign ? `<button class="plan-btn secondary" data-action="replay-full">Replay Full Game</button>` : '');
        actionsEl.appendChild(gameOverBtns);
      } else if (nextBtn) {
        nextBtn.style.display = '';
        nextBtn.textContent   = 'Plan Turn →';
      }

      el.classList.add('visible');

      const cleanup = () => {
        el.classList.remove('visible');
        nextBtn?.removeEventListener('click', onNext);
        replayBtn?.removeEventListener('click', onReplay);
        if (gameOverBtns) gameOverBtns.remove();
        if (nextBtn) nextBtn.style.display = '';
        if (speedRowEl?._closePopup) {
          document.removeEventListener('click', speedRowEl._closePopup);
          speedRowEl._closePopup = null;
        }
      };
      const onNext   = () => { cleanup(); resolve('next'); };
      const onReplay = () => { cleanup(); resolve('replay'); };

      nextBtn?.addEventListener('click', onNext);
      replayBtn?.addEventListener('click', onReplay);
      if (gameOverBtns) {
        gameOverBtns.querySelector('[data-action="restart"]')?.addEventListener('click', () => { cleanup(); resolve('restart'); });
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
    const ids = ['back', 'play', 'pause', 'ff', 'vff', 'end', 'stop'];
    for (const action of ids) {
      const btn = document.getElementById(`replay-${action}-btn`);
      if (btn) btn.onclick = () => onControl?.(action);
    }

    this.setReplayPlayState('play');
  }

  /**
   * Highlight the currently active replay control button.
   * @param {string} activeAction — 'play'|'pause'|'ff'|'vff'|'back'|'end'|'stop'
   */
  setReplayPlayState(activeAction) {
    const ids = ['back', 'play', 'pause', 'ff', 'vff', 'end', 'stop'];
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
   * Show a minimal "SKIP only" HUD during any inline replay animation
   * (initial resolution, "Replay last turn", summary-dialog replay, etc.).
   * Reuses the full-game replay HUD shell but hides every button except
   * the "jump to end" one, which is relabelled "SKIP".
   * @param {Function} onSkip — called when the skip button is pressed
   */
  showInlineReplayHUD(onSkip) {
    const hud = this._el('replay-hud');
    if (!hud) return;
    hud.style.display = 'flex';
    hud.classList.add('replay-hud-skip-only');
    for (const action of ['back', 'play', 'pause', 'ff', 'vff', 'stop']) {
      const btn = document.getElementById(`replay-${action}-btn`);
      if (btn) btn.style.display = 'none';
    }
    const endBtn = document.getElementById('replay-end-btn');
    if (endBtn) {
      endBtn.style.display = '';
      // Remember the original glyph so hideInlineReplayHUD can restore it.
      if (this._replayEndBtnOriginalText === undefined) {
        this._replayEndBtnOriginalText = endBtn.textContent;
      }
      endBtn.textContent = 'SKIP';
      endBtn.title = 'Skip replay';
      endBtn.onclick = () => onSkip?.();
    }
    this._inlineReplayActive = true;
  }

  /** Hide the inline skip-only replay HUD and restore button visibility. */
  hideInlineReplayHUD() {
    const hud = this._el('replay-hud');
    if (hud) {
      hud.style.display = 'none';
      hud.classList.remove('replay-hud-skip-only');
    }
    for (const action of ['back', 'play', 'pause', 'ff', 'vff', 'end', 'stop']) {
      const btn = document.getElementById(`replay-${action}-btn`);
      if (btn) btn.style.display = '';
    }
    const endBtn = document.getElementById('replay-end-btn');
    if (endBtn) {
      // Restore the original glyph (defaults to ⇥ if we never saw one)
      endBtn.textContent = this._replayEndBtnOriginalText ?? '\u21E5';
      endBtn.title = 'Jump to end';
      endBtn.onclick = null;
    }
    this._replayEndBtnOriginalText = undefined;
    this._inlineReplayActive = false;
  }

  /**
   * Show a confirmation dialog during replay when stop is pressed.
   * @returns {Promise<'exit'|'cancel'>}
   */
  showReplayExitDialog() {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'replay-exit-overlay';
      overlay.innerHTML =
        `<div class="replay-exit-card">` +
        `<div class="replay-exit-text">You can replay saved games at any time from the main menu.</div>` +
        `<div class="replay-exit-btns">` +
        `<button class="plan-btn primary" data-action="exit">Exit to Menu</button>` +
        `<button class="plan-btn secondary" data-action="cancel">Cancel</button>` +
        `</div></div>`;
      document.body.appendChild(overlay);

      overlay.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        overlay.remove();
        resolve(btn.dataset.action);
      });
    });
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

  /** True when (col,row) is fully black under full fog-of-war. */
  _isFullyFogged(col, row) {
    const state = this.state;
    if (state.fogOfWar !== 'full') return false;

    const myFaction    = state.myFaction;
    const humanIsHero  = myFaction ? myFaction === 'hero'  : (state.witchIsAI && !state.heroIsAI);
    const humanIsWitch = myFaction ? myFaction === 'witch' : (state.heroIsAI  && !state.witchIsAI);
    const observerOwner = humanIsHero ? 'hero' : (humanIsWitch ? 'witch' : null);
    if (!observerOwner) return false;

    const k = hexKey(col, row);

    // In sight range?
    const sightSet = this.renderer._buildFogVisibleHexes(observerOwner);
    if (sightSet.has(k)) return false;

    // In movement-reachable set?
    const lastStep = this.renderer.planGhostSteps?.at(-1);
    const projectedPositions = lastStep?.positions ?? null;
    const moveSet = buildFogMovementHexes(state, observerOwner, projectedPositions);
    if (moveSet.has(k)) return false;

    // Previously explored?
    const explored = state.exploredHexes?.[observerOwner];
    if (explored?.has(k)) return false;

    return true;
  }

  refresh() {
    this._updateSidebar();
    this.onRedraw();
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

/** Build HTML for a terrain badge (used in unit stats bar). */
function _buildTerrainBadge(tile) {
  const parts = [];
  const label = tile.building ? (BUILDING_LABEL[tile.building] ?? 'Building') : (tile.type ?? '');
  parts.push(label);
  if (tile.explored) {
    parts.push('<span class="usb-terrain-explored">Explored</span>');
  }
  if (tile.fortifyLevel) {
    parts.push(`<span class="usb-terrain-fort">⚙ Fort lvl ${tile.fortifyLevel}</span>`);
  }
  if (tile.powerNode) {
    parts.push(`<span class="usb-terrain-node">⬡ Power Node</span>`);
  }
  return parts.join(' · ');
}

/**
 * Format a countdown in seconds into a friendly string.
 * >= 1 day:  "2d 4h"
 * >= 1 hour: "3h 12m"
 * >= 1 min:  "05:23"
 * < 1 min:   "0:42"
 */
function _formatCountdown(totalSecs) {
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (d >= 1)  return `${d}d ${h}h`;
  if (h >= 1)  return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function btn(label, cls, disabled = '', extra = '') {
  return `<button class="action-btn ${cls}" ${disabled} ${extra}>${label}</button>`;
}


function _visibleUnitsAt(state, col, row) {
  if (state.fogOfWar === 'none') return state.entities.filter(e => e.alive && e.col === col && e.row === row);
  const myFaction = state.myFaction
    ?? (state.witchIsAI && !state.heroIsAI ? 'hero' : state.heroIsAI && !state.witchIsAI ? 'witch' : null);
  const revealed = myFaction ? getVisiblePositions(state, myFaction) : null;
  return state.entities.filter(e => {
    if (!e.alive || e.col !== col || e.row !== row) return false;
    if (revealed && e.owner !== myFaction) return revealed.has(hexKey(col, row));
    return true;
  });
}

// ── Tilemap sprite helpers ────────────────────────────────────────────────────

/** Return the tilemap asset id for any entity snap (uses title for survivors). */
function _entityPortraitId(snap) {
  if (snap.type === 'survivor') return Renderer.survivorAssetId(snap.title);
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

// Compute the per-side breakdown data for the battle dialog.
// Used by both the animated renderer and the instant (autoplay) fallback.
// Each row carries an explicit sign flag: 'base' (neutral), 'pos', or 'neg'.
function _breakdownData(snap, bd, side, total) {
  const pool = side === 'atk'
    ? (bd.atkPool ?? [bd.atkBaseDie])
    : (bd.defPool ?? [bd.defBaseDie]);
  const picked = side === 'atk' ? bd.atkBaseDie : bd.defBaseDie;
  const advantage = side === 'atk'
    ? (bd.atkAdvantageDice ?? 0)
    : (bd.defAdvantageDice ?? 0);

  const rows = [];
  const add = (label, val, sign) => rows.push({ label, val, sign });
  if (side === 'atk') {
    add(`${snap.name} ATK`, snap.attack, 'base');
    if (snap.attackBonus)    add('🪙 Silver',          snap.attackBonus,    'pos');
    if (bd.phaseBonus)       add('🌙 Night',           bd.phaseBonus,       'pos');
    if (bd.atkStaffBonus)    add('⚕ Staff (undead)',   bd.atkStaffBonus,    'pos');
    if (bd.atkFortAtkBonus)  add('🏰 Fort ATT',        bd.atkFortAtkBonus,  'pos');
    const atkAllyNames = bd.atkAllyNames ?? [];
    const atkAllyContrib = Math.min(atkAllyNames.length, bd.atkGangupFlat || 0);
    if (atkAllyContrib > 0) {
      for (let i = 0; i < atkAllyContrib; i++) add(`👥 ${atkAllyNames[i]}`, 1, 'pos');
    } else if (bd.atkGangupFlat) {
      add('👥 Gang-up flat', bd.atkGangupFlat, 'pos');
    }
  } else {
    add(`${snap.name} DEF`, snap.defense, 'base');
    if (snap.defenseBonus)  add('🛡 Bonus DEF',   snap.defenseBonus,  'pos');
    if (bd.fortBonus)       add('🏰 Fort DEF',    bd.fortBonus,       'pos');
    if (bd.fatiguePenalty)  add('😓 Fatigue',     -bd.fatiguePenalty, 'neg');
    const defAllyNames = bd.defAllyNames ?? [];
    const defAllyContrib = Math.min(defAllyNames.length, bd.defGangupFlat || 0);
    if (defAllyContrib > 0) {
      for (let i = 0; i < defAllyContrib; i++) add(`👥 ${defAllyNames[i]}`, 1, 'pos');
    } else if (bd.defGangupFlat) {
      add('👥 Allies flat', bd.defGangupFlat, 'pos');
    }
  }
  return { pool, picked, advantage, rows, total };
}

function _poolSign(advantage) {
  if (advantage > 0) return 'pos';
  if (advantage < 0) return 'neg';
  return 'base';
}

function _poolLabel(advantage) {
  if (advantage > 0) return `Advantage ${advantage}`;
  if (advantage < 0) return `Disadvantage ${-advantage}`;
  return 'Roll';
}

// Signed sign -> data-sign attribute ('pos'|'neg'|'base' → 'positive'|'negative'|'').
function _signAttr(sign) {
  if (sign === 'pos') return ' data-sign="positive"';
  if (sign === 'neg') return ' data-sign="negative"';
  return '';
}

// Instant (no animation) render — used for autoplay/skip.
function _buildBreakdownHTML(snap, bd, side, total, padTo = 0) {
  const d = _breakdownData(snap, bd, side, total);
  const n = d.pool?.length ?? 0;
  const parts = [];
  if (n > 0) {
    // Pool row: discards together, picked die in the value column.
    let usedPick = false;
    const discards = [];
    let pickedHTML = '';
    for (const v of d.pool) {
      const isPick = !usedPick && v === d.picked;
      if (isPick) {
        usedPick = true;
        pickedHTML = `<span class="bkd-die bkd-die-picked">${v}</span>`;
      } else {
        discards.push(`<span class="bkd-die bkd-die-discard">${v}</span>`);
      }
    }
    const poolSign = _poolSign(d.advantage);
    parts.push(
      `<div class="bkd-row bkd-pool-row"${_signAttr(poolSign)}>` +
        `<span class="bkd-label">${_poolLabel(d.advantage)}</span>` +
        `<span class="bkd-pool-discards">${discards.join('')}</span>` +
        `<span class="bkd-pool-picked-slot">${pickedHTML}</span>` +
      `</div>`
    );
  }
  for (const r of d.rows) {
    const v = r.val >= 0 ? '+' + r.val : r.val;
    parts.push(
      `<div class="bkd-row"${_signAttr(r.sign)}><span class="bkd-label">${r.label}</span><span class="bkd-val">${v}</span></div>`
    );
  }
  const spacerCount = Math.max(0, padTo - d.rows.length);
  for (let i = 0; i < spacerCount; i++) {
    parts.push(`<div class="bkd-row bkd-row-spacer" aria-hidden="true"><span class="bkd-label">&nbsp;</span><span class="bkd-val">&nbsp;</span></div>`);
  }
  parts.push(`<hr class="bkd-divider">`);
  parts.push(`<div class="bkd-row bkd-total-row"><span class="bkd-label">Total</span><span class="bkd-val">${total}</span></div>`);
  return parts.join('');
}

// Tint the whole breakdown column once both totals have landed: winner →
// subtle green wash, loser → subtle red wash, tie → neutral. The Total row
// keeps its bold/large size; the side tint carries the winner signal.
function _applyWinnerClass(atkCol, defCol, atkTotal, defTotal) {
  if (!atkCol || !defCol) return;
  for (const col of [atkCol, defCol]) {
    col.classList.remove('bkd-col-winner', 'bkd-col-loser', 'bkd-col-tie');
  }
  if (atkTotal > defTotal) {
    atkCol.classList.add('bkd-col-winner');
    defCol.classList.add('bkd-col-loser');
  } else if (defTotal > atkTotal) {
    defCol.classList.add('bkd-col-winner');
    atkCol.classList.add('bkd-col-loser');
  } else {
    atkCol.classList.add('bkd-col-tie');
    defCol.classList.add('bkd-col-tie');
  }
}

// Base cinematic timings (ms). Multiplied by speedMode factor.
const _BKD_TIMINGS = {
  tumble:       450,
  select:       300,
  selectHold:   150,
  rowStagger:   180,
  flash:        300,
  divider:      200,
  totalSnap:    250,
  outcomeDelay: 200,
};
function _speedFactor(mode) {
  if (mode === 'vfast') return 0.25;
  if (mode === 'fast')  return 0.5;
  return 1;
}

// Animate a side's breakdown column.
// Renders all rows upfront in a muted/desaturated state, then "glows" each
// row into its active state in sequence as the reveal progresses.
//
// Sequence:
//   1. Tumble the dice pool (faces jitter) with a muted pool row visible.
//   2. Pool row becomes active: discarded dice fade, picked die pops into
//      the value-column slot.
//   3. Modifier rows un-mute one at a time with a green/red/neutral flash.
//   4. Divider draws; total row pops.
function _animateBreakdownSide(colEl, snap, bd, side, total, factor, anim, padTo = 0) {
  const d = _breakdownData(snap, bd, side, total);
  colEl.innerHTML = '';
  colEl.classList.add('visible');

  const poolSign = _poolSign(d.advantage);
  const n = d.pool?.length ?? 0;

  // Build pool row. Not muted — the tumble animation must be clearly visible
  // before the picked die is selected. The glow-in at settle still fires.
  const poolRow = document.createElement('div');
  poolRow.className = 'bkd-row bkd-pool-row';
  if (poolSign !== 'base') poolRow.setAttribute('data-sign', poolSign === 'pos' ? 'positive' : 'negative');
  poolRow.innerHTML =
    `<span class="bkd-label">${_poolLabel(d.advantage)}</span>` +
    `<span class="bkd-pool-discards"></span>` +
    `<span class="bkd-pool-picked-slot"></span>`;
  const discardsEl = poolRow.querySelector('.bkd-pool-discards');
  const pickedSlot = poolRow.querySelector('.bkd-pool-picked-slot');

  // During tumble, all dice live in the discards area; on settle, the picked
  // die moves into the picked slot.
  const dieEls = [];
  for (let i = 0; i < n; i++) {
    const de = document.createElement('span');
    de.className = 'bkd-die bkd-die-tumbling';
    de.textContent = Math.ceil(Math.random() * 6);
    discardsEl.appendChild(de);
    dieEls.push(de);
  }
  if (n > 0) colEl.appendChild(poolRow);

  // Pre-render muted modifier rows.
  const rowEls = d.rows.map(r => {
    const row = document.createElement('div');
    row.className = 'bkd-row bkd-row-muted';
    if (r.sign !== 'base') row.setAttribute('data-sign', r.sign === 'pos' ? 'positive' : 'negative');
    const v = r.val >= 0 ? '+' + r.val : r.val;
    row.innerHTML =
      `<span class="bkd-label">${r.label}</span>` +
      `<span class="bkd-val">${v}</span>`;
    colEl.appendChild(row);
    return row;
  });

  // Spacer rows to equalize column height between atk and def sides so the
  // Total row lines up on the same baseline regardless of modifier count.
  const spacerCount = Math.max(0, padTo - d.rows.length);
  for (let i = 0; i < spacerCount; i++) {
    const spacer = document.createElement('div');
    spacer.className = 'bkd-row bkd-row-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.innerHTML = `<span class="bkd-label">&nbsp;</span><span class="bkd-val">&nbsp;</span>`;
    colEl.appendChild(spacer);
  }

  // Divider (muted).
  const hr = document.createElement('hr');
  hr.className = 'bkd-divider bkd-row-muted';
  colEl.appendChild(hr);

  // Total row (muted until the end).
  const totalRow = document.createElement('div');
  totalRow.className = 'bkd-row bkd-total-row bkd-row-muted';
  totalRow.innerHTML =
    `<span class="bkd-label">Total</span>` +
    `<span class="bkd-val">${total}</span>`;
  colEl.appendChild(totalRow);

  // Tumble the pool dice.
  const tumbleMs = Math.max(90, _BKD_TIMINGS.tumble * factor);
  let tumbleInterval = null;
  if (n > 0) {
    tumbleInterval = anim.interval(Math.max(40, 55 * factor), () => {
      for (const de of dieEls) de.textContent = Math.ceil(Math.random() * 6);
    });
  }

  return new Promise(resolve => {
    // Step 1 → 2: dice settle, pool row un-mutes, picked die moves to value slot.
    anim.timeout(tumbleMs, () => {
      // Stop the tumble interval so dice stay on their final face values.
      tumbleInterval?.cancel();
      // Settle dice faces.
      let pickedIdx = -1;
      for (let i = 0; i < dieEls.length; i++) {
        const v = d.pool[i];
        dieEls[i].textContent = v;
        dieEls[i].classList.remove('bkd-die-tumbling');
        if (pickedIdx < 0 && v === d.picked) pickedIdx = i;
      }
      // Mark discards, move picked into the picked slot.
      dieEls.forEach((de, i) => {
        if (i === pickedIdx) {
          de.classList.add('bkd-die-picked');
          pickedSlot.appendChild(de);
        } else {
          de.classList.add('bkd-die-discard');
        }
      });
      // Un-mute the pool row with a glow.
      poolRow.classList.remove('bkd-row-muted');
      poolRow.classList.add(
        poolSign === 'pos' ? 'bkd-row-glow-pos'
        : poolSign === 'neg' ? 'bkd-row-glow-neg'
        : 'bkd-row-glow-neutral'
      );

      // Step 3: un-mute modifier rows one at a time.
      const selectHoldMs = _BKD_TIMINGS.selectHold * factor + _BKD_TIMINGS.select * factor;
      const rowStagger = Math.max(40, _BKD_TIMINGS.rowStagger * factor);
      rowEls.forEach((row, idx) => {
        const sign = d.rows[idx].sign;
        anim.timeout(selectHoldMs + idx * rowStagger, () => {
          row.classList.remove('bkd-row-muted');
          row.classList.add(
            sign === 'pos' ? 'bkd-row-glow-pos'
            : sign === 'neg' ? 'bkd-row-glow-neg'
            : 'bkd-row-glow-neutral'
          );
        });
      });

      // Step 4: divider + total reveal after rows.
      const afterRows = selectHoldMs + rowEls.length * rowStagger + Math.max(60, 100 * factor);
      anim.timeout(afterRows, () => {
        hr.classList.remove('bkd-row-muted');
        hr.classList.add('bkd-divider-draw');
      });
      const dividerMs = Math.max(80, _BKD_TIMINGS.divider * factor);
      anim.timeout(afterRows + dividerMs, () => {
        totalRow.classList.remove('bkd-row-muted');
        totalRow.classList.add('bkd-total-pop');
      });
      anim.timeout(afterRows + dividerMs + Math.max(100, _BKD_TIMINGS.totalSnap * factor), () => resolve(totalRow));
    });
  });
}

// ── Cancellable timer bag for the battle dialog animation ─────────────────
//
// Tracks every setTimeout/setInterval set by the staged animation so they
// can be cancelled together on reset/dismiss. The animation sequence runs
// to completion uninterrupted — pause only affects the auto-dismiss timer,
// which lives outside this bag.
function _makeAnimBag() {
  const entries = [];
  const bag = {
    cancelled: false,
    onClear: null,
    timeout(delayMs, fn) {
      const e = { type: 'timeout', fn, id: null, cancelled: false };
      const run = () => { if (!e.cancelled && !bag.cancelled) fn(); };
      e.id = setTimeout(run, delayMs);
      entries.push(e);
      return e;
    },
    interval(delayMs, fn) {
      const e = { type: 'interval', delayMs, fn, id: null, cancelled: false };
      e.id = setInterval(fn, delayMs);
      e.cancel = () => {
        if (e.cancelled) return;
        e.cancelled = true;
        if (e.id !== null) { clearInterval(e.id); e.id = null; }
      };
      entries.push(e);
      return e;
    },
    // Cancel all timers without tearing down. Leaves the bag reusable.
    reset() {
      for (const e of entries) {
        e.cancelled = true;
        if (e.id !== null) {
          if (e.type === 'timeout') clearTimeout(e.id);
          else clearInterval(e.id);
          e.id = null;
        }
      }
      entries.length = 0;
      bag.cancelled = false;
    },
    // Tear down permanently. After clear(), no further timeouts will fire
    // even if scheduled, and onClear (if set) runs for listener cleanup.
    clear() {
      bag.reset();
      bag.cancelled = true;
      if (bag.onClear) { try { bag.onClear(); } catch (_) {} }
      bag.onClear = null;
    },
  };
  return bag;
}

