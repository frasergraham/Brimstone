/**
 * MissionConductor — guided step-driven overlay for campaign missions.
 *
 * Generalized from TutorialConductor so any campaign mission can provide
 * a step sequence with blocking dialogs, hex/element spotlights, directional
 * arrows, and action-gated progression.
 *
 * The conductor hooks into UIController callbacks (onPlanActionAdded,
 * onEntitySelected) and is called by main.js at key lifecycle moments
 * (planning start, plan submitted, resolution complete).
 *
 * Configuration is data-driven via the `steps` array and `config` object
 * passed to the constructor. See tutorial-config.js for an example.
 *
 * ── Modes ────────────────────────────────────────────────────────────────────
 * 'scripted' (default) — the tutorial model: a linear step sequence that owns
 *   the mission (scripted opponent plans, forced dice, submit gating, and a
 *   `complete` step that ends the mission).
 * 'hints' — micro-lessons riding along a NORMAL AI-driven mission. Steps are
 *   independent one-shot hints activated at planning start by round
 *   (config.roundStepMap, keyed by state.round) or by a `when(state)`
 *   predicate. Hints never block the map or the submit button; a gated hint
 *   dismisses when its action happens or when the plan is submitted. A
 *   "Skip hints" link suppresses the mission's hints permanently
 *   (localStorage), and main.js marks them seen on mission victory.
 */

import { PlanActionType } from './planner.js';
import { EntityType } from './entities.js';
import { isVoiceMuted, toggleVoiceMuted, playVoiceClip, stopVoice, voiceMuteIconHtml } from './voiceover.js';

// ── Hint suppression (localStorage) ──────────────────────────────────────────

const HINTS_SEEN_PREFIX = 'bs_hints_done_';

function _storageGet(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function _storageSet(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* private mode etc. */ }
}
function _storageRemove(key) {
  try { globalThis.localStorage?.removeItem(key); } catch { /* private mode etc. */ }
}

/** True when the player has already seen (or skipped) this mission's hints. */
export function areHintsSuppressed(missionId) {
  return _storageGet(HINTS_SEEN_PREFIX + missionId) === '1';
}

/** Permanently mark a mission's hints as seen — they won't show on replay. */
export function markHintsSeen(missionId) {
  _storageSet(HINTS_SEEN_PREFIX + missionId, '1');
}

/**
 * Clear the seen/skipped flag for one mission so its hints fire again next time.
 * Inverse of markHintsSeen.
 */
export function resetMissionHints(missionId) {
  _storageRemove(HINTS_SEEN_PREFIX + missionId);
}

/**
 * Re-enable hints for every mission in a campaign (undoes Skip Hints and the
 * auto-mark-seen that happens on mission victory). Returns the number of
 * missions whose hints were suppressed before the reset.
 */
export function resetAllHintsForCampaign(campaignDef) {
  let cleared = 0;
  for (const mission of campaignDef?.missions ?? []) {
    if (areHintsSuppressed(mission.id)) cleared++;
    resetMissionHints(mission.id);
  }
  return cleared;
}

// ── MissionConductor ─────────────────────────────────────────────────────────

export class MissionConductor {
  /**
   * @param {object}   state    — GameState
   * @param {object}   ui       — UIController
   * @param {object}   renderer — Renderer
   * @param {function} redraw   — () => void
   * @param {Array}    steps    — step definitions (see tutorial-config.js for shape).
   *   In addition to the tutorial fields, steps may carry:
   *     optional: true       — never blocks map clicks or plan submission
   *     when: (state) => bool — hints mode: activate when the predicate is true
   * @param {object}   config   — conductor configuration:
   *   mode:               'scripted' (default) | 'hints' — see module docs
   *   roundStepMap:       { [round]: stepId } — jump to stepId at start of planning
   *                        for that round (scripted: conductor round counter,
   *                        starting at 0; hints: state.round, starting at 1)
   *   witchPlanProvider:  (round, state) => PlanAction[] — scripted witch plan per round
   *   forcedDice:         [{ round, dice }] — deterministic dice for specific rounds
   *   maxPlanningRounds:  number — after this many rounds, stop entering planning mode
   *   onComplete:         () => void — called when the last step is reached
   *   onSkipHints:        () => void — hints mode: called when the player skips
   *   voiceKey:           string — play assets/voice/<voiceKey>/<stepId>.mp3 per step
   *   voiceBasePath:      string — override the voice asset root (default 'assets/voice')
   */
  constructor(state, ui, renderer, redraw, steps, config = {}) {
    this.state    = state;
    this.ui       = ui;
    this.renderer = renderer;
    this._redraw  = redraw;
    this._steps   = steps;
    this._config  = config;
    this._mode    = config.mode === 'hints' ? 'hints' : 'scripted';
    this._step    = -1;   // current step index; -1 = not started / dismissed
    this._round   = 0;    // rounds completed (incremented after each resolution)
    this._pendingAdvance = null; // setTimeout handle for auto steps
    this._shownStepIds = new Set(); // hints mode: each hint fires at most once

    this._backdrop = document.getElementById('tutorial-backdrop');
    this._tooltip  = document.getElementById('tutorial-tooltip');
    this._titleEl  = this._tooltip?.querySelector('.tut-title');
    this._bodyEl   = this._tooltip?.querySelector('.tut-body');
    this._nextBtn  = this._tooltip?.querySelector('.tut-next-btn');
    this._skipLink = this._tooltip?.querySelector('.tut-skip-link');
    this._voiceBtn = this._tooltip?.querySelector('.tut-voice-btn');
    this._arrowEl  = document.getElementById('tutorial-arrow');
    this._pulseEl  = document.getElementById('tutorial-pulse-circle');
    this._spotlitEl = null;
    this._hexArrowRAF = null; // rAF handle re-anchoring an arrow to a map hex
    this._hexPulseRAF = null; // rAF handle re-anchoring the pulse ring to a hex
    this._elemAnchorRAF = null; // rAF handle re-anchoring arrow + pulse to a DOM element
    this._voiceAudio  = null; // currently playing narration clip

    // Bind handlers once so destroy() can remove them. The tooltip buttons are
    // shared DOM singletons reused across every mission, so a listener left
    // dangling after destroy() would keep this (dead) conductor alive and fire
    // its onComplete/onSkipHints when a LATER mission's button is clicked.
    this._onNextClickBound = () => this._onNextClick();
    this._onSkipLinkBound  = (e) => { e.preventDefault(); this._onSkipHints(); };
    this._onVoiceBtnBound  = () => this._toggleVoiceMuted();

    if (this._nextBtn) {
      this._nextBtn.addEventListener('click', this._onNextClickBound);
    }
    if (this._skipLink) {
      this._skipLink.addEventListener('click', this._onSkipLinkBound);
      this._skipLink.style.display = 'none';
    }
    if (this._voiceBtn) {
      this._voiceBtn.addEventListener('click', this._onVoiceBtnBound);
      this._voiceBtn.style.display = this._config.voiceKey ? '' : 'none';
      this._syncVoiceBtn();
    }

    // Scripted guidance owns the plan: disable the Clear and Auto-Guard buttons
    // AND the per-action edit affordances (floating UNDO buttons, plan-panel ✕
    // removes, the X clear-unit key — via ui.tutorialPlanLocked) so the player
    // can't dismantle a scripted action AFTER its step already advanced, which
    // would leave a later gated step unreachable. Restored in destroy() at the
    // handoff.
    if (this._mode === 'scripted') {
      this._lockPlanControls(true);
      if (this.ui) this.ui.tutorialPlanLocked = true;
    }
  }

  /** Enable/disable the plan controls the tutorial must own (Clear, Auto-Guard). */
  _lockPlanControls(locked) {
    for (const id of ['plan-clear-btn', 'plan-autoguard-btn']) {
      const btn = document.getElementById(id);
      if (btn) { btn.disabled = locked; btn.style.opacity = locked ? '0.4' : ''; }
    }
  }

  /** Kick off the conductor. Scripted: show step 0. Hints: wait for planning. */
  start() {
    if (this._mode === 'hints') return; // hints fire from onPlanningPhaseStart
    this._showStep(0);
  }

  get currentStepId() {
    return this._steps[this._step]?.id ?? null;
  }

  get isHints() {
    return this._mode === 'hints';
  }

  // ── Lifecycle hooks called by main.js ───────────────────────────────────────

  /**
   * Called at the start of each local planning phase.
   * Scripted: cancels any pending auto-advance timeout and jumps to the step
   * for the current round based on config.roundStepMap.
   * Hints: shows the first eligible un-shown hint — by round (state.round in
   * roundStepMap) or by `when(state)` predicate.
   */
  onPlanningPhaseStart() {
    if (this._pendingAdvance !== null) {
      clearTimeout(this._pendingAdvance);
      this._pendingAdvance = null;
    }

    if (this._mode === 'hints') {
      this._showEligibleHint();
      return;
    }

    const stepId = this._config.roundStepMap?.[this._round];
    if (stepId) {
      const idx = this._steps.findIndex(s => s.id === stepId);
      if (idx >= 0) this._showStep(idx);
    }
    // round 0: no jump needed — conductor begins at step 0
  }

  /**
   * Whether planning mode should be entered for this round.
   * Returns false after maxPlanningRounds, allowing explanation-only steps.
   * Hints mode never owns the planning loop.
   */
  shouldPlan() {
    if (this._mode === 'hints') return true;
    const max = this._config.maxPlanningRounds;
    return max == null || this._round < max;
  }

  /**
   * Whether the player is allowed to submit their plan right now.
   * Returns true only when the current step expects plan_submitted trigger,
   * preventing the player from skipping required action steps.
   * Hints and optional steps never gate submission.
   */
  canSubmitPlan() {
    const step = this._steps[this._step];
    if (!step) return true; // no step = no restriction
    if (this._mode === 'hints' || step.optional) return true;
    return step.trigger?.type === 'plan_submitted';
  }

  /** Called by ui.onEntitySelected when the player clicks a unit. */
  onEntitySelected(entity) {
    const step = this._steps[this._step];
    if (!step) return;
    const t = step.trigger;
    if (t?.type === 'entity_selected' && entity.type === t.entityType) {
      this._completeStep();
    }
  }

  /** Called by ui.onPlanActionAdded when a plan action is queued. */
  onActionQueued(action) {
    const step = this._steps[this._step];
    if (!step) return;
    const t = step.trigger;
    if (t?.type === 'action_queued' && t.actionType === action.type) {
      // Optional acting-unit filter — e.g. gate on the SURVIVOR queuing a move
      // (the shared-budget lesson) without the hero's moves advancing the step.
      if (t.entityType) {
        const actor = this.state?.entities?.find(e => e.id === action.entityId);
        if (!actor || actor.type !== t.entityType) return;
      }
      // Optional destination filter — gate a MOVE on REACHING a specific hex, so
      // a multi-hop advance only completes the step on the final leg (teaching
      // two move actions to cross the bridge).
      if (t.toCol != null && (action.toCol !== t.toCol || action.toRow !== t.toRow)) return;
      // Optional count — require N matching actions before advancing (e.g. stack
      // two attacks on the zombie before moving on).
      if ((++this._stepActionCount) < (t.count ?? 1)) return;
      // A MOVE that completes a step switches to a new (often different) unit:
      // suppress the UI's chaining re-select for this one move so the next click
      // selects fresh. A mid-chain MOVE (toCol mismatch above) returns before
      // here, leaving the selection intact so the player keeps moving this unit.
      // Exception: when the FOLLOW-UP step declares keepSelection (a chained
      // two-leg move split into one step per leg), the same unit must stay
      // selected so the next click queues its second leg.
      const followUp = this._steps[this._step + 1];
      if (action.type === PlanActionType.MOVE && this.ui && !followUp?.keepSelection) {
        this.ui._tutorialSuppressReselect = true;
      }
      this._completeStep();
    }
  }

  /** Called by main.js when the human submits their plan. */
  onPlanSubmitted() {
    const step = this._steps[this._step];
    if (!step) return;
    if (step.trigger?.type === 'plan_submitted') {
      this._completeStep();
      return;
    }
    // Optional / hint steps never hold the plan hostage — dismiss on submit.
    if (this._mode === 'hints' || step.optional) {
      this._dismiss();
    }
  }

  /**
   * Called by main.js after the resolution animation finishes.
   * Increments the round counter.  The actual step jump happens in
   * onPlanningPhaseStart (called synchronously right after this), which
   * cancels any pending timeout from here.
   */
  onResolutionComplete() {
    this._round++;
    if (this._mode === 'hints') return; // no auto steps in hints mode
    this._pendingAdvance = setTimeout(() => {
      this._pendingAdvance = null;
      if (this._steps[this._step]?.trigger === 'auto') {
        this._advance();
      }
    }, 900);
  }

  /**
   * Returns the scripted witch/opponent plan for the current round.
   * Delegates to config.witchPlanProvider if provided, else returns [].
   */
  getWitchPlan() {
    if (this._config.witchPlanProvider) {
      return this._config.witchPlanProvider(this._round, this.state, this._steps[this._step]);
    }
    return [];
  }

  /**
   * Returns forced dice for the current round, or null if none configured.
   */
  getForcedDice() {
    const entries = this._config.forcedDice;
    if (!entries) return null;
    const entry = entries.find(e => e.round === this._round);
    return entry?.dice ?? null;
  }

  /** Clean up all overlays. Called when conductor ends or player quits. */
  destroy() {
    if (this._pendingAdvance !== null) {
      clearTimeout(this._pendingAdvance);
      this._pendingAdvance = null;
    }
    this._stopVoice();
    this._clearSpotlight();
    if (this._mode === 'scripted') this._lockPlanControls(false);
    if (this._tooltip) this._tooltip.style.display = 'none';
    if (this._skipLink) this._skipLink.style.display = 'none';
    if (this.renderer) this.renderer.tutorialSpotlightHex = null;
    if (this.ui) {
      this.ui.tutorialClickBlocked = false;
      this.ui.tutorialSubmitBlocked = false;
      this.ui.tutorialAllowedHexes = null;
      this.ui.tutorialAllowedActions = null;
      this.ui.tutorialAllowedUnits = null;
      this.ui.tutorialPlanLocked = false;
    }
    // Detach the shared-button listeners added in the constructor. Without this
    // a destroyed conductor lingers (held alive by the DOM listener) and re-runs
    // its onComplete/onSkipHints when a later mission's overlay button is clicked.
    if (this._nextBtn)  this._nextBtn.removeEventListener('click', this._onNextClickBound);
    if (this._skipLink) this._skipLink.removeEventListener('click', this._onSkipLinkBound);
    if (this._voiceBtn) this._voiceBtn.removeEventListener('click', this._onVoiceBtnBound);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Hints mode: find and show the first eligible un-shown hint, if any. */
  _showEligibleHint() {
    // Round-anchored hints key on the live game round (1 = first planning).
    const byRound = this._config.roundStepMap?.[this.state?.round];
    if (byRound && !this._shownStepIds.has(byRound)) {
      const idx = this._steps.findIndex(s => s.id === byRound);
      if (idx >= 0) { this._showStep(idx); return; }
    }
    for (let i = 0; i < this._steps.length; i++) {
      const s = this._steps[i];
      if (this._shownStepIds.has(s.id) || typeof s.when !== 'function') continue;
      let eligible = false;
      try { eligible = !!s.when(this.state); } catch { /* predicate errors never break planning */ }
      if (eligible) { this._showStep(i); return; }
    }
  }

  _showStep(idx) {
    if (idx < 0 || idx >= this._steps.length) return;
    this._step = idx;
    const step = this._steps[idx];
    this._shownStepIds.add(step.id);
    this._stepActionCount = 0;  // matching action_queued count for `count`-gated steps

    // Update tooltip content
    if (this._titleEl) this._titleEl.textContent = step.title;
    if (this._bodyEl)  this._bodyEl.textContent  = step.body;

    // Position tooltip. Blocking dialogs are ALWAYS centered — off-to-the-side
    // dialogs don't get read (see tests/tutorial.test.js step lint).
    const isDialogStep = (step.trigger === 'click' || step.trigger === 'complete' || step.trigger === 'handoff');
    if (this._tooltip) {
      const pos = isDialogStep ? 'center' : (step.tooltipPos ?? 'center');
      this._tooltip.className = `tutorial-tooltip tutorial-tooltip--${pos}`;
      this._tooltip.style.display = 'block';
    }

    // Button label
    if (this._nextBtn) {
      if (step.trigger === 'complete' || step.trigger === 'handoff') {
        this._nextBtn.textContent   = step.buttonLabel ?? 'Continue →';
        this._nextBtn.style.display = 'block';
      } else if (step.trigger === 'click') {
        this._nextBtn.textContent   = 'Got it →';
        this._nextBtn.style.display = 'block';
      } else {
        // Action-gated or auto steps: hide the button
        this._nextBtn.style.display = 'none';
      }
    }

    // "Skip hints" escape hatch — hints mode only
    if (this._skipLink) {
      this._skipLink.style.display = this._mode === 'hints' ? '' : 'none';
    }

    // Block map clicks during dialog steps (waiting for button)
    // Block submit button until conductor reaches a plan_submitted step.
    // Hints and optional steps never block anything.
    if (this.ui) {
      const optional = this._mode === 'hints' || step.optional === true;
      this.ui.tutorialClickBlocked  = !optional && isDialogStep;
      this.ui.tutorialSubmitBlocked = !optional && step.trigger?.type !== 'plan_submitted';
    }

    // Strict-gating allowlists (Learn-to-Play). A non-null allowedHexes set
    // restricts which map hexes are clickable; allowedActions restricts the arc
    // menu. Dialog steps block the map outright, so their lists don't matter.
    this._publishGating(step);

    // On a Submit step, make sure the plan panel (which holds the Submit button)
    // is expanded — on mobile it collapses to a right-edge tab, leaving the button
    // hidden / rendered in the top-left corner where the spotlight can't anchor.
    if (step.trigger?.type === 'plan_submitted') {
      document.getElementById('plan-panel')?.classList.remove('collapsed');
    }

    // Spotlight (+ optional pulsing red circle on the same target). Steps that
    // gate on a specific unit acting (select-then-target: "click the unit, then
    // click the destination") get a DYNAMIC anchor — the arrow/pulse sit on the
    // unit until it's selected, then move to the destination hex.
    this._clearSpotlight();
    if (step.spotlight) {
      this._applySpotlight(step.spotlight, step.pulse === true,
        this._isSelectThenTarget(step) ? () => this._selectThenTargetPos(step) : null);
    }

    // Bring the step's click targets into view. After a resolution the camera
    // can leave the spotlit hex off-screen or under the plan panel — the pulse
    // then points at something the player can't click. Only reframe when a
    // target actually sits outside the clickable area (no surprise camera jumps
    // when everything is already visible); pan-only once the player has set a
    // zoom (frameHexes keeps their distance).
    if (step.spotlight?.type === 'hex' && typeof this.renderer?.frameHexes === 'function') {
      const hexes = [{ col: step.spotlight.col, row: step.spotlight.row }];
      for (const h of step.allowHexes ?? []) hexes.push({ col: h.col, row: h.row });
      if (!this._hexesClickable(hexes)) this.renderer.frameHexes(hexes, { paddingHexes: 2 });
    }

    // Narration
    this._playVoice(step);
  }

  /** Publish per-step click/action allowlists onto the UIController. */
  _publishGating(step) {
    if (!this.ui) return;
    this.ui.tutorialAllowedHexes = Array.isArray(step.allowHexes)
      ? new Set(step.allowHexes.map(h => `${h.col},${h.row}`))
      : null;
    const acts = step.allowActions !== undefined ? step.allowActions : this._config.actionWhitelist;
    this.ui.tutorialAllowedActions = Array.isArray(acts) ? new Set(acts) : null;
    this.ui.tutorialAllowedUnits = Array.isArray(step.allowUnits) ? new Set(step.allowUnits) : null;

    // Clear any lingering selection when JUMPING into a gated step out of band
    // (roundStepMap jumps at planning start). For a step reached by completing a
    // move, the suppress-reselect flag (set in onActionQueued, consumed by the
    // same click handler's post-move re-select) handles deselection — so we must
    // NOT touch that flag here or we'd clobber it before it's consumed. A
    // keepSelection step (second leg of a chained move) skips the clear so the
    // unit mid-journey stays selected.
    const gated = step.trigger && typeof step.trigger === 'object';
    if (gated && !step.keepSelection && typeof this.ui._clearSelection === 'function') {
      this.ui._clearSelection();
    }
  }

  /** A step's goal was met. Scripted: advance the sequence. Hints: dismiss. */
  _completeStep() {
    if (this._mode === 'hints') {
      this._dismiss();
    } else {
      this._advance();
    }
  }

  _advance() {
    const next = this._step + 1;
    if (next >= this._steps.length) {
      this.destroy();
      return;
    }
    this._showStep(next);
  }

  /** Hide the current step without advancing (hints / optional steps). */
  _dismiss() {
    this._step = -1;
    this._stopVoice();
    this._clearSpotlight();
    if (this._tooltip) this._tooltip.style.display = 'none';
    if (this.ui) {
      this.ui.tutorialClickBlocked  = false;
      this.ui.tutorialSubmitBlocked = false;
      this.ui.tutorialAllowedHexes = null;
      this.ui.tutorialAllowedActions = null;
      this.ui.tutorialAllowedUnits = null;
    }
  }

  _onNextClick() {
    const step = this._steps[this._step];
    if (!step) return;

    if (step.trigger === 'complete') {
      this.destroy();
      this._config.onComplete?.();
      return;
    }

    // Release control to free play (witch AI takes over) without ending the game.
    if (step.trigger === 'handoff') {
      this.destroy();
      this._config.onHandoff?.();
      return;
    }

    if (step.trigger === 'click') {
      this._completeStep();
    }
    // Other triggers (action_queued etc.) are gated by the appropriate hooks
  }

  _onSkipHints() {
    this._config.onSkipHints?.();
    this.destroy();
  }

  /**
   * True for steps that direct the player to select a unit and then click a
   * hex with it (a MOVE to a destination or a targeted BATTLE): the copy reads
   * "click the unit, then click the target", so the spotlight must do the same
   * — anchor on the UNIT first and only point at the target once it's selected.
   */
  _isSelectThenTarget(step) {
    const t = step.trigger;
    return step.spotlight?.type === 'hex' &&
      t?.type === 'action_queued' && t.entityType != null &&
      (t.actionType === PlanActionType.MOVE || t.actionType === PlanActionType.BATTLE_UNIT);
  }

  /**
   * Current anchor hex for a select-then-target step, re-evaluated every frame
   * by the arrow/pulse RAF loops so it self-heals on select AND deselect:
   *   unit not selected yet → the acting unit's hex (ghost-projected, so a
   *     mid-plan unit is spotlit where the player sees it);
   *   unit selected → the step's destination/target hex.
   * The acting unit is the one eligible under the step's gates (trigger
   * entityType + the UI's _tutorialCanSelect allowlists) — Learn-to-Play steps
   * gate so exactly one unit qualifies. Falls back to the destination if none.
   */
  _selectThenTargetPos(step) {
    const dest = { col: step.spotlight.col, row: step.spotlight.row };
    const ui = this.ui;
    const mover = this.state?.entities?.find(e =>
      e.alive !== false && e.type === step.trigger.entityType &&
      (typeof ui?._tutorialCanSelect !== 'function' || ui._tutorialCanSelect(e)));
    if (!mover || ui?._selectedEntity?.id === mover.id) return dest;
    const pos = (typeof ui?._getProjectedPos === 'function' && ui._getProjectedPos(mover.id)) || mover;
    return { col: pos.col, row: pos.row };
  }

  /**
   * True when every given hex projects into the CLICKABLE viewport — inside
   * the canvas with a margin, and clear of the plan panel (renderer.insetRight,
   * published by the UI when the panel is expanded). Conservatively false when
   * projection isn't available (headless / scene not ready) so callers reframe.
   */
  _hexesClickable(hexes) {
    if (typeof this.renderer?.getHexScreenPosition !== 'function') return false;
    const rect = this.renderer.canvas?.getBoundingClientRect?.();
    if (!rect || !rect.width) return false;
    const insetRight = this.renderer.insetRight ?? 0;
    const MARGIN = 40;
    return hexes.every(h => {
      const p = this.renderer.getHexScreenPosition(h.col, h.row);
      return p &&
        p.x >= rect.left + MARGIN && p.x <= rect.right - insetRight - MARGIN &&
        p.y >= rect.top  + MARGIN && p.y <= rect.bottom - MARGIN;
    });
  }

  _applySpotlight(target, pulse = false, posProvider = null) {
    if (target.type === 'hex') {
      // With the pulsing circle + arrow (Learn-to-Play) we deliberately DON'T
      // draw the gold hex disc — three overlapping highlights is too much.
      if (!pulse) {
        this.renderer.tutorialSpotlightHex = { col: target.col, row: target.row };
        if (this._redraw) this._redraw();
      }
      if (target.arrow && this._arrowEl) {
        this._startHexArrow(target.col, target.row, target.arrow, posProvider);
      }
      if (pulse && this._pulseEl) this._startHexPulse(target.col, target.row, posProvider);
    } else if (target.type === 'element') {
      const el = document.querySelector(target.selector);
      if (el) {
        // pulse:true on an ELEMENT target draws the pulsing RED outline on the
        // element itself (.tutorial-spotlit-red) — the red ring overlay is for
        // map hexes; centred on a small chip/button it would cover it. Without
        // pulse, the standard gold glow.
        el.classList.add(pulse ? 'tutorial-spotlit-red' : 'tutorial-spotlit');
        this._spotlitEl = el;
      }
      // Re-anchor only the ARROW to the element every frame (tracks layout/scroll
      // and never sticks at 0,0).
      if (target.arrow && this._arrowEl) {
        this._startElementAnchor(target.selector, target.arrow, false);
      }
    }
  }

  /** Track a DOM element across frames, positioning the arrow + pulse on it. */
  _startElementAnchor(selector, direction, pulse) {
    const place = (r) => {
      const visible = r && (r.width > 0 || r.height > 0) && r.bottom > 0 && r.right > 0;
      if (visible) {
        if (direction && this._arrowEl) this._positionArrow(r, direction);
        if (pulse && this._pulseEl) this._positionPulse(r);
      } else {
        if (direction && this._arrowEl) this._arrowEl.style.display = 'none';
        if (pulse && this._pulseEl) this._pulseEl.style.display = 'none';
      }
    };
    if (typeof requestAnimationFrame !== 'function') {
      place(document.querySelector(selector)?.getBoundingClientRect());
      return;
    }
    this._stopElementAnchor();
    const tick = () => {
      place(document.querySelector(selector)?.getBoundingClientRect());
      this._elemAnchorRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  _stopElementAnchor() {
    if (this._elemAnchorRAF != null) {
      cancelAnimationFrame(this._elemAnchorRAF);
      this._elemAnchorRAF = null;
    }
  }

  /** Center the pulsing red ring on a screen-space rect. */
  _positionPulse(rect) {
    const el = this._pulseEl;
    if (!el) return;
    el.style.left = (rect.left + rect.width / 2) + 'px';
    el.style.top  = (rect.top + rect.height / 2) + 'px';
    el.style.display = 'block';
  }

  /**
   * Anchor the pulse ring to a map hex, re-projecting every frame (camera
   * pan/zoom). An optional posProvider re-resolves WHICH hex each frame
   * (select-then-target steps move the ring from the unit to its destination).
   */
  _startHexPulse(col, row, posProvider = null) {
    if (typeof this.renderer?.getHexScreenPosition !== 'function') return;
    if (typeof requestAnimationFrame !== 'function') return;
    this._stopHexPulse();
    const tick = () => {
      const hex = posProvider ? posProvider() : { col, row };
      const pos = this.renderer.getHexScreenPosition(hex.col, hex.row);
      if (pos) {
        this._positionPulse({ left: pos.x, top: pos.y, width: 0, height: 0 });
      } else if (this._pulseEl) {
        this._pulseEl.style.display = 'none';
      }
      this._hexPulseRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  _stopHexPulse() {
    if (this._hexPulseRAF !== null) {
      cancelAnimationFrame(this._hexPulseRAF);
      this._hexPulseRAF = null;
    }
    if (this._pulseEl) this._pulseEl.style.display = 'none';
  }

  _showArrow(selector, direction) {
    const el = document.querySelector(selector);
    if (!el || !this._arrowEl) return;
    this._positionArrow(el.getBoundingClientRect(), direction);
  }

  /**
   * Place the arrow against a screen-space rect (CSS px).
   * `direction` is the way the arrow POINTS — it sits on the opposite side of
   * the target so its tip aims at the element (e.g. 'down' floats above the
   * target pointing down at it).
   */
  _positionArrow(rect, direction) {
    const arrow = this._arrowEl;
    arrow.className = 'tutorial-arrow tutorial-arrow--' + direction;
    const SIZE = 22; // triangle length along its pointing axis (see styles.css)
    const GAP  = 8;

    switch (direction) {
      case 'up':    // below the target, pointing up at it
        arrow.style.left = (rect.left + rect.width / 2) + 'px';
        arrow.style.top  = (rect.bottom + GAP) + 'px';
        break;
      case 'down':  // above the target, pointing down at it
        arrow.style.left = (rect.left + rect.width / 2) + 'px';
        arrow.style.top  = (rect.top - GAP - SIZE) + 'px';
        break;
      case 'left':  // right of the target, pointing left at it
        arrow.style.left = (rect.right + GAP) + 'px';
        arrow.style.top  = (rect.top + rect.height / 2) + 'px';
        break;
      case 'right': // left of the target, pointing right at it
        arrow.style.left = (rect.left - GAP - SIZE) + 'px';
        arrow.style.top  = (rect.top + rect.height / 2) + 'px';
        break;
    }

    arrow.style.display = 'block';
  }

  /**
   * Anchor the arrow to a map hex, re-projecting every frame so it tracks
   * camera pan/zoom. Requires renderer.getHexScreenPosition (both renderers
   * implement it); silently skips when unavailable (e.g. headless tests).
   * An optional posProvider re-resolves WHICH hex each frame (select-then-
   * target steps move the arrow from the unit to its destination).
   */
  _startHexArrow(col, row, direction, posProvider = null) {
    if (typeof this.renderer?.getHexScreenPosition !== 'function') return;
    if (typeof requestAnimationFrame !== 'function') return;
    this._stopHexArrow();

    const HALF = 26; // approximate on-screen half-extent of a hex at default zoom
    const tick = () => {
      const hex = posProvider ? posProvider() : { col, row };
      const pos = this.renderer.getHexScreenPosition(hex.col, hex.row);
      if (pos) {
        this._positionArrow(
          { left: pos.x - HALF, top: pos.y - HALF, right: pos.x + HALF, bottom: pos.y + HALF, width: HALF * 2, height: HALF * 2 },
          direction,
        );
      } else if (this._arrowEl) {
        this._arrowEl.style.display = 'none';
      }
      this._hexArrowRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  _stopHexArrow() {
    if (this._hexArrowRAF !== null) {
      cancelAnimationFrame(this._hexArrowRAF);
      this._hexArrowRAF = null;
    }
  }

  _clearSpotlight() {
    if (this._spotlitEl) {
      this._spotlitEl.classList.remove('tutorial-spotlit', 'tutorial-spotlit-red');
      this._spotlitEl = null;
    }
    if (this.renderer) this.renderer.tutorialSpotlightHex = null;
    if (this._backdrop) this._backdrop.classList.remove('active');
    this._stopHexArrow();
    this._stopHexPulse();
    this._stopElementAnchor();
    if (this._arrowEl) this._arrowEl.style.display = 'none';
  }

  // ── Voiceover ───────────────────────────────────────────────────────────────
  // Optional per-step narration. Clips live at
  // assets/voice/<config.voiceKey>/<stepId>.mp3 (generated by
  // scripts/generate-voiceover.mjs). Mute state + playback are shared with
  // campaign conversation dialog via src/voiceover.js, so one 🔊/🔇 toggle
  // covers all spoken narration. Missing clips fail silently.

  _voiceMuted() {
    return isVoiceMuted();
  }

  _toggleVoiceMuted() {
    const muted = toggleVoiceMuted();
    this._syncVoiceBtn();
    if (!muted) this._playVoice(this._steps[this._step]);
  }

  _syncVoiceBtn() {
    if (!this._voiceBtn) return;
    this._voiceBtn.innerHTML = voiceMuteIconHtml(isVoiceMuted());
    this._voiceBtn.title = isVoiceMuted() ? 'Unmute narration' : 'Mute narration';
  }

  _playVoice(step) {
    if (!step || !this._config.voiceKey) { stopVoice(); return; }
    const base = this._config.voiceBasePath ?? 'assets/voice';
    // playVoiceClip self-gates on mute and stops any clip already in flight.
    this._voiceAudio = playVoiceClip(`${base}/${this._config.voiceKey}/${step.id}.mp3`);
  }

  _stopVoice() {
    stopVoice();
    this._voiceAudio = null;
  }
}
