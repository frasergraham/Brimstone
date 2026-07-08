// Tests for the weapons overhaul:
//  - range is weapon-derived (no innate unit range)
//  - new ranged weapons + retuned bow/crossbow
//  - faction starting weapons (createLeader)
//  - Magic Bolt faction restriction + loot exclusion
//  - once-per-round free equip
//  - swapLeaderToFaction transfers the starting weapon
//  - serialize/deserialize round-trips weapon, range, equippedThisRound

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ITEMS } from '../src/items.js';
import { createSurvivor, createHero } from '../src/entities.js';
import { getFaction } from '../src/factions.js';
import { executeUseItem, getValidActions, ActionType } from '../src/actions.js';
import { LOOT_CONFIG } from '../src/loot.config.js';
import { GameState } from '../src/game.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { hexKey } from '../src/hex.js';

function freshState() { return new GameState(true, true); }

// ── Range is weapon-derived ─────────────────────────────────────────────────

describe('weapons — weapon-derived range', () => {
  test('unarmed unit is melee (range 1)', () => {
    const s = createSurvivor(0, 0);
    assert.equal(s.getEquippedWeaponId(), null);
    assert.equal(s.getRange(), 1);
  });

  test('bow grants range 3, crossbow/musket/pistol/sling grant range 2', () => {
    const cases = { bow: 3, crossbow: 2, musket: 2, pistol: 2, sling: 2, magic_bolt: 2 };
    for (const [weapon, range] of Object.entries(cases)) {
      const e = createSurvivor(0, 0);
      e.equipWeapon(weapon);
      assert.equal(e.getRange(), range, `${weapon} should grant range ${range}`);
    }
  });

  test('melee weapons keep range 1', () => {
    for (const weapon of ['sword', 'axe', 'shield', 'staff', 'dagger']) {
      const e = createSurvivor(0, 0);
      e.equipWeapon(weapon);
      assert.equal(e.getRange(), 1, `${weapon} should stay melee`);
    }
  });

  test('unequipping a ranged weapon reverts to melee', () => {
    const e = createSurvivor(0, 0);
    e.equipWeapon('bow');
    assert.equal(e.getRange(), 3);
    e.equipWeapon(null);
    assert.equal(e.getRange(), 1);
  });
});

// ── Weapon stat tuning ──────────────────────────────────────────────────────

describe('weapons — stat tuning', () => {
  test('bow gives no attack bonus; crossbow +1; musket +2', () => {
    assert.equal(ITEMS.bow.statMods.attack, 0);
    assert.equal(ITEMS.crossbow.statMods.attack, 1);
    assert.equal(ITEMS.musket.statMods.attack, 2);
    assert.equal(ITEMS.pistol.statMods.attack, 1);
    assert.equal(ITEMS.sling.statMods.attack, 0);
  });

  test('equipping a musket raises effective ATK by 2', () => {
    // Measure the delta (survivors may roll an attack-modifying ability,
    // so compare unarmed vs musket rather than against the raw base field).
    const s = createSurvivor(0, 0);
    const before = s.getAttack();
    s.equipWeapon('musket');
    assert.equal(s.getAttack(), before + 2);
  });
});

// ── Faction starting weapons ────────────────────────────────────────────────

describe('weapons — faction starting loadout', () => {
  test('Paladin starts with a sword (effective ATK 4)', () => {
    const p = getFaction('hero').createLeader(0, 0, 'p1');
    assert.equal(p.getEquippedWeaponId(), 'sword');
    assert.equal(p.getAttack(), 4); // base 2 + sword 2
    assert.equal(p.getRange(), 1);
  });

  test('Rogue starts with a bow (range 3)', () => {
    const r = getFaction('rogue').createLeader(0, 0, 'p1');
    assert.equal(r.getEquippedWeaponId(), 'bow');
    assert.equal(r.getRange(), 3);
  });

  test('Witch and Necromancer start with Magic Bolt (range 2)', () => {
    const w = getFaction('witch').createLeader(0, 0, 'p1');
    assert.equal(w.getEquippedWeaponId(), 'magic_bolt');
    assert.equal(w.getRange(), 2);
    const n = getFaction('necromancer').createLeader(0, 0, 'p1');
    assert.equal(n.getEquippedWeaponId(), 'magic_bolt');
    assert.equal(n.getRange(), 2);
  });

  test('Captain starts with the day-side sword; Brute starts unarmed', () => {
    // The Captain inherits the paladin's sword but sits well below him in
    // base stats (70 HP / ATK 1) — his strength is troops, not the blade.
    const c = getFaction('captain').createLeader(0, 0, 'p1');
    assert.equal(c.getEquippedWeaponId(), 'sword');
    assert.equal(c.getRange(), 1);
    assert.equal(getFaction('brute').createLeader(0, 0, 'p1').getEquippedWeaponId(), null);
  });
});

// ── Magic Bolt gating ───────────────────────────────────────────────────────

describe('weapons — Magic Bolt restriction', () => {
  test('only witch and necromancer can equip Magic Bolt', () => {
    assert.equal(getFaction('witch').canEquipWeaponItem('magic_bolt'), true);
    assert.equal(getFaction('necromancer').canEquipWeaponItem('magic_bolt'), true);
    assert.equal(getFaction('hero').canEquipWeaponItem('magic_bolt'), false);
    assert.equal(getFaction('rogue').canEquipWeaponItem('magic_bolt'), false);
    assert.equal(getFaction('captain').canEquipWeaponItem('magic_bolt'), false);
  });

  test('Magic Bolt is flagged noLoot and never appears in any loot table', () => {
    assert.equal(ITEMS.magic_bolt.noLoot, true);
    const allEntries = [
      ...Object.values(LOOT_CONFIG.buildings).flat(),
      ...Object.values(LOOT_CONFIG.terrain).flat(),
    ];
    assert.ok(!allEntries.some(e => e.type === 'magic_bolt'),
      'magic_bolt must not be a loot drop');
  });
});

// ── Once-per-round free equip ───────────────────────────────────────────────

describe('weapons — once-per-round equip', () => {
  test('a unit may equip only one weapon per round; resetTurn clears the gate', () => {
    const state = freshState();
    const s = createSurvivor(0, 0);
    s.owner = 'hero';
    s.items = { sword: { count: 1 }, dagger: { count: 1 } };
    state.entities.push(s);

    const first = executeUseItem(state, s, 'sword');
    assert.equal(first.success, true);
    assert.equal(s.getEquippedWeaponId(), 'sword');
    assert.equal(s.equippedThisRound, true);

    const second = executeUseItem(state, s, 'dagger');
    assert.equal(second.success, false, 'second equip in the same round is refused');
    assert.equal(s.getEquippedWeaponId(), 'sword', 'weapon unchanged after refused equip');
    assert.equal(s.getItemCount('dagger'), 1, 'refused equip does not consume the item');

    s.resetTurn();
    assert.equal(s.equippedThisRound, false);
    const third = executeUseItem(state, s, 'dagger');
    assert.equal(third.success, true, 'equip allowed again next round');
    assert.equal(s.getEquippedWeaponId(), 'dagger');
  });

  test('equip is a free action (cost 0)', () => {
    const state = freshState();
    const s = createSurvivor(0, 0);
    s.owner = 'hero';
    s.items = { sword: { count: 1 } };
    state.entities.push(s);
    const r = executeUseItem(state, s, 'sword');
    assert.equal(r.cost, 0);
  });
});

// ── Any wielder becomes ranged ──────────────────────────────────────────────

describe('weapons — any wielder becomes ranged', () => {
  test('a plain survivor with a bow can target an enemy 3 hexes away', () => {
    const state = freshState();
    state.fogOfWar = 'none'; // make the distant target visible so BATTLE surfaces
    const archer = createSurvivor(5, 5);
    archer.owner = 'hero';
    archer.equipWeapon('bow');
    state.entities.push(archer);

    // Drop a witch-side target 3 hexes east (same row, +3 cols = distance 3).
    const target = createSurvivor(8, 5);
    target.owner = 'witch';
    state.entities.push(target);

    const actions = getValidActions(state, archer);
    const battle = actions.find(a => a.type === ActionType.BATTLE);
    assert.ok(battle, 'archer should have a BATTLE action');
    assert.ok(battle.targets.some(t => t.id === target.id),
      'target 3 hexes away should be in range for a bow wielder');

    // A melee (unarmed) unit at the same spot cannot reach 3 hexes.
    const meleeUnit = createSurvivor(5, 5);
    meleeUnit.owner = 'hero';
    state.entities.push(meleeUnit);
    const meleeActions = getValidActions(state, meleeUnit);
    const meleeBattle = meleeActions.find(a => a.type === ActionType.BATTLE);
    assert.ok(!meleeBattle || !meleeBattle.targets.some(t => t.id === target.id),
      'an unarmed unit should NOT reach a target 3 hexes away');
  });
});

// ── swapLeaderToFaction transfers the weapon ────────────────────────────────

describe('weapons — leader faction swap', () => {
  test('Paladin → Rogue swap adopts the bow (drops the sword)', () => {
    const state = freshState();
    assert.equal(state.hero.getEquippedWeaponId(), 'sword'); // default day leader is the paladin
    state.swapLeaderToFaction('day', 'rogue');
    assert.equal(state.hero.getEquippedWeaponId(), 'bow');
    assert.equal(state.hero.getRange(), 3);
  });
});

// ── Serialization round-trip ────────────────────────────────────────────────

describe('weapons — serialize/deserialize', () => {
  test('equipped weapon, derived range, and equippedThisRound survive a round-trip', () => {
    const state = freshState();
    const archer = createSurvivor(5, 5);
    archer.owner = 'hero';
    archer.equipWeapon('crossbow');
    archer.equippedThisRound = true;
    state.entities.push(archer);

    const restored = deserializeState(serializeState(state));
    const copy = restored.entities.find(e => e.id === archer.id);
    assert.ok(copy);
    assert.equal(copy.getEquippedWeaponId(), 'crossbow');
    assert.equal(copy.getRange(), 2, 'range composes from the equipped weapon');
    assert.equal(copy.equippedThisRound, true);
  });
});
