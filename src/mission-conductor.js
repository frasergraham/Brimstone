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

// ── Hint suppression (localStorage) ──────────────────────────────────────────

const HINTS_SEEN_PREFIX = 'bs_hints_done_';
const VOICE_MUTED_KEY   = 'bs_tutorial_voice_muted';

function _storageGet(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function _storageSet(key, value) {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* private mode etc. */ }
}

/** True when the player has already seen (or skipped) this mission's hints. */
export function areHintsSuppressed(missionId) {
  return _storageGet(HINTS_SEEN_PREFIX + missionId) === '1';
}

/** Permanently mark a mission's hints as seen — they won't show on replay. */
export function markHintsSeen(missionId) {
  _storageSet(HINTS_SEEN_PREFIX + missionId, '1');
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
    this._spotlitEl = null;
    this._hexArrowRAF = null; // rAF handle re-anchoring an arrow to a map hex
    this._voiceAudio  = null; // currently playing narration clip

    if (this._nextBtn) {
      this._nextBtn.addEventListener('click', () => this._onNextClick());
    }
    if (this._skipLink) {
      this._skipLink.addEventListener('click', (e) => { e.preventDefault(); this._onSkipHints(); });
      this._skipLink.style.display = 'none';
    }
    if (this._voiceBtn) {
      this._voiceBtn.addEventListener('click', () => this._toggleVoiceMuted());
      this._voiceBtn.style.display = this._config.voiceKey ? '' : 'none';
      this._syncVoiceBtn();
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
    if (this._tooltip) this._tooltip.style.display = 'none';
    if (this._skipLink) this._skipLink.style.display = 'none';
    if (this.renderer) this.renderer.tutorialSpotlightHex = null;
    if (this.ui) {
      this.ui.tutorialClickBlocked = false;
      this.ui.tutorialSubmitBlocked = false;
    }
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

    // Update tooltip content
    if (this._titleEl) this._titleEl.textContent = step.title;
    if (this._bodyEl)  this._bodyEl.textContent  = step.body;

    // Position tooltip. Blocking dialogs are ALWAYS centered — off-to-the-side
    // dialogs don't get read (see tests/tutorial.test.js step lint).
    const isDialogStep = (step.trigger === 'click' || step.trigger === 'complete');
    if (this._tooltip) {
      const pos = isDialogStep ? 'center' : (step.tooltipPos ?? 'center');
      this._tooltip.className = `tutorial-tooltip tutorial-tooltip--${pos}`;
      this._tooltip.style.display = 'block';
    }

    // Button label
    if (this._nextBtn) {
      if (step.trigger === 'complete') {
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

    // Spotlight
    this._clearSpotlight();
    if (step.spotlight) this._applySpotlight(step.spotlight);

    // Narration
    this._playVoice(step);
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

    if (step.trigger === 'click') {
      this._completeStep();
    }
    // Other triggers (action_queued etc.) are gated by the appropriate hooks
  }

  _onSkipHints() {
    this._config.onSkipHints?.();
    this.destroy();
  }

  _applySpotlight(target) {
    if (target.type === 'hex') {
      this.renderer.tutorialSpotlightHex = { col: target.col, row: target.row };
      if (this._redraw) this._redraw();
      if (target.arrow && this._arrowEl) {
        this._startHexArrow(target.col, target.row, target.arrow);
      }
    } else if (target.type === 'element') {
      const el = document.querySelector(target.selector);
      if (el) {
        el.classList.add('tutorial-spotlit');
        this._spotlitEl = el;
      }
      if (target.arrow && this._arrowEl) {
        this._showArrow(target.selector, target.arrow);
      }
    }
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
   */
  _startHexArrow(col, row, direction) {
    if (typeof this.renderer?.getHexScreenPosition !== 'function') return;
    if (typeof requestAnimationFrame !== 'function') return;
    this._stopHexArrow();

    const HALF = 26; // approximate on-screen half-extent of a hex at default zoom
    const tick = () => {
      const pos = this.renderer.getHexScreenPosition(col, row);
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
      this._spotlitEl.classList.remove('tutorial-spotlit');
      this._spotlitEl = null;
    }
    if (this.renderer) this.renderer.tutorialSpotlightHex = null;
    if (this._backdrop) this._backdrop.classList.remove('active');
    this._stopHexArrow();
    if (this._arrowEl) this._arrowEl.style.display = 'none';
  }

  // ── Voiceover ───────────────────────────────────────────────────────────────
  // Optional per-step narration. Clips live at
  // assets/voice/<config.voiceKey>/<stepId>.mp3 (generated by
  // scripts/generate-voiceover.mjs). Missing clips fail silently.

  _voiceMuted() {
    return _storageGet(VOICE_MUTED_KEY) === '1';
  }

  _toggleVoiceMuted() {
    const muted = !this._voiceMuted();
    _storageSet(VOICE_MUTED_KEY, muted ? '1' : '0');
    this._syncVoiceBtn();
    if (muted) this._stopVoice();
    else this._playVoice(this._steps[this._step]);
  }

  _syncVoiceBtn() {
    if (!this._voiceBtn) return;
    this._voiceBtn.textContent = this._voiceMuted() ? '🔇' : '🔊';
    this._voiceBtn.title = this._voiceMuted() ? 'Unmute narration' : 'Mute narration';
  }

  _playVoice(step) {
    this._stopVoice();
    if (!step || !this._config.voiceKey || this._voiceMuted()) return;
    if (typeof Audio !== 'function') return;
    const base = this._config.voiceBasePath ?? 'assets/voice';
    const audio = new Audio(`${base}/${this._config.voiceKey}/${step.id}.mp3`);
    audio.addEventListener('error', () => { /* missing clip = silent step */ });
    this._voiceAudio = audio;
    audio.play().catch(() => { /* autoplay restriction before first gesture */ });
  }

  _stopVoice() {
    if (this._voiceAudio) {
      try { this._voiceAudio.pause(); } catch { /* already stopped */ }
      this._voiceAudio = null;
    }
  }
}
