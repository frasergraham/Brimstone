// ═══════════════════════════════════════════════════════════════════════════
// Round-trip equivalence tests for the migrated JSON missions (P3).
// ─────────────────────────────────────────────────────────────────────────────
// The 8 mission JSON files under src/campaign/missions/ were snapshotted from
// the original imperative JS map builders by scripts/migrate-missions.js, which
// self-verifies JS-built ≡ JSON-built at generation time. These tests are the
// PERMANENT guard that the runtime loader (loadMissionJSON + buildMissionMap)
// reconstructs each JSON mission losslessly:
//
//   • the built map round-trips — re-snapshotting it reproduces the file's
//     `map.tiles` exactly (type/building/resource/fortifyLevel/hiddenSurvivor
//     and roadDirs as sets), plus identical starts / objectives / dims;
//   • derived roads are symmetric (no one-way links);
//   • every mission field (phaseCycle, enemyUnits, waves, objectives,
//     storyTriggers, scalars) survives loadMissionJSON untouched;
//   • storyTrigger `condition` strings resolve to the SAME registry fn the
//     runtime gates on (identity, not a copy);
//   • `conductor.scriptKey` resolves to the registered conductor script.
//
// Read via fs and passed as a parsed object to loadMissionJSON — the same code
// path the browser exercises via fetch.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadMissionJSON } from '../src/campaign/json-mission.js';
import { buildMissionMap } from '../src/campaign/mission-map.js';
import { TileType, BuildingType, ResourceType, PathType, StructureType, legacyTileType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { resolveCondition } from '../src/campaign/condition-registry.js';
import { resolveConductorScript } from '../src/campaign/conductor-scripts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSIONS_DIR = path.join(__dirname, '..', 'src', 'campaign', 'missions');

// The 8 migrated missions and the campaign each belongs to.
const MISSIONS = [
  { id: 'tutorial', campaignId: 'prologue' },
  { id: 'prologue', campaignId: 'calebs_hollow_prologue' },
  { id: 'gathering_survivors', campaignId: 'calebs_hollow_prologue' },
  { id: 'first_night', campaignId: 'calebs_hollow_prologue' },
  { id: 'river_crossing', campaignId: 'calebs_hollow_prologue' },
  { id: 'dark_ritual', campaignId: 'calebs_hollow_prologue' },
  { id: 'long_watch', campaignId: 'calebs_hollow_prologue' },
  { id: 'witchs_trail', campaignId: 'calebs_hollow_prologue' },
];

function readMission(id) {
  return JSON.parse(readFileSync(path.join(MISSIONS_DIR, `${id}.json`), 'utf8'));
}

// ── Snapshot helpers (mirror scripts/migrate-missions.js) ─────────────────────

function invert(enumObj) {
  const out = {};
  for (const [k, v] of Object.entries(enumObj)) out[v] = k;
  return out;
}
const TILE_KEY = invert(TileType);
const BLDG_KEY = invert(BuildingType);
const RES_KEY = invert(ResourceType);
const PATH_KEY = invert(PathType);
const STRUCT_KEY = invert(StructureType);

function isDefaultTile(t) {
  return legacyTileType(t) === TileType.GRASS
    && !t.building
    && (t.fortifyLevel ?? 0) === 0
    && !t.resource
    && !t.hiddenSurvivor
    && (t.roadDirs?.size ?? 0) === 0;
}

// Re-snapshot a built map into a comparable shape, keyed by "col,row" for
// order-independent comparison. Carries BOTH the derived legacy `type` and the
// three explicit layers (base/structure/path, uppercase KEY form) so the
// round-trip proof asserts the full layered shape — not just the legacy type.
function snapshotTiles(built) {
  const out = new Map();
  for (let row = 0; row < built.rows; row++) {
    for (let col = 0; col < built.cols; col++) {
      const t = built.tiles.get(hexKey(col, row));
      if (!t || isDefaultTile(t)) continue;
      out.set(hexKey(col, row), {
        col, row,
        type: TILE_KEY[legacyTileType(t)] ?? legacyTileType(t),
        base: TILE_KEY[t.base] ?? t.base,
        structure: t.structure ? (STRUCT_KEY[t.structure] ?? t.structure) : null,
        path: t.path ? (PATH_KEY[t.path] ?? t.path) : null,
        building: t.building ? (BLDG_KEY[t.building] ?? t.building) : null,
        fortifyLevel: t.fortifyLevel ?? 0,
        resource: t.resource ? (RES_KEY[t.resource] ?? t.resource) : null,
        hiddenSurvivor: !!t.hiddenSurvivor,
        roadDirs: [...(t.roadDirs ?? [])].sort(),
      });
    }
  }
  return out;
}

// Derive the legacy TileType KEY a layered file tile def reports — mirrors the
// P0 `get type()` precedence (path > structure/building > base).
function fileTileTypeKey(def) {
  if (def.path === 'RIVER') return 'RIVER';
  if (def.path === 'BRIDGE') return 'BRIDGE';
  if (def.path === 'ROAD') return 'ROAD';
  if (def.structure === 'BUILDING' || def.building != null) return 'BUILDING';
  return def.base ?? 'GRASS';
}

// Normalise a (layered) file tile def into the same comparable shape as
// snapshotTiles, computing the derived `type` from the layers.
function normFileTile(def) {
  return {
    col: def.col, row: def.row,
    type: fileTileTypeKey(def),
    base: def.base ?? 'GRASS',
    structure: def.structure ?? null,
    path: def.path ?? null,
    building: def.building ?? null,
    fortifyLevel: def.fortifyLevel ?? 0,
    resource: def.resource ?? null,
    hiddenSurvivor: !!def.hiddenSurvivor,
    roadDirs: [...(def.roadDirs ?? [])].sort(),
  };
}

function assertSymmetricRoads(tiles) {
  for (const [k, t] of tiles) {
    for (const nk of t.roadDirs) {
      const n = tiles.get(nk);
      assert.ok(n, `roadDir to missing tile ${nk} from ${k}`);
      assert.ok(n.roadDirs.has(k), `asymmetric road ${k} → ${nk}`);
    }
  }
}

// ── Files exist + schema ─────────────────────────────────────────────────────

describe('migrated mission files', () => {
  test('all 8 mission JSON files load and declare schema 1', () => {
    for (const { id } of MISSIONS) {
      const parsed = readMission(id);
      assert.equal(parsed.schema, 1, `${id}: schema`);
      assert.equal(parsed.id, id, `${id}: id`);
      assert.ok(parsed.map && typeof parsed.map === 'object', `${id}: map`);
    }
  });
});

// ── Per-mission round-trip equivalence ────────────────────────────────────────

for (const { id, campaignId } of MISSIONS) {
  describe(`mission ${id} — round-trip`, () => {
    const parsed = readMission(id);
    const def = loadMissionJSON(parsed);
    const built = buildMissionMap(parsed.map);

    test('campaignId is preserved', () => {
      assert.equal(parsed.campaignId, campaignId);
    });

    test('scalar / shape fields pass through loadMissionJSON verbatim', () => {
      assert.equal(def.id, parsed.id);
      assert.equal(def.title, parsed.title);
      assert.equal(def.mapSize, parsed.mapSize);
      assert.equal(def.hasWitch, parsed.hasWitch);
      assert.equal(def.disableScoring, parsed.disableScoring);
      assert.equal(def.aiPersonality, parsed.aiPersonality);
      assert.deepEqual(def.phaseCycle, parsed.phaseCycle);
      assert.deepEqual(def.enemyUnits ?? null, parsed.enemyUnits ?? null);
      assert.deepEqual(def.waves ?? null, parsed.waves ?? null);
      assert.deepEqual(def.objectives, parsed.objectives);
      assert.deepEqual(def.startingResources ?? null, parsed.startingResources ?? null);
      assert.deepEqual(def.rewards ?? null, parsed.rewards ?? null);
      assert.deepEqual(def.survivorStartPositions ?? null, parsed.survivorStartPositions ?? null);
      // schema/conductor are stripped from the runtime def.
      assert.equal(def.schema, undefined);
      assert.equal(def.conductor, undefined);
    });

    test('built map round-trips: re-snapshot equals the file tiles', () => {
      const resnap = snapshotTiles(built);
      const fileTiles = new Map(parsed.map.tiles.map((d) => [hexKey(d.col, d.row), normFileTile(d)]));

      assert.equal(resnap.size, fileTiles.size,
        `tile count differs: built ${resnap.size} vs file ${fileTiles.size}`);
      for (const [k, ft] of fileTiles) {
        const rt = resnap.get(k);
        assert.ok(rt, `built map missing tile ${k}`);
        assert.deepEqual(rt, ft, `tile ${k} differs after round-trip`);
      }
    });

    test('starts / objectives / dims match the file', () => {
      assert.deepEqual(built.heroStart ?? null, parsed.map.heroStart ?? null);
      assert.deepEqual(built.witchStart ?? null, parsed.map.witchStart ?? null);
      assert.deepEqual(built.witchObjectives ?? [], parsed.map.witchObjectives ?? []);
      assert.equal(built.cols, parsed.map.cols);
      assert.equal(built.rows, parsed.map.rows);
    });

    test('derived roads are symmetric', () => {
      assertSymmetricRoads(built.tiles);
    });

    test('storyTrigger conditions resolve to the registry fn (identity)', () => {
      const triggers = parsed.storyTriggers ?? [];
      for (let i = 0; i < triggers.length; i++) {
        const raw = triggers[i];
        if (typeof raw.condition === 'string') {
          const resolved = def.storyTriggers[i].condition;
          assert.equal(typeof resolved, 'function', `${id} trigger ${i}: condition not resolved`);
          assert.equal(resolved, resolveCondition(raw.condition),
            `${id} trigger ${i}: condition fn identity differs from registry`);
        }
      }
    });

    test('conductor scriptKey resolves to the registered script', () => {
      if (parsed.conductor) {
        const script = resolveConductorScript(parsed.conductor.scriptKey);
        assert.ok(script, `${id}: unknown conductor script`);
        assert.equal(def.conductorSteps, script.steps);
        assert.equal(def.conductorConfig, script.config);
      } else {
        assert.equal(def.conductorSteps, undefined);
        assert.equal(def.conductorConfig, undefined);
      }
    });
  });
}

// ── Targeted equivalence spot-checks (pin known JS-original values) ───────────
// These guard the migration against silent data drift: the values were authored
// in the original JS builders/missions and must survive the snapshot.

describe('migration spot-checks', () => {
  test('prologue: 3 attack-1 zombies + 1 hero_kills golem wave, daytime cycle', () => {
    const m = readMission('prologue');
    assert.equal(m.enemyUnits.length, 3);
    assert.ok(m.enemyUnits.every((e) => e.type === 'zombie' && e.overrides.attack === 1));
    assert.equal(m.waves.length, 1);
    assert.equal(m.waves[0].trigger, 'hero_kills');
    assert.equal(m.waves[0].count, 3);
    assert.deepEqual(m.phaseCycle.phases, ['dawn', 'day', 'day', 'day']);
  });

  test('river_crossing: handmade 17×9, targetHex at the church (15,4)', () => {
    const m = readMission('river_crossing');
    assert.equal(m.map.cols, 17);
    assert.equal(m.map.rows, 9);
    assert.deepEqual(m.map.targetHex, { col: 15, row: 4 });
    // The church tile carries the hidden survivor.
    const church = m.map.tiles.find((t) => t.col === 15 && t.row === 4);
    assert.ok(church && church.building === 'CHURCH' && church.hiddenSurvivor === true);
  });

  test('dark_ritual: 2 named power nodes, witch present', () => {
    const m = readMission('dark_ritual');
    assert.equal(m.hasWitch, true);
    assert.equal(m.map.witchObjectives.length, 2);
    assert.deepEqual(m.map.witchObjectives.map((o) => o.label), ['Ritual Circle', 'Dark Altar']);
  });

  test('long_watch: 3 nodes, two notHoldingAllNodes reminder triggers', () => {
    const m = readMission('long_watch');
    assert.equal(m.map.witchObjectives.length, 3);
    const gated = m.storyTriggers.filter((t) => t.condition === 'notHoldingAllNodes');
    assert.equal(gated.length, 2);
  });

  test('tutorial: handmade map + conductor scriptKey + inline minion wave', () => {
    const m = readMission('tutorial');
    assert.equal(m.map.mode, 'handmade');
    assert.equal(m.conductor.scriptKey, 'tutorial');
    assert.equal(m.objectives.win.type, 'conductor_complete');
    assert.equal(m.waves.length, 1);
    assert.equal(m.waves[0].units[0].type, 'minion');
  });
});
