// Smoke test for the unified tabbed tools page at admin-tools.html.
// It merges the standalone Asset viewer + Lighting tuner into one page with a
// third (placeholder) Mission Editor tab, and lazy-inits each tab's heavy
// Babylon scene only on first activation. This test pins the structural
// invariants — the actual rendering can't be exercised in Node.
//
// P4 of the campaign-mission-editor initiative.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = resolve(__dirname, '..', 'admin-tools.html');

describe('admin-tools.html', () => {
  test('exists at repo root', () => {
    assert.ok(existsSync(PAGE_PATH), 'admin-tools.html should be at repo root next to admin.html');
  });

  const html = readFileSync(PAGE_PATH, 'utf8');

  test('has the three tabs: Assets | Lighting | Mission Editor', () => {
    assert.match(html, /data-tab="assets"/);
    assert.match(html, /data-tab="lighting"/);
    assert.match(html, /data-tab="editor"/);
    assert.match(html, />Mission Editor</);
  });

  test('uses the lazy-init tab controller', () => {
    assert.match(html, /from\s+['"]\/src\/tools\/tab-controller\.js['"]/);
    assert.match(html, /createTabController/);
    // init functions are deferred behind onFirstActivate, not run at module top level.
    assert.match(html, /onFirstActivate/);
  });

  test('shares the global dark gothic theme', () => {
    assert.match(html, /<link\s+rel="stylesheet"\s+href="\/styles\.css"/);
  });

  test('loads Babylon UMD locally for the Assets tab (not a CDN)', () => {
    assert.match(html, /\/assets\/vendor\/babylonjs\/babylon\.js/);
    assert.match(html, /\/assets\/vendor\/babylonjs\/babylonjs\.loaders\.min\.js/);
    assert.doesNotMatch(html, /cdn\.babylonjs\.com/);
  });

  test('reuses Renderer3D for the Lighting tab', () => {
    assert.match(html, /from\s+['"]\/src\/renderer-3d\.js['"]/);
    assert.match(html, /new\s+Renderer3D/);
  });

  test('deferred async resume is gated on the tab still being active', () => {
    // Guards the mid-boot switch race: if the user switches away from a tab
    // before its async boot resolves, the deferred resume() must NOT run (or
    // it leaves a hidden tab's render loop going). The gate is controller.active.
    assert.match(html, /controller\.active\s*===\s*id/);
  });

  test('Mission Editor tab boots the 2D editor lazily (P5)', () => {
    assert.match(html, /id="editor-panel"/);
    // Canvas + palette shell present; controller wired via the editor-ui module.
    assert.match(html, /id="e-render-canvas"/);
    assert.match(html, /id="e-palette"/);
    assert.match(html, /from\s+['"]\/src\/tools\/mission-editor-ui\.js['"]/);
    assert.match(html, /initEditor\(\)/);
    // Boot is deferred to first activation (bootTab → onFirstActivate), not at
    // module top level.
    assert.doesNotMatch(html, /initEditor\(\);\s*\n\s*controller\.activate/);
  });

  test('namespaces canvas ids per tab to avoid collisions', () => {
    // Both source pages used #render-canvas; merged page must disambiguate.
    assert.match(html, /id="a-render-canvas"/);
    assert.match(html, /id="l-render-canvas"/);
  });
});
