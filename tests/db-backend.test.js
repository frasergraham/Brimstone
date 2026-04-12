// Tests for the high-level SQLite db API. The shared data/brimstone.db file
// is reused across tests — we scope inserts with unique ids and clean them up
// after.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';

const PREFIX = `db-api-test-${process.pid}-${Date.now()}`;

function cleanup() {
  db.prepare(`DELETE FROM device_tokens WHERE player_id LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM player_identities WHERE player_id LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM game_saves WHERE room_id LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM save_replay_rounds WHERE room_id LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM players WHERE id LIKE '${PREFIX}%'`).run();
}

after(cleanup);

describe('SQLite db API', () => {
  test('exposes the expected domain namespaces', () => {
    for (const ns of [
      'players', 'identities', 'magicTokens', 'saves', 'saveReplayRounds',
      'completedGames', 'plans', 'async', 'gameStats', 'campaignStats',
      'campaignSaves', 'deviceTokens', 'notifications', 'admin',
    ]) {
      assert.ok(db[ns], `missing namespace: ${ns}`);
    }
    assert.equal(typeof db.transaction, 'function');
  });

  test('players.insert + players.getById round-trips', () => {
    const id = `${PREFIX}-p1`;
    db.players.insert({ id, username: `${PREFIX}-alice`, discriminator: 1234, token: `${PREFIX}-tok-1` });
    const row = db.players.getById(id);
    assert.equal(row.username, `${PREFIX}-alice`);
    assert.equal(row.wins, 0);
    assert.equal(row.is_admin, 0);
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
});
