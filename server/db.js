// Default database backend singleton.
// All server modules import this to get a shared backend instance.
import { createBackend } from './db-backend.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = process.env.DB_PATH || join(__dirname, '..', 'data', 'brimstone.db');

export default createBackend(DB_PATH);
