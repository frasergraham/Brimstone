// Tests for the simplified summoning mechanic: units spawn on the summoner's tile.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import { executeSummon, getValidActions, ActionType } from '../src/actions.js';
import { EntityType, createMinion } from '../src/entities.js';
import { ResourceType } from '../src/tiles.js';
import { PlanActionType, validatePlanAction } from '../src/planner.js';
import { hexKey, getNeighbors } from '../src/hex.js';

function freshState() {
  return new GameState(true, true);
}

// ── executeSummon: spawns on summoner tile ────────────────────────────────────

describe('executeSummon — spawns on summoner tile', () => {
  test('summoned minion appears at witch position', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.FOOD] = 2;
    const { col, row } = state.witch;

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true);
    const spawned = state.entities.find(e => e !== state.witch && e.col === col && e.row === row);
    assert.ok(spawned, 'Unit must spawn at witch col/row');
  });

  test('summoned iron golem appears at witch position', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.METAL] = 2;
    const { col, row } = state.witch;

    executeSummon(state, state.witch, EntityType.IRON_GOLEM);
    const spawned = state.entities.find(e => e.type === EntityType.IRON_GOLEM);
    assert.ok(spawned, 'Iron Golem should be spawned');
    assert.equal(spawned.col, col);
    assert.equal(spawned.row, row);
  });

  test('unit does NOT spawn at an adjacent hex', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.FOOD] = 2;
    const { col, row } = state.witch;
    const neighbors = getNeighbors(col, row).map(n => hexKey(n.col, n.row));

    executeSummon(state, state.witch);

    const offTile = state.entities.find(
      e => e !== state.witch && neighbors.includes(hexKey(e.col, e.row))
    );
    assert.equal(offTile, undefined, 'No unit should be summoned on an adjacent hex');
  });

  test('works even when all adjacent hexes are occupied', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.FOOD] = 2;
    // Fill all valid neighbors with minions
    for (const n of getNeighbors(state.witch.col, state.witch.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t) state.entities.push(createMinion(n.col, n.row, null));
    }
    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true, 'Summon must succeed regardless of adjacent occupancy');
  });

  test('multiple units can stack on witch tile', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.FOOD] = 6;
    const { col, row } = state.witch;

    executeSummon(state, state.witch);
    executeSummon(state, state.witch);

    const onTile = state.entities.filter(e => e !== state.witch && e.col === col && e.row === row);
    assert.equal(onTile.length, 2, 'Two units should be stacked on witch tile');
  });
});

// ── getValidActions: SUMMON no longer needs adjacent empty hex ────────────────

describe('getValidActions — SUMMON availability', () => {
  test('includes SUMMON actions when witch has >= 2 resources', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.FOOD] = 2;

    const actions = getValidActions(state, state.witch);
    const summons = actions.filter(a => a.type === ActionType.SUMMON);
    assert.ok(summons.length > 0, 'Should have at least one SUMMON action');
  });

  test('SUMMON available even when all adjacent hexes are occupied', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.FOOD] = 2;
    // Fill all valid neighbors
    for (const n of getNeighbors(state.witch.col, state.witch.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t) state.entities.push(createMinion(n.col, n.row, null));
    }

    const actions = getValidActions(state, state.witch);
    const summons = actions.filter(a => a.type === ActionType.SUMMON);
    assert.ok(summons.length > 0, 'SUMMON should be available regardless of neighbor occupancy');
  });

  test('no SUMMON actions when resources < 2', () => {
    const state = freshState();
    state.inventory.witch = { [ResourceType.FOOD]: 1 };

    const actions = getValidActions(state, state.witch);
    const summons = actions.filter(a => a.type === ActionType.SUMMON);
    assert.equal(summons.length, 0, 'No SUMMON when fewer than 2 total resources');
  });

  test('no SUMMON actions when resources = 0', () => {
    const state = freshState();
    state.inventory.witch = {};

    const actions = getValidActions(state, state.witch);
    const summons = actions.filter(a => a.type === ActionType.SUMMON);
    assert.equal(summons.length, 0, 'No SUMMON when no resources');
  });

  test('SUMMON actions have correct affordability flags', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.METAL] = 2;
    state.inventory.witch[ResourceType.WOOD] = 0;

    const actions = getValidActions(state, state.witch);
    const ironGolem = actions.find(a => a.type === ActionType.SUMMON && a.summonType === EntityType.IRON_GOLEM);
    const woodGolem = actions.find(a => a.type === ActionType.SUMMON && a.summonType === EntityType.WOOD_GOLEM);
    const minion    = actions.find(a => a.type === ActionType.SUMMON && a.summonType === EntityType.MINION);

    assert.ok(ironGolem?.affordable, 'Iron Golem should be affordable with 2 metal');
    assert.equal(woodGolem?.affordable, false, 'Wood Golem should not be affordable with 0 wood');
    assert.ok(minion?.affordable, 'Minion should be affordable with any 2 resources');
  });

  test('SUMMON actions have no targets array', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.FOOD] = 2;

    const actions = getValidActions(state, state.witch);
    const summons = actions.filter(a => a.type === ActionType.SUMMON);
    for (const s of summons) {
      assert.equal(s.targets, undefined, 'SUMMON actions should not have a targets array');
    }
  });

  test('hero cannot SUMMON', () => {
    const state = freshState();
    state.inventory.witch[ResourceType.FOOD] = 4;
    const actions = getValidActions(state, state.hero);
    const summons = actions.filter(a => a.type === ActionType.SUMMON);
    assert.equal(summons.length, 0, 'Hero should never have SUMMON actions');
  });
});

// ── validatePlanAction: SUMMON no longer requires toCol/toRow ─────────────────

describe('validatePlanAction — SUMMON', () => {
  test('valid with no toCol/toRow (new format)', () => {
    const state = freshState();
    const action = { type: PlanActionType.SUMMON, entityId: state.witch.id };
    const result = validatePlanAction(state, action, null);
    assert.equal(result.valid, true);
  });

  test('valid even when toCol/toRow are present (backwards compat)', () => {
    const state = freshState();
    const action = { type: PlanActionType.SUMMON, entityId: state.witch.id, toCol: 5, toRow: 3 };
    const result = validatePlanAction(state, action, null);
    assert.equal(result.valid, true);
  });
});
