// Tests for compileTurnBattleSummary in src/battle-utils.js.
// Verifies that battle events are aggregated correctly into per-pair damage reports.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTurnBattleSummary, compileTurnBattlePairs, collectTurnFinds } from '../src/battle-utils.js';
import { ResEventType } from '../server/resolver.js';
import { PlanActionType } from '../src/planner.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSnap(id, title, owner, hp = 10) {
  return { id, title, displayName: title, owner, hp, alive: true, col: 0, row: 0 };
}

function makeBattleEvent(actorSnap, targetSnap, damage, counterDmg = 0, killed = false) {
  return {
    type:        ResEventType.ACTION_OK,
    faction:     actorSnap.owner,
    action:      { type: PlanActionType.BATTLE_UNIT, entityId: actorSnap.id, targetId: targetSnap.id },
    result:      { damage, counterDmg, killed, hit: damage > 0, success: true, cost: 1, log: [] },
    battleSnaps: { actorSnap, targetSnap },
  };
}

function makeStep(events) {
  return {
    stepIndex:      0,
    heroEvents:     events.filter(e => e.faction === 'hero'),
    witchEvents:    events.filter(e => e.faction === 'witch'),
    entitySnapshot: [],
  };
}

// Final entity state: alive entities still in array with alive=true
function aliveEntities(...snaps) {
  return snaps.map(s => ({ ...s, alive: true }));
}

function killedEntities(killed, ...alive) {
  return [
    ...alive.map(s => ({ ...s, alive: true })),
    { ...killed, alive: false },
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('compileTurnBattleSummary', () => {
  test('returns empty array when no battle events', () => {
    const steps = [makeStep([])];
    const result = compileTurnBattleSummary(steps, [], ResEventType, PlanActionType);
    assert.deepEqual(result, []);
  });

  test('single hit — target loses HP, attacker takes no counter', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    const witch = makeSnap('w1', 'Witch', 'witch', 10);
    const ev    = makeBattleEvent(hero, witch, 2, 0);
    const steps = [makeStep([ev])];
    const lines = compileTurnBattleSummary(steps, aliveEntities(hero, witch), ResEventType, PlanActionType);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Hero vs Witch/);
    assert.match(lines[0], /Witch \u22122HP/);
    // Hero took no damage — should not appear
    assert.doesNotMatch(lines[0], /Hero \u2212/);
  });

  test('counter-attack — both units lose HP', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    const witch = makeSnap('w1', 'Witch', 'witch', 10);
    const ev    = makeBattleEvent(hero, witch, 2, 1); // hero hits 2, counter 1 to hero
    const steps = [makeStep([ev])];
    const lines = compileTurnBattleSummary(steps, aliveEntities(hero, witch), ResEventType, PlanActionType);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Witch \u22122HP/);
    assert.match(lines[0], /Hero \u22121HP/);
  });

  test('multiple attacks between same pair are aggregated', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    const witch = makeSnap('w1', 'Witch', 'witch', 10);
    // Round 1: hero hits witch for 2
    const ev1 = makeBattleEvent(hero, witch, 2, 0);
    // Round 2: witch hits hero for 3
    const ev2 = makeBattleEvent(witch, hero, 3, 0);
    const steps = [makeStep([ev1]), makeStep([ev2])];
    const lines = compileTurnBattleSummary(steps, aliveEntities(hero, witch), ResEventType, PlanActionType);
    assert.equal(lines.length, 1, 'Should be a single aggregated line');
    assert.match(lines[0], /Witch \u22122HP/);
    assert.match(lines[0], /Hero \u22123HP/);
  });

  test('kill shows skull emoji', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    const witch = makeSnap('w1', 'Witch', 'witch', 2);
    const ev    = makeBattleEvent(hero, witch, 2, 0, true); // witch killed
    const steps = [makeStep([ev])];
    const lines = compileTurnBattleSummary(
      steps,
      killedEntities(witch, hero),
      ResEventType,
      PlanActionType,
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\u{1F480}/u); // skull emoji
    assert.match(lines[0], /Witch/);
  });

  test('clean miss (no damage) produces no summary line', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    const witch = makeSnap('w1', 'Witch', 'witch', 10);
    const ev    = makeBattleEvent(hero, witch, 0, 0, false); // miss
    const steps = [makeStep([ev])];
    const lines = compileTurnBattleSummary(steps, aliveEntities(hero, witch), ResEventType, PlanActionType);
    assert.deepEqual(lines, [], 'Miss with no damage should produce no summary');
  });

  test('two separate battles are reported as two lines', () => {
    const hero    = makeSnap('h1', 'Hero',    'hero',  14);
    const witch   = makeSnap('w1', 'Witch',   'witch', 10);
    const zombie  = makeSnap('z1', 'Zombie',  'witch',  2);
    const ev1 = makeBattleEvent(hero, witch,  1, 0);
    const ev2 = makeBattleEvent(hero, zombie, 2, 0);
    const steps = [makeStep([ev1, ev2])];
    const lines = compileTurnBattleSummary(steps, aliveEntities(hero, witch, zombie), ResEventType, PlanActionType);
    assert.equal(lines.length, 2);
    const text = lines.join('\n');
    assert.match(text, /Hero vs Witch/);
    assert.match(text, /Hero vs Zombie/);
  });

  test('uses title field for entity name', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    // Survivor with a specific title
    const surv  = { id: 's1', title: 'Samuel Cooper', displayName: 'Samuel Cooper', owner: 'hero', hp: 3, alive: true };
    const witch = makeSnap('w1', 'Witch', 'witch', 10);
    const ev    = makeBattleEvent(witch, surv, 2, 0);
    const steps = [makeStep([ev])];
    const lines = compileTurnBattleSummary(steps, aliveEntities(hero, surv, witch), ResEventType, PlanActionType);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Samuel Cooper/);
  });

  test('playerEvents format (online MP) is also processed', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    const witch = makeSnap('w1', 'Witch', 'witch', 10);
    const ev    = makeBattleEvent(hero, witch, 3, 0);
    const step  = {
      stepIndex: 0,
      playerEvents: [
        { playerId: 'p1', faction: 'hero',  events: [ev] },
        { playerId: 'p2', faction: 'witch', events: [] },
      ],
      entitySnapshot: [],
    };
    const lines = compileTurnBattleSummary([step], aliveEntities(hero, witch), ResEventType, PlanActionType);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Witch \u22123HP/);
  });
});

describe('compileTurnBattlePairs (structured wrap-up data)', () => {
  test('returns per-pair units with HP loss and kill flags', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    const witch = makeSnap('w1', 'Witch', 'witch', 2);
    const ev    = makeBattleEvent(hero, witch, 2, 1, true);  // witch killed, hero counter 1
    const steps = [makeStep([ev])];
    const pairs = compileTurnBattlePairs(steps, killedEntities(witch, hero), ResEventType, PlanActionType);
    assert.equal(pairs.length, 1);
    const { a, b } = pairs[0];
    // a is the lower id (h1) \u2014 the hero; b the witch.
    assert.equal(a.name, 'Hero');
    assert.equal(a.hpLost, 1);        // counter damage
    assert.equal(a.killed, false);
    assert.equal(b.name, 'Witch');
    assert.equal(b.hpLost, 2);
    assert.equal(b.killed, true);
  });

  test('includes no-damage fights (clean miss) so the card still shows the combat', () => {
    const hero  = makeSnap('h1', 'Hero',  'hero',  14);
    const witch = makeSnap('w1', 'Witch', 'witch', 10);
    const ev    = makeBattleEvent(hero, witch, 0, 0, false);  // clean miss
    const pairs = compileTurnBattlePairs([makeStep([ev])], aliveEntities(hero, witch), ResEventType, PlanActionType);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].a.hpLost, 0);
    assert.equal(pairs[0].b.hpLost, 0);
    assert.equal(pairs[0].a.killed, false);
  });
});

describe('collectTurnFinds', () => {
  const exploreEvent = (faction, entityId, lootItems, survivor = null) => ({
    type:   ResEventType.ACTION_OK,
    faction,
    action: { type: PlanActionType.EXPLORE, entityId },
    result: { success: true, cost: 1, log: [], lootItems, encounterSurvivor: survivor },
  });

  test('counts only the human faction\'s explore loot (AI loot excluded)', () => {
    // Both sides find wood; the player's summary must show wood once, not twice.
    const steps = [makeStep([
      exploreEvent('hero',  'h1', ['+🪵']),
      exploreEvent('witch', 'w1', ['+🪵']),
    ])];
    const { loot } = collectTurnFinds(steps, 'hero');
    assert.deepEqual(loot, ['+🪵']);
  });

  test('aggregates the human\'s own multiple explores (wood then food)', () => {
    const steps = [makeStep([
      exploreEvent('hero', 'h1', ['+🪵']),
      exploreEvent('hero', 'h2', ['+🍞']),
    ])];
    const { loot } = collectTurnFinds(steps, 'hero');
    assert.deepEqual(loot, ['+🪵', '+🍞']);
  });

  test('drops "nothing" rolls and counts all loot when no humanFaction', () => {
    const steps = [makeStep([exploreEvent('hero', 'h1', ['+🪵', 'nothing', '+🪵'])])];
    assert.deepEqual(collectTurnFinds(steps, null).loot, ['+🪵', '+🪵']);
  });

  test('collects only the human faction\'s discoveries', () => {
    const mine   = { id: 's9', type: 'survivor', name: 'Mara' };
    const theirs = { id: 's4', type: 'survivor', name: 'Goodman Pyke' };
    const steps = [makeStep([
      exploreEvent('hero',  'h1', [], mine),
      exploreEvent('witch', 'w1', [], theirs),
    ])];
    const { discoveries } = collectTurnFinds(steps, 'hero');
    assert.equal(discoveries.length, 1);
    assert.equal(discoveries[0].name, 'Mara');
  });

  test('counts discoveries from both sides when no humanFaction', () => {
    const a = { id: 's9', type: 'survivor', name: 'Mara' };
    const b = { id: 's4', type: 'survivor', name: 'Goodman Pyke' };
    const steps = [makeStep([
      exploreEvent('hero',  'h1', [], a),
      exploreEvent('witch', 'w1', [], b),
    ])];
    assert.equal(collectTurnFinds(steps, null).discoveries.length, 2);
  });

  // Fog-of-war regression: node-spawned survivors are always hero-faction
  // (power-node night procs). When the viewer is the witch (online MP or
  // local two-player), surfacing them in the wrap-up leaks hero-side info.
  test('filters hero-tagged node-spawned survivors from a witch viewer', () => {
    const spawned = [{ id: 's7', type: 'survivor', name: 'Hannah', faction: 'hero' }];
    const { discoveries } = collectTurnFinds([], 'witch', spawned);
    assert.equal(discoveries.length, 0,
      'witch viewer must not see hero-side node-spawned survivors');
  });

  test('includes hero-tagged node-spawned survivors for the hero viewer', () => {
    const spawned = [{ id: 's7', type: 'survivor', name: 'Hannah', faction: 'hero' }];
    const { discoveries } = collectTurnFinds([], 'hero', spawned);
    assert.equal(discoveries.length, 1);
    assert.equal(discoveries[0].name, 'Hannah');
  });

  test('includes all node-spawned survivors when no humanFaction (AI vs AI / spectator)', () => {
    const spawned = [{ id: 's7', type: 'survivor', name: 'Hannah', faction: 'hero' }];
    const { discoveries } = collectTurnFinds([], null, spawned);
    assert.equal(discoveries.length, 1);
  });
});
