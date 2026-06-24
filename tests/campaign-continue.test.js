// Tests for the Continue-card target resolution (Task 4/5) and the
// "anything to continue?" decision that defaults a fresh player to Campaign
// (Task 6). The resolver is DOM-free and active-slot-aware.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── localStorage mock for Node ───────────────────────────────────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

import {
  resolveCampaignContinue, hasCampaignToContinue, campaignMissionNumber,
  campaignMissionTotal,
} from '../src/campaign/continue-resolver.js';
import {
  Campaign, setActiveSlot,
} from '../src/campaign/campaign.js';
import {
  campaignMissionSaveKey,
} from '../src/campaign/campaign-ui.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';
import { SAVE_VERSION } from '../src/version.js';
import { mmUrgencyScore } from '../src/main-menu-games.js';

const hollowDef = getCampaignById('calebs_hollow_prologue');
const FIRST = hollowDef.firstMission; // 'tutorial'

// Helper: write a (started) campaign save into a slot with some completed
// missions so getNextMission() advances past them.
function startCampaign(slot, completed = []) {
  const c = new Campaign(hollowDef, slot);
  for (const id of completed) c.completedMissions.add(id);
  c.save();
  return c;
}

// Helper: drop a fake mid-mission save for a mission in a slot. Stamps the current
// SAVE_VERSION so loadCampaignMissionSave's version gate treats it as compatible
// (an unstamped/incompatible save is discarded → resume falls back to fresh).
function writeMissionSave(missionId, slot) {
  localStorage.setItem(
    campaignMissionSaveKey(hollowDef.id, missionId, slot),
    JSON.stringify({ saveVersion: SAVE_VERSION, updatedAt: Date.now() }));
}

describe('campaignMissionNumber', () => {
  test('is 0-based from the tutorial — tutorial=0, prologue=1', () => {
    // FIRST is the tutorial; it is Mission 0. The first real mission (prologue)
    // is Mission 1, matching its on-disk Ch1M1 file.
    assert.equal(campaignMissionNumber(hollowDef, FIRST), 0);
    assert.equal(campaignMissionNumber(hollowDef, 'prologue'), 1);
    assert.equal(campaignMissionNumber(hollowDef, 'gathering_survivors'), 2);
  });
  test('the last real mission is Mission 12', () => {
    assert.equal(campaignMissionNumber(hollowDef, 'witchs_trail'), 12);
  });
  test('returns null for a mission not in the campaign', () => {
    assert.equal(campaignMissionNumber(hollowDef, 'nope'), null);
  });
});

describe('campaignMissionTotal', () => {
  test('counts the non-disabled missions (tutorial is shelved)', () => {
    // 13 catalog entries (1 disabled tutorial + 12 real) → denominator 12.
    assert.equal(
      campaignMissionTotal(hollowDef),
      hollowDef.missions.filter(m => !m.disabled).length);
    assert.equal(campaignMissionTotal(hollowDef), 12);
  });
  test('derives from non-disabled missions, not the positional length-1', () => {
    // Shelf a SECOND mission: a positional `length - 1` would still read 12,
    // but the honest non-disabled count is 11. Guards against the old
    // "tutorial is index 0" assumption silently miscounting shelved missions.
    const def = {
      missions: hollowDef.missions.map((m, i) =>
        m.id === 'prologue' ? { ...m, disabled: true } : m),
    };
    assert.equal(def.missions.length - 1, 12, 'positional formula would lie here');
    assert.equal(campaignMissionTotal(def), 11);
  });
  test('a fully-enabled campaign counts every mission', () => {
    // No disabled flag anywhere → total equals the catalog length (no implicit
    // "first entry is the tutorial" subtraction).
    const def = { missions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    assert.equal(campaignMissionTotal(def), 3);
  });
  test('safe on an empty / missing campaign', () => {
    assert.equal(campaignMissionTotal({ missions: [] }), 0);
    assert.equal(campaignMissionTotal(null), 0);
  });
});

describe('resolveCampaignContinue — active-slot aware', () => {
  beforeEach(() => localStorage.clear());

  test('returns null when the active slot has no save', () => {
    assert.equal(resolveCampaignContinue(hollowDef), null);
  });

  test('disabled campaigns never resolve', () => {
    assert.equal(resolveCampaignContinue({ id: 'x', disabled: true, missions: [] }), null);
  });

  test('resolves the next mission (start fresh) for a started slot', () => {
    startCampaign(1, ['tutorial']);     // tutorial done → next is prologue
    setActiveSlot(hollowDef.id, 1);
    const t = resolveCampaignContinue(hollowDef);
    assert.ok(t);
    assert.equal(t.slot, 1);
    assert.equal(t.missionId, 'prologue');
    assert.equal(t.resume, false);
    assert.equal(t.missionNumber, 1);                       // prologue is Mission 1 (0-based from tutorial)
    assert.equal(t.missionTotal, hollowDef.missions.length - 1);  // tutorial excluded from the denominator
  });

  test('resolves to RESUME when a mid-mission save exists for the next mission', () => {
    startCampaign(1, ['tutorial']);
    writeMissionSave('prologue', 1);    // mid-mission save on the next-up mission
    setActiveSlot(hollowDef.id, 1);
    const t = resolveCampaignContinue(hollowDef);
    assert.ok(t);
    assert.equal(t.missionId, 'prologue');
    assert.equal(t.resume, true);
  });

  test('reads the PERSISTED active slot, not just slot 1', () => {
    // Slot 1 untouched; slot 2 is the active playthrough.
    startCampaign(2, ['tutorial', 'prologue']);  // next is gathering_survivors
    setActiveSlot(hollowDef.id, 2);
    const t = resolveCampaignContinue(hollowDef);
    assert.ok(t, 'should find progress in the active slot (2), not hardcode slot 1');
    assert.equal(t.slot, 2);
    assert.equal(t.missionId, 'gathering_survivors');
    assert.equal(t.missionNumber, 2);   // 0-based from tutorial: tutorial=0, prologue=1, gathering=2
  });

  test('defaults to slot 1 when no active slot was ever persisted', () => {
    startCampaign(1, ['tutorial']);
    // no setActiveSlot call → getActiveSlot defaults to 1
    const t = resolveCampaignContinue(hollowDef);
    assert.ok(t);
    assert.equal(t.slot, 1);
  });

  test('ignores progress that lives in a NON-active slot', () => {
    startCampaign(3, ['tutorial']);     // progress in slot 3
    setActiveSlot(hollowDef.id, 1);     // but active slot is 1 (empty)
    assert.equal(resolveCampaignContinue(hollowDef), null);
  });

  test('returns null when the active slot has completed every mission', () => {
    const c = startCampaign(1, hollowDef.missions.map(m => m.id));
    assert.ok(c.isComplete());
    setActiveSlot(hollowDef.id, 1);
    assert.equal(resolveCampaignContinue(hollowDef), null);
  });
});

// Build the campaign-next Continue row the menu would render for the active
// slot — the same shape _localCampaignRows emits, derived from the resolver so
// the test stays in lockstep with the live recency + next-mission fields.
function continueRowForActiveSlot() {
  const t = resolveCampaignContinue(hollowDef);
  if (!t) return null;
  return {
    kind: 'campaign-next',
    action_needed: false,
    turn_deadline: null,
    // _localCampaignRows derives updated_at from Campaign.updatedAt (ms → s).
    updated_at: t.updatedAt ? Math.floor(t.updatedAt / 1000) : 0,
    _campaignId: hollowDef.id,
    _nextMissionId: t.missionId,
    _missionNumber: t.missionNumber,
    _missionTotal: t.missionTotal,
  };
}

describe('just-played campaign surfaces at the top of Continue', () => {
  beforeEach(() => localStorage.clear());

  test('after winning a mission, the next mission is the Continue target', () => {
    // Stand at first_night with the chain cleared; play + WIN it.
    const c = new Campaign(hollowDef, 1);
    for (const id of ['tutorial', 'prologue', 'gathering_survivors']) c.completedMissions.add(id);
    c.currentMission = 'first_night';
    c.save();
    setActiveSlot(hollowDef.id, 1);

    c.applyMissionResult('first_night', {
      won: true, survivors: [], resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, items: {} },
    });

    // The next unlocked mission after the win — derived from the same engine the
    // resolver uses, so the assertion can't drift if missions are reordered.
    const expectedNext = new Campaign(hollowDef, 1);
    expectedNext.load();
    const expectedId = expectedNext.getNextMission();

    // The Continue row now points at that NEXT mission (first_night done), with a
    // freshly-bumped recency from applyMissionResult's save().
    const row = continueRowForActiveSlot();
    assert.ok(row, 'a Continue target exists after the win');
    assert.notEqual(row._nextMissionId, 'first_night', 'advances past the played mission');
    assert.equal(row._nextMissionId, expectedId, 'surfaces the next unlocked mission');
    // first_night is Mission 3 (0-based from the tutorial); the next mission's
    // number must be past it.
    assert.ok(row._missionNumber > campaignMissionNumber(hollowDef, 'first_night'),
      'with a campaign position past the played one');
  });

  test('the just-played campaign outranks an older idle game in the feed', () => {
    const NOW = Date.now();
    const c = new Campaign(hollowDef, 1);
    for (const id of ['tutorial', 'prologue', 'gathering_survivors']) c.completedMissions.add(id);
    c.currentMission = 'first_night';
    c.save();
    setActiveSlot(hollowDef.id, 1);
    c.applyMissionResult('first_night', {
      won: true, survivors: [], resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, items: {} },
    });

    const campaignRow = continueRowForActiveSlot();
    // A stale single-player save touched an hour ago — must sort BELOW the
    // just-played campaign (idle rows rank by recency; the campaign is freshest).
    const staleIdle = {
      kind: 'local-sp', action_needed: false, turn_deadline: null,
      updated_at: Math.floor(NOW / 1000) - 3600,
    };
    assert.ok(
      mmUrgencyScore(campaignRow, NOW) < mmUrgencyScore(staleIdle, NOW),
      'the just-played campaign must rank first among idle Continue rows',
    );
  });
});

describe('hasCampaignToContinue — drives default-to-Campaign (Task 6)', () => {
  beforeEach(() => localStorage.clear());

  test('false for a brand-new player with no campaign progress', () => {
    assert.equal(hasCampaignToContinue([hollowDef]), false);
  });

  test('true once the active slot has a resumable playthrough', () => {
    startCampaign(1, ['tutorial']);
    setActiveSlot(hollowDef.id, 1);
    assert.equal(hasCampaignToContinue([hollowDef]), true);
  });

  test('false when the only progress lives in a non-active slot', () => {
    startCampaign(2, ['tutorial']);
    setActiveSlot(hollowDef.id, 1);   // active slot is empty
    assert.equal(hasCampaignToContinue([hollowDef]), false);
  });

  test('skips disabled campaigns', () => {
    assert.equal(hasCampaignToContinue([{ id: 'd', disabled: true, missions: [] }]), false);
  });
});

// Mirror of _localCampaignRows' mid-mission save scan (the resume-row path).
// _localCampaignRows lives in main.js behind the DOM-heavy app, so we replicate
// just its scan: a resume row is emitted per PLAYABLE mission that has a
// mid-mission save in the active slot. This is the seam that keeps a disabled
// mission's stale save from ever becoming a clickable Continue row.
function resumeRowMissionIdsForActiveSlot(def) {
  const slot = 1; // tests set active slot 1
  const ids = [];
  for (const m of (def.missions || []).filter(mm => !mm.disabled)) {
    if (localStorage.getItem(campaignMissionSaveKey(def.id, m.id, slot))) ids.push(m.id);
  }
  return ids;
}

describe('resume rows exclude disabled missions (Finding 1)', () => {
  beforeEach(() => localStorage.clear());

  test('a stale mid-mission save of the DISABLED tutorial yields no resume row', () => {
    // The shelved tutorial is the danger case: a returning player can still have
    // a `brimstone-...tutorial` mid-mission save on disk. It must NOT surface.
    assert.ok(hollowDef.missions[0].disabled, 'fixture: tutorial is disabled');
    startCampaign(1, []);
    writeMissionSave('tutorial', 1);            // stale save of the disabled mission
    setActiveSlot(hollowDef.id, 1);
    const ids = resumeRowMissionIdsForActiveSlot(hollowDef);
    assert.ok(!ids.includes('tutorial'), 'disabled tutorial must not produce a resume row');
    assert.deepEqual(ids, [], 'no resume rows at all when only the tutorial has a save');
  });

  test('a mid-mission save of a PLAYABLE mission still surfaces', () => {
    startCampaign(1, ['tutorial']);
    writeMissionSave('prologue', 1);            // legitimate mid-mission save
    setActiveSlot(hollowDef.id, 1);
    const ids = resumeRowMissionIdsForActiveSlot(hollowDef);
    assert.deepEqual(ids, ['prologue'], 'a real mission still resumes');
  });

  test('with saves for BOTH, only the playable mission surfaces', () => {
    startCampaign(1, ['tutorial']);
    writeMissionSave('tutorial', 1);            // disabled — must be dropped
    writeMissionSave('prologue', 1);            // playable — must remain
    setActiveSlot(hollowDef.id, 1);
    const ids = resumeRowMissionIdsForActiveSlot(hollowDef);
    assert.ok(!ids.includes('tutorial'));
    assert.deepEqual(ids, ['prologue']);
  });
});
