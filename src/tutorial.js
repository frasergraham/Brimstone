/**
 * Tutorial mode — guided walkthrough of core game mechanics.
 *
 * TutorialConductor drives a scripted step sequence on a fixed 9×9 map.
 * It hooks into UIController callbacks (onPlanActionAdded, onEntitySelected)
 * and is called by main.js at key lifecycle moments (planning start, plan
 * submitted, resolution complete).
 *
 * No witch on the map — the tutorial uses noWitch mode.
 * A minion spawns adjacent to the hero after round 1 via the wave system.
 *
 * Tutorial map entities:
 *   Hero   at INN    (2,7) — human player
 *   HOUSE  at (2,3) — contains a hidden survivor, revealed in round 3
 *   Minion at (3,5) — spawned via wave after round 1; combat target in round 2
 *
 * Round timeline:
 *   Round 1 — Hero moves to Church (2,5) and explores
 *   Round 2 — Hero attacks Minion; forced dice produce a crush kill
 *   Round 3 — Hero moves to House (2,3) and explores; finds a survivor
 *   After  — Explanation steps (multi-select, fortify, score, guard) → done
 */

import { TUTORIAL_STEPS } from './tutorial/tutorial-config.js';
import { PlanActionType } from './planner.js';
import { EntityType } from './entities.js';

export { TUTORIAL_STEPS };

// ── TutorialConductor ─────────────────────────────────────────────────────────

export class TutorialConductor {
  /**
   * @param {object}   state    — GameState
   * @param {object}   ui       — UIController
   * @param {object}   renderer — Renderer
   * @param {function} redraw   — () => void
   */
  constructor(state, ui, renderer, redraw) {
    this.state    = state;
    this.ui       = ui;
    this.renderer = renderer;
    this._redraw  = redraw;
    this._step    = -1;   // current step index; -1 = not started
    this._round   = 0;    // tutorial rounds completed (incremented after each resolution)
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

  /** Kick off the tutorial from step 0. */
  start() {
    this._showStep(0);
  }

  get currentStepId() {
    return TUTORIAL_STEPS[this._step]?.id ?? null;
  }

  // ── Lifecycle hooks called by main.js ───────────────────────────────────────

  /**
   * Called at the start of each local planning phase.
   * Cancels any pending auto-advance timeout and jumps to the correct step
   * for the current round.
   */
  onPlanningPhaseStart() {
    // Cancel any pending auto-advance so it doesn't fire after we've jumped
    if (this._pendingAdvance !== null) {
      clearTimeout(this._pendingAdvance);
      this._pendingAdvance = null;
    }

    if (this._round === 1) {
      this._showStep(TUTORIAL_STEPS.findIndex(s => s.id === 'combat_intro'));
    } else if (this._round === 2) {
      this._showStep(TUTORIAL_STEPS.findIndex(s => s.id === 'survivor_intro'));
    } else if (this._round === 3) {
      this._showStep(TUTORIAL_STEPS.findIndex(s => s.id === 'multi_select'));
    }
    // round 0: no jump needed — tutorial begins at step 0 (welcome)
  }

  /** Called by ui.onEntitySelected when the player clicks a unit. */
  onEntitySelected(entity) {
    const step = TUTORIAL_STEPS[this._step];
    if (!step) return;
    const t = step.trigger;
    if (t?.type === 'entity_selected' && entity.type === t.entityType) {
      this._advance();
    }
  }

  /** Called by ui.onPlanActionAdded when a plan action is queued. */
  onActionQueued(action) {
    const step = TUTORIAL_STEPS[this._step];
    if (!step) return;
    const t = step.trigger;
    if (t?.type === 'action_queued' && t.actionType === action.type) {
      this._advance();
    }
  }

  /** Called by main.js when the human submits their plan. */
  onPlanSubmitted() {
    const step = TUTORIAL_STEPS[this._step];
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
    // Schedule a brief pause so players can see the resolution before the
    // tooltip changes.  onPlanningPhaseStart will cancel this if it fires
    // before the timeout (which it always does — it's synchronous).
    this._pendingAdvance = setTimeout(() => {
      this._pendingAdvance = null;
      if (TUTORIAL_STEPS[this._step]?.trigger === 'auto') {
        this._advance();
      }
    }, 900);
  }

  /**
   * Returns the scripted witch plan for the current round.
   * round 0: witch idles (witchPlan:[] from submit_plan step)
   * round 1: minion attacks the hero (minion was spawned by wave after round 1)
   * round 2+: witch idles
   */
  getWitchPlan() {
    if (this._round === 0) {
      // Fetch from the current plan-submission step's witchPlan field
      const step = TUTORIAL_STEPS[this._step];
      return step?.witchPlan ?? [];
    }
    if (this._round === 1) {
      // Round 2: minion fights back
      const minion = this.state.entities.find(
        e => e.type === EntityType.MINION && e.owner === 'witch' && e.alive
      );
      const hero = this.state.entities.find(e => e.type === EntityType.HERO && e.alive);
      if (minion && hero) {
        return [{ type: PlanActionType.BATTLE_UNIT, entityId: minion.id, targetId: hero.id, targetCol: hero.col, targetRow: hero.row }];
      }
    }
    // Round 3+: witch idles
    return [];
  }

  /** Clean up all overlays. Called when tutorial ends or player quits. */
  destroy() {
    if (this._pendingAdvance !== null) {
      clearTimeout(this._pendingAdvance);
      this._pendingAdvance = null;
    }
    this._clearSpotlight();
    if (this._tooltip) this._tooltip.style.display = 'none';
    if (this.renderer) this.renderer.tutorialSpotlightHex = null;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _showStep(idx) {
    if (idx < 0 || idx >= TUTORIAL_STEPS.length) return;
    this._step = idx;
    const step = TUTORIAL_STEPS[idx];

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
      if (step.trigger === 'start_game') {
        this._nextBtn.textContent   = 'Start a Real Game →';
        this._nextBtn.style.display = 'block';
      } else if (step.trigger === 'click') {
        this._nextBtn.textContent   = 'Got it →';
        this._nextBtn.style.display = 'block';
      } else {
        // Action-gated or auto steps: hide the button
        this._nextBtn.style.display = 'none';
      }
    }

    // Spotlight
    this._clearSpotlight();
    if (step.spotlight) this._applySpotlight(step.spotlight);
  }

  _advance() {
    const next = this._step + 1;
    if (next >= TUTORIAL_STEPS.length) {
      this.destroy();
      return;
    }
    this._showStep(next);
  }

  _onNextClick() {
    const step = TUTORIAL_STEPS[this._step];
    if (!step) return;

    if (step.trigger === 'start_game') {
      this.destroy();
      location.reload();
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
      // Show directional arrow if specified
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

    // Reset classes
    arrow.className = 'tutorial-arrow tutorial-arrow--' + direction;

    // Position arrow near the target element based on direction
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
