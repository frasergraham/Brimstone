// Tests for the Campaign Progress screen (Phase F).
//
// The render functions are pure string builders (campaign-ui.js) so they're
// tested directly — no DOM needed (getCampaignPortrait returns null outside a
// browser, so cards fall back to glyphs). main.js itself has top-level DOM side
// effects and can't be imported, so its handler wiring is asserted at the
// source level (same pattern as tests/games-update.test.js).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  xpProgress, progressUnitCardHTML, partyPaneHTML, missionListPaneHTML, missionRows,
} from '../../src/campaign/campaign-ui.js';
import { xpForLevel } from '../../src/balance.js';
import { Campaign } from '../../src/campaign/campaign.js';

const _root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// localStorage mock (Campaign ctor / getMissionList don't touch it, but be safe)
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const occurrences = (hay, needle) => hay.split(needle).length - 1;

function makeRoster(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `Unit${i}`, title: 'Farmer', color: '#8a8',
    hp: 6, maxHp: 10, attack: 2, defense: 1, level: 1, xp: 0, items: {},
  }));
}
const HERO = { hp: 50, maxHp: 98, attack: 3, defense: 2, level: 1, xp: 0, weapon: 'sword', items: {} };

// ── xpProgress ───────────────────────────────────────────────────────────────

describe('xpProgress', () => {
  test('level 1 with 0 xp → empty bar of the L1→L2 span', () => {
    const p = xpProgress(1, 0);
    assert.equal(p.level, 1);
    assert.equal(p.into, 0);
    assert.equal(p.span, xpForLevel(2) - xpForLevel(1)); // 200
    assert.equal(p.pct, 0);
  });

  test('partway into a level computes into / span / pct', () => {
    // L2 starts at 200, L3 at 600 → span 400. xp 400 → into 200 → 50%.
    const p = xpProgress(2, 400);
    assert.equal(p.level, 2);
    assert.equal(p.span, 400);
    assert.equal(p.into, 200);
    assert.equal(p.pct, 50);
  });

  test('clamps into to the span and floors level at 1', () => {
    const p = xpProgress(0, -50);
    assert.equal(p.level, 1);
    assert.equal(p.into, 0);
    assert.ok(p.pct >= 0 && p.pct <= 100);
  });
});

// ── progressUnitCardHTML ─────────────────────────────────────────────────────

describe('progressUnitCardHTML', () => {
  test('shows level, HP, XP and ATK/DEF', () => {
    const html = progressUnitCardHTML(
      { name: 'Jeb', title: 'Innkeeper', color: '#8a8', hp: 6, maxHp: 10, attack: 2, defense: 1, level: 3, xp: 700, items: {} },
      { idx: 0 },
    );
    assert.match(html, /Lv 3/);
    assert.match(html, /6\/10/);            // hp label
    assert.match(html, /⚔ 2/);
    assert.match(html, /🛡 1/);
  });

  test('renders a heal button only when canHeal', () => {
    const base = { name: 'X', color: '#888', hp: 4, maxHp: 10, attack: 1, defense: 1, level: 1, xp: 0, items: {} };
    assert.match(progressUnitCardHTML(base, { idx: 2, canHeal: true }), /cprog-heal-btn[^>]*data-idx="2"/);
    assert.doesNotMatch(progressUnitCardHTML(base, { idx: 2, canHeal: false }), /cprog-heal-btn/);
  });

  test('renders the promote/demote control when given', () => {
    const u = { name: 'X', color: '#888', hp: 4, maxHp: 10, attack: 1, defense: 1, level: 1, xp: 0, items: {} };
    assert.match(progressUnitCardHTML(u, { idx: 1, control: { cls: 'cprog-promote', label: '+', title: 'go' } }), /cprog-promote/);
  });

  test('renders an inventory row for carried items', () => {
    const u = { name: 'X', color: '#888', hp: 4, maxHp: 10, attack: 1, defense: 1, level: 1, xp: 0, weapon: 'sword', items: { shield: 2 } };
    const html = progressUnitCardHTML(u, { idx: 0 });
    assert.match(html, /cprog-inv/);
    assert.match(html, /×2/);
  });
});

// ── partyPaneHTML ────────────────────────────────────────────────────────────

describe('partyPaneHTML', () => {
  test('always renders the featured leader + Active Squad + Reserve sections', () => {
    const html = partyPaneHTML(HERO, makeRoster(2), [0], 2, { resources: { herbs: 0 } });
    assert.match(html, /Ishmael Charger/);
    assert.match(html, /Leader/);
    assert.match(html, /Active Squad/);
    assert.match(html, /Reserve/);
    assert.match(html, /Shared Inventory/);
  });

  test('empty reserve (hero only, no survivors) still renders all sections', () => {
    const html = partyPaneHTML(HERO, [], [], 3, { resources: {} });
    assert.match(html, /Ishmael Charger/);
    assert.match(html, /Active Squad/);
    assert.match(html, /No reserve survivors/);
  });

  test('active count reflects the cap and selected indices', () => {
    const html = partyPaneHTML(HERO, makeRoster(4), [0, 1], 2, { resources: {} });
    assert.match(html, /Active Squad <span class="cprog-count">2\/2<\/span>/);
  });

  test('reserve > cap: only `cap` units are active, the rest are reserve', () => {
    // 4 survivors, cap 2, two active → two reserve cards remain.
    const html = partyPaneHTML(HERO, makeRoster(4), [0, 1], 2, { resources: {} });
    // 2 active demote controls, and the reserve cards live under reserve-grid.
    assert.equal(occurrences(html, 'cprog-demote'), 2);
    assert.match(html, /reserve-grid/);
  });

  test('PROMOTE control appears on reserve cards only when below the cap', () => {
    const below = partyPaneHTML(HERO, makeRoster(3), [0], 2, { resources: {} }); // 1 active, cap 2 → can add
    assert.ok(occurrences(below, 'cprog-promote') > 0, 'promote shown below cap');

    const full = partyPaneHTML(HERO, makeRoster(3), [0, 1], 2, { resources: {} }); // 2 active, cap 2 → full
    assert.equal(occurrences(full, 'cprog-promote'), 0, 'no promote when active squad full');
  });

  test('maxActive 0 → "go alone" note, no promote controls', () => {
    const html = partyPaneHTML(HERO, makeRoster(2), [], 0, { resources: {} });
    assert.match(html, /go alone/i);
    assert.equal(occurrences(html, 'cprog-promote'), 0);
  });

  test('heal buttons gated by herbs > 0 AND hp < maxHp', () => {
    const roster = makeRoster(1); // hp 6/10 (wounded)
    const withHerbs = partyPaneHTML(HERO, roster, [0], 2, { resources: { herbs: 2 } });
    assert.ok(occurrences(withHerbs, 'cprog-heal-btn') >= 1, 'wounded unit heals with herbs');

    const noHerbs = partyPaneHTML(HERO, roster, [0], 2, { resources: { herbs: 0 } });
    assert.equal(occurrences(noHerbs, 'cprog-heal-btn'), 0, 'no heal without herbs');

    const fullRoster = [{ ...roster[0], hp: 10 }];     // survivor at max
    const fullHero = { ...HERO, hp: HERO.maxHp };        // leader at max too
    const fullHp = partyPaneHTML(fullHero, fullRoster, [0], 2, { resources: { herbs: 5 } });
    assert.equal(occurrences(fullHp, 'cprog-heal-btn'), 0, 'no heal at full hp');
  });

  test('shared inventory shows positive resources only', () => {
    const html = partyPaneHTML(HERO, [], [], 3, { resources: { herbs: 3, wood: 0, silver: 2 } });
    assert.match(html, /herbs/);
    assert.match(html, /silver/);
    assert.doesNotMatch(html, /class="cr-label">wood/);
  });
});

// ── missionRows + missionListPaneHTML ───────────────────────────────────────

const rowsDef = {
  id: 'rows_test',
  title: 'Chapter 1 — Test',
  missions: [
    { id: 'm1', title: 'One',   briefing: 'first'  },
    { id: 'm2', title: 'Two',   briefing: 'second', requires: ['m1'] },
    { id: 'm3', title: 'Three', briefing: 'third',  requires: ['m2'] },
    { id: 'm4', title: 'Four',  briefing: 'fourth', requires: ['m3'] },
  ],
  mapBuilders: {},
  firstMission: 'm1',
};

function rowsCampaign(completed = ['m1']) {
  const c = new Campaign(rowsDef, 1);
  c.completedMissions = new Set(completed);
  return c;
}

describe('missionRows', () => {
  test('hides missions more than one step from playable', () => {
    const rows = missionRows(rowsCampaign(['m1']));
    const ids = rows.map(r => r.id);
    assert.deepEqual(ids, ['m1', 'm2', 'm3']); // m4 hidden (two steps away)
  });

  test('status: completed / available / locked', () => {
    const rows = missionRows(rowsCampaign(['m1']));
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    assert.equal(byId.m1.status, 'completed');
    assert.equal(byId.m2.status, 'available');
    assert.equal(byId.m3.status, 'locked');
  });

  test('locked rows carry a "complete <prev>" hint', () => {
    const rows = missionRows(rowsCampaign(['m1']));
    const m3 = rows.find(r => r.id === 'm3');
    assert.match(m3.lockedHint, /complete .*Two.* to unlock/);
  });

  test('unlockAll shows every mission and treats them as launchable', () => {
    const rows = missionRows(rowsCampaign(['m1']), true);
    assert.equal(rows.length, 4);
    assert.equal(rows.find(r => r.id === 'm4').status, 'available');
  });
});

describe('missionListPaneHTML', () => {
  test('renders status icons and the chapter title', () => {
    const rows = missionRows(rowsCampaign(['m1']));
    const html = missionListPaneHTML('Chapter 1 — Test', rows);
    assert.match(html, /Chapter 1 — Test/);
    assert.match(html, /✓/); // completed
    assert.match(html, /→/); // available
    assert.match(html, /🔒/); // locked
  });

  test('available rows get the .available class (clickable hook)', () => {
    const rows = missionRows(rowsCampaign(['m1']));
    const html = missionListPaneHTML('x', rows);
    assert.match(html, /cprog-mission available" data-mission="m2"/);
  });
});

// ── main.js wiring (source-level) ────────────────────────────────────────────

describe('main.js Campaign Progress wiring', () => {
  const src = readFileSync(join(_root, 'src', 'main.js'), 'utf8');

  test('slot-picker default landing routes to the Progress screen', () => {
    assert.match(src, /_renderCampaignProgressScreen\(\)/);
    assert.match(src, /showStep\('campaign-progress'\)/);
  });

  test('heal button handler invokes Campaign.healUnitWithHerb', () => {
    assert.match(src, /healUnitWithHerb\(/);
  });

  test('promote handler respects the active-squad cap', () => {
    assert.match(src, /_activeRosterIndices\.length < maxActive/);
  });

  test('mobile pane toggle flips the show-party / show-missions class', () => {
    assert.match(src, /classList\.toggle\('show-party'/);
    assert.match(src, /classList\.toggle\('show-missions'/);
  });

  test('briefing preserves a squad already chosen on the Progress screen', () => {
    // _showMissionBriefing must NOT unconditionally reset _activeRosterIndices.
    assert.match(src, /Preserve a squad already chosen on the Progress screen/);
  });
});
