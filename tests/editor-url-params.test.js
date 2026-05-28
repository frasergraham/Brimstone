// Tests for the admin-tools URL helpers + editor URL wiring (E7) and the
// E1 unified-modal secondary actions (Resume WIP / Load from disk).
//
// The URL helpers in src/tools/url-state.js are pure — they take/return a
// search string, so they round-trip without touching `location`/`history`.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseToolParams, withToolParams, KNOWN_TOOLS,
} from '../src/tools/url-state.js';
import { openCreationDialog, randomSeed } from '../src/tools/mission-editor-ui.js';

// ── parseToolParams ─────────────────────────────────────────────────────────

describe('parseToolParams', () => {
  test('returns nulls for an empty / missing search', () => {
    assert.deepEqual(parseToolParams(''),         { tool: null, mission: null, wip: null });
    assert.deepEqual(parseToolParams(undefined),  { tool: null, mission: null, wip: null });
  });

  test('extracts tool / mission / wip and accepts a leading "?"', () => {
    assert.deepEqual(
      parseToolParams('?tool=editor&mission=long_watch'),
      { tool: 'editor', mission: 'long_watch', wip: null },
    );
    assert.deepEqual(
      parseToolParams('tool=editor&wip=draft7'),
      { tool: 'editor', mission: null, wip: 'draft7' },
    );
  });

  test('drops unknown tool values rather than activating a non-existent tab', () => {
    assert.equal(parseToolParams('?tool=ghost').tool, null);
    // …but everything else in the same URL is preserved.
    assert.deepEqual(
      parseToolParams('?tool=ghost&mission=x'),
      { tool: null, mission: 'x', wip: null },
    );
  });

  test('KNOWN_TOOLS lists exactly the three admin-tools tabs', () => {
    assert.deepEqual([...KNOWN_TOOLS].sort(), ['assets', 'editor', 'lighting']);
  });
});

// ── withToolParams ──────────────────────────────────────────────────────────

describe('withToolParams', () => {
  test('sets a new param and emits a leading "?"', () => {
    assert.equal(withToolParams('', { tool: 'editor' }), '?tool=editor');
  });

  test('null deletes the param', () => {
    assert.equal(withToolParams('?tool=editor&wip=x', { wip: null }), '?tool=editor');
  });

  test('undefined leaves the param untouched (vs explicit null delete)', () => {
    assert.equal(
      withToolParams('?tool=editor&mission=lw', { wip: 'd1' }),
      '?tool=editor&mission=lw&wip=d1',
    );
  });

  test('PRESERVES unrelated query params', () => {
    const out = withToolParams('?utm=src&debug=1', { tool: 'editor' });
    const params = new URLSearchParams(out.slice(1));
    assert.equal(params.get('utm'), 'src');
    assert.equal(params.get('debug'), '1');
    assert.equal(params.get('tool'), 'editor');
  });

  test('empty result returns "" (no stray "?")', () => {
    assert.equal(withToolParams('?tool=editor', { tool: null }), '');
  });

  test('chained calls round-trip: switch tabs then load a mission', () => {
    let s = '';
    s = withToolParams(s, { tool: 'editor' });
    s = withToolParams(s, { mission: 'first_night' });
    s = withToolParams(s, { mission: 'river_crossing' }); // overwrite
    s = withToolParams(s, { wip: 'draft1' });
    assert.deepEqual(parseToolParams(s),
      { tool: 'editor', mission: 'river_crossing', wip: 'draft1' });
    // Switching away from the editor clears editor-scoped params.
    s = withToolParams(s, { tool: 'assets', mission: null, wip: null });
    assert.deepEqual(parseToolParams(s),
      { tool: 'assets', mission: null, wip: null });
  });
});

// ── E5 — randomSeed ─────────────────────────────────────────────────────────

describe('randomSeed (E5)', () => {
  test('returns a non-negative integer within the 31-bit range', () => {
    for (let i = 0; i < 200; i++) {
      const s = randomSeed();
      assert.ok(Number.isInteger(s), 'integer');
      assert.ok(s >= 0 && s <= 0x7fffffff, `${s} in [0, 2^31-1]`);
    }
  });

  test('is non-degenerate (effectively random)', () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) seen.add(randomSeed());
    assert.ok(seen.size > 15, 'random seeds shouldn\'t collide ~half the time');
  });
});

// ── E1 — openCreationDialog secondary buttons ───────────────────────────────
// Fake DOM (same shape as buildLaunchPicker tests; pure structural assertions).

function makeEl(tag) {
  const el = {
    tag, children: [], parent: null,
    style: {}, dataset: {}, _listeners: {},
    className: '', title: '', textContent: '', type: '', value: '',
    setAttribute() {},
    addEventListener(ev, fn) { (el._listeners[ev] ??= []).push(fn); },
    append(...kids) { for (const k of kids) { k.parent = el; el.children.push(k); } },
    remove() {
      if (!el.parent) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    click(target) { (el._listeners.click ?? []).forEach(fn => fn({ target: target ?? el })); },
    findAll(cls, out = []) {
      for (const k of el.children) {
        if (String(k.className).split(/\s+/).includes(cls)) out.push(k);
        k.findAll?.(cls, out);
      }
      return out;
    },
    findByText(text, out = []) {
      for (const k of el.children) {
        if (String(k.textContent) === text) out.push(k);
        k.findByText?.(text, out);
      }
      return out;
    },
  };
  return el;
}
function makeDoc() {
  const panel = makeEl('editor-panel');
  return {
    _panel: panel,
    createElement: () => makeEl('div'),
    getElementById: (id) => (id === 'editor-panel' ? panel : null),
    body: makeEl('body'),
  };
}

describe('openCreationDialog secondary actions (E1)', () => {
  test('with no secondary callbacks: no alt-buttons row is rendered', () => {
    const doc = makeDoc();
    openCreationDialog(doc, () => {});
    // Only ONE button row (cancel + create).
    assert.equal(doc._panel.findAll('e-modal-alt-btns').length, 0);
  });

  test('hasWip:false suppresses the Resume WIP button even if onResumeWip is wired', () => {
    const doc = makeDoc();
    openCreationDialog(doc, () => {}, {
      onResumeWip: () => {},
      onLoadDisk: () => {},
      hasWip: false,
    });
    // Only Load from disk renders in the alt row (no Resume WIP entry).
    const resume = doc._panel.findByText('Resume WIP…');
    const disk = doc._panel.findByText('Load from disk…');
    assert.equal(resume.length, 0, 'Resume WIP suppressed when hasWip:false');
    assert.equal(disk.length, 1, 'Load from disk still shown');
  });

  test('hasWip:true: Resume WIP appears and fires its callback', () => {
    const doc = makeDoc();
    let resumed = false;
    openCreationDialog(doc, () => {}, {
      onResumeWip: () => { resumed = true; },
      hasWip: true,
    });
    const resume = doc._panel.findByText('Resume WIP…');
    assert.equal(resume.length, 1);
    resume[0].click();
    assert.equal(resumed, true);
  });

  test('Load from disk fires onLoadDisk and closes the modal', () => {
    const doc = makeDoc();
    let diskOpened = false;
    openCreationDialog(doc, () => {}, {
      onLoadDisk: () => { diskOpened = true; },
    });
    const before = doc._panel.children.length;
    assert.ok(before > 0, 'overlay appended');
    const disk = doc._panel.findByText('Load from disk…');
    disk[0].click();
    assert.equal(diskOpened, true);
    // The overlay is removed on close.
    assert.equal(doc._panel.children.length, before - 1);
  });
});
