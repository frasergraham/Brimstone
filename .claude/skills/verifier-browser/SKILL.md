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
Capacitor/Electron builds). Install it **globally** — the harness resolves the
global install via `npm root -g` when the local import fails:

```bash
npm i -g playwright
playwright install chromium            # macOS/local: NO --with-deps
# Linux/CI only: playwright install chromium --with-deps   (needs apt)
```

Verify it resolves before driving:
```bash
node -e "import(require('child_process').execSync('npm root -g').toString().trim()+'/playwright/index.mjs').then(p=>console.log('ok', p.chromium.executablePath()))"
```

## The harness

`scripts/verify/browser-harness.mjs` exports the building blocks:

| Helper | What it does |
|---|---|
| `startServer()` | boots `server.js` on :3199 with a throwaway temp DB; returns `{ baseUrl, stop }` |
| `launchBrowser()` | headless Chromium **with the SwiftShader WebGL flags Babylon requires** (`--use-gl=angle --enable-unsafe-swiftshader`); returns `{ page, logs, close }` with console/pageerror capture |
| `startCampaignMission(page, baseUrl, { missionId, missionTitle, slot, resume, useHook })` | Ledger → Campaign rail → mission row → Begin Mission (default `missionId: 'prologue'`; pass `useHook: true` to launch via `window.__startCampaignMission` instead of clicking) |
| `startSkirmish(page, baseUrl)` | menu → vs. AI → Start Game |
| `loadScenario(page, baseUrl, def)` | **jump straight to a hand-defined board** via `?scenario=` — see below |
| `waitForGameReady(page)` | waits for the `#loading-overlay` (Babylon + assets) to clear — **always await this before judging visuals** |
| `snapHud(page)` | JSON snapshot of HUD state (plan panel, replay HUD, timeline, conversation card) |

## Jump straight to a scenario (preferred for a specific visual)

Grinding an AI game to a precise situation (two units on a forest hex, a
blocked-move-then-attack) is slow and non-deterministic. Instead, `loadScenario`
boots a hand-defined board via the `?scenario=<urlencoded JSON>` dev loader
(`initScenario` in `src/main.js`) — skipping the menu, AI, and conversations,
and optionally animating a **scripted** turn. Definition shape:

```js
{
  cols, rows,                                   // grid (default 9×9 grass)
  tiles: [{ col, row, type:'FOREST'|'ROAD'|…, roadDirs?:['c,r'] }],  // sparse overrides
  hero:  { col, row },                          // hero leader start (required)
  witch: { col, row } | null,                   // witch start; null ⇒ no witch
  units: [{ ref?, type, owner:'hero'|'witch', col, row, weapon?, level? }],
  heroPlan:  [{ ref, move:[c,r] } | { ref, attack:'<ref>' }
              | { ref, guard:true } | { ref, explore:true }],  // optional…
  witchPlan: [ … ],                             // …only used when resolve:true
  resolve: true,                                // animate the scripted turn
  summary: true,                                // keep the end-of-round wrap-up card
                                                // (skipped by default in scenario mode)
  fog: 'none',                                  // default 'none' (see everything)
  pov: 'hero',                                  // hero side human-controlled — gives fog
                                                // ('partial') a real observer; required to
                                                // reproduce fog gating / card visibility
}
```

`ref` labels a placed unit so a plan can target it; the leaders are pre-bound as
`'hero'` / `'witch'`. Hero-side `units` spawn as recruited survivors (they can
act in `heroPlan`). For a deterministic explore result, pair `{ ref, explore:true }`
with a tile-level `exploreOverride: { kind:'resource', id:'wood', amount:2 }`.
Two worked checks:

```js
// Slot fix: 3 witch units on one forest hex must sit in distinct slots, no +N badge.
await loadScenario(page, baseUrl, {
  cols:7, rows:7, hero:{col:1,row:1}, witch:{col:6,row:6}, fog:'none',
  tiles:[{ col:3, row:3, type:'FOREST', roadDirs:['3,4'] }],
  units:[ {type:'minion',owner:'witch',col:3,row:3},
          {type:'zombie',owner:'witch',col:3,row:3},
          {type:'minion',owner:'witch',col:3,row:3} ],
});
await waitForGameReady(page); await page.waitForTimeout(1500);
// assert: 0 elements whose text matches /^\+\d+$/  (the overflow badge)

// Blocked-move ordering: golem adjacent to hero, plans move-onto-hero (blocked) then attack.
await loadScenario(page, baseUrl, {
  cols:7, rows:7, hero:{col:3,row:3}, witch:{col:6,row:6}, resolve:true, fog:'none',
  units:[{ ref:'g', type:'wood_golem', owner:'witch', col:3, row:4 }],
  witchPlan:[ {ref:'g', move:[3,3]}, {ref:'g', attack:'hero'} ],
});
await waitForGameReady(page);
await page.waitForTimeout(900);   // resolution kicks ~900ms after the reveal
// screenshot the move beat (golem walks to the edge) then the attack beat
```

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
// NB: absolute path — a /tmp driver can't resolve './scripts/…' (see Gotchas).
import {
  startServer, launchBrowser, startCampaignMission, waitForGameReady, snapHud,
} from '/ABS/PATH/TO/REPO/scripts/verify/browser-harness.mjs';

const srv = await startServer();
const { page, logs, close } = await launchBrowser();
await startCampaignMission(page, srv.baseUrl, { missionId: 'prologue' });
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

- **Driver import path**: a one-off `/tmp/verify-*.mjs` must import the harness
  by ABSOLUTE path (`/Users/…/scripts/verify/browser-harness.mjs`). ESM resolves
  relative imports against the *script's own dir* (`/tmp`), not your cwd, so
  `'./scripts/verify/…'` fails with `ERR_MODULE_NOT_FOUND`.
- **Port 3199 / EADDRINUSE**: `startServer` uses :3199. A hung prior driver keeps
  it bound and the next run dies with `EADDRINUSE`. Clean up between runs:
  `lsof -ti tcp:3199 | xargs kill -9; pkill -f server.js` (or pass `{ port }`).
  Prefer `run_in_background` + a generous timeout so a stuck replay-step loop
  doesn't wedge the port.
- **WebGL**: without the SwiftShader launch args the 3D renderer never
  initializes and the canvas stays black (the harness sets them).
- **Loading race**: clicks before `waitForGameReady` can land on the loading
  overlay and be swallowed.
- **Campaign opens on a conversation**: `startCampaignMission` lands on the
  intro CONVERSATION (turn-0), not planning — `#plan-submit-btn` is absent until
  it's dismissed. Click the **SKIP** button (or step `#replay-next-btn`) until
  `snapHud().convCard` is `null`.
- **Resolving a real turn** (when you can't script it via `loadScenario`):
  submit the plan with `#plan-submit-btn`, then confirm an empty plan via
  `#grace-submit-empty` if the prompt appears. After submit the game sits on the
  **replay HUD** (`replayHud:'flex'`, `planPanel:'none'`) and does NOT auto-return
  to planning — step `#replay-next-btn` until `snapHud().planPanel` is visible
  again to reach the next round.
- **Selectors (Ledger menu)**: campaign rail item
  `#ledger-rail-items .ledger-rail-item[data-dest="campaign"]`, mission rows
  `.lg-mission[data-mission-id=…]` (or `[data-mission-title=…]`), Begin/Resume
  `[data-testid="begin-mission"]`; plan submit `#plan-submit-btn` /
  `#grace-submit-empty`, replay controls `#replay-{next,back,redo}-btn`.
- **Cones, not models**: GLB rigs 404 in headless → units render as cones (known
  noise: "unit will be invisible" warnings). Layout / slot / stacking / UI / +N
  badge judgments are still valid.
