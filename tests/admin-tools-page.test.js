// Static-wiring guards for the unified tabbed tools page at admin-tools.html.
//
// The page's BEHAVIOUR lives in importable modules and is tested there:
//   • lazy tab activation / mid-boot switch race → tests/tab-controller.test.js
//   • tool-id registry / URL state              → src/tools/url-state.js tests
//   • Mission Editor                            → tests/mission-editor*.test.js
//   • Lighting-tab absolute asset base          → tests/admin-tools-asset-base.test.js
//   • Combat tab controller                     → tests/admin-combat-tester.test.js
// The inline boot script and the page's CSS are verified in the browser
// (verifier-browser skill) — unit-greping that script text passed even when
// the page was broken and broke on harmless refactors, so those checks are
// intentionally gone.
//
// What REMAINS here are pure static-markup presence checks that guard real
// wiring: element ids the JS modules look up at boot (a missing id makes a
// tab silently render blank), the data-tab registry shared with url-state.js,
// and the locally-vendored Babylon scripts (the tools must work offline —
// regression: a CDN URL crept back in).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_TOOLS } from '../src/tools/url-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = resolve(__dirname, '..', 'admin-tools.html');

describe('admin-tools.html', () => {
  test('exists at repo root', () => {
    assert.ok(existsSync(PAGE_PATH), 'admin-tools.html should be at repo root next to admin.html');
  });

  const html = readFileSync(PAGE_PATH, 'utf8');

  test('menu items cover exactly the KNOWN_TOOLS registry (url-state.js ↔ markup)', () => {
    // The dropdown's data-tab values must stay in lockstep with KNOWN_TOOLS —
    // a tool registered in url-state.js but missing from the menu is
    // unreachable; a menu item missing from KNOWN_TOOLS loses URL state.
    const menuTabs = new Set(
      [...html.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]),
    );
    assert.deepEqual([...menuTabs].sort(), [...KNOWN_TOOLS].sort(),
      'data-tab menu entries must match KNOWN_TOOLS exactly');
  });

  test('has every element id the boot script and tool modules getElementById', () => {
    // Each of these is looked up by JS at boot; a missing id silently breaks
    // the corresponding tool (blank tab, dead menu) with no thrown error.
    const requiredIds = [
      'tools-menu-btn', 'tools-menu-list',          // tool-switch dropdown
      'file-menu', 'file-load', 'file-save',        // editor Load/Save menu
      'assets-panel', 'lighting-panel', 'editor-panel', 'combat-panel',
      // Canvas ids are namespaced per tab (both source pages used
      // #render-canvas; the merged page must keep them disambiguated).
      'a-render-canvas', 'l-render-canvas', 'e-render-canvas', 'c-render-canvas',
      'e-palette',                                   // mission-editor-ui.js palette host
    ];
    for (const id of requiredIds) {
      assert.ok(html.includes(`id="${id}"`), `missing element id="${id}"`);
    }
  });

  test('loads Babylon UMD from the local vendor copy, never a CDN', () => {
    assert.match(html, /\/assets\/vendor\/babylonjs\/babylon\.js/);
    assert.match(html, /\/assets\/vendor\/babylonjs\/babylonjs\.loaders\.min\.js/);
    assert.doesNotMatch(html, /cdn\.babylonjs\.com/,
      'tools must work offline / behind the LAN dev server');
  });
});
