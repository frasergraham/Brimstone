// Tests for the campaign unlock-criterion builder (src/tools/unlock-fields.js):
// rows ↔ criterion round-trips, so the typed UI faithfully replaces JSON.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { criterionToRows, rowsToCriterion, blankRow } from '../src/tools/unlock-fields.js';

const roundtrip = (unlock) => {
  const { combinator, rows } = criterionToRows(unlock);
  return rowsToCriterion(combinator, rows);
};

describe('unlock-fields / round-trip', () => {
  test('null ⇄ empty', () => {
    assert.equal(roundtrip(null), null);
  });

  test('single leaf is preserved without wrapping', () => {
    assert.deepEqual(roundtrip({ missionDone: 'long_watch' }), { missionDone: 'long_watch' });
    assert.deepEqual(roundtrip({ level: 3 }), { level: 3 });
  });

  test('all (AND)', () => {
    const c = { all: [{ missionDone: 'a' }, { hasItem: 'key' }] };
    assert.deepEqual(roundtrip(c), c);
  });

  test('any (OR)', () => {
    const c = { any: [{ missionDone: 'a' }, { level: 5 }] };
    assert.deepEqual(roundtrip(c), c);
  });

  test('flag with equals', () => {
    assert.deepEqual(roundtrip({ flag: 'ending', equals: 'dark' }), { flag: 'ending', equals: 'dark' });
  });

  test('resource with atLeast', () => {
    assert.deepEqual(roundtrip({ resource: 'silver', atLeast: 3 }), { resource: 'silver', atLeast: 3 });
  });

  test('array sugar normalizes to all', () => {
    assert.deepEqual(roundtrip([{ missionDone: 'a' }, { missionDone: 'b' }]),
      { all: [{ missionDone: 'a' }, { missionDone: 'b' }] });
  });

  test('nested combinators are preserved as an advanced row', () => {
    const c = { all: [{ missionDone: 'a' }, { any: [{ hasItem: 'k' }, { level: 2 }] }] };
    const { combinator, rows } = criterionToRows(c);
    assert.equal(combinator, 'all');
    assert.ok(rows.some((r) => r.type === '__advanced'), 'nested any kept as advanced row');
    assert.deepEqual(rowsToCriterion(combinator, rows), c);
  });

  test('anyOf threshold form is preserved verbatim as an advanced row', () => {
    const top = { anyOf: { count: 3, of: ['mA', 'mB', 'mC', 'mD', 'mE'] } };
    const { rows } = criterionToRows(top);
    assert.ok(rows.some((r) => r.type === '__advanced'), 'top-level anyOf kept as advanced');
    assert.deepEqual(roundtrip(top), top);

    // anyOf nested inside an all[] also survives the flat editor untouched.
    const nested = { all: [{ missionDone: 'a' }, { anyOf: { count: 2, of: ['x', 'y'] } }] };
    assert.deepEqual(roundtrip(nested), nested);
  });

  test('empty-valued rows are dropped', () => {
    const rows = [{ type: 'missionDone', value: '' }, { type: 'hasItem', value: 'key' }];
    assert.deepEqual(rowsToCriterion('all', rows), { hasItem: 'key' });
  });

  test('blankRow defaults', () => {
    assert.deepEqual(blankRow('missionDone'), { type: 'missionDone', value: '' });
    assert.deepEqual(blankRow('resource'), { type: 'resource', value: '', atLeast: 1 });
  });
});
