// ═══════════════════════════════════════════════════════════════════════════
// One-shot tile-shape migrator: legacy `type`-only tile defs → layered
// `base`/`structure`/`path` tile defs (P5 of the tile-model refactor).
// ─────────────────────────────────────────────────────────────────────────────
// Run with:  node scripts/migrate-tiles-to-base-overlay.js
//
// P0 split the runtime Tile into three independent layers behind a derived
// `tile.type` get/set shim:
//
//   base      ∈ {grass, forest, dirt}             — the terrain material
//   structure ∈ {none(null), building}            — is there a building or not
//   path      ∈ {none(null), road, river, bridge} — overlaid path/water feature
//
// The 8 shipped mission JSONs (src/campaign/missions/*.json) still encode each
// tile as a single `type` enum KEY (GRASS/FOREST/ROAD/BUILDING/…). This script
// rewrites every tile def in place to the layered shape, deriving (base,
// structure, path) from the old `type` using EXACTLY the same mapping as P0's
// `set type()` shim (src/tiles.js):
//
//   GRASS/FOREST/DIRT → base=<that>,  structure=null,     path=null
//   ROAD              → base=GRASS,   structure=null,     path=ROAD
//   RIVER             → base=GRASS,   structure=null,     path=RIVER
//   BRIDGE            → base=GRASS,   structure=null,     path=BRIDGE
//   BUILDING          → base=DIRT,    structure=BUILDING, path=null
//
// (Road-through-building is carried by the separate `roadDirs` Set, exactly as
// before — NOT by the path layer — so a BUILDING tile keeps path=null and its
// roadDirs untouched.)
//
// building / roadDirs / resource / fortifyLevel / hiddenSurvivor are preserved
// verbatim. Values are emitted in uppercase enum KEY form, the schema's
// preferred convention (matching what the mission editor will emit in P6).
//
// CANONICAL NEW TILE-DEF SHAPE (per entry in map.tiles[] / map.overlay.tiles[]):
//
//   {
//     col: <int>, row: <int>,
//     base: "GRASS" | "FOREST" | "DIRT",
//     structure: "BUILDING" | null,
//     path: "ROAD" | "RIVER" | "BRIDGE" | null,
//     building: "<BuildingType KEY>" | null,
//     fortifyLevel: <int>,
//     resource: "<ResourceType KEY>" | null,
//     hiddenSurvivor: <bool>,
//     roadDirs: ["col,row", …]   // sorted
//   }
//
// SELF-VERIFICATION: after rewriting each mission, the migrated `map` is loaded
// through buildMissionMap and deep-compared, tile-by-tile, against the map the
// ORIGINAL (pre-migration) JSON produced — derived legacy `type`, the three
// layers, building, roadDirs (as sets), plus starts / objectives / dims. The
// script aborts loudly on any mismatch (the equivalence gate, mirroring
// scripts/migrate-missions.js). Because both shapes flow through the same
// buildMissionMap (the original via the back-compat `type` path, the migrated
// via the layered path), this proves the rewrite is lossless.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildMissionMap } from '../src/campaign/mission-map.js';
import { hexKey } from '../src/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSIONS_DIR = path.join(__dirname, '..', 'src', 'campaign', 'missions');

// ── Tile-def transform ───────────────────────────────────────────────────────

// Decompose a legacy uppercase TileType KEY into the (base, structure, path)
// uppercase KEYs, matching P0's `set type()` shim exactly.
function decomposeTypeKey(typeKey) {
  switch (typeKey) {
    case 'GRASS':
    case 'FOREST':
    case 'DIRT':
      return { base: typeKey, structure: null, path: null };
    case 'ROAD':
      return { base: 'GRASS', structure: null, path: 'ROAD' };
    case 'RIVER':
      return { base: 'GRASS', structure: null, path: 'RIVER' };
    case 'BRIDGE':
      return { base: 'GRASS', structure: null, path: 'BRIDGE' };
    case 'BUILDING':
      return { base: 'DIRT', structure: 'BUILDING', path: null };
    default:
      throw new Error(`migrate-tiles: unknown tile type KEY "${typeKey}"`);
  }
}

// Rewrite one legacy tile def into the layered shape. Idempotent: a def that is
// already layered (has no `type`) is returned untouched.
function migrateTileDef(def) {
  if (def.type == null) return def; // already migrated
  const { base, structure, path: pathLayer } = decomposeTypeKey(def.type);
  return {
    col: def.col,
    row: def.row,
    base,
    structure,
    path: pathLayer,
    building: def.building ?? null,
    fortifyLevel: def.fortifyLevel ?? 0,
    resource: def.resource ?? null,
    hiddenSurvivor: !!def.hiddenSurvivor,
    roadDirs: [...(def.roadDirs ?? [])].sort(),
  };
}

// Produce a deep clone of the mission with every tile def (handmade tiles and
// procedural overlay tiles) rewritten to the layered shape.
function migrateMission(mission) {
  const out = JSON.parse(JSON.stringify(mission));
  const map = out.map;
  if (!map || typeof map !== 'object') return out;
  if (Array.isArray(map.tiles)) {
    map.tiles = map.tiles.map(migrateTileDef);
  }
  if (map.overlay && Array.isArray(map.overlay.tiles)) {
    map.overlay.tiles = map.overlay.tiles.map(migrateTileDef);
  }
  return out;
}

// ── Equivalence self-check ────────────────────────────────────────────────────

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function assertBuiltMapsEquivalent(id, before, after) {
  const fail = (msg) => { throw new Error(`migrate-tiles: ${id} equivalence FAILED — ${msg}`); };

  if (before.cols !== after.cols) fail(`cols ${before.cols} != ${after.cols}`);
  if (before.rows !== after.rows) fail(`rows ${before.rows} != ${after.rows}`);
  if (before.tiles.size !== after.tiles.size) {
    fail(`tile count ${before.tiles.size} != ${after.tiles.size}`);
  }

  for (const [k, a] of before.tiles) {
    const b = after.tiles.get(k);
    if (!b) fail(`missing tile ${k}`);
    if (a.type !== b.type) fail(`tile ${k} derived type ${a.type} != ${b.type}`);
    if (a.base !== b.base) fail(`tile ${k} base ${a.base} != ${b.base}`);
    if ((a.path ?? null) !== (b.path ?? null)) fail(`tile ${k} path ${a.path} != ${b.path}`);
    if ((a.structure ?? null) !== (b.structure ?? null)) fail(`tile ${k} structure ${a.structure} != ${b.structure}`);
    if ((a.building ?? null) !== (b.building ?? null)) fail(`tile ${k} building mismatch`);
    if ((a.resource ?? null) !== (b.resource ?? null)) fail(`tile ${k} resource mismatch`);
    if ((a.fortifyLevel ?? 0) !== (b.fortifyLevel ?? 0)) fail(`tile ${k} fortifyLevel mismatch`);
    if (!!a.hiddenSurvivor !== !!b.hiddenSurvivor) fail(`tile ${k} hiddenSurvivor mismatch`);
    if (!setsEqual(a.roadDirs ?? new Set(), b.roadDirs ?? new Set())) {
      fail(`tile ${k} roadDirs mismatch: [${[...(a.roadDirs ?? [])]}] != [${[...(b.roadDirs ?? [])]}]`);
    }
  }

  const startEq = (p, q) => (p == null && q == null) || (p && q && p.col === q.col && p.row === q.row);
  if (!startEq(before.heroStart, after.heroStart)) fail('heroStart mismatch');
  if (!startEq(before.witchStart, after.witchStart)) fail('witchStart mismatch');
  if (JSON.stringify(before.witchObjectives ?? []) !== JSON.stringify(after.witchObjectives ?? [])) {
    fail('witchObjectives mismatch');
  }
}

// ── Run ────────────────────────────────────────────────────────────────────────

function migrate() {
  const files = readdirSync(MISSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('No mission JSONs found — nothing to migrate.');
    return;
  }

  let count = 0;
  for (const file of files) {
    const full = path.join(MISSIONS_DIR, file);
    const original = JSON.parse(readFileSync(full, 'utf8'));

    // 1. Build the map from the ORIGINAL (pre-migration) JSON.
    const before = buildMissionMap(original.map);

    // 2. Rewrite tile defs → layered shape.
    const migrated = migrateMission(original);

    // 3. Build the map from the MIGRATED JSON and self-verify equivalence.
    const after = buildMissionMap(migrated.map);
    assertBuiltMapsEquivalent(original.id ?? file, before, after);

    // 4. Write the migrated JSON back in place.
    writeFileSync(full, JSON.stringify(migrated, null, 2) + '\n', 'utf8');
    count++;
    const tileCount = migrated.map?.tiles?.length ?? 0;
    console.log(`✓ ${(original.id ?? file).padEnd(20)} → ${path.relative(path.join(__dirname, '..'), full)} `
      + `(${tileCount} tiles, equivalence OK)`);
  }

  console.log(`\nMigrated ${count} missions → layered tile shape (all equivalence checks OK).`);
}

migrate();
