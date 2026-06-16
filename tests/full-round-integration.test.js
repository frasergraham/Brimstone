// Full-round integration: the offline orchestration sequence from src/main.js
// exercised end-to-end against real game state — plan → resolvePlans →
// finalizeRound → phase advance / node scoring / victory. Guards parity of the
// shared rule path (actions.js, game.js, server/resolver.js) that both the
// offline and online orchestrators depend on.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans } from '../server/resolver.js';
import { GameState, Phase } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import { createMinion } from '../src/entities.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { getReachableHexes } from '../src/actions.js';

function freshState() {
  return new GameState(true, true);
}

// Park an entity on a hex that belongs to no power-node cluster so it cannot
// influence node control.
function moveOffNodes(state, entity) {
  const nodeHexes = new Set();
  for (const obj of state.witchObjectives) {
    for (const h of obj.hexes) nodeHexes.add(`${h.col},${h.row}`);
  }
  for (const [, t] of state.tiles) {
    if (!nodeHexes.has(`${t.col},${t.row}`)) {
      entity.col = t.col;
      entity.row = t.row;
      return;
    }
  }
  assert.fail('no off-node tile found');
}

describe('full round — plan → resolve → finalizeRound', () => {
  test('moves execute, then the round and phase advance', () => {
    const state = freshState();
    assert.equal(state.round, 1);
    assert.equal(state.phase, Phase.DAWN);

    state.startPlanning();
    assert.ok(state.planningPhase, 'startPlanning should open planning');
    assert.ok(state.heroActionsLeft > 0, 'hero should have an action budget');

    const heroDest  = getReachableHexes(state, state.hero, 1)[0];
    const witchDest = getReachableHexes(state, state.witch, 1)[0];
    assert.ok(heroDest,  'hero should have a reachable hex on a fresh map');
    assert.ok(witchDest, 'witch should have a reachable hex on a fresh map');

    const heroPlan  = [{ type: PlanActionType.MOVE, entityId: state.hero.id,
                         toCol: heroDest.col,  toRow: heroDest.row }];
    const witchPlan = [{ type: PlanActionType.MOVE, entityId: state.witch.id,
                         toCol: witchDest.col, toRow: witchDest.row }];

    const steps = resolvePlans(state, heroPlan, witchPlan);
    assert.ok(steps.length > 0, 'resolution should produce at least one TURN step');
    assert.deepEqual({ col: state.hero.col,  row: state.hero.row },
                     { col: heroDest.col,    row: heroDest.row },
                     'hero should end on the planned hex');
    assert.deepEqual({ col: state.witch.col, row: state.witch.row },
                     { col: witchDest.col,   row: witchDest.row },
                     'witch should end on the planned hex');

    const logBefore = state.log.length;
    state.finalizeRound();
    assert.equal(state.round, 2, 'round should advance');
    assert.equal(state.phase, Phase.DAY, 'round 2 of the cycle is DAY');
    assert.ok(!state.gameOver, 'a single quiet round should not end the game');
    assert.ok(state.log.length > logBefore, 'finalizeRound should log the new round');
  });

  test('battle resolved mid-round kills the target and bumps the kill counter', () => {
    const state = freshState();
    state.startPlanning();

    state.hero.attackBonus = 100; // guarantee the hit regardless of dice
    const minion = createMinion(state.hero.col, state.hero.row);
    minion.hp = 1; minion.maxHp = 1;
    state.entities.push(minion);
    const killsBefore = state.heroKills;

    const heroPlan = [{ type: PlanActionType.BATTLE_UNIT,
                        entityId: state.hero.id, targetId: minion.id }];
    resolvePlans(state, heroPlan, []);

    assert.ok(!state.entities.some(e => e.id === minion.id),
      'killed minion should be removed from play');
    assert.equal(state.heroKills, killsBefore + 1,
      'heroKills counter should record the kill');

    state.finalizeRound();
    assert.equal(state.heroKills, killsBefore + 1,
      'kill counter should survive end-of-round');
  });

  test('dusk checkpoint scores a point for the side holding more nodes', () => {
    const state = freshState();
    // Round 4 is the last DAY round; endRound advances to round 5 = DUSK,
    // which triggers node scoring.
    state.round = 4;
    state.phase = Phase.DAY;

    const node = state.witchObjectives[0];
    state.hero.col = node.hexes[0].col;
    state.hero.row = node.hexes[0].row;
    moveOffNodes(state, state.witch);

    state.finalizeRound();
    assert.equal(state.phase, Phase.DUSK);
    assert.equal(state.nodeScore.hero, 1, 'hero holding the only node scores at dusk');
    assert.equal(state.nodeScore.witch, 0);
    assert.ok(!state.gameOver, 'one point should not end the game');
  });

  test('reaching the node-score threshold wins the game', () => {
    const state = freshState();
    state.round = 4;
    state.phase = Phase.DAY;
    state.nodeScore.hero = state.nodeScoreThreshold - 1;

    const node = state.witchObjectives[0];
    state.hero.col = node.hexes[0].col;
    state.hero.row = node.hexes[0].row;
    moveOffNodes(state, state.witch);

    state.finalizeRound();
    assert.equal(state.nodeScore.hero, state.nodeScoreThreshold);
    assert.ok(state.gameOver, 'hitting the threshold should end the game');
    assert.equal(state.winner, 'hero');
  });

  test('post-round state survives a serialize/deserialize round-trip', () => {
    const state = freshState();
    state.startPlanning();
    const dest = getReachableHexes(state, state.hero, 1)[0];
    assert.ok(dest);
    resolvePlans(state,
      [{ type: PlanActionType.MOVE, entityId: state.hero.id,
         toCol: dest.col, toRow: dest.row }], []);
    state.finalizeRound();

    const restored = deserializeState(serializeState(state));
    assert.equal(restored.round, state.round);
    assert.equal(restored.phase, state.phase);
    assert.deepEqual(restored.nodeScore, state.nodeScore);
    assert.equal(restored.entities.length, state.entities.length);
    const hero = restored.entities.find(e => e.id === state.hero.id);
    assert.ok(hero, 'hero should survive the round-trip');
    assert.deepEqual({ col: hero.col, row: hero.row },
                     { col: state.hero.col, row: state.hero.row });
  });
});
