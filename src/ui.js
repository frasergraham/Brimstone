// UI controller: handles canvas clicks, sidepanel updates, action buttons
import { hexKey, hexToPixel, MAP_COLS, MAP_ROWS } from './hex.js';
import { TileType, BUILDING_LABEL, BUILDING_ICON, RESOURCE_LABEL, WEAPON_LABEL, ResourceType } from './tiles.js';
import { EntityType, SurvivorAbility, ENTITY_COLOR } from './entities.js';
import { Phase, Player, PHASE_ICON, nodeController, countHeldNodes } from './game.js';
import { PAD_X, PAD_Y, Renderer } from './renderer.js';
import {
  ActionType, getValidActions, getVisibleEnemyHexes, getVisibleHeroHexes,
} from './actions.js';
import { PlanActionType, computeGhostState, computeProjectedInventory, interleavePlan } from './planner.js';
import { compileTurnBattleSummary } from './battle-utils.js';
import { ResEventType } from '../server/resolver.js';
import { collectUIElements } from './ui-elements.js';
import { buildPlanStepsHtml, buildUnitPlanBlocksHtml, buildPlayerStatusHtml, buildObjectivesHtml } from './ui-render.js';

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

    this._touchStart  = null;
    this._pinchDist   = null;
    this._isDragging  = false;
    this._mouseDown   = null;
    this._didDragPan  = false;

    this._lastPostRoundKey = '';   // deduplicates post-round effect animations across state updates
    this._battleInterval   = null; // dice animation interval — cleared on new dialog
    this.speedMode         = this._loadDefaultSpeed(); // 'step' | 'cinematic' | 'fast' | 'vfast'
    this._stepResolve      = null;        // set while waiting for click-to-advance in step mode
    // Start with chronicle hidden on small screens (≤768px)
    this._chronicleMode    = window.innerWidth <= 768 ? 'none' : 'mini'; // 'none' | 'mini' | 'full'
    // When true, disable all planning/action UI — used for spectator mode
    this.spectator         = false;
    // When true, suppress phase modals and auto-select — used for tutorial mode
    this.tutorialMode      = false;
    // When true, block all map clicks (set by TutorialConductor during dialog steps)
    this.tutorialClickBlocked = false;

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
    document.addEventListener('click', () => {
      this._closeSpeedPopup();
      this._closeMapOptionsPopup();
    });

    // Chronicle toggle in map controls area
    this._el('chronicle-toggle')?.addEventListener('click', () => this._cycleChronicle());

    // Map options toggle
    this._el('map-options-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleMapOptionsPopup();
    });
    this._el('map-options-popup')?.addEventListener('click', (e) => e.stopPropagation());
    this._el('opt-tile-images')?.addEventListener('change', (e) => {
      this.renderer.useTileImages = e.target.checked;
      this.renderer.draw();
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

    // In-game menu modal
    const closeMenu = () => {
      const backdrop = this._el('game-menu-backdrop');
      if (backdrop) backdrop.style.display = 'none';
    };
    this._el('menu-btn')?.addEventListener('click', () => {
      const backdrop = this._el('game-menu-backdrop');
      if (backdrop) backdrop.style.display = backdrop.style.display === 'none' ? 'flex' : 'none';
    });
    this._el('menu-close-btn')?.addEventListener('click', closeMenu);
    this._el('menu-replay-turn-btn')?.addEventListener('click', () => {
      closeMenu();
      this.onReplayLastTurn?.();
    });
    this._el('menu-quit-btn')?.addEventListener('click', () => {
      closeMenu();
      this.onQuitToMenu?.();
    });
    this._el('menu-resign-btn')?.addEventListener('click', () => {
      closeMenu();
      this.onResignGame?.();
    });
    // Close on backdrop click (not modal itself)
    this._el('game-menu-backdrop')?.addEventListener('click', e => {
      if (e.target === this._el('game-menu-backdrop')) closeMenu();
    });
    this._el('game-menu-backdrop')?.addEventListener('touchstart', e => {
      if (e.target === this._el('game-menu-backdrop')) closeMenu();
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
        this._renderEndTurnBtn();
      } else if (panel && !this._edgeSwipe.collapsed && dx > threshold) {
        // Swiped right — close panel
        panel.classList.add('collapsed');
        this._syncPlanInset();
        this._renderPlanPanel();
        this._renderEndTurnBtn();
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

    // Submit Plan button in header — becomes "Menu" after submission
    const _submitHandler = () => {
      if (this.state.gameOver) return;
      if (this._planSubmitted) {
        if (this.onReturnToMenu) this.onReturnToMenu();
        return;
      }
      if (this._planMode) this._doSubmitPlan();
    };
    this._el('end-turn-btn')?.addEventListener('click', _submitHandler);
    this._el('end-turn-btn')?.addEventListener('touchend', e => {
      e.preventDefault(); _submitHandler();
    }, { passive: false });

    // Replay last turn button in header
    const _replayHandler = () => { if (this.onReplayLastTurn) this.onReplayLastTurn(); };
    this._el('replay-turn-btn')?.addEventListener('click', _replayHandler);
    this._el('replay-turn-btn')?.addEventListener('touchend', e => {
      e.preventDefault(); _replayHandler();
    }, { passive: false });

    // Plan panel buttons — touchend for instant mobile response
    const _tap = (el, fn) => {
      el?.addEventListener('click', fn);
      el?.addEventListener('touchend', e => { e.preventDefault(); fn(); }, { passive: false });
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
    });
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
  enterPlanningMode(faction, budget, timeoutMs = 0, { showPhaseModal = true } = {}) {
    this._planMode         = true;
    this._planFaction      = faction;
    this._planBudget       = budget;
    this._unitPlans        = new Map();
    this._planSubmitted    = false;

    // Reset footer buttons
    const submitBtn = this._el('plan-submit-btn');
    if (submitBtn) submitBtn.style.display = '';
    const clearBtn = this._el('plan-clear-btn');
    if (clearBtn) clearBtn.style.display = '';
    const menuBtn = this._el('plan-menu-btn');
    if (menuBtn) menuBtn.style.display = 'none';

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
    // Skip when re-entering planning after an inline replay (player already saw it this round).
    if (showPhaseModal && !this.tutorialMode) this._showPhaseModal(faction, budget);

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
    this._planMode      = false;
    this._planSubmitted = false;
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
    if (players.length <= 1) {
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
    if (this._planMode && !this._planSubmitted && timeoutMs > 0) {
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
    if (!this._unitPlans.has(action.entityId)) {
      this._unitPlans.set(action.entityId, []);
    }
    this._unitPlans.get(action.entityId).push(action);
    this.onPlanActionAdded?.(action);
    this._refreshPlanOverlay();
    this._renderPlanPanel();
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

  /** Submit the current plan (flattened to interleaved PlanAction[]). */
  _doSubmitPlan() {
    if (this._planSubmitted) return;
    this.markPlanSubmitted();
    if (this.onPlanSubmit) this.onPlanSubmit(interleavePlan(this._unitPlans));
  }

  /** Mark the plan as submitted (read-only wait state) without firing onPlanSubmit. */
  markPlanSubmitted() {
    if (this._planSubmitted) return;
    this._stopCountdown();
    this._planSubmitted = true;

    const panel = this._el('plan-panel');
    if (panel) panel.classList.add('plan-submitted');

    const status = this._el('plan-status');
    if (status) status.textContent = 'Waiting for opponents…';

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
    const foodAvailable = (this.state.inventory?.shared?.[ResourceType.FOOD] || 0);

    const initialInv = computeProjectedInventory(this.state, []);
    stepsEl.innerHTML = buildUnitPlanBlocksHtml(
      this._unitPlans, this._planBudget, foodAvailable,
      this._planSubmitted, this.state.entities ?? [], initialInv,
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
    if (this._stepResolve) { this._stepResolve(); return; }
    if (this.tutorialClickBlocked) return;
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

    // Outside planning mode, allow viewing tiles/units but block all actions.
    // During resolution/summary/playback, ignore clicks entirely.
    // If appMode is PLANNING but _planMode hasn't been set yet (race between
    // mode transition and enterPlanningMode call), ignore clicks rather than
    // falling through to tile-detail which blocks all UI interaction.
    if (!this._planMode) {
      if (this.appMode === 'RESOLVING' || this.appMode === 'SUMMARY' ||
          this.appMode === 'PLAYBACK' || this.appMode === 'PLANNING' ||
          this.appMode === 'SUBMITTED') return;
      this._clearSelection();
      // Show tile info in stats bar instead of overlay
      this._selectedTile = { col: hex.col, row: hex.row };
      this.renderer.selectedHex = { col: hex.col, row: hex.row };
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    // During planning, same click-to-select/target flow — but actions go to plan queue
    if (this._planMode && this._planSubmitted) {
      // Plan locked — read-only view
      this._clearSelection();
      this._selectedTile = { col: hex.col, row: hex.row };
      this.renderer.selectedHex = { col: hex.col, row: hex.row };
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
      if (this.myPlayerId && e.ownerId && e.ownerId !== this.myPlayerId) return false;
      const ghostPos = lastGhostPos?.get(e.id);
      // In planning mode, if the entity has been moved in the plan, use ONLY the
      // ghost position — it should no longer appear on its real tile.
      const pos = (this._planMode && ghostPos) ? ghostPos : { col: e.col, row: e.row };
      return pos.col === hex.col && pos.row === hex.row;
    });

    if (clickedEntities.length === 0) {
      // No friendly units — check for visible enemy units (view-only selection)
      const enemyEntities = _visibleUnitsAt(state, hex.col, hex.row)
        .filter(e => e.owner !== ownerFilter);
      if (enemyEntities.length > 1) {
        this._hideTileDetail();
        this._selectedEntity       = null;
        this._popupVisible         = true;
        this._validActions         = [];
        this.renderer.selectedHex    = { col: hex.col, row: hex.row };
        this.renderer.highlightHexes = [];
        this._pendingEnemyPick = { units: enemyEntities };
        this._showActionPopup(null);
      } else if (enemyEntities.length === 1) {
        this._hideTileDetail();
        this._selectEnemyEntity(enemyEntities[0]);
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
          _hideActionPopup(this);
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
    this._isEnemySelection = false;
    this.onEntitySelected?.(entity);
    this._pendingUnitPick = null;
    this._popupVisible    = false;
    _hideActionPopup(this);

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

  /** Select an enemy entity for view-only inspection (stats bar, no actions). */
  _selectEnemyEntity(entity) {
    this._selectedEntity       = entity;
    this._isEnemySelection     = true;
    this._pendingUnitPick      = null;
    this._popupVisible         = false;
    this._awaitingTarget       = null;
    this._validActions         = [];
    _hideActionPopup(this);

    this.renderer.selectedHex      = { col: entity.col, row: entity.row };
    this.renderer.selectedEntityId = entity.id;
    this.renderer.highlightHexes   = [];

    this.onEntitySelected?.(entity);
  }

  /** Return the latest projected position for an entity from the ghost overlay, or null. */
  _getProjectedPos(entityId) {
    const steps = this.renderer?.planGhostSteps;
    if (!steps || steps.length === 0) return null;
    return steps[steps.length - 1].positions.get(entityId) ?? null;
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
    _hideActionPopup(this);
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
        if (state.fogOfWar !== 'none' && this._selectedEntity) {
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
        if (state.fogOfWar !== 'none' && this._selectedEntity) {
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

      // Disambiguation: if the target hex has a selectable friendly unit, ask
      // whether the player wants to move there or select that unit instead.
      const ownerFilter = this._planMode ? this._planFaction : state.activePlayer;
      const lastGhostPos = this._planMode
        ? this.renderer?.planGhostSteps?.at(-1)?.positions
        : null;
      const alliesAtHex = state.entities.filter(e => {
        if (!e.alive || e.owner !== ownerFilter || e.id === actor.id) return false;
        if (this.myPlayerId && e.ownerId && e.ownerId !== this.myPlayerId) return false;
        const pos = (this._planMode && lastGhostPos?.get(e.id)) || { col: e.col, row: e.row };
        return pos.col === hex.col && pos.row === hex.row;
      });

      if (alliesAtHex.length > 0) {
        // Show disambiguation popup
        this._pendingDisambig = { actor, hex, allies: alliesAtHex };
        this._showDisambigPopup();
        return;
      }

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
      const originHex = { col: pickerUnits[0].col, row: pickerUnits[0].row };
      this._showArcDisambig(pickerUnits, actionTag, originHex);
      return;
    }

    const ownerCheck = this._planMode ? this._planFaction : state.activePlayer;
    if (!entity || entity.owner !== ownerCheck || state.gameOver) {
      _hideActionPopup(this);
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
            color: '#7eccd6', dis, attrs: 'data-action="explore"' });
          break;
        case ActionType.SOUND_HORN:
          arcItems.push({ group: 'scout', label: 'Sound Horn', fullLabel: 'Sound Horn (1 food)',
            color: '#7eccd6', dis: !action.affordable || dis, attrs: 'data-action="sound_horn"' });
          break;
        case ActionType.GUARD: {
          const charges = action.currentCharges || 0;
          const lbl = charges > 0 ? `Guard +${charges + 1}` : 'Guard';
          arcItems.push({ group: 'defense', label: lbl, fullLabel: lbl,
            color: '#8888cc', dis, attrs: 'data-action="guard"' });
          break;
        }
        case ActionType.FORTIFY: {
          const fortInv    = projInv ? projInv.shared : state.inventory.shared;
          const hasMetal   = (fortInv.metal || 0) > 0;
          const hasWood    = (fortInv.wood  || 0) > 0;
          const cantAfford = projInv ? (!hasMetal && !hasWood) : !action.affordable;
          const hasDoubler = entity.type === EntityType.SURVIVOR && entity.ability === SurvivorAbility.FORTIFY_DOUBLE;
          const tileData   = state.tiles.get(hexKey(entity.col, entity.row));
          const cur        = tileData ? tileData.fortifyLevel : 0;
          const metalGain   = Math.min(4, cur + 2) - cur;
          const doublerGain = Math.min(4, cur + 2) - cur;
          const woodGain    = Math.min(4, cur + 1) - cur;
          const shortLbl = hasMetal ? 'Reinforce Hex' : 'Fortify Hex';
          const fullLbl = hasMetal
            ? `Reinforce +${metalGain} DEF (1 metal)`
            : hasDoubler
              ? `Fortify +${doublerGain} DEF (1 wood)`
              : `Fortify +${woodGain} DEF (1 wood)`;
          arcItems.push({ group: 'defense', label: shortLbl, fullLabel: fullLbl,
            color: '#e0a832', dis: cantAfford || dis, attrs: 'data-action="fortify"' });
          break;
        }
        case ActionType.BATTLE_HEX:
          if (this._planMode) {
            arcItems.push({ group: 'combat', label: 'Attack Hex', fullLabel: 'Attack Hex',
              color: '#c0392b', dis, attrs: 'data-action="attack_hex"' });
          }
          break;
        case ActionType.SUMMON:
          // Handled below — we always show all 3 summon types
          break;
        case ActionType.USE_ITEM:
          for (const item of action.usable) {
            if (this._planMode && item.item === ResourceType.FOOD) continue;
            let itemDis = dis;
            if (projInv) {
              if (item.item === ResourceType.HERBS) {
                const eitems = projInv.entityItems[entity.id] ?? {};
                if ((eitems[ResourceType.HERBS] || 0) < 1) itemDis = true;
              } else if (!item.item.startsWith('weapon:')) {
                if ((projInv.shared[item.item] || 0) < 1) itemDis = true;
              }
            }
            // Strip leading emoji from item labels
            const cleanLabel = item.label.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '');
            arcItems.push({ group: 'items', label: cleanLabel, fullLabel: item.label,
              color: '#b0b0b0', dis: itemDis,
              attrs: `data-action="use_item" data-item="${item.item}"` });
          }
          break;
        case ActionType.EQUIP_WEAPON:
          for (const w of action.weapons) {
            arcItems.push({ group: 'items', label: w.label, fullLabel: `Equip ${w.label}`,
              color: '#b0b0b0', dis, attrs: `data-action="use_item" data-item="${w.key}"` });
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
            color: '#88eeff', dis: !isFree && dis, free: isFree,
            attrs: 'data-action="use_ability"' });
          break;
        }
      }
    }

    // Always show all 3 summon types for the witch, greyed out if unaffordable
    if (entity.type === EntityType.WITCH && actions.some(a => a.type === ActionType.SUMMON || a.type === ActionType.GUARD)) {
      const projWitch = projInv ? projInv.witch : state.inventory.witch;
      const projMetal = projWitch?.[ResourceType.METAL] || 0;
      const projWood  = projWitch?.[ResourceType.WOOD]  || 0;
      const projTotal = projWitch ? Object.values(projWitch).reduce((s, v) => s + (v || 0), 0) : 0;
      const ALL_SUMMONS = [
        { st: EntityType.IRON_GOLEM, label: 'Summon Iron Golem',  full: 'Summon Iron Golem (2 metal)',  afford: projMetal >= 2 },
        { st: EntityType.WOOD_GOLEM, label: 'Summon Wood Golem', full: 'Summon Wood Golem (2 wood)',   afford: projWood >= 2 },
        { st: EntityType.MINION,     label: 'Summon Minion',      full: 'Summon Minion (2 any resource)', afford: projTotal >= 2 },
      ];
      for (const s of ALL_SUMMONS) {
        arcItems.push({ group: 'summon', label: s.label, fullLabel: s.full,
          color: '#9b59b6', dis: !s.afford || !hasAct,
          attrs: `data-action="summon" data-summon-type="${s.st}"` });
      }
    }

    if (arcItems.length === 0) {
      // Nothing to show — use list mode with a message
      popup.classList.add('popup-list-mode');
      popup.innerHTML = `<div class="popup-unit-name">No actions available</div>`;
      _positionPopup(popup, this);
      popup.style.display = 'block';
      return;
    }

    // Compute arc geometry
    const screenPos = _getEntityScreenPos(this, entity);
    if (!screenPos) return;

    // Decide direction: open to side with more space
    const openRight = screenPos.x < window.innerWidth / 2;
    const centerAngle = openRight ? 0 : Math.PI; // 0 = right, PI = left

    // Compute initial arc radius (hex edge); overlap resolution happens in _positionArcPopup
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasScale = canvasRect.width / this.canvas.width;
    const hexScreenPx = this.renderer.hexSize * canvasScale * this.renderer.zoomLevel;
    // Dynamic gap: keep items within a ~160° arc so the radius stays tight.
    // With many items, narrow the gap rather than blowing out the radius.
    const totalItems = arcItems.length;
    const MAX_SPAN  = 160 * (Math.PI / 180);
    const PREF_GAP  = 40  * (Math.PI / 180);
    const ITEM_GAP  = totalItems <= 1 ? 0 : Math.min(PREF_GAP, MAX_SPAN / (totalItems - 1));
    const ARC_RADIUS = _baseArcRadius(hexScreenPx);
    this._arcRadius = ARC_RADIUS;

    const totalAngle = Math.max(0, totalItems - 1) * ITEM_GAP;
    const startAngle = centerAngle - totalAngle / 2;

    // Assign angles uniformly — keep top-to-bottom order consistent on both sides
    for (let i = 0; i < arcItems.length; i++) {
      // When opening left (π), subtract so first item stays at top
      arcItems[i]._angle = openRight
        ? startAngle + i * ITEM_GAP
        : centerAngle + totalAngle / 2 - i * ITEM_GAP;
      arcItems[i]._idx = i;
    }

    // Generate arc item HTML — initial positions use base radius (will be corrected before animating)
    let html = '';
    for (const item of arcItems) {
      const delay = item._idx * 30;
      const disAttr = item.dis ? 'disabled' : '';
      const freeCls = item.free ? ' arc-free' : '';
      html += `<button class="arc-item${freeCls}" title="${item.fullLabel}"
        style="--arc-x:0px;--arc-y:0px;--arc-delay:${delay}ms;--arc-color:${item.color};--arc-hover:${item.color};--arc-glow:${item.color}33"
        ${disAttr} ${item.attrs}>${item.label}</button>`;
    }

    popup.innerHTML = html;

    // Store arc state for pan/zoom tracking and canvas line drawing
    this._arcEntityCol = effectiveEntity.col;
    this._arcEntityRow = effectiveEntity.row;
    this._arcItems = arcItems; // keep for line drawing

    // Position popup centered on entity
    _positionArcPopup(popup, this);
    popup.style.display = 'block';

    // Measure buttons at full scale (they start at scale 0.3 but we need final size).
    // Temporarily force full scale with no transition to measure, then reset.
    const btns = popup.querySelectorAll('.arc-item');
    for (const btn of btns) {
      btn.style.transition = 'none';
      btn.style.transform = 'translate(-50%, -50%) scale(1)';
      btn.style.opacity = '0'; // keep invisible during measurement
    }
    // Force layout so measurements are accurate
    popup.offsetHeight; // eslint-disable-line no-unused-expressions

    // Resolve overlap-free radius using real button sizes
    const finalR = _resolveArcLayout(popup, this, ARC_RADIUS);
    this._arcRadius = finalR;
    this._arcBaseR = ARC_RADIUS;

    // Set final positions on CSS custom properties
    for (let i = 0; i < arcItems.length && i < btns.length; i++) {
      const fx = Math.cos(arcItems[i]._angle) * finalR;
      const fy = Math.sin(arcItems[i]._angle) * finalR;
      btns[i].style.setProperty('--arc-x', fx.toFixed(1) + 'px');
      btns[i].style.setProperty('--arc-y', fy.toFixed(1) + 'px');
    }

    // Reset to pre-animation state (collapsed at center) then let CSS transition to final spot
    for (const btn of btns) {
      btn.style.transform = '';
      btn.style.opacity = '';
      btn.style.transition = '';
    }

    _attachPopupListeners(popup, this);

    // Trigger open animation on next frame — positions are already set, just animate
    requestAnimationFrame(() => {
      popup.classList.add('arc-open');
      this.onRedraw();
    });

    // Start tracking pan/zoom — reposition popup each frame while visible
    _startArcTracking(this);
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

    for (const u of units) {
      const col        = ENTITY_COLOR[u.type] || '#888';
      const portraitId  = u.type === 'survivor' ? Renderer.survivorAssetId(u.title) : u.type;
      const src         = portraitId ? this.renderer.getPortraitDataURL(portraitId) : null;
      const pct         = u.maxHp > 0 ? u.hp / u.maxHp : 0;
      const hpColor     = pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ff9800' : '#f44336';

      const imgHtml = src
        ? `<img class="arc-portrait-img" src="${src}">`
        : `<div class="arc-portrait-img" style="display:flex;align-items:center;justify-content:center;font-size:1.2rem;background:rgba(20,16,32,0.8);">${u.displayName.charAt(0)}</div>`;

      arcItems.push({
        group: 'disambig',
        label: `${imgHtml}<div class="arc-portrait-hp"><div class="arc-portrait-hp-fill" style="width:${(pct * 100).toFixed(0)}%;background:${hpColor};"></div></div><span class="arc-portrait-name">${u.displayName}</span>`,
        fullLabel: `${u.displayName} — HP ${u.hp}/${u.maxHp}`,
        color: col,
        dis: false,
        free: false,
        attrs: `data-action="${actionTag}" data-unit-id="${u.id}"`,
        _portrait: true,
      });
    }

    // Compute arc geometry
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasScale = canvasRect.width / this.canvas.width;
    const hexScreenPx = this.renderer.hexSize * canvasScale * this.renderer.zoomLevel;

    // Decide direction: open to side with more space
    const { x: hx, y: hy } = this.renderer.hexToCanvasPos(originHex.col, originHex.row);
    const scale = canvasRect.width / this.canvas.width;
    const screenX = canvasRect.left + hx * scale;
    const openRight = screenX < window.innerWidth / 2;
    const centerAngle = openRight ? 0 : Math.PI;

    // Use a consistent target radius for portrait arcs — large enough that
    // no button obscures the origin hex (so players can tap to dismiss).
    // The closest edge of any button to center is (radius - halfSize); we
    // need that to exceed the hex radius so the hex stays tappable.
    const BASE_R = _baseArcRadius(hexScreenPx);
    const hexTapZone = hexScreenPx * 0.55; // half-hex + small margin
    // Portrait items are ~56×80px; worst-case half-diagonal ~50px
    const PORTRAIT_CLEARANCE = 50;
    const TARGET_R = Math.max(BASE_R, hexTapZone + PORTRAIT_CLEARANCE, 70);
    this._arcRadius = TARGET_R;

    // Compute angular gap dynamically: spread items evenly within a max arc
    // span (~180°) so the radius stays consistent regardless of item count.
    const totalItems = arcItems.length;
    const MAX_SPAN = Math.PI; // 180° max arc span
    const MIN_GAP  = 35 * (Math.PI / 180); // don't pack tighter than 35°
    const ITEM_GAP = totalItems <= 1 ? 0
      : Math.max(MIN_GAP, Math.min(MAX_SPAN / (totalItems - 1), 65 * (Math.PI / 180)));
    const totalAngle = Math.max(0, totalItems - 1) * ITEM_GAP;
    const startAngle = centerAngle - totalAngle / 2;

    for (let i = 0; i < arcItems.length; i++) {
      arcItems[i]._angle = openRight
        ? startAngle + i * ITEM_GAP
        : centerAngle + totalAngle / 2 - i * ITEM_GAP;
      arcItems[i]._idx = i;
    }

    // Generate HTML
    let html = '';
    for (const item of arcItems) {
      const delay = item._idx * 30;
      const portraitCls = item._portrait ? ' arc-portrait' : '';
      html += `<button class="arc-item${portraitCls}" title="${item.fullLabel}"
        style="--arc-x:0px;--arc-y:0px;--arc-delay:${delay}ms;--arc-color:${item.color};--arc-hover:${item.color};--arc-glow:${item.color}33"
        ${item.attrs}>${item.label}</button>`;
    }

    popup.innerHTML = html;

    // Store arc state for pan/zoom tracking and canvas line drawing
    this._arcEntityCol = originHex.col;
    this._arcEntityRow = originHex.row;
    this._arcItems = arcItems;

    // Position popup centered on hex
    _positionArcPopup(popup, this);
    popup.style.display = 'block';

    // Measure buttons at full scale for overlap resolution
    const btns = popup.querySelectorAll('.arc-item');
    for (const btn of btns) {
      btn.style.transition = 'none';
      btn.style.transform = 'translate(-50%, -50%) scale(1)';
      btn.style.opacity = '0';
    }
    popup.offsetHeight; // force layout

    const finalR = _resolveArcLayout(popup, this, TARGET_R);
    this._arcRadius = finalR;
    this._arcBaseR = TARGET_R;

    for (let i = 0; i < arcItems.length && i < btns.length; i++) {
      const fx = Math.cos(arcItems[i]._angle) * finalR;
      const fy = Math.sin(arcItems[i]._angle) * finalR;
      btns[i].style.setProperty('--arc-x', fx.toFixed(1) + 'px');
      btns[i].style.setProperty('--arc-y', fy.toFixed(1) + 'px');
    }

    // Reset to pre-animation state then let CSS transition to final spot
    for (const btn of btns) {
      btn.style.transform = '';
      btn.style.opacity = '';
      btn.style.transition = '';
    }

    _attachPopupListeners(popup, this);

    requestAnimationFrame(() => {
      popup.classList.add('arc-open');
      this.onRedraw();
    });

    _startArcTracking(this);
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
      const shared = projInv.shared;
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
      ${portraitHtml}
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
    const bar = this._el('score-bar');
    if (bar && this.state.disableScoring) {
      bar.style.display = 'none';
      return;
    }
    const el = this._el('score-bar-content');
    if (!el) return;
    const state = this.state;

    const { html, title } = buildObjectivesHtml(
      state.witchObjectives, state.entities, state.nodeScore,
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
    if (!btn) return;
    const state = this.state;

    if (!this._planMode) {
      // Outside planning mode, hide the button entirely
      btn.disabled = true;
      btn.style.display = 'none';
      return;
    }

    btn.style.display = '';
    btn.disabled = state.gameOver;
    btn.classList.toggle('urgent', !this._planSubmitted && !state.gameOver);
    btn.classList.add('planning-active');
    btn.title = this._planSubmitted ? 'Return to menu' : 'Submit Plan';
    // Let the countdown timer own the text when it's running
    if (!this._countdownTimer && !this._graceActive) {
      btn.textContent = this._planSubmitted ? '← Menu' : '✓ Submit';
    }
    // Hide when plan panel is expanded (not collapsed)
    const panel = this._el('plan-panel');
    const panelOpen = panel && panel.style.display !== 'none'
                   && !panel.classList.contains('collapsed');
    btn.classList.toggle('plan-open', !!panelOpen);
    btn.classList.toggle('plan-was-submitted', !!this._planSubmitted);
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
      _hideActionPopup(this);
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
        setTimeout(() => _hideActionPopup(this), 220);
      } else {
        _hideActionPopup(this);
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

  static SPEED_LABELS = { step: 'Step by Step', cinematic: 'Cinematic', fast: 'Fast', vfast: 'Very Fast' };

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
      `🌑 The curse deepens — Salem's mystical energy grows stronger!`,
      ``,
      desc,
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
      const base = 3;
      const timeBonus = phase === 'night' ? 1 : 0;
      const unitCount = entities.filter(e => e.alive && e.owner === 'witch' && e.type !== 'witch').length;
      const unitBonus = Math.min(unitCount, 3);
      rows.push({ label: 'Base', value: base });
      if (timeBonus) rows.push({ label: `${info.icon} ${info.label} bonus`, value: timeBonus });
      if (unitBonus) rows.push({ label: `☠ Minion${unitBonus !== 1 ? 's' : ''} (${unitCount})`, value: unitBonus });
    }
    // Power node bonus: +1 action per held node
    const nodeBonus = countHeldNodes(faction, this.state.witchObjectives ?? [], entities);
    if (nodeBonus) {
      rows.push({ label: `◆ Power Node${nodeBonus !== 1 ? 's' : ''} (${nodeBonus})`, value: nodeBonus });
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

    if (this.autoplay) {
      setTimeout(dismiss, 500);
    } else if (this.speedMode === 'fast' || this.speedMode === 'vfast') {
      setTimeout(dismiss, 800);
    } else {
      dialog.addEventListener('click', dismiss);
      document.addEventListener('keydown', keyDismiss);
    }
  }

  _showDefenderPickerDialog(defenders, onPick) {
    this._pendingDefenderPick = { defenders, onPick };
    this._popupVisible = true;
    this._showActionPopup(null);
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
    // Remove stale splash damage line from previous battle
    const oldSplash = dialog.querySelector('.battle-splash');
    if (oldSplash) oldSplash.remove();
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
    el.innerHTML = visible.map(m => `<div class="log-entry ${this._logEntryModifier(m)}"${this._logEntryStyle(m)}>${this._logText(m)}</div>`).join('');
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

      const { prevScore, prevNodes, humanFaction, fogOfWar, gameOver, winner, winReason, hasFullReplay } = opts;

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
          // Movement blocked by enemy — full block (ACTION_FAIL with blockedBy)
          if (ev.type === ResEventType.ACTION_FAIL &&
              ev.action?.type === PlanActionType.MOVE &&
              ev.blockedBy) {
            const actor = this.state.entities.find(e => e.id === ev.action.entityId);
            const actorName = actor?.displayName ?? 'Unit';
            const blockerName = ev.blockedBy.displayName ?? 'enemy';
            blockedMoves.push({ actorName, blockerName });
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
          titleEl.textContent = `Round ${roundNum ?? ''} complete`;
        }
      }
      if (eventsEl) {
        let html = '';

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
        const SPEED_ICONS = { step: '👆', cinematic: '🎬', fast: '⏩', vfast: '⏭' };
        const SPEED_DESCS = { step: 'Click to advance each action', cinematic: 'Dialog for important battles', fast: 'Cinematic pace, no popups', vfast: '1.5× speed, no popups' };
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
    parts.push(`<span class="usb-terrain-fort">⚙ Fort +${tile.fortifyLevel}</span>`);
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
    if (snap.attackBonus) parts.push(row('🪙 Silver', snap.attackBonus));
    if (bd.phaseBonus)    parts.push(row('🌙 Night', bd.phaseBonus));
    if (bd.atkStaffBonus) parts.push(row('⚕ Staff (undead)', bd.atkStaffBonus));
    bd.atkExtraDice.forEach((r, i) => {
      parts.push(row(`${bd.atkAllyNames[i] ?? 'Ally'} (D3)`, r, true));
    });
  } else {
    parts.push(row('Base d6', bd.defBaseDie, true));
    parts.push(row(`${snap.name} DEF`, snap.defense));
    if (snap.defenseBonus) parts.push(row('🛡 Bonus DEF', snap.defenseBonus));
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

function _hideActionPopup(ui) {
  const p = document.getElementById('action-popup');
  if (!p) return;
  // Clear any pending close timer
  if (ui && ui._arcCloseTimer) { clearTimeout(ui._arcCloseTimer); ui._arcCloseTimer = null; }
  // Stop pan/zoom tracking loop
  if (ui && ui._arcTrackingRaf) { cancelAnimationFrame(ui._arcTrackingRaf); ui._arcTrackingRaf = null; }
  // Clear canvas connecting lines
  if (ui?.renderer) { ui.renderer.arcMenuLines = null; }
  if (ui) { ui._arcItems = null; ui._arcEntityCol = null; ui._arcEntityRow = null; }
  // Arc mode: animate close
  if (p.classList.contains('arc-open') && !p.classList.contains('popup-list-mode')) {
    p.classList.remove('arc-open');
    p.classList.add('arc-closing');
    const itemCount = p.querySelectorAll('.arc-item').length;
    const closeTime = 150 + itemCount * 20;
    const timer = setTimeout(() => {
      p.style.display = 'none';
      p.classList.remove('arc-closing');
      if (ui) ui._arcCloseTimer = null;
    }, closeTime);
    if (ui) ui._arcCloseTimer = timer;
    // Trigger redraw to clear canvas lines
    ui?.onRedraw?.();
    return;
  }
  // List mode or not open: instant hide
  p.style.display = 'none';
  p.classList.remove('arc-open', 'arc-closing', 'popup-list-mode');
  ui?.onRedraw?.();
}

/** Get the screen position (viewport px) of a selected entity, accounting for planning ghosts. */
function _getEntityScreenPos(ui, entity) {
  if (!entity) {
    // For picker/disambig, try pending state
    const target = ui._pendingUnitPick?.units[0]
      || ui._pendingDefenderPick?.defenders[0]
      || ui._pendingEnemyPick?.units[0];
    if (!target) return null;
    entity = target;
  }
  let displayCol = entity.col;
  let displayRow = entity.row;
  if (ui._pendingDisambig) {
    displayCol = ui._pendingDisambig.hex.col;
    displayRow = ui._pendingDisambig.hex.row;
  } else if (ui._planMode && ui._selectedEntity) {
    const proj = ui._getProjectedPos(ui._selectedEntity.id);
    if (proj) { displayCol = proj.col; displayRow = proj.row; }
  }
  const canvasRect = ui.canvas.getBoundingClientRect();
  const { x, y }   = ui.renderer.hexToCanvasPos(displayCol, displayRow);
  const scale       = canvasRect.width / ui.canvas.width;
  return {
    x: canvasRect.left + x * scale,
    y: canvasRect.top  + y * scale,
  };
}

/** Compute arc radius: starts at hex edge, pushes out until items don't overlap. */
/** Compute base arc radius (hex edge). */
function _baseArcRadius(hexScreenPx) {
  return hexScreenPx * 0.87 + 4;
}

/**
 * Resolve arc layout so no buttons overlap and none obscure the origin hex.
 * Starts at baseR, measures actual button rects, and pushes radius out
 * until all bounding boxes are clear of each other and the hex tap zone.
 * Returns the final radius used.
 */
function _resolveArcLayout(popup, ui, baseR) {
  const items = ui._arcItems;
  if (!items?.length) return baseR;
  const btns = popup.querySelectorAll('.arc-item');
  if (!btns.length) return baseR;

  // Measure button dimensions (only need width/height, position is computed)
  const sizes = [];
  for (let i = 0; i < btns.length; i++) {
    const rect = btns[i].getBoundingClientRect();
    sizes.push({ w: rect.width, h: rect.height });
  }

  // Compute hex tap zone radius (half-hex + margin) so buttons never cover it
  const canvasRect = ui.canvas.getBoundingClientRect();
  const canvasScale = canvasRect.width / ui.canvas.width;
  const hexScreenPx = ui.renderer.hexSize * canvasScale * ui.renderer.zoomLevel;
  const hexTapZone = hexScreenPx * 0.55;

  // Check if any button's bounding box overlaps the hex center tap zone
  function obscuresHex(r) {
    for (let i = 0; i < items.length; i++) {
      const cx = Math.cos(items[i]._angle) * r;
      const cy = Math.sin(items[i]._angle) * r;
      const hw = sizes[i].w / 2, hh = sizes[i].h / 2;
      // Closest point of button AABB to origin (0,0)
      const nearX = Math.max(0, Math.abs(cx) - hw);
      const nearY = Math.max(0, Math.abs(cy) - hh);
      if (Math.sqrt(nearX * nearX + nearY * nearY) < hexTapZone) return true;
    }
    return false;
  }

  // Check if any pair of bounding boxes overlaps at a given radius
  function hasOverlap(r) {
    for (let i = 0; i < items.length; i++) {
      const cx1 = Math.cos(items[i]._angle) * r;
      const cy1 = Math.sin(items[i]._angle) * r;
      const hw1 = sizes[i].w / 2, hh1 = sizes[i].h / 2;
      for (let j = i + 1; j < items.length; j++) {
        const cx2 = Math.cos(items[j]._angle) * r;
        const cy2 = Math.sin(items[j]._angle) * r;
        const hw2 = sizes[j].w / 2, hh2 = sizes[j].h / 2;
        // AABB overlap check with 2px padding
        if (Math.abs(cx1 - cx2) < hw1 + hw2 + 2 &&
            Math.abs(cy1 - cy2) < hh1 + hh2 + 2) {
          return true;
        }
      }
    }
    return false;
  }

  // Only enforce hex-clearance for disambiguation arcs (portrait items) —
  // regular action arcs don't need it and it would blow out their radius.
  const hasPortraits = items.some(i => i._portrait);

  // Start at base radius and step outward until no overlaps (and hex is clear for portrait arcs)
  let r = baseR;
  const MAX_R = 400; // safety cap
  while (r < MAX_R && (hasOverlap(r) || (hasPortraits && obscuresHex(r)))) {
    r += 8;
  }
  return r;
}

/** Position the arc popup centered on the entity's screen position and set up canvas lines. */
function _positionArcPopup(popup, ui) {
  const col = ui._arcEntityCol;
  const row = ui._arcEntityRow;
  if (col == null || row == null) return;

  const canvasRect = ui.canvas.getBoundingClientRect();
  const { x, y }   = ui.renderer.hexToCanvasPos(col, row);
  const scale       = canvasRect.width / ui.canvas.width;
  const sx = canvasRect.left + x * scale;
  const sy = canvasRect.top  + y * scale;

  popup.style.left = sx + 'px';
  popup.style.top  = sy + 'px';
  popup.style.transform = 'none';

  // Update renderer's arc menu lines and DOM positions for canvas drawing
  if (ui._arcItems?.length) {
    // Recompute radius on zoom change (re-resolve overlap with current button sizes)
    const arcScale = canvasRect.width / ui.canvas.width;
    const hexPx = ui.renderer.hexSize * arcScale * ui.renderer.zoomLevel;
    const baseR = _baseArcRadius(hexPx);
    const prevR = ui._arcRadius || baseR;
    // Only re-resolve if zoom changed enough to matter (base radius shifted)
    if (Math.abs(baseR - (ui._arcBaseR || 0)) > 2) {
      const arcR = _resolveArcLayout(popup, ui, baseR);
      ui._arcRadius = arcR;
      ui._arcBaseR = baseR;
      const arcBtns = popup.querySelectorAll('.arc-item');
      for (let i = 0; i < ui._arcItems.length && i < arcBtns.length; i++) {
        const ix = Math.cos(ui._arcItems[i]._angle) * arcR;
        const iy = Math.sin(ui._arcItems[i]._angle) * arcR;
        arcBtns[i].style.setProperty('--arc-x', ix.toFixed(1) + 'px');
        arcBtns[i].style.setProperty('--arc-y', iy.toFixed(1) + 'px');
      }
    }
    const arcR = ui._arcRadius || prevR;
    ui.renderer.arcMenuLines = {
      col, row,
      items: ui._arcItems.map(item => ({
        x: Math.cos(item._angle) * arcR,
        y: Math.sin(item._angle) * arcR,
        color: item.color,
      })),
    };
  }
}

/** Start a rAF loop that repositions the arc popup on every frame (tracks pan/zoom). */
function _startArcTracking(ui) {
  if (ui._arcTrackingRaf) return; // already running
  const popup = document.getElementById('action-popup');
  function tick() {
    if (!popup || popup.style.display === 'none' || popup.classList.contains('popup-list-mode')) {
      ui._arcTrackingRaf = null;
      return;
    }
    _positionArcPopup(popup, ui);
    ui._arcTrackingRaf = requestAnimationFrame(tick);
  }
  ui._arcTrackingRaf = requestAnimationFrame(tick);
}

function _positionPopup(popup, ui) {
  if (!ui._selectedEntity && !ui._pendingUnitPick && !ui._pendingDefenderPick && !ui._pendingEnemyPick) return;
  const target = ui._selectedEntity
    || ui._pendingUnitPick?.units[0]
    || ui._pendingDefenderPick?.defenders[0]
    || ui._pendingEnemyPick?.units[0];
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
  if (ui._pendingDisambig) {
    // Disambiguation popup: show at the clicked hex, not the selected entity
    displayCol = ui._pendingDisambig.hex.col;
    displayRow = ui._pendingDisambig.hex.row;
  } else if (ui._planMode && ui._selectedEntity) {
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
    // On mobile, the synthesized click after touchend can be delayed or
    // swallowed (e.g. iOS treats the first tap on a newly-visible element
    // as a focus event).  Fire directly on touchend for instant response.
    b.addEventListener('touchend', e => {
      e.preventDefault();
      ui._handleActionButton(b);
    }, { passive: false });
  });
}

function _touchDist(t1, t2) {
  return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
}
