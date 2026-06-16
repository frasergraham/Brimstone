// Tests for Campaign.healUnitWithHerb — the between-mission heal helper used by
// the Campaign Progress screen (Phase F). Pure data logic, no DOM.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Campaign } from '../src/campaign/campaign.js';

// ── localStorage mock ────────────────────────────────────────────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const fakeDef = {
  id: 'heal_test',
  title: 'Heal Test',
  missions: [],
  mapBuilders: {},
  firstMission: 'm1',
};

function makeCampaign() {
  localStorage.clear();
  const c = new Campaign(fakeDef, 1);
  c.resources.herbs = 3;
  c.roster = [
    { name: 'Wounded', title: 'Farmer', hp: 5, maxHp: 10, attack: 2, defense: 1, level: 1, xp: 0, items: {} },
    { name: 'Fine',    title: 'Smith',  hp: 8, maxHp: 8,  attack: 2, defense: 2, level: 1, xp: 0, items: {} },
  ];
  c.heroStats = { hp: 40, maxHp: 98, attack: 3, defense: 2, level: 1, xp: 0, weapon: 'sword', items: {} };
  return c;
}

let _origRandom;
beforeEach(() => { _origRandom = Math.random; });
afterEach(()  => { Math.random = _origRandom; });

describe('Campaign.healUnitWithHerb', () => {
  test('heals a wounded roster unit, decrements herbs, returns new hp', () => {
    const c = makeCampaign();
    Math.random = () => 0.0; // each d10 → floor(0)+1 = 1, so 2×1d10 = 2
    const newHp = c.healUnitWithHerb(0);
    assert.equal(newHp, 7);                 // 5 + 2
    assert.equal(c.roster[0].hp, 7);
    assert.equal(c.resources.herbs, 2);
  });

  test('clamps healed hp to maxHp', () => {
    const c = makeCampaign();
    Math.random = () => 0.99;               // each d10 → 10, so heal of 20
    const newHp = c.healUnitWithHerb(0);
    assert.equal(newHp, 10);                // 5 + 20 clamped to maxHp 10
    assert.equal(c.roster[0].hp, 10);
    assert.equal(c.resources.herbs, 2);
  });

  test('no-op when the unit is already at full health (herbs unchanged)', () => {
    const c = makeCampaign();
    const r = c.healUnitWithHerb(1);        // index 1 is at 8/8
    assert.equal(r, null);
    assert.equal(c.roster[1].hp, 8);
    assert.equal(c.resources.herbs, 3);     // not spent
  });

  test('no-op when there are no herbs', () => {
    const c = makeCampaign();
    c.resources.herbs = 0;
    const r = c.healUnitWithHerb(0);
    assert.equal(r, null);
    assert.equal(c.roster[0].hp, 5);
    assert.equal(c.resources.herbs, 0);
  });

  test('no-op for an out-of-range index', () => {
    const c = makeCampaign();
    assert.equal(c.healUnitWithHerb(99), null);
    assert.equal(c.resources.herbs, 3);
  });

  test("'leader' sentinel heals the hero (heroStats)", () => {
    const c = makeCampaign();
    Math.random = () => 0.0;                 // heal of 2
    const newHp = c.healUnitWithHerb('leader');
    assert.equal(newHp, 42);                 // 40 + 2
    assert.equal(c.heroStats.hp, 42);
    assert.equal(c.resources.herbs, 2);
  });

  test('persists the heal to localStorage (survives a reload)', () => {
    const c = makeCampaign();
    Math.random = () => 0.0;                 // heal of 2
    c.healUnitWithHerb(0);

    const reloaded = new Campaign(fakeDef, 1);
    assert.equal(reloaded.load(), true);
    assert.equal(reloaded.roster[0].hp, 7);
    assert.equal(reloaded.resources.herbs, 2);
  });
});
