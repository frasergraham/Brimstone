// Backend-selection singleton. Picks between SQLite and Postgres based on the
// DB_BACKEND environment variable. Consumers import `db` from here (or from
// the compat shim at server/db.js) and get a unified high-level API regardless
// of the underlying store.

const backend = (process.env.DB_BACKEND || 'sqlite').toLowerCase();

let db;
if (backend === 'postgres' || backend === 'pg') {
  db = (await import('./postgres/index.js')).default;
} else if (backend === 'sqlite' || backend === '') {
  db = (await import('./sqlite/index.js')).default;
} else {
  throw new Error(`Unknown DB_BACKEND: ${backend} (expected 'sqlite' or 'postgres')`);
}

export default db;
