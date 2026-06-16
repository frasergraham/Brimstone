// Replay XP events — the data path from a campaign XP grant → resolver
// XP_AWARDED step event → renderer "+N XP" aggregation.
//
// Covers:
//   - resolvePlans fans a real kill's XP into an XP_AWARDED step event (campaign)
//   - the gate: the same kill in a non-campaign game emits NO XP event
//   - a unit that earns XP from several awards in one turn produces one event per
//     logical award, which compileTurnXpSummary sums into a single "+N XP" line
//   - level-up annotation ("Lv from → to") + multi-source summing in isolation
//
// Deterministic outcome: the attacker is given an overwhelming flat attack so
// attackRoll = die + 50 dwarfs any defense roll — every swing crush-kills the
// 1-HP victims regardless of which dice the (splash-consuming) rolls land on.
// That keeps the multi-kill case immune to dice desync without hand-counting
// every die the resolver spends.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePlans, ResEventType } from '../server/resolver.js';
import { GameState, Phase } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import { createMinion } from '../src/entities.js';
import { XP_PER_KILL } from '../src/balance.js';
import { compileTurnXpSummary } from '../src/battle-utils.js';
import { hexKey, getNeighbors } from '../src/hex.js';

// Hero leader (has an action budget) vs `count` 1-HP witch victims on adjacent
// hexes. Stats zeroed so the forced dice fully determine the outcome.
function killSetup({ isCampaign, count = 1 } = {}) {
  const state = new GameState(true, true);
  state.isCampaign = isCampaign;
  state.phase = Phase.DAY; // neutral / hero-favorable — guarantees budget ≥ 2
  const hero = state.hero;
  hero.attack = 50; hero.weapon = null; hero.abilities = []; hero.effects = [];
  hero.xp = 0; hero.level = 1;

  const neighbors = getNeighbors(hero.col, hero.row)
    .filter(n => state.tiles.has(hexKey(n.col, n.row)));
  const victims = [];
  for (let i = 0; i < count; i++) {
    const n = neighbors[i] ?? getNeighbors(hero.col, hero.row)[i];
    const v = createMinion(n.col, n.row);
    v.defense = 0; v.weapon = null; v.abilities = []; v.effects = [];
    v.maxHp = 1; v.hp = 1;
    state.entities.push(v);
    victims.push(v);
  }
  return { state, hero, victims };
}

const xpEventsOf = (steps) =>
  steps.flatMap(s => [...(s.heroEvents ?? []), ...(s.witchEvents ?? [])])
       .filter(e => e.type === ResEventType.XP_AWARDED);

describe('resolver — XP_AWARDED step events', () => {
  test('a campaign kill emits one XP_AWARDED event crediting the killer', () => {
    const { state, hero, victims } = killSetup({ isCampaign: true });
    const heroPlan = [{ type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: victims[0].id }];

    const steps = resolvePlans(state, heroPlan, []);
    const xp = xpEventsOf(steps);

    assert.equal(xp.length, 1, 'exactly one XP award for the kill');
    assert.equal(xp[0].type, ResEventType.XP_AWARDED);
    assert.equal(xp[0].unitId, hero.id);
    assert.equal(xp[0].amount, XP_PER_KILL);
    assert.equal(xp[0].reason, 'kill');
    assert.equal(xp[0].faction, 'hero');
  });

  test('the same kill in a NON-campaign game emits no XP_AWARDED event (gate)', () => {
    const { state, hero, victims } = killSetup({ isCampaign: false });
    const heroPlan = [{ type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: victims[0].id }];

    const steps = resolvePlans(state, heroPlan, []);
    assert.equal(xpEventsOf(steps).length, 0, 'no XP events outside campaign');
  });

  test('XP from multiple awards in one turn → one event each, summed to one line', () => {
    const { state, hero, victims } = killSetup({ isCampaign: true, count: 2 });
    // Two kills across two steps (one battle drained per step).
    const heroPlan = [
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: victims[0].id },
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: victims[1].id },
    ];

    const steps = resolvePlans(state, heroPlan, []);
    const xp = xpEventsOf(steps);

    // Both kills landed → two un-summed events, both crediting the hero.
    assert.equal(xp.length, 2, 'one event per logical award (not pre-summed)');
    assert.ok(xp.every(e => e.unitId === hero.id && e.amount === XP_PER_KILL));

    // The renderer-side aggregation collapses them into ONE line per unit.
    const lines = compileTurnXpSummary(steps, state.entities, ResEventType);
    const heroLine = lines.filter(l => l.unitId === hero.id);
    assert.equal(heroLine.length, 1, 'aggregated to a single line for the unit');
    assert.equal(heroLine[0].amount, 2 * XP_PER_KILL);
    assert.match(heroLine[0].text, new RegExp(`\\+${2 * XP_PER_KILL} XP`));
  });
});

describe('compileTurnXpSummary — aggregation + level-up annotation', () => {
  // Two awards for the same unit in one turn, the second crossing a level.
  const steps = [{
    entitySnapshot: [{ id: 7, displayName: 'Goodwife Tam', title: 'Tinker' }],
    heroEvents: [
      { type: ResEventType.XP_AWARDED, faction: 'hero', unitId: 7, amount: 15, reason: 'combat' },
      { type: ResEventType.XP_AWARDED, faction: 'hero', unitId: 7, amount: 50, reason: 'kill',
        leveledUp: true, fromLevel: 2, newLevel: 3 },
    ],
  }];

  test('sums amounts and renders one line with the unit name', () => {
    const lines = compileTurnXpSummary(steps, [], ResEventType);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].amount, 65);
    assert.equal(lines[0].leveledUp, true);
    assert.match(lines[0].text, /Tinker \+65 XP \(Lv 2 → 3\)/);
  });

  test('no XP events → no lines', () => {
    const empty = [{ heroEvents: [{ type: ResEventType.ACTION_OK, action: { type: 'move' } }] }];
    assert.deepEqual(compileTurnXpSummary(empty, [], ResEventType), []);
  });

  test('a multi-level jump reads "Lv low → high" across events', () => {
    const multi = [{
      entitySnapshot: [{ id: 9, displayName: 'Scout', title: null }],
      heroEvents: [
        { type: ResEventType.XP_AWARDED, faction: 'hero', unitId: 9, amount: 50, reason: 'kill',
          leveledUp: true, fromLevel: 1, newLevel: 2 },
        { type: ResEventType.XP_AWARDED, faction: 'hero', unitId: 9, amount: 50, reason: 'kill',
          leveledUp: true, fromLevel: 2, newLevel: 4 },
      ],
    }];
    const lines = compileTurnXpSummary(multi, [], ResEventType);
    assert.equal(lines.length, 1);
    assert.match(lines[0].text, /\(Lv 1 → 4\)/);
  });
});
