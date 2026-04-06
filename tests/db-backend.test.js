// Tests for the database backend abstraction layer.

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../server/db-backend.js';

describe('createBackend', () => {
  let backend;

  after(() => { if (backend) backend.close(); });

  test('creates an in-memory backend with all schema tables', () => {
    backend = createBackend(':memory:');

    const tables = backend
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(r => r.name);

    assert.ok(tables.includes('players'), 'players table should exist');
    assert.ok(tables.includes('game_saves'), 'game_saves table should exist');
    assert.ok(tables.includes('completed_games'), 'completed_games table should exist');
    assert.ok(tables.includes('game_replay_rounds'), 'game_replay_rounds table should exist');
  });

  test('prepare() returns working statements', () => {
    backend = createBackend(':memory:');

    backend.prepare(
      "INSERT INTO players (id, username, token) VALUES (?, ?, ?)"
    ).run('id-1', 'alice', 'tok-1');

    const row = backend.prepare('SELECT * FROM players WHERE id = ?').get('id-1');
    assert.equal(row.username, 'alice');
    assert.equal(row.token, 'tok-1');
    assert.equal(row.wins, 0);
  });

  test('exec() runs raw SQL', () => {
    backend = createBackend(':memory:');

    const before = backend.prepare('SELECT count(*) AS n FROM players').get().n;
    backend.exec("INSERT INTO players (id, username, token) VALUES ('e1', 'bob', 'tok-e1')");
    const after_ = backend.prepare('SELECT count(*) AS n FROM players').get().n;
    assert.equal(after_ - before, 1);
    const bob = backend.prepare("SELECT * FROM players WHERE id = 'e1'").get();
    assert.equal(bob.username, 'bob');
  });

  test('transaction() wraps operations atomically', () => {
    backend = createBackend(':memory:');

    const insertTwo = backend.transaction((a, b) => {
      backend.prepare("INSERT INTO players (id, username, token) VALUES (?, ?, ?)").run(a.id, a.name, a.token);
      backend.prepare("INSERT INTO players (id, username, token) VALUES (?, ?, ?)").run(b.id, b.name, b.token);
    });

    const before = backend.prepare('SELECT count(*) AS n FROM players').get().n;

    insertTwo(
      { id: 't1', name: 'txn-alice', token: 'tok-t1' },
      { id: 't2', name: 'txn-bob',   token: 'tok-t2' }
    );

    const count = backend.prepare('SELECT count(*) AS n FROM players').get().n;
    assert.equal(count - before, 2);
  });

  test('close() shuts down without error', () => {
    const b = createBackend(':memory:');
    assert.doesNotThrow(() => b.close());
  });
});
