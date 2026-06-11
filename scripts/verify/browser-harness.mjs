// Browser-verification harness — drive the real game in headless Chromium and
// capture screenshots/state. This is the repo's evidence-capture mechanism for
// VISUAL changes (renderer, UI overlays, replay presentation, conversations):
// run the app, navigate to the changed surface, screenshot it, look at it.
//
// Used by the `verifier-browser` skill (.claude/skills/verifier-browser/) and
// runnable standalone:
//
//   import { startServer, launchBrowser, startCampaignMission, snapHud }
//     from './scripts/verify/browser-harness.mjs';
//
// Playwright is NOT a project dependency (it would bloat the Capacitor/
// Electron builds). The harness resolves it from the project's node_modules
// if present, else from the global npm root. One-time setup:
//
//   npm i -g playwright && playwright install chromium --with-deps
//
// WebGL note: Babylon renders headlessly via SwiftShader — the launch args
// below are required or the 3D renderer never initializes.

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function _resolvePlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return import(join(globalRoot, 'playwright', 'index.mjs'));
  }
}

/**
 * Start the game server on an ephemeral port with a throwaway DB.
 * @returns {Promise<{ port, baseUrl, stop() }>}
 */
export async function startServer({ port = 3199 } = {}) {
  const dbDir = mkdtempSync(join(tmpdir(), 'brimstone-verify-'));
  const proc = spawn('node', ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), DB_PATH: join(dbDir, 'verify.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const deadline = Date.now() + 15000;
  while (!log.includes('listening on port')) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`server did not start:\n${log}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return {
    port,
    baseUrl: `http://localhost:${port}`,
    stop: () => proc.kill(),
  };
}

/**
 * Launch headless Chromium with WebGL (SwiftShader) and console capture.
 * @returns {Promise<{ browser, page, logs: string[], close() }>}
 */
export async function launchBrowser({ width = 1280, height = 800 } = {}) {
  const { chromium } = await _resolvePlaywright();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  return { browser, page, logs, close: () => browser.close() };
}

/**
 * Navigate menu → campaign → mission and begin it. Resolves once the mission
 * has had a moment to start (loading overlay may still be up — await
 * `waitForGameReady` before judging visuals).
 */
export async function startCampaignMission(page, baseUrl, {
  campaignId = 'calebs_hollow_prologue',
  missionTitle = 'Awakening',
} = {}) {
  await page.goto(baseUrl);
  await page.waitForTimeout(1200);
  await page.click('#btn-new-game');
  await page.click('#btn-ng-campaign');
  await page.waitForTimeout(800);
  const select = await page.$('#setup-step-campaign-select');
  if (select && await select.isVisible()) {
    await page.click(`.campaign-select-item[data-campaign="${campaignId}"]`);
    await page.waitForTimeout(800);
  }
  await page.locator('.campaign-mission.available', { hasText: missionTitle }).first().click();
  await page.waitForTimeout(500);
  await page.click('#btn-start-mission');
}

/** Start a quick local vs-AI skirmish from the menu (hero side, defaults). */
export async function startSkirmish(page, baseUrl) {
  await page.goto(baseUrl);
  await page.waitForTimeout(1200);
  await page.click('#btn-new-game');
  await page.click('#btn-ng-vsai');
  await page.waitForTimeout(500);
  await page.click('#btn-start-qp');
}

/** Wait for the renderer's loading overlay to clear (assets + Babylon ready). */
export async function waitForGameReady(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loading = await page.evaluate(() => {
      const el = document.getElementById('loading-overlay');
      return !!el && el.style.display !== 'none' && !el.hidden && el.offsetParent !== null;
    }).catch(() => false);
    if (!loading) return;
    await page.waitForTimeout(250);
  }
}

/** Snapshot the HUD state relevant to most visual checks (extend as needed). */
export function snapHud(page) {
  return page.evaluate(() => ({
    planPanel:  document.getElementById('plan-panel')?.style.display,
    replayHud:  document.getElementById('replay-hud')?.style.display,
    endTurnBtn: document.getElementById('end-turn-btn')?.style.display,
    timeline:   document.getElementById('replay-timeline')?.className,
    convCard:   document.querySelector('.replay-conv-col')?.innerText ?? null,
    nextBtnDisabled: document.getElementById('replay-next-btn')?.disabled ?? null,
  }));
}

/**
 * Boot a hand-defined board via the `?scenario=` dev loader (see initScenario in
 * src/main.js) — a small map + unit placements + an optional scripted turn,
 * skipping the menu/AI/conversation. Lets a visual change be verified at an
 * exact board state deterministically (e.g. two units on a forest hex, or a
 * blocked-move-then-attack) instead of grinding an AI game to that situation.
 *
 * @param {import('playwright').Page} page
 * @param {string} baseUrl
 * @param {object} def  scenario definition (see initScenario's doc comment):
 *   { cols, rows, tiles[], hero, witch, units[], heroPlan[], witchPlan[], resolve, fog }
 */
export async function loadScenario(page, baseUrl, def) {
  const url = `${baseUrl}/?scenario=${encodeURIComponent(JSON.stringify(def))}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}
