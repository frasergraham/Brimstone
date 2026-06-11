// Tests for persistMission() — the Save target switch used by the Mission
// Editor (src/tools/mission-editor-ui.js). In Caleb's Studio (Electron) a
// repo-confined filesystem bridge (window.studioAPI) writes the validated
// mission JSON straight into src/campaign/missions/; in a plain browser it
// falls back to a Blob download. DOM-free: the Studio path needs no document,
// and the download path is exercised with a tiny stub.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { persistMission } from '../src/tools/mission-editor-ui.js';

describe('persistMission — Studio bridge', () => {
  test('writes pretty JSON into src/campaign/missions/ via studioAPI', async () => {
    const calls = [];
    const studioAPI = {
      writeFile: async (rel, text) => { calls.push({ rel, text }); return { ok: true, path: rel }; },
    };
    const json = { id: 'Ch1M1', title: 'Test' };

    const res = await persistMission(json, 'Ch1M1.json', { studioAPI });

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].rel, 'src/campaign/missions/Ch1M1.json');
    // Byte-faithful: identical to the download path's serialisation.
    assert.equal(calls[0].text, JSON.stringify(json, null, 2));
    assert.match(res.message, /Saved/);
  });

  test('surfaces a bridge write failure without claiming success', async () => {
    const studioAPI = { writeFile: async () => ({ ok: false, error: 'EACCES' }) };

    const res = await persistMission({ id: 'x' }, 'x.json', { studioAPI });

    assert.equal(res.ok, false);
    assert.match(res.message, /EACCES/);
  });
});

describe('persistMission — browser fallback', () => {
  test('downloads via the document when no studioAPI is present', async () => {
    let clicked = false;
    let downloadName = null;
    // Minimal stub of the DOM surface downloadJSON touches.
    globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
    globalThis.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
    const anchor = { set href(_) {}, set download(v) { downloadName = v; }, click() { clicked = true; } };
    const doc = {
      createElement: () => anchor,
      body: { appendChild() {}, removeChild() {} },
    };

    const res = await persistMission({ id: 'm' }, 'm.json', { doc });

    assert.equal(res.ok, true);
    assert.equal(clicked, true);
    assert.equal(downloadName, 'm.json');
    assert.match(res.message, /downloaded/);
  });
});
