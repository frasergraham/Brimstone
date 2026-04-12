// Compat shim — the canonical entry point is `server/db/index.js`.
// Existing callers (`import db from './db.js'`) keep working unchanged.
export { default } from './db/index.js';
