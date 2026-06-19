// Tests for the Battle-for-Caleb's-Hollow map thumbnail + game-detail wiring.
//
// The Battle is an online game, so its ledger card reuses the SAME thumbnail +
// detail path every online game uses (see src/menu/ledger.js `_battleThumb` /
// `_othersLanding`, and src/main.js `_gameDetail`):
//
//   • A live map thumbnail comes from the round-end snapshot saved under the
//     battle's room id (== `b.roomId`), captured locally when this player
//     resolves a round (main.js `_captureRoundThumbnail(mp.roomId)`).
//   • The detail modal's stats (round / phase / score / kills / participants /
//     nodes) come from the round-end stats snapshot stored beside the thumbnail
//     under the same room id (`loadStats(room_id)`).
//   • A battle-INVITE (never joined) has no room_id ⇒ no thumbnail, no detail —
//     the card shows a placeholder glyph and clicking it opens the Battle view.
//
// These resolvers (`loadThumb` / `loadStats`, keyed by room id) are DOM-free, so
// the battle's thumb + detail contract is unit-testable without the renderer or
// the full app — mirroring how online feed/resume rows resolve their thumbnails.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── localStorage mock for Node (thumbnails.js reads/writes it) ────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

import { saveThumb, loadThumb, saveStats, loadStats } from '../src/menu/thumbnails.js';

// The resolver `_battleThumb` in ledger.js is exactly this — a battle's thumb is
// its room-id-keyed live snapshot, or null (placeholder) when none/no room_id.
// Reproduced here so the battle's resolution contract is covered without pulling
// in the DOM-bound ledger module.
function battleThumb(battle) {
  return battle?.room_id ? loadThumb(battle.room_id) : null;
}

const BATTLE_ROOM = 'battle-room-7';
const THUMB_URL   = 'data:image/jpeg;base64,BATTLEBOARD';
// The shape main.js `_extractStats` captures and the detail overlay consumes.
const BATTLE_STATS = {
  round: 9,
  phase: 'NIGHT',
  mapSize: 'battle',
  score: { hero: 1, witch: 3, threshold: 4 },
  kills: { hero: 5, witch: 8 },
  participants: {
    hero:  [{ label: 'Goodwife Hale', sub: 'Survivor · 3/4 HP', alive: true }],
    witch: [{ label: 'Zombie ×6', sub: '4/6 standing', alive: true }],
  },
  nodes: [{ controller: 'witch', color: '#9b59b6' }],
};

describe('battle map thumbnail — reuses the online round-id thumbnail path', () => {
  beforeEach(() => localStorage.clear());

  test('a joined battle resolves its live saved thumbnail by room_id', () => {
    saveThumb(BATTLE_ROOM, THUMB_URL);
    const battle = { kind: 'battle', room_id: BATTLE_ROOM, round: 9 };
    assert.equal(battleThumb(battle), THUMB_URL,
      'the battle card shows the round-end snapshot saved under its room id');
  });

  test('a joined battle with no snapshot yet → null (card shows a placeholder)', () => {
    const battle = { kind: 'battle', room_id: BATTLE_ROOM, round: 1 };
    assert.equal(battleThumb(battle), null,
      'before any round resolves there is no thumb ⇒ placeholder glyph');
  });

  test('a battle INVITE (never joined, no room_id) has no thumbnail', () => {
    const invite = { kind: 'battle-invite', room_id: null };
    assert.equal(battleThumb(invite), null,
      'an unjoined battle has no captured board to show');
  });

  test('the battle thumbnail is room-id specific (not bled from another game)', () => {
    saveThumb('some-other-game', 'data:image/jpeg;base64,OTHER');
    const battle = { kind: 'battle', room_id: BATTLE_ROOM, round: 4 };
    assert.equal(battleThumb(battle), null,
      'a different game\'s thumb must not show on the battle card');
  });
});

describe('battle game-detail — reuses the online round-end stats snapshot', () => {
  beforeEach(() => localStorage.clear());

  // _gameDetail(row) in main.js reads loadStats(row.room_id) || a local-save
  // parse; online games (battle included) only have the stats snapshot, so this
  // is the path that lights up the battle's detail modal.
  function gameDetailForBattle(battle) {
    const stats = loadStats(battle.room_id);
    const thumb = loadThumb(battle.room_id);
    const PHASE_NAMES = { DAWN: 'Dawn', DAY: 'Day', DUSK: 'Dusk', NIGHT: 'Night' };
    const phase = stats?.phase ?? battle.phase ?? null;
    const base = {
      title: battle.title || 'Game',
      round: stats?.round ?? battle.round ?? null,
      phase,
      phaseLabel: PHASE_NAMES[phase] ?? phase,
      mapSize: stats?.mapSize ?? battle.map_size ?? null,
      thumb,
    };
    if (!stats) {
      return { ...base, score: null, kills: null, participants: null,
               players: battle.players_count ?? battle.players_total ?? null };
    }
    return { ...base, score: stats.score, kills: stats.kills,
             participants: stats.participants, nodes: stats.nodes };
  }

  test('opens with the battle round/score/kills/participants from the snapshot', () => {
    saveThumb(BATTLE_ROOM, THUMB_URL);
    saveStats(BATTLE_ROOM, BATTLE_STATS);
    const battle = {
      kind: 'battle', room_id: BATTLE_ROOM, round: 9,
      title: '⚔✦ Battle for Caleb\'s Hollow', players_count: 7,
    };
    const d = gameDetailForBattle(battle);
    assert.equal(d.thumb, THUMB_URL, 'detail shows the same live board');
    assert.equal(d.round, 9);
    assert.equal(d.phaseLabel, 'Night');
    assert.equal(d.mapSize, 'battle');
    assert.deepEqual(d.score, { hero: 1, witch: 3, threshold: 4 });
    assert.deepEqual(d.kills, { hero: 5, witch: 8 });
    assert.equal(d.participants.hero[0].label, 'Goodwife Hale');
    assert.equal(d.participants.witch[0].label, 'Zombie ×6');
    assert.equal(d.nodes[0].controller, 'witch');
  });

  test('with no snapshot yet, detail still carries the battle row basics', () => {
    const battle = {
      kind: 'battle', room_id: BATTLE_ROOM, round: 2,
      title: '⚔✦ Battle for Caleb\'s Hollow', players_count: 4,
    };
    const d = gameDetailForBattle(battle);
    assert.equal(d.round, 2, 'falls back to the row\'s round');
    assert.equal(d.players, 4, 'player count comes from the battle row');
    assert.equal(d.score, null);
    assert.equal(d.thumb, null);
  });
});
