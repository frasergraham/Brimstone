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
} from '../src/campaign/continue-resolver.js';
import {
  Campaign, setActiveSlot,
} from '../src/campaign/campaign.js';
import {
  campaignMissionSaveKey,
} from '../src/campaign/campaign-ui.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';

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

// Helper: drop a fake mid-mission save for a mission in a slot.
function writeMissionSave(missionId, slot) {
  localStorage.setItem(
    campaignMissionSaveKey(hollowDef.id, missionId, slot),
    JSON.stringify({ updatedAt: Date.now() }));
}

describe('campaignMissionNumber', () => {
  test('returns the 1-based campaign position', () => {
    assert.equal(campaignMissionNumber(hollowDef, FIRST), 1);
    assert.equal(campaignMissionNumber(hollowDef, 'prologue'), 2);
    assert.equal(campaignMissionNumber(hollowDef, 'gathering_survivors'), 3);
  });
  test('returns null for a mission not in the campaign', () => {
    assert.equal(campaignMissionNumber(hollowDef, 'nope'), null);
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
    assert.equal(t.missionNumber, 2);
    assert.equal(t.missionTotal, hollowDef.missions.length);
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
    assert.equal(t.missionNumber, 3);
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
