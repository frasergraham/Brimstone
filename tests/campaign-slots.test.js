// Tests for multi-save campaign slots: slot-key derivation, multi-slot
// independence, legacy→slot-1 migration (progress AND mid-mission), and the
// picker/menu summary helpers.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Campaign, CAMPAIGN_SLOT_COUNT, clampSlotIndex,
  campaignSlotSaveSlot, legacyCampaignSaveSlot,
} from '../src/campaign/campaign.js';
import {
  campaignMissionSaveKey, loadCampaignMissionSave, deleteCampaignMissionSave,
} from '../src/campaign/campaign-ui.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';

// ── localStorage mock for Node ───────────────────────────────────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const hollowDef = getCampaignById('calebs_hollow_prologue');

// ── Slot-key derivation ───────────────────────────────────────────────────────

describe('slot-key derivation', () => {
  test('clampSlotIndex coerces into 1..CAMPAIGN_SLOT_COUNT', () => {
    assert.equal(clampSlotIndex(1), 1);
    assert.equal(clampSlotIndex(CAMPAIGN_SLOT_COUNT), CAMPAIGN_SLOT_COUNT);
    assert.equal(clampSlotIndex(0), 1);
    assert.equal(clampSlotIndex(-5), 1);
    assert.equal(clampSlotIndex(999), CAMPAIGN_SLOT_COUNT);
    assert.equal(clampSlotIndex(undefined), 1);
    assert.equal(clampSlotIndex('2'), 2);
    assert.equal(clampSlotIndex(2.9), 2);
  });

  test('campaignSlotSaveSlot includes a slot suffix; legacy form is unsuffixed', () => {
    assert.equal(campaignSlotSaveSlot('foo', 1), 'campaign-foo-slot1');
    assert.equal(campaignSlotSaveSlot('foo', 3), 'campaign-foo-slot3');
    assert.equal(legacyCampaignSaveSlot('foo'), 'campaign-foo');
  });

  test('constructor clamps the slot index and derives the save slot', () => {
    assert.equal(new Campaign(hollowDef, 2).saveSlot, 'campaign-calebs_hollow_prologue-slot2');
    assert.equal(new Campaign(hollowDef, 99).slotIndex, CAMPAIGN_SLOT_COUNT);
    assert.equal(new Campaign(hollowDef).slotIndex, 1);
  });
});

// ── Multi-slot independence ───────────────────────────────────────────────────

describe('multi-slot independence', () => {
  beforeEach(() => localStorage.clear());

  test('progress in one slot does not leak into another', () => {
    const s1 = new Campaign(hollowDef, 1);
    s1.completedMissions.add('prologue');
    s1.resources.herbs = 7;
    s1.save();

    // A fresh slot 2 is untouched by slot 1's save.
    const s2 = new Campaign(hollowDef, 2);
    assert.equal(s2.load(), false);
    assert.equal(s2.completedMissions.size, 0);
    assert.equal(s2.resources.herbs, 0);

    // Slot 1 still reads back correctly.
    const s1b = new Campaign(hollowDef, 1);
    assert.ok(s1b.load());
    assert.ok(s1b.completedMissions.has('prologue'));
    assert.equal(s1b.resources.herbs, 7);
  });

  test('deleting one slot leaves the other intact', () => {
    new Campaign(hollowDef, 1).save();
    const s2 = new Campaign(hollowDef, 2);
    s2.completedMissions.add('prologue');
    s2.save();

    new Campaign(hollowDef, 1).delete();
    assert.equal(Campaign.exists(hollowDef, 1), false);
    assert.ok(Campaign.exists(hollowDef, 2));
  });
});

// ── Legacy → slot-1 migration (progress) ─────────────────────────────────────

describe('legacy → slot-1 migration (progress)', () => {
  beforeEach(() => localStorage.clear());

  function writeLegacy(extra = {}) {
    const data = {
      campaignId: hollowDef.id,
      version: 3,
      currentMission: 'first_night',
      completedMissions: ['prologue', 'gathering_survivors'],
      roster: [{ name: 'Old Save', hp: 3, maxHp: 3 }],
      resources: { herbs: 4 },
      heroStats: { hp: 50, maxHp: 98, attack: 2, defense: 2, weapon: 'sword', items: {} },
      storyFlags: {},
      updatedAt: 123456789,
      ...extra,
    };
    localStorage.setItem(`brimstone-${legacyCampaignSaveSlot(hollowDef.id)}`, JSON.stringify(data));
  }

  test('slot 1 adopts a legacy unsuffixed save on first load', () => {
    writeLegacy();
    const s1 = new Campaign(hollowDef, 1);
    assert.ok(s1.load());
    assert.ok(s1.completedMissions.has('prologue'));
    assert.ok(s1.completedMissions.has('gathering_survivors'));
    assert.equal(s1.roster[0].name, 'Old Save');
    // The slot-1 key now exists (copied in) and the legacy key is left in place.
    assert.ok(localStorage.getItem(`brimstone-${campaignSlotSaveSlot(hollowDef.id, 1)}`) !== null);
    assert.ok(localStorage.getItem(`brimstone-${legacyCampaignSaveSlot(hollowDef.id)}`) !== null);
  });

  test('migration is idempotent and one-shot', () => {
    writeLegacy();
    new Campaign(hollowDef, 1).load();
    // Mutate the legacy save after the first load — slot 1 must NOT re-adopt it.
    writeLegacy({ completedMissions: ['prologue', 'gathering_survivors', 'first_night', 'river_crossing'] });
    const s1 = new Campaign(hollowDef, 1);
    assert.ok(s1.load());
    assert.ok(!s1.completedMissions.has('river_crossing'), 'should keep the already-migrated slot-1 copy');
  });

  test('only slot 1 adopts the legacy save; other slots ignore it', () => {
    writeLegacy();
    const s2 = new Campaign(hollowDef, 2);
    assert.equal(s2.load(), false);
    assert.equal(s2.completedMissions.size, 0);
  });

  test('Start Over on slot 1 clears the legacy key so it cannot resurrect', () => {
    writeLegacy();
    const s1 = new Campaign(hollowDef, 1);
    s1.load();      // adopt
    s1.delete();    // Start Over
    assert.equal(localStorage.getItem(`brimstone-${campaignSlotSaveSlot(hollowDef.id, 1)}`), null);
    assert.equal(localStorage.getItem(`brimstone-${legacyCampaignSaveSlot(hollowDef.id)}`), null);
    assert.equal(new Campaign(hollowDef, 1).load(), false);
  });

  test('exists() covers a not-yet-migrated legacy save for slot 1 only', () => {
    writeLegacy();
    assert.ok(Campaign.exists(hollowDef, 1));
    assert.equal(Campaign.exists(hollowDef, 2), false);
  });
});

// ── Legacy → slot-1 migration (mid-mission) ──────────────────────────────────

describe('mid-mission save slots', () => {
  beforeEach(() => localStorage.clear());

  test('key is slot-suffixed', () => {
    assert.equal(campaignMissionSaveKey('camp', 'm1', 1), 'brimstone_campaign_mission_camp_slot1_m1');
    assert.equal(campaignMissionSaveKey('camp', 'm1', 2), 'brimstone_campaign_mission_camp_slot2_m1');
  });

  test('mid-mission saves are independent across slots', () => {
    localStorage.setItem(campaignMissionSaveKey('camp', 'm1', 1), JSON.stringify({ slotIndex: 1, round: 5 }));
    localStorage.setItem(campaignMissionSaveKey('camp', 'm1', 2), JSON.stringify({ slotIndex: 2, round: 9 }));
    assert.equal(loadCampaignMissionSave('camp', 'm1', 1).round, 5);
    assert.equal(loadCampaignMissionSave('camp', 'm1', 2).round, 9);
  });

  test('slot 1 reads through to a legacy unsuffixed mid-mission save', () => {
    localStorage.setItem('brimstone_campaign_mission_camp_m1', JSON.stringify({ round: 3 }));
    assert.equal(loadCampaignMissionSave('camp', 'm1', 1).round, 3);
    // Other slots do not see the legacy mid-mission save.
    assert.equal(loadCampaignMissionSave('camp', 'm1', 2), null);
  });

  test('slot-1 save takes precedence over the legacy key', () => {
    localStorage.setItem('brimstone_campaign_mission_camp_m1', JSON.stringify({ round: 3 }));
    localStorage.setItem(campaignMissionSaveKey('camp', 'm1', 1), JSON.stringify({ round: 8 }));
    assert.equal(loadCampaignMissionSave('camp', 'm1', 1).round, 8);
  });

  test('delete on slot 1 clears both the slot key and the legacy key', () => {
    localStorage.setItem('brimstone_campaign_mission_camp_m1', JSON.stringify({ round: 3 }));
    localStorage.setItem(campaignMissionSaveKey('camp', 'm1', 1), JSON.stringify({ round: 8 }));
    deleteCampaignMissionSave('camp', 'm1', 1);
    assert.equal(loadCampaignMissionSave('camp', 'm1', 1), null);
    assert.equal(localStorage.getItem('brimstone_campaign_mission_camp_m1'), null);
  });

  test('delete on slot 2 leaves the legacy key alone', () => {
    localStorage.setItem('brimstone_campaign_mission_camp_m1', JSON.stringify({ round: 3 }));
    localStorage.setItem(campaignMissionSaveKey('camp', 'm1', 2), JSON.stringify({ round: 9 }));
    deleteCampaignMissionSave('camp', 'm1', 2);
    assert.equal(loadCampaignMissionSave('camp', 'm1', 2), null);
    assert.equal(localStorage.getItem('brimstone_campaign_mission_camp_m1') !== null, true);
  });
});

// ── Picker / menu summaries ───────────────────────────────────────────────────

describe('getSlotSummary', () => {
  beforeEach(() => localStorage.clear());

  test('reports an empty slot as unused', () => {
    const info = Campaign.getSlotSummary(hollowDef, 2);
    assert.equal(info.used, false);
    assert.equal(info.slotIndex, 2);
    assert.equal(info.total, hollowDef.missions.length);
  });

  test('reports a used slot with the next mission to resume', () => {
    const c = new Campaign(hollowDef, 1);
    c.completedMissions.add('prologue');
    c.currentMission = 'gathering_survivors';
    c.save();
    const info = Campaign.getSlotSummary(hollowDef, 1);
    assert.equal(info.used, true);
    assert.equal(info.status, 'in-progress');
    assert.equal(info.completed, 1);
    assert.equal(info.currentMission, 'gathering_survivors');
    assert.ok(info.currentMissionTitle);
    assert.equal(typeof info.updatedAt, 'number');
  });

  test('a freshly-saved New Game slot reads as used (status new)', () => {
    new Campaign(hollowDef, 3).save();
    const info = Campaign.getSlotSummary(hollowDef, 3);
    assert.equal(info.used, true);
    assert.equal(info.status, 'new');
    assert.equal(info.completed, 0);
    assert.equal(info.currentMission, hollowDef.firstMission);
  });
});

describe('getAggregateProgress', () => {
  beforeEach(() => localStorage.clear());

  test('with no saves reports "new"', () => {
    const p = Campaign.getAggregateProgress(hollowDef);
    assert.equal(p.status, 'new');
    assert.equal(p.completed, 0);
    assert.equal(p.total, hollowDef.missions.length);
  });

  test('reports the furthest-along slot', () => {
    // Slot 1: in-progress (1 done). Slot 2: completed.
    const s1 = new Campaign(hollowDef, 1);
    s1.completedMissions.add('prologue');
    s1.save();
    const s2 = new Campaign(hollowDef, 2);
    for (const m of hollowDef.missions) s2.completedMissions.add(m.id);
    s2.save();
    const p = Campaign.getAggregateProgress(hollowDef);
    assert.equal(p.status, 'completed');
  });

  test('isCampaignCompleted is true when ANY slot is complete', () => {
    const s2 = new Campaign(hollowDef, 2);
    for (const m of hollowDef.missions) s2.completedMissions.add(m.id);
    s2.save();
    assert.ok(Campaign.isCampaignCompleted(hollowDef));
  });
});
