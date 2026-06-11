---
name: verifier-browser
description: Verify visual/UI changes by driving the real game in headless Chromium and capturing screenshots — REQUIRED for any change to the 3D renderer, UI overlays/HUD, replay presentation, conversations, or CSS before pushing
---

# Browser Verification — run the game, look at it

Every **visual change** in this repo (renderer-3d.js, ui.js / ui-*.js, replay
presentation, conversation system, styles.css, index.html overlays) must be
verified by running the actual game and looking at screenshots — unit tests
cannot see a clipped speech bubble or a camera framing bug. This skill is the
repo's evidence-capture protocol for that.

## One-time environment setup

Playwright is deliberately NOT a project dependency (it would bloat the
Capacitor/Electron builds). Install it globally:

```bash
npm i -g playwright && playwright install chromium --with-deps
```

(`--with-deps` needs apt; in restricted environments install chromium deps
separately or use a system chromium.)

## The harness

`scripts/verify/browser-harness.mjs` exports the building blocks:

| Helper | What it does |
|---|---|
| `startServer()` | boots `server.js` on :3199 with a throwaway temp DB; returns `{ baseUrl, stop }` |
| `launchBrowser()` | headless Chromium **with the SwiftShader WebGL flags Babylon requires** (`--use-gl=angle --enable-unsafe-swiftshader`); returns `{ page, logs, close }` with console/pageerror capture |
| `startCampaignMission(page, baseUrl, { campaignId, missionTitle })` | menu → campaign → mission → Begin Mission |
| `startSkirmish(page, baseUrl)` | menu → vs. AI → Start Game |
| `waitForGameReady(page)` | waits for the `#loading-overlay` (Babylon + assets) to clear — **always await this before judging visuals** |
| `snapHud(page)` | JSON snapshot of HUD state (plan panel, replay HUD, timeline, conversation card) |

## Protocol

1. Write a small one-off driver script (e.g. `/tmp/verify-<feature>.mjs`)
   importing the harness; navigate to where the changed code renders.
2. Drive it the way a player would — click the real buttons (`#replay-next-btn`,
   `.replay-conv-btn`, canvas hexes), don't call internals.
3. `page.screenshot({ path })` at each meaningful beat, plus `snapHud()` for
   DOM-state assertions. **Read the screenshots** — the capture is the
   evidence; a passing script with unviewed images proves nothing.
4. Check the captured console `logs` for `[pageerror]` and renderer errors.
   (Known noise in sandboxes: GLB rig 404s → "unit will be invisible"
   mannequin warnings. Units render as cones; layout/UI judgments are still
   valid.)
5. Probe at least one off-path: SKIP mid-animation, toggle the Fixed camera,
   resize, rapid NEXT presses.
6. Report with the screenshots attached/sent — before/after pairs for fixes.

## Worked example

A complete driver for the Mission 1 intro conversation flow:

```js
import {
  startServer, launchBrowser, startCampaignMission, waitForGameReady, snapHud,
} from './scripts/verify/browser-harness.mjs';

const srv = await startServer();
const { page, logs, close } = await launchBrowser();
await startCampaignMission(page, srv.baseUrl, { missionTitle: 'Awakening' });
await waitForGameReady(page);
await page.waitForTimeout(1500);                 // conversation framing settles
await page.screenshot({ path: '/tmp/intro-line1.png' });
console.log(await snapHud(page));
await page.click('#replay-next-btn');            // NEXT = next dialog line
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/intro-line2.png' });
console.log(logs.filter(l => l.includes('pageerror')));
await close(); srv.stop();
```

## Gotchas

- **WebGL**: without the SwiftShader launch args the 3D renderer never
  initializes and the canvas stays black.
- **Loading race**: clicks before `waitForGameReady` can land on the loading
  overlay and be swallowed.
- **Selectors**: campaign cards are `.campaign-select-item[data-campaign=…]`,
  missions `.campaign-mission.available` (match by title text), begin is
  `#btn-start-mission`, replay controls `#replay-{next,playpause,redo}-btn`.
- Server port 3199 by default — pass `{ port }` if it's taken; the DB is a
  temp file so verification never touches real saves.
