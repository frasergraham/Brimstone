// Spec-based tests for src/game.js
// Covers: phase cycle, computeActions, node scoring, victory conditions, planning API.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GameState, Phase, Player, computeActions, countHeldNodes, WIN_REASON,
} from '../src/game.js';
import { EntityType, createMinion, resetRoster } from '../src/entities.js';
import { hexKey } from '../src/hex.js';
import { TileType, legacyTileType } from '../src/tiles.js';
import { getFaction } from '../src/factions.js';

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
// Witch: base 3 + 1 in NIGHT     + 1 per alive unit (cap +3)

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

  test('DAWN/DAY/DUSK: 3 base, no time bonus', () => {
    const ents = makeWitchEntities(0);
    assert.equal(computeActions(Player.WITCH, Phase.DAWN, ents), 3);
    assert.equal(computeActions(Player.WITCH, Phase.DAY,  ents), 3);
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, ents), 3);
  });

  test('NIGHT: 4 base (3 + 1 time bonus)', () => {
    const ents = makeWitchEntities(0);
    assert.equal(computeActions(Player.WITCH, Phase.NIGHT, ents), 4);
  });

  test('+1 action per alive witch unit', () => {
    // 1 minion → +1 → total 4
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(1)), 4);
    // 2 minions → +2 → total 5
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(2)), 5);
    // 3 minions → +3 → total 6
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(3)), 6);
  });

  test('witch unit bonus caps at +4', () => {
    // 3 minions → +3 → total 6 (under the cap)
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(3)), 6);
    // 5 minions → capped at +4 → total 7
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(5)), 7);
    // 20 minions → still capped at +4
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, makeWitchEntities(20)), 7);
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

  test('leader elimination is side-based: killing a Rogue leader ends the day side', () => {
    // Regression guard for the stub-faction work: win condition should
    // trigger on "zero leaders alive on the opposing side" regardless of
    // which specific faction the leader belonged to. Swapping the default
    // Paladin to a Rogue and then killing it must still hand victory to
    // the night side.
    const state = new GameState(true, true);
    state.swapLeaderToFaction('day', 'rogue');
    state.hero.hp = 0;
    state.checkVictory();
    assert.equal(state.winner,    'witch');
    assert.equal(state.winReason, WIN_REASON.HERO_SLAIN);
  });

  test('leader elimination is side-based: killing a Brute leader ends the night side', () => {
    const state = new GameState(true, true);
    state.swapLeaderToFaction('night', 'brute');
    state.witch.hp = 0;
    state.checkVictory();
    assert.equal(state.winner,    'hero');
    assert.equal(state.winReason, WIN_REASON.WITCH_SLAIN);
  });

  test('both alive → no winner', () => {
    const state = new GameState(true, true);
    state.checkVictory();
    assert.equal(state.winner, null);
    assert.equal(state.gameOver, false);
  });
});

// peekVictory() — a READ-ONLY look at whether the current (already-resolved)
// state has sealed a game-over, WITHOUT mutating state.winner/log. The offline
// resolution loop uses it the moment resolvePlans() returns so it can auto-run
// the round's replay to completion (instead of stranding a manual-stepping
// player on the replay HUD, never reaching the Victory/Defeat modal — the
// "stuck in replay after killing the golem" bug on Mission 1 / the prologue).
describe('peekVictory — read-only game-over detection (Mission 1 stuck-replay fix)', () => {
  test('does not mutate state and reports nothing when the game is live', () => {
    const state = new GameState(true, true);
    assert.equal(state.peekVictory(), null, 'no game-over while both leaders stand');
    assert.equal(state.winner, null, 'peek must not set winner');
    assert.equal(state.gameOver, false, 'peek must not flip gameOver');
  });

  test('detects an impending standard leader-death win without mutating', () => {
    const state = new GameState(true, true);
    state.witch.hp = 0; // resolution just slew the witch leader
    const peek = state.peekVictory();
    assert.ok(peek, 'peek sees the sealed win');
    assert.equal(peek.winner, 'hero');
    // Crucially read-only: the live victory state is untouched until finalizeRound.
    assert.equal(state.winner, null, 'peek did not write winner');
    assert.equal(state.gameOver, false, 'peek did not flip gameOver');
  });

  test('detects a mission-logic "all enemies dead" win shape (prologue golem, no witch leader)', () => {
    // The prologue has hasWitch:false (no witch leader) and wins via the
    // mission-logic graph when every witch-owned unit (3 zombies → golem) dies.
    // checkVictory() can't see that win (it's graph-driven), but peekVictory()
    // must still recognise the round as game-ending so the replay auto-completes
    // rather than gating on a manual NEXT the player may never press.
    const state = new GameState(true, true);
    // Mirror hasWitch:false — drop the witch leader.
    state.entities = state.entities.filter(e => !(e.owner === 'witch' && e.type === EntityType.WITCH));
    state.witch = null;
    // The mission-logic proxy only runs for graph missions — attach a marker
    // engine (the prologue has one; a plain game does not, and must NOT auto-win
    // just because a side happens to have no units mid-game).
    state.logicEngine = {};
    // One lone witch-owned enemy (the golem). With it still on the board, the
    // round hasn't sealed a win even though hadWitchUnits is true.
    const golem = createMinion(2, 2, 'witch', state);
    state.entities.push(golem);
    assert.equal(state.peekVictory({ hadWitchUnits: true }), null, 'enemy still alive → not over yet');

    // The resolver REMOVES dead entities, so a wipe shows up as zero witch units
    // present (not a corpse with alive=false). Drop the golem to mirror that.
    state.entities = state.entities.filter(e => e !== golem);
    // Without the hadWitchUnits hint it's indistinguishable from a hero-only
    // mission, so the proxy must stay silent.
    assert.equal(state.peekVictory(), null, 'no hint → no false auto-win on an empty witch side');
    // With the hint (the side fielded the golem this round) the wipe is a win.
    const peek = state.peekVictory({ hadWitchUnits: true });
    assert.ok(peek, 'witch side wiped after fielding a unit → the round sealed a win');
    assert.equal(peek.winner, 'hero');
    assert.equal(state.winner, null, 'peek stays read-only');
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

  test('holding all 3 nodes at dawn scores a point but is NOT an instant win', () => {
    const state = new GameState(true, true);
    state.nodeScore.hero = 0;
    holdNodes(state, 'hero', 3);
    state._checkNodeObjectives(Phase.DAWN);
    // Sweep win condition removed — holding all nodes just scores the majority point.
    assert.equal(state.nodeScore.hero, 1, 'should score 1 point for the majority');
    assert.equal(state.winner, null, 'should NOT instant-win by holding all nodes');
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

// ── disableScoring skips node objectives in endRound ─────────────────────────

describe('disableScoring in endRound', () => {
  test('endRound does not score nodes when disableScoring is true', () => {
    const state = new GameState(true, true);
    state.disableScoring = true;

    // Place hero on all 3 nodes to guarantee sweep
    const hero = state.hero;
    for (const obj of state.witchObjectives) {
      const e = createMinion(obj.col, obj.row, 'p1');
      e.owner = 'hero';
      state.entities.push(e);
    }

    // Advance to a dawn round
    while (state.phase !== Phase.DAWN && !state.gameOver) {
      state.startPlanning();
      state.submitPlan('hero', []);
      state.submitPlan('witch', []);
      state.endRound();
    }

    // Score should remain 0 and no winner from nodes
    assert.equal(state.nodeScore.hero, 0, 'hero score should remain 0');
    assert.equal(state.nodeScore.witch, 0, 'witch score should remain 0');
    assert.ok(!state.winner || state.winReason === undefined ||
      !state.winReason?.includes('Node'), 'should not win via nodes');
  });
});

// ── Initial log message accuracy ──────────────────────────────────────────────
describe('Constructor log message', () => {
  test('initial log states the correct win threshold (4 points)', () => {
    const state = new GameState(true, true);
    const initLog = state.log.join(' ');
    assert.ok(
      initLog.includes('First to 4 points'),
      'Log message should say "First to 4 points" to match the actual win condition'
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

  test('attrition is 1 in cycle 1 (rounds 1-8)', () => {
    const state = new GameState(true, true);
    advanceToRound(state, 2); // still cycle 1
    assert.equal(state.attritionLevel, 1);
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
      if (legacyTileType(t) === TileType.BUILDING && t.building === 'inn') { innTile = t; break; }
    }
    if (!innTile) return; // no inn found (shouldn't happen)

    state.hero.col = innTile.col;
    state.hero.row = innTile.row;
    state.hero.takeDamage(30); // damage enough that the scaled heal doesn't cap
    const hpBefore = state.hero.hp;

    state.startPlanning();
    state.submitPlan('hero', []);
    state.submitPlan('witch', []);
    state.endRound();

    assert.equal(state.hero.hp, Math.min(state.hero.maxHp, hpBefore + 21),
      'Hero should heal 3 × DAMAGE_SCALE HP at the inn');
  });

  test('hero heals 1 HP when resting in any other building', () => {
    const state = new GameState(true, true);
    let otherBuilding = null;
    for (const [, t] of state.tiles) {
      if (legacyTileType(t) === TileType.BUILDING && t.building !== 'inn' && t.building !== 'church') {
        otherBuilding = t; break;
      }
    }
    if (!otherBuilding) return;

    state.hero.col = otherBuilding.col;
    state.hero.row = otherBuilding.row;
    state.hero.takeDamage(30);
    const hpBefore = state.hero.hp;

    state.startPlanning();
    state.submitPlan('hero', []);
    state.submitPlan('witch', []);
    state.endRound();

    assert.equal(state.hero.hp, Math.min(state.hero.maxHp, hpBefore + 7),
      'Hero should heal 1 × DAMAGE_SCALE HP in a non-inn/church building');
  });

  test('hero does not heal when already at full HP', () => {
    const state = new GameState(true, true);
    let innTile = null;
    for (const [, t] of state.tiles) {
      if (legacyTileType(t) === TileType.BUILDING && t.building === 'inn') { innTile = t; break; }
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

// ── addLog owner tagging (Bug #10 — fog-of-war chronicle filtering) ─────────

describe('addLog — owner tagging', () => {
  test('plain string log entries are stored as-is', () => {
    const state = new GameState(true, true);
    state.addLog('Hello world');
    const last = state.log[state.log.length - 1];
    assert.equal(typeof last, 'string');
    assert.equal(last, 'Hello world');
  });

  test('log entries with owner are stored as {text, owner} objects', () => {
    const state = new GameState(true, true);
    state.addLog('Witch moved', 'witch');
    const last = state.log[state.log.length - 1];
    assert.equal(typeof last, 'object');
    assert.equal(last.text, 'Witch moved');
    assert.equal(last.owner, 'witch');
  });

  test('log entries with null owner are stored as plain strings', () => {
    const state = new GameState(true, true);
    state.addLog('Phase changed', null);
    const last = state.log[state.log.length - 1];
    assert.equal(typeof last, 'string');
    assert.equal(last, 'Phase changed');
  });

  test('log respects 100-entry cap', () => {
    const state = new GameState(true, true);
    state.log = [];
    for (let i = 0; i < 110; i++) {
      state.addLog(`msg ${i}`, i % 2 === 0 ? 'hero' : null);
    }
    assert.ok(state.log.length <= 100, 'Log should not exceed 100 entries');
  });
});

// ── submitPlayerPlan (multiplayer per-player path) ────────────────────────────

describe('submitPlayerPlan (multiplayer)', () => {
  function makeMultiplayerState() {
    const state = new GameState(true, false);
    // Simulate what _addSeat does in the lobby: patch synthetic IDs to real UUIDs.
    const heroId  = 'player-hero-uuid';
    const witchId = 'ai-witch-uuid';
    state.players[0].id = heroId;
    state.players[1].id = witchId;
    // Also patch ownerId on the leader entities so AI helpers work correctly.
    const heroEntity  = state.entities.find(e => e.type === EntityType.HERO);
    const witchEntity = state.entities.find(e => e.type === EntityType.WITCH);
    if (heroEntity)  heroEntity.ownerId  = heroId;
    if (witchEntity) witchEntity.ownerId = witchId;
    return { state, heroId, witchId };
  }

  test('allReady is false until both players submit', () => {
    const { state, heroId, witchId } = makeMultiplayerState();
    state.startPlanning();
    const r1 = state.submitPlayerPlan(witchId, []);
    assert.equal(r1, false, 'not ready after first submission');
    const r2 = state.submitPlayerPlan(heroId, []);
    assert.equal(r2, true, 'ready after both submissions');
  });

  test('playerReady is reset between rounds', () => {
    const { state, heroId, witchId } = makeMultiplayerState();

    // Round 1
    state.startPlanning();
    state.submitPlayerPlan(witchId, []);
    state.submitPlayerPlan(heroId, []);
    state.endRound();

    // Round 2: playerReady must be reset so both players can submit again
    state.startPlanning();
    assert.equal(state.playerReady.get(heroId),  false, 'hero ready flag reset for round 2');
    assert.equal(state.playerReady.get(witchId), false, 'witch ready flag reset for round 2');
    const r1 = state.submitPlayerPlan(witchId, []);
    assert.equal(r1, false, 'not ready after first submission in round 2');
    const r2 = state.submitPlayerPlan(heroId, []);
    assert.equal(r2, true, 'ready after both submissions in round 2');
  });

  test('double submission is silently ignored', () => {
    const { state, witchId } = makeMultiplayerState();
    state.startPlanning();
    state.submitPlayerPlan(witchId, [{ type: 'move', entityId: 'e1', toCol: 1, toRow: 1 }]);
    // Second submission is ignored — returns current allReady without changing the plan
    const result = state.submitPlayerPlan(witchId, []);
    assert.equal(state.playerPlans.get(witchId).length, 1, 'original plan preserved');
    assert.equal(typeof result, 'boolean');
  });

  test('submitting for unknown playerId throws', () => {
    const { state } = makeMultiplayerState();
    state.startPlanning();
    assert.throws(
      () => state.submitPlayerPlan('nonexistent-player', []),
      /unknown player/i,
    );
  });

  test('playerReady keys match state.players ids after startPlanning', () => {
    const { state, heroId, witchId } = makeMultiplayerState();
    state.startPlanning();
    assert.ok(state.playerReady.has(heroId),  'playerReady initialized with heroId');
    assert.ok(state.playerReady.has(witchId), 'playerReady initialized with witchId');
    assert.equal(state.playerReady.size, 2,   'exactly 2 entries in playerReady');
  });
});

// ── countHeldNodes ──────────────────────────────────────────────────────────

describe('countHeldNodes', () => {
  function makeNodeFixture() {
    const objectives = [
      { col: 5, row: 5, hexes: [{ col: 5, row: 5 }, { col: 5, row: 6 }, { col: 6, row: 5 }] },
      { col: 10, row: 10, hexes: [{ col: 10, row: 10 }, { col: 10, row: 11 }, { col: 11, row: 10 }] },
      { col: 15, row: 15, hexes: [{ col: 15, row: 15 }, { col: 15, row: 16 }, { col: 16, row: 15 }] },
    ];
    return objectives;
  }

  test('returns 0 when no entities on nodes', () => {
    const objectives = makeNodeFixture();
    const entities = [{ alive: true, owner: 'hero', col: 0, row: 0 }];
    assert.equal(countHeldNodes('hero', objectives, entities), 0);
    assert.equal(countHeldNodes('witch', objectives, entities), 0);
  });

  test('counts nodes controlled by hero', () => {
    const objectives = makeNodeFixture();
    const entities = [
      { alive: true, owner: 'hero', col: 5, row: 5 },
      { alive: true, owner: 'hero', col: 10, row: 10 },
    ];
    assert.equal(countHeldNodes('hero', objectives, entities), 2);
    assert.equal(countHeldNodes('witch', objectives, entities), 0);
  });

  test('counts nodes controlled by witch', () => {
    const objectives = makeNodeFixture();
    const entities = [
      { alive: true, owner: 'witch', col: 15, row: 15 },
    ];
    assert.equal(countHeldNodes('witch', objectives, entities), 1);
    assert.equal(countHeldNodes('hero', objectives, entities), 0);
  });

  test('contested nodes do not count for either faction', () => {
    const objectives = makeNodeFixture();
    // Both factions occupy 1 hex each on the same node → contested
    const entities = [
      { alive: true, owner: 'hero', col: 5, row: 5 },
      { alive: true, owner: 'witch', col: 5, row: 6 },
    ];
    assert.equal(countHeldNodes('hero', objectives, entities), 0);
    assert.equal(countHeldNodes('witch', objectives, entities), 0);
  });

  test('handles empty objectives array', () => {
    assert.equal(countHeldNodes('hero', [], []), 0);
  });
});

// ── computeActions with nodeBonus ────────────────────────────────────────────

describe('computeActions — nodeBonus', () => {
  test('default nodeBonus is 0, existing results unchanged', () => {
    const ents = [{ alive: true, owner: 'hero', type: EntityType.HERO }];
    assert.equal(computeActions(Player.HERO, Phase.DUSK, ents), 3);
    assert.equal(computeActions(Player.HERO, Phase.DUSK, ents, 0), 3);
  });

  test('hero gains +1 per nodeBonus', () => {
    const ents = [{ alive: true, owner: 'hero', type: EntityType.HERO }];
    assert.equal(computeActions(Player.HERO, Phase.DUSK, ents, 1), 4);
    assert.equal(computeActions(Player.HERO, Phase.DUSK, ents, 2), 5);
    assert.equal(computeActions(Player.HERO, Phase.DUSK, ents, 3), 6);
  });

  test('witch gains +1 per nodeBonus', () => {
    const ents = [{ alive: true, owner: 'witch', type: EntityType.WITCH }];
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, ents, 1), 4);
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, ents, 2), 5);
    assert.equal(computeActions(Player.WITCH, Phase.DUSK, ents, 3), 6);
  });

  test('nodeBonus stacks with time bonus and unit bonus', () => {
    const ents = [
      { alive: true, owner: 'hero', type: EntityType.HERO },
      { alive: true, owner: 'hero', type: EntityType.SURVIVOR },
    ];
    // DAWN: 3 base + 1 time + 1 survivor + 2 nodes = 7
    assert.equal(computeActions(Player.HERO, Phase.DAWN, ents, 2), 7);
  });
});

// ── computeActions hard caps ─────────────────────────────────────────────────

describe('computeActions — hard caps', () => {
  test('hero cap is 8', () => {
    assert.equal(getFaction('hero').actionCap, 8);
  });

  test('witch cap is 8', () => {
    assert.equal(getFaction('witch').actionCap, 8);
  });

  test('hero capped at 8 even with max survivors + time + nodes', () => {
    const ents = [
      { alive: true, owner: 'hero', type: EntityType.HERO },
      ...Array.from({ length: 5 }, () => ({ alive: true, owner: 'hero', type: EntityType.SURVIVOR })),
    ];
    // DAWN: 3 base + 1 time + 5 survivors + 3 nodes = 12 → capped at 8
    assert.equal(computeActions(Player.HERO, Phase.DAWN, ents, 3), 8);
    // DAY: same
    assert.equal(computeActions(Player.HERO, Phase.DAY, ents, 3), 8);
  });

  test('hero nodeBonus alone can hit cap', () => {
    const ents = [{ alive: true, owner: 'hero', type: EntityType.HERO }];
    // DAWN: 3 base + 1 time + 0 survivors + 3 nodes = 7 (under cap)
    assert.equal(computeActions(Player.HERO, Phase.DAWN, ents, 3), 7);
    // But with 5 survivors: 3 + 1 + 5 + 3 = 12 → capped at 8
    const ents5 = [
      ...ents,
      ...Array.from({ length: 5 }, () => ({ alive: true, owner: 'hero', type: EntityType.SURVIVOR })),
    ];
    assert.equal(computeActions(Player.HERO, Phase.DAWN, ents5, 3), 8);
  });

  test('witch capped at 8 even with max units + time + nodes', () => {
    const ents = [
      { alive: true, owner: 'witch', type: EntityType.WITCH },
      ...Array.from({ length: 3 }, () => ({ alive: true, owner: 'witch', type: EntityType.MINION })),
    ];
    // NIGHT: 3 base + 1 time + 3 units + 3 nodes = 10 → capped at 8
    assert.equal(computeActions(Player.WITCH, Phase.NIGHT, ents, 3), 8);
  });

  test('witch with high nodeBonus stays at cap', () => {
    const ents = [
      { alive: true, owner: 'witch', type: EntityType.WITCH },
      ...Array.from({ length: 20 }, () => ({ alive: true, owner: 'witch', type: EntityType.MINION })),
    ];
    // NIGHT: 3 + 1 + 3 (capped units) + 3 nodes = 10 → capped at 8
    assert.equal(computeActions(Player.WITCH, Phase.NIGHT, ents, 3), 8);
  });
});

// ── startPlanning with node bonus ────────────────────────────────────────────

describe('startPlanning — power node bonus', () => {
  test('hero on a power node gets +1 action', () => {
    const state = new GameState(true, true);
    // Place hero on the first power node's center hex
    const node = state.witchObjectives[0];
    state.hero.col = node.col;
    state.hero.row = node.row;
    // Move witch away from all nodes
    state.witch.col = 0;
    state.witch.row = 0;

    state.startPlanning();

    // Hero should have base budget + 1 node bonus
    const baseHero = computeActions(Player.HERO, state.phase, state.entities, 0);
    assert.equal(state.heroActionsLeft, baseHero + 1);
  });

  test('witch on two power nodes gets +2 actions', () => {
    const state = new GameState(true, true);
    // Move hero away from all nodes
    state.hero.col = 0;
    state.hero.row = 0;
    // Place witch on first node
    const node0 = state.witchObjectives[0];
    state.witch.col = node0.col;
    state.witch.row = node0.row;
    // Place a minion on second node
    const node1 = state.witchObjectives[1];
    const minion = createMinion(node1.col, node1.row);
    minion.owner = 'witch';
    state.entities.push(minion);

    state.startPlanning();

    const baseWitch = computeActions(Player.WITCH, state.phase, state.entities, 0);
    assert.equal(state.witchActionsLeft, baseWitch + 2);
  });

  test('no bonus when no nodes held', () => {
    const state = new GameState(true, true);
    // Move both leaders away from all nodes
    state.hero.col = 0;
    state.hero.row = 0;
    state.witch.col = 1;
    state.witch.row = 0;

    state.startPlanning();

    const baseHero  = computeActions(Player.HERO,  state.phase, state.entities, 0);
    const baseWitch = computeActions(Player.WITCH, state.phase, state.entities, 0);
    assert.equal(state.heroActionsLeft, baseHero);
    assert.equal(state.witchActionsLeft, baseWitch);
  });
});

// ── Node spawn balance: witch no longer spawns free minions ──────────────────

describe('Power node free spawn (endRound)', () => {
  test('witch on a node during NIGHT does NOT spawn a free minion', () => {
    const state = new GameState(true, true);
    state.phase = Phase.NIGHT;

    const node = state.witchObjectives[0];
    state.witch.col = node.hexes[0].col;
    state.witch.row = node.hexes[0].row;

    const minionsBefore = state.entities.filter(
      e => e.alive && e.type === EntityType.MINION
    ).length;

    state.endRound();

    const minionsAfter = state.entities.filter(
      e => e.alive && e.type === EntityType.MINION
    ).length;

    assert.equal(minionsAfter, minionsBefore,
      'Witch on a node should no longer spawn free minions');
  });

  test('hero on a node during NIGHT spawns a free survivor when the 33% roll succeeds', () => {
    const runWithRoll = (roll) => {
      resetRoster();
      const state = new GameState(true, true);
      state.phase = Phase.NIGHT;

      const node = state.witchObjectives[0];
      state.hero.col = node.hexes[0].col;
      state.hero.row = node.hexes[0].row;
      // Move witch away from node so it doesn't interfere
      state.witch.col = 0;
      state.witch.row = 0;

      const survivorsBefore = state.entities.filter(
        e => e.alive && e.type === EntityType.SURVIVOR
      ).length;

      const orig = Math.random;
      Math.random = () => roll;
      try {
        state.endRound();
      } finally {
        Math.random = orig;
      }

      const survivorsAfter = state.entities.filter(
        e => e.alive && e.type === EntityType.SURVIVOR
      ).length;

      return survivorsAfter - survivorsBefore;
    };

    assert.ok(runWithRoll(0.1) > 0,
      'Roll below 0.33 should spawn a free survivor at the node');
    assert.equal(runWithRoll(0.5), 0,
      'Roll at/above 0.33 should not spawn a survivor');
  });
});

// ── Side-keyed accessors ─────────────────────────────────────────────────────

describe('GameState side accessors', () => {
  test('inventoryForSide returns the side\'s shared inventory', () => {
    const state = new GameState(true, true);
    // Day side's inventory is what the Hero faction reads via getInventory().
    assert.equal(state.inventoryForSide('day'),   state.inventory.hero);
    assert.equal(state.inventoryForSide('night'), state.inventory.witch);
  });

  test('actionsLeftForSide reflects the legacy 2-player budgets', () => {
    const state = new GameState(true, true);
    state.heroActionsLeft  = 7;
    state.witchActionsLeft = 4;
    assert.equal(state.actionsLeftForSide('day'),   7);
    assert.equal(state.actionsLeftForSide('night'), 4);
  });

  test('killsForSide reflects the per-side kill counters', () => {
    const state = new GameState(true, true);
    state.heroKills  = 3;
    state.witchKills = 5;
    assert.equal(state.killsForSide('day'),   3);
    assert.equal(state.killsForSide('night'), 5);
  });

  test('summonsForSide is 0 for day, witchSummonCount for night', () => {
    const state = new GameState(true, true);
    state.witchSummonCount = 8;
    assert.equal(state.summonsForSide('day'),   0);
    assert.equal(state.summonsForSide('night'), 8);
  });

  test('nodeScoreForSide reflects the per-side score counters', () => {
    const state = new GameState(true, true);
    state.nodeScore.hero  = 2;
    state.nodeScore.witch = 1;
    assert.equal(state.nodeScoreForSide('day'),   2);
    assert.equal(state.nodeScoreForSide('night'), 1);
  });

  test('throws on unknown side id', () => {
    const state = new GameState(true, true);
    assert.throws(() => state.inventoryForSide('twilight'), /Unknown side/);
    assert.throws(() => state.nodeScoreForSide('twilight'), /Unknown side/);
  });
});

// ── swapLeaderToFaction (stub-faction support) ───────────────────────────────

describe('swapLeaderToFaction', () => {
  test('swapping the day-side leader to rogue applies rogue stats in place', () => {
    const state = new GameState(true, true);
    const heroId      = state.hero.id;
    const heroOwnerId = state.hero.ownerId;
    const heroCol     = state.hero.col;
    const heroRow     = state.hero.row;

    assert.ok(state.hero.hasItem('horn'), 'precondition: Paladin holds a horn before the swap');
    state.swapLeaderToFaction('day', 'rogue');

    // Same entity, mutated in place — id/owner/position preserved.
    assert.equal(state.hero.id,      heroId);
    assert.equal(state.hero.ownerId, heroOwnerId);
    assert.equal(state.hero.col,     heroCol);
    assert.equal(state.hero.row,     heroRow);
    // Stub stats applied.
    assert.equal(state.hero.type,      'rogue');
    assert.equal(state.hero.maxHp,     70);
    assert.equal(state.hero.attack,    3);
    assert.equal(state.hero.defense,   1);
    assert.equal(state.hero.agility,   8);
    assert.equal(state.hero.factionId, 'rogue');
    // Full-heal on swap (game just started).
    assert.equal(state.hero.hp,        state.hero.maxHp);
    // Horn-training is stripped on a paladin → rogue swap, so the horn key
    // item goes with it (the Sound Horn gate reads the item).
    assert.ok(!state.hero.hasItem('horn'), 'rogue swap must take back the horn');
  });

  test('swapping to side default is a no-op', () => {
    const state = new GameState(true, true);
    const beforeType  = state.hero.type;
    const beforeMaxHp = state.hero.maxHp;
    state.swapLeaderToFaction('day', 'hero');
    assert.equal(state.hero.type,  beforeType);
    assert.equal(state.hero.maxHp, beforeMaxHp);
  });

  test('swapping to a faction not on the side is a no-op', () => {
    const state = new GameState(true, true);
    const before = state.hero.maxHp;
    state.swapLeaderToFaction('day', 'witch'); // wrong side
    assert.equal(state.hero.maxHp, before);
  });

  test('swapping the night-side leader to brute applies brute stats', () => {
    const state = new GameState(true, true);
    state.swapLeaderToFaction('night', 'brute');
    assert.equal(state.witch.type,    'brute');
    assert.equal(state.witch.maxHp,   100);
    assert.equal(state.witch.attack,   4);
    assert.equal(state.witch.defense,  3);
    assert.equal(state.witch.agility,  3);
  });
});
