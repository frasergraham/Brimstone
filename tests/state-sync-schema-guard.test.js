// Schema guard for server/state-sync.js.
//
// serializeState() maintains a manual field list — a new GameState or Entity
// field that isn't added there is silently dropped in online games, saves,
// and resumes (the known failure mode called out in CLAUDE.md Guideline 5).
//
// This guard enumerates the live fields of a freshly constructed GameState
// (and its entities) and requires every field to be either:
//   • referenced in server/state-sync.js source (serialized or explicitly
//     hydrated on deserialize), or
//   • listed in the transient allowlist below with a justification.
//
// If this test fails for a field you just added: serialize it in
// serializeState() AND restore it in deserializeState(), or — only if it is
// genuinely per-session scratch — add it to the allowlist with a comment.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { GameState } from '../src/game.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateSyncSrc = readFileSync(join(__dirname, '..', 'server', 'state-sync.js'), 'utf8');

// Fields that are intentionally NOT serialized. Every entry needs a reason.
const TRANSIENT_STATE_FIELDS = new Set([
  // Per-round tutorial dice queue — re-populated by the mission conductor each
  // planning phase (documented in serializeState).
  'forcedDice',
  // Campaign mission config — re-applied from the mission JSON by the
  // campaign loader on resume (src/main.js resumeCampaignMission).
  'lootOverrides',
  // Campaign victory hook — a function; re-attached by the mission conductor.
  'victoryDelegate',
  // Map-generation scratch used only when placing hidden survivors at game
  // start; resumed games fall back to safe defaults in game.js.
  '_survivorCounts', '_heroStart', '_witchStart',
  // Offline-mode UI selection state — never meaningful across the wire.
  'selectedEntity', 'pendingAction',
]);

const TRANSIENT_ENTITY_FIELDS = new Set([
  // (none currently — every Entity field must round-trip or be hydrated)
]);

function fieldReferenced(prefix, field) {
  // Treat a field as handled if state-sync.js mentions it as a property
  // access on the serialized/deserialized object (state.X, e.X, snap.X, X:).
  return new RegExp(`[\\w)\\]]\\.${field}\\b`).test(stateSyncSrc)
      || new RegExp(`\\b${field}\\s*:`).test(stateSyncSrc);
}

describe('state-sync schema guard', () => {
  test('every GameState field is serialized or explicitly transient', () => {
    const state = new GameState(true, true);
    const missing = Object.keys(state).filter(k =>
      !TRANSIENT_STATE_FIELDS.has(k) && !fieldReferenced('state', k));
    assert.deepEqual(missing, [],
      `GameState field(s) not handled by server/state-sync.js: ${missing.join(', ')}. ` +
      `Serialize them in serializeState() + deserializeState(), or add them to ` +
      `TRANSIENT_STATE_FIELDS in this test with a justification.`);
  });

  test('every Entity field is serialized or explicitly transient', () => {
    const state = new GameState(true, true);
    const keys = new Set();
    for (const e of state.entities) for (const k of Object.keys(e)) keys.add(k);
    const missing = [...keys].filter(k =>
      !TRANSIENT_ENTITY_FIELDS.has(k) && !fieldReferenced('e', k));
    assert.deepEqual(missing, [],
      `Entity field(s) not handled by server/state-sync.js: ${missing.join(', ')}. ` +
      `Serialize them in the entity block of serializeState() (and restore/hydrate ` +
      `in deserializeState()), or add them to TRANSIENT_ENTITY_FIELDS with a justification.`);
  });

  test('allowlists only contain fields that still exist', () => {
    // Prevents the allowlist from rotting as fields are removed/renamed.
    const state = new GameState(true, true);
    const stateKeys = new Set(Object.keys(state));
    for (const f of TRANSIENT_STATE_FIELDS) {
      assert.ok(stateKeys.has(f),
        `TRANSIENT_STATE_FIELDS lists '${f}' which no longer exists on GameState — remove it`);
    }
    const entityKeys = new Set();
    for (const e of state.entities) for (const k of Object.keys(e)) entityKeys.add(k);
    for (const f of TRANSIENT_ENTITY_FIELDS) {
      assert.ok(entityKeys.has(f),
        `TRANSIENT_ENTITY_FIELDS lists '${f}' which no longer exists on Entity — remove it`);
    }
  });

  test('hasTag() still works after a serialize → deserialize round-trip', () => {
    // tags is derived from UNIT_TYPES in the Entity constructor, which
    // deserializeState bypasses — it must be hydrated on restore or
    // leader-tag checks (abilities targeting, leader-death effects) silently
    // fail in resumed games.
    const state = new GameState(true, true);
    const restored = deserializeState(serializeState(state));
    const hero = restored.entities.find(e => e.id === state.hero.id);
    const witch = restored.entities.find(e => e.id === state.witch.id);
    assert.equal(hero.hasTag('leader'), true, 'restored hero must keep the leader tag');
    assert.equal(witch.hasTag('leader'), true, 'restored witch must keep the leader tag');
  });
});
