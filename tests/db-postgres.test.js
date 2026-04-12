// Integration tests for the Postgres backend.
//
// Requires a running Postgres reachable via PG_TEST_URL
// (e.g. `postgresql://brimstone_test:brimstone_test@localhost:5432/brimstone_test`).
// When PG_TEST_URL is absent, the suite is skipped so the default `npm test`
// run on a dev machine without Postgres stays green.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PG_TEST_URL = process.env.PG_TEST_URL;
const shouldRun   = !!PG_TEST_URL;

describe('Postgres db API', { skip: !shouldRun && 'PG_TEST_URL not set' }, () => {
  let db;
  const PREFIX = `pg-api-test-${process.pid}-${Date.now()}`;

  before(async () => {
    // Force the db singleton to use Postgres for this test file.
    process.env.DB_BACKEND  = 'postgres';
    process.env.DATABASE_URL = PG_TEST_URL;
    // Dynamic import so the default-sqlite singleton in other tests is not affected.
    db = (await import(`../server/db/postgres/index.js?t=${Date.now()}`)).default;

    // Clean any leftover rows from prior runs
    db.gameStats.truncate();
    db.campaignStats.truncate();
  });

  after(() => {
    if (!db) return;
    try {
      // Best-effort cleanup so the test DB stays tidy across runs.
      db.close();
    } catch {}
  });

  test('exposes the same namespaces as SQLite', () => {
    for (const ns of [
      'players', 'identities', 'magicTokens', 'saves', 'saveReplayRounds',
      'completedGames', 'plans', 'async', 'gameStats', 'campaignStats',
      'campaignSaves', 'deviceTokens', 'notifications', 'admin',
    ]) {
      assert.ok(db[ns], `missing namespace: ${ns}`);
    }
    assert.equal(typeof db.transaction, 'function');
  });

  test('players.insert + players.getById round-trips with numeric created_at', () => {
    const id = `${PREFIX}-p1`;
    db.players.insert({ id, username: `${PREFIX}-alice`, discriminator: 1234, token: `${PREFIX}-tok-1` });
    const row = db.players.getById(id);
    assert.equal(row.username, `${PREFIX}-alice`);
    assert.equal(row.wins, 0);
    assert.equal(row.is_admin, 0);
    assert.equal(typeof row.created_at, 'number');
  });

  test('players.getByToken returns the same row', () => {
    const id = `${PREFIX}-p2`;
    db.players.insert({ id, username: `${PREFIX}-bob`, discriminator: 5678, token: `${PREFIX}-tok-2` });
    const row = db.players.getByToken(`${PREFIX}-tok-2`);
    assert.equal(row.id, id);
  });

  test('transaction() wraps operations atomically', () => {
    const runBoth = db.transaction(() => {
      db.players.insert({ id: `${PREFIX}-t1`, username: `${PREFIX}-txn1`, discriminator: 1111, token: `${PREFIX}-txn-tok-1` });
      db.players.insert({ id: `${PREFIX}-t2`, username: `${PREFIX}-txn2`, discriminator: 2222, token: `${PREFIX}-txn-tok-2` });
    });
    runBoth();
    assert.ok(db.players.getById(`${PREFIX}-t1`));
    assert.ok(db.players.getById(`${PREFIX}-t2`));
  });

  test('deviceTokens.upsert is idempotent', () => {
    const id = `${PREFIX}-dt1`;
    db.players.insert({ id, username: `${PREFIX}-dtuser`, discriminator: 9999, token: `${PREFIX}-dt-tok` });
    db.deviceTokens.upsert({ playerId: id, token: 'device-a', platform: 'ios' });
    db.deviceTokens.upsert({ playerId: id, token: 'device-a', platform: 'ios' });
    const tokens = db.deviceTokens.listForPlayer(id);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token, 'device-a');
  });

  test('saves.upsert + saves.get round-trips JSON state', () => {
    const roomId = `${PREFIX}-room-1`;
    db.saves.upsert({
      roomId,
      heroPlayerId: null,
      witchPlayerId: null,
      heroName: 'Hero',
      witchName: 'Witch',
      round: 3,
      phase: 'dawn',
      gameVersion: '1.3.32',
      saveVersion: 7,
      stateJson: JSON.stringify({ round: 3, phase: 'dawn', version: '1.3.32', entities: [] }),
      turnDeadline: null,
      turnIntervalMs: 90000,
      consecutiveTimeouts: '{}',
      configJson: '{}',
      playersJson: '[]',
      isPrivate: 0,
      code: null,
      status: 'playing',
    });
    const row = db.saves.get(roomId);
    assert.equal(row.room_id, roomId);
    assert.equal(row.round, 3);
    assert.deepEqual(row.state.entities, []);
    db.saves.delete(roomId);
    assert.equal(db.saves.get(roomId), null);
  });

  test('plans.insertMissing + listForRound + clearRound', () => {
    const roomId = `${PREFIX}-plan-room`;
    db.plans.insertMissing(roomId, ['p-a', 'p-b'], 1);
    const rows = db.plans.listForRound(roomId, 1);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.player_id).sort(), ['p-a', 'p-b']);
    db.plans.clearRound(roomId, 1);
    assert.equal(db.plans.listForRound(roomId, 1).length, 0);
  });

  test('gameStats.insert + aggregates', () => {
    const id = `${PREFIX}-stat-1`;
    db.gameStats.insert({
      id,
      mode: 'hvai',
      map_size: 'standard',
      winner: 'hero',
      win_reason: 'kill',
      rounds: 25,
      final_phase: 'day',
      hero_score: 3,
      witch_score: 2,
      hero_kills: 4,
      witch_kills: 0,
      hero_survivors: 2,
      witch_summons: 5,
      hero_personality: 'berserker',
      witch_personality: 'hoarder',
      hero_player_id: null,
      witch_player_id: null,
      game_version: '1.3.32',
      fog_of_war: 0,
      duration_ms: 12345,
    });
    const total = db.gameStats.countTotal();
    assert.ok(total >= 1);
    const byWinner = db.gameStats.byWinner();
    assert.ok(byWinner.some(r => r.winner === 'hero' && r.count >= 1));
    const rs = db.gameStats.roundStats();
    assert.equal(typeof rs.min_rounds, 'number');
  });

  test('completedGames.create + listRounds + pruneExpired', () => {
    const gameId = `${PREFIX}-game-done`;
    db.completedGames.create({
      gameId,
      roomId: 'room-done',
      heroPlayerId: null,
      witchPlayerId: null,
      heroName: 'H',
      witchName: 'W',
      winner: 'hero',
      winReason: 'nodes',
      totalRounds: 10,
      gameVersion: '1.3.32',
      mode: 'hvai',
      playersJson: '[]',
      ttlSeconds: -10,   // already expired 10s ago
    }, [
      { roundNum: 1, preStateJson: '{}', stepsJson: '[]' },
      { roundNum: 2, preStateJson: '{}', stepsJson: '[]' },
    ]);
    const rounds = db.completedGames.listRounds(gameId);
    assert.equal(rounds.length, 2);
    const pruned = db.completedGames.pruneExpired();
    assert.ok(pruned >= 1);
    assert.equal(db.completedGames.get(gameId), null);
  });
});
