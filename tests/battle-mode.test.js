// Tests for the Battle for Caleb's Hollow game mode
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase, Player, GameMode, WIN_REASON,
         computeActionsForPlayer, countHeldNodes } from '../src/game.js';
import { createHero, createWitch, createMinion, createZombie,
         createSurvivor, resetRoster, EntityType,
         HERO_PLAYER_COLORS, WITCH_PLAYER_COLORS } from '../src/entities.js';
import { hexKey, getNeighbors, hexDistance, MAP_COLS, MAP_ROWS } from '../src/hex.js';
import { TileType, BuildingType } from '../src/tiles.js';
import { generateBattleStarts } from '../src/map.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { buildObjectivesHtml } from '../src/ui-render.js';

function freshBattleState() {
  const state = new GameState(false, false, 'campaign', 5);
  state.gameMode = GameMode.BATTLE;
  state.battleConfig = { endsAt: Math.floor(Date.now() / 1000) + 86400, maxPlayersPerSide: 10 };
  return state;
}

// ── GameMode enum ─────────────────────────────────────────────────────────────

describe('GameMode enum', () => {
  test('exports STANDARD and BATTLE', () => {
    assert.equal(GameMode.STANDARD, 'standard');
    assert.equal(GameMode.BATTLE, 'battle');
  });
});

// ── Battle mode gameMode field ────────────────────────────────────────────────

describe('Battle mode game state', () => {
  test('default gameMode is standard', () => {
    const state = new GameState(true, true);
    assert.equal(state.gameMode, GameMode.STANDARD);
    assert.equal(state.battleConfig, null);
  });

  test('battle mode sets gameMode and battleConfig via mapDataOverride', () => {
    const state = freshBattleState();
    assert.equal(state.gameMode, GameMode.BATTLE);
    assert.ok(state.battleConfig);
    assert.ok(state.battleConfig.endsAt > 0);
    assert.equal(state.battleConfig.maxPlayersPerSide, 10);
  });
});

// ── Battle mode victory ───────────────────────────────────────────────────────

describe('Battle mode victory', () => {
  test('faction elimination does NOT trigger game over in battle mode', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    // Kill all witch leaders
    for (const e of state.entities) {
      if (e.type === EntityType.WITCH) e.hp = 0;
    }
    state.checkVictory();
    assert.equal(state.winner, null, 'should not end on faction elimination');
  });

  test('faction elimination DOES trigger game over in standard mode', () => {
    const state = new GameState(true, true);
    for (const e of state.entities) {
      if (e.type === EntityType.WITCH) e.hp = 0;
    }
    state.checkVictory();
    assert.equal(state.winner, 'hero');
    assert.equal(state.winReason, WIN_REASON.WITCH_SLAIN);
  });

  test('battle ends when time expires — hero wins with higher score', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    state.battleConfig = { endsAt: Math.floor(Date.now() / 1000) - 10 }; // already expired
    state.nodeScore = { hero: 5, witch: 3 };
    state.checkVictory();
    assert.equal(state.winner, 'hero');
    assert.equal(state.winReason, WIN_REASON.BATTLE_HERO);
  });

  test('battle ends when time expires — witch wins with higher score', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    state.battleConfig = { endsAt: Math.floor(Date.now() / 1000) - 10 };
    state.nodeScore = { hero: 2, witch: 7 };
    state.checkVictory();
    assert.equal(state.winner, 'witch');
    assert.equal(state.winReason, WIN_REASON.BATTLE_WITCH);
  });

  test('battle ends in draw when scores are tied and same living leaders', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    state.battleConfig = { endsAt: Math.floor(Date.now() / 1000) - 10 };
    state.nodeScore = { hero: 4, witch: 4 };
    state.checkVictory();
    assert.equal(state.winner, 'draw');
    assert.equal(state.winReason, WIN_REASON.BATTLE_DRAW);
  });

  test('battle does NOT end when time has not expired', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    state.battleConfig = { endsAt: Math.floor(Date.now() / 1000) + 86400 };
    state.nodeScore = { hero: 10, witch: 0 };
    state.checkVictory();
    assert.equal(state.winner, null, 'should not end before endsAt');
  });
});

// ── Battle mode scoring ───────────────────────────────────────────────────────

describe('Battle mode scoring', () => {
  test('_checkBattleNodeScoring increments score for controlling faction', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    // Place hero on a node
    const node = state.witchObjectives[0];
    state.hero.col = node.col;
    state.hero.row = node.row;
    const prevScore = { ...state.nodeScore };
    state._checkBattleNodeScoring();
    assert.ok(state.nodeScore.hero > prevScore.hero, 'hero score should increase');
  });

  test('node sweep does NOT trigger instant win in battle mode', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    // Place hero on every node
    for (const node of state.witchObjectives) {
      const hero = createHero(node.col, node.row, 'hero');
      state.entities.push(hero);
    }
    state._checkNodeObjectives(Phase.DAWN);
    assert.equal(state.winner, null, 'should not instant-win on node sweep');
  });

  test('score threshold does NOT trigger win in battle mode', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    state.nodeScore = { hero: 10, witch: 0 };
    // Place hero on a node
    const node = state.witchObjectives[0];
    state.hero.col = node.col;
    state.hero.row = node.row;
    state._checkNodeObjectives(Phase.DAWN);
    assert.equal(state.winner, null, 'should not trigger score threshold win');
    assert.ok(state.nodeScore.hero > 10, 'hero score should still increment');
  });
});

// ── Battle mode scatter (death handling) ──────────────────────────────────────

describe('Battle mode death/scatter', () => {
  test('standard mode: survivors scatter to current hex', () => {
    const state = new GameState(true, true);
    state.gameMode = GameMode.STANDARD;
    const surv = createSurvivor(state.hero.col, state.hero.row + 1, 'hero');
    state.entities.push(surv);
    state.scatterPlayerUnits('hero');
    const tile = state.tiles.get(hexKey(surv.col, surv.row));
    assert.ok(tile?.hiddenSurvivor, 'survivor should become hidden at current hex');
    assert.ok(!state.entities.some(e => e.id === surv.id), 'survivor entity should be removed');
  });

  test('battle mode: survivors scatter to nearest building', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    // Find a building tile
    let buildingTile = null;
    for (const [, t] of state.tiles) {
      if (t.building) { buildingTile = t; break; }
    }
    assert.ok(buildingTile, 'should have at least one building');

    // Place a survivor near the building
    const neighbors = getNeighbors(buildingTile.col, buildingTile.row);
    const passable = neighbors.find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER;
    });
    assert.ok(passable, 'should have a passable neighbor');
    const surv = createSurvivor(passable.col, passable.row, 'hero');
    state.entities.push(surv);
    state.scatterPlayerUnits('hero');

    // The building tile (or some building) should now have a hidden survivor
    let foundHiddenInBuilding = false;
    for (const [, t] of state.tiles) {
      if (t.building && t.hiddenSurvivor) { foundHiddenInBuilding = true; break; }
    }
    assert.ok(foundHiddenInBuilding, 'in battle mode, survivors should scatter to a building');
  });

  test('battle mode: zombies convert to hidden survivors at nearest building', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    // Find a building tile
    let buildingTile = null;
    for (const [, t] of state.tiles) {
      if (t.building) { buildingTile = t; break; }
    }
    // Place a zombie near the building
    const zombie = createZombie(buildingTile.col, buildingTile.row, 'witch');
    state.entities.push(zombie);
    state.scatterPlayerUnits('witch');

    assert.ok(!state.entities.some(e => e.id === zombie.id), 'zombie entity should be removed');
    // Check that a building has hiddenSurvivor
    let foundHidden = false;
    for (const [, t] of state.tiles) {
      if (t.building && t.hiddenSurvivor) { foundHidden = true; break; }
    }
    assert.ok(foundHidden, 'zombie should become hidden survivor at building in battle mode');
  });

  test('battle mode: minions just vanish', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    const minion = createMinion(state.witch.col, state.witch.row, 'witch');
    state.entities.push(minion);
    const entCountBefore = state.entities.length;
    state.scatterPlayerUnits('witch');
    assert.ok(!state.entities.some(e => e.id === minion.id), 'minion should be removed');
  });
});

// ── Battle mode action budget balancing ───────────────────────────────────────

describe('Battle mode action budget', () => {
  test('smaller faction gets bonus actions per missing player', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;

    // Add extra heroes (3 heroes total, 1 witch)
    state.addPlayer('h2', 'Hero2', 'hero', state.hero.col + 1, state.hero.row, false);
    state.addPlayer('h3', 'Hero3', 'hero', state.hero.col + 2, state.hero.row, false);

    state.startPlanning();

    // Witch is alone (1) vs 3 heroes → deficit of 2
    const witchBudget = state.playerActionsLeft.get('witch');
    const heroBudget  = state.playerActionsLeft.get('hero');
    // Witch should have a bonus of 2 over hero's base (same-unit base)
    assert.ok(witchBudget > heroBudget, 'witch should get bonus actions for being undermanned');
  });
});

// ── Respawn mechanics ─────────────────────────────────────────────────────────

describe('Battle mode respawn', () => {
  test('respawnRound is respected — player spawns when round matches', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    // Mark the hero as needing respawn at round 3
    state.players[0].respawnRound = 3;
    state.players[0].leaderId = null;
    // Remove the hero entity
    state.entities = state.entities.filter(e => e.type !== EntityType.HERO);
    state.hero = null;

    state.round = 3;
    state._spawnRespawningPlayers();

    // Player should now have a leader
    assert.ok(state.players[0].leaderId, 'player should have a new leaderId after respawn');
    const leader = state.entities.find(e => e.id === state.players[0].leaderId);
    assert.ok(leader, 'new leader entity should exist');
    assert.equal(leader.type, EntityType.HERO);
    assert.equal(leader.hp, leader.maxHp, 'respawned leader should have full HP');
  });

  test('respawn does not happen before respawnRound', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    state.players[0].respawnRound = 5;
    state.players[0].leaderId = null;
    state.entities = state.entities.filter(e => e.type !== EntityType.HERO);
    state.hero = null;

    state.round = 3;
    state._spawnRespawningPlayers();

    assert.equal(state.players[0].leaderId, null, 'should not respawn before respawnRound');
  });
});

// ── Map generation: battle starts ─────────────────────────────────────────────

describe('generateBattleStarts', () => {
  test('hero starts are in leftmost 3 columns', () => {
    const state = freshBattleState();
    const starts = generateBattleStarts(state.tiles, 'hero', 5);
    assert.ok(starts.length >= 1, 'should return at least one start');
    for (const s of starts) {
      assert.ok(s.col <= 2, `hero start col ${s.col} should be <= 2`);
    }
  });

  test('witch starts are in rightmost 3 columns', () => {
    const state = freshBattleState();
    const starts = generateBattleStarts(state.tiles, 'witch', 5);
    assert.ok(starts.length >= 1, 'should return at least one start');
    for (const s of starts) {
      assert.ok(s.col >= MAP_COLS - 3, `witch start col ${s.col} should be >= ${MAP_COLS - 3}`);
    }
  });

  test('returns requested count when possible', () => {
    const state = freshBattleState();
    const starts = generateBattleStarts(state.tiles, 'hero', 10);
    // On a 21×21 campaign map, 3 columns should have plenty of space
    assert.ok(starts.length >= 5, `should return at least 5 starts, got ${starts.length}`);
  });
});

// ── State serialization round-trip ────────────────────────────────────────────

describe('Battle mode state serialization', () => {
  test('gameMode and battleConfig survive serialize/deserialize', () => {
    const state = freshBattleState();
    state.gameMode = GameMode.BATTLE;
    state.battleConfig = { endsAt: 1700000000, maxPlayersPerSide: 10 };
    state.nodeScore = { hero: 7, witch: 3 };

    const snap = serializeState(state);
    assert.equal(snap.gameMode, 'battle');
    assert.deepEqual(snap.battleConfig, { endsAt: 1700000000, maxPlayersPerSide: 10 });

    const restored = deserializeState(snap);
    assert.equal(restored.gameMode, 'battle');
    assert.equal(restored.battleConfig.endsAt, 1700000000);
    assert.equal(restored.battleConfig.maxPlayersPerSide, 10);
    assert.equal(restored.nodeScore.hero, 7);
  });

  test('respawnRound on players survives serialization', () => {
    const state = freshBattleState();
    state.players[0].respawnRound = 5;
    const snap = serializeState(state);
    assert.equal(snap.players[0].respawnRound, 5);
  });
});

// ── Score UI ──────────────────────────────────────────────────────────────────

describe('Battle mode score UI', () => {
  test('buildObjectivesHtml renders numeric score in battle mode', () => {
    const objectives = [
      { col: 0, row: 0, label: 'Node 1', hexes: [{ col: 0, row: 0 }], color: '#22c55e' },
    ];
    const entities = [];
    const nodeScore = { hero: 12, witch: 8 };
    const { html } = buildObjectivesHtml(objectives, entities, nodeScore, 'battle');
    assert.ok(html.includes('score-num'), 'should use score-num class');
    assert.ok(html.includes('12'), 'should include hero score');
    assert.ok(html.includes('8'), 'should include witch score');
    assert.ok(!html.includes('score-pip'), 'should not include score pips');
  });

  test('buildObjectivesHtml renders pip score in standard mode', () => {
    const objectives = [
      { col: 0, row: 0, label: 'Node 1', hexes: [{ col: 0, row: 0 }], color: '#22c55e' },
    ];
    const entities = [];
    const nodeScore = { hero: 2, witch: 1 };
    const { html } = buildObjectivesHtml(objectives, entities, nodeScore, 'standard');
    assert.ok(html.includes('score-pip'), 'should use score-pip class');
    assert.ok(!html.includes('score-num'), 'should not include score-num');
  });
});

// ── Player colors ─────────────────────────────────────────────────────────────

describe('Player colors support 10v10', () => {
  test('HERO_PLAYER_COLORS has at least 10 entries', () => {
    assert.ok(HERO_PLAYER_COLORS.length >= 10, `got ${HERO_PLAYER_COLORS.length}`);
  });

  test('WITCH_PLAYER_COLORS has at least 10 entries', () => {
    assert.ok(WITCH_PLAYER_COLORS.length >= 10, `got ${WITCH_PLAYER_COLORS.length}`);
  });

  test('all colors are distinct within each palette', () => {
    const heroSet = new Set(HERO_PLAYER_COLORS);
    assert.equal(heroSet.size, HERO_PLAYER_COLORS.length, 'hero colors should be unique');
    const witchSet = new Set(WITCH_PLAYER_COLORS);
    assert.equal(witchSet.size, WITCH_PLAYER_COLORS.length, 'witch colors should be unique');
  });
});
