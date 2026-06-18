// Campaign.carryFromInventory: units carry up to WEAPON_CARRY_CAP (2) weapons
// drawn from the shared armory, swappable mid-mission. Drawing the first
// auto-equips; a second is carried without displacing the first; a third is
// rejected.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

let Campaign, snapshotSurvivor, WEAPON_CARRY_CAP, CAMPAIGNS, createSurvivor;
before(async () => {
  ({ Campaign, snapshotSurvivor, WEAPON_CARRY_CAP } = await import('../src/campaign/campaign.js'));
  ({ CAMPAIGNS } = await import('../src/campaign/campaign-registry.js'));
  ({ createSurvivor } = await import('../src/entities.js'));
});

function freshCampaign() {
  const camp = CAMPAIGNS.find(c => !c.disabled) || CAMPAIGNS[0];
  const c = new Campaign(camp, 9); // throwaway test slot
  c.load();
  const surv = snapshotSurvivor(createSurvivor(0, 0, 'hero'));
  surv.items = {};                       // empty backpack
  c.roster = [surv];
  c.weapons = { sword: 1, axe: 1, musket: 1 };
  return c;
}

describe('Campaign.carryFromInventory (2-weapon carry cap)', () => {
  test('draws a weapon from the pool and auto-equips the first', () => {
    const c = freshCampaign();
    const r = c.carryFromInventory(0, 'sword');
    assert.equal(r.success, true);
    assert.equal(c.roster[0].items.sword?.count, 1);
    assert.equal(c.roster[0].items.sword?.equipped, true);
    assert.ok(!c.weapons.sword, 'sword left the shared pool');
  });

  test('carries a second weapon without unequipping the first', () => {
    const c = freshCampaign();
    c.carryFromInventory(0, 'sword');
    const r = c.carryFromInventory(0, 'axe');
    assert.equal(r.success, true);
    assert.ok(c.roster[0].items.sword, 'first weapon still carried');
    assert.ok(c.roster[0].items.axe, 'second weapon carried');
    assert.equal(c.roster[0].items.sword.equipped, true, 'first stays equipped');
    assert.ok(!c.roster[0].items.axe.equipped, 'second is a spare');
  });

  test('rejects a third weapon once at WEAPON_CARRY_CAP', () => {
    assert.equal(WEAPON_CARRY_CAP, 2);
    const c = freshCampaign();
    c.carryFromInventory(0, 'sword');
    c.carryFromInventory(0, 'axe');
    const r = c.carryFromInventory(0, 'musket');
    assert.equal(r.success, false);
    assert.equal(r.reason, 'full');
    assert.ok(c.weapons.musket, 'rejected weapon stays in the pool');
  });

  test('a non-pool or non-weapon id is a no-op', () => {
    const c = freshCampaign();
    assert.equal(c.carryFromInventory(0, 'horn').success, false); // not a weapon
    assert.equal(c.carryFromInventory(0, 'greatsword_not_in_pool').success, false);
  });
});
