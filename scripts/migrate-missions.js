// ═══════════════════════════════════════════════════════════════════════════
// One-shot mission migrator: JS campaign defs → declarative JSON (schema 1).
// ─────────────────────────────────────────────────────────────────────────────
// Run with:  node scripts/migrate-missions.js
//
// For each of the 7 hand-rolled Caleb's Hollow prologue missions, this runs the
// existing imperative `buildXMap()` and SNAPSHOTS the built map into a lossless
// `handmade` map def (full explicit tiles incl. derived roadDirs, plus
// starts/objectives/dims). The remaining mission fields (briefing, objectives,
// waves, storyTriggers, …) are emitted VERBATIM; the only transform is a
// storyTrigger `condition` function → its registry string key.
//
// The tutorial mission emits a handmade map snapshot, its inline waves, and a
// `conductor: { scriptKey: "tutorial" }` reference — its scripted steps /
// witchPlanProvider / forcedDice are NOT serializable and stay in the
// conductor-script registry (src/campaign/conductor-scripts.js).
//
// SELF-VERIFICATION: after emitting each mission, the script re-builds the map
// from the emitted JSON via `buildMissionMap` and deep-compares it to the
// original JS-built map (tiles incl. roadDirs as sets, starts, objectives,
// dims, targetHex). This is the equivalence gate that proves the snapshot is
// lossless at generation time — the script aborts loudly on any mismatch.
//
// NOTE: this is a ONE-SHOT exporter. It imports the JS map builders, which are
// removed from the campaign files once the migration lands, so it is not
// re-runnable post-migration (by design — the emitted JSON is the new source of
// truth, edited via the mission editor).
//
// See docs/design/campaign-mission-editor.md → "P3 — Migration".
// ═══════════════════════════════════════════════════════════════════════════

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import calebsHollowPrologue from '../src/campaign/campaigns/calebs-hollow-prologue.js';
import tutorialCampaign from '../src/campaign/campaigns/prologue.js';
import { TUTORIAL_WAVES } from '../src/tutorial/tutorial-config.js';
import { TileType, BuildingType, ResourceType, legacyTileType, hasBuilding, isBridge } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { buildMissionMap } from '../src/campaign/mission-map.js';
import { resolveCondition, CONDITIONS } from '../src/campaign/condition-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'src', 'campaign', 'missions');

// ── Enum inversion (value → uppercase KEY, the schema's preferred form) ──────

function invert(enumObj) {
  const out = {};
  for (const [k, v] of Object.entries(enumObj)) out[v] = k;
  return out;
}
const TILE_KEY = invert(TileType);
const BLDG_KEY = invert(BuildingType);
const RES_KEY = invert(ResourceType);

// ── Map snapshotting ─────────────────────────────────────────────────────────

// A tile equals the default grass fill iff it carries no distinguishing data.
// We emit only non-default tiles — the handmade builder fills a grass grid
// first, so this is lossless while keeping the JSON lean.
function isDefaultTile(t) {
  return legacyTileType(t) === TileType.GRASS
    && !t.building
    && (t.fortifyLevel ?? 0) === 0
    && !t.resource
    && !t.hiddenSurvivor
    && (t.roadDirs?.size ?? 0) === 0;
}

function snapshotTile(t) {
  return {
    col: t.col,
    row: t.row,
    type: TILE_KEY[legacyTileType(t)] ?? legacyTileType(t),
    building: t.building ? (BLDG_KEY[t.building] ?? t.building) : null,
    fortifyLevel: t.fortifyLevel ?? 0,
    resource: t.resource ? (RES_KEY[t.resource] ?? t.resource) : null,
    hiddenSurvivor: !!t.hiddenSurvivor,
    roadDirs: [...(t.roadDirs ?? [])].sort(),
  };
}

// Snapshot a built map (the shape buildXMap()/generateMap() return) into a
// handmade map def.
function snapshotMap(built) {
  const { tiles, cols, rows } = built;

  const tileDefs = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const t = tiles.get(hexKey(col, row));
      if (!t || isDefaultTile(t)) continue;
      tileDefs.push(snapshotTile(t));
    }
  }

  // roadNodes — authoring metadata (the editor's road-graph waypoints). For a
  // handmade map the derived roadDirs are already persisted per-tile, so this
  // is informational only; we seed it with the implicit nodes (buildings +
  // bridges) for editor friendliness.
  const roadNodes = [];
  for (const t of tiles.values()) {
    if (hasBuilding(t) || isBridge(t)) {
      roadNodes.push(hexKey(t.col, t.row));
    }
  }
  roadNodes.sort();

  const map = { mode: 'handmade', cols, rows };
  if (built.heroStart) map.heroStart = { col: built.heroStart.col, row: built.heroStart.row };
  if (built.witchStart) map.witchStart = { col: built.witchStart.col, row: built.witchStart.row };
  map.witchObjectives = built.witchObjectives ?? [];
  map.roadNodes = roadNodes;
  map.mapSize = built.mapSize;
  map.survivorCounts = built.survivorCounts ?? { buildings: 0, terrain: 0 };
  // Legacy passthrough field carried on the built map (reach_hex marker). The
  // handmade builder doesn't read it, so the registry re-attaches it after
  // buildMissionMap — but we persist it so the data isn't lost.
  if (built.targetHex) {
    map.targetHex = { col: built.targetHex.col, row: built.targetHex.row };
  }
  map.tiles = tileDefs;
  return map;
}

// ── Story-trigger condition fn → registry key ────────────────────────────────

function serializeStoryTriggers(triggers) {
  if (!Array.isArray(triggers)) return triggers;
  return triggers.map((t) => {
    if (typeof t.condition === 'function') {
      // Arrow fns assigned to a const inherit that name (e.g. notHoldingAllNodes).
      const key = t.condition.name;
      if (!key || resolveCondition(key) == null) {
        throw new Error(
          `migrate: story-trigger condition "${key || '(anonymous)'}" is not in the `
          + `condition registry (known: ${Object.keys(CONDITIONS).join(', ')})`);
      }
      return { ...t, condition: key };
    }
    return t;
  });
}

// ── Per-mission emission ──────────────────────────────────────────────────────

// Fields that are NOT copied verbatim — they're replaced/transformed below.
const SKIP_FIELDS = new Set([
  'mapBuilder',       // replaced by `map`
  'conductorSteps',   // tutorial: replaced by `conductor.scriptKey`
  'conductorConfig',
  'storyTriggers',    // condition fn → key
  'map',              // (none of the JS missions have one, but be safe)
]);

function emitMission(missionDef, builtMap, campaignId) {
  const out = { schema: 1 };
  // campaignId for editor friendliness (the loader ignores it).
  out.campaignId = campaignId;

  for (const [k, v] of Object.entries(missionDef)) {
    if (SKIP_FIELDS.has(k)) continue;
    out[k] = v;
  }

  out.map = snapshotMap(builtMap);

  if (Array.isArray(missionDef.storyTriggers)) {
    out.storyTriggers = serializeStoryTriggers(missionDef.storyTriggers);
  }

  // Tutorial: reference the conductor script by key; inline its waves.
  if (missionDef.conductorSteps) {
    out.conductor = { scriptKey: 'tutorial' };
    out.waves = TUTORIAL_WAVES;
  }

  return out;
}

// ── Equivalence self-check ────────────────────────────────────────────────────

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function assertMapsEquivalent(id, jsMap, jsonMap) {
  const fail = (msg) => { throw new Error(`migrate: ${id} equivalence FAILED — ${msg}`); };

  if (jsMap.cols !== jsonMap.cols) fail(`cols ${jsMap.cols} != ${jsonMap.cols}`);
  if (jsMap.rows !== jsonMap.rows) fail(`rows ${jsMap.rows} != ${jsonMap.rows}`);
  if (jsMap.tiles.size !== jsonMap.tiles.size) {
    fail(`tile count ${jsMap.tiles.size} != ${jsonMap.tiles.size}`);
  }

  for (const [k, a] of jsMap.tiles) {
    const b = jsonMap.tiles.get(k);
    if (!b) fail(`missing tile ${k}`);
    if (legacyTileType(a) !== legacyTileType(b)) fail(`tile ${k} type ${legacyTileType(a)} != ${legacyTileType(b)}`);
    if ((a.building ?? null) !== (b.building ?? null)) fail(`tile ${k} building mismatch`);
    if ((a.resource ?? null) !== (b.resource ?? null)) fail(`tile ${k} resource mismatch`);
    if ((a.fortifyLevel ?? 0) !== (b.fortifyLevel ?? 0)) fail(`tile ${k} fortifyLevel mismatch`);
    if (!!a.hiddenSurvivor !== !!b.hiddenSurvivor) fail(`tile ${k} hiddenSurvivor mismatch`);
    if (!setsEqual(a.roadDirs ?? new Set(), b.roadDirs ?? new Set())) {
      fail(`tile ${k} roadDirs mismatch: [${[...(a.roadDirs ?? [])]}] != [${[...(b.roadDirs ?? [])]}]`);
    }
  }

  const startEq = (p, q) => (p == null && q == null) || (p && q && p.col === q.col && p.row === q.row);
  if (!startEq(jsMap.heroStart, jsonMap.heroStart)) fail('heroStart mismatch');
  if (!startEq(jsMap.witchStart, jsonMap.witchStart)) fail('witchStart mismatch');
  if (JSON.stringify(jsMap.witchObjectives ?? []) !== JSON.stringify(jsonMap.witchObjectives ?? [])) {
    fail('witchObjectives mismatch');
  }
}

// ── Run ────────────────────────────────────────────────────────────────────────

function migrate() {
  mkdirSync(OUT_DIR, { recursive: true });

  // [campaignDef, missionId, campaignId] tuples, in canonical campaign order.
  const targets = [];
  for (const m of tutorialCampaign.missions) {
    targets.push([tutorialCampaign, m, 'prologue']);
  }
  for (const m of calebsHollowPrologue.missions) {
    targets.push([calebsHollowPrologue, m, 'calebs_hollow_prologue']);
  }

  // This is a ONE-SHOT exporter. Once the migration landed, the JS mission defs
  // and their map builders were removed from the campaign files (the emitted
  // JSON is now the source of truth), so there is nothing left to export.
  if (targets.length === 0) {
    console.log('Nothing to migrate: the JS mission originals have been removed.');
    console.log('The emitted JSON under src/campaign/missions/ is now the source of truth');
    console.log('(edit it directly or via the mission editor). This script is retained as a');
    console.log('record of how that JSON was derived. To re-run it, restore the JS builders');
    console.log('from git history first.');
    return;
  }

  let count = 0;
  for (const [campaignDef, missionDef, campaignId] of targets) {
    // 1. Build the map with the original JS builder.
    const builder = campaignDef.mapBuilders[missionDef.mapBuilder];
    if (!builder) throw new Error(`migrate: no builder "${missionDef.mapBuilder}" for ${missionDef.id}`);
    const jsMap = builder();

    // 2. Emit the JSON mission (snapshots the map).
    const json = emitMission(missionDef, jsMap, campaignId);

    // 3. Self-verify: rebuild from the emitted handmade def and deep-compare.
    const jsonMap = buildMissionMap(json.map);
    assertMapsEquivalent(missionDef.id, jsMap, jsonMap);

    // 4. Write.
    const file = path.join(OUT_DIR, `${missionDef.id}.json`);
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
    count++;
    console.log(`✓ ${missionDef.id.padEnd(20)} → ${path.relative(path.join(__dirname, '..'), file)} `
      + `(${json.map.tiles.length} tiles, equivalence OK)`);
  }

  console.log(`\nMigrated ${count} missions → ${path.relative(path.join(__dirname, '..'), OUT_DIR)}/`);
}

migrate();
