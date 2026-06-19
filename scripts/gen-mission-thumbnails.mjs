// Generate the fixed (pre-generated) campaign mission map images.
//
// For every bundled campaign mission this drives the REAL 3D renderer in
// headless Chromium and captures a 512×512 top-down board thumbnail via the
// SAME renderer-3d `captureMapThumbnail()` path the in-game saved thumbnails
// use — so a not-yet-started mission's card matches an in-progress one's style.
//
// Each mission is booted directly through the `?genMissionThumb=<missionId>`
// dev hook (see src/main.js), which loads that mission's starting board and
// exposes the live renderer as `window.__renderer3d`. captureMapThumbnail()
// already encodes JPEG (quality 0.6, same as the in-game saved thumbnails), so
// the snapshot is written straight to assets/mission-maps/<file>.jpg, keyed by
// the mission's stable on-disk file basename (the ChXMY convention) so the asset
// name survives a mission-id rename. JPEG (not PNG) keeps each asset ~30KB —
// these only ever render at 64×48 / 170×108 in the card, so lossless is wasted.
//
// Re-run any time the maps change:
//
//   node scripts/gen-mission-thumbnails.mjs            # all 13 missions
//   node scripts/gen-mission-thumbnails.mjs Ch1M3      # one mission (by id OR file basename)
//
// One-time setup (Playwright is intentionally NOT a project dependency):
//   npm i -g playwright && playwright install chromium
//
// The port auto-advances from 3199 through 3299 if the default is busy.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, launchBrowser, waitForGameReady } from './verify/browser-harness.mjs';
import { MIGRATED_MISSIONS, missionMapImageName } from '../src/campaign/mission-catalog.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'assets', 'mission-maps');
const THUMB_SIZE = 512;

// Optional filter: a mission id or file basename to (re)generate just one.
const only = process.argv[2] || null;

async function startServerOnFreePort() {
  for (let port = 3199; port <= 3299; port++) {
    try { return await startServer({ port }); }
    catch (e) { if (port === 3299) throw e; /* port busy — try the next */ }
  }
}

/**
 * Capture one mission's top-down thumbnail as a JPEG data URL (the exact format
 * captureMapThumbnail() emits — the same path the in-game saved thumbnails use).
 * Boots `?genMissionThumb=<id>` and waits for the renderer.
 */
async function captureMissionThumb(page, baseUrl, missionId) {
  await page.goto(`${baseUrl}/?genMissionThumb=${encodeURIComponent(missionId)}`, {
    waitUntil: 'domcontentloaded',
  });
  await waitForGameReady(page, 45000);
  // Give the scene a couple of frames to fully populate (units/tiles materials).
  await page.waitForTimeout(1500);
  return page.evaluate(async (size) => {
    const r = window.__renderer3d;
    if (!r?.captureMapThumbnail) throw new Error('renderer not exposed');
    const jpeg = await r.captureMapThumbnail(size);
    if (!jpeg) throw new Error('captureMapThumbnail returned null');
    return jpeg;
  }, THUMB_SIZE);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const missions = MIGRATED_MISSIONS.filter(
    (m) => !only || m.id === only || m.file === only,
  );
  if (!missions.length) {
    console.error(`No mission matches "${only}". Known ids/files:`);
    for (const m of MIGRATED_MISSIONS) console.error(`  ${m.id}  (${m.file})`);
    process.exit(1);
  }

  const server = await startServerOnFreePort();
  console.log(`server: ${server.baseUrl}`);
  const { page, logs, close } = await launchBrowser({ width: 900, height: 900 });

  let ok = 0, failed = 0;
  try {
    for (const m of missions) {
      const file = `${missionMapImageName(m.id)}.jpg`;
      const dest = join(OUT_DIR, file);
      process.stdout.write(`  ${m.id.padEnd(22)} → assets/mission-maps/${file} … `);
      try {
        const dataUrl = await captureMissionThumb(page, server.baseUrl, m.id);
        const b64 = dataUrl.replace(/^data:image\/jpe?g;base64,/, '');
        writeFileSync(dest, Buffer.from(b64, 'base64'));
        console.log('ok');
        ok++;
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
        const tail = logs.slice(-6).join('\n    ');
        if (tail) console.log(`    recent console:\n    ${tail}`);
        failed++;
      }
    }
  } finally {
    await close();
    server.stop();
  }

  console.log(`\nDone: ${ok} generated, ${failed} failed → ${OUT_DIR}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
