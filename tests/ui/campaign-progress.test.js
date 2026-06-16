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
  weaponName, weaponStatString, progressSquadCap,
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

  test('renders non-weapon carried items as inventory badges', () => {
    // horse is not a weapon → stays in the badge row; weapons move to the list.
    const u = { name: 'X', color: '#888', hp: 4, maxHp: 10, attack: 1, defense: 1, level: 1, xp: 0, weapon: 'sword', items: { horse: 2 } };
    const html = progressUnitCardHTML(u, { idx: 0 });
    assert.match(html, /cprog-inv/);
    assert.match(html, /×2/);
  });
});

// ── weapon name / stat string helpers ────────────────────────────────────────

describe('weaponName / weaponStatString', () => {
  test('weaponName strips the glyph token and the stat parenthetical', () => {
    assert.equal(weaponName('greatsword'), 'Great Sword');
    assert.equal(weaponName('sword'), 'Sword');
    assert.equal(weaponName('staff'), 'Staff');
  });

  test('weaponStatString reads ATK/DEF/range straight off the definition', () => {
    assert.equal(weaponStatString('sword'), 'ATK +2');
    assert.equal(weaponStatString('axe'), 'ATK +1 · DEF +1');
    assert.equal(weaponStatString('bow'), 'range 3');
    assert.equal(weaponStatString('shield'), 'DEF +2');
  });
});

// ── unit card weapons list ───────────────────────────────────────────────────

describe('progressUnitCardHTML weapons list', () => {
  const unit = (over = {}) => ({
    name: 'X', color: '#888', hp: 5, maxHp: 10, attack: 2, defense: 1,
    level: 1, xp: 0, items: {}, ...over,
  });

  test('renders one named row per weapon with its stat string + equipped ✓', () => {
    const html = progressUnitCardHTML(unit({ weapon: 'sword', items: { bow: 1 } }), { idx: 0 });
    assert.equal(occurrences(html, 'cprog-w-glyph'), 2);   // one glyph per weapon row
    assert.match(html, /Sword/);
    assert.match(html, /ATK \+2/);
    assert.match(html, /Bow/);
    assert.match(html, /range 3/);
    assert.match(html, /cprog-weapon equipped/);           // equipped row styled
    assert.match(html, /✓ Equipped/);                      // equipped indicator
  });

  test('non-equipped weapon gets an Equip control carrying idx + weapon id', () => {
    const html = progressUnitCardHTML(unit({ weapon: 'sword', items: { bow: 1 } }), { idx: 3 });
    assert.match(html, /cprog-equip-btn[^>]*data-idx="3"[^>]*data-weapon="bow"/);
    // the equipped weapon itself never gets an Equip control
    assert.equal(occurrences(html, 'cprog-equip-btn'), 1);
  });

  test('leader sentinel idx flows onto the Equip control', () => {
    const html = progressUnitCardHTML(unit({ weapon: 'sword', items: { bow: 1 } }), { idx: 'leader' });
    assert.match(html, /cprog-equip-btn[^>]*data-idx="leader"/);
  });

  test('single weapon → equipped row only, no Equip control; no weapons → no list', () => {
    const single = progressUnitCardHTML(unit({ weapon: 'sword', items: {} }), { idx: 0 });
    assert.match(single, /✓ Equipped/);
    assert.doesNotMatch(single, /cprog-equip-btn/);

    const none = progressUnitCardHTML(unit({ items: {} }), { idx: 0 });
    assert.doesNotMatch(none, /cprog-weapons/);
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

// ── progressSquadCap (Fix #1: the campaign menu's squad picker is uncapped) ───

describe('progressSquadCap', () => {
  test('cap is the full roster size — the whole party is pickable', () => {
    assert.equal(progressSquadCap(makeRoster(5)), 5);
    assert.equal(progressSquadCap(makeRoster(1)), 1);
  });

  test('empty / missing roster → 0 (nothing to pick, no crash)', () => {
    assert.equal(progressSquadCap([]), 0);
    assert.equal(progressSquadCap(undefined), 0);
    assert.equal(progressSquadCap(null), 0);
  });

  test('with the roster-size cap the menu never shows "0/0 — go alone"', () => {
    // Regression for the bug where the next mission's solo cap (0) leaked onto
    // the management screen. Using the roster size as the cap, a party of 3
    // reads "N/3" and offers promote/demote controls instead.
    const roster = makeRoster(3);
    const cap = progressSquadCap(roster);          // 3
    const html = partyPaneHTML(HERO, roster, [0, 1, 2], cap, { resources: {} });
    assert.match(html, /Active Squad <span class="cprog-count">3\/3<\/span>/);
    assert.doesNotMatch(html, /go alone/i);
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

// ── Campaign.equipWeaponForUnit (between-mission loadout) ────────────────────

describe('Campaign.equipWeaponForUnit', () => {
  function equipCampaign() {
    const c = new Campaign(rowsDef, 1);
    c.heroStats = { hp: 50, maxHp: 98, attack: 3, defense: 2, level: 1, xp: 0, weapon: 'sword', items: { bow: 1 } };
    c.roster = [{ name: 'S', title: 'Farmer', color: '#8a8', hp: 6, maxHp: 10, attack: 2, defense: 1, level: 1, xp: 0, weapon: 'dagger', items: { axe: 1 } }];
    return c;
  }

  test('leader: swaps equipped weapon and stows the old one in the backpack', () => {
    const c = equipCampaign();
    assert.equal(c.equipWeaponForUnit('leader', 'bow'), 'bow');
    assert.equal(c.heroStats.weapon, 'bow');         // new weapon equipped
    assert.equal(c.heroStats.items.sword, 1);        // old weapon stowed (not lost)
    assert.ok(!c.heroStats.items.bow);               // new weapon drawn out of backpack
  });

  test('roster unit: equips by index and persists through save()', () => {
    const c = equipCampaign();
    assert.equal(c.equipWeaponForUnit(0, 'axe'), 'axe');
    assert.equal(c.roster[0].weapon, 'axe');
    assert.equal(c.roster[0].items.dagger, 1);
    const saved = JSON.parse(globalThis.localStorage.getItem(`brimstone-${c.saveSlot}`));
    assert.equal(saved.roster[0].weapon, 'axe');     // change reached localStorage
  });

  test('no-op (returns null, no mutation) for bad targets', () => {
    const c = equipCampaign();
    assert.equal(c.equipWeaponForUnit('leader', 'sword'), null);  // already equipped
    assert.equal(c.equipWeaponForUnit('leader', 'horse'), null);  // not a weapon
    assert.equal(c.equipWeaponForUnit('leader', 'musket'), null); // not carried
    assert.equal(c.equipWeaponForUnit(99, 'axe'), null);          // unknown unit
    assert.equal(c.heroStats.weapon, 'sword');                    // unchanged throughout
  });
});

// ── Shared armory: returnWeaponToInventory / equipFromInventory (Fix #2) ──────

describe('Campaign shared armory (weapons move both ways)', () => {
  function armoryCampaign() {
    const c = new Campaign(rowsDef, 1);
    c.heroStats = { hp: 50, maxHp: 98, attack: 3, defense: 2, level: 1, xp: 0, weapon: 'sword', items: { bow: 1 } };
    c.roster = [{ name: 'S', title: 'Farmer', color: '#8a8', hp: 6, maxHp: 10, attack: 2, defense: 1, level: 1, xp: 0, weapon: 'dagger', items: { axe: 1 } }];
    c.weapons = {};
    return c;
  }

  test('returnWeaponToInventory stows a carried weapon into the shared pool', () => {
    const c = armoryCampaign();
    assert.equal(c.returnWeaponToInventory('leader', 'bow'), 'bow');
    assert.equal(c.weapons.bow, 1);                  // weapon reached the pool
    assert.ok(!c.heroStats.items.bow);               // and left the backpack
    assert.equal(c.heroStats.weapon, 'sword');       // equipped slot untouched
  });

  test('equipFromInventory draws a pooled weapon onto a unit, pooling the old one', () => {
    const c = armoryCampaign();
    c.weapons = { greatsword: 1 };
    assert.equal(c.equipFromInventory('leader', 'greatsword'), 'greatsword');
    assert.equal(c.heroStats.weapon, 'greatsword');  // new weapon equipped
    assert.ok(!c.weapons.greatsword);                // drawn out of the pool
    assert.equal(c.weapons.sword, 1);                // old equipped weapon stowed (non-destructive)
  });

  test('round-trips a weapon from one unit to another via the pool', () => {
    const c = armoryCampaign();
    // Survivor stows its spare axe; the leader then equips it from the pool.
    assert.equal(c.returnWeaponToInventory(0, 'axe'), 'axe');
    assert.ok(!c.roster[0].items.axe);
    assert.equal(c.weapons.axe, 1);
    assert.equal(c.equipFromInventory('leader', 'axe'), 'axe');
    assert.equal(c.heroStats.weapon, 'axe');
    assert.ok(!c.weapons.axe);                       // pool drained
    assert.equal(c.weapons.sword, 1);                // leader's old sword pooled
  });

  test('returnWeaponToInventory no-ops for non-weapon / not-carried / unknown unit', () => {
    const c = armoryCampaign();
    assert.equal(c.returnWeaponToInventory('leader', 'horse'), null);   // not a weapon
    assert.equal(c.returnWeaponToInventory('leader', 'greatsword'), null); // not carried
    assert.equal(c.returnWeaponToInventory(99, 'bow'), null);            // unknown unit
    assert.deepEqual(c.weapons, {});                                     // pool untouched
  });

  test('equipFromInventory no-ops when the weapon is not in the pool or already equipped', () => {
    const c = armoryCampaign();
    c.weapons = { greatsword: 1 };
    assert.equal(c.equipFromInventory('leader', 'axe'), null);          // not in pool
    assert.equal(c.equipFromInventory('leader', 'sword'), null);        // already equipped
    assert.equal(c.equipFromInventory('leader', 'horse'), null);        // not a weapon
    assert.equal(c.heroStats.weapon, 'sword');
    assert.equal(c.weapons.greatsword, 1);                              // pool untouched
  });

  test('armory changes persist to localStorage (survive a reload)', () => {
    const c = armoryCampaign();
    c.returnWeaponToInventory('leader', 'bow');
    const reloaded = new Campaign(rowsDef, 1);
    assert.equal(reloaded.load(), true);
    assert.equal(reloaded.weapons.bow, 1);
  });

  test('pre-armory saves load with an empty pool (no crash)', () => {
    const c = new Campaign(rowsDef, 1);
    // Persist a blob lacking the `weapons` field, mimicking an older save.
    const blob = JSON.parse(globalThis.localStorage.getItem(`brimstone-${c.saveSlot}`) || 'null')
      || { campaignId: rowsDef.id, version: 4, currentMission: 'm1', completedMissions: [], roster: [], resources: {}, heroStats: c.heroStats, storyFlags: {}, updatedAt: 1 };
    delete blob.weapons;
    globalThis.localStorage.setItem(`brimstone-${c.saveSlot}`, JSON.stringify(blob));
    const reloaded = new Campaign(rowsDef, 1);
    assert.equal(reloaded.load(), true);
    assert.deepEqual(reloaded.weapons, {});
  });

  test('unequipToInventory round-trips with equipFromInventory back to the start', () => {
    const c = armoryCampaign();
    // Start unit 0 weaponless, with an axe waiting in the shared pool.
    c.roster[0].weapon = null;
    c.weapons = { axe: 1 };
    assert.equal(c.equipFromInventory(0, 'axe'), 'axe'); // pool → equipped
    assert.equal(c.roster[0].weapon, 'axe');
    assert.ok(!c.weapons.axe);                           // pool drained
    // Take it back off (equipped → pool, no replacement) — exact starting state.
    assert.deepEqual(c.unequipToInventory(0), { success: true, weaponId: 'axe' });
    assert.equal(c.roster[0].weapon, null);              // weaponless again
    assert.equal(c.weapons.axe, 1);                      // pool count restored
  });

  test('unequipToInventory banks an equipped weapon into the shared pool', () => {
    const c = armoryCampaign();
    c.weapons = {};                                      // empty pool
    assert.deepEqual(c.unequipToInventory('leader'), { success: true, weaponId: 'sword' });
    assert.equal(c.heroStats.weapon, null);              // equipped slot emptied
    assert.equal(c.weapons.sword, 1);                    // sword reached the pool
  });

  test('unequipToInventory no-ops when the unit has no equipped weapon', () => {
    const c = armoryCampaign();
    c.heroStats.weapon = null;                           // already unarmed
    c.weapons = {};
    assert.deepEqual(c.unequipToInventory('leader'), { success: false });
    // never pools a null/undefined key
    assert.deepEqual(c.weapons, {});
    assert.ok(!('null' in c.weapons));
    assert.ok(!('undefined' in c.weapons));
  });
});

// ── Shared-armory rendering (campaign-ui.js) ─────────────────────────────────

describe('shared-armory rendering', () => {
  test('carried weapon rows get a Stow control (return to the shared armory)', () => {
    const u = { name: 'X', color: '#888', hp: 5, maxHp: 10, attack: 2, defense: 1, level: 1, xp: 0, weapon: 'sword', items: { bow: 1 } };
    const html = progressUnitCardHTML(u, { idx: 2 });
    assert.match(html, /cprog-return-btn[^>]*data-idx="2"[^>]*data-weapon="bow"/);
    // the equipped weapon row never gets a Stow control
    assert.equal(occurrences(html, 'cprog-return-btn'), 1);
  });

  test('the equipped weapon row keeps the ✓ badge and gains an Unequip control', () => {
    const u = { name: 'X', color: '#888', hp: 5, maxHp: 10, attack: 2, defense: 1, level: 1, xp: 0, weapon: 'sword', items: { bow: 1 } };
    const html = progressUnitCardHTML(u, { idx: 2 });
    assert.match(html, /✓ Equipped/);                                          // badge stays
    assert.match(html, /cprog-unequip-btn[^>]*data-idx="2"[^>]*data-weapon="sword"/);
    // only the one equipped weapon is unequippable (carried rows don't get it)
    assert.equal(occurrences(html, 'cprog-unequip-btn'), 1);
  });

  test('pooled weapons render in Shared Inventory with a per-unit Equip control', () => {
    const html = partyPaneHTML(HERO, makeRoster(1), [0], 1, { resources: {}, weapons: { greatsword: 1 } });
    assert.match(html, /Armory/);
    assert.match(html, /Great Sword/);
    // an Equip control for the leader and for the one active unit
    assert.match(html, /cprog-pool-equip-btn[^>]*data-idx="leader"[^>]*data-weapon="greatsword"/);
    assert.match(html, /cprog-pool-equip-btn[^>]*data-idx="0"[^>]*data-weapon="greatsword"/);
  });

  test('no Armory section when the shared pool is empty', () => {
    const html = partyPaneHTML(HERO, makeRoster(1), [0], 1, { resources: { wood: 2 } });
    assert.doesNotMatch(html, /Armory/);
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

  test('equip button handler invokes Campaign.equipWeaponForUnit', () => {
    assert.match(src, /cprog-equip-btn/);
    assert.match(src, /equipWeaponForUnit\(/);
  });

  test('shared-armory handlers invoke return/equip-from-inventory', () => {
    assert.match(src, /cprog-return-btn/);
    assert.match(src, /returnWeaponToInventory\(/);
    assert.match(src, /cprog-pool-equip-btn/);
    assert.match(src, /equipFromInventory\(/);
  });

  test('unequip button handler invokes Campaign.unequipToInventory', () => {
    assert.match(src, /cprog-unequip-btn/);
    assert.match(src, /unequipToInventory\(/);
  });

  test('progress-screen squad cap uses the full roster (not the mission cap)', () => {
    assert.match(src, /_progressSquadCap\(_activeCampaign\?\.roster\)/);
  });

  test('Campaign menu routes straight to the Chapter 1 slot picker', () => {
    assert.match(src, /getCampaignById\('calebs_hollow_prologue'\)/);
    assert.match(src, /_showCampaignSlotScreen\(ch1\)/);
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
