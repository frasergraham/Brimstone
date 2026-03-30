import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_HERO_NAMES, AI_WITCH_NAMES, pickAIName } from '../src/ai-names.js';

describe('pickAIName', () => {
  test('returns a name from the hero pool', () => {
    const name = pickAIName('hero', new Set());
    assert.ok(AI_HERO_NAMES.includes(name), `expected hero name, got "${name}"`);
  });

  test('returns a name from the witch pool', () => {
    const name = pickAIName('witch', new Set());
    assert.ok(AI_WITCH_NAMES.includes(name), `expected witch name, got "${name}"`);
  });

  test('never returns duplicates within a pool', () => {
    const used = new Set();
    const names = [];
    for (let i = 0; i < AI_HERO_NAMES.length; i++) {
      names.push(pickAIName('hero', used));
    }
    assert.equal(new Set(names).size, AI_HERO_NAMES.length,
      'should produce all unique names');
  });

  test('falls back to numbered names when pool is exhausted', () => {
    const used = new Set();
    // Exhaust the pool
    for (let i = 0; i < AI_WITCH_NAMES.length; i++) {
      pickAIName('witch', used);
    }
    const fallback = pickAIName('witch', used);
    assert.ok(fallback.startsWith('AI Witch #'), `expected fallback, got "${fallback}"`);
  });

  test('adds picked name to usedNames set', () => {
    const used = new Set();
    const name = pickAIName('hero', used);
    assert.ok(used.has(name), 'picked name should be in usedNames');
  });
});
