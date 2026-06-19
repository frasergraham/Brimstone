// Tests for the campaign mission map-image resolver.
//
// A campaign mission card shows a board image exactly like a skirmish card:
//   • IN PROGRESS  → the live saved thumbnail (captured at round-end, keyed by
//                    its row id `<campaignId>/slot<N>/<missionId>` in localStorage)
//   • NOT STARTED  → the mission's fixed pre-generated map image (a committed
//                    static asset under assets/mission-maps/)
//   • UNKNOWN id   → still a deterministic asset path (never null)
//
// The resolver (`missionThumb`) and its fixed-image lookup (`fixedMissionImage`,
// keyed by the mission's stable on-disk file basename) are DOM-free so they can
// be unit-tested without the renderer or the full app.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── localStorage mock for Node (thumbnails.js reads/writes it) ────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

import { missionThumb, saveThumb, loadThumb } from '../src/menu/thumbnails.js';
import {
  fixedMissionImage, missionMapImageName, MIGRATED_MISSIONS,
} from '../src/campaign/mission-catalog.js';

describe('fixedMissionImage — fixed mission map image path', () => {
  test('maps a mission id to assets/mission-maps/<file>.jpg', () => {
    // first_night → Ch1M3 on disk
    assert.equal(fixedMissionImage('first_night'), 'assets/mission-maps/Ch1M3.jpg');
  });

  test('keys by the stable file basename, not the mission id', () => {
    for (const m of MIGRATED_MISSIONS) {
      assert.equal(missionMapImageName(m.id), m.file,
        `${m.id} image must be keyed by its file basename ${m.file}`);
      assert.equal(fixedMissionImage(m.id), `assets/mission-maps/${m.file}.jpg`);
    }
  });

  test('falls back to <id>.jpg for an unknown mission', () => {
    assert.equal(fixedMissionImage('brand_new_mission'),
      'assets/mission-maps/brand_new_mission.jpg');
  });
});

describe('missionThumb — in-progress vs not-started resolution', () => {
  beforeEach(() => localStorage.clear());

  test('not-started mission → the fixed pre-generated image', () => {
    const rowId = 'calebs_hollow_prologue/slot1/first_night';
    assert.equal(missionThumb('first_night', rowId),
      'assets/mission-maps/Ch1M3.jpg',
      'no saved thumb yet ⇒ fixed image');
  });

  test('in-progress mission → its live saved thumbnail (over the fixed image)', () => {
    const rowId = 'calebs_hollow_prologue/slot1/first_night';
    const dataUrl = 'data:image/jpeg;base64,SAVEDTHUMB';
    saveThumb(rowId, dataUrl);
    // sanity: the thumb is keyed exactly by the row id
    assert.equal(loadThumb(rowId), dataUrl);
    assert.equal(missionThumb('first_night', rowId), dataUrl,
      'a saved thumb wins over the fixed image');
  });

  test('saved thumb is row-id specific — a different slot still shows the fixed image', () => {
    saveThumb('calebs_hollow_prologue/slot1/first_night', 'data:image/jpeg;base64,SLOT1');
    // Slot 2 of the same mission has no save → fixed image.
    assert.equal(
      missionThumb('first_night', 'calebs_hollow_prologue/slot2/first_night'),
      'assets/mission-maps/Ch1M3.jpg');
  });

  test('unknown mission with no save → graceful deterministic fallback (never null)', () => {
    const out = missionThumb('mystery_mission', 'some/row/id');
    assert.equal(out, 'assets/mission-maps/mystery_mission.jpg');
    assert.ok(out, 'resolver never returns null/undefined');
  });

  test('missing rowId still resolves to the fixed image', () => {
    assert.equal(missionThumb('first_night', null), 'assets/mission-maps/Ch1M3.jpg');
    assert.equal(missionThumb('first_night', undefined), 'assets/mission-maps/Ch1M3.jpg');
  });
});
