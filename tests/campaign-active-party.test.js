// Tests for the persisted active-party (deployed roster) selection. The set of
// roster indices the player marks "active" on the Party Management / Progress
// screen must survive an app restart, stay independent per save slot, and fall
// back gracefully when the saved selection references units no longer in the
// roster (e.g. permadeath shrank it).

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Campaign, resolveDeployIndices } from '../src/campaign/campaign.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';
import { buildDeployPartyPreview, campaignMissionSaveKey, deleteCampaignMissionSave } from '../src/campaign/campaign-ui.js';

// ── localStorage mock for Node ───────────────────────────────────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const hollowDef = getCampaignById('calebs_hollow_prologue');

/** Stub roster entries so we have indices to mark active. */
function _roster(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `S${i}`, title: null, hp: 10, maxHp: 10, attack: 1, defense: 1,
    level: 1, xp: 0, items: {},
  }));
}

describe('persisted active-party selection', () => {
  beforeEach(() => localStorage.clear());

  test('the active-party selection survives a "reload"', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(4);
    c.setActiveParty([0, 2]);
    c.save();

    // "Reload": a fresh instance reading the same slot restores the selection.
    const reloaded = new Campaign(hollowDef, 1);
    assert.ok(reloaded.load());
    reloaded.roster = _roster(4); // roster itself is restored from save in real use
    assert.deepEqual(reloaded.getActiveParty(3), [0, 2]);
  });

  test('different slots keep independent active parties', () => {
    const s1 = new Campaign(hollowDef, 1);
    s1.roster = _roster(3);
    s1.setActiveParty([0, 1]);
    s1.save();

    const s2 = new Campaign(hollowDef, 2);
    s2.roster = _roster(3);
    s2.setActiveParty([2]);
    s2.save();

    const s1b = new Campaign(hollowDef, 1);
    s1b.load();
    s1b.roster = _roster(3);
    assert.deepEqual(s1b.getActiveParty(3), [0, 1]);

    const s2b = new Campaign(hollowDef, 2);
    s2b.load();
    s2b.roster = _roster(3);
    assert.deepEqual(s2b.getActiveParty(3), [2]);
  });

  test('falls back gracefully when the saved selection references missing units', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(5);
    c.setActiveParty([0, 3, 4]);
    c.save();

    // The roster shrank to 2 (e.g. permadeath) before the next reload.
    const reloaded = new Campaign(hollowDef, 1);
    reloaded.load();
    reloaded.roster = _roster(2);
    // Indices 3 and 4 no longer exist — only the still-valid index 0 survives.
    assert.deepEqual(reloaded.getActiveParty(3), [0]);
  });

  test('getActiveParty clamps to the requested cap', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(5);
    c.setActiveParty([0, 1, 2, 3]);
    c.save();

    const reloaded = new Campaign(hollowDef, 1);
    reloaded.load();
    reloaded.roster = _roster(5);
    assert.deepEqual(reloaded.getActiveParty(2), [0, 1]);
  });

  test('setActiveParty drops out-of-range / duplicate indices before saving', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);
    c.setActiveParty([0, 0, 1, 9, -1]);
    assert.deepEqual(c.getActiveParty(3), [0, 1]);
  });

  // Regression: applyMissionResult rebuilds the roster deployed-FIRST, so the
  // index-based activeParty must be remapped by NAME or the player's chosen
  // squad drifts to other survivors (or shrinks) — the "started with 1 survivor
  // though my party is 3" bug. The selection must follow the same survivors.
  test('the active-party selection is remapped by NAME across the post-mission roster reorder', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);              // S0, S1, S2
    c.setActiveParty([0, 1, 2]);        // all three chosen in the Party screen
    // Won mission: reconcile returns a reordered (deployed-first) roster.
    const reordered = [c.roster[2], c.roster[0], c.roster[1]];   // S2, S0, S1
    c.applyMissionResult('prologue', { won: true, survivors: reordered, fallen: [], resources: {}, flags: {} });
    const activeNames = c.getActiveParty(3).map(i => c.roster[i].name).sort();
    assert.deepEqual(activeNames, ['S0', 'S1', 'S2'], 'all three chosen survivors stay active after the reorder');
  });

  test('a partial active party keeps exactly the chosen survivors across the reorder', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);
    c.setActiveParty([0, 2]);           // S0 + S2 active; S1 benched
    const reordered = [c.roster[1], c.roster[2], c.roster[0]];   // S1, S2, S0
    c.applyMissionResult('prologue', { won: true, survivors: reordered, fallen: [], resources: {}, flags: {} });
    const activeNames = c.getActiveParty(3).map(i => c.roster[i].name).sort();
    assert.deepEqual(activeNames, ['S0', 'S2'], 'the benched survivor stays benched; chosen two stay active');
  });

  test('a pre-v8 save loads with an empty active party (migration backfill)', () => {
    // Hand-write a v7 save lacking `activeParty`.
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);
    c.save();
    const key = `brimstone-${c.saveSlot}`;
    const data = JSON.parse(localStorage.getItem(key));
    delete data.activeParty;
    data.version = 7;
    localStorage.setItem(key, JSON.stringify(data));

    const reloaded = new Campaign(hollowDef, 1);
    assert.ok(reloaded.load());
    reloaded.roster = _roster(3);
    assert.deepEqual(reloaded.getActiveParty(3), []);
  });

  // End-to-end: mirror the main.js Party-screen flow — a fresh visit seeds the
  // squad and persists it; the player benches one unit; an app "reload" reopens
  // the screen and must show the same custom squad rather than re-front-filling.
  test('a customized squad survives reopening the Party screen after a reload', () => {
    const MAX = 3;
    // Fresh entry: seed = front-fill to the cap (and persist, like main.js does).
    const first = new Campaign(hollowDef, 1);
    first.load();
    first.roster = _roster(4);
    const seeded = first.getActiveParty(MAX);
    const startSquad = seeded.length > 0 ? seeded
      : first.roster.map((_, i) => i).slice(0, MAX);
    first.setActiveParty(startSquad);
    assert.deepEqual(first.getActiveParty(MAX), [0, 1, 2]);

    // Player benches index 1 and promotes index 3 on the screen.
    first.setActiveParty([0, 2, 3]);

    // "Reload the app": a brand-new Campaign instance reads the same slot.
    const afterReload = new Campaign(hollowDef, 1);
    afterReload.load();
    afterReload.roster = _roster(4);
    // Reopening the Party screen restores the CUSTOM squad, not a fresh front-fill.
    assert.deepEqual(afterReload.getActiveParty(MAX), [0, 2, 3]);
  });
});

// Regression: the Ledger "Begin Mission" path launches a mission WITHOUT first
// visiting the Party screen, so the live working selection (_activeRosterIndices)
// is empty at deploy time. The deploy loop must then fall back to the persisted
// Campaign.activeParty (the player's chosen NAMED squad) rather than deploying
// nobody — otherwise the minSurvivors balancer backfills random generics and the
// player sees "I had 4 units, only 2 showed up". resolveDeployIndices is the pure
// chokepoint that encodes that fallback; it's what _initCampaignMission now calls.
describe('fresh-launch deploy index resolution (resolveDeployIndices)', () => {
  beforeEach(() => localStorage.clear());

  // Ch1M3 (first_night) ships maxSurvivorsFromRoster: 3, minSurvivors: 2.
  const MAX_FROM_ROSTER = 3;

  test('empty working selection falls back to the persisted 3-named-survivor party (THE BUG)', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(4);              // S0, S1, S2, S3 available
    c.setActiveParty([0, 1, 2]);        // player chose a 3-survivor squad and it persisted

    // Fresh launch from the Ledger: the working selection was never seeded.
    const workingIndices = [];

    const toDeploy = resolveDeployIndices(workingIndices, c, MAX_FROM_ROSTER);

    // Must deploy the 3 PERSISTED roster survivors (their named entries), not [].
    assert.deepEqual(toDeploy, [0, 1, 2],
      'empty working selection must fall back to the persisted active party');
    const names = toDeploy.map(i => c.roster[i].name);
    assert.deepEqual(names, ['S0', 'S1', 'S2'],
      'the deployed party must be the player\'s chosen NAMED survivors');
    assert.ok(toDeploy.length > 2,
      'must deploy more than the minSurvivors floor (2) — generic backfill would give exactly 2');
  });

  test('a populated working selection is used as-is (Party-screen path, clamped to cap)', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(5);
    c.setActiveParty([0, 1, 2]);        // a different persisted squad
    // Player customized the squad on the Party screen this session.
    const working = [1, 3, 4];
    assert.deepEqual(resolveDeployIndices(working, c, MAX_FROM_ROSTER), [1, 3, 4],
      'the live working selection wins over the persisted party');
  });

  test('result is clamped to the mission start cap', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(5);
    c.setActiveParty([0, 1, 2, 3, 4]);  // would exceed the cap
    assert.deepEqual(resolveDeployIndices([], c, 2), [0, 1],
      'the persisted-party fallback is clamped to maxFromRoster');
    assert.deepEqual(resolveDeployIndices([0, 1, 2, 3], c, 2), [0, 1],
      'the working-selection path is clamped to maxFromRoster');
  });

  test('stale working indices outside the roster are dropped before the cap is applied', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);
    c.setActiveParty([0, 2]);
    // Working selection references index 9 (no longer in roster) + valid 0.
    assert.deepEqual(resolveDeployIndices([9, 0], c, MAX_FROM_ROSTER), [0],
      'only the still-valid working index survives');
  });

  test('no persisted party and empty working selection deploys nobody (balancer handles minSurvivors)', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);
    // activeParty never set — nothing to fall back to.
    assert.deepEqual(resolveDeployIndices([], c, MAX_FROM_ROSTER), [],
      'with no chosen party at all, deploy nothing and let minSurvivors backfill');
  });

  test('a zero start cap deploys nobody regardless of selection', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);
    c.setActiveParty([0, 1, 2]);
    assert.deepEqual(resolveDeployIndices([0, 1], c, 0), [],
      'maxFromRoster 0 → no roster survivors deploy');
  });
});

// The Begin Mission screen previews "who deploys" via buildDeployPartyPreview,
// fed the EXACT resolveDeployIndices output the launch path uses. The contract
// is "what you see is what deploys": the previewed survivors must be the roster
// entries at the resolved deploy indices, in deploy order, with the fixed hero
// prepended. A drift here is the original "I had 4 units, only 2 showed up" bug
// reappearing on the briefing screen.
describe('Begin Mission deploy preview (buildDeployPartyPreview)', () => {
  beforeEach(() => localStorage.clear());

  const MAX_FROM_ROSTER = 3;
  const _hero = () => ({ hp: 90, maxHp: 98, attack: 2, defense: 2, level: 3, xp: 5, items: {} });

  test('the previewed party is EXACTLY the deploy set (display == deploy)', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(4);              // S0..S3
    c.setActiveParty([0, 2, 3]);        // player chose a 3-survivor squad

    // The briefing path: empty working selection → resolveDeployIndices falls
    // back to the persisted party, then the preview maps those indices.
    const deploy = resolveDeployIndices([], c, MAX_FROM_ROSTER);
    const preview = buildDeployPartyPreview(_hero(), c.roster, deploy);

    // Hero first, then one entry per deployed survivor — never any extra/missing.
    assert.equal(preview[0].isHero, true, 'hero leads the preview');
    assert.equal(preview.length, deploy.length + 1, 'exactly hero + deploy count');
    const previewSurvivorNames = preview.slice(1).map(u => u.name);
    const deployNames = deploy.map(i => c.roster[i].name);
    assert.deepEqual(previewSurvivorNames, deployNames,
      'previewed survivors are precisely the roster entries at the deploy indices, in order');
    assert.deepEqual(previewSurvivorNames, ['S0', 'S2', 'S3'],
      'the player\'s chosen named squad is what the strip shows');
  });

  test('preview honors the deploy order (not roster order)', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);
    // A working selection in a deliberately non-ascending order.
    const deploy = resolveDeployIndices([2, 0, 1], c, MAX_FROM_ROSTER);
    const names = buildDeployPartyPreview(_hero(), c.roster, deploy).slice(1).map(u => u.name);
    assert.deepEqual(names, ['S2', 'S0', 'S1'], 'preview follows deploy order');
  });

  test('preview drops nobody and adds nobody when the cap trims the squad', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(5);
    c.setActiveParty([0, 1, 2, 3, 4]);  // five chosen, cap is 3
    const deploy = resolveDeployIndices([], c, MAX_FROM_ROSTER);
    const preview = buildDeployPartyPreview(_hero(), c.roster, deploy);
    assert.equal(preview.length, MAX_FROM_ROSTER + 1, 'hero + capped survivors only');
  });

  test('a stale deploy index is skipped defensively (never crashes the strip)', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(2);
    // Index 9 is out of range — buildDeployPartyPreview must skip it, not throw.
    const preview = buildDeployPartyPreview(_hero(), c.roster, [0, 9, 1]);
    assert.deepEqual(preview.slice(1).map(u => u.name), ['S0', 'S1']);
  });

  test('carries the level for the veterancy pill', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(2);
    c.roster[0].level = 4;
    const preview = buildDeployPartyPreview(_hero(), c.roster, [0]);
    assert.equal(preview[0].level, 3, 'hero level surfaces');
    assert.equal(preview[1].level, 4, 'survivor level surfaces for the pill');
  });
});

// SAVE-SAFETY: "Abandon save & restart mission" must delete ONLY the mid-mission
// localStorage key — the whole playthrough (roster, completed missions, resources,
// active party) MUST survive. That total wipe is a different action (the slot ✕,
// Campaign.delete()); the two must never be conflated. abandonMissionSave routes
// to deleteCampaignMissionSave, which is exactly what this asserts.
describe('Abandon mission save (deleteCampaignMissionSave) — save safety', () => {
  beforeEach(() => localStorage.clear());

  test('deletes ONLY the mission save key; playthrough progress + roster survive', () => {
    const c = new Campaign(hollowDef, 1);
    c.roster = _roster(3);
    c.setActiveParty([0, 1, 2]);
    c.completedMissions.add('prologue');
    c.resources = { herbs: 4, ammo: 9 };
    c.save();

    // Stand up a mid-mission save for a different mission in the same slot.
    const missionId = 'first_night';
    const missionKey = campaignMissionSaveKey(hollowDef.id, missionId, 1);
    localStorage.setItem(missionKey, JSON.stringify({ round: 5, foo: 'bar' }));
    assert.ok(localStorage.getItem(missionKey), 'mission save exists before abandon');

    // Abandon: deletes the mid-mission save ONLY.
    deleteCampaignMissionSave(hollowDef.id, missionId, 1);

    assert.equal(localStorage.getItem(missionKey), null, 'the mission save is gone');

    // The playthrough is fully intact — reload reads back the same progress.
    const reloaded = new Campaign(hollowDef, 1);
    assert.ok(reloaded.load(), 'the campaign slot still loads (not wiped)');
    reloaded.roster = _roster(3);
    assert.ok(reloaded.completedMissions.has('prologue'), 'completed-mission progress survives');
    assert.equal(reloaded.resources.herbs, 4, 'resources survive');
    assert.deepEqual(reloaded.getActiveParty(3), [0, 1, 2], 'the chosen party survives');
  });

  test('abandoning one mission save leaves a different mission\'s save untouched', () => {
    const a = campaignMissionSaveKey(hollowDef.id, 'prologue', 1);
    const b = campaignMissionSaveKey(hollowDef.id, 'first_night', 1);
    localStorage.setItem(a, JSON.stringify({ round: 1 }));
    localStorage.setItem(b, JSON.stringify({ round: 2 }));

    deleteCampaignMissionSave(hollowDef.id, 'first_night', 1);

    assert.equal(localStorage.getItem(b), null, 'the abandoned mission save is gone');
    assert.ok(localStorage.getItem(a), 'the other mission\'s save is untouched');
  });
});
