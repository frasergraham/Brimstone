#!/usr/bin/env node
/**
 * scripts/build-itch.js
 *
 * Build a zip for itch.io web hosting.
 * Copies client files, stubs native-only modules,
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
// Output to /tmp so build artifacts don't clutter the project root. The release
// script (scripts/release.js, ITCH_ZIP) hardcodes this same default path.
const OUT_DIR = '/tmp/brimstone-itch';
const outPath = process.argv[2] ?? path.join(OUT_DIR, 'calebs-hollow-itch.zip');
const TEMP = path.join(OUT_DIR, '_itch-build');

fs.mkdirSync(path.dirname(outPath), { recursive: true });

// ── Clean + create temp dir ─────────────────────────────────────────────────

if (fs.existsSync(TEMP)) fs.rmSync(TEMP, { recursive: true });
fs.mkdirSync(TEMP, { recursive: true });

// ── Copy files ──────────────────────────────────────────────────────────────

// Whitelist of everything the itch.io web build needs at runtime. Keep this in
// sync with the assets index.html (and the CSS it loads) references — a missing
// stylesheet or font 404s under the itch file:// / zip-root and the menu renders
// unstyled. This mirrors scripts/cap-copy-web.js (the iOS/Android copy). Guarded
// by tests/cap-web-assets.test.js. Any new top-level <link rel="stylesheet"> or
// <script> added to index.html must be added here too.
const COPY = [
  'index.html',
  'styles.css',
  // The ledger-menu redesign (front-of-app) lives in a second stylesheet linked
  // from index.html. It MUST ship — otherwise the menu loads unstyled. It also
  // @imports assets/fonts/ledger-fonts.css and references assets/bg.png.
  'styles-ledger.css',
  'src',
  'server/resolver.js',
  'server/state-sync.js',
  'assets/tilemap.png',
  'assets/bg.png',
  // Fonts: brimstone-icons.woff2 (styles.css @font-face) + the ledger menu's
  // Cormorant/EB Garamond woff2s loaded via assets/fonts/ledger-fonts.css.
  // Copy the whole fonts dir — it's small and every file in it is referenced.
  'assets/fonts',
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
// itch.io build flag
window.BRIMSTONE_ITCH = true;
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
export async function refreshPushToken() {}
export async function unregisterPushToken() {}
export async function loadGameCenterFriends() { return []; }
export async function shareInvite() { return false; }
export async function registerPushNotifications() {}
`;
fs.writeFileSync(path.join(TEMP, 'src', 'platform.js'), platformStub);

// ── Stub out server-selector.js (dev-only feature, needs /api/environments) ─

// The ledger menu (src/menu/ledger.js) imports { mountServerSelector } — the
// stub MUST export that exact symbol or the ES-module load throws a SyntaxError
// and the entire ledger fails to render (blank menu). Keep the export name in
// sync with src/server-selector.js.
const selectorStub = `// Stub for itch.io build — no server selector
export async function mountServerSelector() {}
`;
fs.writeFileSync(path.join(TEMP, 'src', 'server-selector.js'), selectorStub);

// ── Stub out notifications.js if it exists ──────────────────────────────────

const notifStub = `// Stub for itch.io build
export function requestNotificationPermission() {}
export function notifyRoundReady() {}
export function notifyWaitingOnYou() {}
export function notifyDeadlineApproaching() {}
export function notifyGameOver() {}
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
