// ═══════════════════════════════════════════════════════════════════════════
// Mission-catalog tests — the shared source for the Mission Editor's
// File ▸ "Load existing mission…" picker (src/campaign/mission-catalog.js).
//
// The picker lists exactly the bundled missions under src/campaign/missions/
// and, on selection, fetches <id>.json and routes the RAW parsed object through
// the same validate→populate path as the external file picker. These tests pin:
//
//   1. SOURCE OF TRUTH — the catalog's ids match the actual JSON files on disk
//      (no missing / no extra), so the picker can't drift from what ships.
//   2. DISPLAY TITLES — each catalog title matches its JSON's top-level `title`.
//   3. URL RESOLUTION — missionJSONUrl(id) resolves to src/campaign/missions/
//      <id>.json (the same location campaign-registry.js loads from).
//   4. CONVERGENCE — the bytes fetched from that URL validate + populate via the
//      identical loadMissionJSON → populateFromMission path the file picker uses.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MIGRATED_MISSIONS, missionJSONUrl } from '../src/campaign/mission-catalog.js';
import { loadMissionJSON } from '../src/campaign/json-mission.js';
import { populateFromMission } from '../src/tools/mission-editor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSIONS_DIR = path.join(__dirname, '..', 'src', 'campaign', 'missions');

const readMission = (id) =>
  JSON.parse(readFileSync(path.join(MISSIONS_DIR, `${id}.json`), 'utf8'));

describe('mission-catalog — picker source of truth', () => {
  test('catalog ids match exactly the JSON files in missions/', () => {
    const onDisk = readdirSync(MISSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    const catalog = MIGRATED_MISSIONS.map((m) => m.id).sort();
    assert.deepEqual(catalog, onDisk,
      'picker options must match the shipped mission set (no missing / no extra)');
  });

  test('every entry carries id, campaignId and a non-empty title', () => {
    for (const m of MIGRATED_MISSIONS) {
      assert.ok(m.id, 'id present');
      assert.ok(m.campaignId, `campaignId present for ${m.id}`);
      assert.ok(m.title && m.title.length > 0, `title present for ${m.id}`);
    }
  });

  test('catalog titles stay in sync with each JSON top-level title', () => {
    for (const { id, title } of MIGRATED_MISSIONS) {
      assert.equal(title, readMission(id).title,
        `catalog title for "${id}" must match the JSON's title (drift guard)`);
    }
  });
});

describe('mission-catalog — URL resolution', () => {
  test('missionJSONUrl resolves to src/campaign/missions/<id>.json', () => {
    for (const { id } of MIGRATED_MISSIONS) {
      const url = missionJSONUrl(id);
      assert.ok(url.endsWith(`/src/campaign/missions/${id}.json`),
        `resolved URL must point at the bundled mission file: got ${url}`);
    }
  });
});

describe('mission-catalog — load converges on the file-picker populate path', () => {
  // loadMissionById fetches missionJSONUrl(id), then routes the RAW parsed JSON
  // through loadMissionJSON (validate) → populateFromMission, identical to the
  // file picker. Here we read the file the URL points at (fetch stand-in) and
  // run that exact path, asserting it yields a usable editor model per mission.
  for (const { id } of MIGRATED_MISSIONS) {
    test(`"${id}" validates and populates an editor model`, () => {
      const url = missionJSONUrl(id);
      const file = path.join(MISSIONS_DIR, path.basename(new URL(url).pathname));
      const parsed = JSON.parse(readFileSync(file, 'utf8'));

      assert.doesNotThrow(() => loadMissionJSON(parsed), 'raw JSON validates');

      const model = populateFromMission(parsed);
      assert.equal(model.meta.id, id, 'populated meta keeps the mission id');
      assert.ok(model.mapDef, 'populated model has a mapDef');
      assert.ok(Array.isArray(model.enemyUnits), 'populated model has enemyUnits[]');
      // meta must stay serialisable (no fns leaking in) so re-download is faithful.
      for (const [k, v] of Object.entries(model.meta)) {
        assert.notEqual(typeof v, 'function', `meta.${k} must not be a function`);
      }
    });
  }
});
