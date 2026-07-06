// Pure presentation digest for the replay timeline overlay — no DOM, no
// renderer, no module state. Turns the resolved `steps` array (from
// resolvePlans / resolvePlansMP) into a fog-filtered, left-to-right column
// model the UI layer renders as the timeline.
//
// Mirrors the battle-utils.js convention: the ResEventType / PlanActionType
// enums are injected (not imported) to keep this module free of the resolver's
// dependency graph, so it stays trivially unit-testable.

import { ENTITY_COLOR, normalizeDamage, isLeaderType } from './entities.js';
import { ICON } from './icons.js';
import { makeOverlay } from './overlays.js';
import { ITEMS, getWeaponDamage, lootDisplayLabel } from './items.js';
import { pickBlockWord } from './combat-words.js';
import { groupWhiffEvents } from './battle-utils.js';

// Format a weapon damage spec for the breakdown popup: "2D6", "1D12+1", or a
// flat number. Pure.
function fmtDamageSpec(spec) {
  const s = normalizeDamage(spec);
  if (s.count <= 0) return `${s.flat}`;
  let txt = `${s.count}D${s.sides}`;
  if (s.flat) txt += s.flat > 0 ? `+${s.flat}` : `−${-s.flat}`;
  return txt;
}
// Short weapon name from its ITEMS label ("⚔ Sword (+2 ATK)" → "Sword"); unarmed
// reads as "fists".
function weaponName(weaponId) {
  if (!weaponId) return 'fists';
  const label = ITEMS?.[weaponId]?.label;
  if (label) return label.replace(/^[^A-Za-z]+/, '').split(' (')[0].trim() || weaponId;
  return weaponId;
}

// Glyph fallback when no portrait sprite is available. Matches the maps used in
// ui.js / ui-render.js (kept local to preserve this module's purity).
const GLYPHS = Object.freeze({
  hero: ICON.hero, witch: ICON.witch, survivor: ICON.survivor, soldier: ICON.soldier,
  zombie: ICON.zombie, skeleton: ICON.skeleton, minion: ICON.minion, wood_golem: ICON.woodGolem, iron_golem: ICON.ironGolem,
});

/** Presentation outcome kinds for a battle row. */
export const OutcomeKind = Object.freeze({
  HIT: 'hit', CRUSH: 'crush', MISS: 'miss', KILL: 'kill',
});

/**
 * Structured breakdown of a battle roll — the single source for both the
 * plain-text tip (buildRollTip) and the UI's styled hover panel. Pure;
 * returns null when the result carries no breakdown (older replays).
 *
 * Shape:
 *   {
 *     atk: { roll, dice: {pool, picked, advantage}, terms: [{label, val}] },
 *     def: { ... },
 *     notes: string[],   // gang-up / point-blank explanations when relevant
 *     rule:  string,     // hit/crush/counter thresholds (ranged variant)
 *   }
 */
export function buildRollRows(result, ranged = false) {
  const bd = result?.breakdown;
  if (!bd || result?.attackRoll == null || result?.defenseRoll == null) return null;

  // The weapon's contribution gets its own named row ("sword +2") so the
  // player can see what their weapon added to the roll; the remaining
  // intrinsic mods stay folded into the ATK/DEF stat row.
  const atkStat = (bd.atkBaseStat ?? 0) + (bd.atkAbilityMod ?? 0) + (bd.atkEffectMod ?? 0);
  const defStat = (bd.defBaseStat ?? 0) + (bd.defAbilityMod ?? 0) + (bd.defEffectMod ?? 0);
  const weaponLabel = (id) => id ? String(id).replace(/_/g, ' ') : 'weapon';
  const terms = (pairs) => pairs.filter(([, v]) => v).map(([label, val]) => ({ label, val }));

  const notes = [];
  if ((bd.atkGangupFlat ?? 0) > 0 || (bd.defGangupFlat ?? 0) > 0) {
    notes.push('Gang-up: each ally beside the target adds +1 advantage die and +1 flat (max 3).');
  }
  if ((bd.atkDisadvantageDice ?? 0) > 0) {
    notes.push('Point-blank: ranged attackers roll at disadvantage against adjacent targets.');
  }

  return {
    atk: {
      roll: result.attackRoll,
      dice: {
        pool: Array.isArray(bd.atkPool) ? [...bd.atkPool] : [bd.atkBaseDie],
        picked: bd.atkBaseDie,
        advantage: (bd.atkAdvantageDice ?? 0) - (bd.atkDisadvantageDice ?? 0),
      },
      terms: terms([
        ['ATK', atkStat],
        [weaponLabel(bd.atkWeaponId), bd.atkWeaponMod],
        ['silver', bd.atkAttackBonus],
        ['gang-up', bd.atkGangupFlat],
        ['night', bd.phaseBonus],
        // Attacker fortification — distinguished from the defender's fort row
        // ('fort (def)') so the two read clearly when both sides are fortified.
        ['fort (att)', bd.atkFortAtkBonus],
        ['weapon trigger', bd.atkStaffBonus],
        ['range falloff', -(bd.rangeDistancePenalty ?? 0)],
      ]),
    },
    def: {
      roll: result.defenseRoll,
      dice: {
        pool: Array.isArray(bd.defPool) ? [...bd.defPool] : [bd.defBaseDie],
        picked: bd.defBaseDie,
        advantage: bd.defAdvantageDice ?? 0,
      },
      terms: terms([
        ['DEF', defStat],
        [weaponLabel(bd.defWeaponId), bd.defWeaponMod],
        ['bonus', bd.defDefenseBonus],
        ['allies', bd.defGangupFlat],
        // Defender fortification — the wall on the defender's tile adds DEF.
        ['fort (def)', bd.fortBonus],
        ['forest cover', bd.forestCoverBonus],
        ['fatigue', -(bd.fatiguePenalty ?? 0)],
      ]),
    },
    notes,
    rule: ranged
      ? 'Hit if attack > defense. Damage = weapon roll. Ranged shots never crush and are never countered.'
      : 'Hit if attack > defense · damage = weapon roll, ×2 on a crush (double) / ×3 great crush (triple) · counter when defense ≥ 2× attack.',
  };
}

/**
 * Multi-line plain-text breakdown of a battle roll — the accessible/legacy
 * text form of buildRollRows. Pure; returns '' when not reconstructable.
 *
 * @param {object} result — executeBattle-style result (attackRoll/defenseRoll/breakdown)
 * @param {boolean} ranged
 * @returns {string} newline-separated lines, or '' when not reconstructable
 */
export function buildRollTip(result, ranged = false) {
  const rows = buildRollRows(result, ranged);
  if (!rows) return '';

  const dicePart = ({ pool, picked, advantage }) => {
    if (!Array.isArray(pool) || pool.length <= 1) return `die ${picked}`;
    const kind = advantage >= 0 ? 'best' : 'worst';
    return `die ${picked} (rolled ${pool.join('·')}, kept ${kind} of ${pool.length})`;
  };
  const termText = (t) => ` ${t.val > 0 ? '+' : '−'}${Math.abs(t.val)} ${t.label}`;
  const sideLine = (name, side) =>
    `${name} ${side.roll} = ` + dicePart(side.dice) + side.terms.map(termText).join('');

  return [
    sideLine('Attack', rows.atk),
    sideLine('Defense', rows.def),
    ...rows.notes,
    rows.rule,
  ].join('\n');
}

/** Display label per PlanActionType value. */
const ACTION_LABEL = Object.freeze({
  'move': 'MOVE', 'battle-unit': 'BATTLE', 'battle-hex': 'BATTLE',
  'explore': 'EXPLORE', 'fortify': 'FORTIFY', 'summon': 'SUMMON',
  'heal': 'HEAL', 'use-item': 'ITEM', 'equip-weapon': 'EQUIP',
  'use-ability': 'ABILITY', 'guard': 'GUARD', 'sound-horn': 'HORN',
  'sent-to': 'SEND',
});

// Pseudo actionType for the recipient's SURVIVOR_RECEIVED card. Not a real
// PlanActionType — only buildStepDigest emits this on entries it synthesises
// from a SURVIVOR_RECEIVED event. Marked here so the compactor (which gates
// "uneventful" on the actionType allowlist) and the entry sorter recognise it.
const RECV_ACTION_TYPE = 'survivor-received';

/**
 * Rank entries by the order the animation actually plays them, so the card list
 * matches playback. _animateResolutionSteps resolves in phases: moves first,
 * then battles/summons, then explore, sound-horn, fortify, heal. (In queue
 * order a horn can be listed first yet animate after the battles.)
 */
const PHASE_RANK = Object.freeze({
  'move': 1,
  'battle-unit': 2, 'battle-hex': 2, 'summon': 2,
  'explore': 3, 'sound-horn': 4, 'fortify': 5, 'heal': 6,
  // Free actions (no budget cost) — list near the top so the transfer reads
  // before any of the recipient's downstream actions.
  'sent-to': 0,
  'survivor-received': 0,
});
const phaseRank = (t) => PHASE_RANK[t] ?? 7;

/**
 * Build a lightweight unit reference for the overlay. The UI layer resolves the
 * actual portrait from `type`/`title` via its own `_entityPortraitId` +
 * `getPortraitDataURL`, so this stays renderer-free.
 */
function unitRef(snap) {
  if (!snap) return null;
  const name = (snap.type === 'survivor' && snap.name)
    ? snap.name
    : (snap.title ?? snap.displayName ?? snap.type);
  return {
    entityId: snap.id ?? null,
    type:     snap.type,
    title:    snap.title ?? null,
    name,
    color:    snap.color || ENTITY_COLOR[snap.type] || '#888',
    glyph:    GLYPHS[snap.type] ?? '?',
    // Faction owner: used by the timeline compactor to break uneventful runs at
    // faction boundaries (a quiet hero stretch never collapses into a quiet
    // witch stretch). Null for neutral actors.
    owner:    snap.owner ?? null,
  };
}

/** Classify a battle `result` for colour/labelling. The crush tier lives in
 *  breakdown.dmgTier since the weapons overhaul (hit 1× / crush 2× / great
 *  crush 3×); the top-level `crush` flag only exists in older saved replays. */
function battleKind(result) {
  if (!result) return OutcomeKind.MISS;
  if (result.killed)    return OutcomeKind.KILL;
  if (result.crush || (result.breakdown?.dmgTier ?? 0) >= 2) return OutcomeKind.CRUSH;
  if (result.hit)       return OutcomeKind.HIT;
  return OutcomeKind.MISS;
}

/** Outcome word for the turn card's centre cell. KILL trumps everything;
 *  crushes split into CRUSH / GREAT CRUSH by tier; misses use the entry's
 *  deterministic flavour word. Pure — takes a buildStepDigest battle entry. */
export function battleOutcomeWord(entry) {
  if (entry.killed) return 'KILL';
  if (entry.outcomeKind === OutcomeKind.CRUSH) {
    return (entry.dmgTier ?? 0) >= 3 ? 'GREAT CRUSH' : 'CRUSH';
  }
  if (entry.outcomeKind === OutcomeKind.HIT) return 'HIT';
  return entry.missWord ?? 'MISS';
}

/** Meaningful loot icons from an explore result ('nothing' rolls excluded). */
function lootIcons(result) {
  return (result?.lootItems ?? []).filter(x => x && x !== 'nothing');
}

// Actions that are inherently public — visible to every faction regardless of
// fog. The Sound Horn pulse reveals all hero units across the whole map, so the
// opponent sees both the card and the on-map ring even when the horn-blower is
// out of sight. Keyed by PlanActionType value so it stays data-driven.
const PUBLIC_ACTION_TYPES = Object.freeze(new Set(['sound-horn']));

/**
 * Single source of truth for "can the viewer see this resolved event?" — used
 * by BOTH the timeline digest (cards) and the on-map animation gates so a card
 * always has a matching animation and vice-versa.
 *
 * Union rule: an event is visible if its SOURCE hex OR its TARGET/DESTINATION
 * hex is in sight (so an attack out of an unseen hex still shows because the
 * struck unit is visible), OR the action is inherently public (horn).
 *
 * Sight is asked "when the step has RESOLVED": pass `viewEnts` (the POST-step
 * entity snapshot) and the fog test runs against the viewer's post-step unit
 * positions — the same positions the on-map veil shows while the player is
 * paused at the step boundary reading the panel. Without it, a viewer unit
 * that moved AWAY during the step left cards for moves the player can no
 * longer see anywhere on the map. Events involving the viewer's own units
 * (`viewerFaction`) always show — you planned the action / it's your unit's
 * fate — which also covers the participant dying mid-step and therefore
 * granting no post-step sight.
 *
 * @param {Object}   ev        — resolved sub-event (ACTION_OK / GUARD_STRIKE / …).
 * @param {Array}    ents      — the step's entitySnapshot (for actor lookups).
 * @param {Function} isVisible — (col,row,ents)=>boolean fog test; falsy ⇒ all visible.
 * @param {Object}   deps      — { PlanActionType, ResEventType } injected enums,
 *   plus optional { viewerFaction, viewEnts } (see above). When omitted the
 *   fog test falls back to the pre-step snapshot (legacy behaviour).
 * @returns {boolean}
 */
export function isEventVisible(ev, ents, isVisible,
  { PlanActionType: PA, ResEventType: RE, viewerFaction = null, viewEnts = null } = {}) {
  const vis = isVisible || (() => true);
  if (!ev || !PA || !RE) return true;
  const list = ents ?? [];
  // Entity list the viewer's SIGHT is computed from (post-step when given).
  // The hexes tested stay the event's own (pre-step actor / battle snaps).
  const viewList = viewEnts ?? list;
  const at = (s) => !!s && vis(s.col, s.row, viewList);

  // Inherently public actions short-circuit the fog test.
  if (PUBLIC_ACTION_TYPES.has(ev.action?.type)) return true;

  // SURVIVOR_RECEIVED is a same-faction message pushed into the recipient's
  // own bucket — never fog-gated. The transfer happens behind the scenes;
  // there is no map hex to occlude. Always show.
  if (ev.type === RE.SURVIVOR_RECEIVED) return true;

  // Own-faction participants short-circuit it too: the viewer always sees
  // their own units' actions and fates, sighted or not.
  if (viewerFaction) {
    const actor = ev.battleSnaps?.actorSnap
      ?? list.find(e => e.id === ev.action?.entityId);
    if (actor?.owner === viewerFaction) return true;
    if (ev.battleSnaps?.targetSnap?.owner === viewerFaction) return true;
    const blocker = ev.blockedBy;
    if (blocker?.owner === viewerFaction) return true;
  }

  // Battles & reactive guard strikes — source OR target hex. Fort assaults are
  // BATTLE_HEX strikes with no targetSnap; their besieged hex rides on result.
  const isBattleStrike = ev.type === RE.GUARD_STRIKE
    || (ev.type === RE.ACTION_OK && ev.battleSnaps
        && (ev.action?.type === PA.BATTLE_UNIT || ev.action?.type === PA.BATTLE_HEX));
  if (isBattleStrike) {
    if (at(ev.battleSnaps?.actorSnap) || at(ev.battleSnaps?.targetSnap)) return true;
    const tc = ev.result?.targetCol, tr = ev.result?.targetRow;
    return tc != null && vis(tc, tr, viewList);
  }

  // Whiffed hex attack (no enemy on the target hex) — actor OR the empty hex.
  if (ev.type === RE.ACTION_SKIP && ev.whiffTarget && ev.battleSnaps?.actorSnap) {
    return at(ev.battleSnaps.actorSnap)
      || vis(ev.whiffTarget.col, ev.whiffTarget.row, viewList);
  }

  // Blocked move — actor OR the blocker hex.
  if (ev.type === RE.ACTION_FAIL && ev.action?.type === PA.MOVE
      && (ev.blockedBy || ev.blockedByFort)) {
    const a = list.find(e => e.id === ev.action.entityId);
    const block = ev.blockedByFort || ev.blockedBy;
    return at(a) || (!!block && vis(block.col, block.row, viewList));
  }

  // Remaining cards come from successful actions.
  if (ev.type !== RE.ACTION_OK || !ev.action) return false;
  const a = list.find(e => e.id === ev.action.entityId);
  if (!a) return false;

  // Move shows if origin OR destination is in sight; summon/explore/fortify/
  // heal/… happen on the actor's own hex.
  if (ev.action.type === PA.MOVE) {
    return at(a) || vis(ev.action.toCol, ev.action.toRow, viewList);
  }
  return at(a);
}

/**
 * Can the viewer LEARN about a survivor/zombie discovery carried on this event?
 *
 * Tighter than isEventVisible: a move card shows when EITHER its origin or its
 * destination is in sight, but a hidden unit found at a FOGGED destination must
 * not leak into the round summary just because the viewer watched the actor
 * leave a sighted origin. The find is shown only when —
 *   • the discoverer is on the viewer's own faction (own-faction bypass — you
 *     always learn what your own units turn up, sighted or not), OR
 *   • the action is inherently public (the horn reveals its finds to everyone),
 *   • OR the DISCOVERED tile is in the viewer's POST-step sight.
 *
 * The discovered tile is the actor's resolved hex: a move ends at its
 * destination; explore / horn / fortify / … happen on the actor's own hex.
 *
 * @param {Object}   ev        — the resolved ACTION_OK sub-event carrying the find.
 * @param {Object}   actorSnap — the actor's snapshot (for owner + resting hex).
 * @param {Function} isVisible — (col,row,ents)=>boolean fog test; falsy ⇒ all visible.
 * @param {Object}   deps      — { PlanActionType, viewerFaction, viewEnts }.
 *   viewEnts is the POST-step entity list (what the veil shows at the boundary).
 * @returns {boolean}
 */
export function isDiscoveryVisible(ev, actorSnap, isVisible,
  { PlanActionType: PA, viewerFaction = null, viewEnts = null } = {}) {
  const vis = isVisible || (() => true);
  const a = ev?.action;
  if (!PA || !a) return true;
  // Own-faction discoverer always learns of the find.
  if (viewerFaction && actorSnap?.owner === viewerFaction) return true;
  // Inherently public actions (horn) surface their finds to every faction.
  if (PUBLIC_ACTION_TYPES.has(a.type)) return true;
  // Otherwise the discovered tile — the actor's resolved hex — must be in the
  // viewer's post-step sight.
  const col = a.type === PA.MOVE ? a.toCol : actorSnap?.col;
  const row = a.type === PA.MOVE ? a.toRow : actorSnap?.row;
  return Number.isFinite(col) && Number.isFinite(row) && vis(col, row, viewEnts);
}

/**
 * Turn resolved steps into the timeline column model.
 *
 * @param {Array}    steps         — StepRecord[] from resolvePlans/resolvePlansMP.
 * @param {Array}    finalEntities — post-resolution entities; also the
 *                                   viewer-sight set for the LAST step (every
 *                                   other step uses the NEXT step's snapshot).
 * @param {Object}   deps
 * @param {Function} deps.isVisible — (col, row, entities) => boolean. Fog test;
 *   handed the POST-step entity list so cards match what the veil shows while
 *   the player is paused at the step boundary (see isEventVisible). When
 *   omitted, everything is visible (fog off / AI-vs-AI / full replay with no
 *   viewer).
 * @param {string}   deps.viewerFaction — the viewing faction; its own units'
 *   events bypass the fog gate. Omitted ⇒ no bypass (legacy behaviour).
 * @param {Object}   deps.PlanActionType — injected enum.
 * @param {Object}   deps.ResEventType   — injected enum.
 * @returns {Array<{ stepIndex, entries: Array }>} one column per step; a fully
 *   fogged step yields an empty `entries` array so column count tracks the
 *   animation's step count (keeps the slide aligned).
 */
/**
 * Build the single-column digest for a campaign conversation turn card. Same
 * column shape as buildStepDigest output so ui.showReplayTimeline renders it
 * unchanged; the `kind: 'conversation'` flag drives the special card chrome
 * (💬 header + SKIP/REPLAY footer button). stepIndex is a string key so a
 * mid-replay insert never collides with a numeric resolution step.
 *
 * @param {{ id, title, lines }} convo — parsed conversation (conversation-parser.js).
 * @param {Map<string, object>|object[]} participants — bound role→entity map
 *   (or a plain entity array); the first two become the card's actor/target.
 * @param {{ hasVoice?: boolean }} [opts] — hasVoice gates the card's voice-mute
 *   button: shown only when this conversation actually has generated narration.
 */
/**
 * Build a single-column digest for a mission-logic STORY BEAT turn card — a
 * title + text panel inserted into the replay timeline at the turn it fired
 * (instead of a blocking modal). `kind: 'storyBeat'` drives its card chrome.
 * `key` makes the stepIndex unique so a mid-replay insert never collides with a
 * numeric resolution step (or another beat the same turn).
 */
export function buildStoryBeatDigest(beat, key) {
  return {
    stepIndex: `beat:${key}`,
    kind:      'storyBeat',
    title:     beat?.title ?? '',
    text:      beat?.text ?? '',
    // A placeholder entry so showReplayTimeline (which drops empty columns)
    // renders the card; the storyBeat chrome ignores rows and shows the text.
    entries: [{ actionType: 'storyBeat', label: 'STORY' }],
  };
}

export function buildConversationDigest(convo, participants, { hasVoice = false } = {}) {
  const ents = participants instanceof Map ? [...participants.values()] : [...(participants ?? [])];
  return [{
    stepIndex: `conv:${convo.id}`,
    kind:      'conversation',
    title:     convo.title ?? convo.id,
    hasVoice,
    entries: [{
      entityId:   ents[0]?.id ?? null,
      actor:      unitRef(ents[0] ?? null),
      target:     unitRef(ents[1] ?? null),
      actionType: 'conversation',
      label:      'TALK',
      lineCount:  convo.lines?.length ?? 0,
    }],
  }];
}

export function buildStepDigest(steps, finalEntities, { isVisible, PlanActionType, ResEventType, viewerFaction = null } = {}) {
  const vis = isVisible || (() => true);
  const PA = PlanActionType;
  const RE = ResEventType;
  if (!Array.isArray(steps) || !PA || !RE) return [];

  return steps.map((step, stepIndex) => {
    const ents = step.entitySnapshot ?? [];
    // Viewer-sight set: where the viewer's units are AFTER this step (= the
    // next step's snapshot; finalEntities for the last). Matches the veil at
    // the step-boundary hold — see isEventVisible.
    const viewEnts = steps[stepIndex + 1]?.entitySnapshot ?? finalEntities ?? ents;
    const allEvents = [
      ...(step.heroEvents  ?? []),
      ...(step.witchEvents ?? []),
      ...(step.playerEvents ?? []).flatMap(pe => pe.events ?? []),
    ];
    const entries = [];

    // Fold runs of identical whiffs (same actor swinging at the same empty/fled
    // hex) into a single "TARGET FLED" / "NO TARGET" card — mirrors the on-map
    // animation's whiff collapse (src/main.js groupWhiffEvents) so card ⟷
    // animation stay 1:1. Only whiff ACTION_SKIPs are touched; every other event
    // passes through untouched.
    const foldedWhiffs = (() => {
      const whiffs = allEvents.filter(
        ev => ev.type === RE.ACTION_SKIP && ev.whiffTarget && ev.battleSnaps?.actorSnap);
      const keep = new Set(groupWhiffEvents(whiffs));
      return new Set(whiffs.filter(ev => !keep.has(ev)));
    })();

    for (const ev of allEvents) {
      // A whiff folded into the preceding identical whiff — skip its card.
      if (foldedWhiffs.has(ev)) continue;
      // Single visibility gate — shared with the on-map animation so a card and
      // its animation always agree (union of source/target hex + public actions).
      if (!isEventVisible(ev, ents, vis,
        { PlanActionType: PA, ResEventType: RE, viewerFaction, viewEnts })) continue;

      const isBattleStrike = ev.type === RE.GUARD_STRIKE
        || (ev.type === RE.ACTION_OK && ev.battleSnaps
            && (ev.action?.type === PA.BATTLE_UNIT || ev.action?.type === PA.BATTLE_HEX));

      // ── Battles (and reactive guard strikes) ──────────────────────────────
      // Damage is carried per-unit: the target took `targetDmg` (and may have
      // died), the attacker took `actorDmg` (counter). The UI renders each
      // number beneath the unit that lost the HP.
      if (isBattleStrike) {
        const actorSnap  = ev.battleSnaps?.actorSnap;
        const targetSnap = ev.battleSnaps?.targetSnap;
        if (!actorSnap) continue;
        // Gang-up allies that lent advantage to each side (visible ones only).
        const bd = ev.result?.breakdown ?? {};
        const allyRefs = (ids) => (ids ?? [])
          .filter(id => id !== actorSnap.id && id !== targetSnap?.id)
          .map(id => ents.find(e => e.id === id))
          .filter(s => s && (s.owner === viewerFaction || vis(s.col, s.row, viewEnts)))
          .map(unitRef);
        const ranged = !!(ev.result?.ranged ?? ev.battleSnaps?.ranged);
        // `guardReaction` flags the new inline guard attack (a normal BATTLE_UNIT
        // event); GUARD_STRIKE is the legacy event kind in pre-existing saves.
        const isGuard = ev.guardReaction || ev.type === RE.GUARD_STRIKE;
        entries.push({
          entityId:     actorSnap.id,
          actor:        unitRef(actorSnap),
          target:       unitRef(targetSnap),
          actorAllies:  allyRefs(bd.atkAllyIds),
          targetAllies: allyRefs(bd.defAllyIds),
          actionType:   PA.BATTLE_UNIT,
          label:        isGuard ? 'GUARD' : (ranged ? 'RANGED ATTACK' : 'ATTACK'),
          ranged,
          atkRoll:      ev.result?.attackRoll ?? null,
          defRoll:      ev.result?.defenseRoll ?? null,
          rollTip:      buildRollTip(ev.result, ranged),
          rollRows:     buildRollRows(ev.result, ranged),
          attackerWon:  !!ev.result?.hit,        // hit ⇒ attacker's roll beat the defence
          outcomeKind:  battleKind(ev.result),
          // Flavour word for a miss (miss/dodged/blocked/…), matching the
          // floaters — deterministic from the rolls so it's stable.
          missWord:     pickBlockWord(ev.result?.attackRoll, ev.result?.defenseRoll),
          targetDmg:    ev.result?.damage ?? 0,
          actorDmg:     ev.result?.counterDmg ?? 0,
          // Weapon damage roll for the breakdown popup (final = dmgRoll × dmgTier).
          dmgRoll:      ev.result?.breakdown?.dmgRoll ?? 0,
          dmgTier:      ev.result?.breakdown?.dmgTier ?? 0,
          atkWeapon:    ev.result?.breakdown?.atkWeapon ?? null,
          killed:       !!ev.result?.killed,
          // Splash victims (brute blast) — listed in the outcome summary.
          splashHits:   (ev.result?.splashHits ?? []).map(sh => ({
            id: sh.id, name: sh.name ?? sh.type ?? 'Unit', type: sh.type,
            damage: sh.damage ?? 1, killed: !!sh.killed,
          })),
          note:         null,
          // Hover highlight: both combatants' hexes (battleSnaps are captured
          // at battle execution, so mid-step moves have already landed).
          hexes: [actorSnap, targetSnap].filter(Boolean)
            .map(sn => ({ col: sn.col, row: sn.row })),
          movePath: null,
        });
        continue;
      }

      // ── Whiffed hex attacks (ACTION_SKIP, no enemy on the target hex) ──────
      // The attack still lunges/fires at an empty hex, so it earns a card —
      // labelled like a normal strike with a "NO TARGET" result.
      if (ev.type === RE.ACTION_SKIP && ev.whiffTarget && ev.battleSnaps?.actorSnap) {
        const actorSnap = ev.battleSnaps.actorSnap;
        const ranged = !!ev.battleSnaps.ranged;
        entries.push({
          entityId:   actorSnap.id,
          actor:      unitRef(actorSnap),
          target:     null,
          actionType: PA.BATTLE_HEX,
          label:      ranged ? 'RANGED ATTACK' : 'ATTACK',
          ranged,
          outcomeKind: null,
          targetDmg: 0, actorDmg: 0, killed: false,
          // A fled target (alive, moved out of reach) reads differently from
          // an empty-hex whiff — the quarry escaped, not "nothing was there".
          note:      { text: ev.targetFled ? 'TARGET FLED' : 'NO TARGET', kind: 'info' },
          hexes: [
            { col: actorSnap.col, row: actorSnap.row },
            ...(Number.isFinite(ev.whiffTarget?.col) && Number.isFinite(ev.whiffTarget?.row)
              ? [{ col: ev.whiffTarget.col, row: ev.whiffTarget.row }] : []),
          ],
          movePath: null,
        });
        continue;
      }

      // ── Blocked moves (ACTION_FAIL with a blocker) → "BLOCKED" note ────────
      if (ev.type === RE.ACTION_FAIL && ev.action?.type === PA.MOVE
          && (ev.blockedBy || ev.blockedByFort)) {
        const actorSnap = ents.find(e => e.id === ev.action.entityId);
        if (!actorSnap) continue;
        entries.push({
          entityId: ev.action.entityId,
          actor:    unitRef(actorSnap),
          target:   null,
          actionType: PA.MOVE,
          label:    'MOVE',
          outcomeKind: null,
          targetDmg: 0, actorDmg: 0, killed: false,
          note:     { text: 'BLOCKED', kind: 'blocked' },
          hexes: (() => {
            const blocker = ev.blockedByFort ?? ev.blockedBy;
            return [
              { col: actorSnap.col, row: actorSnap.row },
              ...(Number.isFinite(blocker?.col) && Number.isFinite(blocker?.row)
                ? [{ col: blocker.col, row: blocker.row }] : []),
            ];
          })(),
          movePath: null,
        });
        continue;
      }

      // ── Survivor received (paired with the sender's SENT_TO ACTION_OK) ───
      // Resolver pushes this into the RECIPIENT's bucket so the recipient sees
      // their own "📥 sent from <leader>" card. Synthesise an entry with the
      // recipient leader as actor and the transferred survivor as target.
      //
      // Use the PRE-STEP snapshot (`ents`) for both lookups: it carries
      // consistent `displayName` / `title` fields for the sender card too, and
      // it includes the recipient leader at its current position. The
      // survivor's ownerId in `ents` is still the SENDER's (SENT_TO has not
      // mutated the snapshot — only the live entity), so don't look the
      // recipient up by survivor ownership; use the event's destOwnerId.
      if (ev.type === RE.SURVIVOR_RECEIVED) {
        const survivorSnap = ents.find(e => e.id === ev.survivorId)
          ?? viewEnts.find(e => e.id === ev.survivorId);
        if (!survivorSnap) continue;
        // Faction-leader entity-types differ per faction (paladin / witch /
        // rogue / captain / necromancer / brute) — use isLeaderType, not a
        // hard-coded class.
        const recipientLeader = ev.destOwnerId
          ? ents.find(e => e.ownerId === ev.destOwnerId && isLeaderType(e.type))
          : null;
        const fromName = ev.fromOwnerName ?? 'a leader';
        entries.push({
          entityId:    recipientLeader?.id ?? survivorSnap.id,
          actor:       recipientLeader ? unitRef(recipientLeader) : unitRef(survivorSnap),
          target:      unitRef(survivorSnap),
          actionType:  RECV_ACTION_TYPE,
          label:       'RECEIVE',
          outcomeKind: null,
          targetDmg:   0, actorDmg: 0, killed: false,
          note:        { text: `${ICON.receivedFrom} from ${fromName}`, kind: 'gain' },
          hexes:       [
            ...(recipientLeader ? [{ col: recipientLeader.col, row: recipientLeader.row }] : []),
            { col: survivorSnap.col, row: survivorSnap.row },
          ],
          movePath:    null,
        });
        continue;
      }

      // ── Non-battle successful actions ─────────────────────────────────────
      if (ev.type !== RE.ACTION_OK || !ev.action) continue;
      const a = ev.action;
      const actorSnap = ents.find(e => e.id === a.entityId);
      if (!actorSnap) continue;

      // ── SENT_TO sender card ────────────────────────────────────────────────
      // The plan action lives on the SURVIVOR (a.entityId === survivor's id),
      // but the sender card belongs in the SENDER LEADER's column so the
      // recipient's column can carry the paired SURVIVOR_RECEIVED card. We
      // promote the sender leader to actor and keep the survivor in the
      // target cell. fromOwnerId is set on ev.result by executeSentTo.
      if (a.type === PA.SENT_TO) {
        const survivorSnap = ents.find(e => e.id === (ev.result?.survivorId ?? a.entityId));
        const fromOwnerId = ev.result?.fromOwnerId ?? null;
        const senderLeader = fromOwnerId
          ? ents.find(e => e.ownerId === fromOwnerId && isLeaderType(e.type))
          : null;
        // Fall back to the raw actor (the survivor) if we can't find the
        // sender leader — keeps the card non-empty in offline tests where
        // ents may be the survivor-only snapshot.
        const cardActorSnap = senderLeader ?? actorSnap;
        const destName = ev.result?.destOwnerName ?? 'another leader';
        entries.push({
          entityId:    cardActorSnap.id,
          actor:       unitRef(cardActorSnap),
          target:      survivorSnap ? unitRef(survivorSnap) : null,
          actionType:  PA.SENT_TO,
          label:       ACTION_LABEL[PA.SENT_TO] ?? 'SEND',
          outcomeKind: null,
          targetDmg:   0, actorDmg: 0, killed: false,
          note:        { text: `${ICON.sentTo} to ${destName}`, kind: 'gain' },
          hexes:       [
            { col: cardActorSnap.col, row: cardActorSnap.row },
            ...(survivorSnap ? [{ col: survivorSnap.col, row: survivorSnap.row }] : []),
          ],
          movePath:    null,
        });
        continue;
      }

      // Summon shows the conjured unit as the "target" chip.
      let target = null;
      if (a.type === PA.SUMMON && a.summonType) {
        target = unitRef({ type: a.summonType });
      }

      // Explore reports the loot gained with its full name + stats when the id
      // is known (e.g. "⚔ Sword (+2 ATK)", "🪵 Wood"), falling back to the bare
      // emoji floaters for older/online events that predate `lootItemIds`. Empty
      // roll ⇒ "EXPLORED". The `loot` kind bumps the card text size.
      let note = null;
      if (a.type === PA.EXPLORE) {
        const labels = (ev.result?.lootItemIds ?? []).map(lootDisplayLabel).filter(Boolean);
        if (labels.length) {
          note = { text: labels.join(' · '), kind: 'gain loot' };
        } else {
          const icons = lootIcons(ev.result);
          note = icons.length
            ? { text: icons.join(' '), kind: 'gain loot' }
            : { text: 'EXPLORED', kind: 'info' };
        }
      }

      // Discovered survivor(s)/zombie(s) — a move / explore / horn can surface
      // one OR MORE hidden units. Show all their icons + a "FOUND …" note (these
      // replace the old discovery modal). Horn in particular can find several.
      // Fog-gated SEPARATELY from the card: the move card may show because its
      // origin was in sight, but a unit found at a fogged destination must not
      // leak (own-faction discoveries always show — see isDiscoveryVisible).
      let discovered = null;
      const found = ev.result?.encounterSurvivors
        ?? (ev.result?.encounterSurvivor ? [ev.result.encounterSurvivor] : []);
      if (found.length && isDiscoveryVisible(ev, actorSnap, vis,
        { PlanActionType: PA, viewerFaction, viewEnts })) {
        discovered = found.map(unitRef);
        const kind = found[0].type === 'zombie' ? 'ZOMBIE' : 'SURVIVOR';
        note = {
          text: found.length > 1 ? `FOUND ${found.length} ${kind}S` : `FOUND ${kind}`,
          kind: found[0].type === 'zombie' ? 'kill' : 'gain',
        };
      } else if (a.type === PA.SOUND_HORN && ev.result?.success && !found.length) {
        // Horn sounded but no survivor answered — the outcome belongs inline on
        // the action card (like EXPLORED), NOT in a popup result dialog. Public
        // action, so this shows to both factions.
        note = { text: 'NO RESPONSE', kind: 'info' };
      }

      // Hover highlight: the actor's hex, plus — for moves — every hex the
      // unit crossed (movePath drives the ghost arrow on the map).
      const hexes = [{ col: actorSnap.col, row: actorSnap.row }];
      let movePath = null;
      if (a.type === PA.MOVE) {
        const waypoints = Array.isArray(ev.result?.path) && ev.result.path.length
          ? ev.result.path
          : (Number.isFinite(a.toCol) && Number.isFinite(a.toRow)
            ? [{ col: a.toCol, row: a.toRow }] : []);
        if (waypoints.length) {
          movePath = [
            { col: actorSnap.col, row: actorSnap.row },
            ...waypoints.map(p => ({ col: p.col, row: p.row })),
          ];
          hexes.push(...movePath.slice(1));
        }
      } else {
        for (const [c, r] of [[a.toCol, a.toRow], [a.col, a.row]]) {
          if (Number.isFinite(c) && Number.isFinite(r)) hexes.push({ col: c, row: r });
        }
      }

      entries.push({
        entityId:    a.entityId,
        actor:       unitRef(actorSnap),
        target,
        actionType:  a.type,
        label:       ACTION_LABEL[a.type] ?? String(a.type ?? '').toUpperCase(),
        outcomeKind: null,
        targetDmg:   0, actorDmg: 0, killed: false,
        note,
        discovered,
        hexes,
        movePath,
      });
    }

    // Order entries to match the animation's phase order (stable within a
    // phase) so the card reads top-to-bottom in the sequence they play out.
    entries.sort((a, b) => phaseRank(a.actionType) - phaseRank(b.actionType));

    return { stepIndex, entries };
  });
}

/**
 * Outcome summary for a battle entry — what happened, WHY (the roll
 * comparison that triggered it), and who took how much damage. Feeds the
 * turn card's breakdown panel. Pure; takes a buildStepDigest battle entry.
 *
 * @returns {{ kind, headline, reason, lines: string[] } | null}
 */
export function buildOutcomeSummary(entry) {
  if (!entry || !entry.outcomeKind || entry.atkRoll == null || entry.defRoll == null) return null;
  const atk = entry.atkRoll, def = entry.defRoll;
  const target = entry.target?.name ?? 'The defender';
  const actor  = entry.actor?.name  ?? 'The attacker';

  const landed = entry.outcomeKind !== OutcomeKind.MISS;
  // Crush tier multiplies the rolled weapon damage (hit 1× / crush 2× / great
  // crush 3×). Prefer the recorded multiplier; fall back to re-deriving it from
  // the rolls for older replays (mirrors executeBattle; melee only).
  const tier = entry.dmgTier > 0
    ? entry.dmgTier
    : (landed ? (!entry.ranged && atk >= 3 * def ? 3 : !entry.ranged && atk >= 2 * def ? 2 : 1) : 0);
  const isCrush = tier >= 2;
  const isGreat = tier >= 3;

  // Weapon damage roll string, e.g. "Sword 2D6 rolled 7".
  const wName    = weaponName(entry.atkWeapon);
  const diceStr  = fmtDamageSpec(getWeaponDamage(entry.atkWeapon));
  const rolled   = entry.dmgRoll > 0
    ? `${wName} ${diceStr} rolled ${entry.dmgRoll}`
    : `${wName} ${diceStr}`;
  const rolledTotal = entry.dmgRoll > 0 && tier > 0 ? entry.dmgRoll * tier : null;
  const mult        = tier > 1 ? ` ×${tier}` : '';
  const eq          = rolledTotal != null ? ` = ${rolledTotal}` : '';

  let kind, headline, reason;
  if (landed) {
    const tierWord = isGreat ? 'GREAT CRUSH' : isCrush ? 'CRUSH' : 'HIT';
    kind = entry.killed ? 'kill' : (isCrush ? 'crush' : 'hit');
    headline = entry.killed ? `${tierWord} — SLAIN` : `${tierWord} — ${entry.targetDmg} damage`;
    reason = isGreat
      ? `Attack ${atk} ≥ 3× defense ${def} — a great crush. ${rolled}${mult}${eq}.`
      : isCrush
        ? `Attack ${atk} ≥ 2× defense ${def} — a crushing blow. ${rolled}${mult}${eq}.`
        : `Attack ${atk} beats defense ${def}. ${rolled}${eq}.`;
  } else if (entry.actorDmg > 0) {
    kind = 'counter';
    headline = `COUNTERED — ${entry.actorDmg} damage`;
    reason = `Defense ${def} ≥ 2× attack ${atk} — the defender strikes back for one weapon roll.`;
  } else {
    kind = 'miss';
    headline = entry.missWord ? String(entry.missWord).toUpperCase() : 'MISS';
    reason = `Attack ${atk} fails to beat defense ${def} — no damage.`;
  }

  const lines = [];
  if (entry.targetDmg > 0) {
    let line = `${target} takes ${entry.targetDmg}`;
    // Final damage above roll×tier is the defender's wounded surcharge.
    if (rolledTotal != null && entry.targetDmg > rolledTotal) {
      line += ` (incl. +${entry.targetDmg - rolledTotal} wounded)`;
    }
    if (entry.killed) line += ' — slain!';
    lines.push(line + (entry.killed ? '' : '.'));
  }
  if (entry.actorDmg > 0) {
    lines.push(`${actor} takes ${entry.actorDmg} from the counter.`);
  }
  for (const sh of entry.splashHits ?? []) {
    lines.push(sh.killed
      ? `${ICON.splash} ${sh.name ?? 'A bystander'} takes ${sh.damage ?? 1} splash — slain!`
      : `${ICON.splash} ${sh.name ?? 'A bystander'} takes ${sh.damage ?? 1} splash.`);
  }
  return { kind, headline, reason, lines };
}

// ── Replay timeline compaction: consecutive uneventful turns ─────────────────
//
// In long games, multi-turn quiet stretches (a party of survivors trudging
// across the map round after round, or a witch's minions all on guard) leave
// the player clicking NEXT, NEXT, NEXT through near-identical move/guard cards
// for no payoff. compactUneventfulTurns folds runs of N ≥ MIN_COMPACT_RUN
// adjacent "uneventful" turns from the same faction into a single timeline
// card holding all their entries — NEXT then advances past the whole block in
// one click.
//
// Hard rules:
//   • Pure presentation, on top of buildStepDigest output — never touches the
//     resolver / step records / round history. Online MP / replay / spectate /
//     reconnect parity is by construction.
//   • Anything that produced a state-changing event is a HARD boundary that
//     splits the run: battles (outcomeKind), deaths (killed, *Dmg), summons,
//     blocked moves (note), discoveries (discovered, FOUND/EXPLORED note),
//     story beats, conversations, special cards (col.kind). The detector errs
//     on the safe side — any entry that isn't a plain move/guard breaks it.
//   • Faction changes break the run (hero quiet → witch quiet stays two cards).
//   • Single uneventful turn never collapses (MIN_COMPACT_RUN = 2).

/** Minimum adjacent uneventful turn count for compaction. A single quiet turn
 *  stays as a single card; runs of 2+ collapse. */
export const MIN_COMPACT_RUN = 2;

/** Plain-move + guard are the only inherently uneventful action types — every
 *  other action (battle / summon / explore / fortify / heal / use-item /
 *  equip-weapon / use-ability / sound-horn) produces a state-changing event or
 *  a presentational outcome worth its own NEXT click. */
const UNEVENTFUL_ACTION_TYPES = Object.freeze(new Set([
  'move',   // PlanActionType.MOVE
  'guard',  // PlanActionType.GUARD
]));

/**
 * Is this digest entry "uneventful" — i.e. a plain move or guard with no
 * outcome, note, discovery, damage, or kill? Pure, defensive against absent
 * fields so it works against the older digest shapes too.
 */
function _isUneventfulEntry(e) {
  if (!e) return false;
  if (!UNEVENTFUL_ACTION_TYPES.has(e.actionType)) return false;
  if (e.outcomeKind) return false;         // any battle outcome
  if (e.note) return false;                // BLOCKED / loot / FOUND / EXPLORED / NO TARGET
  if (Array.isArray(e.discovered) && e.discovered.length) return false;
  if ((e.targetDmg ?? 0) > 0) return false;
  if ((e.actorDmg ?? 0) > 0) return false;
  if (e.killed) return false;
  return true;
}

/**
 * Is this whole column compactable? It must be a regular step column (no
 * conversation / storyBeat kind), have at least one entry, and every entry
 * must be uneventful (plain move/guard, no event).
 */
function _isUneventfulCol(col) {
  if (!col || col.kind) return false;          // conversation / story beat / wrapup
  const entries = col.entries ?? [];
  if (!entries.length) return false;           // empty (fogged) → already a no-card slot
  return entries.every(_isUneventfulEntry);
}

/** Owner of a single entry — null when the actor is neutral / owner-less. */
function _entryOwner(e) {
  return e?.actor?.owner ?? null;
}

/** Set of distinct owner factions across a column's entries — used to break
 *  the run on a faction change between consecutive turns. */
function _colOwners(col) {
  const out = new Set();
  for (const e of col.entries ?? []) out.add(_entryOwner(e));
  return out;
}

/** Do two owner sets share at least one faction? (A mixed-faction column —
 *  unusual but possible if NPCs queue alongside player units — joins a run
 *  only when its faction set overlaps the run's.) */
function _ownersCompatible(a, b) {
  if (!a.size || !b.size) return true;
  for (const f of a) if (b.has(f)) return true;
  return false;
}

/**
 * Fold adjacent uneventful columns from the same faction into compacted cards.
 *
 * Returns a NEW digest array — never mutates the input. Each compacted column
 * carries:
 *   • stepIndex   — the LEADER step's index (so existing setReplayTimelineStep
 *                   / _replayCol(leaderIdx) keep working unchanged)
 *   • kind        — 'compacted'
 *   • memberStepIndices — every original step index folded in, in order
 *                         (the UI maps follower step → leader for highlight /
 *                         reveal / step-advance lookups, and main.js's manual
 *                         NEXT gate suppresses follower-step holds)
 *   • count       — memberStepIndices.length (display: "Turns N–M")
 *   • entries     — concatenated entries from every member column
 *
 * Single uneventful turns (run length < MIN_COMPACT_RUN) pass through
 * unchanged. Eventful columns (battles / summons / discoveries / story beats /
 * conversations / blocked moves / etc.) always pass through unchanged.
 *
 * @param {Array} digest          — buildStepDigest output (or a digest with
 *                                  story beat / conversation columns spliced in)
 * @param {Object} [opts]
 * @param {number} [opts.minRun]  — minimum adjacent uneventful columns to
 *                                  collapse. Default MIN_COMPACT_RUN (= 2).
 * @returns {Array} new digest
 */
export function compactUneventfulTurns(digest, { minRun = MIN_COMPACT_RUN } = {}) {
  if (!Array.isArray(digest) || digest.length === 0) return digest ?? [];
  const out = [];
  let i = 0;
  while (i < digest.length) {
    const col = digest[i];
    if (!_isUneventfulCol(col)) {
      out.push(col);
      i += 1;
      continue;
    }
    // Begin a candidate run. Extend while the NEXT column is also uneventful
    // AND its faction set overlaps the run's faction set.
    let j = i + 1;
    let runOwners = _colOwners(col);
    while (j < digest.length) {
      const next = digest[j];
      if (!_isUneventfulCol(next)) break;
      const nextOwners = _colOwners(next);
      if (!_ownersCompatible(runOwners, nextOwners)) break;
      // Union the run's owners with the new column (so a {hero}+{hero,null} run
      // doesn't accidentally accept a pure-null column later — overlap is still
      // required at each step).
      for (const f of nextOwners) runOwners.add(f);
      j += 1;
    }
    const runLen = j - i;
    if (runLen < minRun) {
      // Single uneventful turn — pass through unchanged.
      out.push(col);
      i += 1;
      continue;
    }
    // Collapse [i, j) into a single compacted column.
    const members = digest.slice(i, j);
    out.push({
      stepIndex: col.stepIndex,
      kind: 'compacted',
      memberStepIndices: members.map(m => m.stepIndex),
      count: runLen,
      entries: members.flatMap(m => m.entries ?? []),
    });
    i = j;
  }
  return out;
}

// ── Turn-card hover highlights ───────────────────────────────────────────────
//
// Hovering an action entry on a turn card highlights the hexes that action
// involved: a 15%-alpha blue flat fill over every involved hex, plus — for a
// successful move — translucent "ghost" arrow segments tracing the path the
// unit took. Pure: builds overlay descriptors from a buildStepDigest entry;
// ui.js applies/removes them on the renderer by these ids.

export const TURN_CARD_HOVER_FILL_ID = 'turn-card-hover-fill';
export const TURN_CARD_HOVER_ARROW_PREFIX = 'turn-card-hover-arrow-';
export const TURN_CARD_HOVER_COLOR = '#4d9fff';

/** @returns {{ fill: object|null, arrows: object[] }} overlay descriptors */
export function buildTurnCardHoverOverlays(entry) {
  const valid = (h) => h && Number.isFinite(h.col) && Number.isFinite(h.row);
  const hexes = (entry?.hexes ?? []).filter(valid);
  const fill = hexes.length ? makeOverlay({
    id: TURN_CARD_HOVER_FILL_ID, kind: 'fill', layer: 'fill',
    hexes, style: { color: TURN_CARD_HOVER_COLOR, alpha: 0.15 },
  }) : null;
  const path = (entry?.movePath ?? []).filter(valid);
  const arrows = path.length >= 2
    ? path.slice(0, -1).map((from, i) => makeOverlay({
        id: `${TURN_CARD_HOVER_ARROW_PREFIX}${i}`, kind: 'plan-arrow', layer: 'plan-arrow',
        path: [from, path[i + 1]],
        // Ghost variant: the plan-arrow consumer draws the dashed path but
        // skips the waypoint puck + numbered badge, and renders translucent.
        style: { color: TURN_CARD_HOVER_COLOR, alpha: 0.55 },
        meta: { entityId: '__turn-card-hover__', stepIndex: i, variant: 'ghost' },
      }))
    : [];
  return { fill, arrows };
}
