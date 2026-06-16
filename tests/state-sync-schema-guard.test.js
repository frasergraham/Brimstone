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
import { TileType, BuildingType, ResourceType, PathType, StructureType } from '../src/tiles.js';
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
  // Mission-logic presentation queue (docs/09) — transient per-round scratch,
  // drained + animated by the client each step. The engine's *runtime* state is
  // serialized as `logicState` (via state.logicEngine.serialize()); the engine
  // object itself is re-attached by the mission loader on resume.
  'logicPresentation',
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

// ── Tile-field guard ────────────────────────────────────────────────────────
//
// The tile serialize/deserialize in server/state-sync.js is a hand-written
// allowlist (serializeState's `tiles.push({...})` literal and deserializeState's
// `for (const t of snap.tiles)` loop). It is NOT covered by the GameState/Entity
// guards above — a tile field can be authored by the mission loader yet silently
// dropped on undiscovered tiles across mid-mission save/resume. That is exactly
// the bug Ori fixed (hiddenSurvivorId / hiddenSurvivorLevel / exploreOverride,
// dev 0eb77c6); this guard closes the gap for the whole tile-field class.
//
// Canonical authored tile-field set = the fields `_applyTileDef` in
// src/campaign/mission-map.js writes onto a Tile from a mission JSON tile def.
// That function is the authoritative writer; the mission JSON schema (the union
// of tile-object keys across src/campaign/missions/*.json) agrees with it. We
// deliberately EXCLUDE positional (col/row), runtime (explored), and derived
// (blockedSlots, legacy `type`) fields — only authored content is guarded.
const AUTHORED_TILE_FIELDS = [
  { field: 'base',                value: TileType.FOREST },
  { field: 'structure',           value: StructureType.BUILDING },
  { field: 'path',                value: PathType.ROAD },
  { field: 'building',            value: BuildingType.CHURCH },
  { field: 'resource',            value: ResourceType.HERBS },
  { field: 'fortifyLevel',        value: 3 },
  { field: 'hiddenSurvivor',      value: true },
  { field: 'hiddenSurvivorId',    value: 'eliza-stone' },
  { field: 'hiddenSurvivorLevel', value: 2 },
  { field: 'exploreOverride',     value: { kind: 'survivor', survivorId: 'mason' } },
  { field: 'footprintHexes',      value: ['5,5'] },
  { field: 'buildingFootprintOf', value: '4,4' },
  // roadDirs round-trips as an array but is restored as a Set — normalize on read.
  { field: 'roadDirs',            value: new Set(['1,2', '3,4']),
    read: (t) => [...(t.roadDirs ?? [])], expect: ['1,2', '3,4'] },
];

const applyField = (tile, f) => { tile[f.field] = f.value; };
const readField  = (tile, f) => (f.read ? f.read(tile) : tile[f.field]);
const wantField  = (f) => ('expect' in f ? f.expect : f.value);

describe('state-sync tile-field guard', () => {
  test('every authored tile field survives a serialize → deserialize round-trip', () => {
    const state = new GameState(true, true);
    // Populate one tile with a distinctive (non-default) value for every authored
    // field. `building` + non-empty `footprintHexes` keeps the deserialize
    // footprint auto-migration from touching this tile.
    const [key, tile] = [...state.tiles][0];
    for (const f of AUTHORED_TILE_FIELDS) applyField(tile, f);

    // Sanity: the source tile really carries every field at its test value.
    // Catches a typo'd field name in AUTHORED_TILE_FIELDS itself.
    for (const f of AUTHORED_TILE_FIELDS) {
      assert.deepEqual(readField(tile, f), wantField(f),
        `guard setup error: tile.${f.field} was not set on the source tile`);
    }

    // Full save-path round-trip (serialize → JSON → deserialize).
    const restored = deserializeState(JSON.parse(JSON.stringify(serializeState(state))));
    const rt = restored.tiles.get(key);
    assert.ok(rt, 'restored tile must exist after round-trip');

    for (const f of AUTHORED_TILE_FIELDS) {
      assert.deepEqual(readField(rt, f), wantField(f),
        `authored tile field '${f.field}' was dropped across save/resume — ` +
        `serialize it in the tiles.push({...}) literal AND restore it in the ` +
        `deserializeState tile loop (server/state-sync.js).`);
    }
  });

  test('guard list stays in sync with the mission loader (_applyTileDef)', () => {
    // _applyTileDef in mission-map.js is the authoritative writer of authored
    // tile fields. If a contributor adds a new authored field there, this test
    // forces them to add it to AUTHORED_TILE_FIELDS — which in turn forces them
    // to confirm it round-trips (the test above). Prevents the canonical set
    // from drifting silently.
    const missionMapSrc = readFileSync(
      join(__dirname, '..', 'src', 'campaign', 'mission-map.js'), 'utf8');
    const start = missionMapSrc.indexOf('function _applyTileDef');
    const endIdx = missionMapSrc.indexOf('\nfunction _buildHandmade', start);
    const body = missionMapSrc.slice(start, endIdx >= 0 ? endIdx : missionMapSrc.length);

    const written = new Set([...body.matchAll(/\btile\.([a-zA-Z]+)\s*=/g)].map(m => m[1]));
    const guarded = new Set(AUTHORED_TILE_FIELDS.map(f => f.field));

    for (const w of written) {
      assert.ok(guarded.has(w),
        `mission-map.js _applyTileDef writes authored tile field '${w}' but the ` +
        `state-sync guard omits it — add it to AUTHORED_TILE_FIELDS and confirm ` +
        `it round-trips in server/state-sync.js.`);
    }
    for (const g of guarded) {
      assert.ok(written.has(g),
        `AUTHORED_TILE_FIELDS lists '${g}' but mission-map.js _applyTileDef no ` +
        `longer writes it — remove or update the guard entry.`);
    }
  });
});
