// Tests for campaign mid-mission resume correctness:
//   (A) the Begin Mission "Deploying" strip on a RESUME must reflect the SAVED
//       snapshot's party (the units actually on the board), not the fresh deploy
//       set resolveDeployIndices would pick. buildSavedPartyPreview maps the
//       snapshot's hero-faction entities into the same display shape.
//   (B) loadCampaignMissionSave must version-gate the save: a snapshot from an
//       incompatible build is discarded (deleted + null) so resume falls back to
//       a fresh start; a compatible (incl. older-but-same-build-line) save loads.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSavedPartyPreview,
  loadCampaignMissionSave,
  campaignMissionSaveKey,
} from '../src/campaign/campaign-ui.js';
import { VERSION, SAVE_VERSION } from '../src/version.js';

// ── localStorage mock for Node ───────────────────────────────────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const CID = 'calebs_hollow_prologue';
const MID = 'first_night';

/** A minimal serializeState()-shaped snapshot with the given player-faction units.
 *  Mirrors the relevant fields of server/state-sync.js serializeState(). */
function _snapshot(entities, { saveVersion = SAVE_VERSION, version = VERSION } = {}) {
  return {
    saveVersion,
    state: { version, entities },
  };
}

/** A serialized hero-faction entity (owner 'hero'). */
function _ent(type, over = {}) {
  return {
    type, owner: 'hero', isNpc: false,
    hp: 10, maxHp: 10, level: 1, name: null, title: null,
    ...over,
  };
}

// ── (A) buildSavedPartyPreview: snapshot → preview ───────────────────────────
describe('buildSavedPartyPreview (resume strip sources the saved snapshot)', () => {
  test('maps the snapshot hero-faction party, hero first', () => {
    const preview = buildSavedPartyPreview({
      entities: [
        _ent('survivor', { name: 'Annie', title: 'Nurse', level: 3 }),
        _ent('paladin', { name: 'Ishmael Charger', level: 5 }),
        _ent('survivor', { name: 'Cole', title: 'Blacksmith' }),
      ],
    });
    assert.equal(preview.length, 3, 'hero + two survivors');
    assert.equal(preview[0].isHero, true, 'the leader is emitted first');
    assert.equal(preview[0].name, 'Ishmael Charger');
    assert.equal(preview[0].assetId, 'paladin', 'leader type IS its asset id');
    assert.equal(preview[0].level, 5);
    const followers = preview.slice(1);
    assert.deepEqual(followers.map(u => u.name), ['Annie', 'Cole'], 'followers in snapshot order');
    assert.equal(followers[0].isHero, false);
    assert.equal(followers[0].assetId, 'survivor_nurse', 'survivor assetId from title');
    assert.equal(followers[0].level, 3, 'the saved (possibly leveled) value surfaces');
  });

  test('excludes NPCs, witch-side units, and the dead', () => {
    const preview = buildSavedPartyPreview({
      entities: [
        _ent('paladin', { name: 'Hero' }),
        _ent('survivor', { name: 'Ghost NPC', isNpc: true }),     // scripted NPC — excluded
        _ent('survivor', { name: 'Fallen', hp: 0 }),               // dead — excluded
        { type: 'witch', owner: 'witch', hp: 20, maxHp: 20 },      // enemy — excluded
        _ent('survivor', { name: 'Liv', title: 'Herbalist' }),
      ],
    });
    assert.deepEqual(preview.map(u => u.name), ['Hero', 'Liv'],
      'only living, non-NPC, hero-faction units');
  });

  test('the RESUME preview can diverge from a fresh-deploy preview (the bug being fixed)', () => {
    // Fresh deploy would front-fill the chosen roster; the SAVED party here is a
    // single surviving survivor + the hero (e.g. the rest fell mid-mission). The
    // snapshot preview must show exactly that, NOT a fuller fresh squad.
    const preview = buildSavedPartyPreview({
      entities: [
        _ent('paladin', { name: 'Ishmael Charger', hp: 40, maxHp: 98, level: 4 }),
        _ent('survivor', { name: 'Lone Survivor', title: 'Baker', hp: 3, maxHp: 12 }),
      ],
    });
    assert.equal(preview.length, 2, 'exactly the two units left on the board');
    assert.equal(preview[1].hp, 3, 'the saved (damaged) HP surfaces, not a fresh full bar');
  });

  test('empty / malformed snapshot yields an empty list (caller falls back)', () => {
    assert.deepEqual(buildSavedPartyPreview(null), []);
    assert.deepEqual(buildSavedPartyPreview({}), []);
    assert.deepEqual(buildSavedPartyPreview({ entities: [] }), []);
  });
});

// ── (B) loadCampaignMissionSave: version gate ────────────────────────────────
describe('loadCampaignMissionSave version gate', () => {
  beforeEach(() => localStorage.clear());

  const _write = (save) =>
    localStorage.setItem(campaignMissionSaveKey(CID, MID, 1), JSON.stringify(save));

  test('a current-build save loads', () => {
    _write(_snapshot([_ent('paladin', { name: 'Hero' })]));
    const loaded = loadCampaignMissionSave(CID, MID, 1);
    assert.ok(loaded, 'the compatible save loads');
    assert.equal(loaded.saveVersion, SAVE_VERSION);
  });

  test('an incompatible saveVersion is discarded (deleted + null)', () => {
    _write(_snapshot([_ent('paladin')], { saveVersion: SAVE_VERSION + 1 }));
    const loaded = loadCampaignMissionSave(CID, MID, 1);
    assert.equal(loaded, null, 'a future/incompatible schema is refused');
    assert.equal(localStorage.getItem(campaignMissionSaveKey(CID, MID, 1)), null,
      'the stale save is deleted so it stops resurfacing → fresh start');
  });

  test('an OLDER saveVersion is also discarded (no migration path for snapshots)', () => {
    _write(_snapshot([_ent('paladin')], { saveVersion: SAVE_VERSION - 1 }));
    assert.equal(loadCampaignMissionSave(CID, MID, 1), null,
      'an older snapshot schema is discarded — exact-equality rule, no migration');
  });

  test('a LEGACY save (no saveVersion) loads when its snapshot semver matches the build line', () => {
    // Pre-gate saves carry no wrapper saveVersion but the snapshot stamps `version`.
    _write({ state: { version: VERSION, entities: [_ent('paladin', { name: 'Hero' })] } });
    const loaded = loadCampaignMissionSave(CID, MID, 1);
    assert.ok(loaded, 'a structurally-compatible legacy save still loads (conservative)');
  });

  test('a LEGACY save from a different major.minor build is discarded', () => {
    const [maj, min] = String(VERSION).split('.');
    const stale = `${maj}.${Number(min) + 1}.0`;     // a different build line
    _write({ state: { version: stale, entities: [_ent('paladin')] } });
    assert.equal(loadCampaignMissionSave(CID, MID, 1), null,
      'a legacy save from an incompatible build line is discarded');
    assert.equal(localStorage.getItem(campaignMissionSaveKey(CID, MID, 1)), null);
  });

  test('a save with no version info at all is discarded (cannot be trusted)', () => {
    _write({ state: { entities: [_ent('paladin')] } });
    assert.equal(loadCampaignMissionSave(CID, MID, 1), null);
  });

  test('returns null (no throw) for an absent or corrupt save', () => {
    assert.equal(loadCampaignMissionSave(CID, MID, 1), null, 'absent → null');
    localStorage.setItem(campaignMissionSaveKey(CID, MID, 1), '{not json');
    assert.equal(loadCampaignMissionSave(CID, MID, 1), null, 'corrupt JSON → null, no throw');
  });
});
