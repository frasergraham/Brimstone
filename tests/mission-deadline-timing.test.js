// Mission deadline timing — the "end at END of final turn" rule for non-looping
// day-cycles (docs/09 §5.3, Ch1M3 "The First Night").
//
// Part B regression: a fixed-end mission whose deadline is the final phase of a
// non-looping cycle (e.g. "survive until dawn") must run THROUGH that final turn.
// The win/lose check fires at the END of the final turn (postResolution after the
// final round resolves), NOT at its START — so the player gets to plan & act on
// the dawn turn before victory/defeat is evaluated.
//
// Part A data: the non-looping cycle exposes the progress data the cycle bar reads
// (current round, total rounds, the deadline phase) so the HUD can show a countdown.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, getCycleLength, phaseForRound, Phase } from '../src/game.js';
import { createZombie, createSurvivor } from '../src/entities.js';
import { MissionLogicEngine } from '../src/mission-logic/engine.js';
import { createGameContext } from '../src/mission-logic/game-context.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';

const createEnemyFn = (type, col, row, state) => createZombie(col, row, 'witch', state);

function attach(state, graph) {
  const ctx = createGameContext(state, {
    createEnemyFn,
    emit: (e) => state.logicPresentation.push(e),
    random: () => 0.5,
  });
  const engine = new MissionLogicEngine(graph, ctx);
  state.attachLogicEngine(engine);
  return engine;
}

const exec = (from, pin, to) => ({ from: { node: from, pin }, to: { node: to, pin: 'in' }, kind: 'exec' });

// A First-Night-shaped cycle: 6 fight turns then a final dawn turn (loop:false).
const FIRST_NIGHT_CYCLE = { phases: ['dusk', 'night', 'night', 'night', 'night', 'night', 'dawn'], loop: false };

describe('mission deadline timing — non-looping cycle ends at END of final turn', () => {
  // The phase-deadline outcome graph that Ch1M3 uses: a "survive until dawn" win
  // wired to a cycle-end trigger (the FIXED wiring), and a no-op spawn wired to
  // every round-start so we can prove the final (dawn) round still runs.
  function deadlineGraph() {
    return {
      version: 1, variables: [],
      nodes: [
        { id: 'cend', type: 'onCycleEnd' },
        { id: 'win',  type: 'objectiveOutcome',
          params: { side: 'win', spec: { type: 'survive_with_party', phase: 'dawn', survivors: 0 }, reason: 'Held until dawn.' } },
      ],
      edges: [exec('cend', 'out', 'win')],
    };
  }

  test('the player gets a planning turn AT the deadline phase before the mission is decided', () => {
    const state = new GameState(true, false);  // hero human
    state.cycleConfig = FIRST_NIGHT_CYCLE;
    state.disableScoring = true;               // node scoring irrelevant here
    state.round = 1;
    state.phase = phaseForRound(state.round, state.cycleConfig);
    attach(state, deadlineGraph());

    const len = getCycleLength(state.cycleConfig);   // 7
    assert.equal(len, 7);

    // Resolve rounds up to and INCLUDING the final round. After each endRound the
    // mission must NOT be over until the final (dawn) turn has itself resolved.
    for (let r = 1; r <= len; r++) {
      assert.equal(state.round, r, `should be on round ${r}`);
      // The deadline phase (dawn) IS reached on the final round and the player
      // can still plan it: at the START of round `len` the game is not over.
      state.pumpMissionLogic('roundStart');
      assert.equal(state.gameOver, false,
        `mission must not be decided at the START of round ${r} (phase ${state.phase})`);

      const playedPhase = state.phase;
      state.endRound();                          // resolve round r → advance

      if (r < len) {
        assert.equal(state.gameOver, false,
          `mission must not be over after round ${r} (a ${playedPhase} turn) resolves`);
      }
    }

    // The final (dawn) turn has now been PLAYED and resolved → the deadline fires.
    assert.equal(state.gameOver, true, 'mission decided only AFTER the dawn turn resolves');
    assert.equal(state.winner, 'hero');
  });

  test('cycleEnd fires exactly once, at the boundary — not before, not twice', () => {
    const state = new GameState(true, false);
    state.cycleConfig = FIRST_NIGHT_CYCLE;
    state.disableScoring = true;
    state.round = 1;
    state.phase = phaseForRound(state.round, state.cycleConfig);

    const engine = attach(state, {
      version: 1, variables: [],
      nodes: [{ id: 'cend', type: 'onCycleEnd' }],
      edges: [],
    });
    // Spy on the engine to count cycleEnd dispatches.
    const realDispatch = engine.dispatch.bind(engine);
    let cycleEnds = 0;
    const firedAtRounds = [];
    engine.dispatch = (evt, payload) => {
      if (evt === 'cycleEnd') { cycleEnds++; firedAtRounds.push(state.round); }
      return realDispatch(evt, payload);
    };

    const len = getCycleLength(state.cycleConfig);    // 7
    // Drive rounds well past the deadline (clamped phase keeps returning dawn).
    for (let r = 1; r <= len + 3; r++) state.endRound();

    assert.equal(cycleEnds, 1, 'cycleEnd fires exactly once');
    // It fires the round AFTER the final turn resolves: round len resolves →
    // state.round becomes len+1 → the postResolution pump dispatches cycleEnd.
    assert.deepEqual(firedAtRounds, [len + 1]);
    // Sanity: the clamped phase past the end is still the final phase.
    assert.equal(phaseForRound(len + 3, state.cycleConfig), Phase.DAWN);
  });

  test('non-looping cycle exposes the progress data the cycle bar reads (Part A)', () => {
    const state = new GameState(true, false);
    state.cycleConfig = FIRST_NIGHT_CYCLE;
    state.round = 3;
    state.phase = phaseForRound(state.round, state.cycleConfig);

    // The HUD reads: a non-looping flag, the total count, current round, deadline.
    assert.equal(state.cycleConfig.loop, false);
    const total = getCycleLength(state.cycleConfig);
    assert.equal(total, 7);
    assert.equal(state.round, 3);
    const deadlinePhase = state.cycleConfig.phases[total - 1];
    assert.equal(deadlinePhase, Phase.DAWN);
    // Rounds remaining (inclusive of the current playable round through the final).
    const remaining = Math.max(0, total - state.round + 1);
    assert.equal(remaining, 5);
  });

  test('REAL Ch1M3 "The First Night": the player gets to play the dawn turn before the win fires', () => {
    // Load the shipped mission graph and run it through the same fire-points the
    // live loop uses (roundStart pump before planning; endRound after resolution).
    const hollow = getCampaignById('calebs_hollow_prologue');
    const m = hollow.missions.find(x => x.id === 'first_night');
    assert.ok(m?.logic, 'first_night must have a logic graph');
    assert.equal(m.phaseCycle.loop, false);
    assert.equal(m.phaseCycle.phases[m.phaseCycle.phases.length - 1], Phase.DAWN);

    const state = new GameState(true, false);   // hero human
    state.cycleConfig = { phases: [...m.phaseCycle.phases], loop: false };
    state.disableScoring = true;
    state.round = 1;
    state.phase = phaseForRound(state.round, state.cycleConfig);
    // Give the hero a 2-survivor party so survive_with_party (≥2) can be met.
    state.entities.push(createSurvivor(state.hero.col, state.hero.row, 'hero', state));
    state.entities.push(createSurvivor(state.hero.col, state.hero.row, 'hero', state));

    const ctx = createGameContext(state, {
      createEnemyFn,
      emit: (e) => state.logicPresentation.push(e),
      random: () => 0.5,
    });
    state.attachLogicEngine(new MissionLogicEngine(m.logic, ctx));

    const len = getCycleLength(state.cycleConfig);    // 7 → dawn is round 7
    let dawnTurnPlanned = false;

    for (let r = 1; r <= len; r++) {
      // Pre-planning pump (what _startLocalPlanningPhase does each round).
      state.pumpMissionLogic('roundStart');
      assert.equal(state.gameOver, false,
        `mission must not be decided at the START of round ${r} (${state.phase})`);
      if (state.phase === Phase.DAWN) dawnTurnPlanned = true;  // player reaches dawn planning
      state.endRound();                                        // resolve the round
    }

    // The off-by-one regression: the player MUST reach a dawn planning turn, and
    // the mission MUST stay undecided through every roundStart (including dawn's)
    // — only resolving after the final dawn turn. (Winner depends on combat, which
    // this harness doesn't simulate; timing is what we assert.)
    assert.equal(dawnTurnPlanned, true, 'the player reached a DAWN planning turn');
    assert.equal(state.gameOver, true, 'mission is decided once the dawn turn has resolved');
    assert.ok(['hero', 'witch'].includes(state.winner), 'the deadline produced an outcome');
  });

  test('looping cycles do NOT trigger the cycle-end deadline (normal games unchanged)', () => {
    const state = new GameState(true, false);
    state.cycleConfig = { phases: ['dawn', 'day', 'day', 'day'], loop: true };
    state.disableScoring = true;
    state.round = 1;
    state.phase = phaseForRound(state.round, state.cycleConfig);
    let everOver = false;
    attach(state, {
      version: 1, variables: [],
      nodes: [
        { id: 'cend', type: 'onCycleEnd' },
        { id: 'win',  type: 'objectiveOutcome',
          params: { side: 'win', spec: { type: 'survive_with_party', phase: 'dawn', survivors: 0 } } },
      ],
      edges: [exec('cend', 'out', 'win')],
    });
    for (let r = 1; r <= 12; r++) {
      state.endRound();
      if (state.gameOver) everOver = true;
    }
    assert.equal(everOver, false, 'a looping cycle never reaches a cycle-end deadline');
  });
});
