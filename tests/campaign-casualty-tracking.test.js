// Regression: campaign permadeath must survive the fact that combat REMOVES a
// dead entity from `state.entities` the instant it dies. The reconcile/collect
// functions scan the survivors still on the board, so a corpse that's already
// been spliced out is invisible to them — dead survivors were silently restored
// from the pre-mission roster (with their gear) and never reached the memorial.
//
// The fix is a casualty ledger (`state.casualties`) populated at every death
// site, fed back into reconcileRosterAfterMission/collectFallenAfterMission as a
// union with the live entities. These tests drive a REAL combat kill (not a
// hand-built dead entity left in the array, which is the blind spot the existing
// permadeath test had) and assert the dead survivor is dropped + mourned, and
// that the ledger round-trips through state-sync for mid-mission resume.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import { Entity, EntityType, createMinion, resetRoster, SURVIVOR_ROSTER } from '../src/entities.js';
import { executeBattle } from '../src/actions.js';
import { reconcileRosterAfterMission, collectFallenAfterMission } from '../src/campaign/campaign.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { TileType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';

// Kill a hero-faction survivor with one forced crush on a neutral tile, exactly
// the way real play does (the minion's blow runs the live executeBattle path).
function killSurvivorInCombat() {
  resetRoster();
  const state = new GameState(true, true);
  const t = state.tiles.get(hexKey(2, 2));
  t.base = TileType.GRASS; t.fortifyLevel = 0;

  const attacker = createMinion(2, 2);          // witch-side
  attacker.attack = 0; attacker.weapon = null; attacker.abilities = []; attacker.effects = [];

  const name = SURVIVOR_ROSTER[0].name;
  const surv = new Entity(EntityType.SURVIVOR, 'hero', 2, 2);
  surv.name = name; surv.title = SURVIVOR_ROSTER[0].title; surv.level = 2;
  surv.defense = 0; surv.weapon = null; surv.abilities = []; surv.effects = [];
  surv.maxHp = 1; surv.hp = 1; surv.items = {};

  state.entities = [attacker, surv];
  state.phase = Phase.DAY;                       // neutral — no phase bonus either side
  state.setForcedDice(6, 1, 6, 6);              // attacker wins big → kill
  const r = executeBattle(state, attacker, surv);
  return { state, surv, r, name };
}

describe('combat casualty ledger', () => {
  test('a survivor killed in combat is removed from entities AND recorded as a casualty', () => {
    const { state, surv, r, name } = killSurvivorInCombat();
    assert.equal(r.killed, true, 'forced dice should kill the survivor');
    assert.ok(!state.entities.find(e => e.id === surv.id), 'dead survivor is spliced from entities');
    assert.ok(Array.isArray(state.casualties), 'state.casualties exists');
    const rec = state.casualties.find(c => c.name === name);
    assert.ok(rec, 'the dead survivor is in the casualty ledger');
    assert.equal(rec.alive, false);
    assert.equal(rec.level, 2);
  });

  test('non-survivor deaths are NOT recorded (minions/zombies do not bloat the ledger)', () => {
    resetRoster();
    const state = new GameState(true, true);
    const t = state.tiles.get(hexKey(2, 2));
    t.base = TileType.GRASS; t.fortifyLevel = 0;
    const minion = createMinion(2, 2);
    minion.maxHp = 1; minion.hp = 1; minion.defense = 0; minion.weapon = null;
    minion.abilities = []; minion.effects = [];
    state.entities = [state.hero, minion];
    state.hero.col = 2; state.hero.row = 2;
    state.phase = Phase.DAY;
    state.setForcedDice(6, 1, 6, 6);
    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.killed, true);
    assert.equal(state.casualties.length, 0, 'a dead minion leaves the ledger empty');
  });
});

describe('post-mission reconcile sees combat casualties (the real bug)', () => {
  test('a deployed survivor killed in combat is DROPPED from the roster, not restored', () => {
    const { state, name } = killSurvivorInCombat();
    const preMissionRoster = [{ name, title: 'T', level: 2, items: { sword: { count: 1, equipped: true } } }];
    const endEntities = [...state.entities, ...state.casualties];
    const result = reconcileRosterAfterMission(preMissionRoster, endEntities);
    assert.ok(!result.find(s => s.name === name),
      'the dead survivor (and their gear) must not carry over');
  });

  test('a deployed survivor killed in combat is MOURNED in the memorial', () => {
    const { state, name } = killSurvivorInCombat();
    const endEntities = [...state.entities, ...state.casualties];
    const fallen = collectFallenAfterMission(endEntities, 'first_night');
    assert.equal(fallen.length, 1);
    assert.equal(fallen[0].name, name);
    assert.equal(fallen[0].diedInMission, 'first_night');
  });

  test('without the casualty union, the corpse is invisible (documents the prior bug)', () => {
    const { state, name } = killSurvivorInCombat();
    // Scanning ONLY the live board (the old behaviour) finds no corpse, so the
    // dead survivor is wrongly preserved and never mourned.
    const preMissionRoster = [{ name, title: 'T', level: 2 }];
    const survived = reconcileRosterAfterMission(preMissionRoster, state.entities);
    assert.ok(survived.find(s => s.name === name), 'board-only scan wrongly keeps the dead');
    assert.equal(collectFallenAfterMission(state.entities, 'm').length, 0,
      'board-only scan mourns nobody');
  });
});

describe('casualty ledger survives state-sync (mid-mission resume)', () => {
  test('serializeState/deserializeState round-trips state.casualties', () => {
    const { state, name } = killSurvivorInCombat();
    const restored = deserializeState(serializeState(state));
    assert.ok(Array.isArray(restored.casualties));
    const rec = restored.casualties.find(c => c.name === name);
    assert.ok(rec, 'casualty survives the snapshot round-trip');
    assert.equal(rec.alive, false);
  });
});
