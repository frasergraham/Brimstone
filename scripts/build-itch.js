#!/usr/bin/env node
/**
 * scripts/build-itch.js
 *
 * Build a single-player-only zip for itch.io web hosting.
 * Copies client files, injects a script to hide multiplayer UI,
 * and zips the result.
 *
 * Usage:
 *   node scripts/build-itch.js [output.zip]
 *
 * Default output: dist/calebs-hollow-itch.zip
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const outPath = process.argv[2] ?? path.join(ROOT, 'dist', 'calebs-hollow-itch.zip');
const TEMP = path.join(ROOT, 'dist', '_itch-build');

// ── Clean + create temp dir ─────────────────────────────────────────────────

if (fs.existsSync(TEMP)) fs.rmSync(TEMP, { recursive: true });
fs.mkdirSync(TEMP, { recursive: true });

// ── Copy files ──────────────────────────────────────────────────────────────

const COPY = [
  'index.html',
  'styles.css',
  'src',
  'server/resolver.js',
  'server/state-sync.js',
  'assets/tilemap.png',
  'assets/bg.png',
];

for (const entry of COPY) {
  const src = path.join(ROOT, entry);
  const dest = path.join(TEMP, entry);
  if (!fs.existsSync(src)) {
    console.warn(`  [warn] missing ${entry} — skipped`);
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.statSync(src).isDirectory()) {
    cpDir(src, dest);
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Copy campaign subdir
const campaignSrc = path.join(ROOT, 'src', 'campaign');
if (fs.existsSync(campaignSrc)) {
  cpDir(campaignSrc, path.join(TEMP, 'src', 'campaign'));
}

function cpDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── Patch index.html ────────────────────────────────────────────────────────
// Inject a script before </head> that hides multiplayer UI and stubs out
// server-dependent features so the game loads cleanly offline.

const ITCH_PATCH = `
<script>
// itch.io single-player build — disable multiplayer UI
window.BRIMSTONE_ITCH = true;
document.addEventListener('DOMContentLoaded', () => {
  const hide = [
    'btn-multiplayer',
    'setup-step-multiplayer',
    'setup-step-online',
    'setup-step-async',
    'setup-step-local-play',
  ];
  for (const id of hide) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  // Hide server selector
  const ss = document.getElementById('server-selector');
  if (ss) ss.style.display = 'none';
});
</script>
`;

const indexPath = path.join(TEMP, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace('</head>', ITCH_PATCH + '</head>');
fs.writeFileSync(indexPath, html);

// ── Stub out platform.js for non-native context ─────────────────────────────
// The full platform.js tries to await Capacitor/Electron APIs.
// Replace with a minimal stub that exports the same interface.

const platformStub = `// Stub for itch.io build — no native platform features
export const isNativeMobile = false;
export const isDevMode = false;
export function onInactiveChange() {}
export async function tryGameCenterAuth() { return null; }
export function refreshPushToken() {}
export async function loadGameCenterFriends() { return []; }
export async function shareInvite() { return false; }
export async function registerPushNotifications() {}
`;
fs.writeFileSync(path.join(TEMP, 'src', 'platform.js'), platformStub);

// ── Stub out server-selector.js ─────────────────────────────────────────────

const selectorStub = `// Stub for itch.io build — no server selector
export function initServerSelector() {}
`;
fs.writeFileSync(path.join(TEMP, 'src', 'server-selector.js'), selectorStub);

// ── Stub out notifications.js if it exists ──────────────────────────────────

const notifStub = `// Stub for itch.io build
export function requestNotificationPermission() {}
`;
const notifPath = path.join(TEMP, 'src', 'notifications.js');
if (fs.existsSync(notifPath)) fs.writeFileSync(notifPath, notifStub);

// ── Zip ─────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(outPath), { recursive: true });
if (fs.existsSync(outPath)) fs.rmSync(outPath);

execSync(`cd "${TEMP}" && zip -r "${path.resolve(outPath)}" .`, { stdio: 'pipe' });

// ── Clean up ────────────────────────────────────────────────────────────────

fs.rmSync(TEMP, { recursive: true });

const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`itch.io build → ${outPath}  (${size} MB)`);
