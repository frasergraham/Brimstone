// describePlanActionParts — the compact plan-panel step label (verb + optional
// target line). The panel groups steps under a per-unit header, so the label
// drops the actor name and hex coords; only attacks/sends carry a target.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describePlanActionParts } from '../src/ui-render.js';
import { PlanActionType } from '../src/planner.js';
import { EntityType } from '../src/entities.js';
import { ICON } from '../src/icons.js';

// Minimal snapshot entities (plain objects; range drives melee-vs-ranged).
const melee  = { id: 'h1', displayName: 'Ishmael', type: EntityType.PALADIN, range: 1, ownerId: 'p1' };
const ranged = { id: 'r1', displayName: 'Rook',    type: EntityType.ROGUE,   range: 3, ownerId: 'p1' };
const foe    = { id: 'z1', displayName: 'Goodwife Mercy', type: 'zombie', ownerId: 'p2' };
const leader = { id: 'l2', displayName: 'Aldous', type: EntityType.CAPTAIN, ownerId: 'p2' };
const ENTS   = [melee, ranged, foe, leader];

describe('describePlanActionParts', () => {
  test('MOVE is a bare verb — no coords, no target line', () => {
    const r = describePlanActionParts({ type: PlanActionType.MOVE, entityId: 'h1', toCol: 5, toRow: 3 }, ENTS);
    assert.deepEqual(r, { verb: 'Move', target: null });
  });

  test('simple verbs (guard/explore/fortify/summon/heal) carry no target', () => {
    for (const [type, verb] of [
      [PlanActionType.GUARD, 'Guard'], [PlanActionType.EXPLORE, 'Explore'],
      [PlanActionType.FORTIFY, 'Fortify'], [PlanActionType.SUMMON, 'Summon'],
      [PlanActionType.HEAL, 'Heal'], [PlanActionType.SOUND_HORN, 'Sound Horn'],
    ]) {
      assert.deepEqual(describePlanActionParts({ type, entityId: 'h1' }, ENTS), { verb, target: null });
    }
  });

  test('melee BATTLE_UNIT → "Attack" + target name on the second line', () => {
    const r = describePlanActionParts({ type: PlanActionType.BATTLE_UNIT, entityId: 'h1', targetId: 'z1' }, ENTS);
    assert.deepEqual(r, { verb: 'Attack', target: 'Goodwife Mercy' });
  });

  test('ranged attacker (range > 1) → "Ranged Attack"', () => {
    const r = describePlanActionParts({ type: PlanActionType.BATTLE_UNIT, entityId: 'r1', targetId: 'z1' }, ENTS);
    assert.deepEqual(r, { verb: 'Ranged Attack', target: 'Goodwife Mercy' });
  });

  test('getRange() method takes precedence over a plain range field', () => {
    const ents = [{ id: 'g1', displayName: 'Gunner', range: 1, getRange: () => 4 }, foe];
    const r = describePlanActionParts({ type: PlanActionType.BATTLE_UNIT, entityId: 'g1', targetId: 'z1' }, ents);
    assert.equal(r.verb, 'Ranged Attack');
  });

  test('BATTLE_HEX keeps the hex as the target (empty-hex shot)', () => {
    const r = describePlanActionParts({ type: PlanActionType.BATTLE_HEX, entityId: 'h1', targetCol: 4, targetRow: 7 }, ENTS);
    assert.deepEqual(r, { verb: 'Attack', target: '(4,7)' });
  });

  test('SENT_TO → "Send" + destination leader name (actor survivor is the header)', () => {
    const r = describePlanActionParts({ type: PlanActionType.SENT_TO, entityId: 'h1', destOwnerId: 'p2' }, ENTS);
    assert.deepEqual(r, { verb: 'Send', target: 'Aldous' });
  });

  test('USE_ITEM / EQUIP_WEAPON fold the item into the verb', () => {
    assert.deepEqual(
      describePlanActionParts({ type: PlanActionType.USE_ITEM, entityId: 'h1', item: 'Bandage' }, ENTS),
      { verb: 'Use Bandage', target: null });
    assert.deepEqual(
      describePlanActionParts({ type: PlanActionType.EQUIP_WEAPON, entityId: 'h1', weapon: 'Silver Sword' }, ENTS),
      { verb: 'Equip Silver Sword', target: null });
  });

  test('USE_ITEM on a known resource shows the glyph AND the name', () => {
    const r = describePlanActionParts({ type: PlanActionType.USE_ITEM, entityId: 'h1', item: 'herbs' }, ENTS);
    assert.match(r.verb, /Herbs/, 'includes the resource name');
    assert.ok(r.verb.includes(ICON.herb), 'includes the resource glyph');
  });

  test('unknown action type falls back to "Step N" (1-based)', () => {
    const r = describePlanActionParts({ type: 'NONSENSE', entityId: 'h1' }, ENTS, 2);
    assert.deepEqual(r, { verb: 'Step 3', target: null });
  });
});
