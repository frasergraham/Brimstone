// Shared pg-native client for all Postgres domain modules.
// Uses libpq's blocking API (querySync) to preserve the synchronous contract
// that the rest of the server relies on. All DML that needs a row count
// automatically receives a `RETURNING 1` suffix so consumers can still read
// `.changes` from the helper returned by runMutation().

import { createRequire } from 'module';
import { getSchemaSql } from '../schema.js';

// pg-native is required rather than ESM-imported so it can live in
// optionalDependencies without breaking SQLite-only installs.
const require_ = createRequire(import.meta.url);

let client = null;

function _configureTypes() {
  // pg-native uses the same pg-types parsers as node-postgres. By default
  // BIGINT (OID 20) comes back as a string because PG BIGINT can exceed
  // JS Number.MAX_SAFE_INTEGER. Every BIGINT in our schema is either a unix
  // epoch seconds timestamp (safe until year ~2286) or an auto-increment id
  // that stays in small-integer range for this game's scale, so parsing as
  // Number is safe.
  try {
    const types = require_('pg-types');
    types.setTypeParser(20, val => val === null ? null : parseInt(val, 10));
    // NUMERIC (OID 1700) — used by ROUND(...)/AVG(...) aggregate results.
    types.setTypeParser(1700, val => val === null ? null : parseFloat(val));
  } catch {
    // pg-types should always be present as a transitive dep of pg-native;
    // if it isn't, we leave the defaults and live with string BIGINTs.
  }
}

function _open() {
  let PgClient;
  try {
    PgClient = require_('pg-native');
  } catch (err) {
    throw new Error(
      'DB_BACKEND=postgres requires the optional dependency `pg-native` ' +
      `(and libpq). Install it via \`npm install pg-native\`. Underlying error: ${err.message}`
    );
  }

  _configureTypes();

  const connString = process.env.DATABASE_URL;
  if (!connString) {
    throw new Error('DB_BACKEND=postgres requires DATABASE_URL to be set.');
  }

  const c = new PgClient();
  c.connectSync(connString);
  // Silence the NOTICE spam from CREATE TABLE IF NOT EXISTS on every restart.
  try { c.querySync(`SET client_min_messages = WARNING`); } catch {}
  // Bootstrap the schema. `CREATE TABLE IF NOT EXISTS` + `CREATE EXTENSION IF NOT EXISTS`
  // make this idempotent across restarts.
  c.querySync(getSchemaSql('postgres'));
  return c;
}

function _ensure() {
  if (client === null) client = _open();
  return client;
}

/** Normalize BigInt scalar values to Number. Postgres BIGINT comes back as
 *  BigInt from pg-native; all values stored as unix-epoch seconds or counts
 *  fit comfortably in Number. */
function _normalize(rows) {
  if (!rows || rows.length === 0) return rows;
  for (const row of rows) {
    for (const k in row) {
      const v = row[k];
      if (typeof v === 'bigint') row[k] = Number(v);
    }
  }
  return rows;
}

/** Execute SQL and return the row array. */
export function query(sql, params) {
  const c = _ensure();
  const rows = params && params.length ? c.querySync(sql, params) : c.querySync(sql);
  return _normalize(rows);
}

/** Execute a DML statement and return `{ rows, changes }`. If the SQL does
 *  not already contain a RETURNING clause, one is appended so we can derive
 *  affected-row counts. */
export function runMutation(sql, params) {
  const needsReturning = !/\bRETURNING\b/i.test(sql);
  const finalSql = needsReturning ? `${sql.replace(/;\s*$/, '')} RETURNING 1` : sql;
  const rows = query(finalSql, params);
  return { rows, changes: rows.length };
}

/** BEGIN / COMMIT / ROLLBACK around `fn`, returning a callable like
 *  better-sqlite3's transaction API. */
export function transaction(fn) {
  return (...args) => {
    const c = _ensure();
    c.querySync('BEGIN');
    try {
      const result = fn(...args);
      c.querySync('COMMIT');
      return result;
    } catch (err) {
      try { c.querySync('ROLLBACK'); } catch {}
      throw err;
    }
  };
}

/** Close the shared handle. */
export function close() {
  if (client) {
    try { client.end(); } catch {}
    client = null;
  }
}
