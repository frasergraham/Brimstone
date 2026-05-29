// Tests for the loot configuration (src/loot.config.js).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOT_CONFIG } from '../src/loot.config.js';

describe('loot config — no horse drops', () => {
  // Horses are disabled as a procedural loot drop until per-unit-skeleton
  // animation support ships. The HORSE concept itself still exists (older
  // saves / authored missions keep working) — we just never roll a NEW one.
  // Pinned: re-enabling horse loot must be a deliberate edit that updates
  // this assertion, not an accidental table tweak.
  const allTables = [
    ...Object.entries(LOOT_CONFIG.buildings).map(([k, t]) => [`buildings.${k}`, t]),
    ...Object.entries(LOOT_CONFIG.terrain).map(([k, t]) => [`terrain.${k}`, t]),
  ];

  test('no weighted loot table includes a horse entry', () => {
    for (const [name, table] of allTables) {
      const horseEntry = table.find(e => e.type === 'horse' || e.type === 'HORSE');
      assert.equal(
        horseEntry, undefined,
        `${name} should not roll a horse (found: ${JSON.stringify(horseEntry)})`,
      );
    }
  });

  test('every table still has at least one entry with positive weight', () => {
    // Removing horse must not leave an empty / zero-weight table that the
    // roller can't resolve.
    for (const [name, table] of allTables) {
      assert.ok(table.length > 0, `${name} is empty`);
      const sum = table.reduce((s, e) => s + e.weight, 0);
      assert.ok(sum > 0, `${name} has no positive weight`);
    }
  });
});
