// Tests for the Mission Editor WIP autosave store + launch picker.
//
//   • WIP store helpers (src/tools/mission-editor.js): save / list / load /
//     remove / evict / corrupt-skip / schema-guard / quota-safe — exercised
//     against a plain localStorage stub (no real DOM).
//   • buildLaunchPicker / formatWipTime (src/tools/mission-editor-ui.js): the
//     launch-picker DOM + relative-time label, via a minimal fake document.
//
// DOM-free / DOM-light per CLAUDE.md — the store is pure over an injected
// storage; the picker is thin wiring over injected callbacks.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  saveWip, listWip, loadWip, removeWip, evictWip,
  makeWipEntry, wipStorageKey, WIP_KEY_PREFIX, WIP_MAX_SLOTS,
  assembleMission, populateFromMission, createDefaultMeta, createDefaultMapDef,
  createMissionEditor,
} from '../src/tools/mission-editor.js';
import {
  buildLaunchPicker, formatWipTime,
} from '../src/tools/mission-editor-ui.js';

// ── localStorage stub ─────────────────────────────────────────────────────────
function makeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    _map: map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

// A complete assembled schema:1 mission with the given id/title.
function mission(id = 'm1', title = 'Mission One') {
  return assembleMission({
    meta: { ...createDefaultMeta(), id, title },
    mapDef: createDefaultMapDef(),
    enemyUnits: [],
  });
}

describe('WIP store — save / list / load', () => {
  test('saveWip writes under the namespaced key and round-trips', () => {
    const s = makeStorage();
    const m = mission('alpha', 'Alpha');
    const entry = saveWip(s, m, { savedAt: 1000 });
    assert.equal(entry.id, 'alpha');
    assert.equal(entry.name, 'Alpha');
    assert.ok(s.getItem(wipStorageKey('alpha')), 'raw value persisted under prefix');
    assert.ok(wipStorageKey('alpha').startsWith(WIP_KEY_PREFIX));

    const loaded = loadWip(s, 'alpha');
    assert.equal(loaded.id, 'alpha');
    // The stored mission is the exact assembled JSON the editor would download.
    assert.deepEqual(loaded.mission, m);
    // …and populating from it is symmetric with assemble.
    const split = populateFromMission(loaded.mission);
    assert.equal(split.meta.id, 'alpha');
  });

  test('one slot per mission id — re-saving overwrites in place', () => {
    const s = makeStorage();
    saveWip(s, mission('dup', 'First'), { savedAt: 1 });
    saveWip(s, mission('dup', 'Second'), { savedAt: 2 });
    const all = listWip(s);
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'Second');
  });

  test('listWip returns distinct drafts newest-first', () => {
    const s = makeStorage();
    saveWip(s, mission('old'), { savedAt: 100 });
    saveWip(s, mission('mid'), { savedAt: 200 });
    saveWip(s, mission('new'), { savedAt: 300 });
    assert.deepEqual(listWip(s).map(e => e.id), ['new', 'mid', 'old']);
  });

  test('loadWip returns null for an unknown id', () => {
    assert.equal(loadWip(makeStorage(), 'nope'), null);
  });

  test('removeWip deletes the slot', () => {
    const s = makeStorage();
    saveWip(s, mission('gone'), { savedAt: 1 });
    removeWip(s, 'gone');
    assert.equal(loadWip(s, 'gone'), null);
    assert.equal(listWip(s).length, 0);
  });

  test('makeWipEntry derives name from title, falls back to id', () => {
    assert.equal(makeWipEntry({ id: 'x', title: 'Titled' }).name, 'Titled');
    assert.equal(makeWipEntry({ id: 'x' }).name, 'x');
    assert.equal(makeWipEntry({}).id, 'mission');
  });
});

describe('WIP store — eviction', () => {
  test('evicts oldest beyond cap', () => {
    const s = makeStorage();
    for (let i = 0; i < 5; i++) saveWip(s, mission(`m${i}`), { savedAt: i });
    evictWip(s, 3);
    // Keeps the 3 newest (savedAt 4,3,2); drops m0,m1.
    assert.deepEqual(listWip(s).map(e => e.id), ['m4', 'm3', 'm2']);
  });

  test('saveWip auto-evicts to WIP_MAX_SLOTS', () => {
    const s = makeStorage();
    for (let i = 0; i < WIP_MAX_SLOTS + 4; i++) saveWip(s, mission(`m${i}`), { savedAt: i });
    assert.equal(listWip(s).length, WIP_MAX_SLOTS);
    // The very oldest must have been evicted.
    assert.equal(loadWip(s, 'm0'), null);
  });
});

describe('WIP store — corrupt / incompatible entries', () => {
  test('listWip skips unparseable entries', () => {
    const s = makeStorage();
    saveWip(s, mission('good'), { savedAt: 1 });
    s.setItem(`${WIP_KEY_PREFIX}broken`, '{not json');
    const all = listWip(s);
    assert.deepEqual(all.map(e => e.id), ['good']);
  });

  test('listWip skips schema-incompatible drafts', () => {
    const s = makeStorage();
    s.setItem(`${WIP_KEY_PREFIX}future`, JSON.stringify({
      id: 'future', name: 'Future', savedAt: 9, mission: { schema: 99, id: 'future' },
    }));
    assert.equal(listWip(s).length, 0);
    assert.equal(loadWip(s, 'future'), null);
  });

  test('listWip skips entries with no mission object', () => {
    const s = makeStorage();
    s.setItem(`${WIP_KEY_PREFIX}empty`, JSON.stringify({ id: 'empty', savedAt: 1 }));
    assert.equal(listWip(s).length, 0);
  });

  test('evictWip purges corrupt entries even under cap', () => {
    const s = makeStorage();
    saveWip(s, mission('keep'), { savedAt: 1 });
    s.setItem(`${WIP_KEY_PREFIX}junk`, 'xxx');
    evictWip(s, WIP_MAX_SLOTS);
    assert.equal(s.getItem(`${WIP_KEY_PREFIX}junk`), null, 'corrupt slot purged');
    assert.ok(loadWip(s, 'keep'), 'good slot retained');
  });
});

describe('WIP store — defensive guards', () => {
  test('helpers tolerate a null storage', () => {
    assert.equal(saveWip(null, mission()), null);
    assert.deepEqual(listWip(null), []);
    assert.equal(loadWip(null, 'x'), null);
    assert.doesNotThrow(() => { removeWip(null, 'x'); evictWip(null); });
  });

  test('saveWip returns null when the write throws (quota)', () => {
    const s = makeStorage();
    s.setItem = () => { throw new Error('QuotaExceededError'); };
    assert.equal(saveWip(s, mission()), null);
  });
});

describe('controller markDirty — captures in-place form edits', () => {
  test('markDirty flips isDirty without a render', () => {
    let renders = 0;
    const ed = createMissionEditor({ render: () => { renders++; } });
    assert.equal(ed.isDirty(), false, 'fresh editor is clean');
    // Forms mutate getMeta()'s object directly (no emit), so isDirty stays false
    // until the UI marks it explicitly on the bubbling change event.
    ed.getMeta().title = 'Edited In Place';
    assert.equal(ed.isDirty(), false);
    ed.markDirty();
    assert.equal(ed.isDirty(), true);
    assert.equal(renders, 0, 'markDirty does not trigger render');
    // The dirtied meta is what assemble() (and thus autosave) would persist.
    assert.equal(ed.assemble().title, 'Edited In Place');
  });
});

// ── formatWipTime ───────────────────────────────────────────────────────────
describe('formatWipTime', () => {
  const now = 1_000_000_000_000;
  test('buckets recency into just-now / m / h / d', () => {
    assert.equal(formatWipTime(now, now), 'just now');
    assert.equal(formatWipTime(now - 5 * 60_000, now), '5m ago');
    assert.equal(formatWipTime(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(formatWipTime(now - 2 * 86_400_000, now), '2d ago');
  });
  test('empty/invalid timestamps render empty', () => {
    assert.equal(formatWipTime(0), '');
    assert.equal(formatWipTime(undefined), '');
  });
});

// ── Launch picker (fake DOM) ──────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tag, children: [], parent: null,
    style: {}, dataset: {}, _listeners: {},
    className: '', title: '', textContent: '', type: '', accept: '', files: null,
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
  };
  return el;
}
function makeDoc() {
  return { createElement: () => makeEl('div'), getElementById: () => null, body: makeEl('body') };
}

describe('buildLaunchPicker', () => {
  const entries = [
    { id: 'a', name: 'Alpha', savedAt: 2 },
    { id: 'b', name: 'Beta', savedAt: 1 },
  ];

  test('renders one row per draft with name + time', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    const now = 3 * 60_000; // so savedAt:2/1 render as "2m/3m ago"-ish (non-empty)
    buildLaunchPicker(doc, { entries: entries.map(e => ({ ...e, savedAt: now - 60_000 })), container: host, onPick: () => {} });
    const rows = host.findAll('e-launch-row');
    assert.equal(rows.length, 2);
    assert.equal(host.findAll('e-launch-name')[0].textContent, 'Alpha');
    assert.ok(host.findAll('e-launch-time')[0].textContent.length > 0);
  });

  test('clicking a row calls onPick(id) and closes', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    let picked = null;
    buildLaunchPicker(doc, { entries, container: host, onPick: (id) => { picked = id; } });
    const rows = host.findAll('e-launch-row');
    rows[1].click();
    assert.equal(picked, 'b');
    assert.equal(host.findAll('e-launch-row').length, 0, 'overlay removed on pick');
  });

  test('[+] New and Load-from-disk fire their callbacks and close', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    let newed = false; let disked = false;
    buildLaunchPicker(doc, { entries, container: host, onNew: () => { newed = true; }, onLoadDisk: () => { disked = true; } });
    const actions = host.findAll('e-action');
    assert.equal(actions.length, 2);
    actions[0].click(); // ＋ New
    assert.equal(newed, true);
    assert.equal(host.children.length, 0, 'overlay removed on New');

    const host2 = makeEl('div');
    buildLaunchPicker(doc, { entries, container: host2, onLoadDisk: () => { disked = true; } });
    host2.findAll('e-action')[1].click(); // Load from disk
    assert.equal(disked, true);
  });

  test('empty draft list shows a hint and no rows', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    buildLaunchPicker(doc, { entries: [], container: host });
    assert.equal(host.findAll('e-launch-row').length, 0);
    assert.equal(host.findAll('e-launch-empty').length, 1);
  });

  test('backdrop click dismisses the overlay', () => {
    const doc = makeDoc();
    const host = makeEl('div');
    const { overlay } = buildLaunchPicker(doc, { entries, container: host });
    overlay.click(overlay); // target === overlay → close
    assert.equal(host.children.length, 0);
  });
});
