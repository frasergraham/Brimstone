// Parity tests for the UNIT_TYPES / ITEMS / ABILITIES registries.
// Phase 1 of the units/items/abilities refactor — these registries are
// now the single source of truth; existing tables (BASE_STATS,
// BASE_AGILITY, ENTITY_COLOR, WEAPON_STATS, WEAPON_LABEL,
// SurvivorAbility) derive from them. This file guards that derivation.
// See docs/design/units-items-abilities-refactor.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIT_TYPES } from '../src/unit-types.js';
import { ITEMS } from '../src/items.js';
import { ABILITIES, SurvivorAbility as RegistrySurvivorAbility } from '../src/abilities.js';
import { BASE_AGILITY, ENTITY_COLOR, EntityType, SurvivorAbility } from '../src/entities.js';
import { WEAPON_STATS, WEAPON_LABEL } from '../src/tiles.js';

test('UNIT_TYPES: every EntityType value has a descriptor', () => {
  const types = [...new Set(Object.values(EntityType))]; // de-dupe HERO alias
  for (const t of types) {
    assert.ok(UNIT_TYPES[t], `missing UNIT_TYPES[${t}]`);
    const d = UNIT_TYPES[t];
    assert.ok(d.baseStats, `UNIT_TYPES[${t}].baseStats missing`);
    assert.equal(typeof d.baseStats.maxHp, 'number');
    assert.equal(typeof d.baseStats.attack, 'number');
    assert.equal(typeof d.baseStats.defense, 'number');
    assert.equal(typeof d.agility, 'number');
    assert.equal(typeof d.color, 'string');
    assert.ok(Array.isArray(d.tags));
  }
});

test('BASE_AGILITY derives from UNIT_TYPES.agility', () => {
  for (const [t, a] of Object.entries(BASE_AGILITY)) {
    assert.equal(a, UNIT_TYPES[t].agility, `BASE_AGILITY[${t}] mismatch`);
  }
  assert.equal(
    Object.keys(BASE_AGILITY).length,
    Object.keys(UNIT_TYPES).length,
    'BASE_AGILITY key count must match UNIT_TYPES',
  );
});

test('ENTITY_COLOR derives from UNIT_TYPES.color', () => {
  for (const [t, c] of Object.entries(ENTITY_COLOR)) {
    assert.equal(c, UNIT_TYPES[t].color, `ENTITY_COLOR[${t}] mismatch`);
  }
});

test('ITEMS: every weapon has statMods and a label', () => {
  const weapons = Object.values(ITEMS).filter(i => i.kind === 'weapon');
  assert.ok(weapons.length > 0, 'no weapons registered');
  for (const w of weapons) {
    assert.equal(typeof w.id, 'string');
    assert.equal(w.slot, 'weapon');
    assert.ok(w.statMods, `${w.id} missing statMods`);
    assert.equal(typeof w.label, 'string');
  }
});

test('WEAPON_STATS derives from ITEMS weapon entries', () => {
  for (const [id, stats] of Object.entries(WEAPON_STATS)) {
    const item = ITEMS[id];
    assert.ok(item, `ITEMS[${id}] missing`);
    assert.equal(item.statMods?.attack ?? 0, stats.attackBonus, `${id} attack mismatch`);
    assert.equal(item.statMods?.defense ?? 0, stats.defenseBonus, `${id} defense mismatch`);
  }
});

test('WEAPON_LABEL derives from ITEMS[id].label', () => {
  for (const [id, label] of Object.entries(WEAPON_LABEL)) {
    assert.equal(ITEMS[id].label, label, `${id} label mismatch`);
  }
});

test('ABILITIES: every entry has id / kind / label', () => {
  for (const [id, a] of Object.entries(ABILITIES)) {
    assert.equal(a.id, id, `ABILITIES[${id}].id mismatch`);
    assert.ok(a.kind === 'passive' || a.kind === 'active', `${id} kind must be passive|active`);
    assert.equal(typeof a.label, 'string');
  }
});

test('SurvivorAbility re-exports the ABILITIES-derived enum', () => {
  // Same object identity — the entities.js export is a pass-through.
  assert.deepEqual({ ...SurvivorAbility }, { ...RegistrySurvivorAbility });
  // Every ability id is reachable via SurvivorAbility
  for (const id of Object.keys(ABILITIES)) {
    assert.ok(
      Object.values(SurvivorAbility).includes(id),
      `SurvivorAbility missing value ${id}`,
    );
  }
  // Every SurvivorAbility value is a registered ability
  for (const v of Object.values(SurvivorAbility)) {
    assert.ok(ABILITIES[v], `ABILITIES[${v}] missing for SurvivorAbility value`);
  }
});
