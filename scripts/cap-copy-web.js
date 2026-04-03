#!/usr/bin/env node
/**
 * Copies web assets into www/ for Capacitor builds.
 * Since there is no build step, this is a simple file copy
 * of the directories and files the client needs.
 *
 * Usage:
 *   node scripts/cap-copy-web.js              # defaults to dev
 *   node scripts/cap-copy-web.js --env=dev    # dev server
 *   node scripts/cap-copy-web.js --env=prod   # production server
 */
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WWW  = resolve(ROOT, 'www');

// ── Environment config ──────────────────────────────────────────────────────

function _localIp() {
  const nets = require('os').networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

const ENVS = {
  local: { server: `http://${_localIp()}:3000`, devMode: true },
  dev:   { server: 'https://brimstone-dev.up.railway.app', devMode: true },
  prod:  { server: 'https://calebshollow.com' },
};

const envArg = process.argv.find(a => a.startsWith('--env='));
const env = envArg ? envArg.split('=')[1] : 'dev';
if (!ENVS[env]) {
  console.error(`Unknown env "${env}". Use: ${Object.keys(ENVS).join(', ')}`);
  process.exit(1);
}

// ── Copy assets ─────────────────────────────────────────────────────────────

// Clean previous build
if (existsSync(WWW)) rmSync(WWW, { recursive: true });
mkdirSync(WWW, { recursive: true });

// Directories to copy (relative to project root)
const dirs = ['src', 'assets', 'server'];
for (const dir of dirs) {
  cpSync(resolve(ROOT, dir), resolve(WWW, dir), { recursive: true });
}

// Individual files
const files = ['index.html', 'styles.css'];
for (const file of files) {
  cpSync(resolve(ROOT, file), resolve(WWW, file));
}

// ── Write build config ──────────────────────────────────────────────────────

writeFileSync(resolve(WWW, 'build-config.json'), JSON.stringify(ENVS[env], null, 2));

console.log(`✔ Web assets copied to www/ (env: ${env})`);
