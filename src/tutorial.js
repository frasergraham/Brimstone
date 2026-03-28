/**
 * Tutorial mode — guided walkthrough of core game mechanics.
 *
 * TutorialConductor drives a scripted 24-step sequence on a fixed 9×9 map.
 * It hooks into UIController callbacks (onPlanActionAdded, onEntitySelected)
 * and is called by main.js at key lifecycle moments (planning start, plan
 * submitted, resolution complete).
 *
 * The Witch plays a scripted plan each round — no AI involved.
 *
 * Tutorial map entities:
 *   Hero   at INN    (2,6) — human player
 *   Witch  at GRAVEYARD (7,1) — scripted, never acts aggressively
 *   Minion at (3,5) — spawned by initTutorial(); serves as combat target
 *   HOUSE  at (2,4) — contains a hidden survivor, revealed in round 3
 *
 * Round timeline:
 *   Round 1 — Hero moves to Church (2,5) and explores
 *   Round 2 — Hero attacks Minion; Minion counter-attacks (canned dice)
 *   Round 3 — Hero moves to House (2,4) and explores; finds a survivor
 *   After  — Explanation steps (fortify, score tracker, power nodes) → done
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
//                   'auto'         → advances automatically via onPlanningPhaseStart
//                   'start_game'   → shows "Start a Real Game →" button
//                   { type: 'entity_selected', entityType }
//                   { type: 'action_queued',   actionType }
//                   { type: 'plan_submitted' }
//   spotlight   — what to highlight:
//                   null
//                   { type: 'hex',     col, row }
//                   { type: 'element', selector }
//   tooltipPos  — 'center' | 'bottom-left' | 'bottom-right'
//   witchPlan   — scripted witch plan for this round (null = N/A)

export const TUTORIAL_STEPS = [
  // ── Intro ──────────────────────────────────────────────────────────────────

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
    id: 'click_stages',
    title: 'How Clicking Works',
    body: 'Clicking a unit has three stages:\n\n1st click → Select the unit. Green hexes show where it can move. Click a green hex to queue a Move.\n\n2nd click (on the unit again) → Open the action menu — Move, Explore, Battle, etc.\n\nClick empty space → Deselect.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },

  // ── Round 1: Move to Church + Explore ─────────────────────────────────────

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
    body: 'Your hero\'s ghost is now at the Church. Click the ghost (the Church hex) to open the action menu there.\n\nThe ghost shows where your hero will be after the move — actions are planned from that position. Choose Explore to search the Church for supplies.',
    trigger: { type: 'action_queued', actionType: PlanActionType.EXPLORE },
    spotlight: { type: 'hex', col: 2, row: 5 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'submit_plan',
    title: 'Submit Your Plan',
    body: 'Your plan is ready: Move to Church, then Explore. Click Submit Plan — both sides will act simultaneously.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn' },
    tooltipPos: 'bottom-left',
    witchPlan: [], // witch idles in round 1
  },
  {
    id: 'watch_r1',
    title: 'Resolution',
    body: 'Watch both sides act at once. Your hero walks to the Church and searches it.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Round 2: Combat (onPlanningPhaseStart jumps here when _round === 1) ───

  {
    id: 'day_night',
    title: 'Day / Night Cycle',
    body: 'The bar below the header tracks the 8-round cycle: 🌅 Dawn → ☀ Day → 🌇 Dusk → 🌙 Night.\n\nDay gives the Hero +1 ATK. Night gives the Witch +1 ATK. Dawn and Dusk score Power Nodes.\n\nAttrition also rises each Dawn — undead and survivors left in the open will start to suffer.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#cycle-bar' },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'combat_intro',
    title: 'Time to Fight',
    body: 'A Witch Minion lurks to the east — adjacent to your hero.\n\n1st click your Hero to select them. 2nd click your Hero to open the action menu, choose Battle, then click the Minion to queue the attack.\n\nYou can queue multiple attacks in one round — just repeat the sequence to add another hit to your plan.',
    trigger: { type: 'action_queued', actionType: PlanActionType.BATTLE_UNIT },
    spotlight: { type: 'hex', col: 3, row: 5 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'combat_formula',
    title: 'How Combat Works',
    body: 'Both sides roll d6 + their stat:\n• Hit   — attacker\'s roll beats defender\'s → 1 damage\n• Crush — attacker rolls ≥ 2× defender → 2 damage\n• Counter — defender rolls ≥ 2× attacker → 1 damage to attacker\n\nAllies adjacent to the fight add extra d3 dice to their side.',
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
    tooltipPos: 'bottom-left',
    witchPlan: null, // set dynamically by getWitchPlan() for round 2
  },
  {
    id: 'watch_r2',
    title: 'Combat Resolved',
    body: 'Both attacks landed. The minion lives but is wounded. Your hero took a hit too — that\'s the risk of close combat.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Round 3: Survivor rescue (onPlanningPhaseStart jumps here when _round === 2) ──

  {
    id: 'survivor_intro',
    title: 'Find Allies',
    body: 'Salem\'s survivors will join the Hero\'s cause if you find them.\n\nThere\'s a House to the north of the Church. Move your Hero there and explore — someone is hiding inside.',
    trigger: 'click',
    spotlight: { type: 'hex', col: 2, row: 4 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'move_to_house',
    title: 'Move to the House',
    body: 'Click your Hero (1st click to select), then click the House hex to queue a Move north.',
    trigger: { type: 'action_queued', actionType: PlanActionType.MOVE },
    spotlight: { type: 'hex', col: 2, row: 4 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'explore_house',
    title: 'Explore the House',
    body: 'Your hero\'s ghost is now at the House. Click the ghost to open the action menu, then choose Explore to search it.',
    trigger: { type: 'action_queued', actionType: PlanActionType.EXPLORE },
    spotlight: { type: 'hex', col: 2, row: 4 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'submit_r3',
    title: 'Submit and Explore!',
    body: 'Submit your plan. Your hero will move to the House and search it.',
    trigger: { type: 'plan_submitted' },
    spotlight: { type: 'element', selector: '#plan-submit-btn' },
    tooltipPos: 'bottom-left',
    witchPlan: [], // witch idles in round 3
  },
  {
    id: 'watch_r3',
    title: 'A Survivor Found!',
    body: 'A survivor joins your cause. They now share the hex with your Hero.',
    trigger: 'auto',
    spotlight: null,
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },

  // ── Explanation steps (onPlanningPhaseStart jumps here when _round === 3) ──

  {
    id: 'multi_select',
    title: 'Multiple Units on a Hex',
    body: 'Multiple units can share a hex. Click the hex once to select one unit — the number badge shows how many are stacked.\n\nClick the hex again to cycle to the next unit, or open the 🔍 Tile Detail (the magnifying glass button) to see everyone at a glance and pick who to command.',
    trigger: 'click',
    spotlight: { type: 'hex', col: 2, row: 4 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'fortify',
    title: 'Fortification',
    body: 'The Hero can spend 1 Wood to fortify a building (+1 DEF, up to level 4). A fortified position makes the Hero much harder to kill.\n\nSpend 1 Metal instead for +2 DEF in one action. The Innkeeper survivor doubles the bonus from Wood.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'score_tracker',
    title: 'Score Tracker',
    body: 'The bar at the bottom of the screen shows who controls each Power Node (orange = Hero, purple = Witch, grey = neutral) alongside score pips for each side.\n\nAt each Dawn and Dusk, whoever holds more nodes scores 1 point — shown as filled pips. First to 4 points wins by node control.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#score-bar' },
    tooltipPos: 'center',
    witchPlan: null,
  },
  {
    id: 'power_nodes',
    title: 'Power Nodes ⛧',
    body: 'The glowing symbol in the centre is a Power Node. Seize it and hold it through scoring checkpoints to rack up points.\n\nSeizing all 3 Nodes at once is an instant win — so never let the Witch control all three at the same time.',
    trigger: 'click',
    spotlight: { type: 'hex', col: 4, row: 4 },
    tooltipPos: 'bottom-left',
    witchPlan: null,
  },
  {
    id: 'complete',
    title: 'You\'re Ready!',
    body: 'That\'s the core loop: plan actions, submit, watch resolution, repeat.\n\nExplore buildings for weapons and survivors, fortify positions, and seize the Power Nodes.\n\nGood luck in Salem.',
    trigger: 'start_game',
    spotlight: null,
    tooltipPos: 'center',
    witchPlan: null,
  },
];

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
      this._showStep(TUTORIAL_STEPS.findIndex(s => s.id === 'day_night'));
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
   * round 1: minion attacks the hero
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
        return [{ type: PlanActionType.BATTLE_UNIT, entityId: minion.id, targetId: hero.id }];
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
