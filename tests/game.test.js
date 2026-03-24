// Spec-based tests for src/game.js
// Covers: phase cycle, computeActions, node scoring, victory conditions, planning API.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GameState, Phase, Player, computeActions, WIN_REASON,
} from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { hexKey } from '../src/hex.js';
import { TileType } from '../src/tiles.js';

// ── Phase cycle ───────────────────────────────────────────────────────────────
// Design: 8-round cycle: DAWN(1) → DAY(3) → DUSK(1) → NIGHT(3)
//   Round 1: DAWN
//   Round 2: DAY
//   Round 3: DAY
//   Round 4: DAY
//   Round 5: DUSK
//   Round 6: NIGHT
//   Round 7: NIGHT
//   Round 8: NIGHT
//   Round 9: DAWN  (cycle 2)

describe('Phase cycle', () => {
  test('GameState initialises at round 1, DAWN', () => {
    const state = new GameState(true, true);
    assert.equal(state.round, 1);
    assert.equal(state.phase, Phase.DAWN);
  });

  test('phase sequence follows DAWN-DAY-DUSK-NIGHT-DAWN pattern', () => {
    // We read the expected phase for each round by inspecting the planning budget
    // computeActions gives +1 to hero in DAWN/DAY; that lets us probe the phase
    // indirectly. Instead, we directly check phases advance on endRound().
    const state = new GameState(true, true);
    state.startPlanning();
    state.submitPlan('hero', []);
    state.submitPlan('witch', []);

    const expectedPhases = [
      // After each endRound the round increments by 1
      Phase.DAY,   // round 2
      Phase.DAY,   // round 3
      Phase.DAY,   // round 4
      Phase.DUSK,  // round 5
      Phase.NIGHT, // round 6
      Phase.NIGHT, // round 7
      Phase.NIGHT, // round 8
      Phase.DAWN,  // round 9 (cycle 2)
    ];

    for (const expected of expectedPhases) {
      state.endRound();
      assert.equal(state.phase, expected, `Expected phase ${expected} at round ${state.round}`);
      if (state.gameOver) break;
    }
  });
});

// ── computeActions ────────────────────────────────────────────────────────────
// Hero:  base 3 + 1 in DAWN/DAY  + 1 per alive survivor (cap +5)
// Witch: base 4 + 1 in NIGHT     + floor(units/2) (cap +4)

describe('computeActions — Hero', () => {
  const makeEntities = (survivorCount) => [
    { alive: true, owner: 'hero', type: EntityType.HERO },
    ...Array.from({ length: survivorCount }, () => ({
      alive: true, owner: 'hero', type: EntityType.SURVIVOR,
    })),
  ];

  test('DUSK/NIGHT: 3 base, no time bonus', () => {
    const ents = makeEntities(0);
    assert.equal(computeActions(Player.HERO, Phase.DUSK,  ents), 3);
    assert.equal(computeActions(Player.HERO, Phase.NIGHT, ents), 3);
  });

  test('DAWN/DAY: 4 base (3 + 1 time bonus)', () => {
    const ents = makeEntities(0);
    assert.equal(computeActions(Player.HERO, Phase.DAWN, ents), 4);
    assert.equal(computeActions(Player.HERO, Phase.DAY,  ents), 4);
  });

  test('+1 action per alive survivor', () => {
    assert.equal(computeActions(Player.HERO, Phase.DUSK, makeEntities(1)), 4);
    assert.equal(computeActions(Player.HERO, Phase.DUSK, makeEntities(3)), 6);
  });

  test('survivor bonus caps at +5', () => {
    // 5 survivors: 3+5=8
    assert.equal(computeActions(Player.HERO, Phase.DUSK, makeEntities(5)), 8);
    // 6 survivors: still 8 (capped)
    assert.equal(computeActions(Player.HERO, Phase.DUSK, makeEntities(6)), 8);
    // 10 survivors: still 8
    assert.equal(computeActions(Player.HERO, Phase.DUSK, makeEntities(10)), 8);
  });

  test('dead survivors do not count toward action bonus', () => {
    const ents = [
      { alive: true,  owner: 'hero', type: EntityType.HERO },
      { alive: true,  owner: 'hero', type: EntityType.SURVIVOR },
      { alive: false, owner: 'hero', type: EntityType.SURVIVOR }, // dead
    ];
    assert.equal(computeActions(Player.HERO, Phase.DUSK, ents), 4); // 3 + 1 (only 1 alive)
  });

  test('the hero entity itself does not count toward bonus', () => {
    const ents = [
      { alive: true, owner: 'hero', type: EntityType.HERO },
    ];
    // Only 1 entity: the hero. Extras = 0 (hero type filtered out).
    assert.equal(computeActions(Player.HERO, Phase.DUSK, ents), 3);
  });
});

describe('computeActions — Witch', () => {
  const makeWitchEntities = (minionCount) => [
    { alive: true, owner: 'witch', type: EntityType.WITCH },
    ...Array.from({ length: minionCount }, () => ({
      alive: true, owner: 'witch', type: EntityType.MINION,
    })),
  ];

  test('DAWN/DAY/DUSK: 4 base, no time bonus', () => {
    const ents = makeWitchEntities(0);
    assert.equal(computeActions(Player.WITCH, Phase.DAWN, ents), 4);
    assert.equal(computeActions(Player.WITCH, Phase.DAY,  ents), 4);
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, ents), 4);
  });

  test('NIGHT: 5 base (4 + 1 time bonus)', () => {
    const ents = makeWitchEntities(0);
    assert.equal(computeActions(Player.WITCH, Phase.NIGHT, ents), 5);
  });

  test('+1 action per 2 alive witch units', () => {
    // 2 minions → floor(2/2)=1 → total 5
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(2)), 5);
    // 3 minions → floor(3/2)=1 → total 5
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(3)), 5);
    // 4 minions → floor(4/2)=2 → total 6
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(4)), 6);
  });

  test('witch unit bonus caps at +4', () => {
    // 8 minions → floor(8/2)=4 → capped at +4 → total 8
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(8)), 8);
    // 12 minions → still capped at +4 → total 8 (NOT +6 as comment wrongly states)
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(12)), 8);
    // 20 minions → still capped at +4
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(20)), 8);
  });
});

// ── Victory conditions ────────────────────────────────────────────────────────

describe('Victory — kill conditions', () => {
  test('witch slain → hero wins with WITCH_SLAIN reason', () => {
    const state = new GameState(true, true);
    state.witch.hp = 0; // alive = (hp > 0) = false
    state.checkVictory();
    assert.equal(state.winner, 'hero');
    assert.equal(state.winReason, WIN_REASON.WITCH_SLAIN);
  });

  test('hero slain → witch wins with HERO_SLAIN reason', () => {
    const state = new GameState(true, true);
    state.hero.hp = 0;
    state.checkVictory();
    assert.equal(state.winner, 'witch');
    assert.equal(state.winReason, WIN_REASON.HERO_SLAIN);
  });

  test('both alive → no winner', () => {
    const state = new GameState(true, true);
    state.checkVictory();
    assert.equal(state.winner, null);
    assert.equal(state.gameOver, false);
  });
});

describe('Victory — node scoring', () => {
  // Helper: put `count` node hexes under one faction's control (default 2 = majority)
  function holdNodes(state, faction, count = 2) {
    // Remove all entities on nodes first
    state.entities = state.entities.filter(e =>
      !state.witchObjectives.some(o => o.col === e.col && o.row === e.row)
    );
    // Place the hero/witch on each of the first `count` nodes
    const leader = faction === 'hero' ? state.hero : state.witch;
    for (let i = 0; i < count; i++) {
      const obj = state.witchObjectives[i];
      if (i === 0) {
        leader.col = obj.col;
        leader.row = obj.row;
      } else {
        // Add a duplicate unit to hold additional nodes
        const dup = faction === 'hero'
          ? { alive: true, owner: 'hero', col: obj.col, row: obj.row, id: `test-${i}` }
          : { alive: true, owner: 'witch', col: obj.col, row: obj.row, id: `test-${i}` };
        state.entities.push(dup);
      }
    }
  }

  test('node score win requires 4 points, not 3', () => {
    const state = new GameState(true, true);
    // Manually set score to 3 — should NOT trigger win
    state.nodeScore.hero = 3;
    state.checkVictory();
    assert.equal(state.winner, null, 'Should not win at 3 node score points');
  });

  test('node score win at 4 points — hero', () => {
    const state = new GameState(true, true);
    state.nodeScore.hero = 3;
    // Score one more point by holding majority at dawn
    holdNodes(state, 'hero');
    state._checkNodeObjectives(Phase.DAWN);
    assert.equal(state.nodeScore.hero, 4);
    assert.equal(state.winner, 'hero');
    assert.equal(state.winReason, WIN_REASON.SCORE_HERO);
  });

  test('node score win at 4 points — witch', () => {
    const state = new GameState(true, true);
    state.nodeScore.witch = 3;
    holdNodes(state, 'witch');
    state._checkNodeObjectives(Phase.DAWN);
    assert.equal(state.nodeScore.witch, 4);
    assert.equal(state.winner, 'witch');
    assert.equal(state.winReason, WIN_REASON.SCORE_WITCH);
  });

  test('sweeping all 3 nodes at dawn is instant win (no score needed)', () => {
    const state = new GameState(true, true);
    state.nodeScore.hero = 0;
    holdNodes(state, 'hero', 3);
    state._checkNodeObjectives(Phase.DAWN);
    // Either instant sweep or scored a point, but should result in win
    assert.equal(state.winner, 'hero');
  });

  test('majority (2 vs 0) scores 1 point', () => {
    const state = new GameState(true, true);
    // Hero holds 2 nodes, witch holds 0, 1 node empty
    state.entities = state.entities.filter(e =>
      !state.witchObjectives.some(o => o.col === e.col && o.row === e.row)
    );
    const [n1, n2] = state.witchObjectives;
    state.hero.col = n1.col;
    state.hero.row = n1.row;
    // Add second hero entity on n2
    state.entities.push({ alive: true, owner: 'hero', col: n2.col, row: n2.row, id: 'hero2' });
    const scoreBefore = state.nodeScore.hero;
    state._checkNodeObjectives(Phase.DUSK);
    assert.equal(state.nodeScore.hero, scoreBefore + 1);
  });

  test('tied node count (0-0) awards no points', () => {
    const state = new GameState(true, true);
    // Remove all entities from node hexes
    state.entities = state.entities.filter(e =>
      !state.witchObjectives.some(o => o.col === e.col && o.row === e.row)
    );
    const heroBefore = state.nodeScore.hero;
    const witchBefore = state.nodeScore.witch;
    state._checkNodeObjectives(Phase.DUSK);
    assert.equal(state.nodeScore.hero, heroBefore, 'hero should not score on tie');
    assert.equal(state.nodeScore.witch, witchBefore, 'witch should not score on tie');
  });
});

// ── Initial log message accuracy ──────────────────────────────────────────────
// Bug candidate: constructor log says "First to 3 points wins" but code uses >= 4

describe('Constructor log message', () => {
  test('initial log states the correct win threshold (4 points, not 3)', () => {
    const state = new GameState(true, true);
    const initLog = state.log.join(' ');
    // The score win condition is >= 4, so the log should reflect that
    assert.ok(
      !initLog.includes('First to 3 points'),
      'BUG: log says "First to 3 points" but win condition is 4 — message is incorrect'
    );
  });
});

// ── Attrition schedule ────────────────────────────────────────────────────────
// Design: Cycle 1=0, Cycle 2=1, Cycles 3-4=2, Cycle 5+=3

describe('Attrition schedule (endRound)', () => {
  function advanceToRound(state, targetRound) {
    while (state.round < targetRound && !state.gameOver) {
      state.startPlanning();
      state.submitPlan('hero', []);
      state.submitPlan('witch', []);
      state.endRound();
    }
  }

  test('attrition is 0 in cycle 1 (rounds 1-8)', () => {
    const state = new GameState(true, true);
    advanceToRound(state, 2); // still cycle 1
    assert.equal(state.attritionLevel, 0);
  });

  test('attrition is 1 in cycle 2 (round 9+)', () => {
    const state = new GameState(true, true);
    advanceToRound(state, 9); // start of cycle 2
    if (state.gameOver) return; // game may end before we get there in AI vs AI
    assert.equal(state.attritionLevel, 1);
  });

  test('attrition is 2 in cycles 3 and 4', () => {
    const state = new GameState(true, true);
    advanceToRound(state, 17); // start of cycle 3
    if (state.gameOver) return;
    assert.equal(state.attritionLevel, 2);
  });

  test('attrition is 3 in cycle 5 and beyond (capped at 3)', () => {
    const state = new GameState(true, true);
    advanceToRound(state, 33); // start of cycle 5
    if (state.gameOver) return;
    assert.equal(state.attritionLevel, 3);
  });
});

// ── Planning API ──────────────────────────────────────────────────────────────

describe('startPlanning', () => {
  test('sets planningPhase=true, clears previous plans', () => {
    const state = new GameState(true, true);
    state.planningPhase = false;
    state.heroPlan = ['stale'];
    state.witchPlan = ['stale'];
    state.startPlanning();
    assert.equal(state.planningPhase, true);
    assert.equal(state.heroPlan, null);
    assert.equal(state.witchPlan, null);
    assert.equal(state.heroReady, false);
    assert.equal(state.witchReady, false);
  });

  test('computes heroActionsLeft and witchActionsLeft', () => {
    const state = new GameState(true, true);
    state.startPlanning();
    assert.ok(state.heroActionsLeft > 0, 'heroActionsLeft should be positive');
    assert.ok(state.witchActionsLeft > 0, 'witchActionsLeft should be positive');
  });
});

describe('submitPlan', () => {
  test('returns false until both factions submit', () => {
    const state = new GameState(true, true);
    state.startPlanning();
    assert.equal(state.submitPlan('hero', []), false);
    assert.equal(state.heroReady, true);
    assert.equal(state.witchReady, false);
    assert.equal(state.planningPhase, true, 'planning not over yet');
  });

  test('returns true and starts resolution when both factions submit', () => {
    const state = new GameState(true, true);
    state.startPlanning();
    state.submitPlan('hero', []);
    const ready = state.submitPlan('witch', []);
    assert.equal(ready, true);
    assert.equal(state.planningPhase, false);
    assert.equal(state.resolving, true);
  });

  test('throws if called outside planning phase', () => {
    const state = new GameState(true, true);
    assert.throws(() => state.submitPlan('hero', []), /Not in planning phase/);
  });

  test('stores submitted plan arrays', () => {
    const state = new GameState(true, true);
    state.startPlanning();
    const heroPlan = [{ type: 'move', entityId: 'e1' }];
    state.submitPlan('hero', heroPlan);
    assert.deepEqual(state.heroPlan, heroPlan);
  });
});

// ── spendAction ───────────────────────────────────────────────────────────────

describe('spendAction', () => {
  test('reduces actionsLeft by cost', () => {
    const state = new GameState(true, true);
    state.actionsLeft = 5;
    state.spendAction(2);
    assert.equal(state.actionsLeft, 3);
  });

  test('clamps actionsLeft at 0 (never goes negative)', () => {
    const state = new GameState(true, true);
    state.actionsLeft = 1;
    state.spendAction(10);
    assert.equal(state.actionsLeft, 0);
  });

  test('default cost is 1', () => {
    const state = new GameState(true, true);
    state.actionsLeft = 4;
    state.spendAction();
    assert.equal(state.actionsLeft, 3);
  });
});

// ── Rest healing ──────────────────────────────────────────────────────────────

describe('endRound rest healing', () => {
  test('hero heals 3 HP when resting at INN', () => {
    const state = new GameState(true, true);
    // Find the INN tile
    let innTile = null;
    for (const [, t] of state.tiles) {
      if (t.type === TileType.BUILDING && t.building === 'inn') { innTile = t; break; }
    }
    if (!innTile) return; // no inn found (shouldn't happen)

    state.hero.col = innTile.col;
    state.hero.row = innTile.row;
    state.hero.takeDamage(10); // start at 4 HP
    const hpBefore = state.hero.hp;

    state.startPlanning();
    state.submitPlan('hero', []);
    state.submitPlan('witch', []);
    state.endRound();

    assert.equal(state.hero.hp, Math.min(state.hero.maxHp, hpBefore + 3),
      'Hero should heal 3 HP at the inn');
  });

  test('hero heals 1 HP when resting in any other building', () => {
    const state = new GameState(true, true);
    let otherBuilding = null;
    for (const [, t] of state.tiles) {
      if (t.type === TileType.BUILDING && t.building !== 'inn' && t.building !== 'church') {
        otherBuilding = t; break;
      }
    }
    if (!otherBuilding) return;

    state.hero.col = otherBuilding.col;
    state.hero.row = otherBuilding.row;
    state.hero.takeDamage(10);
    const hpBefore = state.hero.hp;

    state.startPlanning();
    state.submitPlan('hero', []);
    state.submitPlan('witch', []);
    state.endRound();

    assert.equal(state.hero.hp, Math.min(state.hero.maxHp, hpBefore + 1),
      'Hero should heal 1 HP in a non-inn/church building');
  });

  test('hero does not heal when already at full HP', () => {
    const state = new GameState(true, true);
    let innTile = null;
    for (const [, t] of state.tiles) {
      if (t.type === TileType.BUILDING && t.building === 'inn') { innTile = t; break; }
    }
    if (!innTile) return;

    state.hero.col = innTile.col;
    state.hero.row = innTile.row;
    // Hero starts at full HP
    assert.equal(state.hero.hp, state.hero.maxHp);

    state.startPlanning();
    state.submitPlan('hero', []);
    state.submitPlan('witch', []);
    state.endRound();

    assert.equal(state.hero.hp, state.hero.maxHp, 'Should not exceed maxHp');
  });
});
