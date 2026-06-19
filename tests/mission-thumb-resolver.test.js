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

import {
  missionThumb, saveThumb, loadThumb, deleteThumb, campaignMissionRowId,
} from '../src/menu/thumbnails.js';
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

describe('campaignMissionRowId — canonical save key', () => {
  test('builds <campaignId>/slot<N>/<missionId>', () => {
    assert.equal(
      campaignMissionRowId('calebs_hollow_prologue', 1, 'first_night'),
      'calebs_hollow_prologue/slot1/first_night');
    assert.equal(
      campaignMissionRowId('calebs_hollow_prologue', 2, 'first_night'),
      'calebs_hollow_prologue/slot2/first_night');
  });

  test('null when the campaign id is missing (no row id to key on)', () => {
    assert.equal(campaignMissionRowId(null, 1, 'first_night'), null);
    assert.equal(campaignMissionRowId(undefined, 1, 'first_night'), null);
  });

  test('key matches what the menu card / briefing read', () => {
    // The card builder and briefing resolve their image with this exact key —
    // so the writer (round-end capture), readers, and the loss-reset all agree.
    const rowId = campaignMissionRowId('calebs_hollow_prologue', 1, 'first_night');
    assert.equal(rowId, 'calebs_hollow_prologue/slot1/first_night');
  });
});

// On mission FAILURE the failed run's last-round snapshot must NOT linger on the
// card. `_handleCampaignMissionEnd` (main.js) deletes the saved thumb on a loss
// so `missionThumb` reverts to the fixed pre-generated image. A WIN leaves the
// saved thumb untouched. These tests reproduce that loss/win branching against
// the shared key + thumbnail store (DOM-free — the handler itself is in main.js,
// but the load-bearing behaviour is exactly this delete-on-loss vs keep-on-win).
describe('mission failure resets the card thumbnail to the default', () => {
  beforeEach(() => localStorage.clear());

  const CAMPAIGN = 'calebs_hollow_prologue';
  const SLOT = 1;
  const MISSION = 'first_night';
  const rowId = campaignMissionRowId(CAMPAIGN, SLOT, MISSION);
  const FAILED_SNAPSHOT = 'data:image/jpeg;base64,FAILEDRUNSNAPSHOT';
  const FIXED = 'assets/mission-maps/Ch1M3.jpg';

  test('LOSS: deleting the saved thumb reverts the card to the fixed image', () => {
    // A failed attempt left its last-round snapshot saved under the row id.
    saveThumb(rowId, FAILED_SNAPSHOT);
    assert.equal(missionThumb(MISSION, rowId), FAILED_SNAPSHOT,
      'precondition: the stale failed snapshot is showing');

    // The loss branch of _handleCampaignMissionEnd does exactly this.
    deleteThumb(rowId);

    assert.equal(loadThumb(rowId), null, 'saved thumb is gone after a loss');
    assert.equal(missionThumb(MISSION, rowId), FIXED,
      'card falls back to the fixed pre-generated image');
  });

  test('WIN: the saved thumb is NOT deleted (a won mission is complete)', () => {
    // A won mission keeps whatever was saved — the win branch never deletes it.
    saveThumb(rowId, FAILED_SNAPSHOT);
    // (no deleteThumb on a win)
    assert.equal(loadThumb(rowId), FAILED_SNAPSHOT, 'win leaves the saved thumb in place');
    assert.equal(missionThumb(MISSION, rowId), FAILED_SNAPSHOT,
      'a win does not revert the card to the fixed image');
  });

  test('LOSS reset is row-id specific — only this mission/slot is cleared', () => {
    const otherRow = campaignMissionRowId(CAMPAIGN, 2, MISSION); // a different slot
    saveThumb(rowId, FAILED_SNAPSHOT);
    saveThumb(otherRow, 'data:image/jpeg;base64,OTHERSLOT');

    deleteThumb(rowId); // lose the slot-1 mission

    assert.equal(loadThumb(rowId), null, 'failed slot-1 thumb cleared');
    assert.equal(loadThumb(otherRow), 'data:image/jpeg;base64,OTHERSLOT',
      'slot-2 thumb untouched');
  });
});
