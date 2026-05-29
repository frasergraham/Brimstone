// ═══════════════════════════════════════════════════════════════════════════
// One-shot building-footprint migrator (P5 of the building-footprint rework).
// ─────────────────────────────────────────────────────────────────────────────
// Run with:  node scripts/migrate-building-footprints.js
//
// P0–P4 turned every building into a compound object: a passable ENTRANCE tile
// (the one carrying `building`) plus one impassable FOOTPRINT hex adjacent to
// it. The entrance lists its footprint hex(es) in `footprintHexes`; the footprint
// hex back-references its entrance in `buildingFootprintOf`. Procedural maps get
// this from generateMap (P2) and in-flight saves from the state-sync auto-
// migration; the 8 bundled mission JSONs were authored BEFORE footprints existed,
// so their buildings are still 1-hex. This script rewrites them once.
//
// For each authored tile def with `building != null` AND no (non-empty)
// `footprintHexes`, it picks a footprint hex with the SHARED, deterministic
// helper `pickFootprintNeighbor(state, col, row)` (no `rand` → first eligible in
// odd-r direction order 0..5), writes `footprintHexes: [neighborKey]` on the
// entrance, and `buildingFootprintOf: entranceKey` on the chosen neighbour
// (editing its tile def in place, or appending a fresh def if the neighbour was
// an unlisted default-grass tile). The built map is mutated as each footprint is
// claimed, so later buildings never reuse a hex another building already took.
//
// If a building has NO eligible neighbour (boxed in by rivers/roads/edges/other
// buildings/nodes), it is left a 1-hex orphan (explicit empty footprintHexes)
// and a console.warn names the mission + hex — the operator may hand-fix.
//
// SELF-VERIFICATION: after rewriting, each mission is re-validated and re-loaded
// through validateMissionJSON / loadMissionJSON (which re-runs buildMissionMap),
// proving the result still parses, validates and builds. The script aborts
// loudly on any failure.
//
// ONE-SHOT / IDEMPOTENT: a mission whose map already has any tile with a
// non-empty `footprintHexes` is assumed migrated and skipped, so re-running
// changes nothing. Output matches the bundled JSON convention: uppercase enum
// KEYs, explicit nulls, 2-space indent, trailing newline.
//
// Reference: scripts/migrate-missions.js, scripts/migrate-tiles-to-base-overlay.js
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildMissionMap } from '../src/campaign/mission-map.js';
import { pickFootprintNeighbor } from '../src/building-footprint.js';
import { hexKey } from '../src/hex.js';
import { TileType, StructureType, PathType, BuildingType, ResourceType } from '../src/tiles.js';
import { loadMissionJSON, validateMissionJSON } from '../src/campaign/json-mission.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSIONS_DIR = path.join(__dirname, '..', 'src', 'campaign', 'missions');

// ── Enum inversion (runtime value → uppercase KEY, the schema's form) ─────────

function invert(enumObj) {
  const out = {};
  for (const [k, v] of Object.entries(enumObj)) out[v] = k;
  return out;
}
const BASE_KEY = invert(TileType);
const STRUCT_KEY = invert(StructureType);
const PATH_KEY = invert(PathType);
const BLDG_KEY = invert(BuildingType);
const RES_KEY = invert(ResourceType);

const keyOf = (enumMap, v) => (v != null ? (enumMap[v] ?? v) : null);

// ── Tile-def helpers ──────────────────────────────────────────────────────────

// Every authored tile-def array in a map def: handmade `tiles[]` and the
// procedural `overlay.tiles[]` (the 8 bundled missions are all handmade, but we
// handle both so a future procedural mission migrates correctly too).
function tileDefArrays(map) {
  const arrs = [];
  if (map && Array.isArray(map.tiles)) arrs.push(map.tiles);
  if (map && map.overlay && Array.isArray(map.overlay.tiles)) arrs.push(map.overlay.tiles);
  return arrs;
}

function hasBuilding(def) {
  return def.building != null && def.building !== '';
}

function hasFootprint(def) {
  return Array.isArray(def.footprintHexes) && def.footprintHexes.length > 0;
}

// Idempotency guard: any authored tile already carrying a footprint ⇒ migrated.
function alreadyMigrated(map) {
  for (const arr of tileDefArrays(map)) {
    for (const def of arr) if (hasFootprint(def)) return true;
  }
  return false;
}

// Snapshot a built Tile (a footprint neighbour that had no explicit def) into a
// canonical layered tile def, matching the bundled JSON shape/key order, with
// the back-pointer set.
function neighborDef(tile, entranceKey) {
  return {
    col: tile.col,
    row: tile.row,
    base: keyOf(BASE_KEY, tile.base) ?? 'GRASS',
    structure: keyOf(STRUCT_KEY, tile.structure),
    path: keyOf(PATH_KEY, tile.path),
    building: keyOf(BLDG_KEY, tile.building),
    fortifyLevel: tile.fortifyLevel ?? 0,
    resource: keyOf(RES_KEY, tile.resource),
    hiddenSurvivor: !!tile.hiddenSurvivor,
    roadDirs: [...(tile.roadDirs ?? [])].sort(),
    buildingFootprintOf: entranceKey,
  };
}

// ── Per-mission migration ──────────────────────────────────────────────────────

function migrateMission(mission, file, warnings) {
  // Build the runtime tile map once for eligibility; mutate it as footprints are
  // claimed so the shared helper never hands the same hex to two buildings.
  const built = buildMissionMap(mission.map);
  const tiles = built.tiles; // Map<"col,row", Tile>
  const state = { tiles, witchObjectives: built.witchObjectives ?? [] };

  let footprintCount = 0;
  let orphanCount = 0;

  for (const arr of tileDefArrays(mission.map)) {
    const defByKey = new Map();
    for (const d of arr) defByKey.set(hexKey(d.col, d.row), d);

    // Snapshot entrance list up front so appending neighbour defs mid-loop
    // doesn't perturb iteration order (deterministic document order).
    const entrances = arr.filter(d => hasBuilding(d) && !hasFootprint(d));

    for (const entrance of entrances) {
      const ek = hexKey(entrance.col, entrance.row);
      const pick = pickFootprintNeighbor(state, entrance.col, entrance.row);

      if (!pick) {
        // Boxed in — leave a 1-hex orphan, but record the decision explicitly.
        entrance.footprintHexes = [];
        orphanCount++;
        warnings.push(`${file}: building "${entrance.building}" at ${ek} has no eligible `
          + `footprint neighbour — left as a 1-hex orphan (operator may hand-fix)`);
        continue;
      }

      const nk = hexKey(pick.col, pick.row);

      // 1. entrance → footprintHexes
      entrance.footprintHexes = [nk];

      // 2. neighbour → buildingFootprintOf (edit existing def, else append one)
      let nDef = defByKey.get(nk);
      if (nDef) {
        nDef.buildingFootprintOf = ek;
      } else {
        nDef = neighborDef(tiles.get(nk), ek);
        arr.push(nDef);
        defByKey.set(nk, nDef);
      }

      // 3. mutate the built map so later picks see this hex as claimed.
      const nTile = tiles.get(nk);
      if (nTile) nTile.buildingFootprintOf = ek;
      const eTile = tiles.get(ek);
      if (eTile) eTile.footprintHexes = [nk];

      footprintCount++;
    }
  }

  return { footprintCount, orphanCount };
}

// ── Run ────────────────────────────────────────────────────────────────────────

function migrate() {
  const files = readdirSync(MISSIONS_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('No mission JSONs found — nothing to migrate.');
    return;
  }

  const warnings = [];
  let migrated = 0;
  let skipped = 0;
  let totalFp = 0;
  let totalOrphan = 0;

  for (const file of files) {
    const full = path.join(MISSIONS_DIR, file);
    const mission = JSON.parse(readFileSync(full, 'utf8'));

    if (alreadyMigrated(mission.map)) {
      skipped++;
      console.log(`• ${file.padEnd(26)} already migrated — skipped`);
      continue;
    }

    const { footprintCount, orphanCount } = migrateMission(mission, file, warnings);

    // Self-verify: re-validate + re-load (structuredClone so the loader can't
    // mutate the object we're about to write).
    validateMissionJSON(structuredClone(mission));
    const def = loadMissionJSON(structuredClone(mission));
    def.mapBuilderFn(); // build the map — throws on any resolution error

    writeFileSync(full, JSON.stringify(mission, null, 2) + '\n', 'utf8');
    migrated++;
    totalFp += footprintCount;
    totalOrphan += orphanCount;
    console.log(`✓ ${file.padEnd(26)} ${footprintCount} footprint(s)`
      + (orphanCount ? `, ${orphanCount} orphan(s)` : '') + ', validates OK');
  }

  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} orphan warning(s):`);
    for (const w of warnings) console.warn('  ' + w);
  }

  console.log(`\nMigrated ${migrated} mission(s) (${skipped} already migrated). `
    + `${totalFp} footprint(s) assigned, ${totalOrphan} orphan(s).`);
}

migrate();
