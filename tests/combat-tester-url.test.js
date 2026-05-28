// URL-state coverage for the Combat tester.
//
// parseCombatParams + withCombatParams are pure helpers; they round-trip
// a `{atk, def, atkAllies, defAllies}` config through the query string,
// coexist with `?tool=combat` (and any unrelated params), and accept an
// optional validator so the UI can drop stale unit keys before applying.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCombatParams, withCombatParams,
  parseToolParams, withToolParams,
} from '../src/tools/url-state.js';

// ── parseCombatParams ──────────────────────────────────────────────────

describe('parseCombatParams', () => {
  test('returns the null/empty shape for an empty / missing search', () => {
    const blank = { atk: null, def: null, atkAllies: [], defAllies: [] };
    assert.deepEqual(parseCombatParams(''),        blank);
    assert.deepEqual(parseCombatParams(undefined), blank);
    assert.deepEqual(parseCombatParams('?utm=x'),  blank);
  });

  test('extracts atk / def and ally lists; accepts a leading "?"', () => {
    assert.deepEqual(
      parseCombatParams('?atk=paladin&def=witch'),
      { atk: 'paladin', def: 'witch', atkAllies: [], defAllies: [] },
    );
    assert.deepEqual(
      parseCombatParams('atk=paladin&atkAllies=survivor,soldier&defAllies=minion'),
      { atk: 'paladin', def: null, atkAllies: ['survivor', 'soldier'], defAllies: ['minion'] },
    );
  });

  test('tolerates comma-encoded values (%2C) — the UI may receive either', () => {
    assert.deepEqual(
      parseCombatParams('?atkAllies=survivor%2Csoldier'),
      { atk: null, def: null, atkAllies: ['survivor', 'soldier'], defAllies: [] },
    );
  });

  test('drops empty / whitespace ally entries', () => {
    assert.deepEqual(
      parseCombatParams('?atkAllies=survivor,,  ,minion'),
      { atk: null, def: null, atkAllies: ['survivor', 'minion'], defAllies: [] },
    );
  });

  test('with isValidUnit predicate, unknown keys are filtered', () => {
    const known = new Set(['paladin', 'witch', 'survivor']);
    const isValid = (k) => known.has(k);
    // atk passes, def is unknown → null; ally list keeps the survivor only.
    assert.deepEqual(
      parseCombatParams('?atk=paladin&def=ghost&atkAllies=survivor,bogus', isValid),
      { atk: 'paladin', def: null, atkAllies: ['survivor'], defAllies: [] },
    );
  });

  test('coexists with ?tool=combat — combat-side parser ignores tool', () => {
    const parsed = parseCombatParams('?tool=combat&atk=paladin&def=witch');
    assert.equal(parsed.atk, 'paladin');
    assert.equal(parsed.def, 'witch');
    // And the tool-side parser still sees the tab.
    assert.equal(parseToolParams('?tool=combat&atk=paladin&def=witch').tool, 'combat');
  });
});

// ── withCombatParams ───────────────────────────────────────────────────

describe('withCombatParams', () => {
  test('sets atk/def and emits a leading "?"', () => {
    assert.equal(
      withCombatParams('', { atk: 'paladin', def: 'witch' }),
      '?atk=paladin&def=witch',
    );
  });

  test('null deletes the param', () => {
    assert.equal(
      withCombatParams('?atk=paladin&def=witch', { def: null }),
      '?atk=paladin',
    );
  });

  test('undefined leaves the param untouched (vs explicit null delete)', () => {
    assert.equal(
      withCombatParams('?atk=paladin&def=witch', { atk: 'rogue' /* def omitted */ }),
      '?atk=rogue&def=witch',
    );
  });

  test('ally arrays comma-join; empty array deletes the param', () => {
    assert.equal(
      withCombatParams('', { atkAllies: ['survivor', 'soldier'] }),
      '?atkAllies=survivor,soldier',
    );
    assert.equal(
      withCombatParams('?atkAllies=survivor,soldier', { atkAllies: [] }),
      '',
    );
  });

  test('empty config produces no params (no stray "?")', () => {
    assert.equal(withCombatParams('', {}), '');
    assert.equal(
      withCombatParams('?atk=paladin&def=witch&atkAllies=survivor',
        { atk: null, def: null, atkAllies: null, defAllies: null }),
      '',
    );
  });

  test('PRESERVES unrelated query params (utm=x etc.)', () => {
    const out = withCombatParams('?utm=src&debug=1', { atk: 'paladin' });
    const params = new URLSearchParams(out.slice(1));
    assert.equal(params.get('utm'), 'src');
    assert.equal(params.get('debug'), '1');
    assert.equal(params.get('atk'), 'paladin');
  });

  test('combat params coexist with ?tool=combat — tab activation preserved', () => {
    const out = withCombatParams('?tool=combat', { atk: 'paladin', def: 'witch' });
    const params = new URLSearchParams(out.slice(1));
    assert.equal(params.get('tool'), 'combat');
    assert.equal(params.get('atk'), 'paladin');
    assert.equal(params.get('def'), 'witch');
    // The reverse: writing ?tool via withToolParams keeps existing atk/def.
    const out2 = withToolParams('?atk=paladin&def=witch', { tool: 'combat' });
    const params2 = new URLSearchParams(out2.slice(1));
    assert.equal(params2.get('atk'), 'paladin');
    assert.equal(params2.get('def'), 'witch');
    assert.equal(params2.get('tool'), 'combat');
  });

  test('overwrites an existing value', () => {
    assert.equal(
      withCombatParams('?atk=paladin', { atk: 'rogue' }),
      '?atk=rogue',
    );
  });
});

// ── round-trip ─────────────────────────────────────────────────────────

describe('parseCombatParams ∘ withCombatParams round-trip', () => {
  test('atk/def-only config encodes and decodes losslessly', () => {
    const cfg = { atk: 'paladin', def: 'witch', atkAllies: [], defAllies: [] };
    const encoded = withCombatParams('', cfg);
    assert.deepEqual(parseCombatParams(encoded), cfg);
  });

  test('full config (allies on both sides) round-trips', () => {
    const cfg = {
      atk: 'paladin', def: 'witch',
      atkAllies: ['survivor', 'soldier'],
      defAllies: ['minion', 'wood_golem'],
    };
    const encoded = withCombatParams('', cfg);
    assert.deepEqual(parseCombatParams(encoded), cfg);
  });

  test('round-trip preserves unrelated params on the URL', () => {
    const start = '?tool=combat&utm=src';
    const encoded = withCombatParams(start,
      { atk: 'paladin', defAllies: ['minion'] });
    // unrelated params survive
    const ps = new URLSearchParams(encoded.slice(1));
    assert.equal(ps.get('tool'), 'combat');
    assert.equal(ps.get('utm'), 'src');
    // combat shape decodes correctly
    assert.deepEqual(parseCombatParams(encoded), {
      atk: 'paladin', def: null, atkAllies: [], defAllies: ['minion'],
    });
  });
});
