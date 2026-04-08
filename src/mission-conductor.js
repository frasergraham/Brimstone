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
 */

import { PlanActionType } from './planner.js';
import { EntityType } from './entities.js';

// ── MissionConductor ─────────────────────────────────────────────────────────

export class MissionConductor {
  /**
   * @param {object}   state    — GameState
   * @param {object}   ui       — UIController
   * @param {object}   renderer — Renderer
   * @param {function} redraw   — () => void
   * @param {Array}    steps    — step definitions (see tutorial-config.js for shape)
   * @param {object}   config   — conductor configuration:
   *   roundStepMap:       { [round]: stepId } — jump to stepId at start of planning for that round
   *   witchPlanProvider:  (round, state) => PlanAction[] — scripted witch plan per round
   *   forcedDice:         [{ round, dice }] — deterministic dice for specific rounds
   *   maxPlanningRounds:  number — after this many rounds, stop entering planning mode
   *   onComplete:         () => void — called when the last step is reached
   */
  constructor(state, ui, renderer, redraw, steps, config = {}) {
    this.state    = state;
    this.ui       = ui;
    this.renderer = renderer;
    this._redraw  = redraw;
    this._steps   = steps;
    this._config  = config;
    this._step    = -1;   // current step index; -1 = not started
    this._round   = 0;    // rounds completed (incremented after each resolution)
    this._pendingAdvance = null; // setTimeout handle for auto steps

    this._backdrop = document.getElementById('tutorial-backdrop');
    this._tooltip  = document.getElementById('tutorial-tooltip');
    this._titleEl  = this._tooltip?.querySelector('.tut-title');
    this._bodyEl   = this._tooltip?.querySelector('.tut-body');
    this._nextBtn  = this._tooltip?.querySelector('.tut-next-btn');
    this._arrowEl  = document.getElementById('tutorial-arrow');
    this._spotlitEl = null;

    if (this._nextBtn) {
      this._nextBtn.addEventListener('click', () => this._onNextClick());
    }
  }

  /** Kick off the conductor from step 0. */
  start() {
    this._showStep(0);
  }

  get currentStepId() {
    return this._steps[this._step]?.id ?? null;
  }

  // ── Lifecycle hooks called by main.js ───────────────────────────────────────

  /**
   * Called at the start of each local planning phase.
   * Cancels any pending auto-advance timeout and jumps to the correct step
   * for the current round based on config.roundStepMap.
   */
  onPlanningPhaseStart() {
    if (this._pendingAdvance !== null) {
      clearTimeout(this._pendingAdvance);
      this._pendingAdvance = null;
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
   */
  shouldPlan() {
    const max = this._config.maxPlanningRounds;
    return max == null || this._round < max;
  }

  /**
   * Whether the player is allowed to submit their plan right now.
   * Returns true only when the current step expects plan_submitted trigger,
   * preventing the player from skipping required action steps.
   */
  canSubmitPlan() {
    const step = this._steps[this._step];
    if (!step) return true; // no step = no restriction
    return step.trigger?.type === 'plan_submitted';
  }

  /** Called by ui.onEntitySelected when the player clicks a unit. */
  onEntitySelected(entity) {
    const step = this._steps[this._step];
    if (!step) return;
    const t = step.trigger;
    if (t?.type === 'entity_selected' && entity.type === t.entityType) {
      this._advance();
    }
  }

  /** Called by ui.onPlanActionAdded when a plan action is queued. */
  onActionQueued(action) {
    const step = this._steps[this._step];
    if (!step) return;
    const t = step.trigger;
    if (t?.type === 'action_queued' && t.actionType === action.type) {
      this._advance();
    }
  }

  /** Called by main.js when the human submits their plan. */
  onPlanSubmitted() {
    const step = this._steps[this._step];
    if (!step) return;
    if (step.trigger?.type === 'plan_submitted') {
      this._advance();
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
    this._clearSpotlight();
    if (this._tooltip) this._tooltip.style.display = 'none';
    if (this.renderer) this.renderer.tutorialSpotlightHex = null;
    if (this.ui) this.ui.tutorialClickBlocked = false;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _showStep(idx) {
    if (idx < 0 || idx >= this._steps.length) return;
    this._step = idx;
    const step = this._steps[idx];

    // Update tooltip content
    if (this._titleEl) this._titleEl.textContent = step.title;
    if (this._bodyEl)  this._bodyEl.textContent  = step.body;

    // Position tooltip
    if (this._tooltip) {
      this._tooltip.className = `tutorial-tooltip tutorial-tooltip--${step.tooltipPos ?? 'center'}`;
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

    // Block map clicks during dialog steps (waiting for button)
    if (this.ui) {
      const isDialogStep = (step.trigger === 'click' || step.trigger === 'complete');
      this.ui.tutorialClickBlocked = isDialogStep;
    }

    // Spotlight
    this._clearSpotlight();
    if (step.spotlight) this._applySpotlight(step.spotlight);
  }

  _advance() {
    const next = this._step + 1;
    if (next >= this._steps.length) {
      this.destroy();
      return;
    }
    this._showStep(next);
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
      this._advance();
    }
    // Other triggers (action_queued etc.) are gated by the appropriate hooks
  }

  _applySpotlight(target) {
    if (target.type === 'hex') {
      this.renderer.tutorialSpotlightHex = { col: target.col, row: target.row };
      if (this._redraw) this._redraw();
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

    const rect = el.getBoundingClientRect();
    const arrow = this._arrowEl;

    arrow.className = 'tutorial-arrow tutorial-arrow--' + direction;

    switch (direction) {
      case 'up':
        arrow.style.left = (rect.left + rect.width / 2) + 'px';
        arrow.style.top  = (rect.top - 8) + 'px';
        break;
      case 'down':
        arrow.style.left = (rect.left + rect.width / 2) + 'px';
        arrow.style.top  = (rect.bottom + 8) + 'px';
        break;
      case 'left':
        arrow.style.left = (rect.left - 8) + 'px';
        arrow.style.top  = (rect.top + rect.height / 2) + 'px';
        break;
      case 'right':
        arrow.style.left = (rect.right + 8) + 'px';
        arrow.style.top  = (rect.top + rect.height / 2) + 'px';
        break;
    }

    arrow.style.display = 'block';
  }

  _clearSpotlight() {
    if (this._spotlitEl) {
      this._spotlitEl.classList.remove('tutorial-spotlit');
      this._spotlitEl = null;
    }
    if (this.renderer) this.renderer.tutorialSpotlightHex = null;
    if (this._backdrop) this._backdrop.classList.remove('active');
    if (this._arrowEl) this._arrowEl.style.display = 'none';
  }
}
