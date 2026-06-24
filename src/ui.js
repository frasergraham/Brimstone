// UI controller: handles canvas clicks, sidepanel updates, action buttons
import { hexKey, hexToPixel, hexDistance, MAP_COLS, MAP_ROWS } from './hex.js';
import { ICON, coloredResourceIcon, coloredResourceLabel, tintResourceGlyphs } from './icons.js';
import { TileType, BUILDING_LABEL, BUILDING_ICON, RESOURCE_LABEL, WEAPON_LABEL, ResourceType, MAX_FORTIFY_LEVEL, FORTIFY_HP_PER_LEVEL, getFortifyCombatBonus, legacyTileType } from './tiles.js';
import { ITEMS, lootDisplayLabel } from './items.js';
import { EntityType, SurvivorAbility, ENTITY_COLOR, isLeaderType, attackOf, defenseOf, rangeOf, getEquippedWeaponIdOf, getItemCountOf, totalItemCount, applyProjectedEquip } from './entities.js';
import { DAMAGE_SCALE } from './balance.js';
import { Phase, PHASE_ICON, phaseForRound, DEFAULT_CYCLE_PHASES, nodeController, countHeldNodes } from './game.js';
import { PAD_X, PAD_Y, Renderer } from './renderer.js';
import { makeOverlay } from './overlays.js';
import { concreteFactionOf, getFaction } from './factions.js';
import {
  ActionType, getValidActions, getVisiblePositions, computeCombatOdds,
} from './actions.js';
import * as audio from './audio.js';

import { PlanActionType, actionCosts, computeGhostState, computeProjectedInventory, interleavePlan, groupPlanByEntity, validatePlanAction, buildAutoGuardQueue } from './planner.js';
import { ABILITIES } from './abilities.js';
import { buildRollRows, buildOutcomeSummary, buildTurnCardHoverOverlays, battleOutcomeWord, compactUneventfulTurns } from './replay-timeline.js';
import { compileTurnBattleSummary, compileTurnXpSummary } from './battle-utils.js';
import { buildWrapupCombatsHtml, wrapupIconHtml } from './wrapup-summary.js';
import { ResEventType } from '../server/resolver.js';
import { collectUIElements } from './ui-elements.js';
import { buildPlanStepsHtml, buildUnitPlanBlocksHtml, buildPlayerStatusHtml, buildObjectivesHtml, buildMissionLogHtml, buildMissionLogDescriptionHtml, buildNodeBadgeHtml, buildEffectsHtml, buildCycleInfoHtml, buildCycleDeadlineHtml, PHASE_META, buildRollRowsTipHtml, computeGameTooltipPos, TurnCardAutoScroll, shouldAutoScrollToActive, computeFadeFlags, buildActionPipsHtml, buildActionBudgetTooltipHtml, levelPillHtml } from './ui-render.js';
import {
  hideActionPopup, getEntityScreenPos, computeArcPositions,
  positionArcPopup, startArcTracking, positionPopup,
  attachPopupListeners, touchDist,
} from './ui-popup.js';
import { isVoiceMuted, toggleVoiceMuted, voiceMuteIconHtml } from './voiceover.js';
import { xpProgress } from './campaign/campaign-ui.js';
import { runStoryBeatGate } from './story-beat-cinematic.js';

/** Enum of UI operating modes. */
export const UIMode = Object.freeze({ LOCAL: 'local', ONLINE: 'online', SPECTATOR: 'spectator' });

/** True when a click event is a triple-click on the title-bar "Actions" label —
 *  the hidden gesture that toggles the on-canvas debug counters (FPS, polys,
 *  camera). `detail` is the browser's consecutive-click counter; a triple-click
 *  fires a final `click` with `detail === 3`. Pure so it can be unit-tested
 *  without a real DOM. */
export function isDebugToggleClick(e) {
  if (!e || e.detail !== 3) return false;
  const t = e.target;
  if (!t) return false;
  if (typeof t.closest === 'function') return !!t.closest('.actions-label');
  return !!(t.classList && t.classList.contains('actions-label'));
}

/** Canonical in-game header title state. The top bar shows exactly ONE of three
 *  titles: PLANNING (building a plan), WAITING (plan locked, awaiting opponents
 *  online), or RESOLUTION (the round resolving / being replayed — this also
 *  covers the offline round summary and AI-vs-AI auto-play). Pure so it can be
 *  unit-tested without a DOM.
 *  @param {{planMode:boolean, planSubmitted:boolean}} [s]
 *  @returns {'PLANNING'|'WAITING'|'RESOLUTION'} */
export function headerTitleState({ planMode = false, planSubmitted = false } = {}) {
  if (planMode && !planSubmitted) return 'PLANNING';
  if (planMode &&  planSubmitted) return 'WAITING';
  return 'RESOLUTION';
}

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
    // Single subscriber for the plan-panel selection highlight: every
    // setSelection() fires this hook, which re-syncs the `.plan-unit-selected`
    // class. Centralises what used to be a class baked into the panel HTML.
    if (this.renderer) {
      this.renderer.onSelectionChange = () => this._syncPlanSelectionClass();
    }
    this.ai        = witchAI;
    this.heroAI    = heroAI;
    this.onRedraw  = onRedraw;
    this.autoplay  = autoplay;
    this.mp        = null;  // set externally when in online mode

    // Injected element bag — tests supply fake elements keyed by DOM ID.
    // Falls back to document.getElementById at each call site when missing.
    this._els = els ?? {};

    // Arm the one-shot user-gesture unlock for synthesized SFX (no-op in
    // tests/node — see src/audio.js).
    audio.init();
    // Game-styled hover tooltips ([data-tip] / [data-tip-html]) — module-level
    // singleton, hover-capable devices only.
    initGameTooltips();
    this._lastPhaseSoundKey = null;  // dedupe phase stings across summaries

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
    this.replayCameraMode  = 'follow';  // 'follow' (auto-zoom to action) | 'fixed' — replay overlay camera toggle (persists across turns)
    this.replayAutoPlay    = false;     // remembered AutoPlay choice — applied at the start of each turn's replay
    // Start with chronicle hidden by default; open = full sidebar, closed = pull-out tab only
    this._chronicleOpen    = false;
    // Unit stats bar: collapsed by default; clicking the (i) glyph expands to reveal ATK/DEF + abilities
    this._unitStatsExpanded = false;
    // Plan panel: same (i) glyph on the selected unit toggles its stats + pack detail (hidden by default)
    this._planStatsExpanded = false;
    // When true, disable all planning/action UI — used for spectator mode
    this.spectator         = false;
    // When true, suppress phase modals and auto-select — used for tutorial mode
    this.tutorialMode      = false;
    // When true, block all map clicks (set by MissionConductor during dialog steps)
    this.tutorialClickBlocked = false;
    // When true, block the plan submit button (set by MissionConductor until plan_submitted step)
    this.tutorialSubmitBlocked = false;
    // Strict Learn-to-Play gating (set by MissionConductor per step). A non-null
    // Set restricts which map hexes / arc-menu actions the player may use; null
    // (the default, and free play after handoff) means no restriction.
    this.tutorialAllowedHexes   = null;
    this.tutorialAllowedActions = null;
    // Restrict which units may be picked from a multi-unit hex (by entity type).
    this.tutorialAllowedUnits   = null;
    // One-shot: set by the conductor when a MOVE completes a gated step, so the
    // post-move re-select deselects instead of chaining (keeps unit-switching clean).
    this._tutorialSuppressReselect = false;

    // ── App mode (set by main.js via onModeChange) ───────────────────────────
    this.appMode        = 'MENU';  // mirrors AppMode enum from app-mode.js

    // ── Planning mode state ──────────────────────────────────────────────────
    this._planMode      = false;   // true during simultaneous planning phase
    this._unitPlans     = new Map(); // Map<entityId, PlanAction[]> — per-unit queues
    this._planFaction   = null;    // 'hero' or 'witch' — which faction we're planning for
    this._planBudget    = 0;       // total action budget for this round
    this._planSubmitted = false;   // true after plan is locked in
    this.onPlanSubmit   = null;    // callback(plan) — set by main.js

    // ── Round-summary wrap-up dismissal-by-click ─────────────────────────────
    // While the wrap-up card is up, _wrapUpResolve holds its Continue resolver
    // and _wrapUpFaction whose units the local player owns; a board click on one
    // of those units resolves the wrap-up as Continue and stashes the unit id in
    // _pendingPlanSelectId to pre-select once planning begins. All cleared on
    // dismissal / planning entry so nothing leaks across rounds.
    this._wrapUpResolve      = null;
    this._wrapUpFaction      = null;
    this._pendingPlanSelectId = null;

    // ── AI-assist (debug) ────────────────────────────────────────────────────
    // When enabled via the in-game `/aiassist` console command (backtick), an
    // "🤖 AI Plan" button appears during planning. Clicking it asks main.js
    // (onAIAssistRequest) for an AI-generated plan for the current faction and
    // loads it into the plan panel so the player can review the AI's choices and
    // then Submit normally.
    this.aiAssistEnabled  = false;
    this.onAIAssistRequest = null; // callback(faction) → flat PlanAction[]
    // Autorun: when true, each planning phase is auto-filled with an AI plan and
    // auto-submitted (and the end-of-round wrap-up auto-advances) so a whole
    // mission plays itself while you watch. aiAutorunDelay paces it.
    this.aiAutorun       = false;
    this.aiAutorunDelay  = 1400;
    this._autorunTimer   = null;

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
    if (this._autorunTimer) { clearTimeout(this._autorunTimer); this._autorunTimer = null; }
    // A pending mission-log toast dismissal must not fire after teardown and
    // touch an orphaned element (shares the listener-leak hazard).
    if (this._missionLogToastTimer) { clearTimeout(this._missionLogToastTimer); this._missionLogToastTimer = null; }
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
      this.renderer.setHover(null);
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
      this._replayManualCamera(() => {
        const cx = this.canvas.width  / 2;
        const cy = this.canvas.height / 2;
        this.renderer.setZoom(this.renderer.zoomLevel * zoomStep, cx, cy);
      });
      this.onRedraw();
    }, sig);
    this._el('zoom-out')?.addEventListener('click', () => {
      this._replayManualCamera(() => {
        const cx = this.canvas.width  / 2;
        const cy = this.canvas.height / 2;
        this.renderer.setZoom(this.renderer.zoomLevel / zoomStep, cx, cy);
      });
      this.onRedraw();
    }, sig);
    // Rotate buttons — 3D only; 2D Renderer.rotateBy is a no-op stub.
    // ROTATE_BUTTON_STEP (π/12 ≈ 15°) is duplicated here from renderer-3d.js
    // so ui.js stays free of 3D-renderer-specific imports.
    const rotateStep = Math.PI / 12;
    this._el('rotate-left')?.addEventListener('click', () => {
      this.renderer.rotateBy(-rotateStep, 0);
      this.onRedraw();
    }, sig);
    this._el('rotate-right')?.addEventListener('click', () => {
      this.renderer.rotateBy(rotateStep, 0);
      this.onRedraw();
    }, sig);
    // ── 3D camera-controls cluster (#camera-controls-3d) ────────────────────
    // Shown only on body.renderer-3d (CSS-driven), mobile-only: rotate
    // left/right buttons (pinch-to-zoom covers zoom on touch). Each button
    // hold-to-repeats so rotation feels continuous. The bind helper attaches
    // pointerdown / pointerup (with pointerleave fallback) so touch and mouse
    // drive the same repeater. Tilt is locked at π/4 — see CAMERA_BETA_LOCKED
    // in renderer-3d.js — so there are no tilt buttons.
    const ROT_STEP  = Math.PI / 60;           // ≈3° per tick — finer than the click-step rotate buttons
    const REPEAT_MS = 50;
    const bindHoldToRepeat = (id, tickFn) => {
      const el = this._el(id);
      if (!el) return;
      let timer = null;
      const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
      const start = (ev) => {
        ev.preventDefault();
        // Fire once immediately, then repeat — single-tap users still get a tick.
        tickFn();
        this.onRedraw();
        stop();
        timer = setInterval(() => { tickFn(); this.onRedraw(); }, REPEAT_MS);
      };
      el.addEventListener('pointerdown', start, sig);
      el.addEventListener('pointerup',     stop, sig);
      el.addEventListener('pointercancel', stop, sig);
      el.addEventListener('pointerleave',  stop, sig);
    };
    bindHoldToRepeat('cam3d-rotate-left',  () => this.renderer.rotateBy(-ROT_STEP, 0));
    bindHoldToRepeat('cam3d-rotate-right', () => this.renderer.rotateBy( ROT_STEP, 0));
    this._el('zoom-fit')?.addEventListener('click', () => {
      if (this.renderer.viewLocked) return;
      this._replayManualCamera(() => {
        // One-button, two-action: tap frames the map; tapping again when the
        // camera is already at the framed target (so framing would be a
        // visual no-op) orients north up instead. No 400ms double-tap window.
        const alreadyFramed = this.renderer.is3D
          && typeof this.renderer.isAtFitTarget === 'function'
          && this.renderer.isAtFitTarget();
        if (alreadyFramed) {
          if (typeof this.renderer.orientNorthUp === 'function') this.renderer.orientNorthUp();
          return;
        }
        this.renderer.resize();
        if (this.renderer.is3D && typeof this.renderer.zoomOutToOwnedUnits === 'function') {
          this.renderer.zoomOutToOwnedUnits();
        } else {
          this.renderer.resetView();
        }
      });
      this.onRedraw();
    }, sig);
    this._el('zoom-me')?.addEventListener('click', () => {
      this._replayManualCamera(() => {
        if (this._selectedEntity && this._selectedEntity.alive) {
          // Zoom to selected unit — an explicit distance change (fit), so it
          // recomputes the radius and establishes the user zoom.
          const pos = this._planMode ? (this._getProjectedPos(this._selectedEntity.id) ?? this._selectedEntity) : this._selectedEntity;
          this.renderer.frameHexes([pos], { maxZoom: 3.5, paddingHexes: 1.5, duration: 400, fit: true });
        } else {
          // No selection — frame all player's units (explicit fit).
          const faction = this._planFaction ?? (!this.state.heroIsAI ? 'hero' : 'witch');
          const units   = this.state.entities.filter(e => e.alive && e.owner === faction);
          if (units.length > 0) this.renderer.frameHexes(units, { maxZoom: 1.8, paddingHexes: 2.5, duration: 400, fit: true });
        }
      });
      this.onRedraw();
    }, sig);
    // Combat-detail speed now lives in the playback "Detail" control
    // (see _showReplayBar); the old map-control toggle was removed.

    // Close map options popup on outside click
    document.addEventListener('click', () => {
      this._closeMapOptionsPopup();
    }, sig);

    // Chronicle pull-out tab — binary open/close toggle (mirrors plan-tab on the right)
    this._el('chronicle-tab')?.addEventListener('click', () => {
      this._setChronicleOpen(!this._chronicleOpen);
    }, sig);

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
    //
    // When the 3D renderer is active, drag-to-pan / pinch-to-zoom are owned
    // by the custom camera input in renderer-3d.js (`_installCustomCameraInput`).
    // We still need touchend → tap → _onClick for hex selection, so the
    // touchstart/move/end handlers stay attached — they just skip the pan
    // and pinch maths against `renderer._panX` / `setZoom` (those would
    // double-apply on top of the 3D camera's own inertial accumulators).
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
      // 3D mode: pan / pinch live in renderer-3d's custom camera input. Just
      // track whether the user has dragged far enough to suppress the tap.
      if (this.renderer.is3D) {
        if (e.touches.length === 1 && this._touchStart) {
          const t = e.touches[0];
          const total = Math.hypot(
            t.clientX - this._touchStart.clientX,
            t.clientY - this._touchStart.clientY
          );
          if (total > 10) this._isDragging = true;
        }
        return;
      }
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
    this._el('menu-btn')?.addEventListener('click', () => {
      const backdrop = this._el('game-menu-backdrop');
      if (backdrop) backdrop.style.display = backdrop.style.display === 'none' ? 'flex' : 'none';
    }, sig);
    // Hidden gesture: triple-click the title-bar "Actions" label to toggle the
    // on-canvas debug counters (FPS / polys / camera). Delegated on the
    // persistent turn-info container because the label is rebuilt via innerHTML.
    // Off by default — CSS gates the counters on `body.debug-counters`.
    this._el('turn-info')?.addEventListener('click', (e) => {
      if (isDebugToggleClick(e)) document.body.classList.toggle('debug-counters');
    }, sig);
    this._el('menu-close-btn')?.addEventListener('click', closeMenu, sig);
    // Bottom score bar / day-cycle pill → cycle & scoring info panel.
    // The pill is a child of the bar, but bind it explicitly too (with the
    // bubble stopped) so the protruding pill always toggles the panel even if
    // the bar's hit area changes.
    this._el('score-bar')?.addEventListener('click', () => this._showCycleInfoPopup(), sig);
    this._el('cycle-bump')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showCycleInfoPopup();
    }, sig);
    // Sound toggle — label reflects persisted mute state on first open.
    const soundBtn = this._el('menu-sound-btn');
    const _syncSoundLabel = () => {
      if (soundBtn) soundBtn.textContent = audio.isMuted() ? '\uE077 Sound: Off' : '\uE076 Sound: On';
    };
    _syncSoundLabel();
    soundBtn?.addEventListener('click', () => {
      audio.toggleMuted();
      _syncSoundLabel();
      if (!audio.isMuted()) audio.play('score');  // audible confirmation
    }, sig);
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
        // On mobile, close chronicle so the two panels don't overlap.
        if (this._chronicleOpen && this._isMobileViewport()) {
          this._setChronicleOpen(false);
        }
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

    // Chronicle overlay (full-screen modal, separate from the sidebar tab) close handlers
    this._el('chronicle-close')?.addEventListener('click', () => {
      this._el('chronicle-overlay')?.classList.remove('visible');
    }, sig);
    this._el('chronicle-overlay')?.addEventListener('click', e => {
      if (e.target === this._el('chronicle-overlay')) {
        this._el('chronicle-overlay').classList.remove('visible');
      }
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
        this.renderer.clearOverlaysByLayer('highlight-disc');
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
    _tap(this._el('plan-autoguard-btn'), () => this._autoFillGuard());
    _tap(this._el('plan-aiassist-btn'),  () => this._fillAIAssistPlan());
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
    // 3D mode owns its own pan/rotate via renderer-3d's custom camera input
    // (left-drag pans, right-drag rotates). Just track drag distance so a
    // dragged-and-released click doesn't fire hex selection.
    if (this._mouseDown && this.renderer.is3D) {
      const dx = e.clientX - this._mouseDown.clientX;
      const dy = e.clientY - this._mouseDown.clientY;
      if (Math.hypot(dx, dy) > 5) {
        this._didDragPan = true;
        this._claimReplayCamera();      // 3D manual pan during replay → hold the view
      }
    } else if (this._mouseDown) {
      const dx = e.clientX - this._mouseDown.clientX;
      const dy = e.clientY - this._mouseDown.clientY;
      if (Math.hypot(dx, dy) > 5) {
        this._didDragPan = true;
        this._claimReplayCamera();      // manual pan during replay → hold the view
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
    this.renderer.setHover(
      (hex.col >= 0 && hex.col < MAP_COLS && hex.row >= 0 && hex.row < MAP_ROWS) ? hex : null,
    );
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

    this._syncAIAssistButton();

    // The Last Turn (↺) replay button's visibility is centralised in
    // _renderEndTurnBtn (called via _updateSidebar below) so it tracks the
    // three header states (PLANNING-only) rather than being set once here.

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

    // If the player dismissed the round summary by clicking one of their units,
    // honour that pick once planning is live (overrides the round-1 leader
    // auto-select above — the explicit click wins). Cleared whether or not the
    // unit is still controllable so it never leaks into a later round.
    if (this._pendingPlanSelectId != null) {
      const pickId = this._pendingPlanSelectId;
      this._pendingPlanSelectId = null;
      const pick = this.state?.entities.find(e =>
        e.id === pickId && e.alive && e.owner === faction && !e.isNpc &&
        (!this.myPlayerId || !e.ownerId || e.ownerId === this.myPlayerId)
      );
      if (pick) this._selectEntity(pick);
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

    this._maybeAutorun();
  }

  /** Exit planning mode (called after resolution completes). */
  exitPlanningMode() {
    this._stopUndoBtnTracking();
    if (this._autorunTimer) { clearTimeout(this._autorunTimer); this._autorunTimer = null; }
    this._planMode      = false;
    this._pushUnitInfoCards();  // plan over — clear odds/attack markers
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
    const isFreeAction = !actionCosts(action.type);
    if (!isFreeAction) {
      const flatPlan = interleavePlan(this._unitPlans);
      const currentCost = flatPlan.filter(a => actionCosts(a.type)).length;
      const foodAvailable = getItemCountOf(this.state.inventory?.hero, ResourceType.FOOD);
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

  /**
   * Auto-Guard: fill the remaining action budget with GUARD actions, the leader
   * first then down the unit list in order, until the budget is used up. Never
   * spends food — it stops at the true action budget. Guard charges stack, so a
   * round-robin reinforces stances rather than wasting leftover budget.
   */
  _autoFillGuard() {
    if (this._planSubmitted) return;

    const used = interleavePlan(this._unitPlans).filter(a => actionCosts(a.type)).length;
    let remaining = this._planBudget - used;
    if (remaining <= 0) {
      this._showPlanToast('No action budget left for Auto-Guard.');
      return;
    }

    // Eligible units (skip stunned/blocked); the pure builder orders leader(s)
    // first then round-robins to fill the budget.
    const eligible = this._getControllableUnits()
      .filter(u => validatePlanAction(this.state, { type: PlanActionType.GUARD, entityId: u.id }).valid)
      .map(u => ({ id: u.id, isLeader: isLeaderType(u.type) }));
    if (eligible.length === 0) {
      this._showPlanToast('No units can guard right now.');
      return;
    }

    const queue = buildAutoGuardQueue(eligible, remaining);
    for (const id of queue) {
      const action = { type: PlanActionType.GUARD, entityId: id };
      if (!this._unitPlans.has(id)) this._unitPlans.set(id, []);
      this._unitPlans.get(id).push(action);
      this.onPlanActionAdded?.(action);
    }
    const added = queue.length;

    this._refreshPlanOverlay();
    this._renderPlanPanel();
    this._refreshUndoButtons();
    this._startUndoBtnTracking();
    if (this._selectedEntity) this._selectEntity(this._selectedEntity);
    this.onRedraw();
    this._showPlanToast(`${ICON.shield} Auto-Guard: ${added} guard action${added === 1 ? '' : 's'} queued.`);
  }

  /**
   * Show/hide the AI-assist button. Visible only while AI assist is enabled and
   * we're actively planning (not yet submitted). Called on planning entry and
   * whenever the console toggle flips `aiAssistEnabled`.
   */
  _syncAIAssistButton() {
    const btn = this._el('plan-aiassist-btn');
    if (!btn) return;
    const show = !!this.aiAssistEnabled && this._planMode && !this._planSubmitted;
    btn.style.display = show ? '' : 'none';
  }

  /**
   * AI-assist: ask main.js for an AI-generated plan for the current faction and
   * load it into the plan panel for review. Replaces any actions queued so far.
   * In manual mode the player still submits — this only fills the queue so they
   * can watch what the AI would do. Returns the number of actions queued.
   */
  _fillAIAssistPlan({ autorun = false } = {}) {
    if (this._planSubmitted || !this.onAIAssistRequest) return 0;
    let plan;
    try {
      plan = this.onAIAssistRequest(this._planFaction);
    } catch (e) {
      console.error('[ai-assist] plan generation failed', e);
      this._showPlanToast('AI plan generation failed — see console.');
      return 0;
    }
    if (!plan || plan.length === 0) {
      if (!autorun) this._showPlanToast('\uE07F AI had no actions to plan this round.');
      return 0;
    }
    this._unitPlans = groupPlanByEntity(plan);
    this._refreshPlanOverlay();
    this._renderPlanPanel();
    this._refreshUndoButtons();
    this._startUndoBtnTracking();
    if (this._selectedEntity) this._selectEntity(this._selectedEntity);
    this.onRedraw();
    this._showPlanToast(autorun
      ? `${ICON.bot} Autorun: ${plan.length} action${plan.length === 1 ? '' : 's'} — submitting…`
      : `${ICON.bot} AI queued ${plan.length} action${plan.length === 1 ? '' : 's'} — review, then Submit.`);
    return plan.length;
  }

  /**
   * Autorun step: when enabled, fill this planning phase with an AI plan, then
   * auto-submit after a visible pause so the round can be watched. Re-armed each
   * time planning re-enters, so a whole mission plays itself. Skipped in tutorial
   * mode (the conductor drives those). The wrap-up between rounds auto-advances
   * via the hook in showReplayWrapUp().
   */
  _maybeAutorun() {
    if (!this.aiAutorun || this.tutorialMode) return;
    if (!this._planMode || this._planSubmitted) return;
    if (this._autorunTimer) { clearTimeout(this._autorunTimer); this._autorunTimer = null; }
    // Auto-play the resolution replay so it runs to the end without manual
    // stepping (main.js reads this when seeding playback.paused), then the
    // wrap-up auto-advances via the hook in showReplayWrapUp(). Speed is left at
    // the player's chosen replay speed — autorun is for watching, not racing.
    this.replayAutoPlay = true;
    // Fill immediately so the queued plan is visible, then submit after a pause.
    this._fillAIAssistPlan({ autorun: true });
    this._autorunTimer = setTimeout(() => {
      this._autorunTimer = null;
      if (this.aiAutorun && this._planMode && !this._planSubmitted) this._doSubmitPlan();
    }, this.aiAutorunDelay);
  }

  /** Recompute ghost overlay from the current plan and push to renderer. */
  _refreshPlanOverlay() {
    if (!this.renderer) return;
    const flatPlan = interleavePlan(this._unitPlans);
    const steps = computeGhostState(this.state, flatPlan);
    // Annotate each step with whether it exceeds the action budget
    let runningCost = 0;
    for (const step of steps) {
      const isFree = !actionCosts(step.action.type);
      if (!isFree) runningCost++;
      step.overBudget = !isFree && runningCost > this._planBudget;
    }
    this.renderer.planGhostSteps = steps;
    // Keep the unit info cards (planned-attack counts) in lockstep with the
    // plan — the renderer's hex-badge fallback reads both in the same draw.
    this._pushUnitInfoCards();
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
    this._pushUnitInfoCards();  // clears the odds/attack markers (guard in compute)
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
    const statusEl = this._el('plan-status');
    if (!stepsEl) return;

    // Food is auto-applied to over-budget actions until exhausted.
    const foodAvailable = getItemCountOf(this.state.inventory?.hero, ResourceType.FOOD);

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
      this._planStatsExpanded,
    );
    // The rebuilt HTML drops any `.plan-unit-selected` class — re-apply it from
    // the single subscriber so selection highlight survives the rebuild.
    this._syncPlanSelectionClass();

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

    // (i) glyph on the selected unit → toggle its stats + pack detail.
    stepsEl.querySelectorAll('.plan-stats-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this._planStatsExpanded = !this._planStatsExpanded;
        this._renderPlanPanel();
      });
    });

    // Click on a unit block → select that unit on the map.
    stepsEl.querySelectorAll('.plan-unit-block').forEach(block => {
      block.addEventListener('click', e => {
        // Don't steal clicks meant for the per-step remove ✕ or the (i) toggle.
        if (e.target.closest('.plan-step-remove') || e.target.closest('.plan-stats-btn')) return;
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

    // Update the side-tab +/- affordance to match collapsed state. (The action
    // count + collapse arrow that used to live in the panel header were removed —
    // the action budget now lives only in the top-bar ACTION BUDGET pips.)
    const panel = this._el('plan-panel');
    const tabToggle = this._el('plan-tab-toggle');
    if (tabToggle && panel) {
      tabToggle.textContent = panel.classList.contains('collapsed') ? '+' : '\u2212';
    }

    // Render inventory section at the bottom of the plan panel
    this._renderInventory();
  }

  /**
   * Single source for the plan-panel selection highlight. Toggles the
   * `.plan-unit-selected` class on the unit block whose `data-entity-id`
   * matches the current selection, clearing it from all others. Fired by the
   * renderer's `onSelectionChange` hook (every setSelection) and re-run after
   * each panel rebuild (the rebuilt HTML carries no class).
   *
   * Planning mode selects a ghost-projected entity, but the plan block is keyed
   * by the real entity id either way, so the lookup is unaffected. Enemy / tile
   * selections have no matching block, so the highlight simply clears.
   */
  _syncPlanSelectionClass() {
    const stepsEl = this._el('plan-steps');
    if (!stepsEl || typeof stepsEl.querySelectorAll !== 'function') return;
    const selId = this._selectedEntity?.id ?? null;
    stepsEl.querySelectorAll('.plan-unit-block').forEach(block => {
      const match = selId != null && block.dataset?.entityId === String(selId);
      block.classList?.toggle('plan-unit-selected', match);
    });
  }

  /** True when the viewport matches the mobile breakpoint used elsewhere in styles.css. */
  _isMobileViewport() {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 700px)').matches;
  }

  /** Toggle the plan panel between expanded and collapsed. */
  _togglePlanPanel() {
    const panel = this._el('plan-panel');
    if (!panel) return;
    panel.classList.toggle('collapsed');
    const isCollapsed = panel.classList.contains('collapsed');
    const tabToggle = this._el('plan-tab-toggle');
    if (tabToggle) tabToggle.textContent = isCollapsed ? '+' : '\u2212';
    // On mobile, plan and chronicle are mutually exclusive \u2014 close chronicle when opening plan.
    if (!isCollapsed && this._chronicleOpen && this._isMobileViewport()) {
      this._setChronicleOpen(false);
    }
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
    // In 3D mode the custom pointer input calls preventDefault on pointermove,
    // which suppresses compat `mousemove` and so the `_didDragPan` flag above
    // is never set during a 3D drag. The renderer tracks the drag itself and
    // publishes the verdict on every pointerup — consume + clear it here.
    if (this.renderer?.is3D && this.renderer._lastGestureWasDrag) {
      this.renderer._lastGestureWasDrag = false;
      return;
    }
    if (this.tutorialClickBlocked) return;
    if (this.state.gameOver) return;

    const { x, y } = this._canvasPos(e);
    const hex = this._canvasToHex(x, y);
    if (hex.col < 0 || hex.col >= MAP_COLS || hex.row < 0 || hex.row >= MAP_ROWS) return;
    // Strict tutorial gating: when an allowlist is published, only the spotlit
    // hexes are clickable — every other click is swallowed so the player can't
    // deviate from the scripted path. Null (the default / free play) = no gate.
    if (this.tutorialAllowedHexes && !this.tutorialAllowedHexes.has(`${hex.col},${hex.row}`)) return;

    // Round-summary wrap-up is on screen: clicking one of YOUR units resolves it
    // as Continue (identical teardown to the Continue button) and pre-selects
    // that unit once planning begins. Clicking empty ground / an enemy is left
    // to the summary's own scrub flow (handled by the SUMMARY early-return
    // below), so normal selection and replay scrubbing are untouched.
    if (this._wrapUpResolve) {
      const mine = this._myUnitAt(hex);
      if (mine) {
        this._pendingPlanSelectId = mine.id;
        const resolve = this._wrapUpResolve;
        resolve('next');   // clears _wrapUpResolve via finish(); see showReplayWrapUp
        return;
      }
      return;   // wrap-up up but no own unit clicked — don't fall through
    }

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

  /**
   * Return the local player's controllable unit at a hex, or null. Used by the
   * round-summary wrap-up dismissal — mirrors the owner filter in
   * _handleSelection (own faction, not an NPC, and in MP only the local
   * player's units), but keyed off _wrapUpFaction since planning isn't live yet.
   */
  _myUnitAt(hex) {
    const faction = this._wrapUpFaction;
    if (!faction || !this.state) return null;
    return this.state.entities.find(e =>
      e.alive && e.owner === faction && !e.isNpc &&
      e.col === hex.col && e.row === hex.row &&
      (!this.myPlayerId || !e.ownerId || e.ownerId === this.myPlayerId)
    ) ?? null;
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
      // Scripted campaign NPCs are never controllable (view-only below).
      if (e.isNpc) return false;
      // In online MP, only allow selecting entities owned by the local player.
      if (this.myPlayerId && e.ownerId && e.ownerId !== this.myPlayerId) return false;
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
          // Scripted campaign NPC → view-only
          if (e.isNpc) return true;
          // Same faction but a different player → ally, view-only
          if (this.myPlayerId && e.ownerId && e.ownerId !== this.myPlayerId) return true;
          return false;
        });
      if (viewOnlyEntities.length > 1) {
        this._hideTileDetail();
        this._selectedEntity       = null;
        this._popupVisible         = true;
        this._validActions         = [];
        this.renderer.setSelection({ entityId: null, hex: { col: hex.col, row: hex.row } });
        this.renderer.clearOverlaysByLayer('highlight-disc');
        this._pendingEnemyPick = { units: viewOnlyEntities };
        this._showActionPopup(null);
      } else if (viewOnlyEntities.length === 1) {
        this._hideTileDetail();
        this._selectEnemyEntity(viewOnlyEntities[0]);
      } else {
        // Empty hex — show tile info in stats bar
        this._clearSelection();
        this._selectedTile = { col: hex.col, row: hex.row };
        this.renderer.setSelection({ entityId: null, hex: { col: hex.col, row: hex.row } });
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
      this.renderer.setSelection({ entityId: null, hex: { col: hex.col, row: hex.row } });
      this.renderer.clearOverlaysByLayer('highlight-disc');
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
      this.renderer.setSelection({ entityId: null, hex: { col: hex.col, row: hex.row } });
      this.renderer.clearOverlaysByLayer('highlight-disc');
      this._pendingEnemyPick = { units: viewUnits };
      this._showActionPopup(null);
    } else if (viewUnits.length === 1) {
      this._selectEnemyEntity(viewUnits[0]);
    } else {
      // Empty hex — show tile info
      this._selectedTile = { col: hex.col, row: hex.row };
      this.renderer.setSelection({ entityId: null, hex: { col: hex.col, row: hex.row } });
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
    // projected position (after earlier MOVE steps) AND projected weapon (after
    // a queued EQUIP_WEAPON switch), not the live ones — otherwise attack-range
    // highlights use the current weapon's range, not the one being switched to.
    let effectiveEntity = entity;
    if (this._planMode) {
      const proj      = this._getProjectedPos(entity.id);
      const projWeapon = this._getProjectedWeaponId(entity.id);
      const posChanged = proj && (proj.col !== entity.col || proj.row !== entity.row);
      const weaponChanged = projWeapon && projWeapon !== entity.getEquippedWeaponId();
      if (posChanged || weaponChanged) {
        // applyProjectedEquip re-parents to Entity.prototype (so hasAbility /
        // getAttack / getRange still resolve) and equips the projected weapon
        // on a deep-copied backpack without touching the live entity.
        effectiveEntity = applyProjectedEquip(entity, weaponChanged ? projWeapon : null);
        if (posChanged) { effectiveEntity.col = proj.col; effectiveEntity.row = proj.row; }
      }
    }

    this.renderer.setSelection({
      entityId: entity.id,
      hex: { col: effectiveEntity.col, row: effectiveEntity.row },
    });
    this._validActions = getValidActions(this.state, effectiveEntity);
    // Move is always the default awaiting action — clicking a green hex moves.
    const hasMoveAction = this._validActions.some(a => a.type === ActionType.MOVE);
    const actionsOk = this._planMode || this.state.actionsAvailable > 0;
    if (hasMoveAction && actionsOk) {
      // Store the real entity in actor: effectiveEntity is a prototype-preserving
      // projection clone (position + projected weapon) used for highlight range,
      // but the live entity is what the rest of the planning flow expects.
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

    this.renderer.setSelection({ entityId: entity.id, hex: { col: entity.col, row: entity.row } });
    this.renderer.clearOverlaysByLayer('highlight-disc');

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

  /** Return the equipped weapon id projected for an entity after its plan runs
   *  (reflects a queued EQUIP_WEAPON switch), or null if no ghost steps exist. */
  _getProjectedWeaponId(entityId) {
    const steps = this.renderer?.planGhostSteps;
    if (!steps || steps.length === 0) return null;
    return steps[steps.length - 1].weapons?.get?.(entityId) ?? null;
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
      if (!e.alive || e.owner !== ownerFilter || e.isNpc) return false;
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
    this._unitStatsExpanded    = false;
    this.renderer.setSelection({ entityId: null, hex: null });
    this.renderer.clearOverlaysByLayer('highlight-disc');
    // Republish the unit info cards — with no selection the odds vanish
    // (planned-attack markers stay; they track the plan, not the selection).
    this._pushUnitInfoCards();
    hideActionPopup(this);
    this._hideTileDetail();
    // Refresh plan panel so selection highlight clears from the unit rows.
    if (this._planMode) {
      this._renderPlanPanel();
      this._refreshUndoButtons();
    }
  }

  /**
   * Publish a movement/battle target overlay (layer `highlight-disc`) under a
   * stable id. Empty target lists remove the id so no stale overlay lingers.
   * Replaces the legacy colour-sniffed `renderer.highlightHexes = [...]` writes.
   */
  _setTargetOverlay(id, color, targets) {
    const hexes = (targets ?? []).map(t => ({ col: t.col, row: t.row }));
    if (hexes.length === 0) { this.renderer.removeOverlay(id); return; }
    this.renderer.setOverlay(id, makeOverlay({
      id, kind: 'fill', layer: 'highlight-disc', hexes, style: { color },
    }));
  }

  /** Clear every move/battle/battle-hex target overlay (the `highlight-disc` layer). */
  _clearTargetOverlays() {
    this.renderer.clearOverlaysByLayer('highlight-disc');
  }

  // ── Unit info cards (hit/crush % + planned-attack marker) ────────────────
  //
  // Per-unit planning info rendered by the 3D renderer INTO the unit icon
  // billboard (now a 2:1 card — see paintUnitIconBadge): attack odds in the
  // left margin, the planned-attack ⚔/×N marker in the right margin. Drawn
  // as part of the billboard so it anchors and scales with the unit instead
  // of swimming like a DOM overlay.

  /**
   * Desired per-entity card info:
   *   - hit/crush odds for every enemy the SELECTED unit could attack
   *     (the red-highlighted targets), per entity — defenders sharing a hex
   *     each get their own numbers.
   *   - planned-attack counts for every enemy targeted by a queued
   *     BATTLE_UNIT anywhere in the plan (independent of selection).
   * @returns {Map<entityId, {hitPct:number|null, crushPct:number|null, attackCount:number}>}
   */
  _computeUnitInfoCards() {
    const cards = new Map();
    if (!this._planMode || this._planSubmitted) return cards;

    const actor = this._selectedEntity;
    const { actionType } = this._awaitingTarget || {};
    const oddsMode = !actionType || actionType === ActionType.MOVE || actionType === ActionType.BATTLE;
    if (actor && !this._isEnemySelection && oddsMode) {
      const b = this._validActions.find(a => a.type === ActionType.BATTLE);
      let targets = b?.targets ?? [];
      if (targets.length && this.state.fogOfWar !== 'none') {
        const visHexes = getVisiblePositions(this.state, actor.owner);
        targets = targets.filter(t => visHexes.has(hexKey(t.col, t.row)));
      }
      // Odds show only for enemies the unit could attack from where its plan
      // LEAVES it — a queued move out of range hides the percentages (and a
      // deselect clears them: no actor → this branch never runs). Range is read
      // from the weapon the plan LEAVES equipped (a queued ranged→melee switch
      // shrinks the reach), not the live weapon.
      const projPos = this._getProjectedPos(actor.id) ?? { col: actor.col, row: actor.row };
      const projWeapon = this._getProjectedWeaponId(actor.id);
      const rangeSrc = (projWeapon && projWeapon !== actor.getEquippedWeaponId())
        ? applyProjectedEquip(actor, projWeapon) : actor;
      const range = rangeOf(rangeSrc);
      targets = targets.filter(t =>
        hexDistance(projPos.col, projPos.row, t.col, t.row) <= range);
      for (const t of targets) {
        const odds = this._attackOdds(actor, t);
        if (!odds) continue;
        cards.set(t.id, {
          hitPct:   Math.round(odds.hit * 100),
          crushPct: Math.round(odds.crush * 100),
          attackCount: 0,
        });
      }
    }

    // Planned-attack counts across the whole plan (BATTLE_UNIT only —
    // BATTLE_HEX has no unit to pin the marker on and keeps the renderer's
    // per-hex fallback badge).
    for (const [, queue] of this._unitPlans) {
      for (const a of queue) {
        if (a.type !== PlanActionType.BATTLE_UNIT || !a.targetId) continue;
        let card = cards.get(a.targetId);
        if (!card) { card = { hitPct: null, crushPct: null, attackCount: 0 }; cards.set(a.targetId, card); }
        card.attackCount++;
      }
    }
    return cards;
  }

  /** Publish the card info to the renderer (call on selection/plan changes). */
  _pushUnitInfoCards() {
    if (!this.renderer) return;
    this.renderer.unitInfoCards = this._computeUnitInfoCards();
  }

  _updateHighlights() {
    this._clearTargetOverlays();
    this._pushUnitInfoCards();
    if (!this._selectedEntity) return;

    const { actionType } = this._awaitingTarget || {};
    if (!actionType || actionType === ActionType.MOVE) {
      const a = this._validActions.find(a => a.type === ActionType.MOVE);
      if (a) this._setTargetOverlay('move-targets', 'rgba(60,220,80,0.22)', a.targets);
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
        this._setTargetOverlay('battle-targets', 'rgba(220,60,60,0.55)', visTargets);
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
        this._setTargetOverlay('battle-targets', 'rgba(220,60,60,0.55)', visTargets);
      }
    } else if (actionType === ActionType.BATTLE_HEX) {
      // Highlight all adjacent non-river hexes as potential targets
      this._setTargetOverlay('battle-hex-targets', 'rgba(220,120,40,0.50)',
        this._awaitingTarget.hexTargets ?? []);
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
      this.renderer.clearOverlaysByLayer('highlight-disc');

      // Add to plan queue (only reachable in planning mode)
      this._addToPlan({ type: PlanActionType.MOVE, entityId: actor.id, toCol: hex.col, toRow: hex.row });
      // Normally re-select the actor so further moves chain (multi-hop advance).
      // The tutorial sets a one-shot suppress flag for the move that COMPLETES a
      // gated step, so that move deselects instead — the next click then reliably
      // selects the next scripted unit rather than moving this one again (the
      // allowlist blocks clicking empty ground to deselect by hand).
      if (actor.alive && this._tutorialSuppressReselect) {
        this._tutorialSuppressReselect = false;
        this._clearSelection();
      } else if (actor.alive) {
        this._selectEntity(actor);
      } else {
        this._clearSelection();
      }
      this._updateSidebar();
      this.onRedraw();

    } else if (actionType === ActionType.BATTLE) {
      const battleAction = this._validActions.find(a => a.type === ActionType.BATTLE);
      // All valid targets on the clicked hex
      const targetsAtHex = battleAction?.targets.filter(t => t.col === hex.col && t.row === hex.row) || [];
      if (!targetsAtHex.length) return;

      this._awaitingTarget = null;
      this.renderer.clearOverlaysByLayer('highlight-disc');

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
        this._showDefenderPickerDialog(targetsAtHex, executeFight, actor);
      } else {
        executeFight(targetsAtHex[0]);
      }

    } else if (actionType === ActionType.BATTLE_HEX) {
      this._awaitingTarget = null;
      this.renderer.clearOverlaysByLayer('highlight-disc');

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
      const selHex = this.renderer._selection?.hex ?? null;
      if (this._pendingUnitPick && selHex) {
        originHex = selHex;
      } else {
        const u = pickerUnits[0];
        const ghost = this._planMode ? this._getProjectedPos(u.id) : null;
        originHex = ghost || { col: u.col, row: u.row };
      }
      this._showArcDisambig(pickerUnits, actionTag, originHex);
      return;
    }

    const ownerCheck = this._planMode ? this._planFaction : state.activePlayer;
    if (!entity || entity.owner !== ownerCheck || entity.isNpc || state.gameOver) {
      hideActionPopup(this);
      return;
    }

    // In planning mode use the unit's PROJECTED position (after queued MOVEs) and
    // PROJECTED weapon (after a queued equip) so the arc's available actions and
    // their range reflect what the plan LEAVES the unit as — not the live state.
    // Mirrors _selectEntity; applyProjectedEquip re-parents to Entity.prototype so
    // hasAbility / getAttack / getRange still resolve.
    let effectiveEntity = entity;
    if (this._planMode) {
      const proj          = this._getProjectedPos(entity.id);
      const projWeapon    = this._getProjectedWeaponId(entity.id);
      const posChanged    = proj && (proj.col !== entity.col || proj.row !== entity.row);
      const weaponChanged = projWeapon && projWeapon !== entity.getEquippedWeaponId();
      if (posChanged || weaponChanged) {
        effectiveEntity = applyProjectedEquip(entity, weaponChanged ? projWeapon : null);
        if (posChanged) { effectiveEntity.col = proj.col; effectiveEntity.row = proj.row; }
      }
    }
    const actions = getValidActions(state, effectiveEntity);

    // In planning mode, compute projected inventory after all queued steps so we can
    // disable resource-dependent actions the player can no longer afford.
    const projInv = this._planMode ? computeProjectedInventory(state, interleavePlan(this._unitPlans)) : null;
    // In planning mode, always show actions (budget tracked separately)
    const hasAct  = this._planMode || state.actionsAvailable > 0;

    // Equipping a weapon is free but capped at once per round per unit.
    // Block it when the unit has already equipped this round or already has
    // a weapon-equip queued in its plan (queued as USE_ITEM of a weapon, or
    // an EQUIP_WEAPON action).
    const queuedEquip = (this._unitPlans.get(entity.id) || []).some(a =>
      a.type === PlanActionType.EQUIP_WEAPON ||
      (a.type === PlanActionType.USE_ITEM && ITEMS[a.item]?.kind === 'weapon'));
    const equipBlocked = entity.equippedThisRound || queuedEquip;

    // Build a flat list of arc action descriptors, grouped by category
    // Groups: scout, defense, summon, combat, items
    const arcItems = [];

    for (const action of actions) {
      // Strict tutorial gating: only whitelisted actions appear in the arc menu
      // (move/attack stay available as hex clicks). Null = no restriction.
      if (this.tutorialAllowedActions && !this.tutorialAllowedActions.has(action.type)) continue;
      const dis = !hasAct;
      switch (action.type) {
        case ActionType.MOVE:
        case ActionType.BATTLE:
          break; // handled via hex clicks
        case ActionType.EXPLORE:
          arcItems.push({ group: 'scout', label: 'Explore', fullLabel: 'Explore tile — search for resources, loot, or hidden survivors (1 action)',
            desc: 'Search this tile for resources, loot, or hidden survivors.',
            color: '#7eccd6', dis, cost: 1, attrs: 'data-action="explore"' });
          break;
        case ActionType.SOUND_HORN:
          arcItems.push({ group: 'scout', label: 'Sound Horn', fullLabel: 'Sound Horn — call hidden survivors within 4 hexes, but reveal your position this round (1 action, 1 food)',
            desc: 'Calls hidden survivors within 4 hexes, but reveals your position this round.',
            color: '#7eccd6', dis: !action.affordable || dis, cost: 1, resCost: `1 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.FOOD])}`, attrs: 'data-action="sound_horn"' });
          break;
        case ActionType.GUARD: {
          const charges = action.currentCharges || 0;
          const lbl = charges > 0 ? `Guard +${charges + 1}` : 'Guard';
          arcItems.push({ group: 'defense', label: lbl,
            fullLabel: `${lbl} — strike the first enemy that comes into reach this round (1 action)`,
            desc: 'Hold position and strike the first enemy that comes into reach this round.',
            color: '#8888cc', dis, cost: 1, attrs: 'data-action="guard"' });
          break;
        }
        case ActionType.FORTIFY: {
          const fortInv    = projInv ? projInv.hero : state.inventory.hero;
          const hasMetal   = getItemCountOf(fortInv, ResourceType.METAL) > 0;
          const hasWood    = getItemCountOf(fortInv, ResourceType.WOOD) > 0;
          const cantAfford = projInv ? (!hasMetal && !hasWood) : !action.affordable;
          const hasDoubler = entity.type === EntityType.SURVIVOR && entity.hasAbility(SurvivorAbility.FORTIFY_DOUBLE);
          const tileData   = state.tiles.get(hexKey(entity.col, entity.row));
          const cur        = tileData ? tileData.fortifyLevel : 0;
          const metalGain   = Math.min(MAX_FORTIFY_LEVEL, cur + 2) - cur;
          const doublerGain = Math.min(MAX_FORTIFY_LEVEL, cur + 2) - cur;
          const woodGain    = Math.min(MAX_FORTIFY_LEVEL, cur + 1) - cur;
          const shortLbl = hasMetal ? 'Reinforce Hex' : 'Fortify Hex';
          const fortRes = hasMetal ? `1 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.METAL])}` : `1 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.WOOD])}`;
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
              desc: 'Hits whatever enemy holds the hex when it resolves — works into fog, skips if empty.',
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
            if (getItemCountOf(healPool, ResourceType.HERBS) < 1) healDis = true;
          }
          arcItems.push({ group: 'items', label: 'Heal', fullLabel: action.atFullHp ? 'Already at full HP' : 'Herbs (heal 2D10 HP)',
            desc: action.atFullHp ? 'Already at full HP.' : 'Spend 1 herb to heal this unit 2D10 HP. (1 action)',
            color: '#55cc55', dis: healDis, cost: 1, resCost: `1 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.HERBS])}`,
            attrs: 'data-action="heal"' });
          break;
        }
        case ActionType.USE_ITEM:
          for (const item of action.usable) {
            if (this._planMode && item.item === ResourceType.FOOD) continue;
            let itemDis = dis;
            if (projInv) {
              if (ITEMS[item.item]?.kind !== 'weapon') {
                if (getItemCountOf(projInv.hero, item.item) < 1) itemDis = true;
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
            arcItems.push({ group: 'items', label: w.label,
              fullLabel: equipBlocked ? 'Already equipped this round' : `Equip ${w.label}`,
              desc: equipBlocked ? 'Already equipped a weapon this round.' : `Equip ${w.label}. Free, once per round.`,
              color: '#b0b0b0', dis: dis || equipBlocked, free: true, cost: 0,
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
            desc: ABILITIES[action.ability]?.description ?? '',
            color: '#88eeff', dis: !isFree && dis, free: isFree, cost: isFree ? 0 : 1,
            attrs: `data-action="use_ability" data-ability="${action.ability}"` });
          break;
        }
        case ActionType.SENT_TO:
          // Multiplayer free action on the SURVIVOR — getValidActions only
          // surfaces this when the survivor has a live owning leader AND
          // there's at least one OTHER live leader on the same faction.
          // Clicking opens a radial destination picker (one item per other
          // leader). Free, mirrors USE_ITEM / EQUIP_WEAPON styling.
          arcItems.push({ group: 'items', label: 'Send To…', fullLabel: 'Send To… — hand off to another leader on your faction',
            desc: 'Hand this survivor over to another leader on your faction. Free.',
            color: '#b0b0b0', dis: false, free: true, cost: 0,
            attrs: 'data-action="sent_to"' });
          break;
      }
    }

    // Show every summon type that the entity's CONCRETE faction allows
    // (Witch / Necromancer: all three; Brute: minion only). Greyed out
    // when unaffordable. Stays gated on a SUMMON or GUARD valid action so
    // the panel doesn't surface summons during off-turn views.
    if (isLeaderType(entity.type) && entity.owner === 'witch' && actions.some(a => a.type === ActionType.SUMMON || a.type === ActionType.GUARD)) {
      const projWitch = projInv ? projInv.witch : state.inventory.witch;
      const projMetal = getItemCountOf(projWitch, ResourceType.METAL);
      const projWood  = getItemCountOf(projWitch, ResourceType.WOOD);
      const projTotal = totalItemCount(projWitch);
      // Probe with a "rich enough" inventory so we get the full allowed-
      // summon set for this faction even when the actual inventory is empty
      // (we still want to show greyed-out unaffordable options, so the
      // player understands what's possible to summon eventually).
      const allowedSummons = new Set(
        concreteFactionOf(entity)
          .getSummonOptions({ [ResourceType.METAL]: { count: 99 }, [ResourceType.WOOD]: { count: 99 } })
          .map(o => o.summonType)
      );
      const ALL_SUMMONS = [
        { st: EntityType.IRON_GOLEM, label: 'Summon Iron Golem',  full: 'Summon Iron Golem (2 metal)',  afford: projMetal >= 2, res: `2 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.METAL])}` },
        { st: EntityType.WOOD_GOLEM, label: 'Summon Wood Golem', full: 'Summon Wood Golem (2 wood)',   afford: projWood >= 2, res: `2 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.WOOD])}` },
        { st: EntityType.MINION,     label: 'Summon Minion',      full: 'Summon Minion (2 any resource)', afford: projTotal >= 2, res: '2 res' },
      ];
      for (const s of ALL_SUMMONS) {
        if (!allowedSummons.has(s.st)) continue;
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
      // Hover expansion: the description renders below the action name when
      // the box is hovered (CSS .arc-item:hover .arc-item-desc). Falls back
      // to the fullLabel when it says more than the label itself.
      const desc = item.desc
        ?? (item.fullLabel && item.fullLabel !== item.label ? item.fullLabel : '');
      const descTag = desc ? `<span class="arc-item-desc">${desc}</span>` : '';
      html += `<button class="arc-item${freeCls}"
        style="--arc-x:0px;--arc-y:0px;--arc-delay:${delay}ms;--arc-color:${item.color};--arc-hover:${item.color};--arc-glow:${item.color}33"
        ${disAttr} ${item.attrs}><span class="arc-item-main">${item.label}${resTag}${costTag}</span>${descTag}</button>`;
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
    this._bindArcHoverExpansion(popup);

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

    // Defender picker: per-target odds preview under each portrait.
    const oddsActor = actionTag === 'pick_defender' ? this._pendingDefenderPick?.actor : null;

    for (const u of units) {
      const col        = ENTITY_COLOR[u.type] || '#888';
      const portraitId  = u.type === 'survivor' ? Renderer.survivorAssetId(u.title) : u.type;
      const src         = portraitId ? this.renderer.getPortraitDataURL(portraitId) : null;
      const pct         = u.maxHp > 0 ? u.hp / u.maxHp : 0;
      const hpColor     = pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ff9800' : '#f44336';

      const imgHtml = src
        ? `<img class="arc-portrait-img" src="${src}">`
        : `<div class="arc-portrait-img" style="display:flex;align-items:center;justify-content:center;font-size:var(--fs-md);background:rgba(20,16,32,0.8);">${u.displayName.charAt(0)}</div>`;

      const atkCount = attacksPerTarget.get(u.id) ?? 0;
      const badgeHtml = atkCount > 0
        ? `<span class="arc-portrait-badge">\u00d7${atkCount}</span>`
        : '';

      const odds = oddsActor ? this._attackOdds(oddsActor, u) : null;
      const oddsHtml = odds
        ? `<span class="arc-portrait-odds">${Math.round(odds.hit * 100)}%</span>`
        : '';

      arcItems.push({
        group: 'disambig',
        label: `<div class="arc-portrait-img-wrap">${imgHtml}${badgeHtml}</div><div class="arc-portrait-hp"><div class="arc-portrait-hp-fill" style="width:${(pct * 100).toFixed(0)}%;background:${hpColor};"></div></div><span class="arc-portrait-name">${u.displayName}${levelPillHtml(u.level)}</span>${oddsHtml}`,
        fullLabel: odds
          ? `${u.displayName} — HP ${u.hp}/${u.maxHp} — ${this._formatOddsText(odds)}`
          : `${u.displayName} — HP ${u.hp}/${u.maxHp}`,
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
      html += `<button class="arc-item${portraitCls}${canvasCls}"
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
      const projMetal = getItemCountOf(projWitch, ResourceType.METAL);
      const projWood  = getItemCountOf(projWitch, ResourceType.WOOD);
      const projTotal = totalItemCount(projWitch);
      const affordable = st === EntityType.IRON_GOLEM ? projMetal >= 2
        : st === EntityType.WOOD_GOLEM ? projWood >= 2
        : projTotal >= 2;
      btn.disabled = !affordable;
    });
    popup.querySelectorAll('.arc-item[data-action="fortify"]').forEach(btn => {
      const shared = projInv.hero;
      const hasMetal = getItemCountOf(shared, ResourceType.METAL) > 0;
      const hasWood  = getItemCountOf(shared, ResourceType.WOOD) > 0;
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
      const clickedTile = this.state.tiles.get(hexKey(tileSelection.col, tileSelection.row));
      if (!clickedTile) { bar.style.display = 'none'; return; }
      // If the clicked tile is a building's footprint hex (the impassable cell
      // that carries the visible model), resolve up to the entrance tile so
      // the player sees the BUILDING they pointed at, not the bare ground
      // underneath. The entrance is the canonical "building tile".
      let tile = clickedTile;
      let displayCol = tileSelection.col;
      let displayRow = tileSelection.row;
      if (clickedTile.buildingFootprintOf) {
        const entranceTile = this.state.tiles.get(clickedTile.buildingFootprintOf);
        if (entranceTile) {
          tile = entranceTile;
          displayCol = entranceTile.col;
          displayRow = entranceTile.row;
        }
      }
      const nodeBadge = buildNodeBadgeHtml(this.state.witchObjectives, this.state.entities, displayCol, displayRow);
      const terrainBadge = _buildTerrainBadge(tile, nodeBadge);
      const TERRAIN_ICON = {
        [TileType.GRASS]: ICON.grass, [TileType.FOREST]: ICON.forest, [TileType.DIRT]: ICON.dirt,
        [TileType.ROAD]: ICON.road, [TileType.RIVER]: ICON.river, [TileType.BRIDGE]: ICON.bridge,
      };
      const icon = tile.building ? (BUILDING_ICON[tile.building] ?? ICON.shelter) : (TERRAIN_ICON[legacyTileType(tile)] ?? ICON.grass);
      const label = tile.building ? (BUILDING_LABEL[tile.building] ?? 'Building') : (legacyTileType(tile) ?? 'terrain');
      const tileSrc = this.renderer.getTileDataURL(tile, displayCol, displayRow, 56);
      const tileImgHtml = tileSrc
        ? `<img class="usb-terrain-hex" src="${tileSrc}" alt="">`
        : `<span class="usb-icon" style="background:#3a4a3a;font-size:var(--fs-md)">${icon}</span>`;
      bar.style.display = 'flex';
      bar.classList.remove('usb-expanded');
      bar.innerHTML = `
        <div class="usb-main">
          ${tileImgHtml}
          <span class="usb-tile-info">
            <span class="usb-tile-name">${label}</span>
            <span class="usb-tile-details">${terrainBadge}</span>
          </span>
          <button class="usb-deselect-btn" title="Deselect">×</button>
        </div>
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
      hero: '\uE000', witch: '\uE001', survivor: '\uE002', soldier: '\uE003',
      zombie: '\uE005', minion: '\uE004', wood_golem: '\uE006', iron_golem: '\uE007',
    };
    const COLORS = {
      hero: '#d4a72c', witch: '#9b59b6', survivor: '#4caf7d', soldier: '#3f78c4',
      zombie: '#7c9a57', minion: '#c0392b', wood_golem: '#8B5E3C', iron_golem: '#607D8B',
    };

    const glyph = GLYPHS[entity.type] ?? '?';
    const color = entity.color ?? COLORS[entity.type] ?? '#d4c9b0';
    const hpPct = Math.max(0, Math.min(100, (entity.hp / entity.maxHp) * 100));
    const hpColor = hpPct > 60 ? '#4caf7d' : hpPct > 30 ? '#f5c842' : '#c0392b';
    // Equipped weapon — use the registry label (carries icon + bonus + range,
    // e.g. "🏹 Bow (range 3)"). Range is weapon-derived, so an unarmed unit
    // is melee (range 1).
    const equippedWeaponId = getEquippedWeaponIdOf(entity.items);
    const weaponLabel = equippedWeaponId
      ? (WEAPON_LABEL[equippedWeaponId] || equippedWeaponId)
      : '\uE08C Unarmed';
    const effectsHtml = buildEffectsHtml(entity);

    // XP bar — campaign veterancy progress, shown beneath the HP bar. Gated on
    // the SAME chokepoint awardXP() uses (state.isCampaign && hero ownership),
    // so non-campaign games and witch / non-levelling units render no bar at
    // all (not "0/0", not greyed — absent). Reuses the campaign-screen
    // xpProgress() formatter so the in-mission and between-mission numbers
    // always agree; distinct blue fill (the established XP colour) keeps it from
    // reading as a second HP stripe.
    let xpRowHtml = '';
    if (this.state.isCampaign && entity.owner === 'hero') {
      const { level, into, span, pct } = xpProgress(entity.level, entity.xp);
      xpRowHtml = `
        <span class="usb-xp-wrap" title="Veterancy — earn XP from exploring, fortifying and combat to level up">
          <span class="usb-stat">Lv <span class="usb-stat-val">${level}</span></span>
          <span class="usb-hp-track usb-xp-track">
            <span class="usb-xp-fill" style="width:${pct}%"></span>
          </span>
          <span class="usb-stat-val">${into}/${span} XP</span>
        </span>`;
    }

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

    // Terrain box for the entity's current hex — stacked full-width below the unit row
    const entCol = this._planMode ? (this._getProjectedPos(entity.id)?.col ?? entity.col) : entity.col;
    const entRow = this._planMode ? (this._getProjectedPos(entity.id)?.row ?? entity.row) : entity.row;
    const tile = this.state.tiles.get(hexKey(entCol, entRow));
    let terrainBoxHtml = '';
    if (tile) {
      const tileSrc = this.renderer.getTileDataURL(tile, entCol, entRow, 56);
      const tileImgHtml = tileSrc ? `<img class="usb-terrain-hex" src="${tileSrc}" alt="">` : '';
      const nodeBadge = buildNodeBadgeHtml(this.state.witchObjectives, this.state.entities, entCol, entRow);
      terrainBoxHtml = `<div class="usb-terrain-box">${tileImgHtml}${_buildTerrainBadge(tile, nodeBadge)}</div>`;
    }

    // Expanded block: ATK, DEF, and any ability description — toggled by the (i) glyph
    const expanded = !!this._unitStatsExpanded;
    const abilityHtml = entity.abilityLabel
      ? `<span class="usb-ability">\uE062 ${entity.abilityLabel}</span>`
      : '';
    const expandedBlockHtml = expanded
      ? `<span class="usb-extra">
           <span class="usb-stat">ATK <span class="usb-stat-val">${entity.getAttack()}</span></span>
           <span class="usb-stat">DEF <span class="usb-stat-val">${entity.getDefense()}</span></span>
           <span class="usb-stat">RNG <span class="usb-stat-val">${entity.getRange()}</span></span>
           <span class="usb-stat" title="Agility — higher acts earlier each turn">AGI <span class="usb-stat-val">${entity.getAgility()}</span></span>
           ${abilityHtml}
         </span>`
      : '';

    bar.style.display = 'flex';
    bar.classList.toggle('usb-expanded', expanded);
    bar.innerHTML = `
      <div class="usb-main">
        ${cyclePrevHtml}
        ${portraitHtml}
        ${cycleNextHtml}
        <span class="usb-info">
          <span class="usb-name" style="color:${color}">${entity.displayName}${levelPillHtml(entity.level)}</span>
          <span class="usb-details">
            <span class="usb-hp-wrap">
              <span class="usb-stat">HP</span>
              <span class="usb-hp-track">
                <span class="usb-hp-fill" style="width:${hpPct}%;background:linear-gradient(to bottom,rgba(255,255,255,0.28) 0%,rgba(255,255,255,0) 55%),${hpColor}"></span>
              </span>
              <span class="usb-stat-val">${entity.hp}/${entity.maxHp}</span>
            </span>
            <span class="usb-weapon">${weaponLabel}</span>
            ${effectsHtml}
            <button class="usb-info-btn ${expanded ? 'usb-info-btn-active' : ''}" title="${expanded ? 'Hide stats' : 'Show stats & abilities'}">i</button>
          </span>
          ${xpRowHtml}
          ${expandedBlockHtml}
        </span>
        <button class="usb-deselect-btn" title="Deselect unit">×</button>
      </div>
      ${terrainBoxHtml}
    `;
    bar.querySelector('.usb-deselect-btn').addEventListener('click', () => {
      this._clearSelection();
      this._updateSidebar();
      this.onRedraw();
    });
    bar.querySelector('.usb-cycle-prev')?.addEventListener('click', () => this._cycleSelection(-1));
    bar.querySelector('.usb-cycle-next')?.addEventListener('click', () => this._cycleSelection(+1));
    bar.querySelector('.usb-info-btn')?.addEventListener('click', () => {
      this._unitStatsExpanded = !this._unitStatsExpanded;
      this._renderUnitStatsBar();
    });
  }

  _renderTurnInfo() {
    const state = this.state;
    const el    = this._el('turn-info');
    if (!el) return;

    // Derive cycle steps from custom cycleConfig or use the default 8-step cycle
    const cyclePhases = state.cycleConfig?.phases ?? DEFAULT_CYCLE_PHASES;
    const CYCLE_STEPS = cyclePhases.map(p => ({ phase: p, ...PHASE_META[p] }));

    const cycleLen     = CYCLE_STEPS.length;
    const roundInCycle = (state.round - 1) % cycleLen;
    const cycle        = Math.ceil(state.round / cycleLen);
    const nonLooping   = !!(state.cycleConfig && !state.cycleConfig.loop);
    const roundLabel   = nonLooping
      ? `Round ${Math.min(state.round, cyclePhases.length)} of ${cyclePhases.length}`
      : `Day ${cycle} · Round ${roundInCycle + 1}`;

    // For a non-looping (fixed-end) cycle the clamped phase past the end stays the
    // final phase — show the deadline phase + round once we reach/overshoot it so
    // the icon/label match the countdown track rather than a stale modulo step.
    const stepIdx    = nonLooping ? Math.min(roundInCycle, cycleLen - 1) : roundInCycle;
    const activeStep = CYCLE_STEPS[stepIdx];
    const bumpEl   = this._el('cycle-bump');
    const iconEl   = this._el('cycle-bump-icon');
    const labelEl  = this._el('cycle-bump-label');
    if (bumpEl && activeStep) {
      bumpEl.className = `phase-${activeStep.phase}`;
    }
    if (iconEl && activeStep) {
      const imgSrc = this.renderer?.getPortraitDataURL?.(activeStep.sprite, 64);
      if (imgSrc) iconEl.src = imgSrc;
      iconEl.alt = activeStep.label;
    }
    if (labelEl && activeStep) {
      labelEl.textContent = `${activeStep.label} — ${roundLabel}`;
    }

    // Deadline countdown — only for non-looping (fixed-end) missions. Normal /
    // looping games leave this hidden so their cycle bar is visually unchanged.
    const deadlineEl  = this._el('cycle-deadline');
    const countEl     = this._el('cycle-deadline-count');
    const trackEl     = this._el('cycle-deadline-track');
    if (deadlineEl) {
      const cd = buildCycleDeadlineHtml(state);
      if (cd) {
        deadlineEl.hidden = false;
        if (countEl)  countEl.textContent  = cd.countLabel;
        if (trackEl)  trackEl.innerHTML     = cd.trackHtml;
        if (bumpEl)   bumpEl.title          = `Mission ends at ${cd.deadlinePhase} (round ${cd.total})`;
      } else {
        deadlineEl.hidden = true;
        if (trackEl) trackEl.innerHTML = '';
      }
    }

    // ── Header title — exactly three canonical states ─────────────────────
    // PLANNING (building a plan) · WAITING FOR OPPONENTS (plan locked, online)
    // · RESOLUTION (the round resolving / being replayed). The menu button
    // (top-left) is a header sibling and stays put across all three; the
    // Submit / Last Turn buttons live in .header-buttons and are gated to the
    // PLANNING state by _renderEndTurnBtn.
    const titleState = headerTitleState({
      planMode: this._planMode, planSubmitted: this._planSubmitted,
    });

    if (titleState === 'PLANNING') {
      // Title + action-budget pips: colour-coded pips with a hover/tap tooltip
      // breakdown. The budget anchors right (above the plan panel).
      const used = interleavePlan(this._unitPlans).filter(a => actionCosts(a.type)).length;
      const { parts, rows, total, foodLabel } = this._computeActionBudget();
      const pips = buildActionPipsHtml(parts, used);
      const tip  = buildActionBudgetTooltipHtml(rows, total, foodLabel);
      el.innerHTML = `
        <span class="turn-title">Planning</span>
        <div class="action-budget">
          <span class="actions-label">Action Budget</span>
          <div class="actions-remaining" tabindex="0" aria-label="Action budget breakdown">${pips}<div id="budget-breakdown" class="budget-breakdown">${tip}</div></div>
        </div>
      `;
      const pipsEl = el.querySelector('.actions-remaining');
      if (pipsEl) pipsEl.addEventListener('click', (e) => { e.stopPropagation(); this._toggleBudgetTip(pipsEl); });
      return;
    }

    if (titleState === 'WAITING') {
      el.innerHTML = `<span class="turn-title">Waiting for Opponents…</span>`;
      return;
    }

    // RESOLUTION — the round is resolving or being replayed. Also covers the
    // offline round summary, the online summary/sync window, and AI-vs-AI
    // auto-play. Keep the online state-recovery watchdog: a PLANNING appMode
    // reached here means our planning payload never arrived, so request a
    // resync (and bail to menu if it never recovers).
    if (this.mp && this.appMode === 'PLANNING' && !this._stateRecoveryPending) {
      this._stateRecoveryPending = true;
      // Delay before requesting state — gives enterPlanningMode time to fire.
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
    el.innerHTML = `<span class="turn-title">Resolution</span>`;
  }

  _renderObjectives() {
    const bar  = this._el('score-bar');
    const bump = this._el('cycle-bump');
    const state = this.state;

    // Toggle cycle-bump independently of scoring — campaign missions
    // typically suppress score points but still want the day/night
    // tracker visible.
    if (bump) {
      bump.style.display = state.disableCycleBar ? 'none' : '';
    }

    // When scoring is disabled and the cycle bar is also disabled, the
    // bottom bar has no content — hide it entirely. When only scoring is
    // disabled, keep the bar (the cycle-bump anchors to its top edge) but
    // strip its inner score content via the .cycle-only class.
    if (bar) {
      if (state.disableScoring && state.disableCycleBar) {
        bar.style.display = 'none';
        return;
      }
      bar.style.display = '';
      bar.classList.toggle('cycle-only', !!state.disableScoring);
      if (state.disableScoring) {
        return;
      }
    }

    const el = this._el('score-bar-content');
    if (!el) return;
    const { html } = buildObjectivesHtml(
      state.witchObjectives, state.entities, state.nodeScore, state.gameMode,
    );
    el.innerHTML = html;
  }

  // ── Cycle & scoring info panel ──────────────────────────────────────────
  // Game-styled popup opened by tapping the bottom score bar / day-cycle
  // pill (replaces the native title tooltips there). Toggles; dismisses on
  // any outside tap.

  _showCycleInfoPopup() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('cycle-info-popup')) { this._dismissCycleInfoPopup(); return; }
    if (!this.state) return;
    const el = document.createElement('div');
    el.id = 'cycle-info-popup';
    // Use the game's cycle sprites for the phase icons (emoji is only the
    // fallback while the tilemap is still loading).
    const icons = {};
    for (const [phase, meta] of Object.entries(PHASE_META)) {
      const src = this.renderer?.getPortraitDataURL?.(meta.sprite, 64);
      if (src) icons[phase] = src;
    }
    el.innerHTML = buildCycleInfoHtml(this.state, icons);
    document.body.appendChild(el);
    this._cycleInfoDismiss = (e) => {
      if (el.contains(e.target)) return;
      // Clicks on the bar/pill toggle via their own handlers — the capture-
      // phase dismisser must not race them (it fired first and re-opened).
      if (this._el('score-bar')?.contains?.(e.target)) return;
      this._dismissCycleInfoPopup();
    };
    setTimeout(() => {
      if (document.getElementById('cycle-info-popup')) {
        document.addEventListener('click', this._cycleInfoDismiss, true);
      }
    }, 0);
  }

  _dismissCycleInfoPopup() {
    if (typeof document === 'undefined') return;
    document.getElementById('cycle-info-popup')?.remove();
    if (this._cycleInfoDismiss) {
      document.removeEventListener('click', this._cycleInfoDismiss, true);
      this._cycleInfoDismiss = null;
    }
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
    // Last Turn (↺) lives in the header during PLANNING only, and only once a
    // prior round exists to replay (i.e. not turn 1). Hidden while waiting for
    // opponents and throughout RESOLUTION so those states are title-only.
    const replayBtn = this._el('replay-turn-btn');
    if (replayBtn) {
      const showReplay = this._planMode && !this._planSubmitted && this._hasReplayHistory;
      replayBtn.style.display = showReplay ? '' : 'none';
    }

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
      // WAITING FOR OPPONENTS — a title-only state. Hide the submit button AND
      // the return-to-menu (← Menu) button: the top-left menu (☰) is the single,
      // consistent exit across all three header states.
      btn.style.display = 'none';
      if (returnBtn) returnBtn.style.display = 'none';
    } else {
      // During planning: show submit, hide return-to-menu
      btn.style.display = '';
      btn.disabled = state.gameOver;
      btn.classList.toggle('urgent', !state.gameOver);
      btn.classList.add('planning-active');
      btn.dataset.tip = 'Lock in your plan — it resolves alongside your opponent’s';
      if (!this._countdownTimer && !this._graceActive) {
        btn.textContent = '\uE071 Submit';
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
        this.renderer.clearOverlaysByLayer('highlight-disc');
      }
      this._updateSidebar();
      this.onRedraw();
      return;
    }

    if (action === 'pick_unit') {
      this._pendingDisambig = null;
      const unit = state.entities.find(e => e.id === button.dataset.unitId);
      // Strict tutorial gating: the disambiguation picker still shows BOTH units
      // (the player learns to choose), but only the scripted unit may actually be
      // picked — the hero, not the townsperson sharing the hex. Picking the wrong
      // one re-shows the picker so the player tries again rather than stalling.
      if (unit && this.tutorialAllowedUnits && !this.tutorialAllowedUnits.has(unit.type)) {
        if (this._pendingUnitPick) this._showActionPopup(null);
        return;
      }
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
      this.renderer.clearOverlaysByLayer('highlight-disc');

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
        this._clearTargetOverlays();
        this._setTargetOverlay('battle-hex-targets', 'rgba(220,120,40,0.50)', hexTargets);
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
        const item = button.dataset.item;
        // Weapon equip is once-per-round per unit. Guard the click in case a
        // disabled button is reached, and explain why.
        if (ITEMS[item]?.kind === 'weapon') {
          const alreadyQueued = (this._unitPlans.get(entity.id) || []).some(a =>
            a.type === PlanActionType.EQUIP_WEAPON ||
            (a.type === PlanActionType.USE_ITEM && ITEMS[a.item]?.kind === 'weapon'));
          if (entity.equippedThisRound || alreadyQueued) {
            this._showPlanToast(`${entity.displayName} can only equip a weapon once per round.`);
            break;
          }
        }
        this._addToPlan({ type: PlanActionType.USE_ITEM, entityId: entity.id, item });
        delayedHide();
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar(); this.onRedraw(); break;
      }

      case 'use_ability': {
        const abilityId = button.dataset.ability || null;
        this._addToPlan({ type: PlanActionType.USE_ABILITY, entityId: entity.id, ability: abilityId });
        delayedHide();
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar(); this.onRedraw(); break;
      }

      case 'sent_to': {
        // Open the Send To destination picker — a radial action arc with
        // one item per OTHER leader on this survivor's faction. Clicking
        // an item queues a free SENT_TO action on the survivor.
        this._openSentToPicker(entity);
        break;
      }

      case 'sent_to_pick': {
        // Radial destination item was clicked — payload carries the
        // destination leader's ownerId. The actor (entityId) is the
        // SURVIVOR; the sender leader is re-derived live at resolution.
        const destOwnerId = button.dataset.destOwnerId;
        if (destOwnerId) {
          this._addToPlan({
            type: PlanActionType.SENT_TO,
            entityId: entity.id,
            destOwnerId,
          });
        }
        hideActionPopup(this);
        if (entity.alive) this._selectEntity(entity);
        else this._clearSelection();
        this._updateSidebar(); this.onRedraw(); break;
      }
    }
  }

  // ── Send To destination picker ─────────────────────────────────────────────
  // Renders a RADIAL action arc (same component the unit action menu uses)
  // with one item per destination leader on the actor's faction. Items are
  // colour-coded with the destination LEADER's player color via
  // GameState.playerColorFor — same source the renderer and chronicle use.
  _openSentToPicker(actor) {
    const popup = this._el('action-popup');
    if (this._arcCloseTimer) { clearTimeout(this._arcCloseTimer); this._arcCloseTimer = null; }
    // Stay in arc mode — drop list-mode styling and any prior arc-open class
    // so the open animation re-triggers cleanly.
    popup.classList.remove('arc-open', 'arc-closing', 'popup-list-mode');
    this._popupVisible = true;

    const state = this.state;
    const validActions = getValidActions(state, actor);
    const sentTo = validActions.find(a => a.type === ActionType.SENT_TO);
    if (!sentTo || (sentTo.destinations?.length ?? 0) === 0) {
      // No eligible destinations — surface a "nothing to do" list popup
      // rather than an empty arc. Defensive: getValidActions should already
      // have hidden the parent action, but this keeps the UI honest.
      popup.classList.add('popup-list-mode');
      popup.innerHTML = `<div class="popup-unit-name">No destination leader</div>`;
      positionPopup(popup, this);
      popup.style.display = 'block';
      return;
    }

    // Build one radial item per destination leader, coloured with the
    // destination leader's player color (so the picker mirrors the colour
    // the recipient is rendered with on the map).
    const arcItems = sentTo.destinations.map((dest, i) => {
      const color = state.playerColorFor(dest.leader) ?? '#b0b0b0';
      const destName = dest.name ?? dest.leader.displayName ?? 'Leader';
      return {
        group: 'sent_to_dest',
        label: destName,
        fullLabel: `Send to ${destName}`,
        desc: `Hand off to ${destName}. Free, no action cost.`,
        color,
        dis: false,
        free: true,
        cost: 0,
        attrs: `data-action="sent_to_pick" data-dest-owner-id="${dest.ownerId}"`,
        _idx: i,
      };
    });

    // Position the arc relative to the survivor (or its planned/ghost
    // position) so it visually radiates from the actor — matches the way
    // the standard unit-action arc opens.
    let arcOriginEntity = actor;
    if (this._planMode) {
      const proj = this._getProjectedPos(actor.id);
      if (proj && (proj.col !== actor.col || proj.row !== actor.row)) {
        arcOriginEntity = Object.setPrototypeOf(
          { ...actor, col: proj.col, row: proj.row },
          Object.getPrototypeOf(actor)
        );
      }
    }
    const screenPos = getEntityScreenPos(this, arcOriginEntity);
    if (!screenPos) {
      // Fallback to a positioned list popup if we can't compute a screen
      // position (e.g. off-canvas) — keeps the action reachable.
      popup.classList.add('popup-list-mode');
      let html = `<div class="popup-unit-name">Send To…</div>`;
      for (const dest of sentTo.destinations) {
        const color = state.playerColorFor(dest.leader) ?? '#b0b0b0';
        const destName = dest.name ?? dest.leader.displayName ?? 'Leader';
        html += `<button class="plan-btn" style="border-left:3px solid ${color};"
          data-action="sent_to_pick"
          data-dest-owner-id="${dest.ownerId}">${destName}</button>`;
      }
      popup.innerHTML = html;
      positionPopup(popup, this);
      popup.style.display = 'block';
      attachPopupListeners(popup, this);
      return;
    }

    const openRight = screenPos.x < window.innerWidth / 2;
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasScale = canvasRect.width / this.canvas.width;
    const hexScreenPx = this.renderer.hexSize * canvasScale * this.renderer.zoomLevel;

    // Generate arc item HTML — same template as _showActionPopup.
    let html = '';
    for (const item of arcItems) {
      const delay = item._idx * 30;
      const freeCls = ' arc-free';
      const costTag = '<span class="arc-cost arc-cost-free">FREE</span>';
      const descTag = item.desc ? `<span class="arc-item-desc">${item.desc}</span>` : '';
      html += `<button class="arc-item${freeCls}"
        style="--arc-x:0px;--arc-y:0px;--arc-delay:${delay}ms;--arc-color:${item.color};--arc-hover:${item.color};--arc-glow:${item.color}33"
        ${item.attrs}><span class="arc-item-main">${item.label}${costTag}</span>${descTag}</button>`;
    }
    popup.innerHTML = html;

    // Track arc state so pan/zoom keep the popup anchored.
    this._arcEntityCol = arcOriginEntity.col;
    this._arcEntityRow = arcOriginEntity.row;
    this._arcItems = arcItems;
    this._arcOpenRight = openRight;

    positionArcPopup(popup, this);
    popup.style.display = 'block';

    const btns = popup.querySelectorAll('.arc-item');
    for (const btn of btns) {
      btn.style.transition = 'none';
      btn.style.transform = 'translate(-50%, -50%) scale(1)';
      btn.style.opacity = '0';
    }
    popup.offsetHeight; // force layout

    computeArcPositions(popup, this, hexScreenPx);

    for (const btn of btns) {
      btn.style.transform = '';
      btn.style.opacity = '';
      btn.style.transition = '';
    }

    attachPopupListeners(popup, this);
    this._bindArcHoverExpansion(popup);

    requestAnimationFrame(() => {
      popup.classList.add('arc-open');
      this.onRedraw();
    });

    startArcTracking(this);
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

  // Combat-detail modes. Internal keys (cinematic/fast/vfast) are unchanged so
  // all pacing behaviour is preserved; only the player-facing labels differ.
  static SPEED_LABELS = { cinematic: 'Full', fast: 'Summary', vfast: 'Speedy' };
  static SPEED_ORDER = ['cinematic', 'fast', 'vfast'];

  _loadDefaultSpeed() {
    // The combat-detail controls (#replay-detail-btn + the Options "Default
    // Game Speed" section) are HIDDEN for now — we're trialling a single
    // playback presentation. Pin to 'fast' (Summary) and IGNORE the stored
    // preference: with no UI to change it back, a stale saved 'cinematic' /
    // 'vfast' would invisibly lock a player into a mode they can't leave.
    // To restore the feature, un-hide both controls in index.html and revive
    // the localStorage read below.
    return 'fast';
    /* eslint-disable no-unreachable -- kept for easy restoration
    try {
      const saved = localStorage.getItem('brimstone-default-speed');
      if (saved && UIController.SPEED_LABELS[saved]) return saved;
    } catch (_) {  }
    return 'fast';
    */
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
    // The Detail button itself shows the active mode now, so no toast.
    this._applyReplayDetail();
  }

  /** Cycle the combat-detail mode Full → Summary → Speedy → Full. */
  _cycleReplayDetail() {
    const order = UIController.SPEED_ORDER;
    const idx = order.indexOf(this.speedMode);
    this._setSpeed(order[(idx + 1) % order.length]);
  }

  /** Sync the playback "Detail" button label to the current speedMode. */
  _applyReplayDetail() {
    const btn = document.getElementById('replay-detail-btn');
    if (!btn) return;
    const label = UIController.SPEED_LABELS[this.speedMode] ?? 'Full';
    btn.textContent = label;
    btn.dataset.tip = `Combat detail: ${label} — how much each battle pauses to show`;
    btn.className = `replay-ctrl-btn replay-detail detail-${this.speedMode}`;
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
      ? '\uE097 slain'
      : result.hit
        ? result.damage >= 2 ? `${ICON.crush} crush −${result.damage}HP` : `${ICON.hero} hit −${result.damage}HP`
        : result.counterDmg > 0 ? '\uE042 counter' : 'miss';

    const toast = document.createElement('div');
    toast.className = 'battle-toast' +
      (result.killed ? ' kill' : result.damage >= 2 ? ' crush' : '');
    const splashNote = result.splashHits?.length
      ? ` +${ICON.splash}${result.splashHits.length} splashed`
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
      `${ICON.newMoon} The curse deepens — Caleb's Hollow's mystical energy grows stronger!`,
      ``,
      desc,
      `${ICON.night} Night: survivors in the open take ${level} damage`,
    ], () => {});
  }

  // ── Action budget ────────────────────────────────────────────────────────

  /**
   * Itemised action budget for the current planning faction: the source `parts`
   * (for the colour-coded pips), human-readable `rows` (for the tooltip), the
   * capped `total`, and the spare-`food` count. Uses the SAME faction math the
   * game uses for the budget (Faction.computeBudgetBreakdown), so the pips/total
   * always match `_planBudget`.
   */
  _computeActionBudget() {
    const faction    = this._planFaction;
    const factionObj = getFaction(faction);
    const phase      = this.state.phase;
    const phaseIcon  = PHASE_ICON[phase] ?? '';
    const phaseLabel = phase ? phase.charAt(0).toUpperCase() + phase.slice(1) : '';
    const entities   = this.state.entities;
    const stash      = faction === 'hero' ? this.state.inventory?.hero : this.state.inventory?.witch;
    const food       = getItemCountOf(stash, 'food');

    const unitCount = entities.filter(
      e => e.alive && e.owner === faction && e.type !== factionObj.leaderType
    ).length;
    const nodeBonus = countHeldNodes(faction, this.state.witchObjectives ?? [], entities);
    const { parts, total } = factionObj.computeBudgetBreakdown(phase, unitCount, nodeBonus);

    const unitIcon = faction === 'hero' ? ICON.survivor : ICON.minion;
    const unitNoun = faction === 'hero' ? 'Survivor'    : 'Minion';
    const labelFor = (p) => {
      switch (p.key) {
        case 'base':  return 'Base';
        case 'phase': return `${phaseIcon} ${phaseLabel} bonus`;
        case 'unit':  return `${unitIcon} ${unitNoun}${p.value !== 1 ? 's' : ''} (${p.count})`;
        case 'node':  return `◆ Power Node${p.value !== 1 ? 's' : ''} (${p.value})`;
        default:      return p.key;
      }
    };
    const rows = parts.filter(p => p.value > 0).map(p => ({ key: p.key, label: labelFor(p), value: p.value }));
    const foodLabel = food > 0 ? `${coloredResourceIcon('food')} Food ×${food}` : '';
    return { parts, rows, total, food, foodLabel };
  }

  /** Toggle the budget breakdown tooltip open (tap on touch; desktop uses CSS hover). */
  _toggleBudgetTip(pipsEl) {
    const open = pipsEl.classList.toggle('tip-open');
    if (this._budgetDismiss) {
      document.removeEventListener('click', this._budgetDismiss, true);
      this._budgetDismiss = null;
    }
    if (open) {
      this._budgetDismiss = (e) => {
        if (pipsEl.contains(e.target)) return;   // a tap on the pips re-toggles via its own handler
        pipsEl.classList.remove('tip-open');
        document.removeEventListener('click', this._budgetDismiss, true);
        this._budgetDismiss = null;
      };
      document.addEventListener('click', this._budgetDismiss, true);
    }
  }

  /**
   * Render the Mission Log — the live objective checklist at the top of the
   * Chronicle sidebar (it replaced the old static mission-goals header button).
   * `objectives` is the authoritative list from the mission-logic engine
   * (`engine.objectives()`): an ordered array of
   *   { id, label, current, target, completed }
   * This is pure presentation — it READS the engine's state, never writes it
   * (Sim/Show split). The section hides itself until at least one objective is
   * pushed, so non-logic / normal games show no Mission Log at all.
   */
  /** Minimal HTML-escape for user/author text injected into the Mission Log. */
  _escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  renderMissionLog(objectives, description = '') {
    const section = this._el('mission-log-section');
    const list = this._el('mission-log-list');
    if (!section || !list) return;
    const desc = this._el('mission-log-desc');
    const objs = Array.isArray(objectives) ? objectives : [];
    if (objs.length === 0) {
      section.style.display = 'none';
      list.innerHTML = '';
      if (desc) { desc.innerHTML = ''; desc.style.display = 'none'; }
      return;
    }
    section.style.display = '';
    // Mission briefing/description header — ABOVE the objectives (Show: pure,
    // HTML-escaped read of the mission's static description text).
    if (desc) {
      const descHtml = buildMissionLogDescriptionHtml(description);
      desc.innerHTML = descHtml;
      desc.style.display = descHtml ? '' : 'none';
    }
    list.innerHTML = buildMissionLogHtml(objs);
  }

  /**
   * Toast for a Mission Log change (objective added / progressed / completed).
   * Auto-dismisses; presentation-only. `change` ∈ {'added','progress','completed'};
   * `objective` is the changed entry { id, label, current, target, completed }.
   */
  showMissionLogToast({ change, objective } = {}) {
    if (!objective) return;
    let toast = document.getElementById('mission-log-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mission-log-toast';
      toast.className = 'mission-log-toast';
      const wrapper = this._el('canvas-wrapper');
      if (wrapper) wrapper.appendChild(toast);
    }
    const icon = change === 'completed' ? '\uE071'
      : change === 'added' ? '\uE07A'
      : '•';
    const verb = change === 'completed' ? 'Objective complete'
      : change === 'added' ? 'New objective'
      : 'Objective updated';
    const progress = (change !== 'completed' && objective.target != null)
      ? ` (${Math.max(0, objective.current ?? 0)}/${objective.target})`
      : '';
    toast.className = 'mission-log-toast' + (change === 'completed' ? ' completed' : '');
    toast.innerHTML = `<span class="mlt-icon">${icon}</span>`
      + `<span class="mlt-body"><span class="mlt-verb">${verb}</span>`
      + `<span class="mlt-label">${this._escHtml(objective.label ?? '')}${progress}</span></span>`;
    toast.classList.remove('mission-log-toast-out');
    // Force reflow so re-triggering the same toast restarts its animation.
    void toast.offsetWidth;
    clearTimeout(this._missionLogToastTimer);
    this._missionLogToastTimer = setTimeout(() => {
      toast.classList.add('mission-log-toast-out');
    }, 3200);
  }

  /**
   * Show a narrative story modal / beat card (campaign triggers).
   * Returns a Promise that resolves when the player dismisses it.
   *
   * @param {object} [opts]
   * @param {number} [opts.autoDismissMs] Autoplay: auto-advance after this dwell
   *        (a Continue countdown labels the button and auto-clicks at 0; the
   *        operator can click sooner). Omit for the human path — gate on click
   *        forever.
   * @param {object} [opts.gateOpts] Forwarded to runStoryBeatGate (test timers).
   */
  showStoryModal(title, text, opts = {}) {
    return new Promise(resolve => {
      const el = this._el('story-modal');
      if (!el) { resolve(); return; }
      el.querySelector('.story-modal-title').textContent = title;
      el.querySelector('.story-modal-text').textContent = text;
      el.classList.add('visible');
      const btn = this._el('story-modal-continue');
      if (opts.autoDismissMs != null) {
        runStoryBeatGate(btn, { minDwellMs: opts.autoDismissMs, ...(opts.gateOpts ?? {}) })
          .then(() => { el.classList.remove('visible'); resolve(); });
        return;
      }
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

    const GLYPHS = { hero: '\uE000', witch: '\uE001', survivor: '\uE002', soldier: '\uE003', zombie: '\uE005', minion: '\uE004', wood_golem: '\uE006', iron_golem: '\uE007' };
    const glyph  = GLYPHS[encounterUnit.type] ?? '?';
    const color  = encounterUnit.color || '#d4c9b0';

    const assetId = encounterUnit.type === 'survivor'
      ? Renderer.survivorAssetId(encounterUnit.title)
      : encounterUnit.type;
    const src = assetId ? this.renderer.getPortraitDataURL(assetId) : null;

    const portraitHtml = src
      ? `<img src="${src}" style="width:72px;height:72px;border-radius:50%;border:2px solid ${color};display:block;">`
      : `<div style="font-size:var(--fs-2xl);line-height:1;color:${color};width:72px;text-align:center;">${glyph}</div>`;

    const titleHtml = encounterUnit.title
      ? `<div style="font-size:var(--fs-xs);color:#9a8a7a;font-style:italic;margin-bottom:0.25rem;">${encounterUnit.title}</div>`
      : '';

    const abilityHtml = encounterUnit.abilityLabel
      ? `<div style="font-size:var(--fs-xs);color:#88eeff;margin-top:0.3rem;">\uE062 ${encounterUnit.abilityLabel}</div>`
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
          <div style="font-size:var(--fs-base);font-weight:bold;color:${color};margin-bottom:0.12rem;">${glyph} ${encounterUnit.name}</div>
          ${titleHtml}
          <div style="font-size:var(--fs-xs);color:#c8b89a;">HP ${encounterUnit.hp}/${encounterUnit.maxHp} · ATK ${attackOf(encounterUnit)} · DEF ${defenseOf(encounterUnit)}</div>
          <div style="background:#1e1e2a;border-radius:3px;height:5px;margin-top:0.3rem;overflow:hidden;">
            <div style="width:${hpPct}%;height:100%;background:${hpColor};border-radius:3px;"></div>
          </div>
          ${abilityHtml}
        </div>
      </div>
      <div style="font-size:var(--fs-sm);color:#b8a88a;text-align:center;margin-bottom:0.5rem;">${message}</div>
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
    } else if (this.aiAutorun) {
      setTimeout(dismiss, this.aiAutorunDelay);
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
    } else if (this.aiAutorun) {
      setTimeout(dismiss, this.aiAutorunDelay);
    } else if (this.speedMode === 'fast') {
      setTimeout(dismiss, 4000);
    }
  }

  // ── Action-arc hover expansion ────────────────────────────────────────────
  // Hovering an action expands its box in place (description under the name)
  // with the box's TOP-LEFT anchored where it was, and shifts the entries
  // below it down by the height delta so nothing overlaps. JS-driven because
  // sibling re-layout can't be done in CSS: the buttons are individually
  // positioned via --arc-x/--arc-y (centre-anchored transforms).

  _bindArcHoverExpansion(popup) {
    if (typeof window !== 'undefined' && window.matchMedia
        && !window.matchMedia('(hover: hover)').matches) return;
    const btns = [...popup.querySelectorAll('.arc-item:not(.arc-portrait)')];
    // Provide a collapse hook so layout recomputes (zoom) start from a clean
    // un-expanded state instead of clobbering the hover offsets.
    this._collapseArcExpansion = () => {
      for (const b of btns) this._collapseArcItem(b, btns);
    };
    for (const btn of btns) {
      if (!btn.querySelector?.('.arc-item-desc')) continue; // nothing to show
      btn.addEventListener('mouseenter', () => this._expandArcItem(btn, btns));
      btn.addEventListener('mouseleave', () => this._collapseArcItem(btn, btns));
    }
  }

  _expandArcItem(btn, btns) {
    if (btn.classList.contains('arc-expanded')) return;
    // Pre-expansion layout box (offsetWidth/Height ignore the centre transform).
    const w0 = btn.offsetWidth, h0 = btn.offsetHeight;
    const x0 = parseFloat(btn.style.getPropertyValue('--arc-x')) || 0;
    const y0 = parseFloat(btn.style.getPropertyValue('--arc-y')) || 0;
    btn._arcOrig = { x: x0, y: y0 };
    // The size change is instant but the centre-transform would TRANSITION to
    // its compensated position — reading as a jump to an origin point that
    // glides back. Disable the transition so the class change and the centre
    // offset land in the same frame: the top-left never moves, only the
    // bottom and right edges grow.
    btn.style.transition = 'none';
    // When the whole arc menu opened to the LEFT of the unit (near the right
    // screen edge), grow the item box leftward too — otherwise it expands off
    // the right edge / over the unit. `arc-expand-left` right-anchors its
    // content to match. Default to rightward when the side is unknown.
    const openLeft = this._arcOpenRight === false;
    btn.classList.toggle('arc-expand-left', openLeft);
    btn.classList.add('arc-expanded');
    const w1 = btn.offsetWidth, h1 = btn.offsetHeight;
    // Pin one top corner and grow from it: top-left when opening right (centre
    // moves +half the width growth), top-right when opening left (−half).
    const dx = (w1 - w0) / 2;
    btn.style.setProperty('--arc-x', `${(x0 + (openLeft ? -dx : dx)).toFixed(1)}px`);
    btn.style.setProperty('--arc-y', `${(y0 + (h1 - h0) / 2).toFixed(1)}px`);
    btn.offsetHeight; // commit class + vars together before re-enabling
    btn.style.transition = '';
    btn.style.transitionDelay = '0ms';
    // Re-layout the entries below: shift down by the height delta.
    const dh = h1 - h0;
    const idx = btns.indexOf(btn);
    for (let j = idx + 1; j < btns.length; j++) {
      const b = btns[j];
      if (b._arcShift == null) {
        b._arcShift = parseFloat(b.style.getPropertyValue('--arc-y')) || 0;
      }
      b.style.transitionDelay = '0ms';
      b.style.setProperty('--arc-y', `${(b._arcShift + dh).toFixed(1)}px`);
    }
  }

  _collapseArcItem(btn, btns) {
    if (!btn.classList.contains('arc-expanded')) return;
    // Same frame-atomic treatment in reverse — shrink and restore the centre
    // together so the top-left stays pinned on the way back too.
    btn.style.transition = 'none';
    btn.classList.remove('arc-expanded', 'arc-expand-left');
    if (btn._arcOrig) {
      btn.style.setProperty('--arc-x', `${btn._arcOrig.x.toFixed(1)}px`);
      btn.style.setProperty('--arc-y', `${btn._arcOrig.y.toFixed(1)}px`);
      btn._arcOrig = null;
    }
    btn.offsetHeight;
    btn.style.transition = '';
    const idx = btns.indexOf(btn);
    for (let j = idx + 1; j < btns.length; j++) {
      const b = btns[j];
      if (b._arcShift != null) {
        b.style.setProperty('--arc-y', `${b._arcShift.toFixed(1)}px`);
        b._arcShift = null;
      }
    }
  }

  _showDefenderPickerDialog(defenders, onPick, actor = null) {
    this._pendingDefenderPick = { defenders, onPick, actor };
    this._popupVisible = true;
    this._showActionPopup(null);
  }

  /**
   * Exact hit/crush/counter odds for `actor` attacking `target` from the
   * actor's projected planning position. Best-effort: returns null when odds
   * can't be computed (e.g. partial mirror data online) — the preview is
   * advisory, never load-bearing.
   */
  _attackOdds(actor, target) {
    try {
      let effActor = actor;
      if (this._planMode) {
        const proj       = this._getProjectedPos(actor.id);
        const projWeapon = this._getProjectedWeaponId(actor.id);
        const posChanged    = proj && (proj.col !== actor.col || proj.row !== actor.row);
        const weaponChanged = projWeapon && projWeapon !== actor.getEquippedWeaponId();
        // Both the attack modifier AND isRanged are read from the attacker's
        // equipped weapon inside computeBattleContext, so a queued EQUIP_WEAPON
        // must reach the odds source too — not just the range filter in
        // _computeUnitInfoCards. applyProjectedEquip re-parents to Entity.prototype
        // (so getRange/getAttack resolve) and equips the projected weapon on a
        // deep-copied backpack without touching the live entity; the projected
        // position is then re-applied onto that local clone.
        if (posChanged || weaponChanged) {
          effActor = applyProjectedEquip(actor, weaponChanged ? projWeapon : null);
          if (posChanged) { effActor.col = proj.col; effActor.row = proj.row; }
        }
      }
      return computeCombatOdds(this.state, effActor, target);
    } catch (err) {
      console.warn('[ui] odds preview unavailable:', err);
      return null;
    }
  }

  /** "72% hit (18% crush) · 9% counter risk" — omits zero-probability parts. */
  _formatOddsText(odds) {
    if (!odds) return null;
    const pct = p => `${Math.round(p * 100)}%`;
    let s = `${pct(odds.hit)} hit`;
    if (odds.crush > 0.005) s += ` (${pct(odds.crush)} crush)`;
    if (odds.counter > 0.005) s += ` · ${pct(odds.counter)} counter risk`;
    return s;
  }

  _showBattleDialog(actorSnap, targetSnap, result, onDismiss, onRematch = null) {
    // Combat audio fires from _playBattleResultAnims (main.js) — the one
    // point every display path (2D dialog, toast, 3D card-hold) funnels
    // through — so no sound here.
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
        '<button class="battle-enable-fast" type="button">\uE086 Click to enable fast mode and skip battle dialogs</button>';

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
        outcome.textContent = `${ICON.defeat} ${targetSnap.name} is slain!${dmgNote}`;
        outcome.className   = 'battle-outcome kill';
      } else if (result.hit) {
        const fortNote = result.fortHpDamage
          ? ` (-${result.fortHpDamage} fort HP${result.fortDamaged ? `, -${result.fortDamaged} lvl` : ''})`
          : '';
        const tier = result.breakdown?.dmgTier ?? 1;
        if (tier >= 2) {
          const word = tier >= 3 ? 'Great crushing hit!' : 'Crushing hit!';
          outcome.textContent = `${ICON.crush}${ICON.crush} ${word} ${targetSnap.name} takes ${result.damage} damage!${fortNote}`;
          outcome.className   = 'battle-outcome kill';
        } else {
          outcome.textContent = `${ICON.crush} Hit! ${targetSnap.name} takes ${result.damage} damage${fortNote}`;
          outcome.className   = 'battle-outcome hit';
        }
      } else if (result.counterDmg > 0) {
        outcome.textContent = `${ICON.hero} Counter! ${actorSnap.name} takes ${result.counterDmg} damage!`;
        outcome.className   = 'battle-outcome kill';
      } else {
        outcome.textContent = `${ICON.shield} ${targetSnap.name} defends!`;
        outcome.className   = 'battle-outcome miss';
      }
      outcome.classList.add('battle-outcome-pulse');

      // Splash damage line(s) below main outcome
      if (result.splashHits?.length) {
        const splashEl = document.createElement('div');
        splashEl.className = 'battle-splash';
        const lines = result.splashHits.map(h =>
          h.killed ? `${ICON.splash} ${h.name} is slain by splash!` : `${ICON.splash} ${h.name} takes −${h.damage ?? 1} splash damage`
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
        rematchBtn.textContent = '\uE000 Battle Again';
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
      pauseBtn.textContent = _dismissPaused ? '\uE0B8' : '\uE0B7';
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
      [TileType.GRASS]:  ICON.grass,
      [TileType.FOREST]: ICON.forest,
      [TileType.DIRT]:   ICON.dirt,
      [TileType.ROAD]:   ICON.road,
      [TileType.RIVER]:  ICON.river,
      [TileType.BRIDGE]: ICON.bridge,
    };

    // ── SVG hex elements ──
    const polyEl = this._el('tile-zoom-poly');
    const fortEl = this._el('tile-zoom-fort');
    const iconEl = this._el('tile-zoom-icon');

    const fillColor = TILE_COLOR_MAP[legacyTileType(tile)] ?? '#3a5430';
    if (polyEl) polyEl.setAttribute('fill', fillColor);

    // Icon: building emoji or terrain fallback
    const icon = tile.building ? (BUILDING_ICON[tile.building] ?? '\uE03C')
                                : (TERRAIN_ICON[legacyTileType(tile)] ?? '');
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
      nameEl.textContent = tile.building ? (BUILDING_LABEL[tile.building] ?? legacyTileType(tile))
                                         : legacyTileType(tile);
    }

    const obj       = state.witchObjectives.find(o =>
      o.hexes.some(h => h.col === hex.col && h.row === hex.row)
    );
    let linesHtml   = '';

    if (obj) {
      const ctrl = nodeController(obj, state.entities);
      const ctrlStr = ctrl === 'hero'      ? '\uE099 Hero'
                    : ctrl === 'witch'     ? '\uE09A Witch'
                    : ctrl === 'contested' ? '\uE091 Contested'
                    : '\uE09B Uncontrolled';
      linesHtml += `<div class="tile-zoom-info-line node">${ICON.hero} Power Node (${obj.label}) — ${ctrlStr}</div>`;
    }
    if (tile.explored && tile.fortifyLevel) {
      const { attack: fAtk, defense: fDef } = getFortifyCombatBonus(tile.fortifyLevel);
      const bonusStr = fAtk > 0 ? `+${fAtk} ATT, +${fDef} DEF` : `+${fDef} DEF`;
      const hp     = tile.fortifyHP ?? tile.fortifyLevel * FORTIFY_HP_PER_LEVEL;
      const lvlMax = tile.fortifyLevel * FORTIFY_HP_PER_LEVEL;
      const hpStr  = `${hp}/${lvlMax} HP`;
      const metalIcon = coloredResourceIcon('metal');
      const fl = tile.fortifyLevel >= 5 ? `${metalIcon}${metalIcon}${metalIcon} Bastion (lvl ${tile.fortifyLevel}: ${bonusStr} · ${hpStr})`
               : tile.fortifyLevel >= 3 ? `${metalIcon}${metalIcon} Heavily Reinforced (lvl ${tile.fortifyLevel}: ${bonusStr} · ${hpStr})`
               : tile.fortifyLevel >= 2 ? `${metalIcon} Metal Reinforced (lvl ${tile.fortifyLevel}: ${bonusStr} · ${hpStr})`
               : `${coloredResourceIcon('wood')} Fortified (lvl ${tile.fortifyLevel}: ${bonusStr} · ${hpStr})`;
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

  /** Open or close the left-edge chronicle sidebar. */
  _setChronicleOpen(open) {
    this._chronicleOpen = !!open;
    const panel = this._el('chronicle-sidebar');
    if (panel) panel.classList.toggle('collapsed', !this._chronicleOpen);
    const toggle = this._el('chronicle-tab-toggle');
    if (toggle) toggle.textContent = this._chronicleOpen ? '−' : '+';
    if (this._chronicleOpen) this._renderSidebarLog();
    // On mobile, plan and chronicle are mutually exclusive — close the plan panel when opening chronicle.
    if (this._chronicleOpen && this._isMobileViewport()) {
      const planPanel = this._el('plan-panel');
      if (planPanel && !planPanel.classList.contains('collapsed')) {
        planPanel.classList.add('collapsed');
        const planTabToggle = this._el('plan-tab-toggle');
        if (planTabToggle) planTabToggle.textContent = '+';
        this._syncPlanInset();
        this._renderEndTurnBtn();
      }
    }
    // Update renderer inset so framing avoids the sidebar area when open
    if (this.renderer) this.renderer.insetLeft = this._chronicleOpen ? 240 : 0;
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
    const label   = isHero ? '\uE000 Supplies' : '\uE067 Stores';

    const entries = Object.entries(stash).filter(([, v]) => (v?.count ?? 0) > 0);

    const rows = entries.length
      ? entries.map(([k, v]) =>
          `<div class="inv-resource-row">
            <span class="inv-resource-label">${coloredResourceLabel(RESOURCE_LABEL[k] || k)}</span>
            <span class="inv-resource-val">×${v.count}</span>
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

    if (this._chronicleOpen) this._renderSidebarLog();
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

      // One sting per summary, highest-priority event wins:
      // game over > node scoring > phase change.
      {
        const score = this.state?.nodeScore;
        const scored = prevScore && score &&
          (score.hero !== prevScore.hero || score.witch !== prevScore.witch);
        const phaseKey = this.state?.phase ?? null;
        if (gameOver) {
          audio.play(!humanFaction || winner === humanFaction ? 'victory' : 'defeat');
        } else if (scored) {
          audio.play('score');
        } else if (phaseKey && this._lastPhaseSoundKey !== null && this._lastPhaseSoundKey !== phaseKey) {
          // Sting only when the phase actually flips (not every round).
          audio.play(phaseKey === 'night' || phaseKey === 'dusk' ? 'nightfall' : 'phase');
        }
        this._lastPhaseSoundKey = phaseKey;
      }

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
      // Reverse map (glyph -> resource id) for parsing legacy glyph-only loot floaters.
      const RES_ID_BY_ICON = { [ICON.wood]: 'wood', [ICON.metal]: 'metal', [ICON.food]: 'food', [ICON.silver]: 'silver', [ICON.scripture]: 'scripture', [ICON.herb]: 'herbs' };
      const RES_IDS = new Set(['wood', 'metal', 'food', 'silver', 'scripture', 'herbs']);

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
            // Loot found: equipment/key items/mounts show their full name +
            // stats (via lootItemIds → lootDisplayLabel); raw resources still
            // aggregate as icons. Falls back to the legacy emoji+log parse for
            // older/online events that predate lootItemIds.
            if (ev.action?.type === 'explore') {
              const ids   = ev.result.lootItemIds;
              const icons = ev.result.lootItems ?? [];
              if (Array.isArray(ids) && ids.length) {
                for (let i = 0; i < ids.length; i++) {
                  const id   = ids[i];
                  const icon = (icons[i] ?? '').replace(/^\+/, '');
                  if (ITEMS[id] || id === 'horse') {
                    equipFinds.push({ label: lootDisplayLabel(id) });
                  } else {
                    _addRes(foundRes, id);
                  }
                }
              } else {
                for (const item of icons) {
                  if (!item.startsWith('+')) continue;
                  const icon  = item.slice(1);
                  const glyph = icon.charAt(0);   // floater may be "glyph" or "glyph Name"
                  if (glyph === '\uE048' || glyph === '\uE0A2') {
                    const keyword = glyph === '\uE048' ? 'horse' : 'Found a ';
                    const logLine = (ev.result.log ?? []).find(l => l.toLowerCase().includes(keyword));
                    equipFinds.push({ icon: glyph, log: logLine || (glyph === '\uE048' ? 'Found a horse!' : 'Found a weapon!') });
                  } else {
                    _addRes(foundRes, RES_ID_BY_ICON[glyph] || icon);
                  }
                }
              }
            }
            // Resources spent: summon — use result.spent for exact breakdown
            if (ev.action?.type === 'summon') {
              for (const { type, amount } of ev.result?.spent ?? []) {
                _addRes(usedRes, type, amount);
              }
            }
            // Resources spent: fortify
            if (ev.action?.type === 'fortify') {
              const log0 = ev.result?.log?.[0] ?? '';
              _addRes(usedRes, log0.includes('metal') ? 'metal' : 'wood');
            }
            // Resources spent: use-item (only trackable consumables)
            if (ev.action?.type === 'use_item') {
              const rid = ev.action?.item;
              if (RES_IDS.has(rid)) _addRes(usedRes, rid);
            }
          }
        }
      }

      // Include survivors spawned at power nodes during endRound — but gate by
      // viewer faction so a witch viewer doesn't see the hero's power-node
      // procs (the wrap-up's other discoveries respect fog already, this
      // legacy branch was missing the same gate).
      for (const s of (this.state.nodeSpawnedSurvivors ?? [])) {
        if (humanFaction && s?.faction && s.faction !== humanFaction) continue;
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

        // Game-over dialog is JUST the victory/defeat message + buttons — no
        // per-turn summary (combats/kills/resources/reckoning) and no speed
        // controls. Write the message and skip the turn-summary body below.
        if (gameOver) {
          eventsEl.innerHTML = html;
        } else {

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
          html += `<div class="summary-kill">${ICON.defeat} ${n} slain</div>`;
        }

        // Campaign veterancy: per-unit "+N XP" lines beneath the kills/combat
        // they came from, summed to one line per unit (aggregation lives in
        // compileTurnXpSummary). Campaign-only — the XP_AWARDED events never
        // fire outside campaign, and this gate keeps the lines out belt-and-braces.
        if (isCampaign) {
          for (const xp of compileTurnXpSummary(steps ?? [], this.state.entities, ResEventType)) {
            const cls = xp.leveledUp ? 'summary-xp leveled' : 'summary-xp';
            html += `<div class="${cls}">${ICON.sparkle} ${xp.text}</div>`;
          }
        }
        for (const s of survivors) {
          if (s.type === 'zombie') {
            html += `<div class="summary-summon">${ICON.zombie} Zombie raised</div>`;
          } else {
            const label = s.title ? `${s.name} the ${s.title}` : s.name;
            html += `<div class="summary-survivor">${ICON.survivor} ${label} joined</div>`;
          }
        }
        for (const s of summons) {
          html += `<div class="summary-summon">${ICON.witch} ${s}</div>`;
        }

        for (const eq of equipFinds) {
          // New path: `label` already carries emoji + name + stats. Legacy path:
          // generic icon + parsed log line.
          const body = eq.label ?? `${eq.icon === '\uE048' ? '\uE048' : '\uE0A2'} ${eq.log}`;
          html += `<div class="summary-equip">${body}</div>`;
        }

        // Resource economy rows
        const foundEntries = Object.entries(foundRes);
        const usedEntries  = Object.entries(usedRes);
        if (foundEntries.length > 0) {
          const foundStr = foundEntries.map(([id, n]) => `${coloredResourceLabel(RESOURCE_LABEL[id] || id)} \u00d7${n}`).join('   ');
          html += `<div class="summary-resources found">${ICON.storehouse} Found: ${foundStr}</div>`;
        }
        if (usedEntries.length > 0) {
          const usedStr = usedEntries.map(([id, n]) =>
            id === 'res' ? `${n} res` : `${coloredResourceLabel(RESOURCE_LABEL[id] || id)} \u00d7${n}`
          ).join('   ');
          html += `<div class="summary-resources used">${ICON.sentTo} Spent: ${usedStr}</div>`;
        }

        // Node control changes
        for (const nc of nodeChanges) {
          if (nc.to === 'hero') {
            html += `<div class="summary-node hero-text">${ICON.hero} Hero now controls ${nc.label}</div>`;
          } else if (nc.to === 'witch') {
            html += `<div class="summary-node witch-text">${ICON.witch} Witch has seized ${nc.label}</div>`;
          } else if (nc.to === 'contested') {
            html += `<div class="summary-node">${ICON.join} ${nc.label} is now contested</div>`;
          } else {
            html += `<div class="summary-node">◇ ${nc.label} is no longer controlled</div>`;
          }
        }

        // Post-round effects (night attrition, etc.)
        const postEvents = this.state.postRoundEvents || [];
        const myId = this.myPlayerId;
        // Kills are shown for either side — the player watched that unit
        // vanish, so the summary must explain it. Damage/shelter stay scoped
        // to the player's own units.
        const visiblePostEvents = postEvents.filter(ev =>
          ev.type !== 'safe'
          && (ev.type === 'kill' || !myId || !ev.ownerId || ev.ownerId === myId)
        );
        if (visiblePostEvents.length) {
          html += `<div class="summary-hazard-header">${ICON.night} Night Attrition</div>`;
          for (const ev of visiblePostEvents) {
            if (ev.type === 'kill') {
              const cause = ev.text
                ? String(ev.text).replace(/^\uE097\s*/, '')
                : `${ev.entityName} −${ev.amount} HP (unsheltered at night) — killed`;
              html += `<div class="summary-hazard">${ICON.defeat} ${cause}</div>`;
            } else if (ev.type === 'damage') {
              html += `<div class="summary-hazard">${ICON.night} ${ev.entityName} −${ev.amount} HP (unsheltered at night)</div>`;
            } else if (ev.type === 'shelter') {
              const isBuilding = ev.text.startsWith('\uE03C');
              const desc = isBuilding ? 'sheltered in building' : 'sheltered by fortifications';
              html += `<div class="summary-shelter">${isBuilding ? '\uE03C' : '\uE03B'} ${ev.entityName} ${desc}</div>`;
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

          const phaseLabel = state.phase === 'dawn' ? '\uE020 Dawn Reckoning' : '\uE022 Dusk Reckoning';

          let reckoningLine;
          if (witchDelta > 0) {
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
            <div class="summary-score-track">${ICON.hero} ${heroPips}&nbsp;&nbsp;${witchPips} ${ICON.witch}</div>
          </div>`;
        }



        // AI takeover messages (from consecutive timeout)
        const takeoverMsgs = this.state._takeoverMessages || [];
        for (const msg of takeoverMsgs) {
          html += `<div class="summary-takeover">${ICON.bot} ${msg}</div>`;
        }
        // Clear after showing
        if (this.state._takeoverMessages) this.state._takeoverMessages = [];

        eventsEl.innerHTML = html || `<div class="summary-neutral">No notable events this round.</div>`;
        } // end !gameOver turn-summary body
      }

      // Render replay-speed dropdown (compact single-button toggle + popup).
      // Game-over dialog has no speed controls.
      const speedRowEl = gameOver ? null : this._el('round-summary-speed-row');
      if (speedRowEl) {
        const SPEED_ICONS = { cinematic: '\uE085', fast: '\uE086', vfast: '\uE087' };
        const SPEED_DESCS = { cinematic: 'Dialog for important battles', fast: 'Cinematic pace, no popups', vfast: '1.5× speed, no popups' };
        const modes = Object.entries(UIController.SPEED_LABELS);

        speedRowEl.innerHTML =
          `<button class="summary-speed-toggle" title="Battle speed">${ICON.join} ${UIController.SPEED_LABELS[this.speedMode]}</button>` +
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
          toggleBtn.textContent = `${ICON.join} ${UIController.SPEED_LABELS[this.speedMode]}`;
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
      const replayGroup = el.querySelector('.round-summary-replay-group');
      const actionsEl = el.querySelector('.round-summary-actions');

      // Game-over dialog is JUST the victory/defeat message + a Return to Menu
      // button (and Replay Full Game in skirmish/online). Drop the per-turn
      // wrap-up controls entirely: no ↺ Replay, no speed dropdown.
      let gameOverBtns = null;
      if (gameOver && actionsEl) {
        if (nextBtn) nextBtn.style.display = 'none';
        // Hide the ↺ Replay + speed-row group; clear any stale speed markup left
        // from an earlier non-game-over render of this same modal.
        if (replayGroup) replayGroup.style.display = 'none';
        const staleSpeedRow = this._el('round-summary-speed-row');
        if (staleSpeedRow) {
          staleSpeedRow.innerHTML = '';
          if (staleSpeedRow._closePopup) {
            document.removeEventListener('click', staleSpeedRow._closePopup);
            staleSpeedRow._closePopup = null;
          }
        }
        gameOverBtns = document.createElement('div');
        gameOverBtns.className = 'round-summary-gameover-btns';
        // Campaign missions route this button into the post-mission debrief (NOT
        // the menu), so label it "Continue →" there — "Return to Menu" read as an
        // abandon prompt, leaving players parked on the Victory modal over the
        // still-visible replay ("stuck in replay" on the prologue). data-action
        // stays 'restart'; _runLocalResolution maps it to _handleCampaignMissionEnd.
        const primaryLabel = isCampaign ? 'Continue →' : 'Return to Menu';
        gameOverBtns.innerHTML =
          `<button class="plan-btn primary" data-action="restart">${primaryLabel}</button>` +
          (hasFullReplay && !isCampaign ? `<button class="plan-btn secondary" data-action="replay-full">Replay Full Game</button>` : '');
        actionsEl.appendChild(gameOverBtns);
      } else if (nextBtn) {
        if (replayGroup) replayGroup.style.display = '';
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
        // Restore the ↺ Replay / speed group hidden by the game-over branch so
        // the shared modal renders normally for the next round.
        if (replayGroup) replayGroup.style.display = '';
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
   * @param {Function} onControl  — called with action string: 'back'|'next'|'playpause'|'stop'
   */
  showReplayHUD(totalRounds, onControl) {
    const hud = this._el('replay-hud');
    if (!hud) return;
    this._showReplayBar('full', onControl);
  }

  /**
   * Shared implementation behind the full-game and inline replay bars — one
   * unified bottom-center control bar (#replay-hud). Back/Stop appear only in
   * full mode; the End button is relabelled "SKIP" in inline mode. The camera
   * toggle is wired internally (not routed through onControl).
   *
   * @param {'full'|'inline'} mode
   * @param {Function} onControl — 'back'|'play'|'pause'|'ff'|'end'|'stop'
   */
  _showReplayBar(mode, onControl) {
    const hud = this._el('replay-hud');
    if (!hud) return;
    hud.style.display = 'flex';
    // _replayOnControl marks the FULL-game bar as active; main.js reads it to
    // avoid stacking the inline bar over the full one.
    this._replayOnControl = mode === 'full' ? onControl : null;

    // Back + Stop are full-game-only; NEXT + PLAY/PAUSE are shared.
    for (const action of ['back', 'stop']) {
      const btn = document.getElementById(`replay-${action}-btn`);
      if (btn) btn.style.display = (mode === 'full') ? '' : 'none';
    }
    // Redo (replay the current round/turn) is shown in both modes — distinct
    // from Back (which steps to the previous round in full-game replay).
    const redoBtn = document.getElementById('replay-redo-btn');
    if (redoBtn) redoBtn.style.display = '';

    // Wire control buttons -> onControl. Camera is handled internally.
    for (const action of ['back', 'redo', 'next', 'playpause', 'stop']) {
      const btn = document.getElementById(`replay-${action}-btn`);
      if (btn) btn.onclick = () => onControl?.(action);
    }
    const camBtn = document.getElementById('replay-camera-btn');
    if (camBtn) camBtn.onclick = () => this._toggleReplayCamera();

    // Detail (combat-speed) toggle — cycles Full → Summary → Speedy, internal.
    const detailBtn = document.getElementById('replay-detail-btn');
    if (detailBtn) detailBtn.onclick = () => this._cycleReplayDetail();
    this._applyReplayDetail();

    // Apply the current camera mode (FOLLOW by default) so auto-framing and
    // manual-pan state are consistent the moment the bar appears.
    this._preReplayViewLocked = this.renderer?.viewLocked ?? false;
    this._applyReplayCameraMode();

    this.setReplayTransport(true);   // start paused (manual stepping)
  }

  /** Toggle replay camera between FOLLOW (auto-zoom to action) and FIXED. */
  _toggleReplayCamera() {
    this.replayCameraMode = this.replayCameraMode === 'fixed' ? 'follow' : 'fixed';
    this._applyReplayCameraMode();
  }

  /** True while a replay/resolution control bar is on screen. */
  _isReplayActive() {
    const hud = this._el('replay-hud');
    return !!hud && hud.style.display !== 'none';
  }

  /**
   * Manual pan during replay takes camera control away from FOLLOW: flip to
   * FIXED so the player's view sticks instead of the next step yanking it back.
   * Pan mutates the view directly (not via frameHexes), so it isn't blocked by
   * suppressAutoFrame — this only needs the mode flip. No-op when not replaying
   * or already FIXED.
   */
  _claimReplayCamera() {
    if (!this._isReplayActive() || this.replayCameraMode === 'fixed') return;
    this.replayCameraMode = 'fixed';
    this._applyReplayCameraMode();
  }

  /**
   * Run a user-initiated camera move (zoom / fit / focus) that uses frameHexes
   * or _focusCamera. Those early-return while `suppressAutoFrame` is set (the
   * FIXED/FOLLOW auto-frame guard), so a manual move during replay would do
   * nothing. We lift suppression for the move, then re-assert FIXED so the new
   * view holds against the next step's auto-follow. Outside replay it just runs.
   */
  _replayManualCamera(fn) {
    const replaying = this._isReplayActive();
    const r = this.renderer;
    const prevSuppress = r ? r.suppressAutoFrame : false;
    if (replaying && r) r.suppressAutoFrame = false;
    fn();
    if (replaying) {
      this.replayCameraMode = 'fixed';
      this._applyReplayCameraMode();        // restores suppressAutoFrame = true
    } else if (r) {
      r.suppressAutoFrame = prevSuppress;
    }
  }

  /**
   * Sync renderer + button to the current replayCameraMode.
   * FOLLOW - auto-framing drives the camera (suppress off, manual pan allowed).
   * FIXED  - camera stays put; auto-framing suppressed, manual pan allowed.
   */
  _applyReplayCameraMode() {
    if (!this.replayCameraMode) this.replayCameraMode = 'follow';
    const fixed = this.replayCameraMode === 'fixed';
    if (this.renderer) {
      this.renderer.suppressAutoFrame = fixed;
      // Both modes leave manual pan/zoom unlocked; FOLLOW just keeps re-framing.
      this.renderer.viewLocked = false;
      this._updateFitBtnLockState();
    }
    const camBtn = document.getElementById('replay-camera-btn');
    if (camBtn) {
      camBtn.textContent = fixed ? 'Fixed' : 'Follow';
      camBtn.dataset.tip = fixed
        ? 'Camera fixed — stays where you put it; tap to follow the action'
        : 'Camera follows the action — tap to keep it fixed instead';
      camBtn.classList.toggle('fixed', fixed);
    }
  }

  /**
   * Sync the transport buttons to the current play/pause state.
   * @param {boolean} paused — true = manual stepping (NEXT enabled), false = auto-run.
   */
  setReplayTransport(paused) {
    // AutoPlay is a toggle: highlighted (active) while auto-running.
    const pp = document.getElementById('replay-playpause-btn');
    if (pp) {
      pp.dataset.tip = paused ? 'Auto-play — run every step without stopping' : 'Pause — step through manually with Next';
      pp.classList.toggle('active', !paused);
    }
    // NEXT only works while paused; grey it out during auto-play.
    const next = document.getElementById('replay-next-btn');
    if (next) {
      next.disabled = !paused;
      next.classList.toggle('disabled', !paused);
      if (!paused) next.classList.remove('ready');   // drop the prompt when auto-playing
    }
  }

  /**
   * Pulse the NEXT button once a step has finished animating (manual mode) to
   * prompt the player to advance. Cleared as soon as they do.
   */
  setReplayNextReady(ready) {
    const next = document.getElementById('replay-next-btn');
    if (next) next.classList.toggle('ready', !!ready && !next.disabled);
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

    // Restore view-lock state that existed before replay started
    if (this.renderer) {
      this.renderer.suppressAutoFrame = false;
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
  showInlineReplayHUD(onControl) {
    this._showReplayBar('inline', onControl);
    this._inlineReplayActive = true;
  }

  /** Hide the inline replay bar and restore Back/Stop visibility. */
  hideInlineReplayHUD() {
    const hud = this._el('replay-hud');
    if (hud) hud.style.display = 'none';
    for (const action of ['back', 'next', 'playpause', 'stop']) {
      const btn = document.getElementById(`replay-${action}-btn`);
      if (btn) btn.style.display = '';
    }
    if (this.renderer) {
      this.renderer.suppressAutoFrame = false;
      this.renderer.viewLocked = this._preReplayViewLocked ?? false;
      this._updateFitBtnLockState();
    }
    const endBtn = document.getElementById('replay-end-btn');
    if (endBtn) {
      // Restore the original glyph (defaults to ⇥ if we never saw one)
      endBtn.textContent = this._replayEndBtnOriginalText ?? '\u21E5';
      endBtn.dataset.tip = 'Jump to the end of the replay';
      endBtn.onclick = null;
    }
    this._replayEndBtnOriginalText = undefined;
    this._inlineReplayActive = false;
  }

  // ── Off-screen conversation arrow ────────────────────────────────────────
  // Fixed-camera mode keeps the camera put during conversations; when the
  // talking hex is outside the viewport, an edge-clamped arrow points at it.

  /** Show (and keep refreshing) the edge arrow toward hex (col,row). Hidden
   *  automatically whenever the hex is on screen. Refreshes on an interval so
   *  manual pans in fixed-camera mode keep the direction honest. */
  showOffscreenArrow(col, row) {
    this.hideOffscreenArrow();
    const el = this._el('offscreen-arrow');
    const canvas = this._el('game-canvas');
    if (!el || !canvas || !this.renderer?.hexToCanvasPos) return;

    const update = () => {
      const p = this.renderer.hexToCanvasPos(col, row);
      // hexToCanvasPos returns render-buffer pixels; scale to CSS pixels.
      const sx = canvas.clientWidth  / (canvas.width  || canvas.clientWidth  || 1);
      const sy = canvas.clientHeight / (canvas.height || canvas.clientHeight || 1);
      const x = p.x * sx, y = p.y * sy;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const MARGIN = 28;
      const onScreen = x >= MARGIN && x <= W - MARGIN && y >= MARGIN && y <= H - MARGIN;
      if (onScreen) { el.hidden = true; return; }
      el.hidden = false;
      const cx = Math.max(MARGIN, Math.min(W - MARGIN, x));
      const cy = Math.max(MARGIN, Math.min(H - MARGIN, y));
      const angle = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
      el.style.left = `${cx}px`;
      el.style.top  = `${cy}px`;
      el.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
    };
    update();
    this._offscreenArrowTimer = setInterval(update, 250);
  }

  hideOffscreenArrow() {
    if (this._offscreenArrowTimer) {
      clearInterval(this._offscreenArrowTimer);
      this._offscreenArrowTimer = null;
    }
    const el = this._el('offscreen-arrow');
    if (el) el.hidden = true;
  }

  // ── Replay timeline overlay ──────────────────────────────────────────────
  // Transparent left-to-right sequence of resolution-step columns built from
  // buildStepDigest (src/replay-timeline.js). Driven by _animateResolutionSteps.

  /** Render the timeline columns and reveal the overlay. */
  showReplayTimeline(digest) {
    const wrap  = this._el('replay-timeline');
    const track = this._el('replay-timeline-track');
    if (!wrap || !track || !Array.isArray(digest)) return;
    // Compact long runs of quiet move/guard turns into a single timeline card
    // before render. Purely a UX-layer fold over buildStepDigest output — the
    // resolver / step records / round history are untouched. The compactor
    // returns the original digest unchanged when there's nothing to collapse.
    // We store BOTH the rendered (compacted) digest — used by hover lookups
    // that key off the column's `data-step` — and a follower→leader stepIndex
    // map so highlightReplayEntry / revealReplayEntryOutcome / advance calls
    // for a follower step resolve to the compacted leader's column.
    const compacted = compactUneventfulTurns(digest);
    this._replayDigest = compacted;
    this._replayStepLeader = new Map();
    for (const col of compacted) {
      if (col.kind === 'compacted' && Array.isArray(col.memberStepIndices)) {
        for (const m of col.memberStepIndices) {
          this._replayStepLeader.set(String(m), col.stepIndex);
        }
      }
    }
    this._replayTrackX = 0;
    this._activeReplayOrd = 0;
    track.style.transform = 'translateX(0)';
    // Only render steps that have visible activity (fogged steps are dropped
    // entirely). data-step keeps the ORIGINAL step index so highlight/centre
    // calls (keyed on the animation step) still match; the "Step N" label is
    // numbered sequentially among the visible cards.
    const visible = compacted.filter(col => col.entries.length > 0);
    // Bump the displayed turn number by (count - 1) for each compacted card so
    // a "Turns 5–8" block doesn't make the next solo card read as "Turn 6".
    let displayNum = 0;
    track.innerHTML = visible.map(col => {
      const startNum = displayNum + 1;
      const span = (col.kind === 'compacted' && col.count > 1) ? col.count : 1;
      const endNum = startNum + span - 1;
      displayNum = endNum;
      return this._replayColHtml(col, startNum, endNum);
    }).join('');
    if (!visible.length) { wrap.classList.remove('visible'); return; }
    wrap.classList.add('visible');
    // Mobile defaults to collapsed cards (they otherwise cover the board);
    // desktop defaults to the full card. A manual toggle is remembered for the
    // rest of the session. On mobile the body flag also hides the compass and
    // lifts the cards up (see styles.css mobile block).
    if (this._replayCollapsed === undefined) this._replayCollapsed = this._isMobileViewport();
    this._bindReplayCollapse();
    this._bindReplayHoverHighlights();
    this._bindTurnCardScrollDetection();
    // A fresh round's cards mount at the top — forget any prior manual scroll so
    // auto-scroll resumes immediately for the new turn.
    (this._turnCardAutoScroll ??= new TurnCardAutoScroll()).reset();
    this._applyReplayCollapse(this._replayCollapsed);
    if (typeof document !== 'undefined') document.body?.classList?.add('replay-timeline-up');
    this._el('replay-progress')?.classList.add('visible');
    this.setReplayTimelineStep(visible[0].stepIndex);
    // Cards are fresh in the DOM — no scroll events have fired yet, so set the
    // initial fade-flag state (cards that fit on screen get NO mask gradient,
    // cards that overflow get a bottom fade only since scrollTop starts at 0).
    this._updateAllColFades();
  }

  /** Wire manual-scroll detection on the (persistent) timeline container once.
   *  A wheel or touch scroll inside a turn card flags the auto-scroll controller
   *  so it suspends itself for a few seconds — we never yank the card away while
   *  the player is reading. Programmatic scrollIntoView fires no wheel/touch
   *  event, so it never trips this. Listeners share the UIController-wide
   *  AbortController (`_eventsAC`) so `destroy()` removes them — otherwise an
   *  orphaned UIController would keep firing on shared replay DOM in the next
   *  game (see tests/ui/action-panel-stuck.test.js for the pattern). */
  _bindTurnCardScrollDetection() {
    if (this._turnCardScrollBound) return;
    const wrap = this._el('replay-timeline');
    if (!wrap || typeof wrap.addEventListener !== 'function') return;
    const onUserScroll = () => {
      const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
      (this._turnCardAutoScroll ??= new TurnCardAutoScroll()).notifyUserScroll(now);
    };
    const opts = { passive: true, signal: this._eventsAC.signal };
    wrap.addEventListener('wheel',     onUserScroll, opts);
    wrap.addEventListener('touchmove', onUserScroll, opts);
    // `scroll` doesn't bubble, so capture-phase on the wrapper sees scrolls on
    // every descendant `.replay-step-col` (fired by both user and programmatic
    // scrollIntoView). Each fires _updateColFade so the top/bottom mask gradient
    // only appears when content is actually clipped above/below the viewport.
    wrap.addEventListener('scroll', (e) => {
      const col = e.target;
      if (col && col.classList && col.classList.contains('replay-step-col')) {
        this._updateColFade(col);
      }
    }, { capture: true, passive: true, signal: this._eventsAC.signal });
    this._turnCardScrollBound = true;
  }

  /** Toggle `.has-fade-top` / `.has-fade-bottom` on a turn card based on whether
   *  content is currently hidden above or below the visible viewport. Cards that
   *  fit entirely get neither class (no mask gradient → no dimmed readable text).
   *  The mask CSS is keyed off these classes (styles.css). */
  _updateColFade(col) {
    if (!col || !col.classList) return;
    const { top, bottom } = computeFadeFlags({
      scrollTop:    col.scrollTop    ?? 0,
      clientHeight: col.clientHeight ?? 0,
      scrollHeight: col.scrollHeight ?? 0,
    });
    col.classList.toggle('has-fade-top',    top);
    col.classList.toggle('has-fade-bottom', bottom);
  }

  /** Walk every rendered turn card and refresh its fade state — used after a
   *  fresh render where no scroll events have fired yet, or after a layout
   *  change that may have flipped overflow on/off. */
  _updateAllColFades() {
    const wrap = this._el('replay-timeline');
    if (!wrap || typeof wrap.querySelectorAll !== 'function') return;
    wrap.querySelectorAll('.replay-step-col').forEach(col => this._updateColFade(col));
  }

  /** Keep the action currently resolving inside the visible upper portion of a
   *  long, scrollable turn card. Targets the first `.is-acting` row and aligns
   *  it to the card's top + `scroll-margin-top` (set in CSS), landing it above
   *  the middle of the screen. Stands down while the player has scrolled
   *  manually (TurnCardAutoScroll) and on collapsed cards (only the active row
   *  shows — scrolling would just jump). */
  _autoScrollActiveEntry(col) {
    if (!col || typeof col.querySelector !== 'function') return;
    const now = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
    const suspended = (this._turnCardAutoScroll ??= new TurnCardAutoScroll()).isSuspended(now);
    const active = col.querySelector('.replay-step-entry.is-acting');
    if (!shouldAutoScrollToActive({
      suspended,
      collapsed: !!this._replayCollapsed,
      hasActive: !!active,
    })) return;
    if (typeof active.scrollIntoView !== 'function') return;
    active.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /** Wire the per-card +/- toggle once. Cards are re-rendered every round, so
   *  the listener is delegated on the (persistent) timeline container. */
  _bindReplayCollapse() {
    if (this._replayCollapseBound) return;
    const wrap = this._el('replay-timeline');
    if (!wrap || typeof wrap.addEventListener !== 'function') return;
    wrap.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.replay-collapse-btn')) return;
      this._applyReplayCollapse(!this._replayCollapsed);
    });
    this._replayCollapseBound = true;
  }

  /** Hovering an action entry on a turn card highlights its involved hexes on
   *  the map (15%-alpha blue fill) and, for a successful move, a translucent
   *  ghost arrow tracing the path. Delegated on the persistent timeline
   *  container (cards re-render every round); hover-capable pointers only. */
  _bindReplayHoverHighlights() {
    if (this._replayHoverBound) return;
    const wrap = this._el('replay-timeline');
    if (!wrap || typeof wrap.addEventListener !== 'function') return;
    if (typeof window !== 'undefined' && window.matchMedia
        && !window.matchMedia('(hover: hover)').matches) return;
    wrap.addEventListener('mouseover', (e) => {
      const row = e.target?.closest?.('.replay-step-entry');
      if (!row) { this._clearReplayHoverHighlight(); return; }
      const stepAttr = row.closest('.replay-step-col')?.getAttribute?.('data-step');
      const col = (this._replayDigest ?? []).find(c => String(c.stepIndex) === String(stepAttr));
      const entry = col?.entries?.[Number(row.getAttribute('data-entry'))] ?? null;
      this._applyReplayHoverHighlight(entry);
    });
    wrap.addEventListener('mouseleave', () => this._clearReplayHoverHighlight());
    this._replayHoverBound = true;
  }

  _applyReplayHoverHighlight(entry) {
    if (typeof this.renderer?.setOverlay !== 'function') return;
    const { fill, arrows } = buildTurnCardHoverOverlays(entry);
    if (!fill && !arrows.length) { this._clearReplayHoverHighlight(); return; }
    this._clearReplayHoverHighlight();
    const ids = [];
    if (fill) { this.renderer.setOverlay(fill.id, fill); ids.push(fill.id); }
    for (const a of arrows) { this.renderer.setOverlay(a.id, a); ids.push(a.id); }
    this._turnCardHoverIds = ids;
    this.renderer.draw?.();
  }

  _clearReplayHoverHighlight() {
    const ids = this._turnCardHoverIds;
    if (!ids?.length || typeof this.renderer?.removeOverlay !== 'function') return;
    for (const id of ids) this.renderer.removeOverlay(id);
    this._turnCardHoverIds = [];
    this.renderer.draw?.();
  }

  /** Collapse or expand every turn card. Collapsed cards show only the action
   *  that's currently playing (the rest is hidden by CSS); the +/- glyph flips
   *  to match. The choice is remembered across rounds in `_replayCollapsed`. */
  _applyReplayCollapse(collapsed) {
    this._replayCollapsed = !!collapsed;
    const wrap = this._el('replay-timeline');
    if (!wrap) return;
    // Auto-scroll is deliberately NOT triggered here — only resolution advancing
    // moves the card. (Preserving scrollTop across the toggle is a no-op: the
    // collapsed state clamps scrollTop to 0, so by the time we read it for the
    // re-expand it's already lost.)
    wrap.classList.toggle('collapsed', this._replayCollapsed);
    const glyph = this._replayCollapsed ? '+' : '−';
    const label = this._replayCollapsed ? 'Expand turn card' : 'Collapse turn card';
    wrap.querySelectorAll?.('.replay-collapse-btn').forEach(b => {
      b.textContent = glyph;
      b.setAttribute('aria-label', label);
    });
  }

  /** Build one visible step column's HTML (icons, names, hidden outcomes).
   *  A +/- toggle in the header collapses the card down to just the action
   *  currently playing (see `_applyReplayCollapse`); the trailing `.replay-more`
   *  dots are revealed by CSS when several actions are active at once.
   *  `endNum` is the LAST turn number in the card — equals `displayNum` for a
   *  regular column, and the inclusive end of the run for a compacted card
   *  (e.g. `Turns 5–8`). */
  _replayColHtml(col, displayNum, endNum = displayNum) {
    const rows = col.entries.map((e, j) => this._replayRowHtml(e, j)).join('');
    if (col.kind === 'storyBeat') {
      const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // A title + text panel — no action rows, no SKIP/REPLAY footer. The replay
      // gate (NEXT) advances past it like any turn card (see _presentStoryBeatCard).
      return `<div class="replay-step-col replay-beat-col" data-step="${col.stepIndex}">`
           + `<div class="replay-step-header">`
           +   `<div class="replay-step-label">${ICON.witch} ${esc(col.title)}</div>`
           + `</div>`
           + `<div class="replay-beat-text">${esc(col.text)}</div>`
           + `</div>`;
    }
    if (col.kind === 'conversation') {
      const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Voice-only mute lives on the bubble itself (top-right of the header) so
      // the player can silence narration without leaving the conversation. It
      // toggles the SHARED voiceover mute (src/voiceover.js) — same state as the
      // tutorial tooltip's button — and never affects SFX/music. Shown ONLY when
      // this conversation actually has generated narration (col.hasVoice).
      let muteBtnHtml = '';
      if (col.hasVoice) {
        const muteTitle = isVoiceMuted() ? 'Unmute narration' : 'Mute narration';
        muteBtnHtml = `<button class="replay-conv-mute" type="button" title="${muteTitle}" aria-label="${muteTitle}">${voiceMuteIconHtml(isVoiceMuted())}</button>`;
      }
      return `<div class="replay-step-col replay-conv-col" data-step="${col.stepIndex}">`
           + `<div class="replay-step-header">`
           +   `<div class="replay-step-label">${ICON.conversation} ${esc(col.title)}</div>`
           +   muteBtnHtml
           + `</div>`
           + rows
           + `<div class="replay-conv-btns">`
           +   `<button class="replay-conv-btn" type="button">SKIP</button>`
           +   `<button class="replay-conv-continue" type="button" style="display:none">CONTINUE ${ICON.play}</button>`
           + `</div>`
           + `</div>`;
    }
    // Compacted (consecutive uneventful turns folded into one card).
    // Header reads "Turns N–M" with a small count badge; the body shows every
    // constituent action so the player can still see what happened, but NEXT
    // walks past the whole block in one click (see main.js's manual-step gate
    // and _replayStepLeader in showReplayTimeline).
    if (col.kind === 'compacted') {
      const span = (endNum > displayNum)
        ? `Turns ${displayNum}–${endNum}`
        : `Turn ${displayNum}`;
      const countBadge = (col.count ?? 1) > 1
        ? `<span class="replay-compact-badge" title="${col.count} quiet turns collapsed">×${col.count}</span>`
        : '';
      return `<div class="replay-step-col replay-compact-col" data-step="${col.stepIndex}">`
           + `<div class="replay-step-header">`
           +   `<div class="replay-step-label">${span}${countBadge}</div>`
           +   `<button class="replay-collapse-btn" type="button" aria-label="Collapse turn card">−</button>`
           + `</div>`
           + rows
           + `<div class="replay-more" aria-hidden="true">…</div>`
           + `</div>`;
    }
    return `<div class="replay-step-col" data-step="${col.stepIndex}">`
         + `<div class="replay-step-header">`
         +   `<div class="replay-step-label">Turn ${displayNum}</div>`
         +   `<button class="replay-collapse-btn" type="button" aria-label="Collapse turn card">−</button>`
         + `</div>`
         + rows
         + `<div class="replay-more" aria-hidden="true">…</div>`
         + `</div>`;
  }

  /**
   * Flip a conversation card between its live and finished states and (re)wire
   * its footer buttons: 'playing' → SKIP (jump dialog to the end); 'done' →
   * REPLAY (re-run the dialog presentation) plus, when an `onContinue` handler
   * is supplied (mission-intro/turn-0 conversations), a CONTINUE button that
   * dismisses the card and lets the game proceed to planning. Mid-replay
   * conversations pass no onContinue — the round resumes on its own.
   * Targets the card by conversation stepIndex key (`conv:<id>`).
   */
  setConversationCardState(convoStepIndex, cardState, { onSkip, onReplay, onContinue } = {}) {
    const col = this._replayCol(convoStepIndex);
    const btn = col?.querySelector?.('.replay-conv-btn');
    const contBtn = col?.querySelector?.('.replay-conv-continue');
    if (!btn) return;
    this._wireConvMuteBtn(col);
    if (cardState === 'done') {
      btn.textContent = 'REPLAY';
      btn.onclick = onReplay ?? null;
      if (contBtn) {
        contBtn.style.display = onContinue ? '' : 'none';
        contBtn.onclick = onContinue ?? null;
      }
    } else {
      btn.textContent = 'SKIP';
      btn.onclick = onSkip ?? null;
      if (contBtn) contBtn.style.display = 'none';
    }
  }

  /**
   * Wire the conversation card's voice-only mute button (idempotent — the card
   * state flips several times per conversation). Click toggles the shared
   * voiceover mute; the glyph syncs immediately. No long-lived subscription:
   * the card is transient, and each new card paints the current mute state in
   * its header HTML.
   */
  _wireConvMuteBtn(col) {
    const muteBtn = col?.querySelector?.('.replay-conv-mute');
    if (!muteBtn || muteBtn.dataset.wired === '1') return;
    muteBtn.dataset.wired = '1';
    const sync = () => {
      const muted = isVoiceMuted();
      muteBtn.innerHTML = voiceMuteIconHtml(muted);
      const title = muted ? 'Unmute narration' : 'Mute narration';
      muteBtn.title = title;
      muteBtn.setAttribute('aria-label', title);
    };
    muteBtn.onclick = (e) => { e.stopPropagation(); toggleVoiceMuted(); sync(); };
    sync();
  }

  /**
   * Insert a column into the live timeline (mid-replay conversation card).
   * Splices the stored digest after `afterStepIndex` (or after the currently
   * active card when no match), re-renders, restores the revealed outcomes of
   * everything before the insert, and activates the new card.
   */
  insertReplayTimelineCol(col, afterStepIndex = null) {
    const digest = this._replayDigest ?? [];
    // When `afterStepIndex` is a follower of a compacted card, route it to the
    // leader's stepIndex so the conversation lands AFTER the whole folded
    // block (not the unfindable middle of it).
    const leader = this._replayStepLeader?.get?.(String(afterStepIndex));
    const key = leader != null ? leader : afterStepIndex;
    let idx = digest.findIndex(c => String(c.stepIndex) === String(key));
    if (idx < 0) {
      // Fall back to the active card's position in the digest.
      const cols = this._replayCols();
      const activeStep = cols[this._activeReplayOrd ?? 0]?.getAttribute('data-step');
      idx = digest.findIndex(c => String(c.stepIndex) === activeStep);
      if (idx < 0) idx = digest.length - 1;
    }
    digest.splice(idx + 1, 0, col);
    this.showReplayTimeline(digest);
    // Re-rendering resets the reveal animations — everything that already
    // played stays revealed.
    const cols = this._replayCols();
    const newOrd = cols.findIndex(c => c.getAttribute('data-step') === String(col.stepIndex));
    cols.slice(0, Math.max(0, newOrd)).forEach(c =>
      c.querySelectorAll('.replay-step-outcome, .replay-roll, .replay-discovered')
        .forEach(o => o.classList.add('revealed')));
    this.setReplayTimelineStep(col.stepIndex);
  }

  /**
   * One actor entry, laid out as an aligned 3-column grid:
   *   row 1:  [ UNIT ]   [ ACTION ]   [ TARGET ]
   *   row 2:  [ actor HP ] [ OUTCOME ] [ target HP ]
   * Each column lines up with its parent above it. Empty cells are emitted so
   * the grid stays aligned. All outcome cells are `.replay-step-outcome` so they
   * stay hidden until revealed as the action plays out.
   */
  _replayRowHtml(entry, entryIdx) {
    const esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const iconImg = (u) => {
      const assetId = _entityPortraitId({ type: u.type, title: u.title });
      const src = (this.renderer && assetId) ? this.renderer.getPortraitDataURL(assetId, 56) : null;
      return src
        ? `<img class="replay-step-icon" src="${src}" style="border-color:${u.color}" alt="">`
        : `<span class="replay-step-icon" style="background:${u.color}">${u.glyph}</span>`;
    };
    // Small gang-up ally icons shown beneath a combatant.
    const miniIcon = (u) => {
      const assetId = _entityPortraitId({ type: u.type, title: u.title });
      const src = (this.renderer && assetId) ? this.renderer.getPortraitDataURL(assetId, 32) : null;
      return src
        ? `<img class="replay-ally-icon" src="${src}" style="border-color:${u.color}" alt="">`
        : `<span class="replay-ally-icon" style="background:${u.color}">${u.glyph}</span>`;
    };
    const alliesHtml = (allies) => (allies && allies.length)
      ? `<div class="replay-allies">${allies.map(miniIcon).join('')}</div>`
      : '';
    const unit = (u, allies) => u
      ? `<div class="replay-unit">${iconImg(u)}<div class="replay-unit-name">${esc(u.name)}</div>`
        + `${alliesHtml(allies)}</div>`
      : `<span class="replay-cell"></span>`;
    // Discovered units (1+) occupy the target cell, hidden until revealed —
    // each shown as an icon + name.
    const discoveredCell = (units) =>
      `<div class="replay-unit replay-discovered"><div class="replay-discovered-icons">`
      + units.map(u => `<div class="replay-disc-unit">${iconImg(u)}`
          + `<div class="replay-unit-name">${esc(u.name)}</div></div>`).join('')
      + `</div></div>`;
    const out = (text, kind) => text
      ? `<div class="replay-step-outcome ${kind}">${text}</div>`
      : `<span class="replay-cell"></span>`;

    let actorOut, centerOut, targetOut;
    if (entry.outcomeKind) {
      // Battle: outcome word centred, HP changes under each combatant.
      const word = battleOutcomeWord(entry);
      const kind = entry.killed ? 'kill' : entry.outcomeKind;
      actorOut  = out(entry.actorDmg > 0 ? `COUNTER −${entry.actorDmg}` : '', 'counter');
      centerOut = out(word, kind);
      targetOut = out(entry.targetDmg > 0 ? `−${entry.targetDmg}` : '', kind);
    } else {
      // Move / explore / etc.: the note (BLOCKED / "+1 RESOURCE") sits centred.
      // Loot/explore notes carry resource glyphs (e.g. " Wood" / " Herbs"); tint
      // each by type so the glyph reads brown/green while the label stays
      // ambient. Non-resource notes (BLOCKED / FOUND SURVIVOR / …) pass through
      // unchanged — tintResourceGlyphs only touches the six resource PUA glyphs.
      actorOut  = out('', '');
      centerOut = entry.note ? out(tintResourceGlyphs(entry.note.text), entry.note.kind) : out('', '');
      targetOut = out('', '');
    }

    // Battles flank the (two-line) action word with each side's final roll,
    // the winner's roll highlighted. The roll-breakdown tooltip is the
    // in-game explanation of advantage/gang-up (battle dialog is retired).
    // Rendered as a game-styled hover panel ([data-tip-html]) rather than a
    // native title tooltip.
    let actionHtml;
    if (entry.outcomeKind && entry.atkRoll != null && entry.defRoll != null) {
      const word = esc(entry.label).replace(' ', '<br>');
      const atkCls = entry.attackerWon ? 'winner' : 'loser';
      const defCls = entry.attackerWon ? 'loser' : 'winner';
      const bkdHtml = buildRollRowsTipHtml(entry.rollRows, entry, {
        portraitFor: (u) => {
          const assetId = _entityPortraitId({ type: u.type, title: u.title });
          return (this.renderer && assetId) ? this.renderer.getPortraitDataURL(assetId, 36) : null;
        },
      });
      const tip = bkdHtml
        ? ` data-tip-html="${encodeURIComponent(bkdHtml)}"`
        : '';
      actionHtml = `<div class="replay-step-action battle"${tip}>`
        + `<span class="replay-roll ${atkCls}">${entry.atkRoll}</span>`
        + `<span class="replay-action-word">${word}</span>`
        + `<span class="replay-roll ${defCls}">${entry.defRoll}</span>`
        + `</div>`;
    } else {
      actionHtml = `<div class="replay-step-action">${esc(entry.label).replace(' ', '<br>')}</div>`;
    }

    return `<div class="replay-step-entry" data-entity="${entry.entityId ?? ''}"`
         + ` data-action="${entry.actionType}" data-entry="${entryIdx}">`
         + unit(entry.actor, entry.actorAllies)
         + actionHtml
         + (entry.discovered?.length ? discoveredCell(entry.discovered) : unit(entry.target, entry.targetAllies))
         + actorOut + centerOut + targetOut
         + `</div>`;
  }

  /**
   * Mark a single entry in `stepIndex` as the one being performed right now
   * (used to walk through serialized battles). Clears any prior highlight in
   * that column.
   */
  highlightReplayEntry(stepIndex, entityId) {
    const col = this._replayCol(stepIndex);
    if (!col) return;
    col.querySelectorAll('.replay-step-entry').forEach(e => e.classList.remove('is-acting'));
    col.querySelectorAll(`.replay-step-entry[data-entity="${entityId}"]`)
      .forEach(e => e.classList.add('is-acting'));
    this._autoScrollActiveEntry(col);
  }

  /**
   * Highlight every entry of the given action type(s) at once — used when a
   * phase animates several actions simultaneously (e.g. all moves together).
   * Clears any prior highlight in the column.
   */
  highlightReplayActions(stepIndex, types) {
    const col = this._replayCol(stepIndex);
    if (!col) return;
    const set = new Set(types);
    col.querySelectorAll('.replay-step-entry').forEach(e =>
      e.classList.toggle('is-acting', set.has(e.getAttribute('data-action'))));
    this._autoScrollActiveEntry(col);
  }

  /** Reveal one ACTION's rolls + outcome once that action has resolved. */
  revealReplayEntryOutcome(stepIndex, entityId) {
    const col = this._replayCol(stepIndex);
    if (!col) return;
    col.querySelectorAll(`.replay-step-entry[data-entity="${entityId}"]`).forEach(entry =>
      entry.querySelectorAll('.replay-step-outcome, .replay-roll, .replay-discovered').forEach(o => o.classList.add('revealed')));
  }

  /** Look up a step column element by index. When `stepIndex` is a follower of
   *  a compacted card (one of the quiet turns folded into a leader column), the
   *  leader's column is returned — so highlightReplayEntry / revealOutcome /
   *  advance calls keyed on a follower step still land on its merged card. */
  _replayCol(stepIndex) {
    const track = this._el('replay-timeline-track');
    if (!track) return null;
    const leaderKey = this._replayStepLeader?.get?.(String(stepIndex));
    const key = leaderKey != null ? leaderKey : stepIndex;
    return track.querySelector(`.replay-step-col[data-step="${key}"]`);
  }

  /**
   * Mark the column for animation step `stepIndex` active. At most three cards
   * show: the previous (just-finished) card peeking half-off the left edge, the
   * active card opaque at the left of the screen, and the next card translucent
   * to its right — everything else hidden. The track slides one card left as
   * steps advance. If the step is hidden (fogged → no card), the previously-
   * active card stays put.
   */
  setReplayTimelineStep(stepIndex) {
    const cols = this._replayCols();
    if (!cols.length) return;
    // Resolve a follower step to its compacted-card leader so an advance call
    // on a folded turn lands on (i.e. holds) the same merged card. Without
    // this, _animateResolutionSteps' per-step setReplayTimelineStep(i) would
    // silently miss for follower steps and the card would never highlight.
    const leaderKey = this._replayStepLeader?.get?.(String(stepIndex));
    const key = leaderKey != null ? String(leaderKey) : String(stepIndex);
    let ord = cols.findIndex(c => c.getAttribute('data-step') === key);
    if (ord < 0) ord = this._activeReplayOrd ?? 0;
    this._setReplayActiveOrd(ord);
  }

  /** All rendered timeline cards (step cards + the wrap-up card) in DOM order. */
  _replayCols() {
    const track = this._el('replay-timeline-track');
    return track ? Array.from(track.querySelectorAll('.replay-step-col')) : [];
  }

  /**
   * Activate the ord-th visible card. At most three cards show: the previous one
   * peeking half-off the left edge, the active card opaque at the left, and the
   * next card translucent to its right. The track slides one card left as the
   * active ordinal advances. Shared by step playback and review scrubbing.
   */
  _setReplayActiveOrd(ord) {
    const track = this._el('replay-timeline-track');
    const container = this._el('replay-timeline');
    if (!track || !container) return;
    const cols = Array.from(track.querySelectorAll('.replay-step-col'));
    if (!cols.length) return;
    ord = Math.max(0, Math.min(cols.length - 1, ord));
    this._activeReplayOrd = ord;
    cols.forEach((col, j) => col.classList.toggle('is-current', j === ord));
    this._renderReplayDots(cols.length, ord);

    // Anchor the active card a sixth in from the left on desktop, centred on
    // mobile — the SAME in playback and review. The track slides to keep the
    // active card at that spot; in review (CSS .reviewing) the other cards stay
    // visible, so scrubbing ◀ ▶ scrolls them in/out at the screen's width.
    const active = cols[ord];
    if (typeof active.offsetLeft !== 'number') return;
    const cw = container.clientWidth || 0;
    const anchorX = this._isMobileViewport() ? cw / 2 : cw / 6;
    const target = anchorX - (active.offsetLeft + active.offsetWidth / 2);
    this._replayTrackX = target;
    track.style.transform = `translateX(${target}px)`;
    const progress = this._el('replay-progress');
    if (progress && typeof container.offsetLeft === 'number') {
      progress.style.left = `${container.offsetLeft + anchorX}px`;
    }
  }

  /** Render the round-progress dots (one per card, active filled). */
  _renderReplayDots(count, active) {
    const dots = this._el('replay-dots');
    if (!dots) return;
    let html = '';
    for (let i = 0; i < count; i++) html += `<span class="replay-dot${i === active ? ' filled' : ''}"></span>`;
    dots.innerHTML = html;
  }

  // ── End-of-turn review: wrap-up card + scrub arrows ──────────────────────

  /**
   * Append the turn wrap-up card to the timeline (same card format) with a
   * Continue button and an optional Replay button, then enter review mode:
   * left/right arrows scrub through every card without re-animating. Resolves
   * with 'next' (Continue) or 'replay' (Replay).
   *
   * @param {object} opts { titleHtml, bodyHtml, canReplay }
   * @returns {Promise<'next'|'replay'>}
   */
  showReplayWrapUp({ titleHtml = 'Turn Complete', combats = [], discoveries = [], loot = [], attrition = [], attritionLevel = 0, canReplay = true, humanFaction = null } = {}) {
    // Remember whose units the local player controls so a board click on one of
    // them can dismiss this wrap-up as Continue. Falls back to state.myFaction
    // (set for online/async) when not passed explicitly.
    this._wrapUpFaction = humanFaction ?? this.state?.myFaction ?? null;
    const track = this._el('replay-timeline-track');
    const wrap  = this._el('replay-timeline');
    if (!track || !wrap) return Promise.resolve('next');
    wrap.classList.add('visible');

    const replayBtn = canReplay
      ? `<button class="replay-wrapup-btn" data-act="replay">↺ Replay</button>` : '';
    const card = document.createElement('div');
    card.className = 'replay-step-col replay-wrapup';
    card.setAttribute('data-step', 'wrapup');
    card.innerHTML =
      `<div class="replay-step-label">${titleHtml}</div>`
      + `<div class="replay-wrapup-body">${this._buildWrapUpBody(combats, attritionLevel, discoveries, loot, attrition)}</div>`
      + `<div class="replay-wrapup-actions">${replayBtn}`
      + `<button class="replay-wrapup-btn primary" data-act="next">Continue ▸</button></div>`;
    track.appendChild(card);

    // Show scrub arrows and jump to the wrap-up card.
    this._enterReplayReview();
    this._setReplayActiveOrd(this._replayCols().length - 1);

    return new Promise(resolve => {
      let autoTimer = null;
      const finish = (action) => {
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
        card.querySelectorAll('.replay-wrapup-btn').forEach(b => { b.onclick = null; });
        this._wrapUpResolve = null;   // wrap-up dismissed — stop intercepting board clicks
        this._exitReplayReview();
        resolve(action);
      };
      card.querySelectorAll('.replay-wrapup-btn').forEach(btn => {
        btn.onclick = () => finish(btn.getAttribute('data-act'));
      });
      // Expose the resolver so a board/unit click while the summary is up can
      // resolve it as Continue (the same teardown as the Continue button) —
      // see _onClick. Cleared in finish() so it never leaks across rounds.
      this._wrapUpResolve = finish;
      // Autorun: auto-advance the wrap-up after a watchable pause so the mission
      // plays unattended. Manual clicks still work and cancel the timer.
      if (this.aiAutorun && !this.tutorialMode) {
        autoTimer = setTimeout(() => finish('next'), this.aiAutorunDelay);
      }
    });
  }

  /**
   * Build the wrap-up body: each combat as [icon] vs [icon] with HP loss (or a
   * skull) beneath each unit, plus the node-score dots reused from the bottom
   * score bar.
   */
  _buildWrapUpBody(combats, attritionLevel = 0, discoveries = [], loot = [], attrition = []) {
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const iconFor = (u, size, cls) => {
      const assetId = _entityPortraitId({ type: u.type, title: u.title });
      const src = (this.renderer && assetId) ? this.renderer.getPortraitDataURL(assetId, size) : null;
      return wrapupIconHtml(u, { src, cls });
    };
    let combatHtml = buildWrapupCombatsHtml(combats, (u, size) => iconFor(u, size, 'wrapup-unit-icon'));
    if (!combatHtml) combatHtml = `<div class="wrapup-line muted">A quiet turn.</div>`;

    // Survivors/zombies discovered this round — icon + name, reusing the old
    // summary modal's "found" list.
    let foundHtml = '';
    if (discoveries.length) {
      const cells = discoveries.map(u => {
        const name = (u.type === 'survivor' && u.name) ? u.name : (u.title ?? u.displayName ?? u.type);
        return `<div class="wrapup-found-unit">${iconFor(u, 48, 'wrapup-found-icon')}`
          + `<div class="wrapup-found-name">${esc(String(name))}</div></div>`;
      }).join('');
      const zombies = discoveries.every(u => u.type === 'zombie');
      const label = zombies ? 'Risen' : 'Found';
      foundHtml = `<div class="wrapup-found"><div class="wrapup-found-label">${label}</div>`
        + `<div class="wrapup-found-row">${cells}</div></div>`;
    }

    // Resources looted from exploration this round — tally identical icons so
    // e.g. two wood reads "🪵 ×2".
    let lootHtml = '';
    if (loot.length) {
      const tally = new Map();
      for (const it of loot) { const k = String(it).replace(/^\+/, ''); tally.set(k, (tally.get(k) ?? 0) + 1); }
      // Tint each pip's leading resource glyph by type (wood brown, herbs green,
      // …) while the label text stays ambient. esc() runs first for safety; the
      // resource PUA glyphs are not &<> so they survive escaping, and
      // tintResourceGlyphs wraps only those six glyphs — horse/weapon pips pass
      // through ambient.
      const pips = [...tally.entries()].map(([label, n]) =>
        `<span class="wrapup-loot-pip">${tintResourceGlyphs(esc(label))}${n > 1 ? `<span class="wrapup-loot-x">×${n}</span>` : ''}</span>`
      ).join('');
      lootHtml = `<div class="wrapup-loot"><div class="wrapup-found-label">Looted</div>`
        + `<div class="wrapup-loot-row">${pips}</div></div>`;
    }

    // Night attrition roll-call — who took hazard damage in the open and who
    // was sheltered by a building / fortification this round.
    let attritionListHtml = '';
    if (attrition.length) {
      const rows = attrition.map(a => {
        if (a.kind === 'kill') {
          // DOT deaths carry their cause in `text` ("🩸 X succumbs to
          // bleeding!"); night-attrition kills keep the classic copy.
          const note = a.text
            ? esc(String(a.text).replace(/^\uE097\s*/, ''))
            : `${esc(a.name)} <span class="wrapup-attr-note">consumed by the night</span>`;
          return `<div class="wrapup-attr-row hurt">${ICON.defeat} ${note}</div>`;
        }
        if (a.kind === 'damage') {
          return `<div class="wrapup-attr-row hurt">${ICON.night} ${esc(a.name)} <span class="wrapup-attr-dmg">−${a.amount} HP</span> <span class="wrapup-attr-note">exposed</span></div>`;
        }
        const icon = a.shelter === 'building' ? '\uE03C' : '\uE03B';
        const desc = a.shelter === 'building' ? 'sheltered in building' : 'sheltered by fort';
        return `<div class="wrapup-attr-row safe">${icon} ${esc(a.name)} <span class="wrapup-attr-note">${desc}</span></div>`;
      }).join('');
      attritionListHtml = `<div class="wrapup-attr"><div class="wrapup-found-label">${ICON.night} Night Attrition</div>`
        + `<div class="wrapup-attr-rows">${rows}</div></div>`;
    }

    let scoreHtml = '';
    if (this.state?.witchObjectives) {
      const { html } = buildObjectivesHtml(
        this.state.witchObjectives, this.state.entities, this.state.nodeScore, this.state.gameMode);
      scoreHtml = `<div class="wrapup-score">${html}</div>`;
    }

    // Night-attrition escalation warning, folded in from its old modal.
    let attritionHtml = '';
    if (attritionLevel > 0) {
      attritionHtml = `<div class="wrapup-attrition">${ICON.night} The curse deepens — exposed survivors `
        + `now take <b>${attritionLevel}</b> damage each night.</div>`;
    }
    return attritionHtml + combatHtml + foundHtml + lootHtml + attritionListHtml + scoreHtml;
  }

  /** Show the prev/next scrub arrows above the active card. */
  _enterReplayReview() {
    // Review mode: reveal ALL cards at once (CSS .reviewing) and show the scrub
    // arrows flanking the dots. ◀ ▶ just shift which card is emphasised.
    this._replayReviewMode = true;
    this._el('replay-timeline')?.classList.add('reviewing');
    this._el('replay-progress')?.classList.add('review');
    const prev = document.getElementById('replay-review-prev');
    const next = document.getElementById('replay-review-next');
    if (prev) prev.onclick = () => this._setReplayActiveOrd((this._activeReplayOrd ?? 0) - 1);
    if (next) next.onclick = () => this._setReplayActiveOrd((this._activeReplayOrd ?? 0) + 1);
    // The manual-step control bar isn't relevant during review.
    const hud = this._el('replay-hud');
    if (hud) hud.style.display = 'none';
  }

  /** Leave review (hide arrows, back to single-card layout). */
  _exitReplayReview() {
    this._replayReviewMode = false;
    this._el('replay-timeline')?.classList.remove('reviewing');
    this._el('replay-progress')?.classList.remove('review');
  }

  /** Reveal the outcome lines for a step once it has played out. */
  revealReplayOutcome(stepIndex) {
    // Route follower steps in a compacted run to the leader's column so its
    // shared outcome reveals together — see _replayCol.
    const col = this._replayCol(stepIndex);
    if (!col) return;
    // Reveal the dice rolls, outcome badges, and discovered units together.
    col.querySelectorAll('.replay-step-outcome, .replay-roll, .replay-discovered').forEach(o => o.classList.add('revealed'));
  }

  /** Re-hide a step's rolls/outcomes (used when a step is replayed). */
  hideReplayOutcome(stepIndex) {
    const col = this._replayCol(stepIndex);
    if (!col) return;
    col.querySelectorAll('.replay-step-outcome, .replay-roll, .replay-discovered').forEach(o => o.classList.remove('revealed'));
  }

  /** Hide and clear the timeline overlay. */
  hideReplayTimeline() {
    this._clearReplayHoverHighlight();
    const wrap  = this._el('replay-timeline');
    const track = this._el('replay-timeline-track');
    if (wrap) wrap.classList.remove('visible', 'reviewing');
    if (track) track.innerHTML = '';
    if (typeof document !== 'undefined') document.body?.classList?.remove('replay-timeline-up');
    this._el('replay-progress')?.classList.remove('visible', 'review');
    const dots = this._el('replay-dots');
    if (dots) dots.innerHTML = '';
    this._replayReviewMode = false;
    this._replayDigest = null;
    this._replayStepLeader = null;
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
function _buildTerrainBadge(tile, nodeBadge = '') {
  const parts = [];
  const label = tile.building ? (BUILDING_LABEL[tile.building] ?? 'Building') : (legacyTileType(tile) ?? '');
  parts.push(label);
  if (tile.explored) {
    parts.push('<span class="usb-terrain-explored">Explored</span>');
  }
  if (tile.fortifyLevel) {
    // Show the fort HP within its current level band, e.g. "L2 · 34/40 HP".
    // The pool maxes at level × per-level; a unit attacked here chips this pool
    // every swing, downgrading the level the moment it crosses a threshold.
    const lvl    = tile.fortifyLevel;
    const hp     = tile.fortifyHP ?? lvl * FORTIFY_HP_PER_LEVEL;
    const lvlMax = lvl * FORTIFY_HP_PER_LEVEL;
    parts.push(`<span class="usb-terrain-fort">${coloredResourceIcon('metal')} Fort L${lvl} · ${hp}/${lvlMax} HP</span>`);
  }
  if (nodeBadge) {
    parts.push(nodeBadge);
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
  const GLYPHS = { hero: '\uE000', witch: '\uE001', survivor: '\uE002', soldier: '\uE003', zombie: '\uE005', minion: '\uE004', wood_golem: '\uE006', iron_golem: '\uE007' };
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

  // Stats line — one heart per DAMAGE_SCALE HP chunk so scaled pools (e.g. a
  // 98/70 HP hero) render at the same ~14/10 hearts they did pre-scaling.
  const hpNow  = entity.hp ?? 0;
  const hpMax  = entity.maxHp ?? entity.hp ?? 0;
  const fullHearts  = Math.round(hpNow / DAMAGE_SCALE);
  const totalHearts = Math.max(fullHearts, Math.round(hpMax / DAMAGE_SCALE));
  const hearts = '\uE088'.repeat(fullHearts) + '\uE089'.repeat(Math.max(0, totalHearts - fullHearts));
  let statsHtml = hearts;
  if (showStats && entity.attack !== undefined) {
    const atk = attackOf(entity);
    const def = defenseOf(entity);
    const atkStr = `${atk}${entity.attackBonus ? `+${entity.attackBonus}` : ''}`;
    const defStr = `${def}${entity.defenseBonus ? `+${entity.defenseBonus}` : ''}`;
    statsHtml = `${hearts} · ATK ${atkStr} · DEF ${defStr}`;
  }

  const cls    = selectable ? 'tile-unit-card selectable' : 'tile-unit-card';
  const dataId = selectable ? ` data-unit-id="${entity.id}"` : '';

  return `<div class="${cls}"${dataId}>${portraitHtml}<span class="tile-unit-card-name" style="color:${color}">${label}</span><span class="tile-unit-card-stats">${statsHtml}</span></div>`;
}

function _combatantHTML(snap, role, portraitSrc = null) {
  const label      = role === 'atk' ? '\uE000 Attacker' : '\uE042 Defender';
  const color      = ENTITY_COLOR[snap.type] || '#888';
  const hpPct      = (snap.hp / snap.maxHp) * 100;
  const hpColor    = hpPct > 50 ? '#4caf50' : hpPct > 25 ? '#ff9800' : '#f44336';
  const portraitHtml = portraitSrc
    ? `<img src="${portraitSrc}" style="width:56px;height:56px;border-radius:50%;border:2px solid ${color};display:block;margin:0 auto 0.35rem;">`
    : '';
  return `
    ${portraitHtml}
    <div class="combatant-name" style="color:${color}">${snap.name}${levelPillHtml(snap.level)}</div>
    <div style="font-size:var(--fs-2xs);color:#7a7060;margin-bottom:0.3rem">${label}</div>
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

  const GANGUP_TIP = 'Gang-up: each ally adjacent to the target adds +1 advantage die and +1 flat (max 3).';
  const rows = [];
  const add = (label, val, sign, tip = null) => rows.push({ label, val, sign, tip });
  if (side === 'atk') {
    add(`${snap.name} ATK`, snap.attack, 'base', 'Base attack stat (including equipped weapon).');
    if (snap.attackBonus)    add('\uE013 Silver',          snap.attackBonus,    'pos', 'Silver weapon bonus.');
    if (bd.phaseBonus)       add('\uE023 Night',           bd.phaseBonus,       'pos', 'Phase bonus — the night favors the witch’s forces.');
    if (bd.atkStaffBonus)    add('\uE08A Staff (undead)',   bd.atkStaffBonus,    'pos', 'Weapon trigger — the staff is potent against undead defenders.');
    if (bd.atkFortAtkBonus)  add('\uE03B Fort ATT',        bd.atkFortAtkBonus,  'pos', 'Attacking from a fortified tile.');
    const atkAllyNames = bd.atkAllyNames ?? [];
    const atkAllyContrib = Math.min(atkAllyNames.length, bd.atkGangupFlat || 0);
    if (atkAllyContrib > 0) {
      for (let i = 0; i < atkAllyContrib; i++) add(`${ICON.players} ${atkAllyNames[i]}`, 1, 'pos', GANGUP_TIP);
    } else if (bd.atkGangupFlat) {
      add('\uE080 Gang-up flat', bd.atkGangupFlat, 'pos', GANGUP_TIP);
    }
  } else {
    add(`${snap.name} DEF`, snap.defense, 'base', 'Base defense stat (including equipped weapon).');
    if (snap.defenseBonus)  add('\uE042 Bonus DEF',   snap.defenseBonus,  'pos', 'Temporary defense bonus.');
    if (bd.fortBonus)       add('\uE03B Fort DEF',    bd.fortBonus,       'pos', 'Fortification — each fort level on the defender’s tile adds defense.');
    if (bd.fatiguePenalty)  add('\uE08B Fatigue',     -bd.fatiguePenalty, 'neg', 'Fatigue — defending repeatedly in one round wears the defender down.');
    const defAllyNames = bd.defAllyNames ?? [];
    const defAllyContrib = Math.min(defAllyNames.length, bd.defGangupFlat || 0);
    if (defAllyContrib > 0) {
      for (let i = 0; i < defAllyContrib; i++) add(`${ICON.players} ${defAllyNames[i]}`, 1, 'pos', GANGUP_TIP);
    } else if (bd.defGangupFlat) {
      add('\uE080 Allies flat', bd.defGangupFlat, 'pos', GANGUP_TIP);
    }
  }
  return { pool, picked, advantage, rows, total };
}

// Tooltip for the dice-pool row — explains the advantage mechanic in place.
function _poolTip(advantage) {
  if (advantage > 0) {
    return `Advantage ${advantage}: rolls ${1 + advantage} dice and keeps the BEST. ` +
      'Gang-up allies adjacent to the target grant +1 die each (max 3); some weapons and effects add more.';
  }
  if (advantage < 0) {
    return `Disadvantage ${-advantage}: rolls ${1 - advantage} dice and keeps the WORST ` +
      '(e.g. a ranged unit firing point-blank).';
  }
  return 'A single d6 — no advantage on this roll.';
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
      `<div class="bkd-row bkd-pool-row"${_signAttr(poolSign)} title="${_poolTip(d.advantage)}">` +
        `<span class="bkd-label">${_poolLabel(d.advantage)}</span>` +
        `<span class="bkd-pool-discards">${discards.join('')}</span>` +
        `<span class="bkd-pool-picked-slot">${pickedHTML}</span>` +
      `</div>`
    );
  }
  for (const r of d.rows) {
    const v = r.val >= 0 ? '+' + r.val : r.val;
    const tip = r.tip ? ` title="${r.tip}"` : '';
    parts.push(
      `<div class="bkd-row"${_signAttr(r.sign)}${tip}><span class="bkd-label">${r.label}</span><span class="bkd-val">${v}</span></div>`
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
  poolRow.title = _poolTip(d.advantage);
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
    if (r.tip) row.title = r.tip;
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


// ── Game-styled tooltip (replaces native title tooltips) ────────────────────
//
// One shared floating element, shown on hover over any node carrying
// `data-tip` (plain text) or `data-tip-html` (encodeURIComponent'd HTML —
// used by the turn cards' roll breakdown). Hover-only: touch devices skip
// the whole subsystem (they have their own tap affordances, e.g. the
// cycle/score info panel). Module-level singleton so repeated UIController
// constructions never stack document listeners.

let _gttBound = false;
let _gttEl = null;

export function initGameTooltips() {
  if (_gttBound || typeof document === 'undefined') return;
  if (typeof window !== 'undefined' && window.matchMedia
      && !window.matchMedia('(hover: hover)').matches) return;
  _gttBound = true;

  const hide = () => { _gttEl?.classList.remove('visible'); };
  const show = (target) => {
    const html = target.dataset.tipHtml;
    const text = target.dataset.tip;
    if (!html && !text) { hide(); return; }
    if (!_gttEl) {
      _gttEl = document.createElement('div');
      _gttEl.id = 'game-tooltip';
      document.body.appendChild(_gttEl);
    }
    if (html) _gttEl.innerHTML = decodeURIComponent(html);
    else      _gttEl.textContent = text;
    _gttEl.classList.add('visible');
    // Position above the target, clamped to the viewport; flip below when
    // there's no headroom. Inside a replay turn card, the popup goes below
    // (or beside) the WHOLE card so the card it explains stays readable.
    const card = target.closest?.('.replay-step-col');
    const { x, y } = computeGameTooltipPos({
      targetRect: target.getBoundingClientRect(),
      cardRect:   card ? card.getBoundingClientRect() : null,
      tipW: _gttEl.offsetWidth,
      tipH: _gttEl.offsetHeight,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    });
    _gttEl.style.left = `${x}px`;
    _gttEl.style.top  = `${y}px`;
  };

  document.addEventListener('mouseover', (e) => {
    const t = e.target?.closest?.('[data-tip], [data-tip-html]');
    if (t) show(t);
    else hide();
  }, { passive: true });
  // Any press or scroll dismisses — the tooltip must never sit over a tap.
  document.addEventListener('mousedown', hide, { passive: true, capture: true });
  window.addEventListener('scroll', hide, { passive: true, capture: true });
  document.addEventListener('mouseleave', hide, { passive: true });
}

