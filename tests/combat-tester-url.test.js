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
    const blank = { atk: null, def: null, atkAllies: [], defAllies: [], speed: 'cinematic' };
    assert.deepEqual(parseCombatParams(''),        blank);
    assert.deepEqual(parseCombatParams(undefined), blank);
    assert.deepEqual(parseCombatParams('?utm=x'),  blank);
  });

  test('extracts atk / def and ally lists; accepts a leading "?"', () => {
    assert.deepEqual(
      parseCombatParams('?atk=paladin&def=witch'),
      { atk: 'paladin', def: 'witch', atkAllies: [], defAllies: [], speed: 'cinematic' },
    );
    assert.deepEqual(
      parseCombatParams('atk=paladin&atkAllies=survivor,soldier&defAllies=minion'),
      { atk: 'paladin', def: null, atkAllies: ['survivor', 'soldier'], defAllies: ['minion'], speed: 'cinematic' },
    );
  });

  test('tolerates comma-encoded values (%2C) — the UI may receive either', () => {
    assert.deepEqual(
      parseCombatParams('?atkAllies=survivor%2Csoldier'),
      { atk: null, def: null, atkAllies: ['survivor', 'soldier'], defAllies: [], speed: 'cinematic' },
    );
  });

  test('drops empty / whitespace ally entries', () => {
    assert.deepEqual(
      parseCombatParams('?atkAllies=survivor,,  ,minion'),
      { atk: null, def: null, atkAllies: ['survivor', 'minion'], defAllies: [], speed: 'cinematic' },
    );
  });

  test('with isValidUnit predicate, unknown keys are filtered', () => {
    const known = new Set(['paladin', 'witch', 'survivor']);
    const isValid = (k) => known.has(k);
    // atk passes, def is unknown → null; ally list keeps the survivor only.
    assert.deepEqual(
      parseCombatParams('?atk=paladin&def=ghost&atkAllies=survivor,bogus', isValid),
      { atk: 'paladin', def: null, atkAllies: ['survivor'], defAllies: [], speed: 'cinematic' },
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
    const cfg = { atk: 'paladin', def: 'witch', atkAllies: [], defAllies: [], speed: 'cinematic' };
    const encoded = withCombatParams('', cfg);
    assert.deepEqual(parseCombatParams(encoded), cfg);
  });

  test('full config (allies on both sides) round-trips', () => {
    const cfg = {
      atk: 'paladin', def: 'witch',
      atkAllies: ['survivor', 'soldier'],
      defAllies: ['minion', 'wood_golem'],
      speed: 'cinematic',
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
      atk: 'paladin', def: null, atkAllies: [], defAllies: ['minion'], speed: 'cinematic',
    });
  });
});

// ── speed param ─────────────────────────────────────────────────────────

describe('parseCombatParams — speed', () => {
  test('absent param defaults to cinematic', () => {
    assert.equal(parseCombatParams('').speed, 'cinematic');
    assert.equal(parseCombatParams('?atk=paladin').speed, 'cinematic');
  });

  test('valid values round-trip as-is', () => {
    assert.equal(parseCombatParams('?speed=cinematic').speed, 'cinematic');
    assert.equal(parseCombatParams('?speed=fast').speed,      'fast');
    assert.equal(parseCombatParams('?speed=vfast').speed,     'vfast');
  });

  test('invalid value falls back to cinematic', () => {
    assert.equal(parseCombatParams('?speed=ludicrous').speed, 'cinematic');
    assert.equal(parseCombatParams('?speed=').speed,          'cinematic');
    assert.equal(parseCombatParams('?speed=CINEMATIC').speed, 'cinematic',
      'case-sensitive — uppercase is rejected and falls back');
  });
});

describe('withCombatParams — speed', () => {
  test('explicit fast / vfast write the param', () => {
    assert.equal(withCombatParams('', { speed: 'fast' }),  '?speed=fast');
    assert.equal(withCombatParams('', { speed: 'vfast' }), '?speed=vfast');
  });

  test('cinematic is the default — the param is dropped to keep URLs tidy', () => {
    assert.equal(withCombatParams('?speed=fast', { speed: 'cinematic' }), '');
    assert.equal(withCombatParams('', { speed: 'cinematic' }), '');
  });

  test('undefined leaves the existing speed untouched', () => {
    assert.equal(
      withCombatParams('?speed=fast', { atk: 'paladin' }),
      '?speed=fast&atk=paladin',
    );
  });

  test('null deletes the speed param', () => {
    assert.equal(withCombatParams('?speed=fast', { speed: null }), '');
  });

  test('round-trips alongside combatant slots', () => {
    const cfg = {
      atk: 'paladin', def: 'witch',
      atkAllies: ['survivor'], defAllies: ['minion'],
      speed: 'vfast',
    };
    const encoded = withCombatParams('', cfg);
    assert.deepEqual(parseCombatParams(encoded), cfg);
  });
});
