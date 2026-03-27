/**
 * Tutorial mode — guided walkthrough of core game mechanics.
 *
 * TutorialConductor drives a scripted 13-step sequence on a fixed 9×9 map.
 * It hooks into UIController callbacks (onPlanActionAdded, onEntitySelected)
 * and is called by main.js at key lifecycle moments (planning start, plan
 * submitted, resolution complete).
 *
 * The Witch plays a scripted plan each round — no AI involved.
 *
 * Tutorial map entities:
 *   Hero at INN (2,6) — human player
 *   Witch at GRAVEYARD (7,1) — scripted, never acts aggressively in tutorial
 *   Minion at (3,5) — spawned by initTutorial(); serves as combat target
 */

import { PlanActionType } from './planner.js';
import { EntityType } from './entities.js';

// ── Tutorial step definitions ─────────────────────────────────────────────────
//
// Each step has:
//   id          — unique string identifier
//   title       — tooltip heading
//   body        — tooltip explanation (may contain \n for line breaks)
//   trigger     — what advances the step:
//                   'click'        → "Got it →" button
//                   'auto'         → advances automatically (after resolution)
//                   'start_game'   → shows "Start a Real Game →" button
//                   { type: 'entity_selected', entityType }
//                   { type: 'action_queued',   actionType }   (PlanActionType value)
//                   { type: 'plan_submitted' }
//   spotlight   — what to highlight:
//                   null                                    → nothing
//                   { type: 'hex',     col, row }           → pulsing ring on canvas
//                   { type: 'element', selector }           → CSS glow on DOM element
//   tooltipPos  — 'center' | 'bottom-left' | 'bottom-right' (CSS class suffix)
//   witchPlan   — scripted witch plan for this round (null = no round yet / use previous)

export const TUTORIAL_STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Brimstone',
    body: 'A hero rides into cursed Salem. The witch who haunts the graveyard stirs.\n\nYou play as the ⚔ Hero. Let\'s learn the core mechanics in a few minutes.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'planning_intro',
    title: 'Simultaneous Planning',
    body: 'Each round you build a plan — an ordered list of actions. Both sides plan secretly, then everything resolves at once.\n\nNobody gets to react to the other\'s plan. Prediction wins battles.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'select_hero',
    title: 'Select Your Hero',
    body: 'Click your ⚔ Hero on the map to select them and see available actions.',
    trigger: { type: 'entity_selected', entityType: EntityType.HERO },
    spotlight: { type: 'hex', col: 2, row: 6 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'queue_move',
    title: 'Queue a Move',
    body: 'Green hexes show where you can move. Click the Church to the north to add a Move to your plan.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE },
    spotlight: { type: 'hex', col: 2, row: 5 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'ghost_arrow',
    title: 'Ghost Arrows',
    body: 'The yellow arrow shows your planned move. You can keep queuing — actions happen in order when you submit.\n\nThe number badge counts your remaining action points.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#plan-budget-badge' },
    tooltipPos: 'bottom-right',
    witchPlan: null,
  },
  {
    id: 'queue_explore',
    title: 'Explore a Building',
    body: 'Click your Hero again (at the Inn). Their ghost is now at the Church, so Explore will appear in the action menu — queue it to search for supplies.',
    trigger: { type: 'action_queued', actionType: PlanActionType.EXPLORE },
    spotlight: { type: 'hex', col: 2, row: 6 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'submit_plan',
    title: 'Submit Your Plan',
    body: 'Your plan is ready: Move to Church, then Explore. Click Submit Plan — both sides will act simultaneously.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn' },
    tooltipPos: 'bottom-right',
    witchPlan: [], // witch idles in round 1
  },
  {
    id: 'watch_resolution',
    title: 'Resolution',
    body: 'Watch both sides act at once. Your hero walks to the Church and searches it.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'combat_intro',
    title: 'Time to Fight',
    body: 'A Witch Minion lurks to the east — adjacent to your hero. Select your Hero and click Battle in the action menu, then click the Minion.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT },
    spotlight: { type: 'hex', col: 3, row: 5 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'combat_formula',
    title: 'How Combat Works',
    body: 'Both sides roll d6 + their stat:\n• Hit   — attacker\'s roll beats defender\'s\n• Crush — attacker rolls ≥ 2× defender → 2 damage\n• Counter — defender rolls ≥ 2× attacker → 1 damage to attacker\n\nAllies adjacent to the fight add extra d3 dice.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'submit_fight',
    title: 'Submit and Fight!',
    body: 'Submit your plan. The minion will fight back — watch the dice resolve!',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn' },
    tooltipPos: 'bottom-right',
    witchPlan: null, // set dynamically by getWitchPlan() for round 2
  },
  {
    id: 'power_nodes',
    title: 'Power Nodes ⛧',
    body: 'The glowing symbol in the centre is a Power Node. At each Dawn and Dusk, whoever holds more nodes scores 1 point.\n\nFirst to 4 score points (or slaying the enemy leader) wins the game.',
    trigger: 'click',
    spotlight: { type: 'hex', col: 4, row: 4 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'complete',
    title: 'You\'re Ready!',
    body: 'That\'s the core loop: plan actions, submit, watch resolution, repeat.\n\nExplore buildings for weapons and survivors, fortify positions, summon minions (if you\'re the Witch), and seize the Power Nodes.\n\nGood luck in Salem.',
    trigger: 'start_game',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
];

// Step IDs that mark the start of a new planning round (when to show the tooltip again)
const ROUND_START_STEPS = new Set(['select_hero', 'combat_intro']);

// ── TutorialConductor ─────────────────────────────────────────────────────────

export class TutorialConductor {
  /**
   * @param {object} state    — GameState
   * @param {object} ui       — UIController
   * @param {object} renderer — Renderer
   * @param {function} redraw — () => void
   */
  constructor(state, ui, renderer, redraw) {
    this.state    = state;
    this.ui       = ui;
    this.renderer = renderer;
    this._redraw  = redraw;
    this._step    = -1;     // current step index; -1 = not started
    this._round   = 0;      // tutorial rounds completed (0 = before first submit)

    this._backdrop = document.getElementById('tutorial-backdrop');
    this._tooltip  = document.getElementById('tutorial-tooltip');
    this._titleEl  = this._tooltip?.querySelector('.tut-title');
    this._bodyEl   = this._tooltip?.querySelector('.tut-body');
    this._nextBtn  = this._tooltip?.querySelector('.tut-next-btn');
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

  /** Called at the start of each local planning phase. */
  onPlanningPhaseStart() {
    // After round 1 resolves we're back in planning — jump to combat_intro.
    if (this._round === 1 && this._step >= TUTORIAL_STEPS.findIndex(s => s.id === 'watch_resolution')) {
      this._showStep(TUTORIAL_STEPS.findIndex(s => s.id === 'combat_intro'));
    }
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

  /** Called by main.js after the resolution animation finishes. */
  onResolutionComplete() {
    this._round++;
    const step = TUTORIAL_STEPS[this._step];
    if (!step) return;
    if (step.trigger === 'auto') {
      // Brief pause so the player can see the result before the tooltip advances
      setTimeout(() => this._advance(), 900);
    }
  }

  /**
   * Returns the scripted witch plan for the current round.
   * Round 1: witch idles.
   * Round 2: witch minion attacks the hero.
   */
  getWitchPlan() {
    if (this._round === 0) {
      // Round 1 — fetch from the current plan-submission step's witchPlan field
      const step = TUTORIAL_STEPS[this._step];
      return step?.witchPlan ?? [];
    }
    if (this._round === 1) {
      // Round 2 — minion fights back
      const minion = this.state.entities.find(e => e.type === EntityType.MINION && e.owner === 'witch' && e.alive);
      const hero   = this.state.entities.find(e => e.type === EntityType.HERO && e.alive);
      if (minion && hero) {
        return [{ type: PlanActionType.BATTLE_UNIT, entityId: minion.id, targetId: hero.id }];
      }
    }
    return [];
  }

  /** Clean up all overlays. Called when tutorial ends or player quits. */
  destroy() {
    this._clearSpotlight();
    if (this._tooltip) this._tooltip.style.display = 'none';
    this.renderer.tutorialSpotlightHex = null;
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
        this._nextBtn.textContent  = 'Start a Real Game →';
        this._nextBtn.style.display = 'block';
      } else if (step.trigger === 'click') {
        this._nextBtn.textContent  = 'Got it →';
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
      // Return to the main menu so the player can start a normal game
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
    }
  }

  _clearSpotlight() {
    if (this._spotlitEl) {
      this._spotlitEl.classList.remove('tutorial-spotlit');
      this._spotlitEl = null;
    }
    if (this.renderer) this.renderer.tutorialSpotlightHex = null;
    if (this._backdrop) this._backdrop.classList.remove('active');
  }
}
