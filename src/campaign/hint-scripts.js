// ═══════════════════════════════════════════════════════════════════════════
// Chapter 1 micro-lesson hint scripts
// ─────────────────────────────────────────────────────────────────────────────
// Each Chapter 1 mission teaches 1–3 mechanics the prologue tutorial deferred,
// at the moment they matter (fortify when night is coming, equip when a weapon
// drops). The scripts run through MissionConductor in 'hints' mode: the mission
// stays fully AI-driven, hints never block the map or the submit button, a
// gated hint dismisses when its action happens (or on submit), and each hint
// fires at most once. Hints are suppressed on replay once the mission has been
// completed (see areHintsSuppressed / markHintsSeen in mission-conductor.js).
//
// Step shape matches tutorial-config.js. Two activation paths:
//   • config.roundStepMap[round] — show at the start of planning for that game
//     round (state.round, 1 = first planning round).
//   • step.when(state) — show at the first planning start where the predicate
//     is true (for loot-dependent lessons round numbers can't anchor).
//
// Wired up via `"hints": { "scriptKey": "..." }` in the mission JSON, resolved
// through the conductor-script registry (conductor-scripts.js).
// ═══════════════════════════════════════════════════════════════════════════

import { PlanActionType } from '../planner.js';
import { EntityType } from '../entities.js';
import { nodeController } from '../game.js';
import { Side } from '../sides.js';
import { sideOf } from '../factions.js';

/** True when the owner faction fights on the player's (day) side. */
const _isPlayerSide = (owner) => sideOf(owner) === Side.DAY;

/** Any player-side unit carrying an unequipped (spare) weapon in its pack. The
 *  equipped weapon now lives in `items` too, so a spare is either a non-equipped
 *  weapon entry or an equipped one held in multiples. */
function _heroSideHasPackWeapon(state) {
  return !!state?.entities?.some(e =>
    e.alive && _isPlayerSide(e.owner) &&
    Object.entries(e.items ?? {}).some(([id, entry]) => {
      if (id === 'horse' || !_isWeapon(id)) return false;
      const count = entry?.count ?? 0;
      return entry?.equipped ? count > 1 : count > 0;
    }));
}

let _weaponIds = null;
function _isWeapon(id) {
  // Lazy import-free check: weapon ids are stable strings (see loot.config.js).
  if (!_weaponIds) {
    _weaponIds = new Set(['sword', 'axe', 'shield', 'bow', 'crossbow',
      'musket', 'pistol', 'sling', 'staff', 'dagger']);
  }
  return _weaponIds.has(id);
}

/** Any player-side unit below max HP while the side has herbs to heal with. */
function _heroSideCanHeal(state) {
  const wounded = state?.entities?.some(e =>
    e.alive && _isPlayerSide(e.owner) && e.hp < e.maxHp);
  const herbs = (state?.inventory?.hero?.herbs ?? 0) > 0;
  return !!(wounded && herbs);
}

// ── Ch1M1 "The Awakening" — guard, the chronicle ─────────────────────────────

const CH1M1_STEPS = [
  {
    id: 'm1_guard',
    title: 'Hold Your Ground',
    body: 'The dead shamble closer each round. Queue Guard and your Hero strikes anything that comes adjacent.',
    trigger: { type: 'action_queued', actionType: PlanActionType.GUARD },
    spotlight: null,
    tooltipPos: 'bottom-left',
  },
  {
    id: 'm1_chronicle',
    title: 'The Chronicle',
    body: 'Every roll and wound is written in the Chronicle — open the tab on the left to review what happened.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#chronicle-sidebar', arrow: 'left' },
    tooltipPos: 'center',
  },
];

const CH1M1_CONFIG = {
  mode: 'hints',
  roundStepMap: { 1: 'm1_guard', 3: 'm1_chronicle' },
  voiceKey: 'ch1m1',
};

// ── Ch1M2 "Gathering Survivors" — fog, objectives, equip, gang-up ───────────

const CH1M2_STEPS = [
  {
    id: 'm2_fog',
    title: 'Fog of War',
    body: 'You only see so far — and sight shrinks at night. Smoke on the horizon marks buildings worth reaching.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
  },
  {
    id: 'm2_mission_info',
    title: 'Your Orders',
    body: 'Forgot the objective? The scroll re-opens the mission briefing any time.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#mission-info-btn', arrow: 'up' },
    tooltipPos: 'center',
  },
  {
    id: 'm2_gangup',
    title: 'Gang Up',
    body: 'Attacking an enemy while an ally stands beside it boosts your roll — surround before you strike.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
    // Fires once the player has recruited a survivor to gang up with.
    when: (state) => !!state?.entities?.some(e =>
      e.alive && _isPlayerSide(e.owner) && e.type === EntityType.SURVIVOR && !e.isNpc),
  },
  {
    id: 'm2_equip',
    title: 'Arm Yourselves',
    body: 'Someone is carrying a spare weapon. Select them and choose Equip Weapon — silver blades bite cursed flesh hardest.',
    trigger: { type: 'action_queued', actionType: PlanActionType.EQUIP_WEAPON },
    spotlight: null,
    tooltipPos: 'bottom-left',
    when: _heroSideHasPackWeapon,
  },
];

const CH1M2_CONFIG = {
  mode: 'hints',
  roundStepMap: { 1: 'm2_fog', 2: 'm2_mission_info' },
  voiceKey: 'ch1m2',
};

// ── Ch1M3 "The First Night" — shelter, fortify, heal ─────────────────────────

const CH1M3_STEPS = [
  {
    id: 'm3_shelter',
    title: 'Shelter From the Dark',
    body: 'When night falls, anyone caught outside a building or fortified tile is hurt by the cold dark. Get your people indoors.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
  },
  {
    id: 'm3_fortify',
    title: 'Fortify',
    body: 'You carry wood — select a unit and choose Fortify to raise the tile\'s defenses. Fortified ground shelters and shields.',
    trigger: { type: 'action_queued', actionType: PlanActionType.FORTIFY },
    spotlight: null,
    tooltipPos: 'bottom-left',
  },
  {
    id: 'm3_heal',
    title: 'Tend the Wounded',
    body: 'Someone is hurt and you have herbs. Select them and choose Heal before the next assault.',
    trigger: { type: 'action_queued', actionType: PlanActionType.HEAL },
    spotlight: null,
    tooltipPos: 'bottom-left',
    when: _heroSideCanHeal,
  },
];

const CH1M3_CONFIG = {
  mode: 'hints',
  roundStepMap: { 1: 'm3_shelter', 2: 'm3_fortify' },
  voiceKey: 'ch1m3',
};

// ── Ch1M4 "The River Crossing" — abilities, party budget ─────────────────────

const CH1M4_STEPS = [
  {
    id: 'm4_abilities',
    title: 'Companions\' Gifts',
    body: 'Your companions carry abilities of their own — select one and look for Use Ability in the action menu.',
    trigger: { type: 'action_queued', actionType: PlanActionType.USE_ABILITY },
    spotlight: null,
    tooltipPos: 'bottom-left',
  },
  {
    id: 'm4_party_budget',
    title: 'March in Order',
    body: 'Four travellers, one action budget. Spend it on whoever is most exposed — stragglers can wait a round.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#plan-budget-badge', arrow: 'right' },
    tooltipPos: 'center',
  },
];

const CH1M4_CONFIG = {
  mode: 'hints',
  roundStepMap: { 1: 'm4_abilities', 2: 'm4_party_budget' },
  voiceKey: 'ch1m4',
};

// ── Ch1M5 "Dark Ritual" — node control, scoring checkpoints ──────────────────

const CH1M5_STEPS = [
  {
    id: 'm5_nodes',
    title: 'Power Nodes',
    body: 'Whichever side has more units standing on a node controls it. Drive the witch\'s thralls off and hold the ground.',
    trigger: 'click',
    spotlight: null,
    tooltipPos: 'center',
  },
  {
    id: 'm5_checkpoint',
    title: 'Dusk Approaches',
    body: 'Dawn and Dusk are scoring checkpoints — the bar below tracks who holds what when the light changes.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#score-bar', arrow: 'down' },
    tooltipPos: 'center',
  },
];

const CH1M5_CONFIG = {
  mode: 'hints',
  roundStepMap: { 1: 'm5_nodes', 4: 'm5_checkpoint' },
  voiceKey: 'ch1m5',
};

// ── Ch1M6 "The Long Watch" — node action-budget bonus ────────────────────────

const CH1M6_STEPS = [
  {
    id: 'm6_node_budget',
    title: 'Power Flows to You',
    body: 'Holding a Power Node grants +1 action every round — your budget just grew. More nodes, more moves.',
    trigger: 'click',
    spotlight: { type: 'element', selector: '#plan-budget-badge', arrow: 'right' },
    tooltipPos: 'center',
    when: (state) => !!state?.witchObjectives?.some(o =>
      _isPlayerSide(nodeController(o, state.entities))),
  },
];

const CH1M6_CONFIG = {
  mode: 'hints',
  voiceKey: 'ch1m6',
};

// ── Registry export ───────────────────────────────────────────────────────────

export const HINT_SCRIPTS = Object.freeze({
  ch1m1: Object.freeze({ steps: CH1M1_STEPS, config: CH1M1_CONFIG }),
  ch1m2: Object.freeze({ steps: CH1M2_STEPS, config: CH1M2_CONFIG }),
  ch1m3: Object.freeze({ steps: CH1M3_STEPS, config: CH1M3_CONFIG }),
  ch1m4: Object.freeze({ steps: CH1M4_STEPS, config: CH1M4_CONFIG }),
  ch1m5: Object.freeze({ steps: CH1M5_STEPS, config: CH1M5_CONFIG }),
  ch1m6: Object.freeze({ steps: CH1M6_STEPS, config: CH1M6_CONFIG }),
});
