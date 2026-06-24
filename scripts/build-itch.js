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

// Whitelist of everything the itch.io web build needs at runtime. The `assets`
// entry is copied WHOLESALE (minus the dev-only excludes below) — same approach
// as scripts/cap-copy-web.js (the iOS/Android copy). An explicit per-file
// allowlist drifted every time the 3D renderer learned to load a new asset dir
// (models, textures, voice, portraits, mission-maps) and shipped a menu that
// styled fine but couldn't actually render/play a game. Copying the dir is the
// robust fix: every LOCAL runtime asset rides along automatically. Guarded by
// tests/cap-web-assets.test.js. Any new top-level <link rel="stylesheet"> or
// <script> added to index.html must still be added here (assets ride along).
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
  // Wholesale assets copy: fonts (brimstone-icons + ledger Cormorant/EB
  // Garamond), bg.png, tilemap.png, the 3D-renderer GLB models + terrain
  // textures + Babylon vendor bundle, char portraits, mission-map thumbnails,
  // and voice MP3s. The ASSET_EXCLUDE filter (below) drops dev-only source art.
  // (Keep this comment free of apostrophes and square brackets: the
  // cap-web-assets test parses the COPY array string literals with a regex.)
  'assets',
];

// Dev-only asset dirs/files that are NEVER fetched at runtime — excluded to keep
// the itch zip reasonable. Each is console-documented at copy time (no silent
// drops). Correctness (game plays) beats size; only things verified unreferenced
// by src/ are excluded here:
//   • assets/generated  — baked sprite/tpose/building/tile/icon source art used
//                          only by the offline asset-generation scripts (~590 MB).
//   • assets/source     — raw character art + animation sources for the model
//                          pipeline (~280 MB); the runtime loads the baked .glb
//                          under assets/models/ instead.
//   • the 4K PBR texture SOURCE sets (Grass001_4K-JPG / forest_leaves_04 /
//                          brown_dirt_1-4K, ~190 MB) — these bake down to the
//                          small assets/textures/terrain/*-detail.jpg the
//                          renderer actually loads (verified: no src/ ref to the
//                          4K dirs). assets/textures/terrain itself IS shipped.
//   • *.pxd             — Pixelmator editable source docs kept beside exported
//                          runtime PNGs (e.g. cobblestone_large_01_diff_4k.pxd).
//   • .DS_Store         — macOS Finder cruft.
// Mirrors cap-copy-web.js's filter (generated + .pxd) and extends it: the iOS
// bundle currently over-ships the source/4K-PBR art, but the itch zip is hosted
// (download size matters), so we trim the verified-unused dirs here.
const ASSET_EXCLUDE = [
  'assets/generated',
  'assets/source',
  'assets/textures/Grass001_4K-JPG',
  'assets/textures/forest_leaves_04',
  'assets/textures/brown_dirt_1-4K',
];
function isExcludedAsset(relPath) {
  const p = relPath.split(path.sep).join('/'); // normalise to posix for matching
  if (p.endsWith('.pxd') || p.endsWith('.DS_Store')) return true;
  return ASSET_EXCLUDE.some((ex) => p === ex || p.startsWith(ex + '/'));
}

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

// Log what we intentionally skipped under assets/ (no silent drops — see DoD).
for (const ex of ASSET_EXCLUDE) {
  if (fs.existsSync(path.join(ROOT, ex))) {
    console.log(`  [skip] ${ex} — dev-only source art, not loaded at runtime`);
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
    // Skip dev-only asset paths (relative to ROOT so the exclude list matches).
    if (isExcludedAsset(path.relative(ROOT, s))) continue;
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
