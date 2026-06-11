// Pure presentation digest for the replay timeline overlay — no DOM, no
// renderer, no module state. Turns the resolved `steps` array (from
// resolvePlans / resolvePlansMP) into a fog-filtered, left-to-right column
// model the UI layer renders as the timeline.
//
// Mirrors the battle-utils.js convention: the ResEventType / PlanActionType
// enums are injected (not imported) to keep this module free of the resolver's
// dependency graph, so it stays trivially unit-testable.

import { ENTITY_COLOR, normalizeDamage } from './entities.js';
import { ITEMS, getWeaponDamage } from './items.js';
import { pickBlockWord } from './combat-words.js';

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
  hero: '⚔', witch: '✦', survivor: '☺', soldier: '♟',
  zombie: '†', minion: '☠', wood_golem: '🪵', iron_golem: '⚙',
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
        ['fort', bd.atkFortAtkBonus],
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
        ['fort', bd.fortBonus],
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
});

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
  };
}

/** Classify a battle `result` for colour/labelling. */
function battleKind(result) {
  if (!result) return OutcomeKind.MISS;
  if (result.killed)    return OutcomeKind.KILL;
  if (result.crush)     return OutcomeKind.CRUSH;
  if (result.hit)       return OutcomeKind.HIT;
  return OutcomeKind.MISS;
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
 * @param {Object}   ev        — resolved sub-event (ACTION_OK / GUARD_STRIKE / …).
 * @param {Array}    ents      — the step's entitySnapshot (for actor lookups).
 * @param {Function} isVisible — (col,row,ents)=>boolean fog test; falsy ⇒ all visible.
 * @param {Object}   deps      — { PlanActionType, ResEventType } injected enums.
 * @returns {boolean}
 */
export function isEventVisible(ev, ents, isVisible, { PlanActionType: PA, ResEventType: RE } = {}) {
  const vis = isVisible || (() => true);
  if (!ev || !PA || !RE) return true;
  const list = ents ?? [];
  const at = (s) => !!s && vis(s.col, s.row, list);

  // Inherently public actions short-circuit the fog test.
  if (PUBLIC_ACTION_TYPES.has(ev.action?.type)) return true;

  // Battles & reactive guard strikes — source OR target hex. Fort assaults are
  // BATTLE_HEX strikes with no targetSnap; their besieged hex rides on result.
  const isBattleStrike = ev.type === RE.GUARD_STRIKE
    || (ev.type === RE.ACTION_OK && ev.battleSnaps
        && (ev.action?.type === PA.BATTLE_UNIT || ev.action?.type === PA.BATTLE_HEX));
  if (isBattleStrike) {
    if (at(ev.battleSnaps?.actorSnap) || at(ev.battleSnaps?.targetSnap)) return true;
    const tc = ev.result?.targetCol, tr = ev.result?.targetRow;
    return tc != null && vis(tc, tr, list);
  }

  // Whiffed hex attack (no enemy on the target hex) — actor OR the empty hex.
  if (ev.type === RE.ACTION_SKIP && ev.whiffTarget && ev.battleSnaps?.actorSnap) {
    return at(ev.battleSnaps.actorSnap)
      || vis(ev.whiffTarget.col, ev.whiffTarget.row, list);
  }

  // Blocked move — actor OR the blocker hex.
  if (ev.type === RE.ACTION_FAIL && ev.action?.type === PA.MOVE
      && (ev.blockedBy || ev.blockedByFort)) {
    const a = list.find(e => e.id === ev.action.entityId);
    const block = ev.blockedByFort || ev.blockedBy;
    return at(a) || (!!block && vis(block.col, block.row, list));
  }

  // Remaining cards come from successful actions.
  if (ev.type !== RE.ACTION_OK || !ev.action) return false;
  const a = list.find(e => e.id === ev.action.entityId);
  if (!a) return false;

  // Move shows if origin OR destination is in sight; summon/explore/fortify/
  // heal/… happen on the actor's own hex.
  if (ev.action.type === PA.MOVE) {
    return at(a) || vis(ev.action.toCol, ev.action.toRow, list);
  }
  return at(a);
}

/**
 * Turn resolved steps into the timeline column model.
 *
 * @param {Array}    steps         — StepRecord[] from resolvePlans/resolvePlansMP.
 * @param {Array}    finalEntities — post-resolution entities (reserved; not yet
 *                                   needed since outcomes come from result).
 * @param {Object}   deps
 * @param {Function} deps.isVisible — (col, row, entities) => boolean. Fog test
 *   against the step's own entitySnapshot, matching the canvas. When omitted,
 *   everything is visible (fog off / AI-vs-AI / full replay with no viewer).
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
 */
export function buildConversationDigest(convo, participants) {
  const ents = participants instanceof Map ? [...participants.values()] : [...(participants ?? [])];
  return [{
    stepIndex: `conv:${convo.id}`,
    kind:      'conversation',
    title:     convo.title ?? convo.id,
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

export function buildStepDigest(steps, finalEntities, { isVisible, PlanActionType, ResEventType } = {}) {
  const vis = isVisible || (() => true);
  const PA = PlanActionType;
  const RE = ResEventType;
  if (!Array.isArray(steps) || !PA || !RE) return [];

  return steps.map((step, stepIndex) => {
    const ents = step.entitySnapshot ?? [];
    const allEvents = [
      ...(step.heroEvents  ?? []),
      ...(step.witchEvents ?? []),
      ...(step.playerEvents ?? []).flatMap(pe => pe.events ?? []),
    ];
    const entries = [];

    for (const ev of allEvents) {
      // Single visibility gate — shared with the on-map animation so a card and
      // its animation always agree (union of source/target hex + public actions).
      if (!isEventVisible(ev, ents, vis, { PlanActionType: PA, ResEventType: RE })) continue;

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
          .filter(s => s && vis(s.col, s.row, ents))
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
          note:         null,
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
        });
        continue;
      }

      // ── Non-battle successful actions ─────────────────────────────────────
      if (ev.type !== RE.ACTION_OK || !ev.action) continue;
      const a = ev.action;
      const actorSnap = ents.find(e => e.id === a.entityId);
      if (!actorSnap) continue;

      // Summon shows the conjured unit as the "target" chip.
      let target = null;
      if (a.type === PA.SUMMON && a.summonType) {
        target = unitRef({ type: a.summonType });
      }

      // Explore reports the loot gained as the actual resource icons (🌿 🪵 ⚙
      // …), not a generic "+1 RESOURCE". Empty roll ⇒ "EXPLORED".
      let note = null;
      if (a.type === PA.EXPLORE) {
        const icons = lootIcons(ev.result);
        note = icons.length
          ? { text: icons.join(' '), kind: 'gain' }
          : { text: 'EXPLORED', kind: 'info' };
      }

      // Discovered survivor(s)/zombie(s) — a move / explore / horn can surface
      // one OR MORE hidden units. Show all their icons + a "FOUND …" note (these
      // replace the old discovery modal). Horn in particular can find several.
      let discovered = null;
      const found = ev.result?.encounterSurvivors
        ?? (ev.result?.encounterSurvivor ? [ev.result.encounterSurvivor] : []);
      if (found.length) {
        discovered = found.map(unitRef);
        const kind = found[0].type === 'zombie' ? 'ZOMBIE' : 'SURVIVOR';
        note = {
          text: found.length > 1 ? `FOUND ${found.length} ${kind}S` : `FOUND ${kind}`,
          kind: found[0].type === 'zombie' ? 'kill' : 'gain',
        };
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
  return { kind, headline, reason, lines };
}
