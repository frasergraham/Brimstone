// Tests for chronicle three-state mode cycling and logText helper.
// These tests exercise the pure logic without requiring a DOM.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── _logText helper (extracted for unit testing) ──────────────────────────

function logText(entry) {
  return typeof entry === 'string' ? entry : entry.text;
}

describe('logText — handles plain strings and {text,owner} objects', () => {
  test('plain string is returned as-is', () => {
    assert.equal(logText('Hero moves north.'), 'Hero moves north.');
  });

  test('{text,owner} object returns .text property', () => {
    assert.equal(logText({ text: 'Witch summons minion.', owner: 'witch' }), 'Witch summons minion.');
  });

  test('{text} without owner still returns .text', () => {
    assert.equal(logText({ text: 'Scoring: Witch holds 2 nodes.' }), 'Scoring: Witch holds 2 nodes.');
  });
});

// ── Chronicle mode cycling ─────────────────────────────────────────────────

const CHRONICLE_MODES = ['none', 'mini', 'full'];

function cycleMode(current) {
  const idx = CHRONICLE_MODES.indexOf(current);
  return CHRONICLE_MODES[(idx + 1) % CHRONICLE_MODES.length];
}

describe('chronicle mode cycling', () => {
  test('none → mini', () => {
    assert.equal(cycleMode('none'), 'mini');
  });

  test('mini → full', () => {
    assert.equal(cycleMode('mini'), 'full');
  });

  test('full → none', () => {
    assert.equal(cycleMode('full'), 'none');
  });

  test('full cycle returns to origin after 3 steps', () => {
    let mode = 'mini';
    mode = cycleMode(mode);
    mode = cycleMode(mode);
    mode = cycleMode(mode);
    assert.equal(mode, 'mini');
  });
});

// ── Visible log filtering (fog-of-war logic) ──────────────────────────────

function visibleLog(log, fogOfWar, myFaction) {
  if (!fogOfWar) return log;
  return log.filter(entry => {
    if (typeof entry === 'string') return true;
    return !entry.owner || entry.owner === myFaction;
  });
}

describe('visibleLog — fog-of-war filtering', () => {
  const log = [
    'Tiles revealed.',                           // untagged — always visible
    { text: 'Hero explores.', owner: 'hero' },
    { text: 'Witch summons.', owner: 'witch' },
    { text: 'Attrition rises.' },                // no owner — always visible
  ];

  test('no fog: all entries visible', () => {
    assert.equal(visibleLog(log, false, 'hero').length, 4);
  });

  test('fog hero: untagged + hero-owned + no-owner entries visible', () => {
    const visible = visibleLog(log, true, 'hero');
    assert.equal(visible.length, 3);
    assert.ok(visible.includes(log[0]));    // untagged string
    assert.ok(visible.includes(log[1]));    // hero entry
    assert.ok(visible.includes(log[3]));    // no-owner object
    assert.ok(!visible.includes(log[2]));   // witch entry excluded
  });

  test('fog witch: untagged + witch-owned + no-owner entries visible', () => {
    const visible = visibleLog(log, true, 'witch');
    assert.equal(visible.length, 3);
    assert.ok(!visible.includes(log[1]));   // hero entry excluded
    assert.ok(visible.includes(log[2]));    // witch entry included
  });
});

// ── logEntryModifier — CSS class selection ────────────────────────────────

function logEntryModifier(entry) {
  if (typeof entry === 'string') {
    return /^Round \d+/.test(entry) ? 'log-round-separator' : '';
  }
  if (entry.owner === 'hero') return 'log-hero';
  if (entry.owner === 'witch') return 'log-witch';
  return '';
}

describe('logEntryModifier — returns CSS modifier class for log entries', () => {
  test('plain string returns empty', () => {
    assert.equal(logEntryModifier('Hero moves north.'), '');
  });

  test('round header returns log-round-separator', () => {
    assert.equal(logEntryModifier('Round 3 — ☀ DAY'), 'log-round-separator');
  });

  test('round 12 also matches', () => {
    assert.equal(logEntryModifier('Round 12 — 🌙 NIGHT'), 'log-round-separator');
  });

  test('hero-owned entry returns log-hero', () => {
    assert.equal(logEntryModifier({ text: 'Hero explores.', owner: 'hero' }), 'log-hero');
  });

  test('witch-owned entry returns log-witch', () => {
    assert.equal(logEntryModifier({ text: 'Witch summons minion.', owner: 'witch' }), 'log-witch');
  });

  test('object with no owner returns empty', () => {
    assert.equal(logEntryModifier({ text: 'Attrition rises.' }), '');
  });

  test('object with undefined owner returns empty', () => {
    assert.equal(logEntryModifier({ text: 'Scoring update.', owner: undefined }), '');
  });

  test('string not starting with Round returns empty', () => {
    assert.equal(logEntryModifier('Rounding up survivors...'), '');
  });
});
