// ============================================================================
// Renderer3D — Babylon.js (WebGL) renderer
// ============================================================================
//
// Phase 2 (this file): renders the actual hex map — terrain, river, roads,
// bridges, buildings — under a locked isometric camera that pans and zooms
// but does not yaw or tilt. Entities, fog, plan overlay, animations remain
// stubbed for later phases.
//
// World-unit scale (carried forward from Phase 1):
//   * hex radius = 1 world unit
//   * tile cylinder: diameter 2, height 0.15
//   * 2D pixel→world ratio is therefore 1 unit ≈ 30 pixels (HEX_SIZE = 30)
//
// Babylon is loaded lazily on first draw() via a dynamic import() from a
// pinned CDN URL, keeping src/renderer-3d.js importable in node-test (no DOM,
// no Babylon) so the interface-conformance test and pure-helper tests run
// without a WebGL context. Pure math is exported from this module for tests.
//
// Babylon CDN pin: @babylonjs/core 7.42.0 (ESM build via jsdelivr +esm).

import {
  TileType,
  TILE_COLOR,
  BUILDING_COLOR,
  BUILDING_LABEL,
  BuildingType,
  PathType,
  baseOf,
  pathOf,
  hasBuilding,
  isRiver,
  isBridge,
} from './tiles.js';
import { EntityType, isLeaderType } from './entities.js';
import { Renderer } from './renderer.js';
import { getFactionTheme } from './theme.js';
import { hexKey, hexDistance, getNeighbors } from './hex.js';
import { nodeController, Phase } from './game.js';
import { sightRangeForEntity, findFaction } from './factions.js';
import { Side } from './sides.js';
import { MAP_SIZES, NODE_COLORS } from './map.js';
import {
  installOverlayShims, OVERLAY_METHODS, yForLayer, overlaySignature,
  makeOverlay, overlayMaterialKey,
} from './overlays.js';

// Babylon core + glTF loaders are served from the packaged `assets/vendor/`
// directory rather than any CDN — the Electron / iOS bundles must run with zero
// runtime network dependencies. Both files are UMD bundles that attach to
// `window.BABYLON`; loading them as <script> tags (rather than ESM imports)
// keeps a single BABYLON instance, which is what the glTF plugin needs in
// order to register on the same SceneLoader the renderer uses. (The previous
// ESM-import of @babylonjs/core via the jsdelivr `+esm` wrapper bundled its
// own internal copy of core, so the plugin registered on the wrong BABYLON
// and SceneLoader rejected GLB files with "Unable to find a plugin to load
// .glb".)
const BABYLON_CORE_LOCAL    = '/assets/vendor/babylonjs/babylon.js';
const BABYLON_LOADERS_LOCAL = '/assets/vendor/babylonjs/babylonjs.loaders.min.js';

// ─── House GLB model (replaces the procedural box+roof building) ───────────
// Path is relative to the assets base directory (`assets/` in production), so
// the loader fetches `<base>/models/house.glb`. The file is intentionally
// optional — if it's missing or fails to parse the renderer falls back to the
// existing procedural box+roof, so gameplay never blocks on a 404.
export const HOUSE_MODEL_DIR  = 'models/';
export const HOUSE_MODEL_FILE = 'house.glb';
// The legacy hand-authored house model — kept as ONE of the two HOUSE
// variants (see BUILDING_GLB_BY_TYPE) so a village shows a mix of it and the
// newer scenario-generated house.
export const LEGACY_HOUSE_PATH = `${HOUSE_MODEL_DIR}${HOUSE_MODEL_FILE}`;

// Directory holding the per-building-type GLBs generated via Scenario. Each
// file is named after the lowercase BuildingType value (e.g. `church.glb`,
// `town_hall.glb`), so the path map below is derived directly from the enum.
export const BUILDINGS_MODEL_DIR = 'models/buildings/';

// Building-type → ordered list of GLB variant paths (relative to the assets
// base). EVERY building type now renders an imported model; the loader fetches
// each unique path once as a hidden template and instances it per tile. A type
// with >1 variant hash-picks one deterministically per (col,row) — currently
// only HOUSE, which keeps the legacy hand-made model AND the scenario model so
// the same village can show both. Any per-type load failure falls back to the
// procedural box+roof for tiles of that type only (other types are unaffected).
//
// Derived programmatically from BuildingType so it can never drift out of sync
// with the enum — all 13 values are guaranteed covered.
export const BUILDING_GLB_BY_TYPE = Object.freeze(
  Object.fromEntries(
    Object.values(BuildingType).map((key) => {
      const variants = key === BuildingType.HOUSE
        ? [LEGACY_HOUSE_PATH, `${BUILDINGS_MODEL_DIR}${key}.glb`]
        : [`${BUILDINGS_MODEL_DIR}${key}.glb`];
      return [key, Object.freeze(variants)];
    }),
  ),
);

/** Predicate: does this tile carry a building that renders as an imported GLB?
 *  Pure; exported for tests. True for any tile with a building type present in
 *  `BUILDING_GLB_BY_TYPE` (all 13 types). Keyed on the building/structure, not
 *  the base material, so a HOUSE on a forest base still counts. */
export function buildingUsesGlbModel(tile) {
  if (!tile || !hasBuilding(tile)) return false;
  return Object.prototype.hasOwnProperty.call(BUILDING_GLB_BY_TYPE, tile.building);
}

// Back-compat alias: the pipeline used to handle HOUSE only, so callers/tests
// referenced `buildingUsesHouseModel`. Now generalized to every type.
export const buildingUsesHouseModel = buildingUsesGlbModel;

/** Deterministic per-tile pick of which GLB variant a building renders. For
 *  single-variant types this is just that path; for multi-variant types
 *  (HOUSE) it hash-picks across the variants by (col,row) so the choice is
 *  stable across sessions but varies tile-to-tile. Returns null when the tile
 *  has no building or no variant list. Pure; exported for tests. */
export function buildingGlbVariantForHex(tile) {
  if (!tile || tile.building == null) return null;
  const variants = BUILDING_GLB_BY_TYPE[tile.building];
  if (!Array.isArray(variants) || variants.length === 0) return null;
  if (variants.length === 1) return variants[0];
  const h = _treePackHash(tile.col, tile.row, 269);
  return variants[Math.floor(h * variants.length) % variants.length];
}

/** Bake a translation into the given source mesh so its bounding-box bottom
 *  sits at local Y = 0. Common GLB exporters centre the mesh pivot inside the
 *  bounding box, which sinks an instance placed at tile-top into the ground;
 *  shifting the origin down to the floor makes instance placement intuitive
 *  ("position.y = tileTopY puts the floor on the tile-top"). Safe on stubbed
 *  meshes — missing bounding-info or bakeTransformIntoVertices APIs short-
 *  circuit to a no-op so tests without a real Babylon don't blow up.
 *
 *  Exported for direct unit testing. */
export function _bakeOriginToBottom(source, BABYLON) {
  if (!source || !BABYLON) return;
  if (typeof source.bakeTransformIntoVertices !== 'function') return;
  if (typeof source.getBoundingInfo !== 'function') return;
  const info = source.getBoundingInfo();
  const bb   = info && info.boundingBox;
  if (!bb) return;
  // Prefer the world-space bottom (post-import the source has identity world
  // matrix in practice; we double-check on `minimum` if `minimumWorld` is
  // unavailable on the stub).
  const minY = (bb.minimumWorld && typeof bb.minimumWorld.y === 'number')
    ? bb.minimumWorld.y
    : (bb.minimum && typeof bb.minimum.y === 'number' ? bb.minimum.y : 0);
  if (Math.abs(minY) < 1e-4) return;
  const yOffset = -minY;
  if (!BABYLON.Matrix || typeof BABYLON.Matrix.Translation !== 'function') return;
  source.bakeTransformIntoVertices(BABYLON.Matrix.Translation(0, yOffset, 0));
  if (typeof source.refreshBoundingInfo === 'function') source.refreshBoundingInfo();
}

// Fallback world-space scale for an imported building when its natural
// bounding box can't be measured (test stubs, malformed GLB). In real-browser
// use the load step computes a bbox-derived scale instead (see
// TARGET_BUILDING_WORLD_HEIGHT) so each generated model — whose intrinsic unit
// system varies per export — lands at a consistent on-tile size. This value
// sits the model at roughly the procedural BUILDING_BASE_DIM footprint (≈0.55).
export const HOUSE_INSTANCE_BASE_SCALE = 0.55;

// Target world-space height for an instanced building (before the per-hex
// jitter ratio). The scenario-generated GLBs export at wildly different
// intrinsic scales, so each template is uniformly scaled at load time so its
// bbox height lands here — the same bbox-normalize trick the tree + paladin
// pipelines use. Roughly matches the procedural box+roof stack (0.70 + 0.15).
// Operator can retune by adjusting this constant.
export const TARGET_BUILDING_WORLD_HEIGHT = 0.85;

// ─── Tree pack (real GLB trees from `assets/models/trees/`) ────────────────
// Phase 1 (PR #381) extracted `tree_pack.glb` into per-model GLBs + a manifest
// indexed by group ("tree-summer-complete", etc.). Phase 2 (this code) loads
// the manifest at renderer init, lazy-loads each unique GLB as a hidden
// template, and the FOREST tile + map-border builders instance the templates
// in place of the procedural cone+sphere trees. Procedural fallback stays
// alive — any load failure or missing season bucket falls through to the
// existing batched merge path so a missing manifest never blocks gameplay.
export const TREE_PACK_DIR           = 'models/trees/';
export const TREE_PACK_MANIFEST_FILE = 'manifest.json';
// Target world-space height for an instanced tree (post bbox-derived scale,
// before the per-tree FOREST_SCALE_MIN..MAX multiplier). Bumped from 1.0 →
// 1.8 after operator feedback: at 1.0 the new GLB trees read as much
// smaller than the old procedural pines, making the forest look sparse.
// 1.8 gives them more presence than the procedural stack while staying
// within one hex's footprint.
export const TARGET_TREE_WORLD_HEIGHT = 1.8;

/** Map a season tag (as used by `_buildMap` / forestTreesForHex) to the
 *  manifest group name we should pull tree GLBs from. Pure; exported for
 *  tests. The "complete" buckets are pre-built single-mesh trees (trunk +
 *  leaves combined) — the only group shape this loader needs to handle.
 *  Spring leans on summer because the seasonal palettes also treat it as a
 *  green-canopy variant. Falls back to summer when the season is unknown so
 *  any future season tag still resolves to a real bucket. */
export function treeGroupsForSeason(season) {
  switch (season) {
    case 'summer': return 'tree-summer-complete';
    case 'spring': return 'tree-summer-complete';
    case 'fall':
    case 'autumn': return 'tree-autumn-complete';
    case 'winter': return 'tree-winter-complete';
    case 'dead':   return 'tree-dead-complete';
    default:       return 'tree-summer-complete';
  }
}

/** Deterministic [0,1) hash from (col, row, salt). Module-internal hex
 *  hash duplicated here so the export below can ship without dragging
 *  `_forestHash` (defined far below in this file) into scope. */
function _treePackHash(col, row, salt) {
  let h = ((col | 0) * 73856093) ^ ((row | 0) * 19349663) ^ ((salt | 0) * 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x100000000;
}

/** Deterministic pick of a file from a manifest group for one tree slot.
 *  `files` is the array of file paths the manifest lists under the chosen
 *  group; the hash key is (col, row, treeIdx) so the same hex always picks
 *  the same tree silhouette across sessions. Returns null when the group
 *  is empty or missing — caller should fall back to the procedural path
 *  for that slot. Pure; exported for tests. */
export function pickTreeFileForSlot(files, col, row, treeIdx) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const h = _treePackHash(col, row, treeIdx * 11 + 7);
  return files[Math.floor(h * files.length) % files.length];
}

// ─── Paladin GLB model (replaces cone+sphere body for hero-side standees) ──
// Path is relative to the assets base directory captured by `loadImages()` —
// the loader fetches `<base>/models/paladin.glb`. The file is intentionally
// optional — if it's missing or fails to parse, hero standees fall back to the
// existing cone+sphere body so gameplay never blocks on a 404.
export const PALADIN_MODEL_DIR  = 'models/';
// Back-compat constant; UNIT_RIG_BANK is the source-of-truth for which
// .glb maps to which entity type.
// paladin-idle.glb is the paladin's source rig — mesh + skeleton + idle
// animation all in one Mixamo export. The embedded idle clip is
// auto-detected as idleGroup at load time; no separate retarget needed.
// Walking + running are loaded as animation-only files and retargeted.
export const PALADIN_MODEL_FILE = 'paladin-idle.glb';

// Fallback world-space scale applied to each cloned paladin when the source
// mesh's natural bounding box can't be measured (test stubs, malformed GLB).
// In real-browser use the load step computes a bbox-derived scale instead so
// the model lands at TARGET_PALADIN_WORLD_HEIGHT regardless of whether the
// source FBX was exported in metres or centimetres. Tunable in one place.
export const PALADIN_BASE_SCALE = 0.4;
// Target world-space height for the visible paladin model. The Mixamo source
// can land anywhere from ~1.8 (m-units) to ~180 (cm-units) tall — we measure
// the source bounding box at load time and scale to hit this target. Picked
// so the paladin reads slightly taller than the ~0.55-tall cone+sphere it
// replaces but still fits within one hex's footprint.
export const TARGET_PALADIN_WORLD_HEIGHT = 0.92;
// Forward-facing yaw applied to clones (radians). Rotates the imported mesh
// 180° so the paladin's front reads toward the camera rather than away.
export const PALADIN_YAW        = Math.PI;

// Walking + Idle animation companion GLB filenames. These exist for
// back-compat with existing call sites; UNIT_RIG_BANK is the architectural
// source of truth going forward (UNIT_RIG_BANK[type].animations.{idle,walking}).
export const WALKING_MODEL_FILE = 'walking.glb';
// IDLE_MODEL_FILE matches PALADIN_MODEL_FILE — paladin-idle.glb ships the
// idle clip embedded, so the loader picks it up at model-load time and
// _loadIdleAnimation skips (avoids a duplicate import).
export const IDLE_MODEL_FILE    = 'paladin-idle.glb';

// Crossfade rate between idle and walking, in 1/seconds. 5.0 = full transition
// in 200ms. Slow enough to read as a deliberate state change, fast enough that
// a unit moving through several hexes blends back to idle promptly between
// steps if there's a pause in the resolution loop.
export const PALADIN_ANIM_BLEND_RATE = 5.0;

/** Read the root bone's first/last position keys to compute how far the
 *  source animation translates the rig per cycle (in source-mesh units).
 *  Returns the XZ distance between the first and last keyframe values —
 *  for a properly-authored walk cycle this is one stride length. Pure;
 *  exported for tests. Returns 0 if no usable position track is found. */
export function computeRootStrideLength(animGroup, rootName = 'mixamorig:Hips') {
  if (!animGroup || !Array.isArray(animGroup.targetedAnimations)) return 0;
  const stripDup = n => n ? String(n).replace(/\.\d{3}$/, '') : n;
  for (const ta of animGroup.targetedAnimations) {
    const target = ta && ta.target;
    const tName = target && target.name;
    const prop  = ta.animation && ta.animation.targetProperty;
    if (!tName || !prop) continue;
    if (tName !== rootName && stripDup(tName) !== rootName) continue;
    if (!/position/i.test(prop)) continue;
    const keys = ta.animation.getKeys ? ta.animation.getKeys() : null;
    if (!keys || keys.length < 2) continue;
    const first = keys[0].value;
    const last  = keys[keys.length - 1].value;
    if (!first || !last || !('x' in first) || !('z' in first)) continue;
    const dx = (last.x ?? 0) - (first.x ?? 0);
    const dz = (last.z ?? 0) - (first.z ?? 0);
    return Math.sqrt(dx * dx + dz * dz);
  }
  return 0;
}

/** Duration in seconds of an AnimationGroup's natural cycle (one play
 *  at speedRatio=1). Pulls from the first animation's framePerSecond,
 *  defaulting to 60. Pure; exported for tests. */
export function animDurationSeconds(animGroup) {
  if (!animGroup || !Array.isArray(animGroup.targetedAnimations)) return 0;
  const first = animGroup.targetedAnimations[0];
  const anim  = first && first.animation;
  if (!anim) return 0;
  const fps = (typeof anim.framePerSecond === 'number' && anim.framePerSecond > 0)
    ? anim.framePerSecond : 60;
  const from = typeof animGroup.from === 'number' ? animGroup.from : 0;
  const to   = typeof animGroup.to === 'number'   ? animGroup.to   : 0;
  return Math.max(0, (to - from) / fps);
}

/** Solve for the AnimationGroup.speedRatio that makes one stride of the
 *  source clip cover `targetDistanceWU` of world-distance in
 *  `targetTimeMs` milliseconds, after the mesh is rendered at `scale`.
 *
 *  Derivation: at speedRatio=1, the rig translates
 *  `stride * scale` world-units per `natCycleSec` seconds. We want the
 *  same world-distance in `targetTimeMs / 1000` seconds. speedRatio
 *  multiplies playback speed (cycles/sec), so:
 *
 *      speedRatio = (targetDistanceWU / scale)
 *                 / (stride * (targetTimeMs / 1000) / natCycleSec)
 *                 = (targetDistanceWU * natCycleSec)
 *                 / (stride * scale * (targetTimeMs / 1000))
 *
 *  Returns `fallback` when stride or scale or natCycleSec is non-positive
 *  (can't solve). Clamped to a reasonable [0.25, 6.0] band to avoid
 *  pathological values from broken clips. Pure; exported for tests. */
export function computeAnimSpeedRatioForStride(
  strideSourceUnits,
  natCycleSec,
  scale,
  targetDistanceWU,
  targetTimeMs,
  fallback = 1.0,
) {
  if (!(strideSourceUnits > 0)) return fallback;
  if (!(natCycleSec > 0)) return fallback;
  if (!(scale > 0)) return fallback;
  if (!(targetDistanceWU > 0)) return fallback;
  if (!(targetTimeMs > 0)) return fallback;
  const targetTimeSec = targetTimeMs / 1000;
  const ratio = (targetDistanceWU * natCycleSec) / (strideSourceUnits * scale * targetTimeSec);
  return Math.max(0.25, Math.min(6.0, ratio));
}

/** Zero out the root-bone's translation keyframes so the animation drives
 *  the rig in place. Mixamo's walk/run/idle clips bake root motion into
 *  mixamorig:Hips's position channel — without stripping, the model
 *  translates through space on top of whatever world-space animation the
 *  renderer is doing (cone slide, ghost path), producing double-displacement
 *  or float. Pure; exported for tests. */
export function stripRootBoneTranslation(animGroup, rootName = 'mixamorig:Hips') {
  if (!animGroup || !Array.isArray(animGroup.targetedAnimations)) return 0;
  const stripDup = n => n ? String(n).replace(/\.\d{3}$/, '') : n;
  let stripped = 0;
  for (const ta of animGroup.targetedAnimations) {
    const target = ta && ta.target;
    const tName = target && target.name;
    const prop  = ta.animation && ta.animation.targetProperty;
    if (!tName || !prop) continue;
    if (tName !== rootName && stripDup(tName) !== rootName) continue;
    if (!/position/i.test(prop)) continue;
    const keys = ta.animation.getKeys ? ta.animation.getKeys() : null;
    if (!keys) continue;
    for (const k of keys) {
      if (k.value && typeof k.value === 'object'
        && 'x' in k.value && 'y' in k.value && 'z' in k.value) {
        k.value.x = 0;
        k.value.y = 0;
        k.value.z = 0;
      }
    }
    stripped++;
  }
  return stripped;
}

// Time (ms) after the last motion before the paladin returns to IDLE.
// During this window the walking animation is PAUSED (frozen mid-stride)
// rather than running idle — so a multi-hex chain reads as "walk → freeze
// → walk → freeze → walk → idle" instead of "walk → idle → walk → idle →
// walk → idle". 700ms comfortably covers inter-step gaps at the current
// MOVE_ANIM_MS=1000 pace (each hop is 1s of motion plus a small queue
// gap, so 700ms of post-motion sustain bridges back-to-back hops) while
// still letting idle resume between different units' sequences in
// resolution playback (which typically have longer pauses).
export const PALADIN_WALK_SUSTAIN_MS = 700;

/** Predicate: does this entity belong to the day-side hero faction (and thus
 *  render as the paladin GLB when available)? Routes through `sideFactionOf`
 *  so the faction registry is the single source of truth — no string-literal
 *  side checks in the renderer. Pure; exported for tests. */
export function isHeroFactionEntity(entity) {
  if (!entity) return false;
  const f = findFaction(entity.owner);
  return !!(f && f.side === Side.DAY);
}

/** Renderer-side bank of available animation clips. Each entry names the
 *  .glb file under `assets/models/` that holds a single AnimationGroup; the
 *  loader retargets that group onto a unit's skeleton by bone name. Extend
 *  this as new clips drop in. */
export const ANIMATION_BANK = Object.freeze({
  idle:    'paladin-idle.glb', // mesh + idle in one file; doubles as the rig source
  walking: 'walking.glb',
  running: 'running.glb',
});

/** Renderer-side bank of available unit rigs. Each entry pairs a model
 *  .glb (mesh + skeleton, no embedded animation) with the animation clips
 *  from ANIMATION_BANK that apply to it. Future models slot in here
 *  without touching the loader code — e.g. witch.glb + witch's own idle.
 *  An entity whose type is NOT in this map falls back to the generic
 *  unanimated cone+sphere pawn. */
export const UNIT_RIG_BANK = Object.freeze({
  [EntityType.PALADIN]: Object.freeze({
    // Model file ships with the idle clip embedded — auto-detected as
    // the rig's idle by _loadPaladinModel. Walking + running are loaded
    // separately and retargeted onto this skeleton by bone name.
    model: 'paladin-idle.glb',
    animations: Object.freeze({
      walking: ANIMATION_BANK.walking,
      running: ANIMATION_BANK.running,
    }),
  }),
  // Future:
  // [EntityType.WITCH]:   { model: 'witch.glb',  animations: { idle: 'witch_idle.glb' } },
  // [EntityType.ZOMBIE]:  { model: 'zombie.glb', animations: { idle: 'zombie_idle.glb', walking: 'zombie_shamble.glb' } },
});

/** Look up the rig config for an entity. Returns the entry from
 *  UNIT_RIG_BANK if the entity's type has a rig defined; otherwise null
 *  (caller falls back to cone+sphere pawn). Pure; exported for tests. */
export function getUnitRigConfig(entity) {
  if (!entity || !entity.type) return null;
  return UNIT_RIG_BANK[entity.type] || null;
}

/** Should this entity render with a 3D model rig (vs. the generic pawn)?
 *  Thin predicate over getUnitRigConfig — true iff the entity's type is
 *  in UNIT_RIG_BANK. */
export function unitUsesPaladinModel(entity) {
  return getUnitRigConfig(entity) != null;
}

// ─── Standee constants (Phase 3) ────────────────────────────────────────────
// Units are now rendered as traditional board-game tokens — a coloured cone
// "body" with a spherical "head" on top, both tinted in the owning player's
// colour. The previous tombstone-shaped silhouette + portrait sticker was
// retired so the icon billboard (a separate task) can carry the unit identity.
//
// STANDEE_BASE_WIDTH/HEIGHT are retained as the legacy "silhouette bounding
// box" (still consumed by the plan-ghost positioning helper); the cone/sphere
// constants below describe the actual body geometry. Leader entities scale all
// three (base disc, cone, sphere) up to read as "important" from far out.
export const STANDEE_BASE_WIDTH       = 0.7;
export const STANDEE_BASE_HEIGHT      = 1.0;
export const STANDEE_BASE_DIAMETER    = 0.75;
// Was 0.06 when each standee carried a ground disc as its anchor. The disc
// has been retired but the formula `cone.position.y = STANDEE_BASE_Y_OFFSET
// + STANDEE_BASE_THICKNESS / 2 + coneHeight / 2` is wired across many call
// sites; setting thickness to 0 collapses the leftover legacy term to nothing
// without churning every formula. The y math just reads `OFFSET + coneH/2`.
export const STANDEE_BASE_THICKNESS   = 0;
export const STANDEE_LEADER_WIDTH_MUL  = 1.2;
export const STANDEE_LEADER_HEIGHT_MUL = 1.3;
// Cone body dimensions (centred on Y axis; bottom rim wider than top to read
// as a traditional "meeple" / board-game pawn). Bottom rim sits flush on the
// top face of the base disc — no extra Y offset beyond the disc's thickness.
export const STANDEE_CONE_HEIGHT          = 0.55;
export const STANDEE_CONE_DIAMETER_BOTTOM = 0.55;
export const STANDEE_CONE_DIAMETER_TOP    = 0.18;
// Sphere "head" diameter — sits centred on the cone's flat top.
export const STANDEE_SPHERE_DIAMETER      = 0.32;
// Y-offset for the base disc centre so it sits clear of the tile prism top
// (which is at y=0.075). The cone/sphere are positioned relative to this disc.
// Was 0.18 when the ground disc sat 0.105 clear of the tile prism top (0.075).
// With the disc retired and TERRAIN_DISC_Y_OFFSET at 0.084, lowering this to
// 0.084 puts the cone's bottom rim exactly on the tile top so the paladin GLB
// model's feet land on the ground rather than floating ~13 cm above it.
export const STANDEE_BASE_Y_OFFSET    = 0.084;

// Building world-space offset within its tile — aliased to TILE_SLOTS[1] (the
// "NE" outer slot) so building/tree/standee co-tenancy on the same hex shares
// the unified slot layout. Frozen so callers can't mutate it accidentally.
// Distance from centre comfortably clears the STANDEE_BASE_DIAMETER=0.75 disc.
export const BUILDING_OFFSET = Object.freeze({ x: 0.42, z: -0.42 });

// ─── Building labels (hover text above each building) ───────────────────────
// Mirrors the 2D renderer's fade-on-zoom logic from src/renderer.js (~line
// 1684): labels are fully visible when the camera is close (small radius) and
// fade out as the camera zooms back (large radius). 2D uses
//   effectiveHex = hs * zoomLevel  (bigger as you zoom in)
//   alpha = clamp((effectiveHex - 40) / (60 - 40), 0, 1)
// We use ArcRotateCamera radius (smaller = closer) instead, so the formula
// inverts the sign — see `labelAlphaForZoom`.

/** Camera radius at or below which building labels are fully visible. */
export const BUILDING_LABEL_FADE_RADIUS_CLOSE = 12;
/** Camera radius at or above which building labels are fully invisible. */
export const BUILDING_LABEL_FADE_RADIUS_FAR   = 28;
/** World-units height above the building roof at which the label plane sits. */
export const BUILDING_LABEL_Y = 1.55;
/** Plane size (world units) for the label sprite. */
export const BUILDING_LABEL_WIDTH  = 1.6;
export const BUILDING_LABEL_HEIGHT = 0.4;
/** Texture canvas dimensions (px). Power-of-two friendly. */
export const BUILDING_LABEL_TEX_W = 256;
export const BUILDING_LABEL_TEX_H = 64;

// ─── Power-node tint overlay + name label ───────────────────────────────────
// A faint faction-tinted hex sits over every power-node tile (just above the
// terrain disc, below highlight / plan layers), and a single billboarded name
// label floats above the cluster's centre hex. Both retint when the
// controller flips (hero / witch / neutral / contested) and hide under fog
// alongside the existing node ring discs.
//
// Layered Y ordering (kept consistent with the renderer's other ground decals):
//   terrain disc 0.084  →  node tint 0.095  →  road/river ribbons 0.085-0.088
//   →  highlight 0.12   →  plan disc 0.16-0.18

/** Y offset (world units) for the translucent per-hex tint disc. Sits just
 *  above the terrain disc (0.084) so it doesn't z-fight, but stays below the
 *  highlight band (0.12) and the plan ghost layer. */
export const NODE_TINT_Y = 0.095;
/** Diameter (world units) of the translucent tint disc. Matches the existing
 *  NODE_DISC_DIAMETER so it covers the same tile footprint as the node ring. */
export const NODE_TINT_DIAMETER = 1.9;
/** Material alpha for the tint disc — 10% per the operator brief: enough to
 *  read as a faint faction wash, light enough that the underlying terrain
 *  texture and ring tube still dominate. */
export const NODE_TINT_ALPHA = 0.1;

/** Y offset (world units) for the floating power-node name label. Slightly
 *  below building labels (1.55) so the two overlays don't collide on a tile
 *  that happens to be both a node hex and a building. */
export const NODE_LABEL_Y = 1.4;
/** Plane size (world units) of the floating name label. Wider than the
 *  building label since node names (e.g. "The Crooked Pine") can be long. */
export const NODE_LABEL_WIDTH  = 2.4;
export const NODE_LABEL_HEIGHT = 0.55;
/** DynamicTexture canvas dimensions (px) for the node label. */
export const NODE_LABEL_TEX_W = 384;
export const NODE_LABEL_TEX_H = 96;

/** Resolve the display text for a power-node label. Returns the objective's
 *  human-readable label, or a sensible fallback if missing. Pure helper for
 *  tests. */
export function nodeLabelText(obj) {
  if (!obj) return '';
  if (typeof obj.label === 'string' && obj.label.length > 0) return obj.label;
  return 'Power Node';
}

/** Resolve the tint / label colour for a controller. Thin alias over
 *  `getNodeGlowColor` so the two overlays share one source of truth — if the
 *  glow palette is retuned, the tint and label retint with it. */
export function nodeOverlayColor(controller) {
  return getNodeGlowColor(controller);
}

/** Resolve a node's *identifying* colour — the per-node palette entry that
 *  matches the 2D score-dot HUD, independent of who currently controls the
 *  node. Accepts either a witchObjective (uses its baked-in `.color`) or a
 *  numeric index (looks up `NODE_COLORS`). Falls back to the first palette
 *  entry on bad input.
 *
 *  The score dots in the HUD (`src/ui-render.js`) read `obj.color`, which is
 *  set at map-gen from `NODE_COLORS` in `src/map.js`. Painting the 3D label
 *  text + outer identifier ring in the same colour lets a player tie "the
 *  red dot in the HUD" to "the red-labelled node on the map" at a glance. */
export function nodeIdentifyingColor(objOrIndex) {
  if (objOrIndex && typeof objOrIndex === 'object'
      && typeof objOrIndex.color === 'string' && objOrIndex.color.length > 0) {
    return objOrIndex.color;
  }
  if (typeof objOrIndex === 'number' && Number.isFinite(objOrIndex)) {
    const n = NODE_COLORS.length;
    const i = ((Math.trunc(objOrIndex) % n) + n) % n;
    return NODE_COLORS[i];
  }
  return NODE_COLORS[0];
}

/** Diameter (world units) of the static per-node identifier ring — the
 *  outer hex outline painted in the node's identifying palette colour.
 *  Sits just outside the controller-coloured ring (radius ≈ 0.96) so both
 *  reads as a concentric pair without overlap. */
export const NODE_IDENTIFIER_RING_RADIUS = 1.04;
/** Tube radius of the identifier ring. Thinner than the controller ring
 *  (0.06) so the controller signal stays dominant; the identifier just
 *  adds a quiet outline of palette colour. */
export const NODE_IDENTIFIER_RING_TUBE = 0.045;


// ─── Pure helpers (exported for tests; no Babylon dependency) ────────────────

/** World-unit radius for a single hex tile. */
export const HEX_RADIUS_WORLD = 1;

/** Duration (in frames at 60fps) of focus-shift animations.
 *  18 frames ≈ 300ms — long enough to read, short enough not to feel slow. */
export const FOCUS_ANIM_FRAMES = 18;

/** Epsilon below which a focus shift is treated as a no-op (skip animation). */
export const FOCUS_EPSILON = 1e-3;

/** Camera radius selection-driven focus zooms IN to (never out past current).
 *  Picked to frame ~3-tile diameter around the unit on a standard map. */
export const SELECTION_FOCUS_RADIUS = 14;

/** Camera tilt (beta) is permanently locked at π/4 (45°). Earlier rounds
 *  allowed a clamped tilt range with Tilt-up/Tilt-down buttons and a
 *  right-drag dy → beta branch; both were removed (operator decision —
 *  tilt-lock task) so the board always reads as a fixed isometric. The
 *  camera's lowerBetaLimit and upperBetaLimit are both pinned to π/4 in
 *  _initBabylon, so any stray beta mutation is immediately re-clamped. */
// Locked tilt angle for the ArcRotateCamera (radians from +Y). Higher = more
// top-down; π/2 would be a flat-on horizon view. 35° → camera sits higher in
// the sky and looks down more sharply, which reads the texture-rich top faces
// and standee silhouettes clearly without going pure top-down.
export const CAMERA_BETA_LOCKED = Math.PI * 35 / 180;

/** Repeat cadence for hold-to-repeat rotate buttons (ms). */
export const CAMERA_BUTTON_REPEAT_MS = 50;

/** Camera radius at zoomLevel === 1.0. The 2D renderer expresses zoom as a
 *  unitless multiplier on hex size; the 3D camera works in ArcRotate `radius`.
 *  We bridge the two by mapping zoom→radius reciprocally: setZoom(N) →
 *  radius = DEFAULT_ZOOM_RADIUS / N (clamped to the camera's radius limits).
 *  12 sits in the middle of [4, 80] and frames a standard map's centre at
 *  a comfortable working distance. */
export const DEFAULT_ZOOM_RADIUS = 12;

/** Step size (radians) applied by the rotate-left/right HUD buttons. ≈14°
 *  per click — enough to feel like a meaningful nudge without disorienting. */
export const ROTATE_BUTTON_STEP = Math.PI / 12;

/** Update interval (ms) for the on-canvas FPS / ms-per-frame chip. Updating
 *  every frame would cost a layout per frame for no readable gain; 100ms is
 *  fast enough to feel live while keeping DOM churn negligible. */
export const FPS_COUNTER_UPDATE_MS = 100;

/** Format the FPS chip label. Pure — both inputs come straight from Babylon's
 *  Engine (`getFps()`, `getDeltaTime()`). Returns e.g. "60.0 fps · 16.7 ms".
 *  Non-finite or negative inputs are coerced to 0 so a transient NaN on the
 *  first frame doesn't render as "NaN fps". */
/** Format a "polys: {drawn} / {total}" label with thousands separators.
 *  Drawn = polys actually rendered this frame (post frustum cull).
 *  Total = sum of all triangle indices across every mesh + instance in
 *  the scene, regardless of visibility. */
export function formatPolyLabel(totalPolys, activePolys) {
  const fmt = (n) => {
    const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
    return v.toLocaleString('en-US');
  };
  return `polys: ${fmt(activePolys)} / ${fmt(totalPolys)}`;
}

export function formatFpsLabel(fps, dtMs) {
  const safeFps = Number.isFinite(fps) && fps >= 0 ? fps : 0;
  const safeDt  = Number.isFinite(dtMs) && dtMs >= 0 ? dtMs : 0;
  return `${safeFps.toFixed(1)} fps · ${safeDt.toFixed(1)} ms`;
}

/** Translate a 2D-style zoom multiplier into an ArcRotateCamera radius.
 *  Reciprocal mapping (higher zoom = smaller radius = closer in); the result
 *  is clamped to [lowerRadiusLimit, upperRadiusLimit]. Pure helper for tests. */
export function zoomToRadius(zoom, lowerLimit = 4, upperLimit = 80, defaultRadius = DEFAULT_ZOOM_RADIUS) {
  const z = Math.max(1e-3, zoom);
  const r = defaultRadius / z;
  return Math.max(lowerLimit, Math.min(upperLimit, r));
}

/** Inverse of zoomToRadius — used when external code asks for the current
 *  zoom level and the 3D renderer needs to report it from its radius. */
export function radiusToZoom(radius, defaultRadius = DEFAULT_ZOOM_RADIUS) {
  const r = Math.max(1e-3, radius);
  return defaultRadius / r;
}

/** Building-label alpha for a given camera radius. Mirrors the 2D renderer's
 *  fade ramp but operates on ArcRotateCamera `radius` (smaller = closer in).
 *  Returns 1.0 at fadeStart (or closer), 0.0 at fadeEnd (or farther), and a
 *  linear interpolation in between. Pure helper for tests. */
export function labelAlphaForZoom(
  radius,
  fadeStart = BUILDING_LABEL_FADE_RADIUS_CLOSE,
  fadeEnd   = BUILDING_LABEL_FADE_RADIUS_FAR,
) {
  if (fadeEnd <= fadeStart) return radius <= fadeStart ? 1 : 0;
  const a = (fadeEnd - radius) / (fadeEnd - fadeStart);
  return Math.max(0, Math.min(1, a));
}

/** Returns the human-readable label string for a tile, or null if the tile
 *  doesn't get a label (anything other than a BUILDING tile with a building
 *  field). Pure helper — single source of truth for label text + visibility. */
export function labelTextForTile(tile) {
  if (!tile || !hasBuilding(tile) || !tile.building) return null;
  return BUILDING_LABEL[tile.building] || tile.building;
}

/** Distance between two pointer positions. Pure helper used by the two-finger
 *  pinch path of the custom camera input. */
export function pinchDistance(p1, p2) {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

/** Angle (radians) of the segment p1→p2, measured via atan2. Used by the
 *  two-finger twist path: the difference between two such angles is the
 *  rotation the user's fingers have swept since the previous frame. */
export function pinchAngle(p1, p2) {
  return Math.atan2(p2.y - p1.y, p2.x - p1.x);
}

/** Twist delta given previous and current pinch angles, normalised to
 *  (-π, π]. Without normalisation a wraparound from +179° to -179° would
 *  spin the camera nearly all the way around in a single frame; this helper
 *  picks the short way round so two-finger rotation stays continuous through
 *  the discontinuity at ±π. */
export function twistDelta(prevAngle, currAngle) {
  let d = currAngle - prevAngle;
  // Normalise to (-π, π].
  while (d >  Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Two-finger gesture intent-lock thresholds. The operator's iPhone playtest
 *  found simultaneous pinch+twist "wonky" — any tiny twist noise applied
 *  while pinching would shake the camera, and vice versa. The fix is to
 *  sample for a short window when the second finger lands, decide whether
 *  the user wants pinch (zoom) or twist (rotate), and ignore the other axis
 *  for the rest of the gesture (until a finger lifts). */
export const PINCH_LOCK_THRESHOLD_PX  = 6;          // ~6 pixels of spread
export const TWIST_LOCK_THRESHOLD_RAD = 3 * Math.PI / 180; // ≈0.052 rad / 3°
export const GESTURE_SAMPLING_WINDOW_MS = 100;

/** Sensitivity for the 2-finger pinch → radius mapping. 25px of spread
 *  corresponds to ~1 radius unit. */
export const PINCH_RADIUS_PER_PX = 0.04;

/** Pixel distance below which a pointerdown→pointerup is treated as a click
 *  instead of a drag. Tuned to operator playtest — 6px is loose enough to
 *  forgive a shaky finger or a noisy trackpad without classifying a real pan
 *  drag as a click. Used by `wasClick` below + the custom pointer handlers
 *  to gate `_lastGestureWasDrag`.
 *
 *  Why this exists: in 3D mode the custom pointer input calls
 *  `e.preventDefault()` on `pointermove` (necessary so the browser doesn't
 *  text-select / scroll during a pan). preventDefault on pointermove
 *  suppresses the compat `mousemove` event, which is what ui.js's
 *  `_didDragPan` guard listens to — so without this flag the synthetic
 *  `click` on pointerup runs unconditionally and the empty-hex branch
 *  deselects the user's unit. The renderer tracks the drag itself and ui.js
 *  consults `_lastGestureWasDrag`. */
export const CLICK_DRAG_THRESHOLD_PX = 6;

/** Pure predicate: did the pointer travel little enough between down and up
 *  to count as a click? Exported for unit-testing the drag-vs-click rule
 *  without spinning up Babylon. */
export function wasClick(downPos, upPos, threshold = CLICK_DRAG_THRESHOLD_PX) {
  if (!downPos || !upPos) return false;
  const dx = (upPos.x ?? 0) - (downPos.x ?? 0);
  const dy = (upPos.y ?? 0) - (downPos.y ?? 0);
  return Math.hypot(dx, dy) <= threshold;
}

/** Pure helper: convert a per-frame pinch-distance delta (px, positive when
 *  fingers spread apart) into the radius change to apply to the camera.
 *
 *  Convention (matches mobile platform norms):
 *    • Fingers spread (dDist > 0) → zoom IN → radius shrinks → returns negative.
 *    • Fingers pinch (dDist < 0) → zoom OUT → radius grows → returns positive.
 *
 *  Note: Babylon's ArcRotateCamera applies `radius -= inertialRadiusOffset`
 *  each frame, so the call site negates this when accumulating into
 *  `inertialRadiusOffset`. */
export function pinchDeltaToRadiusDelta(dDist, perPx = PINCH_RADIUS_PER_PX) {
  return -dDist * perPx;
}

/** Decide which two-finger gesture intent the user has expressed.
 *
 *  Inputs are the absolute Δ-from-start of each axis (distance in pixels,
 *  angle in radians), the elapsed ms since the second finger landed, and a
 *  thresholds bag (overridable for tests; defaults match the constants
 *  above).
 *
 *  Return values:
 *    'zoom'      — pinch threshold crossed first → lock to radius
 *    'rotate'    — twist threshold crossed first → lock to alpha
 *    'sampling'  — neither threshold crossed yet AND the window has not
 *                  expired; caller should wait for more motion
 *    'none'      — sampling window expired with both axes still negligible
 *                  (relative motion below ~10% of either threshold either
 *                  side); the gesture is essentially idle, fall through
 *
 *  Tie-break rule: when both axes cross their threshold in the same frame
 *  (or both are sub-threshold at window expiry but one is decisively
 *  larger), the axis with greater *relative* motion (Δ / threshold) wins.
 *  That keeps the choice scale-free — a 12px pinch vs a 6° twist is
 *  unambiguously a zoom; a 6px pinch vs a 6° twist tips the same way it
 *  would at twice the scale.
 *
 *  Pure helper — no DOM/Babylon — so it can be unit-tested directly.
 */
export function gestureLockDecision(deltaDist, deltaAngle, elapsedMs, thresholds = {}) {
  const pinchT   = thresholds.pinch   ?? PINCH_LOCK_THRESHOLD_PX;
  const twistT   = thresholds.twist   ?? TWIST_LOCK_THRESHOLD_RAD;
  const windowMs = thresholds.windowMs ?? GESTURE_SAMPLING_WINDOW_MS;

  const dDist  = Math.abs(deltaDist);
  const dAngle = Math.abs(deltaAngle);
  const rPinch = pinchT > 0 ? dDist  / pinchT : 0;
  const rTwist = twistT > 0 ? dAngle / twistT : 0;

  const pinchHit = rPinch >= 1;
  const twistHit = rTwist >= 1;

  if (pinchHit && twistHit) {
    // Same-frame double crossing — use relative motion to tie-break.
    return rPinch >= rTwist ? 'zoom' : 'rotate';
  }
  if (pinchHit) return 'zoom';
  if (twistHit) return 'rotate';

  // Neither crossed yet — keep sampling unless the window has run out.
  if (elapsedMs < windowMs) return 'sampling';

  // Window expired with no clean cross — pick the axis with the larger
  // relative motion, but bail out to 'none' if both are essentially zero
  // (under 10% of their threshold) so a still 2-finger touch doesn't lock
  // into a random axis.
  const NEGLIGIBLE = 0.1;
  if (rPinch < NEGLIGIBLE && rTwist < NEGLIGIBLE) return 'none';
  return rPinch >= rTwist ? 'zoom' : 'rotate';
}

/** Decide the initial two-finger gesture mode given the pointer types that
 *  just made up the gesture.
 *
 *  On touch (mobile), two fingers ALWAYS mean zoom — the twist-rotate branch
 *  is removed entirely because in practice it triggers accidentally while
 *  pinching to zoom. The caller still has rotate available via the on-screen
 *  rotate buttons and (on desktop) shift+wheel / right-drag.
 *
 *  On non-touch input (desktop two-finger trackpad gesture mapped to pointer
 *  events, hybrid devices, etc.) we keep the existing 'sampling' flow so the
 *  intent-lock heuristic can pick zoom vs rotate from early motion.
 *
 *  Pure helper — no DOM/Babylon — so it can be unit-tested directly. */
export function gestureModeForTwoFingerStart(pointerTypes) {
  if (Array.isArray(pointerTypes) && pointerTypes.some(t => t === 'touch')) {
    return 'zoom';
  }
  return 'sampling';
}

/** Compute pan-clamp bounds for the camera target from the playable map's
 *  visual extent. The clamp keeps the target inside the playable bbox, so
 *  the playable map is always the visible subject (rather than sliding off
 *  into the border-forest band).
 *
 *  `extent` is the output of `computeMapBounds(state.tiles)` — already padded
 *  by half a hex on each side so the bbox covers full rendered tile area,
 *  not just tile centres. `fudgeHex` is extra slack (in hex radii) past that
 *  visual edge; default is 0 so the target is bound strictly to the visual
 *  extent. Earlier values (2 world units, then 0.5 hex) still let the
 *  playable area slide far enough off-frame at the locked 45° tilt that the
 *  border forest dominated the view — the camera's tilt biases the visible
 *  ground centre away from the target, so any positive fudge compounded with
 *  that offset.
 *
 *  Pure helper — Babylon-free, so it's unit-testable. */
export function panBoundsForPlayableExtent(extent, fudgeHex = 0) {
  if (!extent) return null;
  const fudge = fudgeHex * HEX_RADIUS_WORLD;
  return {
    minX: extent.minX - fudge,
    maxX: extent.maxX + fudge,
    minZ: extent.minZ - fudge,
    maxZ: extent.maxZ + fudge,
  };
}

/** Clamp a camera pan target so it can't roam beyond the map's XZ extents.
 *  Returns a new {x, y, z} object — does not mutate the input. `margin` is
 *  in world units, applied uniformly outside the map bounds (so the player
 *  can frame the edge tiles with a little breathing room).
 *
 *  Pure helper — Babylon-free, so it's unit-testable. */
export function clampPanTarget(target, bounds, margin = 0) {
  if (!target || !bounds) return target;
  const minX = bounds.minX - margin;
  const maxX = bounds.maxX + margin;
  const minZ = bounds.minZ - margin;
  const maxZ = bounds.maxZ + margin;
  return {
    x: Math.max(minX, Math.min(maxX, target.x)),
    y: target.y ?? 0,
    z: Math.max(minZ, Math.min(maxZ, target.z)),
  };
}

const SQRT3 = Math.sqrt(3);

/**
 * Offset (col,row) → world (x,z) for a pointy-top, odd-r hex grid.
 * Matches the 2D renderer's hexToPixel layout, scaled so radius = 1 world unit.
 * Y is left to the caller (we always render on the XZ plane).
 */
export function hexToWorld(col, row, radius = HEX_RADIUS_WORLD) {
  return {
    x: radius * SQRT3 * (col + 0.5 * (row & 1)),
    z: radius * 1.5 * row,
  };
}

/**
 * Bounding box (in world units) for a set of hex positions.
 * Pads by the hex's footprint so the box covers the whole rendered tiles,
 * not just their centres. Returns null for an empty set.
 */
export function computeMapBounds(hexes, radius = HEX_RADIUS_WORLD) {
  if (!hexes || hexes.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const h of hexes) {
    const { x, z } = hexToWorld(h.col, h.row, radius);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  // Half-width / half-height of a single hex (pointy-top, unit radius).
  const padX = radius * SQRT3 / 2;
  const padZ = radius;
  return {
    minX: minX - padX, maxX: maxX + padX,
    minZ: minZ - padZ, maxZ: maxZ + padZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    width:   (maxX - minX) + 2 * padX,
    depth:   (maxZ - minZ) + 2 * padZ,
  };
}

/**
 * Pick a camera radius so a `fitWidth × fitDepth` rectangle on the ground
 * fills the canvas at the locked isometric tilt. Uses the larger of the two
 * dimensions and the vertical FOV (Babylon default ≈ 0.8 rad).
 *
 * `aspect` is renderWidth / renderHeight. `margin` is multiplicative slack
 * around the fit (1.05 = 5% headroom).
 */
export function radiusForFit(fitWidth, fitDepth, aspect, fov = 0.8, margin = 1.05) {
  const safeAspect = Math.max(1e-6, aspect);
  const rForDepth = (fitDepth / 2) / Math.tan(fov / 2);
  const rForWidth = (fitWidth / 2) / (Math.tan(fov / 2) * safeAspect);
  return Math.max(rForDepth, rForWidth) * margin;
}

/**
 * Variant of `radiusForFit` that only fits the DEPTH (screen-vertical world
 * axis). The width may overflow horizontally — by design — so the playable
 * map fills the screen vertically and the operator never sees sky / off-map
 * background past the top or bottom edge. Used for the max-zoom-out cap and
 * the fit-map button so the playable area always covers the viewport.
 *
 * `fitWidth` is ignored; kept in the signature so callers can swap helpers
 * without dropping the argument.
 */
export function radiusForFitDepth(_fitWidth, fitDepth, _aspect, fov = 0.8, margin = 1.05) {
  return (fitDepth / 2) / Math.tan(fov / 2) * margin;
}

/**
 * Camera radius required to fit the standard 13×13 map at a given aspect /
 * FOV / margin. Used as the camera's `upperRadiusLimit` so larger maps
 * (regional, campaign, battle) can never zoom out further than a standard
 * view — the player has to pan to see the rest of the map. Pure helper.
 *
 * `paddingHexes` mirrors the per-side hex padding `_frameFullMap` applies so
 * the cap matches what a default-frame would show on a standard map exactly.
 */
export function radiusForStandardFit(aspect, fov = 0.8, margin = 1.05, paddingHexes = 1) {
  return radiusForMapFit(null, aspect, fov, margin, paddingHexes);
}

/**
 * Radius required to fit the actual playable map in `state.tiles` at the
 * given aspect / FOV / margin. Falls back to the standard 13×13 layout if
 * `state` is null (init time, before state has been set). The cap is
 * applied as the camera's `upperRadiusLimit` so larger maps (regional,
 * campaign, battle) reach an upper bound that actually fits THEIR
 * footprint — not the standard footprint — and the operator can see the
 * whole battle map without panning.
 */
export function radiusForMapFit(state, aspect, fov = 0.8, margin = 1.05, paddingHexes = 1) {
  let positions;
  if (state && state.tiles && typeof state.tiles.values === 'function') {
    positions = [];
    for (const t of state.tiles.values()) {
      if (t && typeof t.col === 'number' && typeof t.row === 'number') {
        positions.push({ col: t.col, row: t.row });
      }
    }
  }
  if (!positions || positions.length === 0) {
    const cfg = MAP_SIZES.standard;
    positions = [];
    for (let c = 0; c < cfg.cols; c++) for (let r = 0; r < cfg.rows; r++) {
      positions.push({ col: c, row: r });
    }
  }
  const bounds = computeMapBounds(positions);
  if (!bounds) return 0;
  const padding = paddingHexes * HEX_RADIUS_WORLD * SQRT3;
  const fitWidth = bounds.width + 2 * padding;
  const fitDepth = bounds.depth + 2 * padding;
  // Fit DEPTH only — playable map always covers the screen vertically at the
  // max-zoom-out cap so the operator never sees background past the top/
  // bottom edge. Width may overflow horizontally; pan covers that.
  return radiusForFitDepth(fitWidth, fitDepth, aspect, fov, margin);
}

/**
 * Camera radius required so a square of `minVisibleHexes × minVisibleHexes`
 * fits inside the frustum — used as the camera's `lowerRadiusLimit` (max
 * zoom-in). Pulling in closer than this makes the camera dive into individual
 * meshes and breaks picking/clipping; backing off until N hexes are visible
 * gives a comfortable close-up where the player can still read tile context.
 *
 * `margin` defaults to 1.0 (tight): the helper returns the minimum radius
 * that still shows N hexes across, with no extra slack. Pure helper.
 */
export function radiusForCloseFit(minVisibleHexes, aspect, fov = 0.8, margin = 1.0) {
  const n = Math.max(1, minVisibleHexes);
  const fitWidth = n * HEX_RADIUS_WORLD * SQRT3;
  const fitDepth = n * HEX_RADIUS_WORLD * 1.5;
  return radiusForFit(fitWidth, fitDepth, aspect, fov, margin);
}

/** Minimum hex span we want visible at max zoom-in. 5 reads as a comfortable
 *  close-up: the focused tile plus its full ring of neighbours, with a touch
 *  of context past them. Closer than that and we start clipping into meshes. */
// Was 5; dropped to 1.5 so the operator can zoom in close enough to fill the
// screen with a single unit / hex. Lower bound shifts radiusForCloseFit down
// and lets the camera get within a hex-width of its target before the radius
// limit kicks in.
export const MIN_VISIBLE_HEXES = 1.5;

/**
 * Per-side depth (in hexes) the forest border band must cover so that, when
 * the camera is panned all the way to a corner of the playable extent at
 * maximum zoom-out (`upperRadiusLimit`), the visible frustum is still filled
 * with forest past the playable rectangle.
 *
 * The visible half-extents at the locked isometric tilt are approximated as
 * `radius * tan(fov/2)` in world units (depth axis) and that × aspect (width
 * axis). We divide by the column/row hex pitch (SQRT3 and 1.5 world units
 * respectively) and round up, then add a small safety margin so the player
 * never sees the void at the corner.
 *
 * Returns the maximum of column- and row-direction requirements (uniform
 * band depth — cleanest visually). Pure helper.
 */
export function forestBandDepthForView(radius, aspect, fov = 0.8, safetyHexes = 3) {
  if (!Number.isFinite(radius) || radius <= 0) return 0;
  const safeAspect = Math.max(1e-6, aspect);
  const halfViewZ = radius * Math.tan(fov / 2);
  const halfViewX = halfViewZ * safeAspect;
  const colPitch = HEX_RADIUS_WORLD * SQRT3;
  const rowPitch = HEX_RADIUS_WORLD * 1.5;
  const colsNeeded = Math.ceil(halfViewX / colPitch);
  const rowsNeeded = Math.ceil(halfViewZ / rowPitch);
  return Math.max(colsNeeded, rowsNeeded) + Math.max(0, safetyHexes | 0);
}

/**
 * Returns true when a focus shift is large enough to be worth animating.
 * Skips no-op transitions where the camera is already (approximately) at the
 * requested target+radius — animating a no-op wastes a frame and produces a
 * visible micro-stall.
 */
export function shouldAnimateFocus(curTarget, curRadius, newTarget, newRadius, epsilon = FOCUS_EPSILON) {
  if (Math.abs(curRadius - newRadius) > epsilon) return true;
  const dx = (curTarget?.x ?? 0) - (newTarget?.x ?? 0);
  const dy = (curTarget?.y ?? 0) - (newTarget?.y ?? 0);
  const dz = (curTarget?.z ?? 0) - (newTarget?.z ?? 0);
  return (dx * dx + dy * dy + dz * dz) > epsilon * epsilon;
}

/** Set `receiveShadows = true` on every (non-null) mesh in the iterable.
 *
 *  Babylon's `ShadowGenerator` casts onto any scene mesh whose `receiveShadows`
 *  flag is true; without it the shadow pass simply doesn't touch the mesh and
 *  the surface renders as if no caster were present. We pin the flag on every
 *  flat ground-hugging surface that wants the sun's silhouettes — road
 *  ribbons, river ribbons, river-extension ribbons through the border-forest
 *  band, and bridge planks — so unit shadows fall through correctly instead
 *  of vanishing as the standee crosses onto the path.
 *
 *  Null-safe (skips missing meshes — meshes go missing when MergeMeshes
 *  refuses a degenerate list). Returns the count of meshes touched, mostly
 *  for tests + diagnostics. Setting the flag is idempotent on Babylon's side
 *  so the helper is safe to call more than once.
 *
 *  Apply at mesh construction time, BEFORE `_freezeStaticMeshes()` runs.
 *  `receiveShadows` is a property on the mesh, not the world matrix, so the
 *  freeze pass doesn't disturb it — but ordering it before keeps the build
 *  graph readable. */
export function applyShadowReceiving(meshes) {
  if (!meshes) return 0;
  let n = 0;
  for (const mesh of meshes) {
    if (!mesh) continue;
    mesh.receiveShadows = true;
    n++;
  }
  return n;
}

/** Parse `#rrggbb` → [r,g,b] in 0..1; returns magenta on parse failure (loud). */
const _RGB_CACHE = new Map();
export function cssHexToRgb01(hex) {
  if (_RGB_CACHE.has(hex)) return _RGB_CACHE.get(hex);
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 0, 1];
  const n = parseInt(m[1], 16);
  const rgb = [
    ((n >> 16) & 0xff) / 255,
    ((n >>  8) & 0xff) / 255,
    ( n        & 0xff) / 255,
  ];
  _RGB_CACHE.set(hex, rgb);
  return rgb;
}

/**
 * Color a tile by its type. Phase 2 keeps it simple: every TileType maps
 * to its TILE_COLOR directly (so rivers read as blue, roads as brown,
 * bridges as blue under their plank deck) and buildings to BUILDING_COLOR.
 *
 * Note this diverges from the 2D renderer's _drawTile, which draws roads
 * and rivers on a grass base and overlays strips on top. In 3D we already
 * have separate meshes for road decks and bridge planks, so the underlying
 * tile colour can be its honest type colour without losing visual signal.
 */
export function tileColorFor(tile) {
  if (!tile) return TILE_COLOR[TileType.GRASS];
  // The disc/prism colour is the tile's REAL base material (grass/forest/dirt).
  // Roads, rivers and bridges no longer collapse to grass — the bezier network
  // pass overlays the path on top of the honest base. Buildings show their base
  // material under the box/roof props (BUILDING_COLOR is the prop colour, set in
  // _buildTileMesh, not the disc colour).
  return TILE_COLOR[baseOf(tile)] || TILE_COLOR[TileType.GRASS];
}

// ─── 2D thumbnail helpers (UI portrait + terrain icons) ─────────────────────
// These exist for `getPortraitDataURL` / `getTileDataURL`, which the unit-
// stats bar (and other ui.js portrait callsites) invokes on the renderer
// regardless of mode. The 3D renderer doesn't draw to a 2D canvas at runtime,
// but it still owns the shared sprite atlas, so it's the natural place to
// produce these tiny offscreen-canvas thumbnails.

/** Trace a flat-top hexagon path on a 2D canvas context, centred at (cx, cy)
 *  with radius r. Matches the 2D renderer's `_traceHexPath` so thumbnails
 *  rendered through either renderer look identical. */
function _traceHexPath2D(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (Math.PI / 3) * i;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Pick a hex fill colour for the terrain thumbnail. Roads/rivers/bridges
 *  collapse to grass (their cosmetic strips are layered on top in the 2D
 *  renderer but we don't replicate those for thumbnails). */
function _tileFillColor(tile) {
  if (!tile) return TILE_COLOR[TileType.GRASS];
  // Building thumbnails show the building's colour as the informative cue;
  // everything else fills from the real base material so a road-over-forest
  // thumbnail reads as forest rather than collapsing to grass.
  if (hasBuilding(tile)) {
    return BUILDING_COLOR[tile.building] || '#8a7a5a';
  }
  return TILE_COLOR[baseOf(tile)] || TILE_COLOR[TileType.GRASS];
}

/** Choose a representative sprite id (e.g. 'grass_3') for a tile, hashed
 *  deterministically by (col, row) so the same hex always renders the same
 *  variant. Lighter version of the 2D renderer's `_pickVariant` — we only
 *  cover the variant pools that exist in the atlas (grass/forest/dirt). */
export function _terrainThumbSpriteId(tile, col, row) {
  if (!tile) return null;
  // Real base material — a road/river/building thumbnail picks the sprite for
  // its true base (e.g. forest under a road) rather than collapsing to grass.
  const base = baseOf(tile);
  const variants = { grass: 5, forest: 5, dirt: 5 };
  const count = variants[base];
  if (!count) return null;
  // Stable hash mirroring the 2D renderer's variant choice.
  const hash = Math.abs((col * 73856093) ^ (row * 19349663)) % count;
  return `${base}_${hash + 1}`;
}

// ─── Renderer class ──────────────────────────────────────────────────────────

export class Renderer3D {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.state  = state;
    /** Flag inspected by ui.js so it can bypass 2D-specific drag-pan / pinch
     *  handlers that would otherwise fight the custom 3D camera input. */
    this.is3D   = true;

    // Unified overlay map (`_overlays` / `_selection` / `_hover`). All overlay
    // state flows through setOverlay / getOverlay / setSelection / setHover —
    // the legacy `highlightHexes` / `selectedHex` field proxies were retired
    // across PRs 2–5.
    installOverlayShims(this);

    // ── Interface property slots (read/written by main.js and ui.js) ────────
    this.onImagesLoaded     = null;
    this.aiDebugOverlay     = null;
    this.insetLeft          = 0;
    this.insetRight         = 0;
    // Selection + hover state live on `_selection` / `_hover` (initialised by
    // installOverlayShims above); the legacy field proxies were retired in PR 3.
    // 3D camera drag mode: 'pan' (default) or 'rotate'. UI toggle button
    // flips this via `setCameraDragMode`. Pinch / wheel always zooms.
    this.cameraDragMode     = 'pan';
    this.planGhostSteps     = null;
    this.viewLocked         = false;
    this.zoomLevel          = 1.0;
    this.hexSize            = 30;
    this.useTileImages      = true;
    this._zoomAnim          = null;
    this._panX              = 0;
    this._panY              = 0;
    this.disambigHiddenIds  = new Set();

    // ── Babylon state — populated by _initBabylon() on first draw ───────────
    this._babylon       = null; // module namespace once loaded
    // ── Building GLB model state (see `_loadBuildingModels`) ──────────────
    // `_buildingTemplates`   : Map<relPath, { mesh, scale }> — one hidden
    //                          source mesh per unique GLB variant path across
    //                          BUILDING_GLB_BY_TYPE. Building tiles render
    //                          `mesh.createInstance(...)` so all instances of
    //                          a type share one vertex buffer / material.
    //                          `scale` is the bbox-derived uniform scale that
    //                          lands the template at TARGET_BUILDING_WORLD_HEIGHT.
    // `_buildingLoadPromises`: Map<relPath, Promise> — de-dupes concurrent
    //                          loads of the same path. A failed load leaves the
    //                          path absent from `_buildingTemplates`, so tiles
    //                          of that type keep the procedural box+roof.
    this._buildingTemplates   = new Map();
    this._buildingLoadPromises = new Map();
    this._assetsBasePath   = null; // captured by loadImages()
    // ── Tree-pack GLB state (see `_loadTreePackManifest`) ─────────────────
    // `_treeTemplates`     : Map<filename, mesh>   — hidden source meshes,
    //                       one per unique GLB file loaded from the manifest.
    //                       Instances reference these via createInstance().
    // `_treeGroupsByName`  : Map<groupName, filename[]> — manifest group →
    //                       loaded filenames in that group. The seasonal
    //                       FOREST builder picks one filename per tree slot
    //                       via `pickTreeFileForSlot`.
    // `_treePackLoadPromise`: de-dupes concurrent load attempts.
    // `_useRealTrees`      : feature flag — true once at least one template
    //                       loaded. False keeps the procedural cone+sphere
    //                       path active (intentional fallback so a missing
    //                       manifest never blocks gameplay).
    this._treeTemplates      = new Map();
    this._treeGroupsByName   = new Map();
    this._treePackLoadPromise = null;
    this._useRealTrees       = false;
    // Translucent template clones for the border-forest edge fade, keyed by
    // `file@a<alpha>`. Cloned once per (file, alpha) so faded border trees can
    // still hardware-instance off a shared (faded) template instead of forcing
    // per-instance alpha. The opaque `_treeTemplates` are never mutated, so the
    // in-map forest stays fully opaque. See `_fadedTreeTemplateFor`.
    this._fadedTreeTemplates  = new Map();
    // ── Paladin GLB model state (see `_loadPaladinModel`) ─────────────────
    // _paladinSource: { mesh, skeleton, idleGroup } — the imported source
    // skinned mesh, its skeleton, and the idle AnimationGroup. Each hero
    // standee gets a fresh clone of all three so animations advance
    // independently per-unit. Null until the GLB load resolves; null forever
    // if the file is missing or fails to parse — hero standees keep the
    // cone+sphere fallback in that case.
    this._paladinSource     = null;
    this._paladinLoadPromise = null; // de-dupes concurrent load attempts
    // Uniform scale applied to cloned paladin meshes. Computed once at load
    // time from the source mesh's natural bbox height so the visible model
    // lands at TARGET_PALADIN_WORLD_HEIGHT regardless of FBX export units
    // (m vs cm). Falls back to PALADIN_BASE_SCALE if bbox is unavailable.
    this._paladinScale      = PALADIN_BASE_SCALE;
    // Local-space distance from the paladin model's origin to its feet
    // (= -minY of the aggregated hierarchy bbox, positive). Used at clone
    // time to lift the cloned root so the model's feet rest on the cone
    // anchor — without it the Mixamo hip-pivot puts the feet below the
    // base disc. Defaults to 0 when bbox is unavailable.
    this._paladinFeetOffset = 0;
    this._engine        = null;
    this._scene         = null;
    this._camera        = null;
    this._light         = null;
    this._mapRoot       = null; // TransformNode parent for all tile meshes
    this._materialCache = new Map(); // hex string → BABYLON.StandardMaterial
    this._tileMeshes    = [];   // for picking + future incremental rebuild
    this._mapBuilt      = false;
    // Per-map deterministic season tag — picked in `_buildMap` from a hash of
    // the tile layout (or `state.mapSeed` if exposed later). Drives seasonal
    // tree palettes + geometry. Null until the map is built.
    this._season        = null;
    this._babylonInit   = null; // pending init promise (de-dupes draw() calls)

    // ── Loading-screen asset bundle (see beginLoad / whenReady / onProgress) ─
    // beginLoad() populates `_assetBundle` with one item per major load
    // (engine, atlas, houses, paladin, forest). Each item carries a smoothed
    // `progress: 0..1` — bumped by byte-level ImportMeshAsync callbacks while
    // the GLB streams, then pinned to 1 on settle. `onProgress(progress01,
    // label)` fires with the aggregate (mean of all item fractions) every time
    // any item advances. whenReady() resolves once every item settles. The
    // scene stays hidden behind the loading overlay (main.js) until whenReady
    // resolves, then fades in.
    this._assetBundle   = null;  // [{ id, label, promise, progress, settled }]
    this._loadStarted   = false; // beginLoad idempotency guard
    this.onProgress     = null;  // (progress01, label?) => void, set by main.js
    this._loadTimeoutMs = 30000; // whenReady safety timeout (overridable in tests)

    // Tile top-face textures (see "Tile top-face textures" banner below).
    // Both keyed by sprite id ('grass_3', 'dirt_1', 'road', …) so every tile of
    // one variant shares one Texture + one Material — ~10 unique materials for
    // the textured-terrain set across an entire Campaign-size map.
    this._terrainTextureCache    = new Map();
    this._terrainMaterialCache   = new Map();
    this._terrainFogMaterialCache = new Map(); // darkened variants for fog-of-war
    // Per-(base-material, alpha) translucent CLONES of the fogged terrain (or
    // colour-fog fallback) material, used by the border-forest GROUND edge fade
    // so the band's ground dissolves in lockstep with its trees. Kept separate
    // from the shared terrain caches so the playable map's opaque ground
    // materials are never mutated. See `_borderGroundMaterialFor`.
    this._borderGroundAlphaMatCache = new Map();
    // Per-instance fog-tint multiplier — initialised from the FOG_TILE_DARKEN
    // export but tunable at runtime via `setFogTint` (and per-phase via the
    // optional `cfg.fogTint` field consumed by `_applyLightConfig`).
    this._fogTileDarken = FOG_TILE_DARKEN;
    // Per-hex lookup for visual-only border-forest cylinders, so
    // `_upgradeTileTextures` can swap their material when the atlas arrives
    // after init (parallel to `_tileMeshByKey` for playable tiles).
    this._borderForestHexesByKey = new Map();
    // Border-forest band is visible by default — the wilderness frame is
    // part of the intended visual. Toggle off live with the `F` hotkey
    // if it's tanking fps on a slow GPU.
    this._borderForestHidden = false;
    // Bridge plank meshes are disabled — the road tube already crosses the
    // river hex correctly, and the arched plank read as a toy more than a
    // bridge. The mesh builder, rotation helper, and tilesExtent helper are
    // left in place so this can be flipped back on cheaply if we want to
    // iterate on the look later. Flip to true to restore the old plank.
    this._renderBridges = false;
    // One-shot warning gate per failed sprite id, so a missing or broken
    // sprite doesn't spam the console once per redraw.
    this._textureWarnedFor     = new Set();

    // ── Phase 6: atmosphere + fog veil ──────────────────────────────────────
    // Per-hex lookup of the main tile mesh and its props (forest cones, road
    // decks, bridge planks, building boxes/roofs). Populated by _buildTileMesh.
    // Used by _applyFogVeil to swap tile materials and hide props on hexes the
    // observer can't see.
    this._tileMeshByKey   = new Map();   // hexKey → base hex cylinder
    this._tilePropsByKey  = new Map();   // hexKey → Array<Mesh> (forest, road, bridge, bldg, roof)
    // Visual-only forest border surrounding the playable map (see
    // _buildMapBorderForest). Kept on a separate map from _tilePropsByKey so
    // gameplay-coupled passes (fog veil, slot reassignment) never pick these
    // up — they live in a parallel namespace that just renders.
    this._borderPropsByKey = new Map(); // hexKey → Array<Mesh>
    // Cross-tile merged tree meshes for the border-forest band. One trunk
    // mesh + one mesh per leaf-colour bucket (≤10 total) instead of 2–4 per
    // tile (≈240–900 meshes at max zoom-out). Lives in its own registry so
    // `_syncBorderForestVisibility` can toggle these alongside the per-tile
    // hex cylinders. Built by `_buildBorderForestTreesBatched`.
    this._borderForestBatchMeshes = []; // Mesh[]
    // Item 2 — bezier road/river networks, ONE merged mesh per network.
    this._riverNetworkMesh = null;       // merged tube mesh; null when not built
    this._roadNetworkMesh  = null;
    // Item 8 — static (build-time) per-tile occupant registry consumed by the
    // per-draw standee re-slot pass.
    this._staticOccupantsByKey = new Map(); // hexKey → [{id, kind: 'building'|'tree'}]
    // Per-tile Set of TILE_SLOTS indices a road deck crosses on a forest tile
    // (from `roadBlockedTreeSlots`). Computed at build time so the per-draw
    // standee re-slot reserves the same slots the forest trees skipped.
    this._roadBlockedSlotsByKey = new Map(); // hexKey → Set<slotIdx>
    // Item 8 — overflow "+N" badges keyed by hexKey; created lazily when a
    // tile has more standees than free slots, disposed when overflow drops to 0.
    this._overflowBadges       = new Map(); // hexKey → { plane, mat, tex, lastN }
    // Building hover labels: floating planes above each building tile, fade
    // with camera zoom (alpha pumped each frame in `_onBeforeRender`). Built
    // alongside the building mesh in `_buildTileMesh`; never rebuilt because
    // map topology is immutable once the game starts.
    this._buildingLabelsByKey  = new Map(); // hexKey → { plane, mat, tex }
    this._fogMaterialCache = new Map();  // base hex color → darker StandardMaterial
    this._fogActiveSet     = new Set();  // hexKeys currently rendered as fogged
    // Power-node glow meshes: { obj, disc, col, row, glowColor } per node hex.
    this._nodeGlowMeshes   = [];
    this._nodeGlowBuilt    = false;
    // Power-node tint discs: one translucent faction-tinted hex per node hex.
    // Recoloured each draw alongside the glow ring; hidden via the per-tile
    // fog veil (registered into `_tilePropsByKey`). Built lazily alongside
    // the node ring tubes in `_buildNodeGlowMeshes`.
    this._nodeTintMeshes   = [];           // [{ obj, mesh, mat, col, row }]
    // Power-node floating name labels: one billboarded plane per node, anchored
    // above the cluster's centre hex. Keyed by centre-hex key so the per-tile
    // fog veil can hide them in `_setTileFogged` without freezing the world
    // matrix (billboarding requires per-frame matrix sync — registering in
    // `_tilePropsByKey` would freeze the plane and lock its rotation).
    this._nodeNameLabels   = [];           // [{ obj, plane, mat, tex, hexKey, lastCtrl }]
    this._nodeLabelsByCenterHex = new Map(); // hexKey → label entry (above)
    // Phase-driven lighting state. Pumped by _onBeforeRender each frame; draw()
    // notices state.phase changes and starts a new 3-second eased transition.
    this._lightState = null;            // populated on first draw after init
    this._lastPhase  = null;
    this._phaseTransition = null;       // { from, to, startMs, durMs } or null
    this._onBeforeRenderObs = null;     // observer handle so we can dispose it
    // FPS counter throttle state — see _pumpFpsCounter / FPS_COUNTER_UPDATE_MS.
    this._fpsCounterEl       = null;
    this._polyCounterEl      = null;
    this._fpsCounterLastMs   = 0;

    // ── Phase 3: standees + selection ───────────────────────────────────────
    // Map<entityId, { plane, base, assetId, ownerKey, leader }> for incremental diff.
    this._entityStandees   = new Map();
    // Cache: assetId → BABYLON.Texture (built lazily from the loaded tilemap).
    this._portraitTextures = new Map();
    // Cache: BABYLON.StandardMaterial per asset id (sprite-textured plane material).
    this._portraitMaterials = new Map();
    // Cache: base material per "ownerKey" so all standees of one player share a material.
    this._baseMaterialCache = new Map();
    // Last selectedEntityId we acted on, so we only retarget the camera on change.
    this._lastSelectedEntityId = null;
    // ── Per-unit ground-level hex outlines ─────────────────────────────────
    // Every alive unit gets a thin owner-tinted hex ring on its tile (the
    // "thin" mesh, always visible). When that unit is selected we hide the
    // thin ring and show a thicker glowing variant (the "thick" mesh).
    // Map<entityId, { thin, thick, ownerKey }>. Driven by
    // `_syncEntityHexOutlines` (called from draw()) and selection-toggled by
    // `_applySelectionAndFocus`. Independent of `_syncEntityStandees` so it
    // doesn't tangle with concurrent token / HP-bar work above the unit.
    this._entityHexOutlines      = new Map();
    this._thinOutlineMatCache    = new Map(); // ownerKey → StandardMaterial
    this._thickOutlineMatCache   = new Map(); // ownerKey → StandardMaterial
    // Backing image + sprite rects for the tilemap (loaded by loadImages()).
    this._tilemapImg  = null;
    this._spriteRects = null;

    // Locked camera angles. Alpha (yaw) is the user's initial heading — the
    // right-drag / two-finger twist / rotate buttons spin freely from there.
    // Beta (tilt) is permanently π/4 (45°) — see CAMERA_BETA_LOCKED.
    this._lockedAlpha = -Math.PI / 4;
    this._lockedBeta  = CAMERA_BETA_LOCKED;

    // ── Phase 5: animations, plan arrows, HP bars ──────────────────────────
    // In-flight Babylon animations expressed as Promises that resolve when
    // their animation/timeout completes. waitForAnimations() awaits the set;
    // each promise self-removes when it resolves.
    this._animPromises    = new Set();
    // Set of entity ids whose standee is currently being driven by a move or
    // lunge animation; _syncEntityStandees skips _positionStandee for these
    // so the animation isn't snapped back to the state position every frame.
    this._activeMoveIds   = new Set();
    this._activeLungeIds  = new Set();
    // Map<entityId, { mesh, texture, lastHp, lastMax }> — billboarded HP bar
    // parented to the standee base, redrawn only when ratio changes.
    // Retained as a no-op compatibility hook; the floating-icon badge below
    // now carries the HP indicator (as a circular arc rim) and the
    // rectangular bar is no longer built.
    this._hpBars          = new Map();
    // Map<entityId, { plane, mat, tex, lastHp, lastMax, lastAssetId, leader }>
    // — floating unit-icon billboard above each entity's cone+sphere body.
    // Texture composites a portrait disc with a coloured HP ring; repainted
    // only when HP / maxHp / assetId change.
    this._unitIconBadges  = new Map();
    // [{ mesh, owner, fromCol, fromRow, toCol, toRow }] — solid ghost-arrow tubes
    // rebuilt every draw() from this.planGhostSteps so the overlay tracks any
    // plan-step edit.
    this._planArrowMeshes = [];
    // Reusable plan-arrow materials, keyed by owner colour.
    this._planArrowMatCache = new Map();
    // Cached material used to highlight a hex on attack flash.
    this._attackHexFlashMat = null;
    // Change-detect signature for the plan-arrow overlay. Recomputed each
    // draw() from steps + per-entity owner colour; identical signature → skip
    // the dispose/rebuild cycle entirely (otherwise plan-edit drags GC a fresh
    // marker + dash + badge per MOVE step every frame).
    this._planArrowSig = '';
    // Plan-mode battle overlay: red attack-arrow tubes + ×N badges,
    // rebuilt every draw from `this.planGhostSteps` (BATTLE_UNIT /
    // BATTLE_HEX steps). Mirrors `_planArrowMeshes` but for attacks
    // instead of moves. Each entry: { shaft, head1, head2, mat,
    // badge, badgeMat, badgeTex }.
    this._planBattleMeshes = [];
    // Change-detect signature for the battle overlay; same purpose as
    // `_planArrowSig` but for attackArrow steps + per-target ×N counts.
    this._planBattleSig = '';
    // Single shared red material for all attack arrow tubes — every
    // attack uses the same colour, so one allocation is enough.
    this._attackArrowMat = null;

    // ── Highlight overlay (movement / target hexes from ui.js) ─────────────
    // The 2D path tints valid-move and target hexes via `highlightHexes`
    // (set by ui.js _updateHighlights). We mirror that here by laying flat
    // emissive discs on the tagged hexes, rebuilt each draw so the overlay
    // tracks selection changes without dirty-tracking.
    this._highlightMeshes      = [];                  // disposable hex overlay meshes
    this._highlightMatCache    = new Map();           // rgba-string → cached StandardMaterial
    this._highlightSig         = '';                  // change-detect signature
    // Selection + hover outline rings (overlay layer `selection`). Tube rings,
    // owner-tinted for the selection, white-ish for the hover. Rebuilt by
    // `_syncOverlays` with their own signature so they don't churn the
    // highlight-disc diff above.
    this._selectionOverlayMeshes  = [];               // disposable selection/hover ring meshes
    this._selectionOverlayMatCache = new Map();       // "css|emissiveMul" → cached StandardMaterial
    this._selectionOverlaySig      = '';              // change-detect signature
    // Ring-pulse (objective-ring layer) material cache, keyed by
    // overlayMaterialKey(rgb, alpha, glow) so overlays that share a colour share
    // one StandardMaterial — fixes the per-ring material churn the node-ring
    // builder used to incur. Static identifier rings reuse these freely; the
    // controller rings keep per-instance materials (see `_buildObjectiveRings`)
    // because they recolour in place when control of a node flips.
    this._ringPulseMatCache       = new Map();
    // ── Plan ghost (walking previewer) ─────────────────────────────────────
    // For each entity with at least one MOVE step in `planGhostSteps`, a
    // translucent standee clone walks its path on a loop while planning. The
    // plane/material pair is rebuilt only when the path signature changes;
    // per-frame motion happens in `_onBeforeRender` so the animation runs
    // independently of game-state redraws.
    this._planGhostMeshes  = new Map();   // entityId → { plane, mat, path, signature }
    this._planGhostSig     = '';          // joined per-entity signatures
  }

  // ─── Required interface (real implementations) ───────────────────────────

  /** Lazy-init Babylon on first draw. Babylon owns its own render loop; on
   *  later draw() calls we just diff entities and apply selection changes.
   *  Most state writes (selectedEntityId, entity moves) flow through draw()
   *  via main.js's onRedraw, so this is where the standee diff and camera
   *  focus updates happen. */
  draw() {
    // Render-only by contract. `beginLoad()` is the sole entry point that
    // boots Babylon and populates the asset bundle — draw() never triggers
    // init anymore. It still no-ops while the scene is in flight so any
    // state-change redraw fired before whenReady() resolves is harmless.
    if (!this._scene) return; // not ready yet — beginLoad() drives init
    this._syncEntityStandees();
    this._syncEntityIconBillboards();
    this._syncEntityHexOutlines();
    this._applySelectionAndFocus();
    // _syncOverlays is the SINGLE dispatcher for the unified overlay map: it
    // publishes the state-derived overlays (move + battle plan arrows,
    // objective rings) and then dispatches every overlay kind to a builder that
    // reads the descriptor. The four legacy per-system sync entry points
    // (movement highlights, plan move arrows, plan battle arrows, node glow)
    // were retired in PR 5 — this one call replaces them.
    this._syncOverlays();
    this._syncPlanGhosts();
    // Phase 6: atmosphere updates — phase-driven lighting transitions and the
    // fog veil. Node-glow recolour now happens inside _syncOverlays via the
    // ring-pulse builder. Standees are hidden in fogged hexes after the standee
    // sync above so newly-built standees are tagged correctly.
    this._notePhaseChange();
    this._applyFogVeil();
  }

  // ─── Loading-screen API ──────────────────────────────────────────────────
  //
  // The 3D renderer fires several heavy loads (Babylon engine, tilemap atlas,
  // house GLB, paladin GLB, tree pack). Historically these ran fire-and-forget
  // from `_initBabylon` and the scene rendered procedural fallbacks that
  // visibly morphed into the real assets over a few seconds. main.js now hides
  // the canvas behind a loading overlay until `whenReady()` resolves, ticking a
  // progress bar from `onProgress`.

  /** Kick off Babylon init + every tracked asset load and populate
   *  `_assetBundle`. Idempotent — calling twice does nothing the second time.
   *  Each scene-dependent loader (house/paladin/trees) is chained behind the
   *  engine promise; the loaders themselves de-dupe (they cache their in-flight
   *  promise), so `_initBabylon`'s own fire-and-forget kickoff and the bundle's
   *  re-invocation share a single network load. Per-item `.catch(() => null)`
   *  means an individual GLB failure never rejects `whenReady` — the renderer
   *  keeps its procedural fallback.
   *
   *  @param {string} [basePath] - absolute or relative asset root. Pass an
   *    ABSOLUTE base (e.g. '/assets') when the host page is served from a
   *    sub-path URL (such as `/admin/tools`); otherwise the relative default
   *    'assets' resolves against the page's directory and 404s. Supplied
   *    synchronously here because `loadImages()` only pins `_assetsBasePath`
   *    after its async image load — too late for this call to read. Omit it to
   *    keep the relative default (correct for the root-served live game). */
  beginLoad(basePath) {
    if (this._loadStarted) return;
    this._loadStarted = true;

    if (typeof basePath === 'string' && basePath) this._assetsBasePath = basePath;
    basePath = this._assetsBasePath || 'assets';

    // Engine + scene. This is the existing init path (no longer triggered by
    // draw()). It also kicks off the scene-dependent loaders fire-and-forget;
    // we re-await their cached promises below so the bundle tracks them.
    const babylonP = this._babylonInit
      || (this._babylonInit = this._initBabylon().catch(err => {
        console.error('[Renderer3D] Babylon init failed:', err);
      }));

    // tilemap atlas — independent of the scene.
    const atlasP = this.loadImages(basePath);

    // Scene-dependent GLB loaders. Wait for init, then (re-)invoke each loader.
    // The loaders return their cached in-flight promise (or the loaded source
    // if already resolved), so this never starts a duplicate network load.
    const afterInit = (fn) => babylonP.then(() => (this._scene ? fn() : null));
    const buildingsP = afterInit(() => this._loadBuildingModels(basePath));
    const paladinP   = afterInit(() => this._loadPaladinModel(basePath));
    const treesP     = afterInit(() => this._loadTreePackManifest(basePath));

    this._assetBundle = [
      { id: 'engine',    label: 'engine',    promise: babylonP,   progress: 0 },
      { id: 'sprites',   label: 'sprites',   promise: atlasP,     progress: 0 },
      { id: 'buildings', label: 'buildings', promise: buildingsP, progress: 0 },
      { id: 'paladin',   label: 'paladin',   promise: paladinP,   progress: 0 },
      { id: 'forest',    label: 'forest',    promise: treesP,     progress: 0 },
    ];

    for (const item of this._assetBundle) {
      // `.catch` so a single failed GLB never rejects whenReady; `.finally`
      // pins the item to 100% regardless of resolve/reject order (byte-level
      // ticks may not reach 1 if the server sent no Content-Length).
      item.settled = Promise.resolve(item.promise)
        .catch(() => null)
        .finally(() => {
          item.progress = 1;
          this._emitProgress(item.label);
        });
    }
  }

  /** Advance one bundle item's byte-level progress and re-emit the aggregate.
   *  Monotonic — a regressing or already-settled fraction is ignored, so a
   *  late/duplicate ProgressEvent never drags the bar backwards. No-op before
   *  `beginLoad()` populates the bundle or for an unknown id. */
  _setItemProgress(id, frac) {
    if (!this._assetBundle) return;
    const item = this._assetBundle.find(b => b.id === id);
    if (!item) return;
    const f = Math.max(0, Math.min(1, frac));
    if (!(f > (item.progress || 0))) return;
    item.progress = f;
    this._emitProgress(item.label);
  }

  /** Build an ImportMeshAsync `onProgress` handler bound to one bundle item.
   *  Babylon hands it a ProgressEvent-like `{ lengthComputable, loaded, total }`
   *  per network tick; when the server sent no Content-Length the event isn't
   *  computable and we skip the tick (the item's `.finally` still pins it to 1
   *  on completion, and the shimmer keeps the bar alive in the meantime). */
  _glbProgressHandler(id) {
    return (evt) => {
      if (!evt || !evt.lengthComputable || !(evt.total > 0)) return;
      this._setItemProgress(id, evt.loaded / evt.total);
    };
  }

  /** Re-emit aggregate load progress (mean of every item's 0..1 fraction).
   *  `label` is the item that just advanced, surfaced as the overlay caption. */
  _emitProgress(label) {
    if (typeof this.onProgress !== 'function') return;
    const items = this._assetBundle;
    if (!items || items.length === 0) return;
    let sum = 0;
    for (const b of items) sum += (b.progress || 0);
    const progress01 = sum / items.length;
    try {
      this.onProgress(progress01, label);
    } catch (err) {
      console.warn('[Renderer3D] onProgress handler threw:', err);
    }
  }

  /** Resolve once every bundle item has settled (resolved OR rejected). A
   *  safety timeout (`_loadTimeoutMs`, default 30s) resolves anyway with a
   *  console.warn so a hung load never traps the player behind the overlay.
   *  Returns immediately if `beginLoad()` was never called. */
  whenReady() {
    if (!this._assetBundle) return Promise.resolve();
    const all = Promise.all(this._assetBundle.map(b => b.settled)).then(() => undefined);
    const ms = this._loadTimeoutMs;
    if (!(ms > 0)) return all;
    const safety = new Promise(resolve => {
      const t = setTimeout(() => {
        console.warn(`[Renderer3D] whenReady safety timeout (${ms}ms) — revealing scene anyway`);
        resolve();
      }, ms);
      // Don't keep a node test process alive waiting on the timer.
      if (t && typeof t.unref === 'function') t.unref();
    });
    return Promise.race([all, safety]);
  }

  resize() {
    // Size the canvas to its wrapper, same approach as the 2D renderer.
    const wrapper = this.canvas.parentElement;
    if (wrapper) {
      const W = wrapper.clientWidth  || this.canvas.width  || 800;
      const H = wrapper.clientHeight || this.canvas.height || 600;
      if (this.canvas.width  !== W) this.canvas.width  = W;
      if (this.canvas.height !== H) this.canvas.height = H;
    }
    if (this._engine) this._engine.resize();
    // Aspect ratio may have changed — re-derive the max-zoom cap (and snap
    // the current radius in if it now exceeds the new ceiling).
    this._recomputeMaxZoomCap();
  }

  /** Load assets/tilemap.png so entity standees can crop portrait sprites out
   *  of it. Falls back gracefully (faceless coloured planes) if the tilemap
   *  is unreachable — the renderer must never block the game on a 404. */
  async loadImages(basePath = 'assets') {
    if (typeof Image === 'undefined') {
      if (this.onImagesLoaded) this.onImagesLoaded();
      return;
    }
    const img = new Image();
    await new Promise(resolve => {
      img.onload  = resolve;
      img.onerror = resolve;
      img.src = `${basePath}/tilemap.png`;
    });
    if (img.naturalWidth) {
      this._tilemapImg  = img;
      // Reuse the 2D renderer's sprite-rect layout — single source of truth.
      const { rects } = Renderer._buildSpriteRects();
      this._spriteRects = rects;
      // If Babylon init beat the tilemap to the punch, the map will already
      // exist with solid-colour tops. Retro-fit textured discs onto every
      // tile that supports one. (When loadImages resolves first — the common
      // case — _mapBuilt is still false here and _buildMap will pick textures
      // up naturally.)
      if (this._mapBuilt && this._mapRoot) this._upgradeTileTextures();
      // Standees built before this point have a textureless fallback material
      // cached in `_portraitMaterials`. Upgrade them in place so already-built
      // entities show their portrait once the tilemap finally arrives.
      this._upgradePortraitMaterials();
      // Same race for floating unit-icon badges: any that were painted before
      // the tilemap loaded show only the neutral fallback disc. Re-run the
      // billboard diff now so the badge textures are repainted with the real
      // portrait sprite before the next draw cycle.
      this._syncEntityIconBillboards();
    }
    // Remember the basePath so `_loadBuildingModels` (kicked off from
    // `_initBabylon` once the scene exists) can fetch the GLBs from the same
    // root the tilemap came from.
    this._assetsBasePath = basePath;
    if (this.onImagesLoaded) this.onImagesLoaded();
  }

  /** Inject the Babylon core UMD bundle into the page so `window.BABYLON` is
   *  populated. Idempotent and concurrency-safe — mirrors `_ensureBabylonLoaders`.
   *
   *  Returns the BABYLON global on success, null on failure (no DOM, script
   *  errored, or bundle loaded but didn't populate window.BABYLON).
   *
   *  Why a <script> tag instead of `await import(...)`: the previous ESM
   *  import of @babylonjs/core via the jsdelivr `+esm` wrapper produced a
   *  BABYLON instance distinct from the one the loaders UMD bundle attaches
   *  to, so the glTF plugin never registered on the renderer's SceneLoader.
   *  The UMD bundle solves that by putting the SAME BABYLON on `window`. */
  async _ensureBabylonCore() {
    if (typeof window !== 'undefined' && window.BABYLON) return window.BABYLON;
    if (typeof document === 'undefined') return null;

    if (!this._babylonCorePromise) {
      this._babylonCorePromise = new Promise((resolve) => {
        const existing = document.querySelector('script[data-babylon-core]');
        if (existing) {
          if (existing.dataset.loaded === 'true') {
            return resolve(typeof window !== 'undefined' ? window.BABYLON : null);
          }
          existing.addEventListener('load', () => {
            resolve(typeof window !== 'undefined' ? window.BABYLON : null);
          }, { once: true });
          existing.addEventListener('error', () => resolve(null), { once: true });
          return;
        }
        const s = document.createElement('script');
        s.src = BABYLON_CORE_LOCAL;
        s.async = true;
        s.dataset.babylonCore = 'true';
        s.addEventListener('load', () => {
          s.dataset.loaded = 'true';
          resolve(typeof window !== 'undefined' ? window.BABYLON : null);
        }, { once: true });
        s.addEventListener('error', () => resolve(null), { once: true });
        document.head.appendChild(s);
      });
    }

    const BABYLON = await this._babylonCorePromise;
    if (!BABYLON) {
      console.warn('[Renderer3D] Babylon core script failed to load; 3D renderer unavailable.');
      return null;
    }
    return BABYLON;
  }

  /** Compose `_ensureBabylonCore` + `_ensureBabylonLoaders` so the rest of the
   *  renderer has a single entry point for "make BABYLON available." Core MUST
   *  resolve before loaders run — the loaders bundle augments BABYLON.SceneLoader
   *  on the global created by core. Returns the BABYLON global, or null if core
   *  failed to load (in which case 3D rendering is impossible). A loaders
   *  failure is non-fatal: core works and GLB consumers silently fall back to
   *  their procedural geometry. */
  async _ensureBabylonReady() {
    const BABYLON = await this._ensureBabylonCore();
    if (!BABYLON) return null;
    this._babylon = BABYLON;
    await this._ensureBabylonLoaders();
    return BABYLON;
  }

  /** Inject the Babylon glTF loaders UMD bundle into the page so SceneLoader
   *  recognizes `.glb` / `.gltf` files. Idempotent and shared by every GLB
   *  consumer in the renderer (house, paladin, future props) — registration
   *  is a global side-effect on BABYLON.SceneLoader so the first caller pays
   *  the network cost and subsequent callers fast-path through the cached
   *  promise.
   *
   *  Returns true if the loaders plugin is available after the call (script
   *  loaded AND .glb plugin registered), false otherwise. Callers should not
   *  abort on `false` if their fake BABYLON already stubs ImportMeshAsync —
   *  the test path bypasses the script tag entirely.
   *
   *  Why a `<script>` tag instead of `await import(...+esm)`: the jsdelivr
   *  `+esm` ESM wrapper bundles its own copy of @babylonjs/core, registering
   *  the plugin on the wrong BABYLON instance. The UMD bundle attaches to
   *  the same window.BABYLON the rest of the renderer uses. Asset is served
   *  from the packaged `assets/vendor/` path — no CDN runtime dependency. */
  async _ensureBabylonLoaders() {
    if (this._babylonLoadersReady) return true;
    // No DOM (headless tests / node-test runner): there's no <script> tag to
    // inject. Tests stub SceneLoader directly on the fake BABYLON, so the
    // caller's plugin-availability check will let things proceed regardless.
    if (typeof document === 'undefined') return false;

    const BABYLON = this._babylon;
    const hasPlugin = () =>
      typeof BABYLON?.SceneLoader?.IsPluginForExtensionAvailable === 'function'
        ? !!BABYLON.SceneLoader.IsPluginForExtensionAvailable('.glb')
        : false;

    // Already registered (e.g. an earlier renderer instance, or a host page
    // that loaded the bundle itself). Skip the script injection.
    if (hasPlugin()) {
      this._babylonLoadersReady = true;
      return true;
    }

    if (!this._babylonLoadersPromise) {
      this._babylonLoadersPromise = new Promise((resolve) => {
        const existing = document.querySelector('script[data-babylon-loaders]');
        if (existing) {
          if (existing.dataset.loaded === 'true') return resolve(true);
          existing.addEventListener('load', () => resolve(true), { once: true });
          existing.addEventListener('error', () => resolve(false), { once: true });
          return;
        }
        const s = document.createElement('script');
        s.src = BABYLON_LOADERS_LOCAL;
        s.async = true;
        s.dataset.babylonLoaders = 'true';
        s.addEventListener('load', () => { s.dataset.loaded = 'true'; resolve(true); }, { once: true });
        s.addEventListener('error', () => resolve(false), { once: true });
        document.head.appendChild(s);
      });
    }

    const scriptOk = await this._babylonLoadersPromise;
    if (!scriptOk) {
      console.warn('[Renderer3D] Babylon glTF loaders script failed to load; GLB models unavailable.');
      return false;
    }
    // The script may have loaded but failed to register (CDN returned wrong
    // content, BABYLON global mismatch, etc.). Verify by asking SceneLoader
    // whether it can handle .glb — that's the question we actually care about.
    if (!hasPlugin()) {
      console.warn('[Renderer3D] Babylon loaders script loaded but .glb plugin not registered.');
      return false;
    }
    this._babylonLoadersReady = true;
    return true;
  }

  /** Kick off the load of every unique building-GLB variant path across
   *  `BUILDING_GLB_BY_TYPE` (lazily, in parallel) and retrofit the map once
   *  any of them resolves. Fire-and-forget from `beginLoad`; each individual
   *  load is de-duped + fault-isolated so a missing/broken GLB for one type
   *  never blocks the others or the game. Returns a promise that settles once
   *  all variant loads have settled (used by the loading-screen bundle). */
  async _loadBuildingModels(basePath = 'assets') {
    if (!this._babylon || !this._scene) return null;
    // Collect the unique relative paths (HOUSE contributes two).
    const paths = new Set();
    for (const variants of Object.values(BUILDING_GLB_BY_TYPE)) {
      for (const p of variants) paths.add(p);
    }
    const results = await Promise.all(
      Array.from(paths).map(p => this._loadBuildingModel(p, basePath)),
    );
    // A final retrofit sweep in case the map finished building between the last
    // per-load retrofit and now (per-load retrofits already handle the common
    // case where each GLB resolves after _buildMap).
    if (this._mapBuilt) this._upgradeBuildingsToGlbModel();
    return results;
  }

  /** Lazy-load one building GLB variant (`<basePath>/<relPath>`) and stash it
   *  as a hidden template in `_buildingTemplates` keyed by `relPath`. Building
   *  tiles whose variant resolves to this path render
   *  `mesh.createInstance(...)` of the template so all instances share one
   *  vertex buffer / material. The GLB is intentionally optional: any loader /
   *  import / merge failure leaves the path absent from `_buildingTemplates`,
   *  so tiles of that type keep the procedural box+roof. De-duped per path via
   *  `_buildingLoadPromises`.
   *
   *  Loading the @babylonjs/loaders package has the side-effect of registering
   *  the .glb / .gltf plugins on BABYLON.SceneLoader — without it,
   *  ImportMeshAsync rejects .glb with "Unable to find a plugin". */
  async _loadBuildingModel(relPath, basePath = 'assets') {
    if (!this._babylon || !this._scene || !relPath) return null;
    const existing = this._buildingTemplates.get(relPath);
    if (existing && existing.mesh) return existing.mesh;
    if (this._buildingLoadPromises.has(relPath)) return this._buildingLoadPromises.get(relPath);
    const BABYLON = this._babylon;

    // Split the relative path into rootUrl + fileName for ImportMeshAsync
    // (e.g. 'models/buildings/church.glb' → dir 'models/buildings/', file
    // 'church.glb'). Mirrors how the house path used to be split.
    const slash    = relPath.lastIndexOf('/');
    const dir      = slash >= 0 ? relPath.slice(0, slash + 1) : '';
    const fileName = slash >= 0 ? relPath.slice(slash + 1) : relPath;

    const promise = (async () => {
      // Best-effort loaders plugin registration (no-op if the fake BABYLON in
      // tests already wires SceneLoader.ImportMeshAsync directly).
      await this._ensureBabylonLoaders();

      if (!BABYLON.SceneLoader || typeof BABYLON.SceneLoader.ImportMeshAsync !== 'function') {
        console.warn('[Renderer3D] BABYLON.SceneLoader.ImportMeshAsync unavailable; skipping building model.');
        return null;
      }

      // Import. `null` for meshNames pulls everything in.
      let result;
      try {
        result = await BABYLON.SceneLoader.ImportMeshAsync(
          null,
          `${basePath}/${dir}`,
          fileName,
          this._scene,
          this._glbProgressHandler('buildings'),
        );
      } catch (err) {
        console.warn(`[Renderer3D] ${relPath} load failed; using procedural box for that type.`, err);
        return null;
      }

      // Filter to meshes carrying real geometry (glTF imports include an empty
      // `__root__` TransformNode + N sub-meshes).
      const realMeshes = (result.meshes || []).filter(m =>
        m && typeof m.getTotalVertices === 'function' && m.getTotalVertices() > 0,
      );
      if (realMeshes.length === 0) {
        console.warn(`[Renderer3D] ${relPath} contained no geometry; using procedural box.`);
        return null;
      }

      // Collapse to ONE source mesh so instances share a single vertex buffer
      // + material. `multiMultiMaterials=true` keeps per-submesh textures.
      let source = realMeshes[0];
      if (realMeshes.length > 1 && typeof BABYLON.Mesh?.MergeMeshes === 'function') {
        try {
          const merged = BABYLON.Mesh.MergeMeshes(
            realMeshes,
            /* disposeSource */     true,
            /* allow32BitsIndices */ true,
            /* meshSubclass */       undefined,
            /* subdivideWithSubMeshes */ false,
            /* multiMultiMaterials */ true,
          );
          if (merged) source = merged;
        } catch (err) {
          console.warn(`[Renderer3D] ${relPath} merge failed; falling back to first sub-mesh.`, err);
          source = realMeshes[0];
        }
      }
      if (!source) return null;

      // Pivot fix: drop the source's bounding-box bottom to local Y = 0 so an
      // instance placed at tile-top sits *on* the ground rather than half-sunk.
      _bakeOriginToBottom(source, BABYLON);

      // Hide the template — instances render geometry on its behalf.
      if (typeof source.setEnabled === 'function') source.setEnabled(false);
      source.isPickable = false;
      // World-geometry render group so depth-tests against units/buildings
      // behave like the other terrain props (see PR #361).
      if (typeof source.renderingGroupId !== 'undefined') source.renderingGroupId = 0;

      // Compute a bbox-derived uniform scale so this template's height lands at
      // TARGET_BUILDING_WORLD_HEIGHT regardless of the GLB's intrinsic units.
      // Falls back to HOUSE_INSTANCE_BASE_SCALE when bbox is unmeasurable
      // (test stubs) — instances then multiply by the per-hex jitter ratio.
      let scale = HOUSE_INSTANCE_BASE_SCALE;
      try {
        const info = typeof source.getBoundingInfo === 'function' ? source.getBoundingInfo() : null;
        const bb   = info?.boundingBox;
        if (bb) {
          const minY = bb.minimumWorld?.y ?? bb.minimum?.y ?? 0;
          const maxY = bb.maximumWorld?.y ?? bb.maximum?.y ?? 0;
          const h    = maxY - minY;
          if (h > 1e-3) scale = TARGET_BUILDING_WORLD_HEIGHT / h;
        }
      } catch { /* keep fallback scale */ }

      const triCount = typeof source.getTotalIndices === 'function'
        ? Math.floor((source.getTotalIndices() || 0) / 3) : null;
      console.log(
        `[Renderer3D] ${relPath} loaded (${realMeshes.length} sub-mesh${realMeshes.length === 1 ? '' : 'es'}`
        + (triCount != null ? `, ${triCount} tris` : '')
        + `).`,
      );

      this._buildingTemplates.set(relPath, { mesh: source, scale });

      // If the map's already built (the common case — GLB load is slow,
      // _buildMap runs synchronously right after Babylon init), retrofit the
      // procedural buildings that use this variant.
      if (this._mapBuilt) this._upgradeBuildingsToGlbModel();
      return source;
    })();

    this._buildingLoadPromises.set(relPath, promise);
    return promise;
  }

  /** Create one BABYLON.InstancedMesh of the building tile's chosen GLB variant
   *  template, positioned at the tile's NE building slot with the hash-seeded
   *  scale + yaw jitter so neighbouring buildings don't look stamped out of one
   *  mould. Returns the instance, or null if no template for this tile's
   *  variant is loaded yet (caller falls back to procedural box+roof). */
  _buildBuildingInstance(tile, x, z, parent) {
    if (!this._babylon) return null;
    const variant = buildingGlbVariantForHex(tile);
    if (!variant) return null;
    const tpl = this._buildingTemplates.get(variant);
    if (!tpl || !tpl.mesh) return null;
    const BABYLON = this._babylon;
    const source  = tpl.mesh;
    if (typeof source.createInstance !== 'function') return null;
    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    // Tile-top anchor — matches the procedural building's base Y (0.43 - 0.7/2).
    const tileTopY = 0.43 - 0.7 / 2;
    const baseScale = tpl.scale != null ? tpl.scale : HOUSE_INSTANCE_BASE_SCALE;

    const inst = source.createInstance(`bldgInst_${tile.col}_${tile.row}`);
    if (parent && 'parent' in inst) inst.parent = parent;
    if (inst.position && typeof inst.position === 'object') {
      inst.position.x = x + slot.x;
      inst.position.y = tileTopY;
      inst.position.z = z + slot.z;
    }
    const sc = houseInstanceScalingForHex(tile.col, tile.row);
    if (BABYLON.Vector3) {
      inst.scaling = new BABYLON.Vector3(
        baseScale * sc.x,
        baseScale * sc.y,
        baseScale * sc.z,
      );
      inst.rotation = new BABYLON.Vector3(0, houseYawForHex(tile.col, tile.row), 0);
    }
    inst.isPickable = false;
    // Buildings stay visible under fog of war — permanent terrain, not
    // tactical info. Mirrors the procedural box+roof metadata.
    inst.metadata = { respectsFog: false, kind: 'building-glb', col: tile.col, row: tile.row };
    this._addShadowCaster(inst);
    // World-geometry render group, same as the procedural box+roof + tile
    // cylinders — keeps the depth buffer consistent for unit/building overlap.
    if (typeof inst.renderingGroupId !== 'undefined') inst.renderingGroupId = 0;
    return inst;
  }

  /** Sweep `_tilePropsByKey` for every building tile, dispose the procedural
   *  box + roof meshes (`bldg_…` / `roof_…`), and replace them with a GLB
   *  instance of the tile's chosen variant. Called after each
   *  `_loadBuildingModel` resolves on an already-built map. A tile whose
   *  variant template hasn't loaded (or failed) is left on its procedural
   *  box+roof — so a missing GLB for one type doesn't strip other buildings.
   *  Idempotent: tiles already carrying a `building-glb` instance are skipped.
   *  Re-runs `_freezeStaticMeshes` so new instances get world-matrix-locked. */
  _upgradeBuildingsToGlbModel() {
    if (!this._mapBuilt || this._buildingTemplates.size === 0 || !this.state?.tiles) return 0;
    let upgraded = 0;
    for (const tile of this.state.tiles.values()) {
      if (!buildingUsesGlbModel(tile)) continue;
      const tkey  = hexKey(tile.col, tile.row);
      const props = this._tilePropsByKey.get(tkey) || [];
      // Skip if this tile already holds a GLB building instance.
      if (props.some(m => m?.metadata?.kind === 'building-glb')) continue;

      // Build the instance FIRST — if the tile's variant template isn't loaded
      // yet, bail without touching the procedural meshes so they stay visible.
      const { x, z } = hexToWorld(tile.col, tile.row);
      const inst = this._buildBuildingInstance(tile, x, z, this._mapRoot);
      if (!inst) continue;

      const remaining = [];
      for (const m of props) {
        const name = m?.name || '';
        if (name.startsWith('bldg_') || name.startsWith('roof_')) {
          if (typeof m.dispose === 'function') m.dispose();
          continue;
        }
        remaining.push(m);
      }
      remaining.push(inst);
      upgraded++;
      this._tilePropsByKey.set(tkey, remaining);
    }
    // Freeze pass picks up the new instances. The procedural meshes were
    // already frozen on initial build; the new instances need their world
    // matrices locked too.
    if (upgraded > 0) this._freezeStaticMeshes();
    return upgraded;
  }

  /** Lazy-load the tree-pack manifest at `<basePath>/<TREE_PACK_DIR>manifest.json`
   *  and import every unique GLB file it lists. Each GLB lands as a hidden
   *  template mesh (`setEnabled(false)`); the FOREST + map-border-forest
   *  builders later call `createInstance()` on these templates so a forest
   *  hex with 5 trees still costs one draw call per unique template the GPU
   *  has to dispatch.
   *
   *  Single-mesh GLBs are used directly. Multi-mesh / multi-material GLBs
   *  collapse via MergeMeshes (mirrors `_loadBuildingModel`'s recipe). A
   *  per-template uniform scale is computed at load time so the template's
   *  bbox-height lands at TARGET_TREE_WORLD_HEIGHT — instances then apply
   *  the per-tree FOREST_SCALE_MIN..MAX multiplier on top of that.
   *
   *  The manifest is intentionally optional — any fetch / parse / import
   *  failure leaves `_useRealTrees = false`, so the procedural cone+sphere
   *  path stays active. Test environments can pre-stub `_treeTemplates` /
   *  `_treeGroupsByName` / `_useRealTrees` to drive the build paths without
   *  exercising the network. */
  async _loadTreePackManifest(basePath = 'assets') {
    if (!this._babylon || !this._scene) return null;
    if (this._useRealTrees) return this._treeTemplates;
    if (this._treePackLoadPromise) return this._treePackLoadPromise;
    const BABYLON = this._babylon;

    const promise = (async () => {
      await this._ensureBabylonLoaders();
      if (!BABYLON.SceneLoader || typeof BABYLON.SceneLoader.ImportMeshAsync !== 'function') {
        console.warn('[Renderer3D] BABYLON.SceneLoader.ImportMeshAsync unavailable; skipping tree pack.');
        return null;
      }

      // Step 1: fetch manifest. `fetch` is the only network call here — the
      // GLB loads below go through SceneLoader.ImportMeshAsync which is
      // already wired for asset paths.
      let manifest;
      try {
        const fetchFn = (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function')
          ? globalThis.fetch.bind(globalThis) : null;
        if (!fetchFn) {
          console.warn('[Renderer3D] global fetch unavailable; skipping tree pack.');
          return null;
        }
        const url = `${basePath}/${TREE_PACK_DIR}${TREE_PACK_MANIFEST_FILE}`;
        const res = await fetchFn(url);
        if (!res || !res.ok) {
          console.warn(`[Renderer3D] tree pack manifest fetch failed (${res?.status}); using procedural trees.`);
          return null;
        }
        manifest = await res.json();
      } catch (err) {
        console.warn('[Renderer3D] tree pack manifest fetch failed; using procedural trees.', err);
        return null;
      }

      const groups = manifest?.groups;
      if (!groups || typeof groups !== 'object') {
        console.warn('[Renderer3D] tree pack manifest has no `groups` field; using procedural trees.');
        return null;
      }

      // Step 2: collect every unique file across the "complete" tree groups.
      // Only complete-buckets are loaded — the trunk/leaves split groups
      // aren't used by this loader (they'd need pairwise composition). Other
      // groups (rocks, grass, clouds) are intentionally out of scope for
      // this PR.
      const wantedGroups = [];
      for (const name of Object.keys(groups)) {
        if (/-complete$/.test(name)) wantedGroups.push(name);
      }
      if (wantedGroups.length === 0) {
        console.warn('[Renderer3D] tree pack manifest has no *-complete groups; using procedural trees.');
        return null;
      }

      // Manifest v2 (PR for tree-pack species/region tagging) tags each entry
      // with `{species, region}`. Filter to colonial New England species so
      // the runtime forest excludes any flagged-tropical/exotic trees. The
      // filter is permissive — entries missing a `region` field (manifest v1
      // back-compat, or non-tree extras that slip into a tree-* group) are
      // kept rather than silently dropped.
      const isNewEngland = (e) => {
        if (!e || typeof e.file !== 'string' || e.file.length === 0) return false;
        if (typeof e.region !== 'string') return true;
        return e.region === 'new-england';
      };

      const uniqueFiles = new Set();
      const filesByGroup = new Map(); // groupName → array of file paths
      for (const g of wantedGroups) {
        const entries = Array.isArray(groups[g]) ? groups[g] : [];
        const list = [];
        for (const e of entries) {
          if (!isNewEngland(e)) continue;
          uniqueFiles.add(e.file);
          list.push(e.file);
        }
        if (list.length > 0) filesByGroup.set(g, list);
      }
      if (uniqueFiles.size === 0) {
        console.warn('[Renderer3D] tree pack manifest listed no new-england tree files; using procedural trees.');
        return null;
      }

      // Step 3: import every unique file in parallel. Each import resolves
      // to a single template mesh (single-submesh imports use the mesh
      // directly; multi-submesh imports merge first). Failures are isolated
      // per-file so one bad GLB doesn't kill the whole pack.
      const baseUrl = `${basePath}/${TREE_PACK_DIR}`;
      // Byte-level progress for the 'forest' bundle item is the mean fraction
      // across every tree GLB. Each file's per-tick fraction feeds this map;
      // the item climbs smoothly toward 1 as files stream and settle (a
      // settled file pins to 1 so a missing Content-Length never stalls it).
      const fileCount = uniqueFiles.size;
      const fileFractions = new Map();
      const reportForest = () => {
        let s = 0;
        for (const v of fileFractions.values()) s += v;
        this._setItemProgress('forest', fileCount > 0 ? s / fileCount : 0);
      };
      const loadOne = async (file) => {
        let result;
        try {
          result = await BABYLON.SceneLoader.ImportMeshAsync(
            null, baseUrl, file, this._scene,
            (evt) => {
              if (!evt || !evt.lengthComputable || !(evt.total > 0)) return;
              fileFractions.set(file, evt.loaded / evt.total);
              reportForest();
            },
          );
        } catch (err) {
          console.warn(`[Renderer3D] tree GLB load failed (${file}); skipping.`, err);
          fileFractions.set(file, 1); // settled (failed) — count it as done
          reportForest();
          return null;
        }
        fileFractions.set(file, 1); // file fully streamed
        reportForest();
        const realMeshes = (result?.meshes || []).filter(m =>
          m && typeof m.getTotalVertices === 'function' && m.getTotalVertices() > 0,
        );
        if (realMeshes.length === 0) return null;
        let source = realMeshes[0];
        if (realMeshes.length > 1 && typeof BABYLON.Mesh?.MergeMeshes === 'function') {
          try {
            const merged = BABYLON.Mesh.MergeMeshes(
              realMeshes, true, true, undefined, false, true,
            );
            if (merged) source = merged;
          } catch (err) {
            console.warn(`[Renderer3D] tree GLB merge failed (${file}); using first submesh.`, err);
          }
        }
        if (!source) return null;
        // Drop the mesh pivot to the floor so instances anchor at Y=0.
        _bakeOriginToBottom(source, BABYLON);
        // Hide template — instances render geometry on its behalf.
        if (typeof source.setEnabled === 'function') source.setEnabled(false);
        source.isPickable = false;
        if (typeof source.renderingGroupId !== 'undefined') source.renderingGroupId = 0;
        // Receive shadows. Set on the source mesh AND every child mesh
        // (glTF imports usually put geometry on a child node). Force
        // shader compilation with `useInstances: true` immediately after
        // so the SHADOWS + INSTANCES defines are baked into the shader
        // before any instance triggers an implicit compile — this is
        // the critical step. Without it, the first instance render
        // compiles the shader from the current mesh state at THAT
        // moment, which can drop shadow sampling if Babylon
        // short-circuits on a disabled source mesh.
        const allMeshes = [source];
        if (typeof source.getChildMeshes === 'function') {
          for (const child of source.getChildMeshes()) allMeshes.push(child);
        }
        for (const m of allMeshes) {
          if ('receiveShadows' in m) m.receiveShadows = true;
          if (m.material) {
            if (typeof m.material.markAsDirty === 'function') {
              m.material.markAsDirty(BABYLON.Material?.MiscDirtyFlag ?? 0);
            }
            // Pre-compile with instances + the current scene's shadow
            // generator set on the mesh so the shader includes both
            // INSTANCES and SHADOWS{N} defines from the start.
            if (typeof m.material.forceCompilation === 'function') {
              try {
                m.material.forceCompilation(m, { useInstances: true });
              } catch (_err) { /* compilation may fail in headless tests */ }
            }
          }
        }
        // Stash a bbox-derived per-template uniform scale so callers don't
        // re-measure on every instance. Falls back to 1.0 when bbox is
        // unavailable (test stubs) — caller can multiply by the per-tree
        // FOREST_SCALE_MIN..MAX jitter on top.
        let templateScale = 1.0;
        try {
          const info = typeof source.getBoundingInfo === 'function' ? source.getBoundingInfo() : null;
          const bb = info?.boundingBox;
          const minY = bb?.minimumWorld?.y ?? bb?.minimum?.y ?? 0;
          const maxY = bb?.maximumWorld?.y ?? bb?.maximum?.y ?? 0;
          const h = Math.max(1e-3, maxY - minY);
          templateScale = TARGET_TREE_WORLD_HEIGHT / h;
        } catch { /* keep templateScale = 1 */ }
        source.metadata = Object.assign(source.metadata || {}, {
          kind: 'tree-template', file, templateScale,
        });
        return source;
      };

      const fileList = Array.from(uniqueFiles);
      const loaded = await Promise.all(fileList.map(loadOne));
      for (let i = 0; i < fileList.length; i++) {
        const mesh = loaded[i];
        if (mesh) this._treeTemplates.set(fileList[i], mesh);
      }
      if (this._treeTemplates.size === 0) {
        console.warn('[Renderer3D] tree pack: no templates loaded; using procedural trees.');
        return null;
      }

      // Filter group → file lists down to files that actually loaded.
      for (const [g, files] of filesByGroup) {
        const ok = files.filter(f => this._treeTemplates.has(f));
        if (ok.length > 0) this._treeGroupsByName.set(g, ok);
      }
      if (this._treeGroupsByName.size === 0) {
        console.warn('[Renderer3D] tree pack: no usable groups after filter; using procedural trees.');
        return null;
      }

      console.log(
        `[Renderer3D] tree pack loaded: ${this._treeTemplates.size} templates`
        + ` across ${this._treeGroupsByName.size} group(s).`,
      );
      this._useRealTrees = true;
      // Retrofit any forest tiles built before the load completed.
      if (this._mapBuilt) this._upgradeForestToRealTrees();
      return this._treeTemplates;
    })();

    this._treePackLoadPromise = promise;
    return promise;
  }

  /** Create one real-tree InstancedMesh for a given tree slot. Picks the
   *  template via `pickTreeFileForSlot` against the season's group; falls
   *  back to a clone if `createInstance` isn't supported on the test stub.
   *  Returns null when no template is available (caller falls back to the
   *  procedural cone+sphere path for that slot). */
  /** Return a translucent clone of a loaded tree template at `alpha` < 1, so the
   *  border-forest edge fade can hardware-instance faded trees without mutating
   *  the shared opaque template (which the in-map forest also instances off).
   *  Clones the template hierarchy once per (file, alpha), then clones+fades
   *  every material in it. Returns the plain opaque template when `alpha` ≥ 1,
   *  or null when the file has no template. Cached in `_fadedTreeTemplates`
   *  (null results are cached too, so a failed clone isn't retried per tree). */
  _fadedTreeTemplateFor(file, alpha) {
    if (!(alpha < 1)) return this._treeTemplates.get(file) || null;
    const BABYLON = this._babylon;
    const key = `${file}@a${alpha}`;
    if (this._fadedTreeTemplates.has(key)) return this._fadedTreeTemplates.get(key);
    const src = this._treeTemplates.get(file);
    if (!src || typeof src.clone !== 'function') {
      this._fadedTreeTemplates.set(key, null);
      return null;
    }
    const clone = src.clone(`tree_faded_${key}`);
    if (!clone) { this._fadedTreeTemplates.set(key, null); return null; }
    const meshes = [clone];
    if (typeof clone.getChildMeshes === 'function') {
      for (const c of clone.getChildMeshes()) meshes.push(c);
    }
    for (const m of meshes) {
      if (m.material && typeof m.material.clone === 'function') {
        const fm = m.material.clone(`${m.material.name || 'treemat'}_a${alpha}`);
        this._applyAlphaBlend(fm, alpha);
        // ROOT CAUSE of "border trees stay opaque": a merged GLB tree's material
        // is a MultiMaterial. Its own `alpha` / `transparencyMode` are IGNORED
        // at draw time — each sub-mesh renders with its corresponding
        // SUBMATERIAL (here a trunk PBR + a leaf PBR), so fading only the
        // container left the actual foliage fully opaque. `MultiMaterial.clone()`
        // also shares the original subMaterials by reference, so we must clone
        // each one before fading (otherwise the shared opaque originals the
        // in-map forest instances off would go translucent too), then rebind.
        if (Array.isArray(fm.subMaterials) && fm.subMaterials.length > 0) {
          fm.subMaterials = fm.subMaterials.map((sub) => {
            if (!sub || typeof sub.clone !== 'function') return sub;
            const fsub = sub.clone(`${sub.name || 'submat'}_a${alpha}`);
            this._applyAlphaBlend(fsub, alpha);
            // Re-bake INSTANCES (+ SHADOWS) defines on the faded submaterial so
            // its hardware instances compile the alpha path (see below).
            if (typeof fsub.forceCompilation === 'function') {
              try { fsub.forceCompilation(m, { useInstances: true }); } catch (_e) { /* headless */ }
            }
            return fsub;
          });
        }
        m.material = fm;
        // Re-bake the INSTANCES (+ SHADOWS) shader defines on the faded
        // material so its hardware instances render with shadow sampling,
        // matching the opaque template's pre-compile (see `_loadTreePackManifest`).
        if (typeof fm.forceCompilation === 'function') {
          try { fm.forceCompilation(m, { useInstances: true }); } catch (_e) { /* headless */ }
        }
      }
    }
    if (typeof clone.setEnabled === 'function') clone.setEnabled(false);
    clone.isPickable = false;
    clone.metadata = Object.assign(clone.metadata || {}, { kind: 'tree-template-faded', file, alpha });
    this._fadedTreeTemplates.set(key, clone);
    return clone;
  }

  _buildRealTreeInstance(parent, col, row, tree, treeIdx, namePrefix, opts = {}) {
    if (!this._useRealTrees || !this._babylon) return null;
    const BABYLON = this._babylon;
    const season  = opts.season ?? this._season;
    const alpha   = opts.alpha ?? 1;
    const group   = treeGroupsForSeason(season);
    const files   = this._treeGroupsByName.get(group);
    if (!files || files.length === 0) return null;
    const file = pickTreeFileForSlot(files, col, row, treeIdx);
    if (!file) return null;
    // Faded border-forest tiles instance off a translucent template clone; all
    // other trees (and fully-opaque inner band tiles) use the shared opaque one.
    const template = alpha < 1 ? this._fadedTreeTemplateFor(file, alpha) : this._treeTemplates.get(file);
    if (!template) return null;

    const instName = `${namePrefix}_t${treeIdx}_real`;
    let inst = null;
    if (typeof template.createInstance === 'function') {
      inst = template.createInstance(instName);
    } else if (typeof template.clone === 'function') {
      inst = template.clone(instName);
    }
    if (!inst) return null;

    if (parent && 'parent' in inst) inst.parent = parent;
    const templateScale = template.metadata?.templateScale ?? 1.0;
    const s = templateScale * (tree.scale || 1.0);
    if (BABYLON.Vector3 && (inst.scaling == null || typeof inst.scaling === 'object')) {
      inst.scaling = new BABYLON.Vector3(s, s, s);
    }
    const yaw = _treePackHash(col, row, treeIdx * 17 + 3) * Math.PI * 2;
    if (BABYLON.Vector3 && (inst.rotation == null || typeof inst.rotation === 'object')) {
      inst.rotation = new BABYLON.Vector3(0, yaw, 0);
    }
    if (inst.position && typeof inst.position === 'object') {
      inst.position.x = (opts.cx ?? 0) + tree.x;
      inst.position.y = 0; // bbox bottom already baked to local Y=0
      inst.position.z = (opts.cz ?? 0) + tree.z;
    }
    inst.isPickable = false;
    if (typeof inst.renderingGroupId !== 'undefined') inst.renderingGroupId = 0;
    // Receive shadows from neighbouring trees / buildings / standees as
    // well as cast them. InstancedMesh inherits receiveShadows from its
    // source mesh, so set it on the template too (idempotent — Babylon
    // will short-circuit if already true).
    if (template && 'receiveShadows' in template) template.receiveShadows = true;
    if ('receiveShadows' in inst) inst.receiveShadows = true;
    // Trees stay visible under fog — permanent terrain. Matches the
    // procedural cone+sphere metadata in _buildTileMesh.
    inst.metadata = { respectsFog: false, kind: 'tree-glb', col, row, file };
    this._addShadowCaster(inst);
    return inst;
  }

  /** Build instances for every tree on one forest hex (in-map or border).
   *  Returns the array of instances. Falls back to an empty array when
   *  `_useRealTrees` is false or no template resolves for any slot — caller
   *  should consult the return and fall back to the procedural path when
   *  empty. */
  _buildRealForestTreesForHex(parent, col, row, cx, cz, trees, namePrefix, opts = {}) {
    if (!trees || trees.length === 0) return [];
    const out = [];
    const faded = opts.alpha != null && opts.alpha < 1; // border-band edge fade
    for (let i = 0; i < trees.length; i++) {
      const inst = this._buildRealTreeInstance(
        parent, col, row, trees[i], i, namePrefix, { ...opts, cx, cz },
      );
      if (inst) {
        // Faded border-band trees are alpha-blended — pin the same stable
        // alphaIndex as the merged-cone band path so they don't reshuffle
        // under the per-frame distance sort (see BORDER_TREE_ALPHA_INDEX).
        if (faded) inst.alphaIndex = BORDER_TREE_ALPHA_INDEX;
        out.push(inst);
      }
    }
    return out;
  }

  /** Retrofit forest tiles built before the tree-pack manifest finished
   *  loading. Walks every FOREST tile in `_tilePropsByKey` and the entire
   *  map-border band, disposes the procedural cone+sphere merged meshes,
   *  and rebuilds them as real-tree instances. Idempotent — tiles that
   *  already hold a real-tree instance are skipped. Mirrors
   *  `_upgradeBuildingsToGlbModel`. */
  _upgradeForestToRealTrees() {
    if (!this._mapBuilt || !this._useRealTrees || !this.state?.tiles) return 0;
    let upgraded = 0;

    // In-map FOREST tiles — props key is hexKey, identifies the cluster by
    // the `forest_${col}_${row}_*` name prefix the procedural builder uses.
    for (const tile of this.state.tiles.values()) {
      if (baseOf(tile) !== TileType.FOREST) continue;
      const tkey  = hexKey(tile.col, tile.row);
      const props = this._tilePropsByKey.get(tkey) || [];
      // Skip if this tile already holds a real-tree instance.
      if (props.some(m => m?.metadata?.kind === 'tree-glb')) continue;
      const procIdx = [];
      for (let i = 0; i < props.length; i++) {
        const name = props[i]?.name || '';
        if (name.startsWith(`forest_${tile.col}_${tile.row}_`)) procIdx.push(i);
      }
      if (procIdx.length === 0) continue;
      const { x, z } = hexToWorld(tile.col, tile.row);
      // Same building-slot AND road-deck reservation as the BUILD pass so the
      // real-tree upgrade keeps cones off BUILDING_SLOT_INDEX on
      // building-on-forest tiles and off the road deck on road-through-forest
      // tiles.
      const trees = forestTreesForHex(tile.col, tile.row, this._season, {
        reserveBuildingSlot: hasBuilding(tile),
        blockedSlots: this._roadBlockedSlotsByKey.get(tkey),
      });
      const namePrefix = `forest_${tile.col}_${tile.row}`;
      const insts = this._buildRealForestTreesForHex(
        this._mapRoot, tile.col, tile.row, x, z, trees, namePrefix,
        { season: this._season },
      );
      if (insts.length === 0) continue;
      // Dispose old procedural cluster meshes (back-to-front to keep
      // indices valid as we splice).
      for (let i = procIdx.length - 1; i >= 0; i--) {
        const m = props[procIdx[i]];
        if (m && typeof m.dispose === 'function') m.dispose();
        props.splice(procIdx[i], 1);
      }
      for (const m of insts) props.push(m);
      this._tilePropsByKey.set(tkey, props);
      upgraded++;
    }

    // Border forest — build new real-tree instances FIRST, only dispose the
    // procedural batch if the rebuild actually produced trees. Without this
    // guard a season without a populated template bucket (anything but
    // summer in the current manifest) would dispose the procedural cones
    // and leave the border empty.
    // Re-derive the band depth + extent so the edge-fade alpha matches the
    // original procedural build (see `_buildMapBorderForest`). The band is keyed
    // to the current `_borderForestHexesByKey`, so depth comes straight off each
    // tile's Chebyshev distance from the playable extent.
    const ext = tilesExtent(this.state.tiles);
    let bandDepth = 0;
    for (const [, hex] of this._borderForestHexesByKey) {
      const md = hex?.metadata;
      if (!md) continue;
      bandDepth = Math.max(bandDepth, borderTileDepthFromPlayable(md.col, md.row, ext));
    }
    const newBorderInsts = [];
    for (const [, hex] of this._borderForestHexesByKey) {
      const md = hex?.metadata;
      if (!md) continue;
      const { col, row } = md;
      const { x, z } = hexToWorld(col, row);
      const alpha = borderForestAlphaForTile(col, row, ext, bandDepth);
      const trees = forestTreesForHex(col, row, this._season).filter(t =>
        !this._borderTreeBlockedByRiver(x + t.x, z + t.z),
      );
      if (trees.length === 0) continue;
      const namePrefix = `border_forest_${col}_${row}`;
      const insts = this._buildRealForestTreesForHex(
        this._mapRoot, col, row, x, z, trees, namePrefix, { season: this._season, alpha },
      );
      for (const m of insts) newBorderInsts.push(m);
    }
    if (newBorderInsts.length > 0) {
      if (this._borderForestBatchMeshes && this._borderForestBatchMeshes.length > 0) {
        for (const m of this._borderForestBatchMeshes) {
          if (m && typeof m.dispose === 'function') m.dispose();
        }
      }
      this._borderForestBatchMeshes = newBorderInsts;
      upgraded += newBorderInsts.length;
    }
    // else: keep the existing procedural batch — no real trees available
    // for this season, no reason to wipe what's already on screen.

    if (upgraded > 0) this._freezeStaticMeshes();
    return upgraded;
  }

  /** Lazy-load `<basePath>/models/paladin.glb` and stash it as
   *  `_paladinSource = { mesh, skeleton, idleGroup }`. Each hero standee
   *  later clones all three so per-unit idle animations play independently.
   *  The GLB is intentionally optional: if the loader plugin import, the
   *  ImportMeshAsync call, or the skeleton-resolution step fails, the
   *  renderer silently falls back to the cone+sphere body so a missing file
   *  never blocks gameplay.
   *
   *  Loader registration is delegated to `_ensureBabylonLoaders` so the
   *  house and paladin GLB consumers share a single UMD-script-tag path —
   *  see #371 for why the ESM `+esm` wrapper can't be used. */
  async _loadPaladinModel(basePath = 'assets') {
    if (!this._babylon || !this._scene) return null;
    if (this._paladinSource) return this._paladinSource;
    if (this._paladinLoadPromise) return this._paladinLoadPromise;
    const BABYLON = this._babylon;

    const promise = (async () => {
      // Step 1: register glTF loader plugin via the UMD bundle. Best-effort —
      // if SceneLoader.ImportMeshAsync is already wired (tests stub it
      // directly on the fake BABYLON), the script tag isn't required. Real-
      // browser path: this attaches to window.BABYLON and populates the
      // .glb / .gltf plugin entries on BABYLON.SceneLoader.
      await this._ensureBabylonLoaders();

      if (!BABYLON.SceneLoader || typeof BABYLON.SceneLoader.ImportMeshAsync !== 'function') {
        console.warn('[Renderer3D] BABYLON.SceneLoader.ImportMeshAsync unavailable; skipping paladin model.');
        return null;
      }

      // Step 2: import the GLB. `null` for meshNames pulls everything in.
      let result;
      try {
        result = await BABYLON.SceneLoader.ImportMeshAsync(
          null,
          `${basePath}/${PALADIN_MODEL_DIR}`,
          PALADIN_MODEL_FILE,
          this._scene,
          this._glbProgressHandler('paladin'),
        );
      } catch (err) {
        console.warn('[Renderer3D] paladin.glb load failed; using cone+sphere bodies.', err);
        return null;
      }

      // Step 3: collect every geometry mesh in the import. Mixamo paladin
      // GLBs ship as a hierarchy (helmet + body + cape + …), and PR #375's
      // single-mesh selection produced the "giant floating head" regression
      // — only the helmet was cloned, and the scale derived from the
      // helmet's bbox alone blew it up to fill the target height. Walk the
      // full list, hide every source, and use the aggregated bbox below.
      const meshes = (result.meshes || []).filter(m =>
        m && typeof m.getTotalVertices === 'function' && m.getTotalVertices() > 0,
      );
      if (meshes.length === 0) {
        console.warn('[Renderer3D] paladin.glb contained no geometry; using cone+sphere bodies.');
        return null;
      }
      // The skinned mesh carries the skeleton + animation targets. Prefer
      // the mesh with a skeleton attached (Mixamo's `Beta_Surface`); fall
      // back to the first geometry mesh.
      const skinned  = meshes.find(m => m.skeleton) || meshes[0];
      const skeleton = skinned.skeleton
        || (Array.isArray(result.skeletons) ? result.skeletons[0] : null)
        || null;

      // Idle animation group — Mixamo exports usually label this either by
      // the source clip name ("mixamo.com") or with an explicit "Idle"
      // string. Match either; fall back to the first group available.
      const groups   = result.animationGroups || [];
      const idleGroup = groups.find(g => g && /idle|mixamo/i.test(g.name || ''))
        || groups[0] || null;

      // Hide every source mesh — clones render geometry on their behalf,
      // but the templates themselves must never draw. Hiding only the
      // skinned mesh would leave the helmet / cape submeshes floating at
      // world origin.
      for (const m of meshes) {
        if (typeof m.setEnabled === 'function') m.setEnabled(false);
        m.isPickable = false;
      }
      // Strip root-bone X/Y/Z translation from idle's keyframes so the
      // animation doesn't pull the model away from the cone anchor. Mixamo
      // idle clips often have a Hips.position baseline that lifts the rig
      // off the ground; without this strip the paladin floats. Y is
      // included so the cone's feet-on-tile placement is the SOLE Y
      // authority (no breathing bob, but solid ground contact).
      stripRootBoneTranslation(idleGroup);
      // Start the embedded idle animation immediately so the rig animates
      // from load instead of sitting in bind-pose T-pose. The swap tick
      // (_maybeTogglePaladinAnimation) will stop()/start() between idle and
      // walking based on motion state from there on.
      if (idleGroup && typeof idleGroup.start === 'function') {
        idleGroup.weight = 1.0;
        idleGroup.start(true, 1.0);
      }

      // Compute an aggregate hierarchy bbox + scale so the entire model
      // (helmet to feet) lands at TARGET_PALADIN_WORLD_HEIGHT regardless of
      // submesh count or FBX export units. Store the feet offset separately
      // — applied at clone time via the root's position rather than baked
      // into vertices, so it survives the hierarchical clone path.
      const { scale, feetOffset } = this._normalisePaladinSource(meshes);
      this._paladinScale      = scale;
      this._paladinFeetOffset = feetOffset;

      // Capture the imported TransformNode hierarchy so the walking anim
      // retargeter has a comprehensive name → node map to look up against.
      // Mixamo node names ("mixamorig:Hips", etc) line up between paladin
      // and walking exports, but Babylon's glTF loader uses TransformNodes
      // (not Bones) as the canonical animation targets, so we MUST include
      // every imported TN in the lookup or retargeting silently drops
      // targets and the model T-poses when blend weight flips to walking.
      const transformNodes = Array.isArray(result.transformNodes)
        ? result.transformNodes.slice() : [];
      this._paladinSource = {
        mesh: skinned, meshes, skeleton, idleGroup, walkGroup: null,
        transformNodes,
      };

      // Fire-and-forget the companion animation GLBs. Paladins start at
      // bind pose (or with the model's embedded idle if it has one); as
      // each clip resolves, the blend tick picks it up.
      this._loadWalkingAnimation(basePath).catch(err => {
        console.warn('[Renderer3D] walking.glb load failed; paladins will idle only.', err);
      });
      // Only load a separate idle if the paladin model file isn't already
      // idle.glb — when the model IS idle.glb its embedded animation was
      // already picked up as src.idleGroup above, and loading it again
      // would import duplicate meshes into the scene.
      if (PALADIN_MODEL_FILE !== IDLE_MODEL_FILE) {
        this._loadIdleAnimation(basePath).catch(err => {
          console.warn('[Renderer3D] idle.glb load failed; paladins will stay at bind pose when not moving.', err);
        });
      }

      // If standees were built before the GLB landed (the common case —
      // _initBabylon kicks the load off async and `_syncEntityStandees`
      // runs synchronously right after), retrofit each hero standee with
      // a paladin clone.
      this._upgradeHeroStandeesToPaladin();
      return this._paladinSource;
    })();

    this._paladinLoadPromise = promise;
    return promise;
  }

  /** Measure the aggregated bounding box across all geometry meshes in the
   *  paladin hierarchy and return both the uniform scale needed to hit
   *  TARGET_PALADIN_WORLD_HEIGHT and the feet offset (= -minY, positive)
   *  that the cloned root needs to lift its feet to local origin.
   *
   *  Accepts either a single mesh (legacy) or an array of meshes. The
   *  array form is the multi-submesh GLB case fixed in #375's follow-up:
   *  a Mixamo paladin imports as helmet + body + cape (+ …) and measuring
   *  only the skinned mesh's bbox produced a scale that fit the helmet to
   *  the target height — leaving the body geometry inflated off-screen
   *  ("giant floating head"). Walking every mesh's bbox aggregates the
   *  true natural height of the model.
   *
   *  Returns `{ scale: PALADIN_BASE_SCALE, feetOffset: 0 }` as a safe
   *  fallback when no usable bbox is available (test stubs without
   *  getBoundingInfo, or a degenerate hierarchy with zero height). */
  _normalisePaladinSource(input) {
    const fallback = { scale: PALADIN_BASE_SCALE, feetOffset: 0 };
    if (!input) return fallback;
    const meshes = Array.isArray(input) ? input : [input];
    if (meshes.length === 0) return fallback;

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const m of meshes) {
      if (!m || typeof m.getBoundingInfo !== 'function') continue;
      let info;
      try { info = m.getBoundingInfo(); } catch { continue; }
      const bb = info && info.boundingBox;
      if (!bb) continue;
      // Prefer local-space min/max so the measurement isn't perturbed by
      // a transform we're about to override on the clone anyway.
      const lo = bb.minimum || bb.minimumWorld;
      const hi = bb.maximum || bb.maximumWorld;
      if (!lo || !hi) continue;
      if (typeof lo.y === 'number' && lo.y < minY) minY = lo.y;
      if (typeof hi.y === 'number' && hi.y > maxY) maxY = hi.y;
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return fallback;
    const naturalHeight = maxY - minY;
    if (!(naturalHeight > 0)) return fallback;

    return {
      scale: TARGET_PALADIN_WORLD_HEIGHT / naturalHeight,
      // Positive value: how far above the model's local origin the feet
      // sit. The clone root lifts by `scale * feetOffset` so feet land at
      // root-local y=0.
      feetOffset: -minY,
    };
  }

  /** Clone the loaded paladin source for one hero standee. Returns
   *  `{ mesh, skinnedMesh, childMeshes, skeleton, animationGroup }` (any
   *  field may be null/empty if the source lacked it) or null if the
   *  source isn't loaded yet.
   *
   *  The Mixamo paladin GLB ships as a hierarchy (helmet + body + cape).
   *  PR #375 cloned only the skinned mesh and produced the "giant floating
   *  head" regression. This version clones every geometry mesh and parents
   *  them under a fresh per-standee root TransformNode, then applies
   *  scale / rotation / position on the root so the entire hierarchy
   *  transforms as a unit. The skeleton + idle animation are bound to the
   *  primary skinned child so per-unit idles play independently —
   *  InstancedMesh doesn't support per-instance bone matrices, hence the
   *  deeper clone path. */
  /** Load `walking.glb`, extract its animation group, and retarget every
   *  targetedAnimation onto the paladin source skeleton's linked
   *  TransformNodes by name. Disposes walking's meshes + skeleton — we
   *  only want its keyframes. The retargeted group + a blend tick are
   *  stashed on `_paladinSource.walkGroup` so the standee-move observer
   *  can cross-fade between idle ↔ walking based on whether any hero
   *  paladin is currently being slid between hexes by the resolver. */
  async _loadWalkingAnimation(basePath = 'assets') {
    if (!this._babylon || !this._scene || !this._paladinSource) return null;
    const BABYLON = this._babylon;
    const src = this._paladinSource;
    if (src.walkGroup) return src.walkGroup;
    if (!BABYLON.SceneLoader || typeof BABYLON.SceneLoader.ImportMeshAsync !== 'function') {
      return null;
    }

    let result;
    try {
      result = await BABYLON.SceneLoader.ImportMeshAsync(
        null,
        `${basePath}/${PALADIN_MODEL_DIR}`,
        WALKING_MODEL_FILE,
        this._scene,
        this._glbProgressHandler('paladin'),
      );
    } catch (err) {
      console.warn('[Renderer3D] walking.glb import failed', err);
      return null;
    }

    const walkGroupNative = (result.animationGroups || []).find(g => g) || null;
    if (!walkGroupNative) {
      console.warn('[Renderer3D] walking.glb contained no animation group');
      this._disposeWalkingImport(result);
      return null;
    }

    // Keep walking's mesh + skeleton alive — they're the GHOST source.
    // The native walkGroup drives walking's own skeleton natively (no
    // retargeting), so ghost clones reading from walking's skeleton get a
    // clean walk animation that's completely decoupled from the main
    // paladin's skeleton. The walking source meshes themselves are hidden
    // (setEnabled=false); ghosts clone them per-standee.
    const walkingMeshes = (result.meshes || []).filter(m =>
      m && typeof m.getTotalVertices === 'function' && m.getTotalVertices() > 0,
    );
    const walkingPrimary = walkingMeshes.find(m => m.skeleton) || walkingMeshes[0] || null;
    const walkingSkeleton = walkingPrimary?.skeleton
      || (Array.isArray(result.skeletons) ? result.skeletons[0] : null) || null;
    for (const m of walkingMeshes) {
      if (typeof m.setEnabled === 'function') m.setEnabled(false);
      m.isPickable = false;
    }
    // If walking.glb shipped without a Skeleton (animation-only files
    // typically don't, since fbx2gltf emits a glTF skin only when a mesh
    // references the joints), synthesize one by cloning paladin's
    // skeleton and re-linking each cloned bone's _linkedTransformNode to
    // walking's matching TransformNode by name. The ghost mesh bound to
    // this synthesized skeleton then skins from walking's animated TNs
    // (which the native walkGroup drives), fully independent of paladin's
    // idle skeleton.
    const walkingTNs = Array.isArray(result.transformNodes) ? result.transformNodes.slice() : [];
    let ghostSkeleton = walkingSkeleton;
    if (!ghostSkeleton && this._paladinSource?.skeleton
      && typeof this._paladinSource.skeleton.clone === 'function'
      && walkingTNs.length > 0) {
      ghostSkeleton = this._buildGhostSkeletonFromWalkingTNs(
        this._paladinSource.skeleton, walkingTNs,
      );
    }
    this._walkingSource = {
      mesh: walkingPrimary,
      meshes: walkingMeshes,
      skeleton: ghostSkeleton,
      walkGroup: walkGroupNative,
      transformNodes: walkingTNs,
    };
    // Compute the source clip's stride length and natural cycle duration
    // BEFORE stripping root motion — once stripped, the keyframes are
    // zeroed and stride reads as 0. Then back-calc a speedRatio that
    // makes one stride cover one hex's world-distance in MOVE_ANIM_MS.
    // Hex spacing on the X axis = HEX_RADIUS_WORLD * sqrt(3) ≈ 1.732 wu
    // for radius=1.
    const strideSrcUnits = computeRootStrideLength(walkGroupNative);
    const natCycleSec    = animDurationSeconds(walkGroupNative);
    const paladinScale   = this._paladinScale > 0 ? this._paladinScale : PALADIN_BASE_SCALE;
    const hexStepWU      = HEX_RADIUS_WORLD * Math.sqrt(3);
    const walkSpeedRatio = computeAnimSpeedRatioForStride(
      strideSrcUnits, natCycleSec, paladinScale, hexStepWU, MOVE_ANIM_MS, /*fallback*/ 2.0,
    );
    console.info(
      `[Renderer3D] walking speed ratio = ${walkSpeedRatio.toFixed(2)} `
      + `(stride=${strideSrcUnits.toFixed(2)} src-units, cycle=${natCycleSec.toFixed(2)}s, `
      + `scale=${paladinScale.toFixed(3)}, hex=${hexStepWU.toFixed(2)}wu, anim=${MOVE_ANIM_MS}ms)`,
    );
    this._walkingSource.speedRatio = walkSpeedRatio;
    // Strip root motion on the native walking group too — ghost clones
    // riding walking's skeleton would otherwise translate through space
    // on their own in addition to the cone slide along the planned path.
    stripRootBoneTranslation(walkGroupNative);
    if (typeof walkGroupNative.start === 'function') {
      walkGroupNative.start(true, walkSpeedRatio);
    }
    if (typeof walkGroupNative.pause === 'function') {
      walkGroupNative.pause();
      this._walkingSource.playing = false;
    }

    // Clone walkGroupNative and retarget the CLONE onto paladin's
    // TransformNodes (looked up by name — Mixamo bone names line up
    // between the rigged paladin.glb and walking.glb exports). The
    // original walkGroupNative keeps driving walking.glb's own skeleton
    // for the ghost preview path; the clone is what _maybeTogglePaladin
    // Animation pause/plays on the live paladin standees.
    const nameMap = new Map();
    const stripDup = n => n ? String(n).replace(/\.\d{3}$/, '') : n;
    const addEntry = (name, target) => {
      if (!name || !target) return;
      if (!nameMap.has(name)) nameMap.set(name, target);
      const stripped = stripDup(name);
      if (stripped !== name && !nameMap.has(stripped)) nameMap.set(stripped, target);
    };
    for (const tn of src.transformNodes || []) {
      if (tn && tn.name) addEntry(tn.name, tn);
    }
    if (src.skeleton && Array.isArray(src.skeleton.bones)) {
      for (const bone of src.skeleton.bones) {
        if (!bone) continue;
        const tn = bone._linkedTransformNode
          || (typeof bone.getTransformNode === 'function' && bone.getTransformNode());
        if (tn && tn.name) addEntry(tn.name, tn);
        if (bone.name) addEntry(bone.name, tn || bone);
      }
    }

    let walkGroupForPaladin = null;
    let remapped = 0;
    let missed = 0;
    const missingExamples = [];
    if (typeof walkGroupNative.clone === 'function') {
      walkGroupForPaladin = walkGroupNative.clone('paladinWalkRetargeted', (oldTarget) => {
        if (!oldTarget || !oldTarget.name) { missed++; return oldTarget; }
        const match = nameMap.get(oldTarget.name) || nameMap.get(stripDup(oldTarget.name));
        if (match) { remapped++; return match; }
        missed++;
        if (missingExamples.length < 5) missingExamples.push(oldTarget.name);
        return oldTarget;
      });
    }
    console.info(
      `[Renderer3D] walking → paladin retarget: ${remapped} hit, ${missed} miss`
      + (missed > 0 ? ` (e.g. ${missingExamples.join(', ')})` : '')
      + ` — nameMap size ${nameMap.size}`,
    );

    if (walkGroupForPaladin && remapped > 0) {
      // Strip root motion so the walking clip animates the rig in place —
      // the cone slide via Babylon Animation already handles world-space
      // translation across hexes. Without this the walking model would
      // also translate via its own root keyframes (double-displacement).
      stripRootBoneTranslation(walkGroupForPaladin);
      // Kick the animatables into existence then immediately pause, so
      // _maybeTogglePaladinAnimation can use play()/pause() to resume from
      // current frame instead of restarting from frame 0 each move.
      if (typeof walkGroupForPaladin.start === 'function') {
        walkGroupForPaladin.start(true, walkSpeedRatio);
      }
      if (typeof walkGroupForPaladin.pause === 'function') {
        walkGroupForPaladin.pause();
      }
      src.walkGroup = walkGroupForPaladin;
    } else {
      // Retarget failed — fall back to whatever embedded animation the
      // paladin GLB shipped with (or nothing if it has none).
      console.warn('[Renderer3D] walking retarget produced 0 hits — main standees will not animate.');
      src.walkGroup = null;
    }
    src.activeGroup = 'idle';
    this._paladinAnimObserver = this._installPaladinAnimBlendTick();
    return walkGroupNative;
  }

  /** Dispose every mesh + skeleton brought in by the walking.glb import.
   *  The animation group is intentionally preserved (handed back to the
   *  caller). Safe against partial / missing fields. */
  /** Load idle.glb and retarget its AnimationGroup onto the paladin
   *  source skeleton by name (same pattern as walking). The retargeted
   *  group replaces `src.idleGroup` so the blend tick plays it when the
   *  paladin is not mid-move. Imported geometry is disposed — we only
   *  want the keyframes. */
  async _loadIdleAnimation(basePath = 'assets') {
    if (!this._babylon || !this._scene || !this._paladinSource) return null;
    const BABYLON = this._babylon;
    const src = this._paladinSource;
    if (!BABYLON.SceneLoader || typeof BABYLON.SceneLoader.ImportMeshAsync !== 'function') {
      return null;
    }

    let result;
    try {
      result = await BABYLON.SceneLoader.ImportMeshAsync(
        null,
        `${basePath}/${PALADIN_MODEL_DIR}`,
        IDLE_MODEL_FILE,
        this._scene,
        this._glbProgressHandler('paladin'),
      );
    } catch (err) {
      console.warn('[Renderer3D] idle.glb import failed', err);
      return null;
    }

    const idleNative = (result.animationGroups || []).find(g => g) || null;
    if (!idleNative) {
      console.warn('[Renderer3D] idle.glb contained no animation group');
      this._disposeWalkingImport(result);
      return null;
    }

    const nameMap = new Map();
    const stripDup = n => n ? String(n).replace(/\.\d{3}$/, '') : n;
    const addEntry = (name, target) => {
      if (!name || !target) return;
      if (!nameMap.has(name)) nameMap.set(name, target);
      const stripped = stripDup(name);
      if (stripped !== name && !nameMap.has(stripped)) nameMap.set(stripped, target);
    };
    for (const tn of src.transformNodes || []) {
      if (tn && tn.name) addEntry(tn.name, tn);
    }
    if (src.skeleton && Array.isArray(src.skeleton.bones)) {
      for (const bone of src.skeleton.bones) {
        if (!bone) continue;
        const tn = bone._linkedTransformNode
          || (typeof bone.getTransformNode === 'function' && bone.getTransformNode());
        if (tn && tn.name) addEntry(tn.name, tn);
        if (bone.name) addEntry(bone.name, tn || bone);
      }
    }

    let idleForPaladin = null;
    let remapped = 0;
    let missed = 0;
    if (typeof idleNative.clone === 'function') {
      idleForPaladin = idleNative.clone('paladinIdleRetargeted', (oldTarget) => {
        if (!oldTarget || !oldTarget.name) { missed++; return oldTarget; }
        const match = nameMap.get(oldTarget.name) || nameMap.get(stripDup(oldTarget.name));
        if (match) { remapped++; return match; }
        missed++;
        return oldTarget;
      });
    }
    console.info(`[Renderer3D] idle → paladin retarget: ${remapped} hit, ${missed} miss`);

    if (idleForPaladin && remapped > 0) {
      if (typeof idleForPaladin.start === 'function') {
        idleForPaladin.start(true, 1.0);
      }
      src.idleGroup = idleForPaladin;
      src._playing = true; // currently playing idle
      src.activeGroup = 'idle';
    } else {
      console.warn('[Renderer3D] idle retarget produced 0 hits — paladin will sit at bind pose.');
      try { idleForPaladin?.dispose?.(); } catch { /* ignore */ }
    }

    // Dispose idle.glb's imported mesh + skeleton — we only kept the
    // animation keyframes (cloned + retargeted onto paladin's rig).
    this._disposeWalkingImport(result);
    return idleForPaladin;
  }

  /** Clone the paladin source skeleton and re-link each cloned bone's
   *  _linkedTransformNode to the walking import's matching TransformNode
   *  by name. The resulting skeleton has paladin's bind matrices + bone
   *  hierarchy, but bone matrices read from walking's animated TNs every
   *  frame — so a mesh bound to this skeleton skins walking's pose,
   *  independent of paladin's own idle skeleton. Returns null if the
   *  clone fails. */
  _buildGhostSkeletonFromWalkingTNs(paladinSkeleton, walkingTNs) {
    try {
      const ghostSkel = paladinSkeleton.clone('ghostWalkingSkeleton', 'ghostWalkingSkeleton');
      if (!ghostSkel || !Array.isArray(ghostSkel.bones)) return null;
      const stripDup = n => n ? String(n).replace(/\.\d{3}$/, '') : n;
      const tnMap = new Map();
      for (const tn of walkingTNs) {
        if (!tn || !tn.name) continue;
        if (!tnMap.has(tn.name)) tnMap.set(tn.name, tn);
        const s = stripDup(tn.name);
        if (s !== tn.name && !tnMap.has(s)) tnMap.set(s, tn);
      }
      let relinked = 0;
      for (const bone of ghostSkel.bones) {
        if (!bone || !bone.name) continue;
        const tn = tnMap.get(bone.name) || tnMap.get(stripDup(bone.name));
        if (tn) {
          // _linkedTransformNode is a private Babylon field; both setters
          // (linkTransformNode and direct assignment) work. Use the public
          // method when available so any internal bookkeeping fires.
          if (typeof bone.linkTransformNode === 'function') bone.linkTransformNode(tn);
          else bone._linkedTransformNode = tn;
          relinked++;
        }
      }
      console.info(`[Renderer3D] ghost skeleton: ${relinked}/${ghostSkel.bones.length} bones relinked to walking TNs`);
      return ghostSkel;
    } catch (err) {
      console.warn('[Renderer3D] ghost skeleton synthesis failed', err);
      return null;
    }
  }

  _disposeWalkingImport(result) {
    if (!result) return;
    for (const m of result.meshes || []) {
      if (m && typeof m.dispose === 'function') {
        try { m.dispose(); } catch { /* ignore */ }
      }
    }
    for (const s of result.skeletons || []) {
      if (s && typeof s.dispose === 'function') {
        try { s.dispose(); } catch { /* ignore */ }
      }
    }
    for (const tn of result.transformNodes || []) {
      if (tn && typeof tn.dispose === 'function') {
        try { tn.dispose(); } catch { /* ignore */ }
      }
    }
  }

  /** Resume or pause the paladin's BUILT-IN animation group (the one that
   *  ships with the .glb — for NewPaladin this is the walking clip, treated
   *  as the rig's default animation). Should play whenever any hero
   *  paladin is mid-move/lunge; pause when nothing is moving so the model
   *  freezes mid-stride between turns in playback. Uses pause()/play()
   *  (not stop()/start()) so the animation resumes from its current frame
   *  on each motion event instead of snapping back to frame 0. */
  _maybeTogglePaladinAnimation() {
    const src = this._paladinSource;
    if (!src) return;
    // Three states: 'walk' (motion active), 'paused' (mid-chain freeze
    // — walking is paused at its current frame, idle does NOT run), and
    // 'idle' (no motion for SUSTAIN_MS). 'paused' is the new state that
    // lets a multi-hex move chain read as "walk → freeze → walk → freeze
    // → walk → idle" instead of dipping back into idle pose between
    // every hop.
    const wantWalk = paladinAnimTargetWeight(
      this._activeMoveIds, this._activeLungeIds,
      this.state?.entities, unitUsesPaladinModel,
    ) === 0;
    const now = performance.now();
    if (wantWalk) this._paladinLastWalkTs = now;

    let desired;
    if (wantWalk) {
      desired = 'walk';
    } else if (typeof this._paladinLastWalkTs === 'number'
      && (now - this._paladinLastWalkTs) < PALADIN_WALK_SUSTAIN_MS) {
      desired = 'paused';
    } else {
      desired = 'idle';
    }
    if (src.activeGroup === desired) return;

    const walk = src.walkGroup;
    const idle = src.idleGroup;
    if (desired === 'walk') {
      if (idle && typeof idle.stop === 'function') idle.stop();
      if (walk) {
        if (typeof walk.play === 'function') walk.play(true);
        else if (typeof walk.start === 'function') walk.start(true, 1.0);
      }
    } else if (desired === 'paused') {
      // Freeze walking mid-stride. Crucially we do NOT start idle —
      // idle would immediately drive the bones away from walking's
      // current frame. Walking stays paused at its last keyframe until
      // the next motion event resumes it (walk.play() resumes from
      // the paused frame) or the sustain window expires and we
      // transition to 'idle' below.
      if (walk && typeof walk.pause === 'function') walk.pause();
    } else { // 'idle'
      if (walk && typeof walk.stop === 'function') walk.stop();
      if (idle) {
        if (typeof idle.play === 'function') idle.play(true);
        else if (typeof idle.start === 'function') idle.start(true, 1.0);
      }
    }
    src.activeGroup = desired;
  }

  /** Resume or pause the NATIVE walking AnimationGroup (the one playing
   *  on walking.glb's own skeleton, used by ghost clones). It should play
   *  whenever a plan-ghost is up or a hero standee is mid-move; otherwise
   *  pause so the rig holds its current pose instead of cycling
   *  invisibly in the background. */
  _maybeToggleNativeWalking() {
    const ws = this._walkingSource;
    if (!ws || !ws.walkGroup) return;
    const ghostsActive = this._planGhostMeshes && this._planGhostMeshes.size > 0;
    const movesActive = (this._activeMoveIds && this._activeMoveIds.size > 0)
      || (this._activeLungeIds && this._activeLungeIds.size > 0);
    const shouldPlay = !!(ghostsActive || movesActive);
    if (shouldPlay && !ws.playing) {
      // Always stop()+start() with an explicit speedRatio so we don't
      // accidentally drop back to Babylon's default speedRatio=1.0 on
      // resume. restart() and play() preserve speedRatio in newer
      // Babylon versions but not all, and a wrong speedRatio is what
      // caused the ghost's feet to slide (animation cycle racing the
      // cone slide because it was running at 1× natural instead of
      // the computed match-rate).
      const speed = ws.speedRatio ?? 1.0;
      if (typeof ws.walkGroup.stop === 'function') ws.walkGroup.stop();
      if (typeof ws.walkGroup.start === 'function') ws.walkGroup.start(true, speed);
      ws.playing = true;
    } else if (!shouldPlay && ws.playing) {
      if (typeof ws.walkGroup.pause === 'function') ws.walkGroup.pause();
      ws.playing = false;
    }
  }

  /** Subscribe a per-frame tick that swaps the paladin's idle and walking
   *  animation groups. Decision: play walking whenever any hero entity is
   *  mid-move/lunge OR a plan-ghost is animating; otherwise idle. The
   *  per-Animation blending wired in _loadWalkingAnimation crossfades the
   *  swap smoothly. Sustained for PALADIN_WALK_SUSTAIN_MS across
   *  consecutive moves so the walk reads as one continuous cycle.
   *  Returns the Babylon observer handle for disposal. */
  _installPaladinAnimBlendTick() {
    if (!this._scene || !this._scene.onBeforeRenderObservable) return null;
    return this._scene.onBeforeRenderObservable.add(() => {
      // Native walking group (used by ghosts) — pause when no ghost is up
      // and nobody is mid-move. Resume otherwise. This keeps the rig from
      // moonwalking in place when nothing on screen needs it.
      this._maybeToggleNativeWalking();
      this._maybeTogglePaladinAnimation();
      // The legacy idle↔walk swap below only fires when a SEPARATE
      // retargeted walking group was loaded onto the paladin's skeleton.
      // With NewPaladin shipping its own walking animation as the rig's
      // sole group, _maybeTogglePaladinAnimation handles pause/play and
      // this branch is a no-op (walkGroup remains null).
      const src = this._paladinSource;
      if (!src || !src.idleGroup || !src.walkGroup) return;
      // Main standees only enter walking during ACTUAL resolution motion
      // (_activeMoveIds / _activeLungeIds). Plan-ghosts don't trigger this
      // because they animate on their OWN skeleton (walking source), so
      // during planning the live paladin stays in idle while the ghost
      // walks the preview path.
      let wantWalk = paladinAnimTargetWeight(
        this._activeMoveIds, this._activeLungeIds,
        this.state?.entities, unitUsesPaladinModel,
      ) === 0;
      const now = performance.now();
      if (wantWalk) this._paladinLastWalkTs = now;
      else if (typeof this._paladinLastWalkTs === 'number'
        && (now - this._paladinLastWalkTs) < PALADIN_WALK_SUSTAIN_MS) {
        wantWalk = true;
      }
      const desired = wantWalk ? 'walk' : 'idle';
      if (src.activeGroup === desired) return;
      const walkSpeed = this._walkingSource?.speedRatio ?? 1.0;
      if (desired === 'walk') {
        if (typeof src.idleGroup.stop === 'function') src.idleGroup.stop();
        if (typeof src.walkGroup.start === 'function') src.walkGroup.start(true, walkSpeed);
      } else {
        if (typeof src.walkGroup.stop === 'function') src.walkGroup.stop();
        if (typeof src.idleGroup.start === 'function') src.idleGroup.start(true, 1.0);
      }
      src.activeGroup = desired;
    });
  }

  /** Build a translucent walking-paladin clone for a plan-ghost. Uses
   *  the walking GLB as source (mesh + skeleton + already-playing native
   *  walking animation). Returns the same `{ mesh, childMeshes, ... }`
   *  shape as `_buildPaladinClone` so the ghost teardown path can share
   *  `_disposePaladinClone`. The walking source's skeleton is SHARED
   *  across every ghost — they all march in step at the same animation
   *  frame, which reads fine for a planning preview. */
  _buildWalkingGhostClone(entity, parent) {
    // Ghost uses PALADIN's mesh (since walking.glb is animation-only with
    // no embedded mesh) bound to WALKING's separate skeleton. Walking's
    // skeleton is driven by the native walkGroup; the live paladin's
    // skeleton runs idle. Two skeletons → ghost animates walking
    // independently of the live paladin's idle. Mixamo bone ordering
    // matches between paladin-idle.glb and walking.glb so the skinning
    // indices map cleanly across the skeleton swap.
    const walking = this._walkingSource;
    const paladin = this._paladinSource;
    if (!this._babylon || !paladin) return null;
    const BABYLON = this._babylon;
    // Mesh always from paladin (the only one with geometry).
    const srcMeshes = Array.isArray(paladin.meshes) && paladin.meshes.length > 0
      ? paladin.meshes
      : (paladin.mesh ? [paladin.mesh] : []);
    if (srcMeshes.length === 0) return null;
    // Prefer walking's skeleton so the ghost animates independently.
    // Fall back to paladin's if walking didn't export one (defensive).
    const ghostSkeleton = (walking && walking.skeleton) || paladin.skeleton;
    const src = { meshes: srcMeshes, mesh: paladin.mesh, skeleton: ghostSkeleton };
    const id = entity?.id ?? 'unknown';

    let cloneRoot = null;
    if (typeof BABYLON.TransformNode === 'function') {
      try {
        cloneRoot = new BABYLON.TransformNode(`ghost_${id}`, this._scene || null);
      } catch { cloneRoot = null; }
    }
    const ownsRootNode = !!cloneRoot;

    const childClones = [];
    let primarySkinnedClone = null;
    for (const srcMesh of srcMeshes) {
      if (!srcMesh || typeof srcMesh.clone !== 'function') continue;
      const name = `ghost_${id}_${srcMesh.name || 'mesh'}`;
      const childClone = srcMesh.clone(name);
      if (!childClone) continue;
      if (typeof childClone.setEnabled === 'function') childClone.setEnabled(true);
      childClone.isPickable = false;
      if (typeof childClone.renderingGroupId !== 'undefined') childClone.renderingGroupId = 0;
      childClone.alwaysSelectAsActiveMesh = true;
      childClones.push(childClone);
      if (srcMesh === src.mesh) primarySkinnedClone = childClone;
    }
    if (childClones.length === 0) {
      if (cloneRoot && typeof cloneRoot.dispose === 'function') cloneRoot.dispose();
      return null;
    }
    if (!primarySkinnedClone) primarySkinnedClone = childClones[0];

    if (cloneRoot) {
      for (const c of childClones) {
        if ('parent' in c) c.parent = cloneRoot;
      }
    } else {
      cloneRoot = primarySkinnedClone;
    }

    if (src.skeleton && primarySkinnedClone) {
      primarySkinnedClone.skeleton = src.skeleton;
    }

    // Match the live paladin's scale/yaw + feet-on-cone-bottom anchor so
    // the ghost reads as the same character at the same height.
    const scale = (typeof this._paladinScale === 'number' && this._paladinScale > 0)
      ? this._paladinScale : PALADIN_BASE_SCALE;
    const feetOffsetLocal = (typeof this._paladinFeetOffset === 'number'
      && Number.isFinite(this._paladinFeetOffset))
      ? this._paladinFeetOffset : 0;
    if (BABYLON.Vector3) {
      cloneRoot.scaling  = new BABYLON.Vector3(scale, scale, scale);
      cloneRoot.rotation = new BABYLON.Vector3(0, PALADIN_YAW, 0);
      const leader = isLeaderType(entity?.type);
      const hMul = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
      const coneFeetY = -(STANDEE_CONE_HEIGHT * hMul) / 2;
      cloneRoot.position = new BABYLON.Vector3(0, coneFeetY + scale * feetOffsetLocal, 0);
    }
    if (parent && 'parent' in cloneRoot) cloneRoot.parent = parent;

    return {
      mesh: cloneRoot,
      skinnedMesh: primarySkinnedClone,
      childMeshes: childClones,
      ownsRootNode,
      skeleton: null,        // shared from src.skeleton, not owned
      animationGroup: null,  // walkGroup runs on src.skeleton, not owned
    };
  }

  _buildPaladinClone(entity, parent) {
    const src = this._paladinSource;
    if (!src || !this._babylon) return null;
    const BABYLON = this._babylon;
    // Backward-compat with the pre-multi-mesh _paladinSource shape that
    // only stashed `mesh`. The retrofit + standee-build paths populate
    // `meshes` going forward.
    const srcMeshes = Array.isArray(src.meshes) && src.meshes.length > 0
      ? src.meshes
      : (src.mesh ? [src.mesh] : []);
    if (srcMeshes.length === 0) return null;
    const id = entity?.id ?? 'unknown';

    // Per-standee root. Owns scale / rotation / position so every cloned
    // child mesh moves as a unit. Fall back to using the first cloned
    // child as the root when TransformNode isn't available (e.g. test
    // stubs that don't implement it).
    let cloneRoot = null;
    if (typeof BABYLON.TransformNode === 'function') {
      try {
        cloneRoot = new BABYLON.TransformNode(`paladin_${id}`, this._scene || null);
      } catch { cloneRoot = null; }
    }
    const ownsRootNode = !!cloneRoot;

    // Clone every source mesh; parent each to the root so the hierarchy
    // hangs together. Track the primary skinned clone (the one matching
    // src.mesh) — that's where the skeleton + animation group attach.
    const childClones = [];
    let primarySkinnedClone = null;
    for (const srcMesh of srcMeshes) {
      if (!srcMesh || typeof srcMesh.clone !== 'function') continue;
      const name = `paladin_${id}_${srcMesh.name || 'mesh'}`;
      const childClone = srcMesh.clone(name);
      if (!childClone) continue;
      if (typeof childClone.setEnabled === 'function') childClone.setEnabled(true);
      childClone.isPickable = false;
      if (typeof childClone.renderingGroupId !== 'undefined') childClone.renderingGroupId = 0;
      // Defeat bbox-based culling on EVERY child. Babylon caches each
      // submesh's natural bbox; even with the root scaled correctly,
      // skinning can move verts outside that bbox (Mixamo bone-scale
      // quirk on cape / cloth bones in particular) and a culled child
      // mesh leaves a gap in the silhouette.
      childClone.alwaysSelectAsActiveMesh = true;
      childClones.push(childClone);
      if (srcMesh === src.mesh) primarySkinnedClone = childClone;
    }
    if (childClones.length === 0) {
      if (cloneRoot && typeof cloneRoot.dispose === 'function') cloneRoot.dispose();
      return null;
    }
    if (!primarySkinnedClone) primarySkinnedClone = childClones[0];

    // Parent every child to the root. When TransformNode isn't available
    // we collapse to the legacy single-mesh path: use the primary skinned
    // clone as the "root" handle and leave siblings unparented (the test
    // fakes only ever populate one mesh in that mode anyway).
    if (cloneRoot) {
      for (const c of childClones) {
        if ('parent' in c) c.parent = cloneRoot;
      }
    } else {
      cloneRoot = primarySkinnedClone;
    }

    // Share the source skeleton across every clone. Babylon's glTF loader
    // makes the imported AnimationGroup target TransformNodes, and bones link
    // to those TransformNodes via _linkedTransformNode. Cloning the skeleton
    // per-standee leaves the cloned bones still pointing at source nodes —
    // the bone-name AnimationGroup retarget converter (which looks for Bones,
    // not TransformNodes) ends up with no matches, falls back to the source
    // target, and every clone stays in T-pose. Sharing the source skeleton
    // sidesteps the problem: the source idleGroup (started in _loadPaladinModel)
    // animates the source skeleton's bones, and every clone that references
    // that skeleton skins from the same bone matrices. All paladins idle in
    // unison — fine for a board-game token, far better than T-pose.
    if (src.skeleton && primarySkinnedClone) {
      primarySkinnedClone.skeleton = src.skeleton;
    }

    // Scale + rotate + position on the root. Children inherit transforms.
    const scale = (typeof this._paladinScale === 'number' && this._paladinScale > 0)
      ? this._paladinScale : PALADIN_BASE_SCALE;
    const feetOffsetLocal = (typeof this._paladinFeetOffset === 'number'
      && Number.isFinite(this._paladinFeetOffset))
      ? this._paladinFeetOffset : 0;
    if (BABYLON.Vector3) {
      cloneRoot.scaling  = new BABYLON.Vector3(scale, scale, scale);
      cloneRoot.rotation = new BABYLON.Vector3(0, PALADIN_YAW, 0);
      // The cone's local origin is its centre; the cone bottom rim is at
      // -coneHeight/2 in cone-local space. The model's natural feet sit at
      // local y = -feetOffsetLocal; after scaling, they're at -scale *
      // feetOffsetLocal relative to the root. Lifting the root by
      // scale * feetOffsetLocal puts feet at root-local y=0; then
      // subtracting coneHeight/2 lands them on the cone bottom rim.
      const leader = isLeaderType(entity?.type);
      const hMul = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
      const coneFeetY = -(STANDEE_CONE_HEIGHT * hMul) / 2;
      cloneRoot.position = new BABYLON.Vector3(0, coneFeetY + scale * feetOffsetLocal, 0);
    }
    if (parent && 'parent' in cloneRoot) cloneRoot.parent = parent;

    return {
      mesh: cloneRoot,
      skinnedMesh: primarySkinnedClone,
      childMeshes: childClones,
      ownsRootNode,
      skeleton: null,
      animationGroup: null,
    };
  }

  /** Dispose a previously-built paladin clone — every child mesh first
   *  (cascades materials), then the root transform node if we own it.
   *  Skeleton + animation group are owned by `_paladinSource` (shared
   *  across all clones) and live for the renderer's lifetime; no per-
   *  clone teardown of either. Safe to call when no clone is attached. */
  _disposePaladinClone(standee) {
    if (!standee || !standee.paladinClone) return;
    const c = standee.paladinClone;
    if (Array.isArray(c.childMeshes)) {
      for (const m of c.childMeshes) {
        if (m && typeof m.dispose === 'function') m.dispose();
      }
    }
    // Only dispose the root if we own it (a real TransformNode we created)
    // AND it's not already part of childMeshes (legacy single-mesh path).
    if (c.ownsRootNode && c.mesh && typeof c.mesh.dispose === 'function'
      && (!Array.isArray(c.childMeshes) || !c.childMeshes.includes(c.mesh))) {
      c.mesh.dispose();
    }
    standee.paladinClone = null;
  }

  /** Retrofit existing hero standees with a paladin clone after the GLB
   *  load resolves asynchronously. Idempotent: standees that already carry
   *  a clone are skipped. Returns the number of standees upgraded. */
  _upgradeHeroStandeesToPaladin() {
    if (!this._paladinSource || !this._entityStandees || !this.state?.entities) return 0;
    // Index entities by id so we can look up the owner field without a
    // O(n) scan per standee. Cheap — entity counts top out at a few dozen.
    const byId = new Map();
    for (const e of this.state.entities) {
      if (e && e.id) byId.set(e.id, e);
    }
    let upgraded = 0;
    for (const [id, standee] of this._entityStandees) {
      if (!standee || standee.paladinClone) continue;
      const ent = byId.get(id);
      if (!unitUsesPaladinModel(ent)) continue;
      const clone = this._buildPaladinClone(ent, standee.plane);
      if (!clone) continue;
      // Hide the cone+sphere body so the paladin reads on its own.
      // .visibility is a 0..1 alpha multiplier in Babylon — leaving the
      // meshes enabled keeps picking + the existing animation rig intact.
      if (standee.plane)  standee.plane.visibility  = 0;
      if (standee.sphere) standee.sphere.visibility = 0;
      // Replace the pawn shape on the shadow caster list with the paladin
      // hierarchy so the floor shadow reads as the actual model silhouette.
      if (standee.plane)  this._removeShadowCaster(standee.plane);
      if (standee.sphere) this._removeShadowCaster(standee.sphere);
      for (const m of clone.childMeshes || []) this._addShadowCaster(m);
      standee.paladinClone = clone;
      upgraded++;
    }
    return upgraded;
  }

  /** Walk `_portraitMaterials` and attach a freshly-built texture to any
   *  material that was created before `_tilemapImg` was available. Idempotent
   *  — materials that already have a diffuseTexture are skipped. */
  _upgradePortraitMaterials() {
    if (!this._scene || !this._babylon || !this._tilemapImg) return;
    const BABYLON = this._babylon;
    for (const [key, mat] of this._portraitMaterials) {
      if (mat.diffuseTexture) continue;
      const assetId = key === '__blank__' ? null : key;
      const tex = this._portraitTextureFor(assetId);
      if (!tex) continue;
      mat.diffuseTexture = tex;
      mat.opacityTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
      // Match the textured branch in _planeMaterialFor: drop the flat diffuse
      // fill (the texture is the diffuse now), keep specular off, raise
      // emissive so the portrait reads at any phase / light angle.
      mat.diffuseColor  = new BABYLON.Color3(1, 1, 1);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.emissiveColor = new BABYLON.Color3(0.4, 0.4, 0.4);
    }
  }

  /** Center and zoom the camera so the given hexes (with a margin) fill the
   *  view. `opts.paddingHexes` widens the bounds; `opts.instant` skips the
   *  focus-shift animation (used on first frame / map load).
   *
   *  `frameHexes([singleHex])` is supported: `computeMapBounds` falls back to
   *  the single hex's footprint, and `radiusForFit` floors at the camera's
   *  `lowerRadiusLimit` so we never end up with a zero or sub-tile radius.
   */
  frameHexes(positions, opts = {}) {
    if (!this._camera || !positions || positions.length === 0) return;
    const padHexes = typeof opts.paddingHexes === 'number' ? opts.paddingHexes : 1.5;
    const bounds = computeMapBounds(positions);
    if (!bounds) return;
    const padding = padHexes * HEX_RADIUS_WORLD * SQRT3;
    const fitWidth  = bounds.width  + 2 * padding;
    const fitDepth  = bounds.depth  + 2 * padding;

    const BABYLON = this._babylon;
    const newTarget = new BABYLON.Vector3(bounds.centerX, 0, bounds.centerZ);
    const newRadius = this._radiusForFit(fitWidth, fitDepth);
    this._focusCamera(newTarget, newRadius, { instant: opts.instant === true });
  }

  /** Project a canvas pixel onto the map by raycasting against tile and
   *  standee meshes — each carries `{col,row}` (plus `kind` and possibly
   *  `entityId`) in `mesh.metadata`. Standees are raised above tiles so the
   *  closest-hit picker prefers them, which means clicking a unit returns
   *  the unit's hex even when its base partially overlaps a neighbour. */
  canvasToHex(x, y) {
    if (!this._scene) return { col: -1, row: -1 };
    const pick = this._scene.pick(x, y, (mesh) => {
      const k = mesh.metadata?.kind;
      return k === 'tile' || k === 'entity';
    });
    if (pick?.hit && pick.pickedMesh?.metadata) {
      const md = pick.pickedMesh.metadata;
      if (typeof md.col === 'number' && typeof md.row === 'number') {
        return { col: md.col, row: md.row };
      }
    }
    return { col: -1, row: -1 };
  }

  /** Project a hex centre to canvas pixel coordinates.
   *
   *  Phase 4 note: we rotate the *camera* (alpha) for yaw, not `mapRoot`, so
   *  the world matrix passed to `Vector3.Project` stays `Matrix.Identity()`.
   *  If a future phase ever yaws `mapRoot` instead, swap this for
   *  `this._mapRoot.computeWorldMatrix(true)` — otherwise projection will
   *  silently desync from picked mesh positions when the map rotates.
   */
  hexToCanvasPos(col, row) {
    if (!this._scene || !this._camera || !this._engine || !this._babylon) {
      return { x: 0, y: 0 };
    }
    const BABYLON = this._babylon;
    const { x, z } = hexToWorld(col, row);
    const world = new BABYLON.Vector3(x, 0, z);
    const projected = BABYLON.Vector3.Project(
      world,
      BABYLON.Matrix.Identity(),
      this._scene.getTransformMatrix(),
      this._camera.viewport.toGlobal(
        this._engine.getRenderWidth(),
        this._engine.getRenderHeight(),
      ),
    );
    return { x: projected.x, y: projected.y };
  }

  /** Adjust camera distance to mirror the 2D renderer's zoom semantics.
   *  Focal coordinates are accepted for interface parity with the 2D path
   *  but ignored — the ArcRotateCamera keeps its current target. */
  setZoom(newZoom, _focalX, _focalY) {
    if (this.viewLocked) return;
    const camera = this._camera;
    if (!camera) {
      // Init hasn't run yet; just stash the requested zoom so frameHexes /
      // _initBabylon (which use zoomLevel) see the desired starting point.
      this.zoomLevel = Math.max(0.1, newZoom);
      return;
    }
    const lower = camera.lowerRadiusLimit ?? 4;
    const upper = camera.upperRadiusLimit ?? 80;
    const radius = zoomToRadius(newZoom, lower, upper);
    this.zoomLevel = radiusToZoom(radius);
    this._focusCamera(camera.target.clone(), radius, { forceAnimate: true });
  }

  /** Rotate the camera by an alpha (yaw) delta. The signature accepts a
   *  second `_betaDelta` arg for interface parity with the 2D Renderer's
   *  no-op `rotateBy(alpha, beta)`, but tilt is permanently locked at
   *  CAMERA_BETA_LOCKED so the beta arg is ignored. No-op until Babylon
   *  has initialised. */
  rotateBy(alphaDelta, _betaDelta) {
    if (this.viewLocked) return;
    const camera = this._camera;
    if (!camera) return;
    camera.alpha = camera.alpha + alphaDelta;
  }

  /** Set the 3D drag-mode toggle: 'pan' or 'rotate'. UI calls this when the
   *  operator taps the camera-mode button in #zoom-controls. Wheel / pinch
   *  always zooms regardless of mode. */
  setCameraDragMode(mode) {
    this.cameraDragMode = (mode === 'rotate') ? 'rotate' : 'pan';
  }

  /** Update the fog-of-war tint multiplier at runtime. Walks both fog
   *  material caches (terrain + colour) and the per-tile ribbon clones via
   *  `_applyFogVeil`, so already-fogged tiles immediately read with the new
   *  darken factor — no need to rebuild the map. Live-tunable by the admin
   *  lighting page and per-phase via `PHASE_LIGHT_CONFIG.fogTint`. */
  setFogTint(value) {
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    this._fogTileDarken = v;
    // Terrain fog materials: diffuseColor = (v, v, v) regardless of original.
    for (const [, mat] of this._terrainFogMaterialCache) {
      if (mat?.diffuseColor) {
        mat.diffuseColor.r = v;
        mat.diffuseColor.g = v;
        mat.diffuseColor.b = v;
      }
    }
    // Colour fog materials are keyed by base hex — recompute each one's
    // diffuseColor from its anchor.
    for (const [baseHex, mat] of this._fogMaterialCache) {
      if (!mat?.diffuseColor) continue;
      const [r, g, b] = cssHexToRgb01(baseHex);
      mat.diffuseColor.r = r * v;
      mat.diffuseColor.g = g * v;
      mat.diffuseColor.b = b * v;
    }
    // Re-apply the fog veil so per-tile ribbon clones (whose darken happens
    // in `_setTileFogged` using `this._fogTileDarken`) pick up the new value.
    if (this._scene) this._applyFogVeil();
  }

  /** Stub for interface parity with the 2D Renderer's `tiltBy(_betaDelta)`
   *  no-op. Tilt is permanently locked at CAMERA_BETA_LOCKED (π/4); the
   *  camera's lowerBetaLimit/upperBetaLimit are both pinned to that value
   *  in _initBabylon, so any stray beta mutation would be re-clamped
   *  immediately anyway. Kept callable so external code (e.g. ui.js, tests)
   *  that still invokes tiltBy doesn't crash. */
  tiltBy(_betaDelta) { /* no-op — tilt locked at CAMERA_BETA_LOCKED */ }

  /** Refit the whole map. Animates target+radius via `frameHexes`; deliberately
   *  does NOT reset the user's yaw (alpha) — rotation is user state. */
  resetView() {
    if (!this.state?.tiles) return;
    const all = [];
    for (const tile of this.state.tiles.values()) all.push({ col: tile.col, row: tile.row });
    this.frameHexes(all, { paddingHexes: 1 });
  }
  _clampPan()                                         { /* camera panning is bounded via panning limits in _initBabylon */ }
  // Phase 6: real fog visibility. Sums sight ranges across all alive entities
  // owned by `observerOwner` (same logic as 2D `_buildFogVisibleHexes`).
  // Delegates to the pure `buildFogVisibleSet` helper so the math is testable
  // without a Babylon context.
  _buildFogVisibleHexes(observerOwner)                { return buildFogVisibleSet(this.state, observerOwner); }

  // ─── Stubs (deferred to later phases / out of Phase 5 scope) ─────────────

  addDeathAnim(_col, _row, _color)                                           { /* later phase */ }
  addFadeOutAnim(_entityId, _duration)                                       { /* later phase */ }
  addNodeRevealAnim(_hexes, _color, _opts)                                   { /* Phase 6 — Hana */ }
  addSpawnAnim(_col, _row, _color)                                           { /* later phase */ }

  clearBattleHighlights()                             { /* later phase */ }
  setBattleHighlights(_combatantHexes, _allyHexes)    { /* later phase */ }

  // ─── Phase 5 anim methods (implementations below the class banner) ───────
  // addMoveAnim, addLungeAnim, returnAllLungeAnims, clearAllLungeAnims,
  // addProjectileAnim, clearAllProjectileAnims, addAttackAnim, addFlash,
  // addHpChangeFlash, clearFlashes, clearAnimations, waitForAnimations
  // are defined under the Phase 5 banner near the end of this class.

  getFadeOutOpacity(_entityId)                        { return 1; }
  getEntityScreenPositions(_col, _row, _entities, _rect)                     { return []; }
  getEntityScreenPos(_col, _row, _id, _stackIdx, _stackTotal, _rect)         { return null; }
  /**
   * Round 4: return a small data-URL portrait for the given asset id by
   * cropping the shared tilemap atlas. `ui.js` calls this for the unit-stats
   * bar, the plan-panel portrait map, the disambiguation arc, and the combat
   * dialog. The 2D Renderer has the same method on it — by implementing it
   * here too the UI layer doesn't have to branch on renderer mode.
   *
   * Cached per (assetId, size) — repeat lookups are O(1) after first build.
   * Falls back to null when the tilemap hasn't loaded yet or the id is
   * unknown; ui.js degrades to a glyph fallback in that case.
   */
  getPortraitDataURL(assetId, size = 128) {
    if (!assetId || !this._tilemapImg || !this._spriteRects) return null;
    if (typeof document === 'undefined') return null;
    const rect = this._spriteRects.get(assetId);
    if (!rect) return null;
    if (!this._portraitDataURLCache) this._portraitDataURLCache = new Map();
    const key = `${assetId}@${size}`;
    if (this._portraitDataURLCache.has(key)) {
      return this._portraitDataURLCache.get(key);
    }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(
      this._tilemapImg,
      rect.x, rect.y, rect.size, rect.size,
      0, 0, size, size,
    );
    const url = c.toDataURL();
    this._portraitDataURLCache.set(key, url);
    return url;
  }

  /**
   * Round 4: terrain thumbnail used by the unit-stats bar's "current tile"
   * preview. We render a simple hex-cropped tile thumbnail (background colour
   * + sprite if available) — the 2D Renderer adds fortification rings and a
   * border, which we omit here as they were minor cues the 3D scene already
   * conveys at the camera level. Caller's UI degrades to "no terrain image"
   * if this returns null.
   */
  getTileDataURL(tile, col, row, size = 28) {
    if (!tile || typeof document === 'undefined') return null;
    if (!this._tileDataURLCache) this._tileDataURLCache = new Map();
    const cacheKey = `${baseOf(tile)}_${pathOf(tile) ?? ''}_${tile.building || ''}_${tile.fortifyLevel || 0}@${size}`;
    if (this._tileDataURLCache.has(cacheKey)) {
      return this._tileDataURLCache.get(cacheKey);
    }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const hs = size / 2;
    _traceHexPath2D(ctx, hs, hs, hs - 0.5);
    const baseColor = _tileFillColor(tile);
    ctx.fillStyle = baseColor;
    ctx.fill();

    if (this._tilemapImg && this._spriteRects) {
      const spriteId = _terrainThumbSpriteId(tile, col, row);
      const rect = spriteId ? this._spriteRects.get(spriteId) : null;
      if (rect) {
        ctx.save();
        _traceHexPath2D(ctx, hs, hs, hs - 0.5);
        ctx.clip();
        ctx.drawImage(this._tilemapImg, rect.x, rect.y, rect.size, rect.size, 0, 0, size, size);
        ctx.restore();
      }
      // Building overlay sprite on top of dirt.
      if (hasBuilding(tile) && tile.building) {
        const bldgRect = this._spriteRects.get(tile.building);
        if (bldgRect) {
          ctx.save();
          _traceHexPath2D(ctx, hs, hs, hs - 0.5);
          ctx.clip();
          ctx.drawImage(this._tilemapImg, bldgRect.x, bldgRect.y, bldgRect.size, bldgRect.size, 0, 0, size, size);
          ctx.restore();
        }
      }
    }
    // Hex outline for a touch of grid definition.
    _traceHexPath2D(ctx, hs, hs, hs - 0.5);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    const url = c.toDataURL();
    this._tileDataURLCache.set(cacheKey, url);
    return url;
  }

  // ─── Babylon scene setup ─────────────────────────────────────────────────

  async _initBabylon() {
    // Babylon core + loaders ship as UMD bundles under `assets/vendor/` and
    // attach to `window.BABYLON`. Loading both via <script> tags keeps a
    // single BABYLON instance so the glTF plugin registers on the same
    // SceneLoader the renderer uses. The module stays importable in
    // node-test (no DOM) because the helper short-circuits to null and the
    // draw loop only invokes `_initBabylon` after a real canvas is attached.
    const BABYLON = await this._ensureBabylonReady();
    if (!BABYLON) return;
    this._babylon = BABYLON;

    const engine = new BABYLON.Engine(this.canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene  = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.05, 0.04, 0.07, 1.0); // dark gothic

    // Isometric ArcRotateCamera. Pan + zoom + yaw are user-controlled; tilt
    // (beta) stays locked at the isometric angle so the board always reads
    // top-downish, like a board-game camera.
    const camera = new BABYLON.ArcRotateCamera(
      'cam',
      this._lockedAlpha,
      this._lockedBeta,
      20,
      BABYLON.Vector3.Zero(),
      scene,
    );
    // Camera-controls overhaul (t-0bd3e8c2): we deliberately skip Babylon's
    // built-in `camera.attachControl(canvas, true)` and replace the default
    // pointer/wheel inputs with `_installCustomCameraInput` below. Babylon's
    // defaults bake in 1-finger-rotate, which tested poorly on mobile — the
    // operator's iPhone playtest of #321 called it "wonky". The custom input
    // maps 1-pointer → pan, 2-pointer → pinch-zoom only on touch (the twist-
    // rotate branch is dropped on mobile; intent-lock survives for desktop
    // pointer input), and right-mouse-drag → rotate alpha on desktop.

    // Yaw (alpha) is unbounded — right-mouse / button-driven rotation spins
    // the camera around the vertical axis. Tilt (beta) is permanently
    // locked at CAMERA_BETA_LOCKED (π/4); both beta limits are pinned to
    // the same value so anything that mutates camera.beta — Babylon's own
    // inertia accumulators, a stray plugin, future code — is re-clamped
    // back to π/4 on the next render tick. We rotate the *camera*, not
    // `mapRoot`, so world-space stays stable for picking + `hexToCanvasPos`
    // projection (see the note on hexToCanvasPos).
    camera.lowerAlphaLimit = null;
    camera.upperAlphaLimit = null;
    camera.beta            = CAMERA_BETA_LOCKED;
    camera.lowerBetaLimit  = CAMERA_BETA_LOCKED;
    camera.upperBetaLimit  = CAMERA_BETA_LOCKED;

    // Zoom limits — both are provisional and get replaced by
    // _recomputeMaxZoomCap once the engine reports its actual aspect. The cap
    // is radiusForStandardFit (so larger maps must be panned to view in full)
    // and the floor is radiusForCloseFit(MIN_VISIBLE_HEXES) (so the camera
    // can't dive inside meshes at max zoom-in).
    // Lower radius capped at 6 wu — at ~radius 6 the camera frame holds
    // roughly 3-4 hex tiles which is the closest sensible inspection zoom
    // without the camera diving inside meshes. Previous value (1.5) let
    // the operator zoom in until the camera sat inside a single hex.
    camera.lowerRadiusLimit = 6;
    camera.upperRadiusLimit = 80;
    camera.wheelDeltaPercentage = 0.02; // smoother wheel zoom (legacy default — wheel handled by custom input)
    camera.pinchDeltaPercentage = 0.005;

    // Pan controls. Babylon's ArcRotateCamera still consumes inertialPanningX/Y
    // in its per-frame update even without attached inputs; the custom input
    // writes to those accumulators so the existing panningSensibility /
    // panningInertia tuning still applies.
    camera.panningSensibility = 250;
    camera.panningInertia     = 0.85;
    camera.useBouncingBehavior = false;

    // Install the custom input — one capture-phase pointer + wheel handler set
    // covering both mobile and desktop. Babylon's default `pointers` input is
    // never attached, so there's nothing to detach.
    this._installCustomCameraInput(camera);

    const light = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0.3), scene);
    light.intensity = 0.95;
    // scene.ambientColor is set per-phase in _applyLightConfig (was a fixed
    // value here; now varies — stronger and warm at dawn/dusk, stronger and
    // cool at night, low neutral at noon when the sun dominates).

    // Scene fog disabled — was washing out tree shadows and contrast
    // without delivering the intended atmospheric fade. _pumpSceneFog
    // and the fogColor sync in _applyLightConfig are still wired but
    // no-op while fogEnabled stays false. Reinstate by flipping this
    // flag if we ever want the linear-fog band back.
    scene.fogMode    = BABYLON.Scene.FOGMODE_NONE;
    scene.fogColor   = new BABYLON.Color3(0.55, 0.72, 0.85);
    scene.fogEnabled = false;

    // Directional sun light — casts shadows from standees / buildings / trees
    // onto the terrain. Starts pointing straight down with day-tier intensity;
    // _applyLightConfig immediately overrides both from the current phase
    // (and `_onBeforeRender` interpolates them across phase transitions).
    const sunLight = new BABYLON.DirectionalLight(
      'sun',
      new BABYLON.Vector3(0.35, -0.85, 0.4),
      scene,
    );
    // Lift the light's position so the shadow camera frustum sees the whole
    // map from above even when autoUpdateExtends nudges it.
    sunLight.position = new BABYLON.Vector3(0, 30, 0);
    sunLight.intensity = 1.0;
    // Auto-compute the shadow camera's near/far so the frustum hugs the
    // casters, then enlarge the orthographic shadow camera to cover a whole
    // Campaign-size map plus the visual border ring. Without these, Babylon's
    // default ortho size is ~10 world units — far smaller than our maps —
    // and shadows just don't render outside that footprint.
    sunLight.autoCalcShadowZBounds = true;
    const SHADOW_HALF = 40;
    sunLight.shadowOrthoScale = 0; // disable padding; rely on explicit ortho bounds
    sunLight.orthoLeft   = -SHADOW_HALF;
    sunLight.orthoRight  =  SHADOW_HALF;
    sunLight.orthoTop    =  SHADOW_HALF;
    sunLight.orthoBottom = -SHADOW_HALF;

    const shadowGenerator = new BABYLON.ShadowGenerator(SUN_SHADOW_MAP_SIZE, sunLight);
    shadowGenerator.usePercentageCloserFiltering = SUN_SHADOW_USE_PCF;
    shadowGenerator.filteringQuality = SUN_SHADOW_FILTERING_QUALITY;
    shadowGenerator.bias = SUN_SHADOW_BIAS;
    shadowGenerator.darkness = SUN_SHADOW_DARKNESS;
    // Honour the alpha channel of standee textures so each unit casts a
    // silhouette-shaped shadow rather than a billboard rectangle.
    shadowGenerator.transparencyShadow = true;

    this._engine            = engine;
    this._scene             = scene;
    this._camera            = camera;
    this._light             = light;
    this._sunLight          = sunLight;
    this._shadowGenerator   = shadowGenerator;

    // Per-unit hex outlines are built lazily by `_syncEntityHexOutlines`
    // (one thin + one thick mesh per alive entity). The old golden singleton
    // hex outline that only showed on the selected unit has been generalised
    // away — see `_syncEntityHexOutlines` + `_applySelectionAndFocus`.

    // Apply the starting phase's lighting immediately (no transition) so the
    // very first frame already reads dawn/day/dusk/night correctly.
    this._lastPhase   = this.state?.phase ?? null;
    this._lightState  = {
      intensity: 0,
      color: { r: 1, g: 1, b: 1 },
      clear: { r: 0, g: 0, b: 0 },
      sun: { dir: { x: 0, y: -1, z: 0.1 }, intensity: 1.0 },
    };
    this._applyLightConfig(getPhaseLightConfig(this._lastPhase));

    // Per-frame pump: drives phase-light interpolation and selection / node glow pulses.
    this._onBeforeRenderObs = scene.onBeforeRenderObservable.add(() => this._onBeforeRender());

    // Cap max zoom to whatever fits a standard map at the current aspect.
    // Must happen BEFORE _frameFullMap (whose `_radiusForFit` clamps to this
    // limit) and BEFORE _buildMap (whose forest band depth is sized off it).
    this._recomputeMaxZoomCap();

    // Kick off the building GLB loads asynchronously (one template per unique
    // variant path across all 13 building types). We deliberately don't await
    // here — `_buildMap` below is synchronous and the models are heavy.
    // Building tiles render with the procedural box+roof fallback; as each GLB
    // resolves, `_upgradeBuildingsToGlbModel` retrofits the matching tiles with
    // instances. Fire-and-forget — errors are caught inside `_loadBuildingModel`.
    this._loadBuildingModels(this._assetsBasePath || 'assets');

    // Kick off the paladin GLB load asynchronously. Fire-and-forget —
    // `_buildMap` + `_syncEntityStandees` run synchronously right after and
    // hero standees render with the cone+sphere fallback. Once the GLB
    // resolves (heavy ~7 MB file), `_upgradeHeroStandeesToPaladin` retrofits
    // every hero standee with a paladin clone. Errors are caught inside
    // `_loadPaladinModel`.
    this._loadPaladinModel(this._assetsBasePath || 'assets');

    // Kick off the tree-pack manifest + per-model GLB loads asynchronously.
    // Fire-and-forget — `_buildMap` runs synchronously right after and
    // FOREST tiles + the map-border forest render with the procedural
    // cone+sphere fallback. Once the manifest resolves,
    // `_upgradeForestToRealTrees` retrofits every forest cluster with real
    // GLB-tree instances. Errors are caught inside `_loadTreePackManifest`.
    this._loadTreePackManifest(this._assetsBasePath || 'assets');

    // Build the map from current state and frame it (instant — no animation
    // on the very first frame, otherwise the camera "slides in" from the
    // arbitrary radius=20 starting point). Then re-derive the max-zoom-out
    // cap NOW that state.tiles is populated so campaign/battle maps get a
    // cap that fits THEIR footprint, not the standard 13×13.
    this._buildMap();
    this._recomputeMaxZoomCap();
    this._frameFullMap({ instant: true });
    // Initial standee population so the first frame already has units.
    this._syncEntityStandees();
    this._syncEntityIconBillboards();
    this._syncEntityHexOutlines();
    this._applySelectionAndFocus();
    // Build the unified overlay map (objective rings + any pending highlights)
    // so the first rendered frame already has node rings. _syncOverlays is the
    // single dispatcher; it publishes state-derived overlays then builds them.
    this._syncOverlays();
    this._applyFogVeil();

    engine.runRenderLoop(() => scene.render());
    engine.resize();

    // Diagnostic handle: lets the operator run `__brimstone3dDebug.ribbons()`
    // from the browser console to inspect the runtime material/light state of
    // the road and river ribbons. `inspector()` toggles the Babylon Inspector
    // (also bound to the `D` hotkey). No-op when `window` is undefined (tests).
    if (typeof window !== 'undefined') {
      window.__brimstone3dDebug = {
        ribbons: () => this.dumpRibbonDebug(),
        renderer: this,
        inspector: () => this._toggleInspector(),
      };
      if (typeof document !== 'undefined' && !this._inspectorKeyBound) {
        this._inspectorKeyBound = true;
        window.addEventListener('keydown', (e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const t = e.target;
          const tag = (t?.tagName || '').toUpperCase();
          if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
          if (e.key === 'd' || e.key === 'D') {
            e.preventDefault();
            this._toggleInspector();
          } else if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            this._toggleBorderForest();
          }
        });
      }
    }
  }

  /** Apply the current `_borderForestHidden` flag to every border-band mesh.
   *  Called by `_toggleBorderForest` and by `_buildMapBorderForest` so meshes
   *  built while the band is hidden start in the right state. */
  _syncBorderForestVisibility() {
    const hide = this._borderForestHidden;
    for (const [, hex] of this._borderForestHexesByKey) hex.setEnabled(!hide);
    for (const [, props] of this._borderPropsByKey) for (const m of props) m.setEnabled?.(!hide);
    for (const m of this._borderForestBatchMeshes) m.setEnabled?.(!hide);
  }

  /** Toggle the visual-only border-forest band (the wilderness ring around the
   *  playable map) on/off. The band carries a few hundred tree cones plus
   *  textured hex cylinders, so even though it's static geometry it can drag
   *  fps on slow GPUs. Bound to the `F` hotkey for live debugging. Hidden by
   *  default — the playable map reads cleanly without it. */
  _toggleBorderForest() {
    this._borderForestHidden = !this._borderForestHidden;
    this._syncBorderForestVisibility();
    console.log(`[Renderer3D] border forest ${this._borderForestHidden ? 'hidden' : 'visible'}`);
  }

  /** Lazy-load the Babylon Inspector ESM bundle (pinned to the same version as
   *  core) and toggle it on the current scene. The Inspector exposes the full
   *  scene tree, per-mesh material/shadow panels, texture previews, and
   *  ShadowGenerator caster/receiver lists — invaluable for diagnosing
   *  "tile renders but is untextured / why aren't shadows painting" without
   *  guessing. Triggered by the `D` hotkey or `__brimstone3dDebug.inspector()`. */
  async _toggleInspector() {
    if (!this._scene) return;
    const layer = this._scene.debugLayer;
    if (layer?.isVisible?.()) {
      layer.hide();
      return;
    }
    if (!this._inspectorLoaded) {
      try {
        // The Inspector ships as a UMD bundle that hooks into `window.BABYLON`
        // (the same global core + loaders populate from `assets/vendor/`).
        // Loaded from a local vendor path so the packaged Electron / iOS app
        // has zero runtime CDN dependencies — the file is optional, so when
        // it's not present locally the inspector hotkey is effectively a
        // no-op and the warn below makes that explicit to the operator.
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/assets/vendor/babylonjs/babylon.inspector.bundle.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('script load failed'));
          document.head.appendChild(s);
        });
        this._inspectorLoaded = true;
      } catch (err) {
        console.warn('[Renderer3D] failed to load Babylon Inspector (drop babylon.inspector.bundle.js into assets/vendor/babylonjs/ to enable):', err);
        return;
      }
    }
    try {
      await layer.show({ embedMode: true, overlay: true, globalRoot: document.body });
    } catch (err) {
      console.warn('[Renderer3D] failed to show Babylon Inspector:', err);
    }
  }

  /**
   * Custom camera input — replaces Babylon's default ArcRotateCamera pointer
   * + wheel inputs. Single capture-phase listener set on the canvas covers
   * mobile (touch) and desktop (mouse + wheel) with the gesture spec from
   * t-0bd3e8c2:
   *
   *   Mobile / touch:
   *     • 1 finger drag        → pan (writes inertialPanningX/Y)
   *     • 2 finger pinch       → zoom only (rotate via on-screen buttons)
   *     • NO 1-finger rotate, NO 2-finger twist, NO 3-finger tilt
   *       (twist-rotate dropped — too easy to trigger accidentally while
   *       pinch-zooming; tilt is locked at π/4)
   *
   *   Desktop / mouse:
   *     • Wheel                → zoom (radius)
   *     • Left-drag            → pan (parity with mobile 1-finger)
   *     • Right-drag           → rotate alpha (yaw only — tilt is locked at π/4)
   *
   * Wires straight to the camera's inertial accumulators so Babylon's
   * panningSensibility / inertia / radius limits all still apply. Pan extent
   * clamping happens in `_onBeforeRender` (see the clampPanTarget call) since
   * inertia carries the target a few frames past the pointer-up event.
   */
  _installCustomCameraInput(camera) {
    if (!this.canvas || typeof this.canvas.addEventListener !== 'function') return;

    // Active pointer tracking: pointerId → { x, y, type, button, prevX, prevY }.
    // Touch pinch/twist needs the previous frame's positions to compute deltas.
    const pointers = new Map();
    this._customInputPointers = pointers;

    // Per-gesture drag tracking. `gestureDownPos` is the first pointer's
    // pointerdown position; `gestureDragged` flips true as soon as any pointer
    // moves further than CLICK_DRAG_THRESHOLD_PX from it, OR as soon as a
    // second pointer joins (multi-touch is never a click). On every pointerup
    // we publish the current value to `this._lastGestureWasDrag` so ui.js's
    // canvas-click handler can suppress the empty-hex deselect when the
    // synthetic `click` fires after a drag. See CLICK_DRAG_THRESHOLD_PX
    // module-scope comment for *why* the renderer (not ui.js) owns this guard.
    let gestureDownPos = null;
    let gestureDragged = false;
    this._lastGestureWasDrag = false;

    // Two-finger gesture state — primed on the second pointerdown, used and
    // reset on pointerup/cancel.
    //
    // gestureMode evolves: 'none' (no 2-finger gesture) → 'sampling' (second
    // finger just landed, waiting to see if user pinches or twists) → 'zoom'
    // or 'rotate' (locked for the rest of the gesture). See
    // `gestureLockDecision` above for the lock criteria.
    let lastPinchDist    = 0;
    let lastPinchAngle   = 0;
    let gestureMode      = 'none';
    let gestureStartDist  = 0;
    let gestureStartAngle = 0;
    let gestureStartTime  = 0;

    // Sensitivity knobs — tuned to the operator's iPhone playtest. Pan uses
    // panningSensibility (Babylon convention: lower number = faster). Twist
    // applies the raw radian delta directly (1px-of-rotation = 1px). Pinch
    // converts a "fingers spread by X px" gesture into a radius delta.
    // PINCH_RADIUS_PER_PX is exported at module scope so the pure pinch→radius
    // helper can be unit-tested without spinning up Babylon.
    const ALPHA_PER_PIXEL      = 0.0025; // right-drag rotate yaw (dialled down — old 0.006 spun too fast on desktop)
    const WHEEL_RADIUS_PER_DEL = 0.05;  // mouse wheel zoom

    const isTouchPoint = (p) => p && p.type === 'touch';

    // World-space drag pan: when the user starts dragging, we snapshot the
    // ground point (Y=0 plane) under the cursor; every subsequent pointermove
    // recomputes the ground point under the current cursor and shifts the
    // camera target by (grab − current). Because the camera's position
    // tracks target (radius offset only), the next frame's ray-through-pixel
    // converges so the grabbed terrain stays under the cursor exactly. This
    // delivers the "grab the world and pull it" feel the operator asked for
    // and replaces the old screen-space inertial-pan path which moved at a
    // fixed pixels-per-world rate regardless of zoom or camera angle.
    const groundPointFromScreen = (clientX, clientY) => {
      if (!this._scene || !camera) return null;
      const rect = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : { left: 0, top: 0 };
      const localX = clientX - (rect.left || 0);
      const localY = clientY - (rect.top  || 0);
      if (typeof this._scene.createPickingRay !== 'function') return null;
      const BABYLON = this._babylon;
      const idMat = BABYLON && BABYLON.Matrix && typeof BABYLON.Matrix.Identity === 'function'
        ? BABYLON.Matrix.Identity() : null;
      const ray = this._scene.createPickingRay(localX, localY, idMat, camera);
      if (!ray || !ray.direction) return null;
      // Ray going up or parallel to ground → no hit. Camera looking down has
      // direction.y < 0.
      if (ray.direction.y >= -1e-6) return null;
      const t = -ray.origin.y / ray.direction.y;
      if (t <= 0) return null;
      return {
        x: ray.origin.x + ray.direction.x * t,
        z: ray.origin.z + ray.direction.z * t,
      };
    };

    const applySinglePan = (entry, _dx, _dy) => {
      if (this.viewLocked) return;
      if (!entry.grab) entry.grab = groundPointFromScreen(entry.x, entry.y);
      if (!entry.grab) return; // ray missed (sky / parallel) — can't pan
      const current = groundPointFromScreen(entry.x, entry.y);
      if (!current) return;
      const ddx = entry.grab.x - current.x;
      const ddz = entry.grab.z - current.z;
      if (ddx === 0 && ddz === 0) return;
      camera.target.x += ddx;
      camera.target.z += ddz;
      // Kill the old inertial-pan accumulators so nothing competes with the
      // world-space drag math.
      camera.inertialPanningX = 0;
      camera.inertialPanningY = 0;
    };

    const applyTwoFingerGesture = (entries) => {
      if (this.viewLocked) return;
      const [a, b] = entries;
      const newDist  = pinchDistance(a, b);
      const newAngle = pinchAngle(a, b);

      // Intent locking: while gestureMode is 'sampling' (set on the second
      // pointerdown), evaluate the lock decision and possibly transition to
      // 'zoom' or 'rotate'. Once locked, only that axis is applied for the
      // rest of the gesture — pinching while rotating no longer wobbles
      // zoom, and vice versa.
      if (gestureMode === 'sampling') {
        const deltaDist  = newDist  - gestureStartDist;
        const deltaAngle = twistDelta(gestureStartAngle, newAngle);
        const elapsed    = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - gestureStartTime;
        const decision   = gestureLockDecision(deltaDist, deltaAngle, elapsed);
        if (decision === 'zoom' || decision === 'rotate' || decision === 'none') {
          gestureMode = decision;
        }
        // 'sampling' → stay sampling; deltas are deliberately not applied
        // during the sampling window so a small noisy frame doesn't bleed
        // into either axis before lock.
      }

      if (gestureMode === 'zoom' && lastPinchDist > 0) {
        const dDist = newDist - lastPinchDist;
        // Spread fingers (dDist > 0) → zoom in → radius shrinks. Helper returns
        // the desired radius delta (negative on spread); Babylon's
        // ArcRotateCamera does `radius -= inertialRadiusOffset` each frame, so
        // we accumulate -radiusDelta into the inertial offset.
        const radiusDelta = pinchDeltaToRadiusDelta(dDist, PINCH_RADIUS_PER_PX);
        camera.inertialRadiusOffset -= radiusDelta;
      } else if (gestureMode === 'rotate' && (lastPinchAngle !== 0 || lastPinchDist > 0)) {
        const dAngle = twistDelta(lastPinchAngle, newAngle);
        // Twist sign convention: twisting fingers one way should rotate the
        // VIEW the same way (operator: phone touch rotate was inverted). Was
        // -= (camera follows finger direction, but mapRoot/scene appears to
        // counter-rotate — felt inverted under playtest); += matches the
        // intuitive "I'm spinning the map under my fingers" reading.
        camera.inertialAlphaOffset += dAngle;
      }
      lastPinchDist  = newDist;
      lastPinchAngle = newAngle;
    };

    const applyRightDragRotate = (entry, dx, _dy) => {
      if (this.viewLocked) return;
      // Yaw-only: tilt is locked at π/4, so we deliberately ignore vertical
      // drag motion. Operator decision (tilt-lock task) — having dy → beta
      // here let users drag the camera out of the locked tilt before the
      // beta limits caught up.
      camera.inertialAlphaOffset += dx * ALPHA_PER_PIXEL;
    };

    this._onCustomPointerDown = (e) => {
      // We capture the pointer so move/up still fire if the user drags off-
      // canvas; this is important for the buttons row at the bottom edge.
      try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
      // Drag tracking: arm a fresh gesture when the first pointer lands; any
      // additional pointer joining mid-gesture forces drag=true (multi-touch
      // is never a click).
      if (pointers.size === 0) {
        gestureDownPos = { x: e.clientX, y: e.clientY };
        gestureDragged = false;
      } else {
        gestureDragged = true;
      }
      const entry = {
        id: e.pointerId,
        x:  e.clientX,
        y:  e.clientY,
        prevX: e.clientX,
        prevY: e.clientY,
        type: e.pointerType,
        button: e.button,
        grab: null, // ground point under cursor at first drag-move
      };
      // World-space drag pan needs the ground point at touchdown so the same
      // terrain feature stays under the cursor for the rest of the gesture.
      // Compute now while camera state is stable (no in-flight motion).
      if (pointers.size === 0) entry.grab = groundPointFromScreen(e.clientX, e.clientY);
      pointers.set(e.pointerId, entry);
      // Reset two-finger state when the second finger lands so the first
      // frame's deltas don't snap-rotate the camera. Also enter the
      // 'sampling' phase of intent-locking — applyTwoFingerGesture will
      // decide whether the user means to pinch or twist within the first
      // ~100ms of motion.
      if (pointers.size === 2) {
        const arr = [...pointers.values()];
        lastPinchDist  = pinchDistance(arr[0], arr[1]);
        lastPinchAngle = pinchAngle(arr[0], arr[1]);
        gestureStartDist  = lastPinchDist;
        gestureStartAngle = lastPinchAngle;
        gestureStartTime  = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Touch → lock to zoom immediately (no twist-rotate path on mobile).
        // Non-touch input falls through the normal sampling-then-lock flow.
        gestureMode = gestureModeForTwoFingerStart([arr[0].type, arr[1].type]);
      } else if (pointers.size > 2) {
        // 3+ pointers — ignore extras; the spec is explicit about no 3-finger
        // tilt. Wipe two-finger state so the recent extras don't drive twist.
        lastPinchDist  = 0;
        lastPinchAngle = 0;
        gestureMode    = 'none';
      }
    };

    this._onCustomPointerMove = (e) => {
      const entry = pointers.get(e.pointerId);
      if (!entry) return; // pointer never went down inside the canvas
      entry.prevX = entry.x;
      entry.prevY = entry.y;
      entry.x = e.clientX;
      entry.y = e.clientY;

      // Once any pointer travels past the click threshold from the gesture's
      // origin, classify the gesture as a drag. We measure from the first
      // pointer's down position (gestureDownPos) so a wandering second finger
      // still counts — single-finger pans, mouse pans, and pinch/twist all
      // exceed the threshold quickly. `gestureDragged` stays sticky for the
      // remainder of the gesture, even if the pointer moves back near origin.
      if (!gestureDragged && gestureDownPos) {
        if (!wasClick(gestureDownPos, { x: e.clientX, y: e.clientY })) {
          gestureDragged = true;
        }
      }

      const active = [...pointers.values()];
      if (active.length === 1) {
        const p = active[0];
        const dx = p.x - p.prevX;
        const dy = p.y - p.prevY;
        // Drag mode toggle (UI button) chooses pan vs rotate for both touch
        // and left-mouse drag. Right-mouse-drag stays as a power-user rotate
        // shortcut on desktop regardless of the toggle.
        const mode = this.cameraDragMode || 'pan';
        const doDrag = (mode === 'rotate')
          ? () => applyRightDragRotate(p, dx, dy)
          : () => applySinglePan(p, dx, dy);
        if (isTouchPoint(p)) {
          doDrag();
          e.preventDefault();
        } else if (p.type === 'mouse') {
          if (p.button === 0) {
            doDrag();
            e.preventDefault();
          } else if (p.button === 2) {
            applyRightDragRotate(p, dx, dy);
            e.preventDefault();
          }
        }
      } else if (active.length === 2) {
        applyTwoFingerGesture(active);
        e.preventDefault();
      }
    };

    this._onCustomPointerUp = (e) => {
      pointers.delete(e.pointerId);
      try { this.canvas.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
      // Drop two-finger state on transition back to fewer pointers — the next
      // 2-finger gesture re-primes on the second pointerdown.
      if (pointers.size < 2) {
        lastPinchDist  = 0;
        lastPinchAngle = 0;
        gestureMode    = 'none';
      }
      // Publish drag verdict on every pointerup. The synthetic `click` event
      // that follows pointerup will be inspected by ui.js's _onClick which
      // reads `renderer._lastGestureWasDrag` to decide whether to run the
      // hex-pick / select-or-deselect logic. We set it on every up (not just
      // the last) because the click fires off the *terminating* pointerup of
      // a primary-button gesture, and `gestureDragged` is already sticky.
      this._lastGestureWasDrag = gestureDragged;
      // Reset gesture state once the last pointer lifts so the next gesture
      // starts clean.
      if (pointers.size === 0) {
        gestureDownPos = null;
        gestureDragged = false;
      }
    };

    this._onCustomContextMenu = (e) => {
      // Suppress the browser context menu so right-drag works smoothly.
      e.preventDefault();
    };

    this._onCustomWheel = (e) => {
      if (this.viewLocked) return;
      const cam = this._camera;
      if (!cam) return;
      e.preventDefault();
      // ctrlKey is set by Mac trackpad pinch — treat the same as a wheel zoom
      // (the gesture's natural direction matches deltaY's sign).
      const dy = e.deltaY || 0;
      const newRadius = Math.max(
        cam.lowerRadiusLimit ?? 4,
        Math.min(cam.upperRadiusLimit ?? 80, cam.radius + dy * WHEEL_RADIUS_PER_DEL),
      );
      cam.radius = newRadius;
      this.zoomLevel = radiusToZoom(newRadius);
    };

    const optsCap = { capture: true, passive: false };
    this.canvas.addEventListener('pointerdown',   this._onCustomPointerDown,   optsCap);
    this.canvas.addEventListener('pointermove',   this._onCustomPointerMove,   optsCap);
    this.canvas.addEventListener('pointerup',     this._onCustomPointerUp,     optsCap);
    this.canvas.addEventListener('pointercancel', this._onCustomPointerUp,     optsCap);
    this.canvas.addEventListener('pointerleave',  this._onCustomPointerUp,     optsCap);
    this.canvas.addEventListener('contextmenu',   this._onCustomContextMenu,   optsCap);
    this.canvas.addEventListener('wheel',         this._onCustomWheel,         optsCap);
    // Stop the touch-action default so scrollback / pull-to-refresh doesn't
    // hijack a vertical pan on iOS Safari.
    if (this.canvas.style) this.canvas.style.touchAction = 'none';
  }

  // ─── Map construction ────────────────────────────────────────────────────

  /** Build one cylinder per tile, plus road/bridge decks and building boxes.
   *  Uses individual meshes (not thin instances) for Phase 2 — simpler to
   *  pick and easier to debug. Materials are cached by colour so the GPU
   *  state count stays low (~10 materials regardless of map size). */
  _buildMap() {
    if (this._mapBuilt) return;
    if (!this.state?.tiles || this.state.tiles.size === 0) return;

    const BABYLON = this._babylon;
    const scene   = this._scene;

    const mapRoot = new BABYLON.TransformNode('mapRoot', scene);
    this._mapRoot = mapRoot;

    // TEMPORARY: hardcode summer until the tree-pack extraction is re-done
    // for the other seasons. The current manifest only has tree-summer-complete
    // populated, so any other season falls through to the procedural cone
    // path AND silently disposes the procedural border-forest meshes during
    // _upgradeForestToRealTrees → border ends up empty. Forcing summer
    // makes real trees render until Phase 1.5 lands the other seasons.
    this._season = 'summer';

    // Reusable shared geometry — clone for each instance, all parented to mapRoot.
    // (We do not yet use Babylon InstancedMesh; one mesh per tile keeps picking
    // trivially correct and Phase 2 maps are well under 1000 tiles.)
    for (const tile of this.state.tiles.values()) {
      this._buildTileMesh(tile, mapRoot);
    }
    // Item 2: after every per-tile mesh exists, lay down the bezier road and
    // river networks on top of the grass tiles. Built once at map-load and
    // never rebuilt (the map topology is immutable once a game has started).
    this._buildRoadRiverNetworks();
    // Surround the playable area with a band of impassable thick-forest
    // hexes so the map reads as "world continues into wilderness" instead of
    // "map ends here at a hard edge". These tiles are visual-only — they
    // are NOT added to `state.tiles`, so units can't path into them, fog
    // logic skips them, and the camera pan clamp below still bounds to
    // the playable extent.
    this._buildMapBorderForest();
    this._syncBorderForestVisibility();
    // Cache map bounds in world-space XZ for the pan clamp (consumed by
    // _onBeforeRender → clampPanTarget). One-shot — map topology is immutable
    // once the game starts.
    const allHexes = [];
    for (const tile of this.state.tiles.values()) {
      allHexes.push({ col: tile.col, row: tile.row });
    }
    this._mapPanBounds = computeMapBounds(allHexes);
    // Tighter pan-clamp bounds — keep the playable map clearly the subject
    // at every zoom/tilt, instead of letting it slide out into the border
    // forest band. See `panBoundsForPlayableExtent` for the rationale.
    this._panClampBounds = panBoundsForPlayableExtent(this._mapPanBounds);
    this._mapBuilt = true;
    // Static meshes built above never move again — freeze their world matrices
    // so Babylon stops recomputing them every frame, and skip bounding-info
    // sync (used for active-mesh selection / picking; we don't depend on
    // dynamic bounds for any of these meshes). Single biggest unrealised perf
    // win on standard 13×13 + zoom-out — ~600–1500 static meshes per scene.
    this._freezeStaticMeshes();
  }

  /** Walk the known static-mesh registries built by `_buildMap` (tiles, props,
   *  border-forest, road/river network, node rings) and lock each mesh's world
   *  matrix + skip bounding-info sync. Idempotent — safe to call again after
   *  `_buildNodeGlowMeshes` to pick up the lazily-built node rings. Returns
   *  the number of meshes freshly frozen on this call, for tests + diagnostics.
   *
   *  What is freezed: anything that never moves post-build — playable hex
   *  prisms, terrain props (trees, buildings, roofs), bridges, road/river
   *  per-tile ribbon meshes + river extensions, border-forest cylinders + tree
   *  clusters, and power-node ring tubes.
   *
   *  What is NOT freezed (and must stay walking each frame): entity standees
   *  (cones, sphere heads, owner discs, icon billboards), per-unit hex
   *  outlines, plan ghosts / dashes / attack arrows / movement highlights,
   *  the selection halo, the overflow "+N" badges, and the building hover
   *  labels (those use `billboardMode = BILLBOARDMODE_ALL`, which requires a
   *  per-frame world-matrix update — freezing them would lock their rotation
   *  away from the camera). Dynamic meshes live in their own registries
   *  (`_entityStandees`, `_planGhostMeshes`, `_buildingLabelsByKey`, …) which
   *  this helper deliberately does not touch. */
  _freezeStaticMeshes() {
    let frozen = 0;
    const freeze = (mesh) => {
      if (!mesh || typeof mesh.freezeWorldMatrix !== 'function') return;
      if (mesh.isWorldMatrixFrozen) return;
      mesh.freezeWorldMatrix();
      mesh.doNotSyncBoundingInfo = true;
      frozen++;
    };
    // Playable tile cylinders.
    if (this._tileMeshes) for (const m of this._tileMeshes) freeze(m);
    // Per-tile props (trees, buildings, roofs, bridges, road/river per-tile
    // merged ribbons, node-disc rings registered into the tile prop list).
    if (this._tilePropsByKey) {
      for (const list of this._tilePropsByKey.values()) {
        for (const m of list) freeze(m);
      }
    }
    // Border-forest hex prisms + props (trees, river extensions).
    if (this._borderForestHexesByKey) {
      for (const m of this._borderForestHexesByKey.values()) freeze(m);
    }
    if (this._borderPropsByKey) {
      for (const list of this._borderPropsByKey.values()) {
        for (const m of list) freeze(m);
      }
    }
    // Cross-tile merged border-forest trees (`_buildBorderForestTreesBatched`
    // collapses ~240–900 per-tile cone clusters into ≤10 merged meshes — the
    // biggest static draw-call payoff on the map, so freezing them here is
    // load-bearing for the perf win).
    if (Array.isArray(this._borderForestBatchMeshes)) {
      for (const m of this._borderForestBatchMeshes) freeze(m);
    }
    // Power-node ring tubes (built lazily on first draw — re-invocation picks
    // them up).
    if (this._nodeGlowMeshes) {
      for (const ng of this._nodeGlowMeshes) freeze(ng?.disc);
    }
    return frozen;
  }

  /** Surround the playable hex grid with a band of impassable, visual-only
   *  forest hexes that fade the map into wilderness instead of ending at a
   *  hard rectangular edge.
   *
   *  Each border position gets the same three meshes a playable forest tile
   *  has — a solid-colour hex cylinder, a textured top disc (forest sprite),
   *  and a deterministic cluster of cone "trees" — but with a slightly
   *  higher cone count (`borderForestTreesForHex`) to read as denser
   *  wilderness.
   *
   *  These positions are NOT in `state.tiles`, so:
   *    • units never path into them (impassable by absence, not by rule)
   *    • fog logic skips them (`_applyFogVeil` iterates `state.tiles`)
   *    • the camera pan clamp (`_mapPanBounds`, computed from `state.tiles`
   *      only) still bounds the user to the playable rectangle
   *
   *  Static — built once at map-load (map topology is immutable). */
  _buildMapBorderForest() {
    if (!this.state?.tiles || !this._scene || !this._babylon || !this._mapRoot) return;
    const BABYLON  = this._babylon;
    const scene    = this._scene;
    const parent   = this._mapRoot;
    const baseColor = TILE_COLOR[TileType.FOREST] || TILE_COLOR[TileType.GRASS];
    const baseMat   = this._materialFor(baseColor);
    const treeMat   = this._materialFor('#234c1f');
    // Size the band so it still surrounds the visible frustum after the
    // player pans to the playable corner at maximum zoom-out. Falls back to
    // BORDER_BAND_DEPTH (2) if engine/camera aren't ready (e.g. headless test).
    const aspect = this._engine
      ? this._engine.getRenderWidth() / Math.max(1, this._engine.getRenderHeight())
      : 16 / 9;
    const fov = this._camera?.fov || 0.8;
    const cap = this._camera?.upperRadiusLimit ?? radiusForStandardFit(aspect, fov);
    // Hard cap at 3 hexes deep regardless of camera distance — the band's job
    // is to give the playable edge a sense of "world continues" within a small
    // visual frame, not to fill the screen with hundreds of cones. Previously
    // forestBandDepthForView could push this past 10 at zoomed-out views and
    // tank fps. 3 reads as plenty of forest visually while keeping draw cost
    // bounded. (See task 17.)
    // 6 hexes deep — gives the playable map a wider wilderness frame so the
    // scene fog has room to fade the distant rows into grey before the
    // playable area sees any fog.
    const bandDepth = Math.min(6, Math.max(BORDER_BAND_DEPTH,
      forestBandDepthForView(cap, aspect, fov)));
    // Precompute river-extension corridors so `_borderTreeBlockedByRiver`
    // can reject tree positions that would land in the water extending past
    // the playable edge. Each entry is the exit point, outward unit tangent,
    // and the extension length (matches `_buildRiverExtensions`).
    const extensionLength = (bandDepth + 1) * SQRT3;
    const halfRiverWidth = RIVER_RIBBON_WIDTH / 2 + 0.20; // small buffer past the visible ribbon
    this._riverExtensionCorridors = riverExitPoints(this.state.tiles).map(exit => ({
      px: exit.point.x, pz: exit.point.z,
      tx: exit.tangent.x, tz: exit.tangent.z,
      length: extensionLength,
      half:   halfRiverWidth,
    }));
    // Collect tree clusters for every border tile and merge them in one pass
    // across the whole band — see `_buildBorderForestTreesBatched`. The result
    // is ≤10 merged meshes regardless of `bandDepth`, instead of 2–4 per tile
    // (≈240–900 meshes at max zoom-out).
    // Playable extent drives the edge-fade: each border tile's alpha is keyed
    // to how many rings it sits from the OUTER edge of the band (outermost ring
    // dissolves most). See `borderForestAlphaForTile`.
    const ext = tilesExtent(this.state.tiles);
    const treeJobs = [];
    for (const pos of borderTilePositions(this.state.tiles, bandDepth)) {
      const { x, z } = hexToWorld(pos.col, pos.row);
      const alpha = borderForestAlphaForTile(pos.col, pos.row, ext, bandDepth);

      // Flat hex polygon — identical recipe to _buildTileMesh's flat tile.
      const hex = this._buildFlatHexMesh(`border_tile_${pos.col}_${pos.row}`, parent, x, z);
      // Border-forest hex tiles ALWAYS render with the fog-of-war tint —
      // they sit outside the playable area, never observable by any player,
      // so they consistently read as wilderness ground beyond sight. The
      // trees on top stay in their normal (unfogged) colours so the
      // wilderness silhouette doesn't go too dark to read against the sky.
      const syntheticTile = { type: TileType.FOREST, base: TileType.FOREST, col: pos.col, row: pos.row };
      // Fade the ground hex with the SAME per-ring alpha as the trees on this
      // tile (`alpha`), so the band's ground and foliage dissolve together at
      // the map edge. `_borderGroundMaterialFor` clones the shared fogged
      // terrain material per alpha tier — the playable map's ground material
      // is never touched.
      const borderMat = this._borderGroundMaterialFor(
        terrainSpriteIdFor(syntheticTile, pos.col, pos.row),
        baseColor,
        alpha,
      );
      hex.material   = borderMat || this._fogMaterialFor(baseColor);
      hex.isPickable = false;
      hex.metadata   = { kind: 'map-border-forest', col: pos.col, row: pos.row };
      this._setShadowReceiver(hex);
      // Faded outer-ring ground discs are alpha-blended — pin a stable
      // alphaIndex so they stop reshuffling under the per-frame distance sort
      // (see BORDER_GROUND_ALPHA_INDEX). Opaque inner-band discs render in the
      // opaque pass where alphaIndex is ignored, so only tag the faded ones.
      if (alpha < 1) hex.alphaIndex = BORDER_GROUND_ALPHA_INDEX;
      this._borderForestHexesByKey.set(hexKey(pos.col, pos.row), hex);
      this._borderPropsByKey.set(hexKey(pos.col, pos.row), [hex]);

      // Pine trees use the SAME layout as in-map FOREST tiles so the band
      // reads as a continuous extension of the map (operator: "the forest
      // outside the playable area to look and feel like an extension of the
      // map"). Same tree count (3-5 per tile, was 5-7 for border), same
      // trunk/leaf colours. Trees are skipped where they'd land inside the
      // river-extension footprint.
      const trees = forestTreesForHex(pos.col, pos.row, this._season).filter(t =>
        !this._borderTreeBlockedByRiver(x + t.x, z + t.z),
      );
      if (trees.length > 0) {
        treeJobs.push({
          namePrefix: `border_forest_${pos.col}_${pos.row}`,
          cx: x, cz: z, trees, col: pos.col, row: pos.row, alpha,
        });
      }
    }
    // Real GLB trees take precedence when the manifest has loaded with a
    // template for this season; otherwise the original cross-tile batched
    // merge path takes over so the band still renders. Real-tree path
    // builds per-tile instances (one createInstance call per tree); Babylon
    // hardware-instancing collapses that to one draw call per template.
    let bandTreeMeshes = [];
    if (this._useRealTrees) {
      for (const job of treeJobs) {
        const insts = this._buildRealForestTreesForHex(
          parent, job.col, job.row, job.cx, job.cz, job.trees, job.namePrefix,
          { season: this._season, alpha: job.alpha },
        );
        for (const m of insts) bandTreeMeshes.push(m);
      }
    }
    if (bandTreeMeshes.length === 0) {
      // Bucket jobs by alpha tier: Babylon can't do per-instance alpha on a
      // shared merged mesh, so each tier merges into its own translucent
      // material. ≤4 tiers (1.0 / 0.8 / 0.5 / 0.2) → ≤4× the (≤10) merged
      // meshes, still O(1) in band depth and far below the per-tile path.
      const jobsByAlpha = new Map();
      for (const job of treeJobs) {
        const a = job.alpha ?? 1;
        let bucket = jobsByAlpha.get(a);
        if (!bucket) { bucket = []; jobsByAlpha.set(a, bucket); }
        bucket.push(job);
      }
      for (const [a, jobs] of jobsByAlpha) {
        const prefix = a < 1 ? `border_forest_a${Math.round(a * 100)}` : 'border_forest';
        const mergedTreeMeshes = this._buildBorderForestTreesBatched(
          parent, jobs, { season: this._season, alpha: a, namePrefix: prefix },
        );
        for (const m of mergedTreeMeshes) {
          this._addShadowCaster(m);
          // Faded foliage tiers are alpha-blended — pin a stable alphaIndex
          // (above the ground discs, below the river) so the band's draw order
          // no longer flips per-frame under the distance sort.
          if (a < 1) m.alphaIndex = BORDER_TREE_ALPHA_INDEX;
          bandTreeMeshes.push(m);
        }
      }
    }
    this._borderForestBatchMeshes = bandTreeMeshes;
    // After the band is in place, extend any river that exits the playable
    // map outward in a straight line through the band so the water doesn't
    // visually dead-end at the playable edge. Built last so `bandDepth` is in
    // scope and the in-map river mesh's material is available for re-use.
    this._buildRiverExtensions(bandDepth);
  }

  /** Continue every river endpoint past the playable map edge using the SAME
   *  render path as the in-map river ribbon (`_buildNetworkMesh`): a 5-path
   *  feathered ribbon with per-vertex alpha tapering at the lateral edges,
   *  sharing the river ribbon material via `_buildRibbonMaterial`. The result
   *  is indistinguishable from the in-map river — same dark-navy diffuse +
   *  emissive, same alpha-feathered edges, same alphaIndex / shadow reception
   *  — so the water reads as one continuous flow from playable to wilderness
   *  instead of a bright rectangular strip butted onto a feathered bezier.
   *
   *  Each extension lives in `_borderPropsByKey` under a synthetic
   *  `river-ext:col,row` key alongside the surrounding forest props, so it
   *  follows the same visual-only lifecycle (no state.tiles entry, no
   *  pan-clamp influence). No-op when the map has no river, or when the
   *  forest band is disabled. */
  _buildRiverExtensions(bandDepth) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!BABYLON || !scene || !this.state?.tiles) return;
    if (!(bandDepth > 0)) return;
    if (!this._riverNetworkMesh) return; // no river on this map
    const exits = riverExitPoints(this.state.tiles);
    if (exits.length === 0) return;
    // Build via the SAME helper as the playable-map river ribbons — same
    // 'river' branch, so the extension picks up the river-ribbon texture,
    // useAlphaFromDiffuseTexture, zero emissive. THEN multiply diffuseColor
    // by _fogTileDarken so the textured extension always reads as
    // wilderness-beyond-sight (matching the border-forest hex tiles it
    // weaves through — which are permanently fogged). The sampled texel is
    // texture.rgb × diffuseColor.rgb, so this darkens the entire extension
    // ribbon by FOG_TILE_DARKEN regardless of the actual fog veil state.
    const extMat = this._buildRibbonMaterial('river', TILE_COLOR[TileType.RIVER]);
    const k = this._fogTileDarken;
    if (extMat.diffuseColor) {
      extMat.diffuseColor.r *= k;
      extMat.diffuseColor.g *= k;
      extMat.diffuseColor.b *= k;
    }
    // Mark the (private, freshly-built) extension material for explicit
    // alpha-blending so the per-ring edge fade baked into the ribbon's vertex
    // alpha below actually composites against the scene — matching the ground
    // + tree fade recipe (`_applyAlphaBlend`). `_buildRibbonMaterial` returns a
    // NEW StandardMaterial each call, so this never touches the in-map river's
    // material. The playable river ribbon stays fully opaque.
    if (this._babylon?.Material) {
      extMat.transparencyMode = this._babylon.Material.MATERIAL_ALPHABLEND;
    }
    // Playable-map extent — used to map each ribbon sample to its border ring
    // so the river fades in lockstep with the ground + trees on that ring.
    const ringExt = tilesExtent(this.state.tiles);
    // Extend one hex past the outermost band tile so the ribbon's far end
    // clearly carries past the band's silhouette instead of fading inside it.
    // Centre-to-centre spacing in any axial direction is SQRT3 world units.
    const length = (bandDepth + 1) * SQRT3;
    // Use the SAME segment count as the in-map bezier so the per-sample
    // density of the feathered alpha gradient matches at the join.
    const segments = NETWORK_BEZIER_SEGMENTS;
    const OPAQUE_FRAC = 0.80;
    for (const exit of exits) {
      // Centreline samples along the outward tangent from `exit.point` (which
      // is exactly where the in-map ribbon's bezier ends — see `riverExitPoints`).
      // Add a tapered sine-wave perpendicular offset so the extension WINDS
      // away from the playable map instead of running dead straight, matching
      // the bezier-curve behaviour of the in-map river. Amplitude is 0 at
      // both endpoints (so the join at exit.point is exact and the far tip
      // feathers naturally) and peaks mid-path. The phase is seeded off the
      // exit point's world coordinates so multiple exits wind differently.
      const perpX = -exit.tangent.z;
      const perpZ =  exit.tangent.x;
      const RIVER_EXT_WIND_AMP    = 0.6;  // world units of lateral sway at peak
      const RIVER_EXT_WIND_CYCLES = 1.25; // wave cycles across the extension
      const phaseOffset = Math.atan2(exit.point.x + 7.1, exit.point.z + 3.3);
      const pts = new Array(segments + 1);
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const taper = Math.sin(Math.PI * t); // 0 → 1 → 0
        const wind  = RIVER_EXT_WIND_AMP * taper
          * Math.sin(t * 2 * Math.PI * RIVER_EXT_WIND_CYCLES + phaseOffset);
        pts[i] = {
          x: exit.point.x + exit.tangent.x * length * t + perpX * wind,
          z: exit.point.z + exit.tangent.z * length * t + perpZ * wind,
        };
      }
      // Five-path ribbon with lateral alpha taper, matching the in-map river
      // ribbon's recipe in `_buildNetworkMesh`. Path order is
      // `[rightOuter, rightInner, center, leftInner, leftOuter]`; first triangle
      // winding produces a +Y face normal so the hemispheric light hits the
      // camera-visible top face (see the contract comment on `_buildNetworkMesh`).
      // Same world-space width modulation as the playable river so the
      // ribbon widths at the playable→wilderness seam are continuous (both
      // sample the same world (x,z) at the shared exit point). Wavelength
      // and amplitude must match _buildNetworkMesh's modulator.
      const WIDTH_NOISE_WAVELENGTH = 8.0;
      const WIDTH_AMP = 0.075;
      const widthModAt = (x, z) => {
        const u = (x / WIDTH_NOISE_WAVELENGTH + z / WIDTH_NOISE_WAVELENGTH * 0.7) * Math.PI * 2;
        return 1 + WIDTH_AMP * Math.sin(u);
      };
      const outerWidths = new Array(pts.length);
      const innerWidths = new Array(pts.length);
      for (let p = 0; p < pts.length; p++) {
        const mod = widthModAt(pts[p].x, pts[p].z);
        outerWidths[p] = RIVER_RIBBON_WIDTH * mod;
        innerWidths[p] = RIVER_RIBBON_WIDTH * OPAQUE_FRAC * mod;
      }
      const { left: outerLeft,  right: outerRight  } = ribbonOffsetPaths(pts, outerWidths);
      const { left: innerLeft,  right: innerRight  } = ribbonOffsetPaths(pts, innerWidths);
      const toV3 = (arr) => arr.map(p => new BABYLON.Vector3(p.x, RIVER_RIBBON_Y, p.z));
      const ribbon = BABYLON.MeshBuilder.CreateRibbon(
        `river_extension_${exit.tile.col}_${exit.tile.row}`,
        {
          pathArray: [toV3(outerRight), toV3(innerRight), toV3(pts), toV3(innerLeft), toV3(outerLeft)],
          sideOrientation: BABYLON.Mesh.DOUBLESIDE,
          closeArray: false,
          closePath: false,
          updatable: false,
        },
        scene,
      );
      ribbon.parent     = this._mapRoot;
      ribbon.isPickable = false;
      ribbon.material   = extMat;
      // Per-vertex alpha = lateral feather (path index) × per-ring EDGE FADE
      // (point index). The lateral term tapers the ribbon's left/right edges
      // into the ground (paths 0 and 4 → 0); the per-ring term dissolves the
      // ribbon outward so it fades in lockstep with the border ground + trees
      // it threads through (outermost ring → 0.2, next → 0.5, …). Without the
      // per-ring term the centreline ran at full opacity all the way to the
      // band's outer edge and then hard-stopped (operator: the river isn't
      // fading either).
      const totalVerts = ribbon.getTotalVertices();
      const N = pts.length;
      const alphaByPath = [0.0, 1.0, 1.0, 1.0, 0.0];
      const ringAlphas  = riverExtensionRingAlphas(pts, ringExt, bandDepth);
      const colors = new Float32Array(totalVerts * 4);
      for (let v = 0; v < totalVerts; v++) {
        const pathIdx  = Math.min(alphaByPath.length - 1, Math.floor(v / N));
        const pointIdx = v % N;
        const ringA    = ringAlphas[pointIdx] ?? 1.0;
        const a = alphaByPath[pathIdx] * ringA;
        colors[v * 4 + 0] = 1;
        colors[v * 4 + 1] = 1;
        colors[v * 4 + 2] = 1;
        colors[v * 4 + 3] = a;
      }
      ribbon.setVerticesData(BABYLON.VertexBuffer.ColorKind, colors);
      // Per-vertex UVs — same recipe as the playable river: U = cumulative
      // XZ length, V = path index → {0, 0.3, 0.5, 0.7, 1}. The first sample
      // of the extension starts at the same world position as the playable
      // river's last sample, but we restart U=0 here; that's a small seam
      // but invisible at typical zoom because the texture tile period is
      // ~1 world unit and the join point is feathered to alpha ~0 anyway.
      const vByPath = [0.0, 0.3, 0.5, 0.7, 1.0];
      const periods = new Array(N);
      periods[0] = 0;
      for (let p = 1; p < N; p++) {
        const dx = pts[p].x - pts[p - 1].x;
        const dz = pts[p].z - pts[p - 1].z;
        periods[p] = periods[p - 1] + Math.sqrt(dx * dx + dz * dz);
      }
      const RIVER_TILE_PERIOD = 1.0;
      const uvs = new Float32Array(totalVerts * 2);
      for (let v = 0; v < totalVerts; v++) {
        const pathIdx  = Math.min(vByPath.length - 1, Math.floor(v / N));
        const pointIdx = v % N;
        uvs[v * 2 + 0] = periods[pointIdx] / RIVER_TILE_PERIOD;
        uvs[v * 2 + 1] = vByPath[pathIdx];
      }
      ribbon.setVerticesData(BABYLON.VertexBuffer.UVKind, uvs);
      // Flat +Y normals for full sun lighting — see _buildNetworkMesh.
      if (typeof ribbon.getVerticesData === 'function') {
        const pos = ribbon.getVerticesData(BABYLON.VertexBuffer.PositionKind);
        if (pos) {
          const vcount = pos.length / 3;
          const flatNormals = new Float32Array(vcount * 3);
          for (let v = 0; v < vcount; v++) {
            flatNormals[v * 3 + 0] = 0;
            flatNormals[v * 3 + 1] = 1;
            flatNormals[v * 3 + 2] = 0;
          }
          ribbon.setVerticesData(BABYLON.VertexBuffer.NormalKind, flatNormals);
        }
      }
      ribbon.hasVertexAlpha = true;
      ribbon.alphaIndex     = RIVER_ALPHA_INDEX;
      // Match the playable-map river ribbons — same flat ground-hugging strip,
      // so it should catch unit/tree shadows identically.
      this._setShadowReceiver(ribbon);
      ribbon.metadata = { kind: 'river-extension', col: exit.tile.col, row: exit.tile.row };
      const key = `river-ext:${exit.tile.col},${exit.tile.row}`;
      const list = this._borderPropsByKey.get(key) || [];
      list.push(ribbon);
      this._borderPropsByKey.set(key, list);
    }
  }

  /** Set of TILE_SLOTS indices a road deck crosses on a forest tile, so the
   *  forest cones skip them (and the standee re-slot reserves them). Returns an
   *  empty Set for a forest tile with no road, or when the tile carries no road
   *  metadata. The road centreline geometry is the SAME `networkStrokesForTile`
   *  the merged road mesh is built from, so the exclusion matches the deck the
   *  player sees. */
  _forestRoadBlockedSlots(tile) {
    const empty = new Set();
    if (!tile) return empty;
    const hasRoad = pathOf(tile) === PathType.ROAD
      || (tile.roadDirs && tile.roadDirs.size > 0);
    if (!hasRoad) return empty;
    const tiles = this.state?.tiles;
    if (!tiles) return empty;
    const nbrs = [];
    if (tile.roadDirs && typeof tile.roadDirs[Symbol.iterator] === 'function') {
      for (const k of tile.roadDirs) {
        const nt = tiles.get(k);
        if (nt) nbrs.push({ col: nt.col, row: nt.row });
      }
    }
    if (nbrs.length === 0) return empty;
    const strokes = networkStrokesForTile(tile, nbrs, { kind: 'road' });
    if (!strokes.length) return empty;
    const center = hexToWorld(tile.col, tile.row);
    return roadBlockedTreeSlots(strokes, center);
  }

  _buildTileMesh(tile, parent) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    const { x, z } = hexToWorld(tile.col, tile.row);

    // ── Base hex tile (flat, single face, no side walls) ─────────────────
    // Open-faced pointy-top hex polygon at Y=0, tightly tileable with no
    // cylinder rim to produce dark seams at the perimeter.
    const baseColor = tileColorFor(tile);
    const hex = this._buildFlatHexMesh(`tile_${tile.col}_${tile.row}`, parent, x, z);
    hex.material   = this._tileMaterialFor(tile);
    hex.metadata   = { kind: 'tile', col: tile.col, row: tile.row, baseColor };
    // Terrain cylinder receives shadows from standees / trees / buildings /
    // bridges (cast registrations below).
    this._setShadowReceiver(hex);
    this._tileMeshes.push(hex);
    const tkey = hexKey(tile.col, tile.row);
    this._tileMeshByKey.set(tkey, hex);
    const props = [];
    const trackProp = (m) => { props.push(m); };

    // ── Forests: a small cluster of pine-shaped trees in the unified tile-slot
    // positions, leaving the centre slot clear for an entity standee.
    // Layout is deterministic per (col, row) so the same hex always shows the
    // same cluster across runs. See forestTreesForHex / TILE_SLOTS.
    // Forest cones are gated on the BASE material, NOT tile.type — so a road
    // laid through a forest (or a building on a forest tile) still shows trees
    // alongside the path/structure, instead of the forest vanishing the moment
    // a path was painted over it.
    if (baseOf(tile) === TileType.FOREST) {
      // On a building-on-forest tile, reserve the building slot so the forest
      // cones skip BUILDING_SLOT_INDEX (where the procedural box below sits).
      // On a road-through-forest tile, also skip the slots the road deck
      // crosses so cones never land on the road mesh. Cached so the per-draw
      // standee re-slot reserves the same slots.
      const blockedSlots = this._forestRoadBlockedSlots(tile);
      if (blockedSlots.size > 0) this._roadBlockedSlotsByKey.set(tkey, blockedSlots);
      const trees = forestTreesForHex(tile.col, tile.row, this._season, {
        reserveBuildingSlot: hasBuilding(tile),
        blockedSlots,
      });
      // Prefer the real GLB-tree path when the tree-pack manifest has
      // resolved AND has a template for the current season. Falls back to
      // the procedural cone+sphere stack on any miss (empty group, missing
      // template, etc.) so a missing manifest never leaves a FOREST tile
      // bare.
      const realInsts = this._useRealTrees
        ? this._buildRealForestTreesForHex(
            parent, tile.col, tile.row, x, z, trees,
            `forest_${tile.col}_${tile.row}`, { season: this._season },
          )
        : [];
      if (realInsts.length > 0) {
        for (const m of realInsts) trackProp(m);
      } else {
        const meshes = this._buildPineTreeBatchedMeshes(
          `forest_${tile.col}_${tile.row}`, parent, x, z, trees,
          { season: this._season },
        );
        for (const m of meshes) {
          this._addShadowCaster(m);
          m.metadata = { respectsFog: false };
          trackProp(m);
        }
      }
    }

    // Road/river ROAD/RIVER tiles get NO per-tile prop here — the bezier
    // network mesh built in _buildRoadRiverNetworks() (after this loop)
    // carries the visual. The grass-coloured cylinder + textured top disc
    // above is what shows on either side of the path.

    // ── Bridge: arched wooden plank crossing the river hex ──────────────
    // Build a flat slab (rectangle cross-section) extruded along an arched
    // path. Reads as a plank-thick bridge that rises smoothly over the water
    // and lands on the road at either end. Width / endpoint height tuned to
    // line up visually with the road ribbon (ROAD_RIBBON_WIDTH = 0.6, sitting
    // at Y = ROAD_RIBBON_Y ≈ 0.008).
    if (this._renderBridges && isBridge(tile)) {
      const yaw       = bridgeRotationY(tile, this.state.tiles);
      const span      = 1.8;                     // bridge length along the road
      const thickness = 0.10;                    // slab thickness
      const width     = ROAD_RIBBON_WIDTH * 1.15; // ~5% shoulder past the road
      const seat      = ROAD_RIBBON_Y + thickness / 2; // bottom flush with road
      const peak      = 0.42;                    // midspan height (top of slab)
      const samples   = 14;
      // Arched path in world space, oriented by yaw.
      const path = [];
      for (let i = 0; i <= samples; i++) {
        const u    = i / samples;
        const local = (u - 0.5) * span;          // -span/2 .. +span/2 along +X
        const arc   = seat + (peak - seat) * Math.sin(Math.PI * u);
        const wx = x + Math.cos(yaw) * local;
        const wz = z + Math.sin(yaw) * local;
        path.push(new BABYLON.Vector3(wx, arc, wz));
      }
      // Rectangular cross-section (in the XY plane — Babylon ExtrudeShape
      // sweeps this profile along `path`, automatically orienting at each
      // step so the slab follows the arc without manual rotation).
      const halfW = width / 2;
      const halfT = thickness / 2;
      const shape = [
        new BABYLON.Vector3(-halfW, -halfT, 0),
        new BABYLON.Vector3( halfW, -halfT, 0),
        new BABYLON.Vector3( halfW,  halfT, 0),
        new BABYLON.Vector3(-halfW,  halfT, 0),
        new BABYLON.Vector3(-halfW, -halfT, 0), // close
      ];
      const plank = BABYLON.MeshBuilder.ExtrudeShape(
        `bridge_${tile.col}_${tile.row}`,
        { shape, path, cap: BABYLON.Mesh.CAP_ALL, sideOrientation: BABYLON.Mesh.DOUBLESIDE },
        scene,
      );
      plank.parent     = parent;
      plank.material   = this._materialFor('#8a6030');
      plank.isPickable = false;
      this._addShadowCaster(plank);
      // Bridge planks are raised flat platforms — unit standees walking across
      // them should drop shadows onto the deck, not have those shadows fall
      // through to the river surface below.
      this._setShadowReceiver(plank);
      trackProp(plank);
    }

    // ── Building: either a glTF model instance (if the tile's variant template
    // has loaded by now) or the procedural box + roof fallback. Both paths
    // anchor the building at the NE outer slot (BUILDING_SLOT_INDEX); a
    // standee on the same hex takes the centre slot so silhouettes don't
    // overlap. The GLB loads run async from `_initBabylon` — as each resolves
    // after `_buildMap` completes, `_upgradeBuildingsToGlbModel` swaps the
    // procedural meshes here for instances.
    if (hasBuilding(tile) && tile.building) {
      // Every building type renders an imported GLB once its template loads;
      // until then (or on a per-type load failure) it keeps the procedural
      // box+roof. See BUILDING_GLB_BY_TYPE.
      const glbInst = buildingUsesGlbModel(tile)
        ? this._buildBuildingInstance(tile, x, z, parent)
        : null;
      if (glbInst) {
        trackProp(glbInst);
      } else {
        const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
        // Per-tile dimension jitter so buildings show silhouette variety
        // instead of an army of identical boxes. See `buildingDimensionsForHex`.
        const dims = buildingDimensionsForHex(tile.col, tile.row);
        // Box sits on top of the tile prism with its base at Y = TILE_PRISM_TOP
        // (historically 0.08, the "0.43 - 0.7/2" anchor before jitter). Y the
        // box centre to (TILE_PRISM_TOP + height/2) so the floor stays planted.
        const tileTopY = 0.43 - 0.7 / 2;
        const box = BABYLON.MeshBuilder.CreateBox(
          `bldg_${tile.col}_${tile.row}`,
          { width: dims.box.width, height: dims.box.height, depth: dims.box.depth },
          scene,
        );
        box.parent     = parent;
        box.position.x = x + slot.x;
        box.position.z = z + slot.z;
        box.position.y = tileTopY + dims.box.height / 2;
        box.material   = this._materialFor(BUILDING_COLOR[tile.building] || '#8a7a5a');
        box.isPickable = false;
        this._addShadowCaster(box);
        // Buildings stay visible under fog of war — permanent terrain, not
        // tactical info. See `_setTileFogged`.
        box.metadata   = { respectsFog: false };
        trackProp(box);

        // Tiny roof block to add silhouette variety. Sits flush on top of the box.
        const roof = BABYLON.MeshBuilder.CreateBox(
          `roof_${tile.col}_${tile.row}`,
          { width: dims.roof.width, height: dims.roof.height, depth: dims.roof.depth },
          scene,
        );
        roof.parent     = parent;
        roof.position.x = x + slot.x;
        roof.position.z = z + slot.z;
        roof.position.y = tileTopY + dims.box.height + dims.roof.height / 2;
        roof.material   = this._materialFor('#2c2520');
        roof.isPickable = false;
        this._addShadowCaster(roof);
        roof.metadata   = { respectsFog: false };
        trackProp(roof);
      }

      // Hover label — floating billboarded plane above the roof, painted with
      // the building's display name. Alpha is driven each frame by
      // `_pumpBuildingLabelFade` so labels fade as the camera zooms back.
      this._buildBuildingLabel(tile, x, z, parent);
    }

    if (props.length > 0) this._tilePropsByKey.set(tkey, props);

    // Register this tile's static occupants (building + forest trees) so the
    // per-draw standee re-slot pass knows which slots are already consumed.
    // With the layered tile model a building and a forest base CAN coexist on
    // one tile (a building on forest), so the occupants are additive rather
    // than mutually exclusive.
    const staticOcc = [];
    if (hasBuilding(tile) && tile.building) {
      staticOcc.push({ id: 'building', kind: 'building' });
    }
    if (baseOf(tile) === TileType.FOREST) {
      // Match the rendered cluster: the building occupant is added separately
      // above, so only blockedSlots (road deck) need to be re-applied here so a
      // tree dropped from the deck isn't listed as a phantom occupant.
      const trees = forestTreesForHex(tile.col, tile.row, this._season, {
        blockedSlots: this._roadBlockedSlotsByKey.get(tkey),
      });
      for (const t of trees) staticOcc.push({ id: t.id, kind: 'tree' });
    }
    if (staticOcc.length > 0) this._staticOccupantsByKey.set(tkey, staticOcc);
  }

  // ─── Item 2: bezier road + river networks ────────────────────────────────
  //
  // Build two merged ribbon meshes — one for the river, one for the road —
  // overlaying the grass-coloured tile cylinders. Geometry comes from the
  // pure helpers `buildRiverNetworkStrokes` / `buildRoadNetworkStrokes`,
  // which mirror the 2D renderer's per-tile bezier construction. Each tile
  // contributes one through-bezier (optionally plus straight spokes at
  // junctions). Each bezier sample is widened perpendicular-in-XZ into a
  // flat ribbon strip (CreateRibbon), so the network reads as a painted
  // path on the terrain rather than a raised tube. Per-tile ribbons are
  // merged with Mesh.MergeMeshes so the GPU sees ONE draw call per network
  // regardless of map size.
  _buildRoadRiverNetworks() {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!BABYLON || !scene || !this.state?.tiles) return;

    const riverStrokes = buildRiverNetworkStrokes(this.state.tiles);
    const roadStrokes  = buildRoadNetworkStrokes(this.state.tiles);

    if (riverStrokes.length > 0) {
      this._riverNetworkMesh = this._buildNetworkMesh(
        'river', riverStrokes, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y,
        TILE_COLOR[TileType.RIVER],
      );
    }
    if (roadStrokes.length > 0) {
      this._roadNetworkMesh = this._buildNetworkMesh(
        'road', roadStrokes, ROAD_RIBBON_WIDTH, ROAD_RIBBON_Y,
        TILE_COLOR[TileType.ROAD],
      );
    }
  }

  /** Build a single merged flat-ribbon mesh for one network (river OR road).
   *  Each stroke becomes one CreateRibbon call from a pair of parallel paths
   *  offset ±width/2 perpendicular to the local tangent in the XZ plane, at a
   *  constant Y. MergeMeshes collapses them all into one mesh sharing one
   *  material. Returns the merged mesh (or null if MergeMeshes refused —
   *  which happens when the source list is empty).
   *
   *  Path order is `[rightV3, leftV3]`, NOT `[leftV3, rightV3]`. This is
   *  load-bearing: CreateRibbon's first-triangle winding is
   *  `(pathArray[0][i], pathArray[1][i], pathArray[0][i+1])`, and for a path
   *  travelling along +X (tangent +X, perpendicular +Z), that triangle's
   *  normal works out to +Y only when path 0 is on the −Z side (right) and
   *  path 1 is on the +Z side (left). Reverse the order and the normal flips
   *  to −Y, leaving the +Y hemispheric light hitting the underside while
   *  camera-visible top face renders near-black. PR #322's original ordering
   *  fell into that pit; PR #323 papered over the symptom with an emissive
   *  bump that was still far too small for the dark river/road base colours.
   *  See `ribbonFaceNormal()` below for the math, and the
   *  `renderer-3d-ribbon-normals.test.js` suite that pins this contract. */
  _buildNetworkMesh(networkName, segments, width, yPos, cssColor) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!segments || segments.length === 0) return null;
    // Per-tile ribbons accumulator so each tile's section can be registered
    // with the fog veil — fogged tiles darken the ribbon material in place
    // rather than hiding it. Built outside any individual tile's prop array
    // because the network spans many tiles and is built after `_buildTileMesh`.
    const ribbonsByTileKey = new Map();      // tkey → mesh[]
    const ribbons = [];
    for (let s = 0; s < segments.length; s++) {
      const { tile, strokes } = segments[s];
      const tkey = hexKey(tile.col, tile.row);
      // A road laid through a FOREST-base tile renders 20% narrower so the
      // flanking trees aren't crowded. Width is decided PER TILE: each tile
      // contributes its own stroke(s), so a road spanning a forest tile and a
      // grass tile narrows only on the forest half — the two strokes meet at
      // the shared edge midpoint with a small width step (both centred on the
      // same centreline, so the narrow forest deck sits flush inside the wider
      // grass deck — no lateral gap). Per-tile is simpler than a taper and the
      // alpha-faded ribbon edges hide the seam. River never narrows.
      const tileWidth = roadTileRibbonWidth(networkName, tile, width);
      for (let i = 0; i < strokes.length; i++) {
        const pts = strokes[i];
        if (!pts || pts.length < 2) continue;
        // Five-path ribbon so the alpha fade only affects the outer 10% of
        // the ribbon width on each side. Paths laid out as:
        //   right edge (alpha 0) → right inner (alpha 1) → centre (alpha 1)
        //     → left inner (alpha 1) → left edge (alpha 0)
        // Inner paths sit at 0.80 × half-width from the centreline, so the
        // opaque region covers the inner 80% of the ribbon and the outer 10%
        // on each side fades smoothly into the grass beneath.
        const OPAQUE_FRAC   = 0.80;
        // Road + river get a smooth ±15% per-point width modulation along
        // their length so each strand reads as hand-laid / natural rather
        // than uniform-machined. The sine wave is seeded off the tile col/row
        // + stroke index so a given hex looks the same across reloads.
        let perPointOuterWidth = tileWidth;
        let perPointInnerWidth = tileWidth * OPAQUE_FRAC;
        if (networkName === 'road' || networkName === 'river') {
          // Width modulates as a function of WORLD position so adjacent tiles
          // produce the SAME width at shared seam points — no visible width
          // jump where one tile's stroke ends and the next begins. The 2D
          // sine field uses a wavelength of WIDTH_NOISE_WAVELENGTH world
          // units (~5 hexes) — long enough that neighbour points within a
          // single stroke (≤0.2 wu apart) see ≤1% width delta, well under
          // operator's 5% inter-vertex cap. Peak-to-peak swing is 15%
          // (amp 0.075 → range [0.925, 1.075]).
          const WIDTH_NOISE_WAVELENGTH = 8.0;
          const amp = 0.075;
          const widthModAt = (x, z) => {
            const u = (x / WIDTH_NOISE_WAVELENGTH + z / WIDTH_NOISE_WAVELENGTH * 0.7) * Math.PI * 2;
            return 1 + amp * Math.sin(u);
          };
          const outerArr = new Array(pts.length);
          const innerArr = new Array(pts.length);
          for (let p = 0; p < pts.length; p++) {
            const mod = widthModAt(pts[p].x, pts[p].z);
            outerArr[p] = tileWidth * mod;
            innerArr[p] = tileWidth * OPAQUE_FRAC * mod;
          }
          perPointOuterWidth = outerArr;
          perPointInnerWidth = innerArr;
        }
        const { left: outerLeft,  right: outerRight  } = ribbonOffsetPaths(pts, perPointOuterWidth);
        const { left: innerLeft,  right: innerRight  } = ribbonOffsetPaths(pts, perPointInnerWidth);
        const toV3 = (arr) => arr.map(p => new BABYLON.Vector3(p.x, yPos, p.z));
        const rightOuterV3 = toV3(outerRight);
        const rightInnerV3 = toV3(innerRight);
        const centerV3     = toV3(pts);
        const leftInnerV3  = toV3(innerLeft);
        const leftOuterV3  = toV3(outerLeft);
        const ribbon = BABYLON.MeshBuilder.CreateRibbon(
          `${networkName}_${tile.col}_${tile.row}_${i}`,
          {
            pathArray: [rightOuterV3, rightInnerV3, centerV3, leftInnerV3, leftOuterV3],
            sideOrientation: BABYLON.Mesh.DOUBLESIDE,
            closeArray: false,
            closePath: false,
            updatable: false,
          },
          scene,
        );
        ribbon.isPickable = false;
        // Per-vertex alpha keyed off path index (5 paths, N points each).
        const totalVerts = ribbon.getTotalVertices();
        const N = pts.length;
        const alphaByPath = [0.0, 1.0, 1.0, 1.0, 0.0];
        const colors = new Float32Array(totalVerts * 4);
        for (let v = 0; v < totalVerts; v++) {
          const pathIdx = Math.min(alphaByPath.length - 1, Math.floor(v / N));
          const a = alphaByPath[pathIdx];
          colors[v * 4 + 0] = 1;
          colors[v * 4 + 1] = 1;
          colors[v * 4 + 2] = 1;
          colors[v * 4 + 3] = a;
        }
        ribbon.setVerticesData(BABYLON.VertexBuffer.ColorKind, colors);
        // Per-vertex UVs. Texture tiles along U (length) and spans V across
        // the ribbon width. Path index → V coordinate; cumulative XZ distance
        // along the centreline → U coordinate (scaled by ROAD_TILE_PERIOD so
        // the texture repeats every ~1 world unit, roughly hex-sized).
        if (networkName === 'road' || networkName === 'river') {
          const uvs = new Float32Array(totalVerts * 2);
          // V for each of the 5 paths. The OPAQUE band (inner-right → centre
          // → inner-left) samples the texture's middle 40% (V 0.3–0.7) where
          // the road artwork sits; the alpha-faded OUTER paths sample the
          // texture's V edges (0 / 1) where the artist's dark/transparent
          // shoulder lives. Previously this mapped inner paths to V=0 / V=1,
          // which sampled the texture's dark edges and produced a black
          // border around the road. Tightening the V window keeps the road
          // bulk on the texture's road-colored region.
          const vByPath = [0.0, 0.3, 0.5, 0.7, 1.0];
          // U along the centreline (path index 2 = centre). All five paths
          // share the same U at each point index so vertices stay seam-aligned
          // across the width.
          const periods = new Array(N);
          periods[0] = 0;
          for (let p = 1; p < N; p++) {
            const dx = pts[p].x - pts[p - 1].x;
            const dz = pts[p].z - pts[p - 1].z;
            periods[p] = periods[p - 1] + Math.sqrt(dx * dx + dz * dz);
          }
          const ROAD_TILE_PERIOD = 1.0; // world units per texture tile
          for (let v = 0; v < totalVerts; v++) {
            const pathIdx  = Math.min(vByPath.length - 1, Math.floor(v / N));
            const pointIdx = v % N;
            uvs[v * 2 + 0] = periods[pointIdx] / ROAD_TILE_PERIOD;
            uvs[v * 2 + 1] = vByPath[pathIdx];
          }
          ribbon.setVerticesData(BABYLON.VertexBuffer.UVKind, uvs);
          // Force flat +Y normals on every vertex. The ribbon is built at a
          // constant Y so its true surface normal IS (0,1,0) everywhere —
          // but CreateRibbon with DOUBLESIDE generates tangent-space normals
          // via path-direction cross products which can drift off-axis along
          // curves. backFaceCulling stays false on the material so the back
          // face still draws on edge views, just with the wrong normal.
          // Guarded by getVerticesData existence so test stubs without that
          // method don't throw.
          if (typeof ribbon.getVerticesData === 'function') {
            const pos = ribbon.getVerticesData(BABYLON.VertexBuffer.PositionKind);
            if (pos) {
              const vcount = pos.length / 3;
              const flatNormals = new Float32Array(vcount * 3);
              for (let v = 0; v < vcount; v++) {
                flatNormals[v * 3 + 0] = 0;
                flatNormals[v * 3 + 1] = 1;
                flatNormals[v * 3 + 2] = 0;
              }
              ribbon.setVerticesData(BABYLON.VertexBuffer.NormalKind, flatNormals);
            }
          }
        }
        ribbons.push(ribbon);
        const list = ribbonsByTileKey.get(tkey) || [];
        list.push(ribbon);
        ribbonsByTileKey.set(tkey, list);
      }
    }
    if (ribbons.length === 0) return null;
    // Merge PER-TILE so each tile's ribbon section can be registered with the
    // fog veil and darkened in place (operator: "roads and rivers need to
    // darken in fog of war"). Each per-tile mesh gets its OWN material clone
    // so `_setTileFogged` can multiply diffuseColor + emissiveColor by
    // FOG_TILE_DARKEN without affecting the other tiles. Memory cost is
    // bounded (~50 materials for a standard map) and avoids per-vertex
    // color buffer rewrites on fog state change.
    const baseMat  = this._buildRibbonMaterial(networkName, cssColor);
    const baseDiff = baseMat.diffuseColor.clone();
    const baseEmis = baseMat.emissiveColor.clone();
    let primary = null;
    for (const [tkey, list] of ribbonsByTileKey) {
      const merged = BABYLON.Mesh.MergeMeshes(list, true, true, undefined, false, false);
      if (!merged) continue;
      // Set receiveShadows FIRST, immediately post-merge. `MergeMeshes` creates
      // a fresh mesh whose `receiveShadows` defaults to false — the source
      // ribbons' flag is NOT copied — so this MUST happen on the merged result.
      // Doing it before any other configuration keeps the dependency
      // unambiguous: nothing between the merge and the receiver flag can
      // accidentally reset it.
      this._setShadowReceiver(merged);
      merged.parent          = this._mapRoot;
      merged.isPickable      = false;
      // Per-tile material clone — only diffuse/emissive Color3s differ between
      // clones, all other state copied from the shared base material.
      const mat = baseMat.clone(`${networkName}_${tkey}_mat`);
      mat.diffuseColor  = baseDiff.clone();
      mat.emissiveColor = baseEmis.clone();
      merged.material        = mat;
      merged.hasVertexAlpha  = true;
      // Force road > river in the transparency sort so the road ribbon paints
      // OVER the water at every river / road crossing (bridge planks are
      // disabled — `_renderBridges = false`). Within renderingGroupId 0,
      // Babylon's transparent pass sorts by `alphaIndex` ascending before
      // falling back to distance-to-camera, so this pins ordering even when
      // the per-mesh distance sort would otherwise flip on a low camera angle.
      merged.alphaIndex      = networkName === 'road' ? ROAD_ALPHA_INDEX : RIVER_ALPHA_INDEX;
      merged.name            = `${networkName}_${tkey}`;
      // Tag for fog darkening (not hiding). `_setTileFogged` consults this and
      // stashes the unfogged anchor colours on the metadata so they can be
      // restored when fog clears (avoids accumulating darken multipliers).
      merged.metadata        = {
        respectsFog: 'darken',
        kind: networkName,
        baseDiffuse:  { r: baseDiff.r, g: baseDiff.g, b: baseDiff.b },
        baseEmissive: { r: baseEmis.r, g: baseEmis.g, b: baseEmis.b },
      };
      // Register with the per-tile prop list so fog veil walks it.
      const props = this._tilePropsByKey.get(tkey);
      if (props) props.push(merged);
      else this._tilePropsByKey.set(tkey, [merged]);
      if (!primary) primary = merged;
    }
    return primary;
  }

  /** Dedicated StandardMaterial for the ribbon networks. Unlike the cached
   *  `_materialFor()` (used by tile cylinders), this one carries an
   *  `emissiveColor` so the strip stays readable regardless of phase tinting.
   *
   *  Path order in `_buildNetworkMesh` is now `[right, left]` so face normals
   *  point +Y (the camera-visible side), and the +Y hemispheric light hits the
   *  top face directly. That alone would be enough for grass-coloured ribbons,
   *  but the road/river TILE_COLORs are genuinely dark — `#1a3d5c` (river,
   *  ≈ 10/60/92 in 0–255) reads at roughly RGB(0.10, 0.24, 0.36) under full
   *  white light, and night phase recolours the hemi to a cool blue that
   *  starves the brown road's red channel further. The emissive layer
   *  (`RIBBON_EMISSIVE_SCALE × diffuse`) is bumped from PR #323's 0.15 to a
   *  larger value so the strip stays legible against the brighter terrain
   *  even when phase lighting cools off, without making it self-glow like a
   *  power-node disc. Kept out of the shared cache so this emissive doesn't
   *  bleed onto road/river tile cylinders or building boxes. */
  _buildRibbonMaterial(networkName, hexColor) {
    const BABYLON = this._babylon;
    const { diffuse, emissive } = ribbonMaterialColors(hexColor);
    const mat = new BABYLON.StandardMaterial(`${networkName}_ribbon_mat`, this._scene);
    mat.diffuseColor    = new BABYLON.Color3(diffuse[0],  diffuse[1],  diffuse[2]);
    // Drop emissive to zero for ROAD and RIVER so shadows actually read on
    // them. Emissive is self-lit and washes out the directional sun's shadow
    // contribution. The cure for the "ribbon reads near-black under direct
    // sun" symptom is a textured diffuse (below), not an emissive boost.
    if (networkName === 'road' || networkName === 'river') {
      mat.emissiveColor = new BABYLON.Color3(0, 0, 0);
    } else {
      mat.emissiveColor = new BABYLON.Color3(emissive[0], emissive[1], emissive[2]);
    }
    mat.specularColor   = new BABYLON.Color3(0.04, 0.04, 0.04); // matte
    mat.backFaceCulling = false; // belt-and-braces for low/below camera angles
    // Honour the per-vertex alpha written in `_buildNetworkMesh` so the road
    // / river ribbon fades smoothly into the underlying grass at its lateral
    // edges instead of cutting hard. needAlphaBlendingForMesh inherits from
    // mesh.hasVertexAlpha, which the merged ribbon mesh sets.
    mat.disableLighting = false;
    // Road gets a tiled diffuse texture so shadow detail reads against the
    // road surface (not just the flat coloured ribbon). The texture is
    // 1024×1024 and tileable left-to-right; UVs are written per-vertex in
    // `_buildNetworkMesh` so the texture U-axis runs along the ribbon's
    // length and V across its width. Loaded with explicit success callback —
    // if the load FAILS, we leave the original coloured diffuse alone (no
    // black ribbon when the path 404s).
    if ((networkName === 'road' || networkName === 'river') && this._scene && typeof BABYLON.Texture === 'function') {
      try {
        const fileName = networkName === 'road' ? 'road-ribbon.png' : 'river-ribbon.png';
        const url = `${this._assetsBasePath || 'assets'}/${fileName}`;
        // 2-arg constructor only — anything more positional has broken with
        // Babylon 7.x's minified signature. Use numeric wrap mode constants
        // directly (BABYLON.Texture.WRAP_ADDRESSMODE may live on a different
        // namespace in some builds).
        const tex = new BABYLON.Texture(url, this._scene);
        tex.wrapU = 1; // WRAP
        tex.wrapV = 0; // CLAMP
        tex.hasAlpha = true;
        mat.diffuseTexture = tex;
        // road-ribbon.png is 21% alpha=0 / 78% opaque — designed with
        // transparent cut-outs for the road shoulder. Without this flag
        // Babylon ignores the texture's alpha and renders the cut-out
        // pixels as their RGB (≈ black), producing dark borders + dark
        // gaps. Combined with per-vertex alpha (path edges) the final
        // alpha = vertAlpha × texAlpha, so the road feathered edges still
        // fade smoothly AND the texture's intended holes stay see-through.
        mat.useAlphaFromDiffuseTexture = true;
        // White diffuse so the texture passes through at full strength.
        mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
      } catch (err) {
        console.warn(`[Renderer3D] ${networkName}-ribbon texture setup failed:`, err);
      }
    }
    return mat;
  }

  /** Diagnostic: dump the runtime material state of the road and river
   *  ribbon meshes. Intended for the operator/QA to call from the browser
   *  console when the network reads wrong, so we can confirm at a glance
   *  whether the right material is on the right mesh. Exposed via the
   *  `window.__brimstone3dDebug` handle in `_initBabylon`. */
  dumpRibbonDebug() {
    const summarise = (mesh) => {
      if (!mesh) return { mesh: null };
      const mat = mesh.material;
      const summariseColor = (c) => c ? { r: +c.r.toFixed(3), g: +c.g.toFixed(3), b: +c.b.toFixed(3) } : null;
      return {
        meshName: mesh.name,
        isEnabled: mesh.isEnabled?.() ?? true,
        isVisible: mesh.isVisible !== false,
        position: { x: +mesh.position.x.toFixed(3), y: +mesh.position.y.toFixed(3), z: +mesh.position.z.toFixed(3) },
        material: mat ? {
          name: mat.name,
          klass: mat.getClassName ? mat.getClassName() : (mat.constructor?.name ?? '?'),
          diffuse:  summariseColor(mat.diffuseColor),
          emissive: summariseColor(mat.emissiveColor),
          ambient:  summariseColor(mat.ambientColor),
          specular: summariseColor(mat.specularColor),
          backFaceCulling: mat.backFaceCulling,
          disableLighting: mat.disableLighting,
          alpha: mat.alpha,
          sideOrientation: mat.sideOrientation,
        } : null,
        hasVertexColors: !!mesh.getVerticesData?.('color'),
        normalsSample: mesh.getVerticesData?.('normal')?.slice?.(0, 6) ?? null,
      };
    };
    const light = this._light;
    const summariseColor = (c) => c ? { r: +c.r.toFixed(3), g: +c.g.toFixed(3), b: +c.b.toFixed(3) } : null;
    const dump = {
      river: summarise(this._riverNetworkMesh),
      road:  summarise(this._roadNetworkMesh),
      light: light ? {
        klass: light.getClassName ? light.getClassName() : '?',
        intensity: light.intensity,
        direction: light.direction ? { x: +light.direction.x.toFixed(3), y: +light.direction.y.toFixed(3), z: +light.direction.z.toFixed(3) } : null,
        diffuse: summariseColor(light.diffuse),
        groundColor: summariseColor(light.groundColor),
        specular: summariseColor(light.specular),
      } : null,
    };
    // eslint-disable-next-line no-console
    console.log('[brimstone3d] ribbon debug', dump);
    return dump;
  }

  /** Cache a StandardMaterial per CSS hex colour so we hand a few materials
   *  to the GPU regardless of tile count. */
  _materialFor(hexColor) {
    if (this._materialCache.has(hexColor)) return this._materialCache.get(hexColor);
    const BABYLON = this._babylon;
    const [r, g, b] = cssHexToRgb01(hexColor);
    const mat = new BABYLON.StandardMaterial(`mat_${hexColor}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(r, g, b);
    mat.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04); // matte
    this._materialCache.set(hexColor, mat);
    return mat;
  }

  /** Flag a material for standard alpha-blending at `alpha`, plus a per-mesh
   *  depth pre-pass — the same recipe `_alphaMaterialFor` /
   *  `_borderGroundMaterialFor` apply, factored out so the faded GLB tree
   *  template can fade BOTH its MultiMaterial container AND each PBR
   *  submaterial identically (ground, trees, and river all blend + sort the
   *  same way). Mutates `mat` in place — callers pass a CLONE so shared opaque
   *  materials are never touched. */
  _applyAlphaBlend(mat, alpha) {
    if (!mat) return mat;
    const BABYLON = this._babylon;
    mat.alpha = alpha;
    if (BABYLON?.Material) mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    mat.needDepthPrePass = true;
    return mat;
  }

  /** Like `_materialFor`, but returns a translucent variant at `alpha` < 1 with
   *  standard alpha-blending enabled. Cached separately (keyed `color@a<alpha>`)
   *  so the opaque shared materials used by the in-map forest are never mutated.
   *  Returns the plain opaque material when `alpha` ≥ 1. Used by the
   *  border-forest edge fade — see `borderForestAlphaForTile`. */
  _alphaMaterialFor(hexColor, alpha) {
    if (!(alpha < 1)) return this._materialFor(hexColor);
    const BABYLON = this._babylon;
    const key = `${hexColor}@a${alpha}`;
    if (this._materialCache.has(key)) return this._materialCache.get(key);
    const base = this._materialFor(hexColor);
    const mat = typeof base.clone === 'function' ? base.clone(`mat_${key}`) : base;
    mat.alpha = alpha;
    // Standard alpha blending. A per-mesh depth pre-pass writes depth first so
    // overlapping translucent foliage within a tier sorts sanely instead of
    // flickering, and keeps backface culling honest (no double-blended cone
    // backsides). Inner tiers are more opaque and sit behind the outer ones, so
    // back-to-front transparent sorting across tiers reads correctly.
    if (BABYLON?.Material) mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    mat.needDepthPrePass = true;
    this._materialCache.set(key, mat);
    return mat;
  }

  /** Material for a border-forest GROUND hex at edge-fade `alpha`. The band's
   *  ground dissolves in lockstep with its trees — same per-ring alpha from
   *  `borderForestAlphaForTile` — so the whole map edge reads as one fading
   *  layer (operator: fade the ground, not just the trees).
   *
   *  The base is the SHARED fogged terrain material for the tile's sprite
   *  (border ground always renders fogged), or the colour-fog fallback when
   *  the atlas hasn't loaded. At `alpha` ≥ 1 that shared material is returned
   *  as-is. At `alpha` < 1 a translucent CLONE is returned instead — bucketed
   *  per (base material, alpha) tier in a dedicated cache so the playable
   *  map's terrain materials are never mutated and the clone count stays
   *  bounded (≤ sprite-variants × 3 tiers). Alpha-blend + depth pre-pass match
   *  the tree fade (`_alphaMaterialFor`) so ground and trees sort together. */
  _borderGroundMaterialFor(spriteId, baseColor, alpha) {
    const base = this._terrainMaterialFor(spriteId, { fogged: true })
              || this._fogMaterialFor(baseColor);
    if (!base || !(alpha < 1)) return base;
    const BABYLON = this._babylon;
    const key = `${base.name}@a${alpha}`;
    if (this._borderGroundAlphaMatCache.has(key)) return this._borderGroundAlphaMatCache.get(key);
    const mat = typeof base.clone === 'function' ? base.clone(`mat_${key}`) : base;
    mat.alpha = alpha;
    // Standard alpha blending + per-mesh depth pre-pass — identical recipe to
    // `_alphaMaterialFor` (the tree fade) so a ring's ground and trees blend
    // and sort as a single translucent layer instead of z-fighting.
    if (BABYLON?.Material) mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    mat.needDepthPrePass = true;
    this._borderGroundAlphaMatCache.set(key, mat);
    return mat;
  }

  // ─── Tile top-face textures ──────────────────────────────────────────────
  //
  // Asset layout (mirrors src/renderer.js):
  //   • single texture atlas at assets/tilemap.png (≈7 MB), pre-loaded by
  //     loadImages() into `this._tilemapImg` + `this._spriteRects`.
  //   • terrain sprites in the atlas: grass_1..5, forest_1..5, dirt_1..5,
  //     plus single-variant road / river / bridge.
  //   • per-tile variant is picked by terrainSpriteIdFor(tile, col, row),
  //     a pure function that re-uses the 2D renderer's hash so the same
  //     hex always picks the same sprite across sessions.
  //
  // Which terrains get a texture vs which fall back to solid colour:
  //   GRASS, DIRT, FOREST, BUILDING (uses dirt base) → textured top face.
  //   ROAD, RIVER, BRIDGE → solid colour. They already carry their own
  //   prop meshes (road deck, bridge plank) and a coloured river surface;
  //   layering a grass underlay would muddle that signal.
  //
  // Geometry choice: option (b) from the brief — a flat hexagonal disc on
  // top of the unchanged colour cylinder. Default disc UVs map the sprite
  // into the inscribed circle of the unit square, which covers a regular
  // hex without distortion. Disc lives in the prop array so the fog veil
  // hides it on out-of-sight tiles (the dim colour cylinder then reads as
  // "fogged terrain") and the solid colour cylinder underneath supplies
  // the side walls so the prism still looks thick.

  /** Cached `BABYLON.Texture` for a single terrain sprite id, cropped out
   *  of the shared tilemap into an offscreen canvas. Returns null when the
   *  tilemap hasn't loaded, the sprite id isn't in the rect map, or we're
   *  in a non-DOM environment (node-test). */
  _terrainTextureFor(spriteId) {
    if (!spriteId || !this._tilemapImg || !this._spriteRects) return null;
    if (this._terrainTextureCache.has(spriteId)) return this._terrainTextureCache.get(spriteId);
    const rect = this._spriteRects.get(spriteId);
    if (!rect) {
      if (!this._textureWarnedFor.has(spriteId)) {
        this._textureWarnedFor.add(spriteId);
        console.warn(`[Renderer3D] no atlas rect for terrain sprite '${spriteId}', falling back to solid colour`);
      }
      return null;
    }
    if (typeof document === 'undefined') return null;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      c.getContext('2d').drawImage(
        this._tilemapImg,
        rect.x, rect.y, rect.size, rect.size,
        0, 0, c.width, c.height,
      );
      const BABYLON = this._babylon;
      // Babylon defaults: noMipmap=false, invertY=true. The initial PR shipped
      // `true, false` (noMipmap + invertY=false) — the same anti-pattern the
      // portrait code hit and reverted in 0a2f8007, whose comment notes the
      // V-flip rendered the back face of the plane, hiding the textured face
      // behind backFaceCulling. The disc here is the same situation: front
      // face has normal +Y after rotation.x=-π/2; with invertY=false the
      // texture is sampled as if mapped onto the back face, leaving the
      // visible +Y face untextured (it shows the StandardMaterial's default
      // white diffuse against a culled back — operator-visible symptom: every
      // hex appears as the bare coloured cylinder with no terrain sprite on
      // top). Use defaults — match `_portraitTextureFor`.
      const tex = new BABYLON.Texture(c.toDataURL(), this._scene);
      this._terrainTextureCache.set(spriteId, tex);
      return tex;
    } catch (err) {
      if (!this._textureWarnedFor.has(spriteId)) {
        this._textureWarnedFor.add(spriteId);
        console.warn(`[Renderer3D] failed to build terrain texture '${spriteId}':`, err);
      }
      return null;
    }
  }

  /** Cached textured StandardMaterial for one terrain sprite id. Returns null
   *  if the texture isn't available — callers fall back to the solid-colour
   *  material returned by `_materialFor` for the tile's colour.
   *
   *  `fogged: true` returns a darkened variant (diffuseColor multiplies the
   *  texture) for use under fog of war. Two separate cache entries per sprite
   *  so the bright and dark forms can coexist without mutation. */
  _terrainMaterialFor(spriteId, { fogged = false } = {}) {
    if (!spriteId) return null;
    const cache = fogged ? this._terrainFogMaterialCache : this._terrainMaterialCache;
    if (cache.has(spriteId)) return cache.get(spriteId);
    const tex = this._terrainTextureFor(spriteId);
    if (!tex) return null;
    const BABYLON = this._babylon;
    const name = fogged ? `terrainFog_${spriteId}` : `terrain_${spriteId}`;
    const mat = new BABYLON.StandardMaterial(name, this._scene);
    mat.diffuseTexture = tex;
    mat.specularColor  = new BABYLON.Color3(0.04, 0.04, 0.04); // matte, picks up phase light
    if (fogged) {
      const d = this._fogTileDarken;
      mat.diffuseColor = new BABYLON.Color3(d, d, d);
    }
    cache.set(spriteId, mat);
    return mat;
  }

  /** Pick the right material for a tile cylinder — textured terrain material
   *  when the sprite + atlas are available, otherwise the solid-colour base
   *  material. Called by `_buildTileMesh` at construction time and by
   *  `_upgradeTileTextures` when the atlas finishes loading after init. */
  _tileMaterialFor(tile, { fogged = false } = {}) {
    const spriteId = terrainSpriteIdFor(tile, tile.col, tile.row);
    const terrainMat = spriteId ? this._terrainMaterialFor(spriteId, { fogged }) : null;
    if (terrainMat) return terrainMat;
    const baseColor = tileColorFor(tile);
    return fogged ? this._fogMaterialFor(baseColor) : this._materialFor(baseColor);
  }

  /** Build a flat, pointy-top hexagonal tile mesh at world (x, z), lying in the
   *  XZ plane at Y=0. One face only — no side walls — so adjacent hexes tile
   *  tightly with no z-fight at the seams and no cylinder-rim artefacts. UVs
   *  are written directly to map the terrain texture across the hex's bounding
   *  box (with a small inset so the atlas-sprite gutter pixels are never
   *  sampled). Triangulated as a fan from the centre vertex out to six rim
   *  vertices at 30°, 90°, 150°, 210°, 270°, 330°. */
  /** Build a board-game-style token body: a cone (tapered cylinder) with a
   *  spherical head on top. Both meshes share the same player-colour material
   *  and the sphere is parented to the cone so the pair moves as a unit. The
   *  cone is the picking target (carries the entity metadata); the sphere is
   *  marked non-pickable and inherits visibility through Babylon's parent
   *  chain, so fog-of-war's `setEnabled(false)` on the cone hides both.
   *
   *  Local origin sits at the cone's centre — bottom rim at -h/2, sphere
   *  centre at +h/2 + sphereDiameter/2. The caller positions the cone's world
   *  Y so the bottom rim rests on the base disc. */
  _buildTokenBody(name, opts) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    const {
      coneHeight, coneDiameterBottom, coneDiameterTop, sphereDiameter,
    } = opts;
    const cone = BABYLON.MeshBuilder.CreateCylinder(name, {
      tessellation: 24,
      height:        coneHeight,
      diameterBottom: coneDiameterBottom,
      diameterTop:    coneDiameterTop,
    }, scene);
    const sphere = BABYLON.MeshBuilder.CreateSphere(`${name}_head`, {
      segments: 12,
      diameter: sphereDiameter,
    }, scene);
    sphere.parent = cone;
    sphere.isPickable = false;
    // Sphere centre rests just above the cone's flat top (tiny overlap so the
    // junction doesn't show a hairline crack at oblique angles).
    sphere.position.set(0, (coneHeight / 2) + (sphereDiameter / 2) - 0.01, 0);
    cone.metadata = { _coneHeight: coneHeight, _sphereDiameter: sphereDiameter };
    return { cone, sphere };
  }

  /** Build pine trees for a forest hex: one merged TRUNK mesh + one merged
   *  LEAF mesh covering every tree at the given positions, parented at world
   *  (cx, cz). Trees are translated by their `t.x/z` offsets and uniformly
   *  scaled by `t.scale`. Returning 2 meshes per tile (instead of 4 per tree)
   *  is the bulk of the task-9 fps fix — forest-heavy maps were emitting
   *  hundreds of draw calls before this. */
  /** True if the world-XZ point (tx, tz) lies inside any precomputed river-
   *  extension corridor (built at the top of `_buildMapBorderForest`). Used
   *  to skip border-forest trees that would visually stand in the water. */
  _borderTreeBlockedByRiver(tx, tz) {
    const list = this._riverExtensionCorridors;
    if (!list || list.length === 0) return false;
    for (const c of list) {
      const dx = tx - c.px;
      const dz = tz - c.pz;
      const along = dx * c.tx + dz * c.tz;            // distance along the river axis
      if (along < -0.30 || along > c.length) continue; // outside the extension's length
      const perp = Math.abs(dx * (-c.tz) + dz * c.tx); // perpendicular distance
      if (perp <= c.half) return true;
    }
    return false;
  }

  /** Build merged trunk + leaf meshes for one hex's forest cluster.
   *
   *  Trees come from `forestTreesForHex` / `borderForestTreesForHex` and
   *  carry a `species` ('pine' | 'oak' | 'spruce') and a `shadeIdx` (which
   *  picks the leaf-colour shade from the species palette). Three silhouettes
   *  are emitted:
   *
   *    pine   — tapered 3-tier cone stack (original spruce-y conifer look).
   *    oak    — tall narrow trunk topped with a sphere-shaped foliage crown.
   *    spruce — slim 4-tier cone stack, taller and narrower than pine.
   *
   *  Trunks share one material (they're all the same brown). Leaves get one
   *  merged mesh per distinct (species, shadeIdx) colour bucket — bounded at
   *  TREE_SPECIES.length × TREE_LEAF_SHADES_PER_SPECIES = 9 worst-case, but
   *  ≤ 5 in practice since a hex carries at most 5 trees. */
  _buildPineTreeBatchedMeshes(namePrefix, parent, cx, cz, trees, { fogged = false, season = null } = {}) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!BABYLON || !scene || !trees || trees.length === 0) return [];
    const { trunks, leavesByColor } = this._buildTreeClusterMeshes(
      namePrefix, cx, cz, trees, { fogged, season },
    );
    const trunkCss = fogged ? '#241710' : '#5a3a20';
    const trunkMat = this._materialFor(trunkCss);
    return this._mergeTreeBuckets(trunks, leavesByColor, parent, namePrefix, trunkMat);
  }

  /** Build a tree cluster as raw (unmerged) trunk + leaf meshes at world
   *  (cx, cz). Returns the geometry ready for the caller to merge at whatever
   *  scope makes sense — per-tile for interior forest tiles (see
   *  `_buildPineTreeBatchedMeshes`), or once across an entire band for the
   *  map-border forest (see `_buildBorderForestTreesBatched`). Extracting the
   *  inner geometry build out of `_buildPineTreeBatchedMeshes` is what lets
   *  the border-forest collapse from ~240–900 draw calls to ~10 — the merge
   *  level moves up, the per-tree geometry stays identical.
   *
   *  Trunks share one colour and are returned as a flat array. Leaves are
   *  bucketed by their leaf-colour CSS key so each (species, shadeIdx) pair
   *  can be merged into a single mesh — bounded at TREE_SPECIES.length ×
   *  TREE_LEAF_SHADES_PER_SPECIES = 9 colour keys (per fog variant). */
  _buildTreeClusterMeshes(namePrefix, cx, cz, trees, { fogged = false, season = null } = {}) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    const trunks = [];
    const leavesByColor = new Map();
    if (!BABYLON || !scene || !trees || trees.length === 0) {
      return { trunks, leavesByColor };
    }
    const isWinter = season === 'winter';
    // Deterministic per-tree hash for the rotation + scale jitter — derived
    // from world (tx, tz) so the same hex always shows the same tree
    // arrangement across sessions. Output ∈ [0, 1).
    const jitter = (k) => {
      const v = Math.sin(k * 12.9898) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const tx = cx + t.x;
      const tz = cz + t.z;
      // Random Y rotation 0..2π and random scale 0.8..1.2 multiplier on top
      // of the existing per-tree scale, so the merged mesh shows visible
      // variety despite all trees coming from the same source geometry.
      const rotKey   = jitter(tx * 37.31 + tz * 71.19 + i * 5.13);
      const scaleKey = jitter(tx * 11.79 + tz * 23.41 + i * 9.07);
      const yaw      = rotKey * Math.PI * 2;
      const scaleMul = 0.8 + scaleKey * 0.4;
      const s = t.scale * scaleMul;
      const species  = t.species  || 'pine';
      const shadeIdx = t.shadeIdx ?? 0;
      const leafCss  = treeLeafColorFor(species, shadeIdx, { fogged, season });

      // Trunk silhouette varies by species so the oak's tall trunk reads
      // distinctly from the pine's stubby base.
      let trunkOpts;
      if (species === 'oak') {
        trunkOpts = { diameterTop: 0.14 * s, diameterBottom: 0.18 * s, height: 0.55 * s, tessellation: 6 };
      } else if (species === 'spruce') {
        trunkOpts = { diameterTop: 0.12 * s, diameterBottom: 0.15 * s, height: 0.25 * s, tessellation: 6 };
      } else {
        trunkOpts = { diameterTop: 0.16 * s, diameterBottom: 0.20 * s, height: 0.30 * s, tessellation: 6 };
      }
      const trunk = BABYLON.MeshBuilder.CreateCylinder(
        `${namePrefix}_t${i}_trunk`, trunkOpts, scene,
      );
      // Place trunk so its base sits on the ground (Y = 0).
      trunk.position.set(tx, trunkOpts.height / 2, tz);
      trunk.rotation.y = yaw;
      trunks.push(trunk);

      // Leaf geometry varies by species.
      const leafMeshes = [];
      if (species === 'oak') {
        // Winter deciduous oaks are bare twiggy silhouettes — drop the sphere
        // crown so only the trunk renders. The trunk stays as before so the
        // tree still reads as something.
        if (!isWinter) {
          const crown = BABYLON.MeshBuilder.CreateSphere(
            `${namePrefix}_t${i}_oak`,
            { diameter: 0.85 * s, segments: 5 },
            scene,
          );
          const trunkHeight = trunkOpts.height;
          crown.position.set(tx, trunkHeight + 0.35 * s, tz);
          crown.rotation.y = yaw;
          leafMeshes.push(crown);
        }
      } else if (species === 'spruce') {
        // Slim 4-tier cone stack — narrower and taller than pine.
        const cones = [
          { y: 0.38 * s, dBot: 0.52 * s, dTop: 0.32 * s, h: 0.42 * s },
          { y: 0.66 * s, dBot: 0.42 * s, dTop: 0.22 * s, h: 0.40 * s },
          { y: 0.93 * s, dBot: 0.30 * s, dTop: 0.14 * s, h: 0.38 * s },
          { y: 1.18 * s, dBot: 0.18 * s, dTop: 0.00,     h: 0.32 * s },
        ];
        for (let c = 0; c < cones.length; c++) {
          const cfg = cones[c];
          const cone = BABYLON.MeshBuilder.CreateCylinder(
            `${namePrefix}_t${i}_spr${c}`,
            { diameterTop: cfg.dTop, diameterBottom: cfg.dBot, height: cfg.h, tessellation: 6 },
            scene,
          );
          cone.position.set(tx, cfg.y, tz);
          cone.rotation.y = yaw;
          leafMeshes.push(cone);
        }
      } else {
        // Pine — original 3-tier cone stack.
        const cones = [
          { y: 0.45 * s, dBot: 0.78 * s, dTop: 0.35 * s, h: 0.45 * s },
          { y: 0.72 * s, dBot: 0.58 * s, dTop: 0.20 * s, h: 0.40 * s },
          { y: 0.96 * s, dBot: 0.38 * s, dTop: 0.00,     h: 0.35 * s },
        ];
        for (let c = 0; c < cones.length; c++) {
          const cfg = cones[c];
          const cone = BABYLON.MeshBuilder.CreateCylinder(
            `${namePrefix}_t${i}_leaf${c}`,
            { diameterTop: cfg.dTop, diameterBottom: cfg.dBot, height: cfg.h, tessellation: 6 },
            scene,
          );
          cone.position.set(tx, cfg.y, tz);
          cone.rotation.y = yaw;
          leafMeshes.push(cone);
        }
      }

      if (leafMeshes.length > 0) {
        let bucket = leavesByColor.get(leafCss);
        if (!bucket) { bucket = []; leavesByColor.set(leafCss, bucket); }
        for (const m of leafMeshes) bucket.push(m);
      }
    }
    return { trunks, leavesByColor };
  }

  /** Merge accumulated trunk + leaf meshes into one trunk mesh + one mesh per
   *  leaf-colour bucket, parented under `parent`. Shared between the per-tile
   *  interior forest merge and the band-wide border forest merge — both
   *  collapse the same underlying geometry, the difference is what scope of
   *  trees feeds the input arrays. Returns the merged meshes in emission order
   *  ([trunk, ...leafBuckets]) so callers can register them with the shadow
   *  generator in one pass. */
  _mergeTreeBuckets(trunks, leavesByColor, parent, namePrefix, trunkMat, { alpha = 1 } = {}) {
    const BABYLON = this._babylon;
    const out = [];
    if (!BABYLON) return out;
    // MergeMeshes(meshes, disposeSource=true) returns one combined mesh.
    if (trunks.length > 0) {
      const mergedTrunk = BABYLON.Mesh.MergeMeshes(trunks, true, true, undefined, false, false);
      if (mergedTrunk) {
        mergedTrunk.name       = `${namePrefix}_trunks`;
        mergedTrunk.material   = trunkMat;
        mergedTrunk.parent     = parent;
        mergedTrunk.isPickable = false;
        out.push(mergedTrunk);
      }
    }
    let bucketIdx = 0;
    for (const [color, bucket] of leavesByColor) {
      const merged = BABYLON.Mesh.MergeMeshes(bucket, true, true, undefined, false, false);
      if (!merged) { bucketIdx++; continue; }
      merged.name       = `${namePrefix}_leaves_${bucketIdx}`;
      merged.material   = this._alphaMaterialFor(color, alpha);
      merged.parent     = parent;
      merged.isPickable = false;
      out.push(merged);
      bucketIdx++;
    }
    return out;
  }

  /** Cross-tile merge for the visual-only border-forest band. Instead of
   *  merging per-tile (the interior-forest path), accumulate every border
   *  tile's tree cluster geometry first and merge ONCE across the whole band.
   *  Result is ~10 meshes total (1 trunk + ≤9 leaf buckets) regardless of how
   *  many border tiles or how deep the band is — the entire band collapses to
   *  a near-constant number of draw calls.
   *
   *  Border-forest tiles are never fogged individually (the band is permanent
   *  out-of-sight wilderness — see `_buildMapBorderForest`), so there's no
   *  per-tile visibility toggle that would force per-tile granularity. Trees
   *  carry their per-tree position jitter and rotation baked into local
   *  vertices before merge, so the cross-tile merge preserves the same visual
   *  layout as per-tile merging would.
   *
   *  `treeJobs` is `[{ namePrefix, cx, cz, trees }, ...]` — one entry per
   *  border tile that has any trees. */
  _buildBorderForestTreesBatched(
    parent, treeJobs,
    { fogged = false, season = null, alpha = 1, namePrefix = 'border_forest' } = {},
  ) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!BABYLON || !scene || !treeJobs || treeJobs.length === 0) return [];
    const allTrunks = [];
    const allLeavesByColor = new Map();
    for (const job of treeJobs) {
      const { trunks, leavesByColor } = this._buildTreeClusterMeshes(
        job.namePrefix, job.cx, job.cz, job.trees, { fogged, season },
      );
      for (const t of trunks) allTrunks.push(t);
      for (const [color, list] of leavesByColor) {
        let bucket = allLeavesByColor.get(color);
        if (!bucket) { bucket = []; allLeavesByColor.set(color, bucket); }
        for (const m of list) bucket.push(m);
      }
    }
    const trunkCss = fogged ? '#241710' : '#5a3a20';
    const trunkMat = this._alphaMaterialFor(trunkCss, alpha);
    return this._mergeTreeBuckets(allTrunks, allLeavesByColor, parent, namePrefix, trunkMat, { alpha });
  }

  _buildFlatHexMesh(name, parent, x, z) {
    const BABYLON = this._babylon;
    const R = HEX_RADIUS_WORLD;
    const SQRT3 = Math.sqrt(3);
    const inset = 0.04;
    const uvScale = 1 - 2 * inset;
    const positions = [0, 0, 0];
    const uvs = [0.5, 0.5];
    const indices = [];
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 6 + i * Math.PI / 3; // pointy-top: vertex at +Z when i=1
      const vx = R * Math.cos(angle);
      const vz = R * Math.sin(angle);
      positions.push(vx, 0, vz);
      const u = 0.5 + vx / (R * SQRT3);     // pointy-top bounding box: x ∈ [-R√3/2, R√3/2]
      const v = 0.5 + 0.5 * (vz / R);       //                          z ∈ [-R, R]
      uvs.push(inset + uvScale * u, inset + uvScale * v);
    }
    for (let i = 0; i < 6; i++) indices.push(0, i + 1, ((i + 1) % 6) + 1);

    const mesh = new BABYLON.Mesh(name, this._scene);
    const vd = new BABYLON.VertexData();
    vd.positions = positions;
    vd.indices   = indices;
    vd.uvs       = uvs;
    vd.normals   = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, vd.normals);
    vd.applyToMesh(mesh);
    mesh.parent     = parent;
    mesh.position.x = x;
    mesh.position.z = z;
    mesh.position.y = 0;
    return mesh;
  }

  /** Rewrite a hex cylinder's top-cap UVs so the terrain texture spans the hex's
   *  bounding box rather than being mapped into the inscribed circle (the default
   *  for `CreateCylinder` caps — which leaves the six hex corners sampling
   *  outside [0,1] and rendering as black).
   *
   *  The mesh is rotated by +π/6 around Y at build time (flat-top cylinder →
   *  pointy-top hex in world). We compose that rotation into the UV mapping so
   *  the texture's "north" (v=1) lands on the hex's pointy +Z vertex rather
   *  than 30° off to the side. For each top-cap vertex (local y ≈ +halfHeight),
   *  rotate the local (x, z) by +π/6 into world frame, then map the pointy-top
   *  bounding box [-R·√3/2 .. R·√3/2] × [-R .. R] to [0..1] × [0..1]. Cap centre
   *  stays at (0.5, 0.5). Side / bottom UVs are left untouched. */
  _remapHexTopCapUVs(hex, halfHeight) {
    const BABYLON = this._babylon;
    if (!BABYLON || !hex) return;
    const positions = hex.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const uvs       = hex.getVerticesData(BABYLON.VertexBuffer.UVKind);
    if (!positions || !uvs) return;
    const next = uvs.slice();
    const R    = HEX_RADIUS_WORLD;
    const SQRT3 = Math.sqrt(3);
    const cos = SQRT3 / 2, sin = 0.5; // rotation by +π/6 around Y
    const eps  = 0.001;
    // Inset the UV sample range a few % away from the texture's rim. The
    // atlas sprite has transparent / dark padding at its edges (sprite-sheet
    // gutters), and sampling at UV ∈ {0, 1} picks those pixels up — visible
    // as thin black seams at every hex perimeter.
    const inset = 0.04;
    const scale = 1 - 2 * inset;
    for (let i = 0; i < positions.length / 3; i++) {
      const y = positions[i * 3 + 1];
      if (Math.abs(y - halfHeight) > eps) continue;
      const xl = positions[i * 3];
      const zl = positions[i * 3 + 2];
      // Babylon Y-rotation: world.x = x·cos + z·sin, world.z = −x·sin + z·cos
      const xw = xl * cos + zl * sin;
      const zw = -xl * sin + zl * cos;
      const u = 0.5 + xw / (R * SQRT3);
      const v = 0.5 + 0.5 * (zw / R);
      next[i * 2]     = inset + scale * u;
      next[i * 2 + 1] = inset + scale * v;
    }
    // Use setVerticesData (not updateVerticesData): CreateCylinder builds a
    // non-updatable VBO by default, on which updateVerticesData silently
    // no-ops. setVerticesData forces a fresh writable buffer.
    hex.setVerticesData(BABYLON.VertexBuffer.UVKind, next);
  }

  /** Walk the playable tiles and re-assign each cylinder material now that the
   *  atlas has loaded. No-op when called before the map exists; safe to call
   *  repeatedly (cached materials are reused). Used by `loadImages` when the
   *  tilemap arrives after `_initBabylon` has already laid down solid-colour
   *  tiles. Border-forest cylinders are upgraded in the same pass. */
  _upgradeTileTextures() {
    if (!this._mapBuilt || !this._mapRoot || !this._scene || !this._tilemapImg) return;
    if (!this.state?.tiles) return;
    for (const tile of this.state.tiles.values()) {
      const tkey = tile.col + ',' + tile.row;
      const hex = this._tileMeshByKey.get(tkey);
      if (!hex) continue;
      const isFogged = this._fogActiveSet.has(tkey);
      hex.material = this._tileMaterialFor(tile, { fogged: isFogged });
    }
    // Border-forest cylinders share the FOREST sprite pool but live in a
    // separate map — upgrade them too so the texture appears around the edge.
    // CRITICAL: route through `_borderGroundMaterialFor` (NOT the plain
    // `_terrainMaterialFor`) so the per-ring EDGE FADE is preserved. A plain
    // terrain material is fully opaque, so swapping it in when the atlas
    // arrives would silently un-fade the band's outer rings — the ground would
    // snap back to a hard opaque wall while the trees + river stayed
    // translucent. Re-derive ext + bandDepth exactly as `_buildMapBorderForest`
    // does so the alpha matches the original build tier-for-tier.
    const ext = tilesExtent(this.state.tiles);
    let bandDepth = 0;
    for (const [, hex] of this._borderForestHexesByKey) {
      const md = hex?.metadata;
      if (!md) continue;
      bandDepth = Math.max(bandDepth, borderTileDepthFromPlayable(md.col, md.row, ext));
    }
    const borderBaseColor = TILE_COLOR[TileType.FOREST] || TILE_COLOR[TileType.GRASS];
    for (const [, hex] of this._borderForestHexesByKey) {
      const md = hex.metadata;
      if (!md) continue;
      const syntheticTile = { type: TileType.FOREST, base: TileType.FOREST, col: md.col, row: md.row };
      // Always use the fogged variant — border tiles are permanently
      // out-of-sight wilderness (see `_buildMapBorderForest`) — at this ring's
      // edge-fade alpha so ground keeps dissolving in lockstep with the trees.
      const alpha = borderForestAlphaForTile(md.col, md.row, ext, bandDepth);
      const mat = this._borderGroundMaterialFor(
        terrainSpriteIdFor(syntheticTile, md.col, md.row),
        borderBaseColor,
        alpha,
      );
      if (mat) hex.material = mat;
    }
  }

  _frameFullMap(opts = {}) {
    if (!this.state?.tiles || this.state.tiles.size === 0) return;
    const all = [];
    for (const tile of this.state.tiles.values()) all.push({ col: tile.col, row: tile.row });
    this.frameHexes(all, { paddingHexes: 1, instant: opts.instant === true });
  }

  /** Recompute the camera's zoom limits from the current aspect/FOV.
   *
   *  `upperRadiusLimit` (max zoom-out) → `radiusForStandardFit`: the radius
   *  that fits a standard 13×13 map. Larger maps must be panned.
   *
   *  `lowerRadiusLimit` (max zoom-in) → `radiusForCloseFit(MIN_VISIBLE_HEXES)`:
   *  the radius at which ~5 hexes are still visible around the camera target.
   *  Closer than that, the camera enters meshes and picking/clipping break.
   *
   *  Called once during init and again on resize. If the current camera radius
   *  now falls outside the new range, snap it back into bounds.
   *
   *  No-op when the engine or camera hasn't initialised yet. */
  _recomputeMaxZoomCap() {
    if (!this._engine || !this._camera) return;
    const aspect = this._engine.getRenderWidth() / Math.max(1, this._engine.getRenderHeight());
    const fov = this._camera.fov || 0.8;
    // Cap fits THIS map's playable tiles — not a hardcoded standard 13×13.
    // Campaign / battle maps with bigger footprints get a larger upper radius
    // so the operator can zoom out far enough to see the whole map.
    const upper = radiusForMapFit(this.state, aspect, fov);
    const lower = radiusForCloseFit(MIN_VISIBLE_HEXES, aspect, fov);
    if (Number.isFinite(upper) && upper > 0) {
      // Guarantee lower < upper even on pathological aspects (shouldn't be
      // possible — standard-fit always exceeds 5-hex-fit — but cheap to defend).
      const safeLower = Number.isFinite(lower) && lower > 0
        ? Math.min(lower, upper * 0.99)
        : this._camera.lowerRadiusLimit;
      this._camera.lowerRadiusLimit = safeLower;
      this._camera.upperRadiusLimit = upper;
      if (this._camera.radius > upper) this._camera.radius = upper;
      if (this._camera.radius < safeLower) this._camera.radius = safeLower;
    }
  }

  /** Wraps `radiusForFitDepth` with this camera's FOV/aspect and clamps to the
   *  camera's radius limits. Depth-only fit so the playable map fills the
   *  screen vertically at the fit-button radius — wider maps overflow
   *  horizontally on purpose so the operator never sees past the top/bottom
   *  edge. Both single-hex and full-map callers share this helper. */
  _radiusForFit(_fitWidth, fitDepth) {
    const aspect = this._engine
      ? this._engine.getRenderWidth() / Math.max(1, this._engine.getRenderHeight())
      : 16 / 9;
    const fov = this._camera.fov || 0.8;
    const radius = radiusForFitDepth(_fitWidth, fitDepth, aspect, fov);
    return Math.max(
      this._camera.lowerRadiusLimit ?? 1,
      Math.min(this._camera.upperRadiusLimit ?? 200, radius),
    );
  }

  // ─── Phase 3: entities & selection ─────────────────────────────────────────
  //
  // Standees are billboarded textured planes sitting on solid coloured discs,
  // one pair per entity. Selection state lives in `this._selection.entityId` —
  // written from ui.js _selectEntity() via `setSelection()` on the
  // renderer-agnostic interface (the 2D path reads the same state in its draw
  // loop). draw() runs the diff every redraw; standees are added/removed/moved
  // incrementally.

  /** Compute a stable "owner key" we can use to colour a standee's base disc.
   *  Prefer the entity's per-player colour (`e.color` is set by the game on
   *  leaders and propagated to summons/recruits); fall back to the faction
   *  primary colour and finally a neutral grey for stray neutrals. */
  _ownerColorFor(entity) {
    if (entity?.color) return entity.color;
    if (entity?.owner) {
      const theme = getFactionTheme(entity.owner);
      if (theme?.primary) return theme.primary;
    }
    return '#888888';
  }

  /** Map an entity to the asset id used by the tilemap sprite atlas. */
  _assetIdFor(entity) {
    if (!entity) return null;
    if (entity.type === EntityType.SURVIVOR) {
      return Renderer.survivorAssetId(entity.title);
    }
    // Non-survivor types map 1:1 onto the asset ids ('paladin', 'witch', ...).
    return entity.type;
  }

  /** Lazy-create (and cache) a Babylon Texture for a given sprite asset id by
   *  cropping it out of the tilemap into an offscreen canvas. Returns null if
   *  the tilemap hasn't loaded or the asset id is unknown — caller falls back
   *  to a plain coloured plane. */
  _portraitTextureFor(assetId) {
    if (!assetId || !this._tilemapImg || !this._spriteRects) return null;
    if (this._portraitTextures.has(assetId)) return this._portraitTextures.get(assetId);
    const rect = this._spriteRects.get(assetId);
    if (!rect) return null;
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    c.getContext('2d').drawImage(
      this._tilemapImg,
      rect.x, rect.y, rect.size, rect.size,
      0, 0, c.width, c.height,
    );
    const BABYLON = this._babylon;
    // Babylon defaults: noMipmap=false, invertY=true (matches HTML image origin).
    // We previously passed `true, false` here which disabled mipmaps AND flipped
    // V — the V-flip rendered the back face of the plane, hiding the portrait
    // behind the standee material when backFaceCulling kicked in. Use defaults.
    const tex = new BABYLON.Texture(c.toDataURL(), this._scene);
    tex.hasAlpha = true;
    this._portraitTextures.set(assetId, tex);
    return tex;
  }

  /** Per-asset plane material, textured with the entity portrait (or a flat
   *  diffuse fallback when the tilemap is unavailable). */
  _planeMaterialFor(assetId) {
    const key = assetId ?? '__blank__';
    if (this._portraitMaterials.has(key)) return this._portraitMaterials.get(key);
    const BABYLON = this._babylon;
    const mat = new BABYLON.StandardMaterial(`standee_${key}`, this._scene);
    const tex = this._portraitTextureFor(assetId);
    if (tex) {
      mat.diffuseTexture     = tex;
      mat.opacityTexture     = tex;
      mat.useAlphaFromDiffuseTexture = true;
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      // Strong emissive so the portrait reads as bright/sticker-like against
      // the (relatively dark) tombstone carrier at any phase / light angle.
      mat.emissiveColor = new BABYLON.Color3(0.85, 0.85, 0.85);
      // Portrait sticker stays solid through scene fog — wilderness fade
      // shouldn't make hero faces fuzzy.
      mat.fogEnabled    = false;
    } else {
      // Tilemap unavailable — use neutral pale fill so the plane still reads.
      mat.diffuseColor  = new BABYLON.Color3(0.85, 0.85, 0.85);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
    }
    mat.backFaceCulling = false; // BillboardMode rotates plane — both sides visible
    this._portraitMaterials.set(key, mat);
    return mat;
  }

  /** Per-owner base material (filled with the player's colour). */
  _baseMaterialForOwner(ownerKey) {
    if (this._baseMaterialCache.has(ownerKey)) return this._baseMaterialCache.get(ownerKey);
    const BABYLON = this._babylon;
    const [r, g, b] = cssHexToRgb01(ownerKey);
    const mat = new BABYLON.StandardMaterial(`base_${ownerKey}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(r, g, b);
    mat.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
    // Both sides render — the standee tombstone uses this material on a
    // custom-vertex mesh whose winding might have either-handed normals;
    // showing both sides bypasses the question.
    mat.backFaceCulling = false;
    this._baseMaterialCache.set(ownerKey, mat);
    return mat;
  }

  /** Build the {plane, sphere, leader} mesh group for a single entity.
   *
   *  Unit body is a player-colour cone with a spherical head — a classic
   *  board-game token. The cone is exposed as `plane` to preserve the field
   *  name used by every animation / focus / picking site (lunge, move, plan
   *  ghost, selection halo, fog-of-war visibility). The sphere is parented to
   *  the cone, so animating the cone moves the head along with it for free.
   *
   *  The ground-level base disc was retired with the per-unit hex outline
   *  rollout — selection is now signalled by the thick hex outline + glow,
   *  so the redundant disc is gone. Cone bottom still anchors at
   *  STANDEE_BASE_Y_OFFSET + STANDEE_BASE_THICKNESS/2 so the silhouette and
   *  every floater (icon billboard, HP ring, plan ghost, lantern) keep their
   *  current world-Y placement. */
  _buildStandeeMesh(entity) {
    const leader  = isLeaderType(entity.type);
    const hMul    = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
    const wMul    = leader ? STANDEE_LEADER_WIDTH_MUL  : 1;

    const ownerColor = this._ownerColorFor(entity);
    const bodyMat = this._baseMaterialForOwner(ownerColor);

    const { cone, sphere } = this._buildTokenBody(`unit_${entity.id}`, {
      coneHeight:         STANDEE_CONE_HEIGHT          * hMul,
      coneDiameterBottom: STANDEE_CONE_DIAMETER_BOTTOM * wMul,
      coneDiameterTop:    STANDEE_CONE_DIAMETER_TOP    * wMul,
      sphereDiameter:     STANDEE_SPHERE_DIAMETER      * wMul,
    });
    cone.material   = bodyMat;
    sphere.material = bodyMat;
    // Picking target: the cone (the bigger of the two volumes). Metadata mirrors
    // what the tombstone-era plane carried so canvasToHex still resolves clicks.
    cone.metadata = { kind: 'entity', entityId: entity.id, col: entity.col, row: entity.row };
    // Standees share renderingGroupId 0 with the rest of the world geometry
    // (terrain, road / river ribbons, buildings) so the depth buffer handles
    // unit-vs-building occlusion. Babylon renders higher groups unconditionally
    // on top, which previously made standees draw over buildings regardless of
    // camera angle.
    cone.renderingGroupId   = 0;
    sphere.renderingGroupId = 0;
    // Sun throws a token-shaped shadow onto the terrain. Both meshes cast.
    this._addShadowCaster(cone);
    this._addShadowCaster(sphere);

    const standee = { plane: cone, sphere, leader, paladinClone: null };

    // Hero-side standees swap the cone+sphere body for a clone of the
    // paladin GLB model once it's loaded. The cone+sphere stay in-scene as
    // anchor + picking target (their `.visibility` is dropped to 0 so they
    // don't render). If the source isn't loaded yet, `_loadPaladinModel`
    // resolves later and retrofits via `_upgradeHeroStandeesToPaladin`.
    if (this._paladinSource && unitUsesPaladinModel(entity)) {
      const clone = this._buildPaladinClone(entity, cone);
      if (clone) {
        cone.visibility   = 0;
        sphere.visibility = 0;
        // Cone+sphere are invisible but still on the shadow caster list
        // — strip them so the floor shadow reflects the paladin silhouette,
        // not the pawn shape.
        this._removeShadowCaster(cone);
        this._removeShadowCaster(sphere);
        for (const m of clone.childMeshes || []) this._addShadowCaster(m);
        standee.paladinClone = clone;
      }
    }

    this._positionStandee(standee, entity);
    return standee;
  }

  /** Place an existing standee on its entity's tile. By default centres on
   *  the hex; `opts.x` / `opts.z` override with an explicit world position
   *  (used by the tile-slot re-pass when a hex hosts more than one occupant). */
  _positionStandee(standee, entity, opts = {}) {
    const base = hexToWorld(entity.col, entity.row);
    const x = typeof opts.x === 'number' ? opts.x : base.x;
    const z = typeof opts.z === 'number' ? opts.z : base.z;
    const hMul = standee.leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
    standee.plane.position.x = x;
    standee.plane.position.z = z;
    // Cone is centred on its local Y axis — lift it so its bottom rim sits at
    // the legacy disc-top anchor (STANDEE_BASE_Y_OFFSET + thickness/2). The
    // disc is gone but the anchor stays so every floater (icon billboard,
    // HP ring, plan ghost) keeps its world-Y placement.
    const coneHeight = STANDEE_CONE_HEIGHT * hMul;
    standee.plane.position.y = STANDEE_BASE_Y_OFFSET
      + STANDEE_BASE_THICKNESS / 2
      + coneHeight / 2;
    // Keep the metadata's col/row in sync so picking returns the current tile.
    standee.plane.metadata.col = entity.col;
    standee.plane.metadata.row = entity.row;
  }

  /** Diff the state's live entities against the standee map: add new ones,
   *  remove dead/missing ones, move kept ones to their current hex. */
  _syncEntityStandees() {
    if (!this._scene || !this.state?.entities) return;
    const seen = new Set();
    for (const e of this.state.entities) {
      if (!e || !e.alive) continue;
      if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
      seen.add(e.id);
      let standee = this._entityStandees.get(e.id);
      if (!standee) {
        standee = this._buildStandeeMesh(e);
        this._entityStandees.set(e.id, standee);
      } else if (!this._activeMoveIds.has(e.id) && !this._activeLungeIds.has(e.id)) {
        // Skip snapping while a move/lunge animation is driving this standee —
        // otherwise the per-frame redraw would yank the mesh back to the
        // state's destination and cancel the animation visually.
        this._positionStandee(standee, e);
        // Owner colour can change (e.g. recruit changing sides — defensive).
        // Cone + sphere share the owner material; keep them in sync so a side-
        // flip recolours the whole token.
        const expected = this._baseMaterialForOwner(this._ownerColorFor(e));
        if (standee.plane.material !== expected)  standee.plane.material  = expected;
        if (standee.sphere && standee.sphere.material !== expected) {
          standee.sphere.material = expected;
        }
      } else if (standee.plane?.metadata) {
        // Animation is driving cone.position; we skip _positionStandee to
        // avoid stomping the slide. But the metadata.col/row drives fog
        // visibility checks in _applyFogVeil, so keep IT in sync with the
        // entity's logical hex even during animation. Without this, a unit
        // moving 2+ hexes (road / horse) past sight range would have its
        // OLD hex tested against the post-move fog set, fail, and get
        // setEnabled(false) → invisible for the round.
        standee.plane.metadata.col = e.col;
        standee.plane.metadata.row = e.row;
      }
      // HP indicator: drawn as a circular arc rim around the floating unit
      // icon billboard (see _syncEntityIconBillboards), not the rectangular
      // bar that used to live here.
    }
    // Dispose standees for entities that no longer exist or just died. The
    // unit-icon billboards are owned by _syncEntityIconBillboards's own diff
    // pass — it cleans up its meshes from the same seen-set logic.
    for (const [id, standee] of this._entityStandees) {
      if (!seen.has(id)) {
        // Paladin clones (skeleton + animation group) must be torn down
        // explicitly — they don't cascade off the cone's dispose() call
        // because the animation group lives in scene.animationGroups, not
        // mesh.children. Dispose them first so the per-frame bone update
        // stops before the cone is gone.
        this._disposePaladinClone(standee);
        standee.plane.dispose();
        this._entityStandees.delete(id);
      }
    }
    // Item 8: after the per-entity position step above, re-slot any hex that
    // has more than one occupant. Cheap walk — typically only a handful of
    // hexes have co-tenants. Also manages the +N overflow badge.
    this._resyncTileSlotsForStandees();
  }

  /** Re-position standees on hexes with multiple occupants (building + standee,
   *  forest + standee, or 2+ standees) so each occupant lives in its own slot.
   *  Trees + buildings stay where _buildTileMesh placed them (their slot
   *  assignment is stable); only standee positions change here. Also keeps
   *  the +N overflow badge in sync per-hex. */
  _resyncTileSlotsForStandees() {
    if (!this._scene || !this._babylon || !this.state?.entities) return;

    // Group live standees by hex. Skip entities whose standee is currently
    // being driven by a move/lunge animation (their position is owned by the
    // animation; let it land first, the next draw re-slots them).
    const byHex = new Map(); // hexKey → [{id, kind:'standee', entity, ...}]
    const hexCenter = new Map(); // hexKey → {col, row}
    for (const e of this.state.entities) {
      if (!e?.alive) continue;
      if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
      if (this._activeMoveIds.has(e.id) || this._activeLungeIds.has(e.id)) continue;
      if (!this._entityStandees.has(e.id)) continue;
      const k = hexKey(e.col, e.row);
      if (!byHex.has(k)) { byHex.set(k, []); hexCenter.set(k, { col: e.col, row: e.row }); }
      byHex.get(k).push({ id: `standee_${e.id}`, kind: 'standee', entity: e });
    }

    const seenHexes = new Set();
    for (const [k, standeeOccs] of byHex) {
      seenHexes.add(k);
      const staticOcc = this._staticOccupantsByKey.get(k) ?? [];
      // Single standee on an empty hex → nothing to re-slot, the standee
      // already sits at hex centre from _positionStandee's default path.
      if (standeeOccs.length === 1 && staticOcc.length === 0) {
        this._syncOverflowBadge(k, 0);
        continue;
      }
      const { col, row } = hexCenter.get(k);
      const { positionByOccupantId, overflow } = tileSlotWorldPositions(
        col, row, [...staticOcc, ...standeeOccs], HEX_RADIUS_WORLD,
        { reservedSlots: this._roadBlockedSlotsByKey.get(k) },
      );
      for (const occ of standeeOccs) {
        const pos = positionByOccupantId.get(occ.id);
        const standee = this._entityStandees.get(occ.entity.id);
        if (!pos || !standee) continue;
        this._positionStandee(standee, occ.entity, { x: pos.x, z: pos.z });
      }
      this._syncOverflowBadge(k, overflow, col, row);
    }
    // Clear badges on hexes that no longer host standees.
    for (const k of [...this._overflowBadges.keys()]) {
      if (!seenHexes.has(k)) this._syncOverflowBadge(k, 0);
    }
  }

  /** Diff alive entities against `_entityHexOutlines` and keep the per-unit
   *  ground-level hex outlines in step. Every alive unit gets one thin
   *  owner-tinted hex ring (always visible) plus a thicker glowing ring
   *  (hidden until `_applySelectionAndFocus` shows it for the selected unit).
   *
   *  Intentionally independent of `_syncEntityStandees` — concurrent work on
   *  the standee tower (HP rings, floating icons) should not collide with the
   *  ground-level outline layer. Called from draw() right after the standee
   *  sync so newly-built standees already have their outlines paired up.
   *
   *  Tombstones (entity.alive === false) get no outline; the dispose pass
   *  below drops outlines for entities that have died this turn. */
  _syncEntityHexOutlines() {
    if (!this._scene || !this._babylon || !this.state?.entities) return;
    const observerOwner = this._observerOwner();
    const seen = new Set();
    for (const e of this.state.entities) {
      if (!e || !e.alive) continue;
      if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
      seen.add(e.id);
      // Always-on thin outline only renders for local-side units. Enemy units
      // get no thin ring; the thick selection outline still applies when they
      // are picked, regardless of side. When there is no local observer (AI-
      // vs-AI or generic spectator), no unit qualifies as "local" — nobody
      // gets the thin ring.
      const isLocal = !!(observerOwner && e.owner === observerOwner);
      let outline = this._entityHexOutlines.get(e.id);
      if (!outline) {
        outline = this._buildEntityHexOutline(e, isLocal);
        this._entityHexOutlines.set(e.id, outline);
        // Newly-built outline starts on the thin ring (if local); only flip to
        // thick if the unit is the current selection (rare — usually selection
        // happens after the outline already exists).
        if (this._selection?.entityId === e.id) {
          outline.thin.isVisible  = false;
          outline.thick.isVisible = true;
        }
      } else {
        // Recolour if the entity's owner colour changed (e.g. side-flip).
        const ownerKey = unitHexOutlineColor(e);
        if (outline.ownerKey !== ownerKey) {
          outline.thin.material  = this._thinOutlineMaterialFor(ownerKey);
          outline.thick.material = this._thickOutlineMaterialFor(ownerKey);
          outline.ownerKey = ownerKey;
        }
        // Refresh the local-side flag — observer can change mid-game (e.g.
        // hot-seat two-player) and a recruited survivor can change ownership.
        if (outline.isLocal !== isLocal) {
          outline.isLocal = isLocal;
          if (this._selection?.entityId !== e.id) {
            outline.thin.isVisible = isLocal;
          }
        }
      }
      const { x, z } = hexToWorld(e.col, e.row);
      outline.thin.position.x  = x;
      outline.thin.position.z  = z;
      outline.thick.position.x = x;
      outline.thick.position.z = z;
    }
    // Dispose outlines for entities that no longer exist or just died.
    for (const [id, outline] of this._entityHexOutlines) {
      if (seen.has(id)) continue;
      outline.thin.dispose();
      outline.thick.dispose();
      this._entityHexOutlines.delete(id);
    }
  }

  /** Build the {thin, thick} hex ring pair for a single entity. Thin is
   *  visible by default only for local-side units (enemy units get no thin
   *  outline); thick is parked invisible and toggled on by
   *  `_applySelectionAndFocus` when the unit is selected, regardless of side. */
  _buildEntityHexOutline(entity, isLocal) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    const path    = unitHexOutlineRingPath().map(
      p => new BABYLON.Vector3(p.x, p.y, p.z),
    );
    const ownerKey = unitHexOutlineColor(entity);

    const thin = BABYLON.MeshBuilder.CreateTube(`unitOutlineThin_${entity.id}`, {
      path,
      radius:          UNIT_HEX_OUTLINE_THIN_TUBE,
      tessellation:    6,
      sideOrientation: BABYLON.Mesh.DOUBLESIDE,
    }, scene);
    thin.material         = this._thinOutlineMaterialFor(ownerKey);
    thin.isPickable       = false;
    // World geometry group (0): the outline's Y placement sits above the road/
    // river ribbons but below buildings, so the depth buffer draws it in the
    // correct order without a group bump.
    thin.renderingGroupId = 0;
    thin.isVisible        = !!isLocal;

    const thick = BABYLON.MeshBuilder.CreateTube(`unitOutlineThick_${entity.id}`, {
      path,
      radius:          UNIT_HEX_OUTLINE_THICK_TUBE,
      tessellation:    6,
      sideOrientation: BABYLON.Mesh.DOUBLESIDE,
    }, scene);
    thick.material         = this._thickOutlineMaterialFor(ownerKey);
    thick.isPickable       = false;
    thick.renderingGroupId = 0;
    thick.isVisible        = false; // _applySelectionAndFocus drives visibility

    const { x, z } = hexToWorld(entity.col, entity.row);
    thin.position.x  = x; thin.position.z  = z;
    thick.position.x = x; thick.position.z = z;

    return { thin, thick, ownerKey, isLocal: !!isLocal };
  }

  /** Lazy, owner-keyed material for the always-on thin hex outline. Low
   *  emissive — the ring reads as a tinted line, not a self-lit halo. */
  _thinOutlineMaterialFor(ownerKey) {
    if (this._thinOutlineMatCache.has(ownerKey)) {
      return this._thinOutlineMatCache.get(ownerKey);
    }
    const BABYLON = this._babylon;
    const [r, g, b] = cssHexToRgb01(ownerKey);
    const mat = new BABYLON.StandardMaterial(`unitOutlineThinMat_${ownerKey}`, this._scene);
    mat.diffuseColor   = new BABYLON.Color3(r, g, b);
    mat.specularColor  = new BABYLON.Color3(0, 0, 0);
    const e = UNIT_HEX_OUTLINE_THIN_EMISSIVE_MUL;
    mat.emissiveColor  = new BABYLON.Color3(r * e, g * e, b * e);
    this._thinOutlineMatCache.set(ownerKey, mat);
    return mat;
  }

  /** Lazy, owner-keyed material for the selected unit's thicker glow ring.
   *  Emissive is capped at `UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL × diffuse` so
   *  the ring stays owner-tinted at high emissive values. */
  _thickOutlineMaterialFor(ownerKey) {
    if (this._thickOutlineMatCache.has(ownerKey)) {
      return this._thickOutlineMatCache.get(ownerKey);
    }
    const BABYLON = this._babylon;
    const [r, g, b] = cssHexToRgb01(ownerKey);
    const mat = new BABYLON.StandardMaterial(`unitOutlineThickMat_${ownerKey}`, this._scene);
    mat.diffuseColor   = new BABYLON.Color3(r, g, b);
    mat.specularColor  = new BABYLON.Color3(0, 0, 0);
    const e = UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL;
    mat.emissiveColor  = new BABYLON.Color3(r * e, g * e, b * e);
    this._thickOutlineMatCache.set(ownerKey, mat);
    return mat;
  }

  /** Lazily create / update / dispose the "+N" badge plane above a hex.
   *  Reuses the dynamic-texture + billboard-plane pattern from plan-step
   *  badges (see `_buildPlanArrows`). Idempotent — only repaints the texture
   *  when N changes, and disposes the mesh when N drops back to 0. */
  _syncOverflowBadge(k, overflow, col, row) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    const existing = this._overflowBadges.get(k);

    if (overflow <= 0) {
      if (existing) {
        existing.plane?.dispose();
        existing.mat?.dispose();
        existing.tex?.dispose();
        this._overflowBadges.delete(k);
      }
      return;
    }
    if (!BABYLON || !scene || typeof document === 'undefined') return;

    if (existing && existing.lastN === overflow) return;

    // Repaint texture (existing badge) or build a fresh one.
    let badge = existing;
    if (!badge) {
      const tex = new BABYLON.DynamicTexture(
        `overflowTex_${k}`, { width: 64, height: 64 }, scene, false,
      );
      tex.hasAlpha = true;
      const mat = new BABYLON.StandardMaterial(`overflowMat_${k}`, scene);
      mat.diffuseTexture = tex;
      mat.opacityTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
      mat.backFaceCulling = false;
      const plane = BABYLON.MeshBuilder.CreatePlane(
        `overflow_${k}`, { width: 0.55, height: 0.55 }, scene,
      );
      plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      plane.isPickable    = false;
      plane.material      = mat;
      // Park position above the hex centre. (col,row) is guaranteed when we
      // arrive with overflow > 0 — calls from the "clear stale" loop pass
      // overflow === 0 and exit above.
      const { x, z } = hexToWorld(col, row);
      plane.position.set(x, 1.4, z);
      badge = { plane, mat, tex, lastN: 0 };
      this._overflowBadges.set(k, badge);
    }

    const ctx = badge.tex.getContext();
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffd060';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${overflow}`, 32, 34);
    badge.tex.update();
    badge.lastN = overflow;
  }

  /** Build the floating hover label above a building tile. One DynamicTexture
   *  per label (~256×64 px); painted once at build time and never repainted
   *  because building names are immutable. Alpha is driven each frame from
   *  `_pumpBuildingLabelFade`. Tracked in `_buildingLabelsByKey` so the
   *  per-frame pump can iterate them without a scene walk. */
  _buildBuildingLabel(tile, hexX, hexZ, parent) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!BABYLON || !scene || typeof document === 'undefined') return;
    const text = labelTextForTile(tile);
    if (!text) return;

    const tkey = hexKey(tile.col, tile.row);
    const tex = new BABYLON.DynamicTexture(
      `bldgLabelTex_${tkey}`,
      { width: BUILDING_LABEL_TEX_W, height: BUILDING_LABEL_TEX_H },
      scene,
      false,
    );
    tex.hasAlpha = true;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, BUILDING_LABEL_TEX_W, BUILDING_LABEL_TEX_H);
    // Mirror the 2D label style: cream serif text with a dark shadow for legibility.
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font         = 'bold 36px Georgia, serif';
    const cx = BUILDING_LABEL_TEX_W / 2;
    const cy = BUILDING_LABEL_TEX_H / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(text, cx + 2, cy + 2);
    ctx.fillStyle = 'rgba(255,248,230,0.95)';
    ctx.fillText(text, cx, cy);
    tex.update();

    const mat = new BABYLON.StandardMaterial(`bldgLabelMat_${tkey}`, scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.specularColor  = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor  = new BABYLON.Color3(1, 1, 1);
    mat.backFaceCulling = false;
    mat.alpha = 1;

    const plane = BABYLON.MeshBuilder.CreatePlane(
      `bldgLabel_${tkey}`,
      { width: BUILDING_LABEL_WIDTH, height: BUILDING_LABEL_HEIGHT },
      scene,
    );
    plane.parent        = parent;
    // BILLBOARDMODE_ALL keeps the label fully camera-facing on all axes — at
    // the steeper-down 35° tilt a Y-only billboard reads as a slanted plane
    // ("tilted backwards into the map"), while full screen-space text always
    // looks flat-on regardless of camera angle or zoom.
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable    = false;
    plane.material      = mat;
    // Sit above the building's NE-slot roof, not over the hex centre, so the
    // label visually anchors to the building rather than floating off-axis.
    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    plane.position.set(hexX + slot.x, BUILDING_LABEL_Y, hexZ + slot.z);

    this._buildingLabelsByKey.set(tkey, { plane, mat, tex });
  }

  /** Per-frame: walk every building label and set its material alpha from the
   *  current camera radius using `labelAlphaForZoom`. Cheap — one Map walk
   *  and a scalar assignment per label per frame. */
  _pumpBuildingLabelFade() {
    if (!this._camera) return;
    if (this._buildingLabelsByKey.size === 0) return;
    const a = labelAlphaForZoom(
      this._camera.radius,
      BUILDING_LABEL_FADE_RADIUS_CLOSE,
      BUILDING_LABEL_FADE_RADIUS_FAR,
    );
    for (const entry of this._buildingLabelsByKey.values()) {
      if (entry.mat) entry.mat.alpha = a;
      // Skip the draw call entirely when fully faded — Babylon still uploads
      // the geometry for alpha=0 alpha-blended meshes, so isVisible is the
      // cheap path. setEnabled() is overkill (parent toggling overhead).
      if (entry.plane) entry.plane.isVisible = a > 0;
    }
  }

  /** Apply the renderer's selection (`this._selection.entityId`): drive the
   *  per-unit hex outline (swap thin → thick) and slide the camera to it.
   *  The standee silhouette itself no longer mutates on selection — the
   *  ground-level base disc was retired and the thick hex outline is the
   *  selection signal now. */
  _applySelectionAndFocus() {
    if (!this._scene) return;
    const newId  = this._selection?.entityId ?? null;
    const prevId = this._lastSelectedEntityId;
    if (newId === prevId) return;
    // Per-unit hex outline: swap the previously-selected unit back to its
    // thin always-on ring, and the newly-selected unit up to the thick ring.
    if (prevId && this._entityHexOutlines.has(prevId)) {
      const prevOutline = this._entityHexOutlines.get(prevId);
      // Restore the previous selection's thin ring only for local-side units —
      // enemy units never carry an always-on thin outline.
      prevOutline.thin.isVisible  = !!prevOutline.isLocal;
      prevOutline.thick.isVisible = false;
    }
    if (newId && this._entityHexOutlines.has(newId)) {
      const newOutline = this._entityHexOutlines.get(newId);
      newOutline.thin.isVisible  = false;
      newOutline.thick.isVisible = true;
    }
    if (newId && this._entityStandees.has(newId)) {
      const standee = this._entityStandees.get(newId);
      const BABYLON = this._babylon;
      // Turn the selected unit's animated model to face the camera so the
      // player sees the front of the rig rather than its side or back.
      // Only models with a paladinClone — generic cone+sphere pawns are
      // rotationally symmetric. The standee→camera direction is purely a
      // function of camera.alpha/beta (target shifts during focus don't
      // change the offset vector's direction), so setting rotation.y from
      // the current camera vector survives the focus animation.
      if (standee.paladinClone?.mesh && this._camera) {
        const dx = this._camera.position.x - this._camera.target.x;
        const dz = this._camera.position.z - this._camera.target.z;
        if (dx !== 0 || dz !== 0) {
          standee.paladinClone.mesh.rotation.y = Math.atan2(dx, dz);
        }
      }
      if (BABYLON && this._camera) {
        const newTarget = new BABYLON.Vector3(
          standee.plane.position.x,
          0,
          standee.plane.position.z,
        );
        // Selecting a unit should always feel like "the camera moved to it" —
        // skip the no-op-shift early-out that `_focusCamera` applies for
        // generic shifts, otherwise tiny target deltas (or the camera already
        // sitting on the unit because of an earlier pan) leave the player
        // wondering whether the click registered. Also zoom in toward the
        // unit when the camera is currently parked far away.
        const targetRadius = Math.min(
          this._camera.radius,
          Math.max(this._camera.lowerRadiusLimit ?? 4, SELECTION_FOCUS_RADIUS),
        );
        this._focusCamera(newTarget, targetRadius, { forceAnimate: true });
      }
    }
    this._lastSelectedEntityId = newId;
  }

  /** Animate the camera's target + radius to new values with a cubic
   *  ease-in-out over FOCUS_ANIM_FRAMES (≈300ms at 60fps). Skips the
   *  animation if the shift is below FOCUS_EPSILON, or if `opts.instant`
   *  is set (used on first frame). */
  _focusCamera(newTarget, newRadius, opts = {}) {
    const BABYLON = this._babylon;
    const camera  = this._camera;
    if (!BABYLON || !camera) return;

    if (opts.instant) {
      camera.target = newTarget;
      camera.radius = newRadius;
      return;
    }
    // `forceAnimate` overrides the small-shift early-out — callers that drive
    // user-facing focus changes (e.g. unit selection) want the animation even
    // when the delta is tiny, so the player gets a clear visual confirmation.
    if (!opts.forceAnimate
        && !shouldAnimateFocus(camera.target, camera.radius, newTarget, newRadius)) {
      camera.target = newTarget;
      camera.radius = newRadius;
      return;
    }

    const ease = new BABYLON.CubicEase();
    ease.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);

    const targetAnim = new BABYLON.Animation(
      'focusTarget', 'target', 60,
      BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT,
    );
    targetAnim.setKeys([
      { frame: 0,                 value: camera.target.clone() },
      { frame: FOCUS_ANIM_FRAMES, value: newTarget },
    ]);
    targetAnim.setEasingFunction(ease);

    const radiusAnim = new BABYLON.Animation(
      'focusRadius', 'radius', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT,
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT,
    );
    radiusAnim.setKeys([
      { frame: 0,                 value: camera.radius },
      { frame: FOCUS_ANIM_FRAMES, value: newRadius },
    ]);
    radiusAnim.setEasingFunction(ease);

    this._scene.stopAnimation(camera);
    this._scene.beginDirectAnimation(camera, [targetAnim, radiusAnim], 0, FOCUS_ANIM_FRAMES, false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Phase 5: animations, plan-ghost arrows, HP bars, floating text ────────
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Animation queue
  // ───────────────
  // Babylon's animation API is fire-and-forget per mesh; the resolution loop
  // in src/main.js expects a Promise-based "wait until everything in flight
  // has played out" contract. We track an `_animPromises` Set of pending
  // promises and `waitForAnimations()` awaits the snapshot. Each addX()
  // builds one Promise that resolves when its underlying Babylon animation
  // (or setTimeout for material-only effects) fires its onEnd callback. The
  // promise self-removes from the set on resolve so the set drains cleanly.
  //
  // HP bars (always-on)
  // ───────────────────
  // We render an HP bar above every standee, all the time — *not* only
  // post-damage. Brimstone's signal-density is already low (one or two leaders
  // and a handful of pawns per side); a bar that only shows on damage made it
  // ambiguous whether full-HP units were missing a bar or just at full. The
  // bar is a 1×1 plane scaled to 0.6×0.12, parented to the standee's base
  // disc with billboardMode_ALL, so it follows move animations for free.
  // Colour: red <33%, yellow <66%, green ≥66% — see hpBarColor().
  //
  // Plan arrow geometry
  // ───────────────────
  // We use Babylon's `MeshBuilder.CreateDashedLines` for arrows — Babylon
  // already implements dash spacing in-shader, which avoids manually slicing
  // tubes. Numbered badges are billboarded planes textured with a
  // DynamicTexture rendering the step number. Arrows are rebuilt every draw()
  // from `this.planGhostSteps`; the cost is small (only MOVE steps generate
  // arrows) and avoids tracking dirty state across plan edits.
  //
  // Movement / lunge / projectile / flash
  // ──────────────────────────────────────
  // Move and lunge drive `position.x`/`position.z` of the entity's standee
  // (+ base disc) via beginDirectAnimation. While the entity id is in
  // `_activeMoveIds` / `_activeLungeIds`, `_syncEntityStandees` skips the
  // `_positionStandee` snap that would otherwise yank the mesh back to its
  // state position on the next redraw. Projectiles spawn a small sphere that
  // animates between hex world positions then disposes. Attack flash briefly
  // tints the attacker + target tiles' emissive colour red.

  /** Tail-recursive helper: register a Promise as in-flight; self-remove on settle. */
  _trackAnim(promise) {
    this._animPromises.add(promise);
    promise.finally(() => this._animPromises.delete(promise));
    return promise;
  }

  /** Resolves once all in-flight Phase 5 animations have completed. Safe to
   *  call when nothing is animating — resolves on the microtask queue. */
  async waitForAnimations() {
    if (!this._animPromises || this._animPromises.size === 0) return;
    // Snapshot the set so any animations chained inside callbacks don't
    // extend this particular wait indefinitely.
    await Promise.all([...this._animPromises]);
  }

  /** Hard-clear every Phase 5 animation. Mirrors the 2D path's
   *  clearAnimations(): used between rounds to ensure no half-finished move
   *  or projectile bleeds into the next planning cycle. */
  clearAnimations() {
    this.clearAllLungeAnims(true);
    this.clearAllProjectileAnims();
    this.clearFlashes();
    if (this._scene) {
      for (const standee of this._entityStandees.values()) {
        this._scene.stopAnimation(standee.plane);
      }
    }
    this._activeMoveIds.clear();
    this._activeLungeIds.clear();
    // Don't manually reject — let Babylon's own onEnd callbacks fire as the
    // stopped animations drain; the Set will empty as their promises resolve.
  }

  // ─── Move animation ──────────────────────────────────────────────────────

  /** Slide an entity's standee from one hex to another over ~250ms (linear).
   *  Skips silently if Babylon hasn't loaded yet or the entity has no live
   *  standee — the next draw() will snap the entity to its destination
   *  position anyway via `_positionStandee`, so resolution can't get stuck
   *  on a missing animation. */
  addMoveAnim(entityId, fromCol, fromRow, toCol, toRow, _type, _owner, _title, path = null) {
    if (!this._scene || !this._babylon) return;
    const standee = this._entityStandees.get(entityId);
    if (!standee) return;
    const BABYLON = this._babylon;
    // If a multi-hex path is provided, build a polyline through every
    // waypoint (origin → path[0] → path[1] → ... → path[last]). The cone
    // visits each intermediate hex over the same MOVE_ANIM_MS window, so
    // a road move actually follows the road instead of cutting straight.
    // Without a path the call is a single segment from (fromCol,fromRow)
    // to (toCol,toRow) — the legacy 1-hex hop signature.
    const waypoints = [{ col: fromCol, row: fromRow }];
    if (Array.isArray(path) && path.length > 0) {
      for (const p of path) {
        if (p && typeof p.col === 'number' && typeof p.row === 'number') waypoints.push(p);
      }
    } else {
      waypoints.push({ col: toCol, row: toRow });
    }
    const worldPts = waypoints.map(p => hexToWorld(p.col, p.row));
    const { x: fromX, z: fromZ } = worldPts[0];
    const { x: toX,   z: toZ   } = worldPts[worldPts.length - 1];
    // Cone slide time tied to MOVE_ANIM_MS so the walking-speed-match
    // calc in _loadWalkingAnimation actually corresponds to real cone
    // motion. Scaled by the current playback speed multiplier so vfast
    // mode produces a faster cone slide AND a proportionally faster
    // walking cycle (next code block) → feet plant in every mode.
    const speedMul   = this._playbackSpeedMul ?? 1.0;
    const effMoveMs  = MOVE_ANIM_MS * speedMul;
    const FRAMES_MOVE = Math.max(1, Math.round(effMoveMs * 60 / 1000));

    // Cancel any in-flight move on this entity so plan-step "A→B→C" hops
    // don't queue up and play simultaneously.
    this._scene.stopAnimation(standee.plane);
    this._activeMoveIds.add(entityId);

    // Face the direction of motion: rotate the paladin clone around Y so
    // the model walks forward into its destination rather than sliding
    // sideways/backwards. Witch/zombie cone tokens are rotationally
    // symmetric, so we only yaw the paladin clone (when present).
    if (standee.paladinClone?.mesh && (toX !== fromX || toZ !== fromZ)) {
      standee.paladinClone.mesh.rotation.y = Math.atan2(toX - fromX, toZ - fromZ);
    }

    // Total polyline length in world units — for a 1-hex hop this is
    // one hexStep, for a road move tracing 2 hexes it's two hexSteps
    // (or whatever the actual XZ sum is for the path). The walking
    // animation playback rate scales by this length / one-hex so the
    // walk cycle covers the polyline at the cone's actual ground speed
    // and feet stay planted across the whole move.
    let totalLenWU = 0;
    for (let i = 1; i < worldPts.length; i++) {
      const dx = worldPts[i].x - worldPts[i - 1].x;
      const dz = worldPts[i].z - worldPts[i - 1].z;
      totalLenWU += Math.sqrt(dx * dx + dz * dz);
    }
    const hexStepWU = HEX_RADIUS_WORLD * Math.sqrt(3);
    if (totalLenWU > 0 && hexStepWU > 0) {
      const distMul = totalLenWU / hexStepWU;
      const walkGroup = this._paladinSource?.walkGroup;
      const baseRatio = this._walkingSource?.speedRatio ?? 1.0;
      if (walkGroup && 'speedRatio' in walkGroup) {
        // Dividing by speedMul makes a faster (smaller) speedMul produce
        // a higher walking speedRatio — i.e. a faster cycle that matches
        // the shorter cone-slide duration.
        walkGroup.speedRatio = (baseRatio * distMul) / Math.max(0.05, speedMul);
      }
    }

    // Build the polyline keyframes. Each segment is allocated frames
    // proportional to its length so the cone moves at a constant ground
    // speed across the whole path (no slow-then-fast on uneven splits).
    const keysX = [{ frame: 0, value: fromX }];
    const keysZ = [{ frame: 0, value: fromZ }];
    let accLen = 0;
    for (let i = 1; i < worldPts.length; i++) {
      const dx = worldPts[i].x - worldPts[i - 1].x;
      const dz = worldPts[i].z - worldPts[i - 1].z;
      accLen += Math.sqrt(dx * dx + dz * dz);
      const f = totalLenWU > 0
        ? Math.round(FRAMES_MOVE * (accLen / totalLenWU))
        : FRAMES_MOVE;
      keysX.push({ frame: f, value: worldPts[i].x });
      keysZ.push({ frame: f, value: worldPts[i].z });
    }
    const animX = new BABYLON.Animation('mvX', 'position.x', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animX.setKeys(keysX);
    const animZ = new BABYLON.Animation('mvZ', 'position.z', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animZ.setKeys(keysZ);

    // Set start positions immediately so the very first frame is at "from".
    standee.plane.position.x = fromX; standee.plane.position.z = fromZ;

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(standee.plane, [animX, animZ], 0, FRAMES_MOVE, false, 1, () => {
        this._activeMoveIds.delete(entityId);
        resolve();
      });
    });
    this._trackAnim(promise);
  }

  // ─── Lunge animation ─────────────────────────────────────────────────────

  /** Set the playback-speed multiplier the move/lunge animations use to
   *  compress their durations + scale the walking-animation playback
   *  rate. Pass a mode key from PLAYBACK_SPEED_MULS ('cinematic' |
   *  'fast' | 'vfast') or a raw number (clamped to [0.1, 2.0]). Called
   *  from main.js whenever the operator changes the playback speed. */
  setPlaybackSpeed(modeOrMul) {
    let mul;
    if (typeof modeOrMul === 'number' && Number.isFinite(modeOrMul)) {
      mul = Math.max(0.1, Math.min(2.0, modeOrMul));
    } else if (typeof modeOrMul === 'string' && PLAYBACK_SPEED_MULS[modeOrMul] != null) {
      mul = PLAYBACK_SPEED_MULS[modeOrMul];
    } else {
      mul = 1.0;
    }
    this._playbackSpeedMul = mul;
  }

  /** Slide the attacker's standee to the midpoint between attacker and target
   *  hexes and hold there until `returnAllLungeAnims()` is called. Mirrors
   *  the 2D contract: an "attack-in-progress" pose, not a one-shot. */
  addLungeAnim(entityId, fromCol, fromRow, toCol, toRow, _type, _owner, _title) {
    if (!this._scene || !this._babylon) return;
    const standee = this._entityStandees.get(entityId);
    if (!standee) return;
    const BABYLON = this._babylon;
    const { x: fromX, z: fromZ } = hexToWorld(fromCol, fromRow);
    const { x: toX,   z: toZ   } = hexToWorld(toCol,   toRow);
    const midX = (fromX + toX) * 0.5;
    const midZ = (fromZ + toZ) * 0.5;
    const lungeSpeedMul = this._playbackSpeedMul ?? 1.0;
    const FRAMES_LUNGE = Math.max(1, Math.round(LUNGE_ANIM_MS * lungeSpeedMul * 60 / 1000));

    this._scene.stopAnimation(standee.plane);
    this._activeLungeIds.add(entityId);

    // Face the lunge direction (same model-yaw logic as MOVE).
    if (standee.paladinClone?.mesh && (toX !== fromX || toZ !== fromZ)) {
      standee.paladinClone.mesh.rotation.y = Math.atan2(toX - fromX, toZ - fromZ);
    }

    standee.plane.position.x = fromX; standee.plane.position.z = fromZ;

    const animX = new BABYLON.Animation('lgX', 'position.x', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animX.setKeys([{ frame: 0, value: fromX }, { frame: FRAMES_LUNGE, value: midX }]);
    const animZ = new BABYLON.Animation('lgZ', 'position.z', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animZ.setKeys([{ frame: 0, value: fromZ }, { frame: FRAMES_LUNGE, value: midZ }]);

    // Stash the "home" position on the standee so returnAllLungeAnims() knows
    // where to slide back to without consulting the state (which may have
    // changed by then — e.g. a follow-up move).
    standee.lungeHome = { fromX, fromZ, midX, midZ };

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(standee.plane, [animX, animZ], 0, FRAMES_LUNGE, false, 1, resolve);
    });
    this._trackAnim(promise);
  }

  /** Reverse every active lunge: slide each standee back to its home hex.
   *  Releases the entity id from `_activeLungeIds` once the return completes
   *  so `_syncEntityStandees` resumes snapping the standee to state. */
  returnAllLungeAnims() {
    if (!this._scene || !this._babylon) return;
    const BABYLON = this._babylon;
    const FRAMES_RET = 10; // ≈170ms
    for (const [id, standee] of this._entityStandees) {
      if (!standee.lungeHome) continue;
      const { fromX, fromZ, midX, midZ } = standee.lungeHome;
      this._scene.stopAnimation(standee.plane);
      const animX = new BABYLON.Animation('lrX', 'position.x', 60,
        BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
      animX.setKeys([{ frame: 0, value: midX }, { frame: FRAMES_RET, value: fromX }]);
      const animZ = new BABYLON.Animation('lrZ', 'position.z', 60,
        BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
      animZ.setKeys([{ frame: 0, value: midZ }, { frame: FRAMES_RET, value: fromZ }]);
      const promise = new Promise(resolve => {
        this._scene.beginDirectAnimation(standee.plane, [animX, animZ], 0, FRAMES_RET, false, 1, () => {
          standee.lungeHome = null;
          this._activeLungeIds.delete(id);
          resolve();
        });
      });
      this._trackAnim(promise);
    }
  }

  /** Immediately snap all lunging entities back home and clear lunge state.
   *  Used between rounds when we don't want the return animation to play. */
  clearAllLungeAnims(skipResolve = false) {
    if (!this._scene) {
      this._activeLungeIds.clear();
      return;
    }
    for (const [id, standee] of this._entityStandees) {
      if (!standee.lungeHome) continue;
      this._scene.stopAnimation(standee.plane);
      const { fromX, fromZ } = standee.lungeHome;
      standee.plane.position.x = fromX; standee.plane.position.z = fromZ;
      standee.lungeHome = null;
      this._activeLungeIds.delete(id);
    }
    // skipResolve = called from clearAnimations() — promises will drain on
    // their own as the stopped Babylon animations fire their onEnd.
    void skipResolve;
  }

  // ─── Projectile animation ────────────────────────────────────────────────

  /** Spawn a small projectile mesh and animate it from source → target hex
   *  along a low parabolic arc. Mesh disposes when the animation ends. */
  addProjectileAnim(projectileType, fromCol, fromRow, toCol, toRow, opts = {}) {
    if (!this._scene || !this._babylon) return;
    const BABYLON = this._babylon;
    const { x: fromX, z: fromZ } = hexToWorld(fromCol, fromRow);
    const { x: toX,   z: toZ   } = hexToWorld(toCol,   toRow);
    const duration = opts.duration ?? 320;
    const FRAMES   = Math.max(6, Math.round(duration / 1000 * 60));

    const ball = BABYLON.MeshBuilder.CreateSphere(
      `proj_${projectileType ?? 'sparkle'}_${fromCol}_${fromRow}_${Date.now()}`,
      { diameter: 0.25 }, this._scene,
    );
    ball.isPickable = false;
    const mat = new BABYLON.StandardMaterial(`projmat_${ball.uniqueId}`, this._scene);
    const [r, g, b] = projectileColor01(projectileType);
    mat.diffuseColor  = new BABYLON.Color3(r, g, b);
    mat.emissiveColor = new BABYLON.Color3(r, g, b);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    ball.material = mat;

    // Generate a 3-key arc: source, apex (midpoint + bump), target.
    const apexY = 0.6 + Math.hypot(toX - fromX, toZ - fromZ) * 0.12;
    const midX  = (fromX + toX) * 0.5;
    const midZ  = (fromZ + toZ) * 0.5;
    ball.position.set(fromX, 0.5, fromZ);

    const animPos = new BABYLON.Animation('projPos', 'position', 60,
      BABYLON.Animation.ANIMATIONTYPE_VECTOR3, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animPos.setKeys([
      { frame: 0,           value: new BABYLON.Vector3(fromX, 0.5, fromZ) },
      { frame: FRAMES / 2,  value: new BABYLON.Vector3(midX,  apexY, midZ) },
      { frame: FRAMES,      value: new BABYLON.Vector3(toX,   0.5, toZ) },
    ]);

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(ball, [animPos], 0, FRAMES, false, 1, () => {
        if (typeof opts.onArrive === 'function') {
          try { opts.onArrive(); } catch (_) { /* swallow — playback continues */ }
        }
        ball.dispose();
        mat.dispose();
        resolve();
      });
    });
    this._trackAnim(promise);
  }

  /** No-op for the 3D path — projectile meshes self-dispose when their
   *  animation ends, so there is no detached "in-flight" list to clear. */
  clearAllProjectileAnims() { /* projectiles self-dispose */ }

  // ─── Attack hex flash ────────────────────────────────────────────────────

  /** Briefly tint the attacker and target tiles' emissive colour red.
   *  Restores the original material when the timeout fires so the tiles
   *  return to their normal hue. */
  addAttackAnim(actorCol, actorRow, targetCol, targetRow) {
    if (!this._scene || !this._babylon) return;
    this._flashTile(actorCol,  actorRow,  [0.45, 0.20, 0.05]); // amber actor
    this._flashTile(targetCol, targetRow, [0.55, 0.10, 0.10]); // red target
  }

  _flashTile(col, row, emissive01) {
    if (!this._scene || !this._babylon) return;
    const tileMesh = this._tileMeshes.find(m => m.metadata?.col === col && m.metadata?.row === row);
    if (!tileMesh) return;
    const BABYLON = this._babylon;
    // Clone the current material so per-flash state doesn't leak into the
    // shared per-colour material cache (every grass tile shares one material).
    const original = tileMesh.material;
    const flashMat = new BABYLON.StandardMaterial(`flash_${col}_${row}_${Date.now()}`, this._scene);
    flashMat.diffuseColor  = original.diffuseColor?.clone() ?? new BABYLON.Color3(0.4, 0.4, 0.4);
    flashMat.specularColor = new BABYLON.Color3(0, 0, 0);
    flashMat.emissiveColor = new BABYLON.Color3(emissive01[0], emissive01[1], emissive01[2]);
    tileMesh.material = flashMat;

    const duration = 220;
    const promise = new Promise(resolve => {
      setTimeout(() => {
        // Defensive: tile may have been disposed (map rebuild) — only restore
        // if the tile mesh is still in the scene.
        if (!tileMesh.isDisposed?.()) {
          // Don't blindly slam the pre-flash material back on: the fog veil is
          // diff-based, so if this hex's fog state changed during the ~220ms
          // flash window (e.g. the turn resolved and the hex fell out of /
          // into sight) the captured `original` is now stale. Restoring it
          // desyncs the mesh from `_fogActiveSet`, and the next veil pass — a
          // no-op since the set already says "correct" — never repaints it,
          // leaving the hex stuck. Recompute the material from the CURRENT fog
          // state instead so the veil and the mesh can't drift apart.
          tileMesh.material = this._currentTileMaterial(col, row, tileMesh, original);
        }
        flashMat.dispose();
        resolve();
      }, duration);
    });
    this._trackAnim(promise);
  }

  /** Material a tile should currently display given the live fog state. Mirrors
   *  `_setTileFogged`'s material selection so callers that touch a tile's
   *  material outside the veil (e.g. `_flashTile`'s delayed restore) can hand
   *  back a fog-consistent material rather than a stale captured one. Falls
   *  back to `fallback` when the tile isn't in state and there's no baseColor
   *  to synthesise a colour-only material from. */
  _currentTileMaterial(col, row, tileMesh, fallback = null) {
    const key    = hexKey(col, row);
    const fogged = this._fogActiveSet.has(key);
    const tile   = this.state?.tiles?.get(key);
    if (tile) return this._tileMaterialFor(tile, { fogged });
    const baseColor = tileMesh?.metadata?.baseColor;
    if (!baseColor) return fallback;
    return fogged ? this._fogMaterialFor(baseColor) : this._materialFor(baseColor);
  }

  // ─── HP-change flash + floating text ─────────────────────────────────────

  /** Floating "-2" / "+1" text above a hex when an entity gains/loses HP. */
  addHpChangeFlash(col, row, delta) {
    if (!this._scene || !this._babylon || !delta) return;
    const label = delta < 0 ? `${delta}` : `+${delta}`;
    const colour = delta < 0 ? '#ff5050' : '#60ff70';
    this._spawnFloatingText(col, row, label, colour, 900);
  }

  /** Generic hex flash — used for combat result text ("HIT 2", "CRUSH 3",
   *  "MISS") and other one-shot floaters. The colour/duration knobs match the
   *  2D `addFlash` signature so callers don't need to know which renderer is
   *  active. Background colour is ignored — 3D floaters don't have a fill. */
  addFlash(col, row, text, _color, durationMs = 900, fontScale = 0.85, textColor = null) {
    if (!this._scene || !this._babylon) return;
    if (!text) return; // 2D used empty-text flashes for hex tints; tint goes through addAttackAnim now
    this._spawnFloatingText(col, row, String(text), textColor ?? '#ffe0a0', durationMs, fontScale);
  }

  clearFlashes() {
    if (!this._scene) return;
    // Floating-text meshes manage their own lifecycle through Babylon
    // animations; if anyone wants to brute-force clear them mid-round, they
    // can iterate the scene's transient floater group. For now, no-op — the
    // floaters expire on their own ~700ms after spawn and they're cosmetic.
  }

  _spawnFloatingText(col, row, text, hexColor = '#ffe0a0', durationMs = 700, fontScale = 1) {
    if (typeof document === 'undefined') return;
    const BABYLON = this._babylon;
    const { x, z } = hexToWorld(col, row);

    const tex = new BABYLON.DynamicTexture(
      `floatTex_${Date.now()}`,
      { width: FLOAT_TEXT_TEX_WIDTH, height: FLOAT_TEXT_TEX_HEIGHT },
      this._scene,
      false,
    );
    tex.hasAlpha = true;
    paintFloaterText(tex.getContext(), {
      width:    FLOAT_TEXT_TEX_WIDTH,
      height:   FLOAT_TEXT_TEX_HEIGHT,
      text,
      fillColor: hexColor,
      fontScale,
    });
    tex.update();

    const plane = BABYLON.MeshBuilder.CreatePlane(`float_${col}_${row}_${Date.now()}`,
      { width: FLOAT_TEXT_PLANE_WIDTH, height: FLOAT_TEXT_PLANE_HEIGHT }, this._scene);
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable    = false;
    // Render above all world geometry so floaters never hide behind terrain
    // or standees — matches the unit-icon badge group (2).
    plane.renderingGroupId = 2;
    const mat = new BABYLON.StandardMaterial(`floatMat_${plane.uniqueId}`, this._scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    // Flat-lit UI sticker — text stays at full brightness across every
    // phase and is never dimmed by scene fog.
    applyFlatUnitIconMaterial(BABYLON, mat);
    plane.material = mat;

    // Spawn above the tallest possible token (leader-sized cone + sphere).
    const startY = STANDEE_BASE_Y_OFFSET
      + STANDEE_BASE_THICKNESS
      + STANDEE_CONE_HEIGHT * STANDEE_LEADER_HEIGHT_MUL
      + STANDEE_SPHERE_DIAMETER * STANDEE_LEADER_WIDTH_MUL
      + 0.4;
    const endY   = startY + 1.2;
    plane.position.set(x, startY, z);
    plane.visibility = 1;

    const FRAMES_FLOAT = Math.max(6, Math.round(durationMs / 1000 * 60));
    const animPos = new BABYLON.Animation('floatY', 'position.y', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animPos.setKeys([{ frame: 0, value: startY }, { frame: FRAMES_FLOAT, value: endY }]);

    const animFade = new BABYLON.Animation('floatA', 'visibility', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    // Hold full alpha for half the duration then fade — matches the 2D feel.
    animFade.setKeys([
      { frame: 0,                       value: 1 },
      { frame: Math.floor(FRAMES_FLOAT / 2), value: 1 },
      { frame: FRAMES_FLOAT,            value: 0 },
    ]);

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(plane, [animPos, animFade], 0, FRAMES_FLOAT, false, 1, () => {
        plane.dispose();
        mat.dispose();
        tex.dispose();
        resolve();
      });
    });
    this._trackAnim(promise);
  }

  // ─── Reaction effects: Sound Horn ring + Power-Node-Discovered burst ────

  /** Expanding flat ring at a hex — the 3D equivalent of the gold horn pulse
   *  in `src/renderer.js`. Triggered from the resolution loop's SOUND_HORN
   *  phase to telegraph "this leader just sounded the horn" before the
   *  encounter dialog opens. Self-disposes when the radius animation
   *  completes; the resolution loop awaits it via `waitForAnimations()`. */
  addSoundHorn(col, row, color = '#d4a72c') {
    if (!this._scene || !this._babylon) return;
    const BABYLON = this._babylon;
    const { x, z } = hexToWorld(col, row);

    // CreateTorus builds a unit-diameter ring; the scaling animation grows
    // it from SOUND_HORN_RING_R0 → SOUND_HORN_RING_R1. Y is fixed to a
    // ground-hugging band (above the ribbon apex, below the icon billboards)
    // so the ring stays flat against the terrain even when the camera tilts.
    const ring = BABYLON.MeshBuilder.CreateTorus(
      `sound_horn_${col}_${row}_${Date.now()}`,
      { diameter: 2, thickness: SOUND_HORN_RING_TUBE, tessellation: 48 },
      this._scene,
    );
    ring.isPickable = false;
    ring.position.set(x, SOUND_HORN_RING_Y, z);

    const mat = new BABYLON.StandardMaterial(`sound_horn_mat_${ring.uniqueId}`, this._scene);
    const [r, g, b] = cssHexToRgb01(color);
    mat.diffuseColor   = new BABYLON.Color3(r, g, b);
    mat.emissiveColor  = new BABYLON.Color3(r, g, b);
    mat.specularColor  = new BABYLON.Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mat.alpha = 1;
    ring.material = mat;

    // Diameter=2 ⇒ base radius=1, so scaling.x|z directly = world radius.
    ring.scaling.set(SOUND_HORN_RING_R0, 1, SOUND_HORN_RING_R0);

    const FRAMES = Math.max(6, Math.round(SOUND_HORN_RING_MS / 1000 * 60));
    const animScaleX = new BABYLON.Animation('shScaleX', 'scaling.x', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animScaleX.setKeys([
      { frame: 0,      value: SOUND_HORN_RING_R0 },
      { frame: FRAMES, value: SOUND_HORN_RING_R1 },
    ]);
    const animScaleZ = new BABYLON.Animation('shScaleZ', 'scaling.z', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animScaleZ.setKeys([
      { frame: 0,      value: SOUND_HORN_RING_R0 },
      { frame: FRAMES, value: SOUND_HORN_RING_R1 },
    ]);
    const animAlpha = new BABYLON.Animation('shAlpha', 'material.alpha', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animAlpha.setKeys([
      { frame: 0,      value: 1 },
      { frame: FRAMES, value: 0 },
    ]);

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(ring, [animScaleX, animScaleZ, animAlpha],
        0, FRAMES, false, 1, () => {
          ring.dispose();
          mat.dispose();
          resolve();
        });
    });
    this._trackAnim(promise);
  }

  /** Starburst + floating label at a node hex — the 3D equivalent of the
   *  2D node-reveal pulse. `hexes` is the cluster of hexes covered by the
   *  node (usually 1, sometimes 3 for multi-hex nodes); the burst spawns
   *  at the centroid and the label sits above it. */
  addNodeDiscovered(hexes, color = '#ffd54a', label = 'Power Node Discovered') {
    if (!this._scene || !this._babylon) return;
    if (!Array.isArray(hexes) || hexes.length === 0) return;
    const BABYLON = this._babylon;

    // Centroid of the cluster — single-hex nodes collapse to their own centre.
    let cx = 0, cz = 0;
    for (const h of hexes) {
      const { x, z } = hexToWorld(h.col, h.row);
      cx += x; cz += z;
    }
    cx /= hexes.length; cz /= hexes.length;
    const labelHex = hexes[0];

    // Build N rays radiating from the origin; scale animates 0 → 1 so the
    // burst appears to grow outward from the centre.
    const endpoints = nodeDiscoveredRayEndpoints(
      NODE_DISCOVERED_RAY_COUNT, NODE_DISCOVERED_R1,
    );
    const lines = endpoints.map(p => [
      new BABYLON.Vector3(0, 0, 0),
      new BABYLON.Vector3(p.x, 0, p.z),
    ]);
    const burst = BABYLON.MeshBuilder.CreateLineSystem(
      `node_burst_${Date.now()}`,
      { lines, updatable: false },
      this._scene,
    );
    burst.isPickable = false;
    burst.position.set(cx, NODE_DISCOVERED_Y, cz);
    const [r, g, b] = cssHexToRgb01(color);
    burst.color = new BABYLON.Color3(r, g, b);
    burst.alpha = 1;
    burst.scaling.set(0, 1, 0);

    const FRAMES = Math.max(6, Math.round(NODE_DISCOVERED_MS / 1000 * 60));
    const animSX = new BABYLON.Animation('ndSX', 'scaling.x', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animSX.setKeys([{ frame: 0, value: 0 }, { frame: FRAMES, value: 1 }]);
    const animSZ = new BABYLON.Animation('ndSZ', 'scaling.z', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animSZ.setKeys([{ frame: 0, value: 0 }, { frame: FRAMES, value: 1 }]);
    const animAlpha = new BABYLON.Animation('ndAlpha', 'alpha', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animAlpha.setKeys([
      { frame: 0,                          value: 1 },
      { frame: Math.floor(FRAMES / 2),     value: 1 },
      { frame: FRAMES,                     value: 0 },
    ]);
    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(burst, [animSX, animSZ, animAlpha],
        0, FRAMES, false, 1, () => { burst.dispose(); resolve(); });
    });
    this._trackAnim(promise);

    // Floating label above the cluster. Reuses the existing floater pipeline
    // — t-d5fed35e (floater rework) will resize it once it lands.
    if (label) {
      this._spawnFloatingText(
        labelHex.col, labelHex.row,
        label, color,
        NODE_DISCOVERED_LABEL_MS, 0.6,
      );
    }
  }

  // ─── Floating unit-icon billboards (icon disc + HP ring) ────────────────
  //
  // Each alive entity gets a billboarded square plane parented to its base
  // disc. The plane's DynamicTexture composites two layers:
  //   • a circular portrait sticker (clipped to the inner disc)
  //   • a coloured arc rim around it (red/yellow/green by HP fraction)
  //
  // Dead entities (tombstones) do NOT get a badge — the desaturated
  // cone+sphere is intentionally bare so the player reads it as "gone".
  //
  // Sync runs once per draw() pass *after* `_syncEntityStandees`, so the
  // base disc + cone meshes exist before we try to parent a badge to them.
  // The diff is keyed off the same alive-entity set the standee sync uses,
  // so a dead/missing entity disposes its badge in the same tick its
  // standee disappears.

  /** Per-frame diff: add badges for newly-spawned entities, repaint when HP
   *  or asset id changed, dispose badges for entities that no longer exist
   *  or just died. Idempotent — the repaint path early-exits when the
   *  (hp, maxHp, assetId) tuple is unchanged. */
  _syncEntityIconBillboards() {
    if (!this._scene || !this.state?.entities) return;
    if (!this._babylon || typeof document === 'undefined') return;
    const seen = new Set();
    for (const e of this.state.entities) {
      if (!e || !e.alive) continue;
      if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
      if (e.hp == null || e.maxHp == null) continue;
      const standee = this._entityStandees.get(e.id);
      if (!standee) continue; // standee not built yet — pick up next tick
      seen.add(e.id);
      let entry = this._unitIconBadges.get(e.id);
      if (!entry) entry = this._createUnitIconBadge(standee, e);
      if (!entry) continue;
      const assetId = this._assetIdFor(e);
      // Recompute portrait availability each tick so badges painted before
      // the tilemap finished loading get a real portrait the moment the
      // asset arrives (otherwise the unchanged-tuple early-exit would skip
      // them — that's the gray-circle bug fixed here).
      const portraitSource = resolveUnitIconPortrait(
        this._tilemapImg, this._spriteRects, assetId,
      );
      if (entry.lastHp === e.hp
          && entry.lastMax === e.maxHp
          && entry.lastAssetId === assetId
          && entry.lastHadPortrait === portraitSource.hasPortrait) {
        continue;
      }
      this._repaintUnitIconBadge(entry, e, portraitSource);
      entry.lastHp           = e.hp;
      entry.lastMax          = e.maxHp;
      entry.lastAssetId      = assetId;
      entry.lastHadPortrait  = portraitSource.hasPortrait;
    }
    // Dispose badges for entities that no longer exist or just died.
    for (const id of [...this._unitIconBadges.keys()]) {
      if (!seen.has(id)) this._disposeUnitIconBadge(id);
    }
  }

  _createUnitIconBadge(standee, entity) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!BABYLON || !scene || typeof document === 'undefined') return null;
    const tex = new BABYLON.DynamicTexture(
      `unitIconTex_${entity.id}`,
      { width: UNIT_ICON_TEX_SIZE, height: UNIT_ICON_TEX_SIZE },
      scene,
      /* generateMipMaps */ false,
    );
    tex.hasAlpha = true;
    tex.updateSamplingMode(BABYLON.Texture.BILINEAR_SAMPLINGMODE);
    const mat = new BABYLON.StandardMaterial(`unitIconMat_${entity.id}`, scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    // Flat UI sticker — see `applyFlatUnitIconMaterial`. Crucially keeps the
    // badge at identical brightness across every phase.
    applyFlatUnitIconMaterial(BABYLON, mat);

    const plane = BABYLON.MeshBuilder.CreatePlane(
      `unitIcon_${entity.id}`,
      { width: UNIT_ICON_PLANE_SIZE, height: UNIT_ICON_PLANE_SIZE },
      scene,
    );
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable    = false;
    plane.material      = mat;
    // Parent to the cone (standee.plane) — the base disc that used to anchor
    // this billboard is gone. `iconBillboardYRelativeToCone` gives the local
    // Y above the cone centre so the badge keeps its world-Y placement above
    // the cone+sphere head.
    plane.parent        = standee.plane;
    // Render above all world geometry (terrain, ribbons, buildings, standees,
    // hex outlines — all now in group 0). UI badge must never be occluded.
    plane.renderingGroupId = 2;
    plane.position.set(0, iconBillboardYRelativeToCone(standee.leader), 0);
    // 80% alpha — lets the paladin model behind show through when camera
    // angles bring them close on screen. Plane scale stays at the natural
    // world-space size (UNIT_ICON_PLANE_SIZE) — anchored above the model's
    // head, billboarded to face camera, but scales with the model so it
    // feels attached rather than a screen-space overlay.
    mat.alpha = UNIT_ICON_PLANE_ALPHA;

    const entry = {
      plane, mat, tex,
      leader: !!standee.leader,
      lastHp: -1, lastMax: -1, lastAssetId: '__pending__',
      // Track whether the last paint actually drew the portrait sprite. The
      // race we're guarding against: badge created before `loadImages()`
      // resolves → first paint goes out with `hasPortrait=false` (gray
      // fallback disc). When the tilemap arrives later, the (hp, max,
      // assetId) tuple is unchanged so the diff would otherwise skip the
      // repaint and the badge would stay gray forever.
      lastHadPortrait: false,
      leader: standee.leader,
    };
    this._unitIconBadges.set(entity.id, entry);
    return entry;
  }

  _repaintUnitIconBadge(entry, entity, portraitSource) {
    const ctx = entry.tex.getContext();
    paintUnitIconBadge(ctx, {
      size: UNIT_ICON_TEX_SIZE,
      portraitImg:  portraitSource.hasPortrait ? portraitSource.img  : null,
      portraitRect: portraitSource.hasPortrait ? portraitSource.rect : null,
      hp: entity.hp,
      maxHp: entity.maxHp,
    });
    entry.tex.update();
  }

  _disposeUnitIconBadge(entityId) {
    const entry = this._unitIconBadges.get(entityId);
    if (!entry) return;
    entry.plane.dispose();
    entry.mat.dispose();
    entry.tex.dispose();
    this._unitIconBadges.delete(entityId);
  }

  // ─── Highlight overlay (movement / target hexes) ─────────────────────────
  //
  // ui.js publishes `fill` overlays in the `highlight-disc` layer (ids
  // 'move-targets' / 'battle-targets' / 'battle-hex-targets') via setOverlay
  // whenever a unit is selected or the user is targeting an action. The fill
  // builder lays a thin flat hex-outline ribbon on each tagged tile in the
  // overlay's chosen colour.
  //
  // Rebuild policy: signature-diff each draw. Highlights rarely change frame
  // to frame (only on selection / targeting events), so the cost is near-zero
  // when nothing moved and a handful of disposals + creations when it did.

  /**
   * The single overlay dispatcher. Runs the producers (which derive transient
   * state-driven overlays into `this._overlays`) then the per-kind consumers
   * (which build meshes by reading ONLY the overlay descriptors). Replaces the
   * four legacy `_sync*` entry points the draw loop used to call by hand.
   *
   * Each builder owns its own signature/early-out, so calling the dispatcher
   * every draw is cheap when nothing overlay-related changed.
   */
  _syncOverlays() {
    if (!this._scene || !this._babylon) return;

    // ── Producers ──────────────────────────────────────────────────────────
    // Derive the transient, state-driven overlays into `this._overlays`. The
    // selection / hover / movement-target overlays are pushed in directly by
    // ui.js (setSelection / setHover / setOverlay); these three derive from
    // game state each frame because they track entity positions + node control.
    this._publishPlanMoveOverlays();
    this._publishPlanBattleOverlays();
    this._publishObjectiveRingOverlays();

    // ── Consumers ──────────────────────────────────────────────────────────
    // Dispatch by (kind, layer) to per-kind builders. Each builder reads ONLY
    // the published overlay descriptors — never game state — so the overlay
    // map is the single source of truth for what gets drawn.
    this._syncSelectionOverlays();   // kind:'outline'    layer:'selection'
    this._buildFillOverlays();       // kind:'fill'       layer:'highlight-disc'
    this._buildObjectiveRings();     // kind:'ring-pulse' layer:'objective-ring'
    this._buildPlanArrows();         // kind:'plan-arrow' layer:'plan-arrow' (move)
    this._buildPlanBattleArrows();   // kind:'plan-arrow' layer:'plan-arrow' (battle)
  }

  /**
   * Build the movement / battle / battle-hex target rings. Walks every
   * `kind:'fill'` overlay in the `highlight-disc` layer, alphabetical by id so
   * the nested Y for each is stable across frames, and lays a thin hex-outline
   * ribbon on each tagged hex. Signature-diffed each draw so the rebuild is
   * near-free when nothing targeting-related changed.
   */
  _buildFillOverlays() {
    if (!this._scene || !this._babylon) return;

    // Fill overlays in the highlight-disc layer, alphabetical by id so the
    // nested Y for each is stable across frames.
    const ids = [];
    for (const [id, ov] of this._overlays) {
      if (ov.kind === 'fill' && ov.layer === 'highlight-disc') ids.push(id);
    }
    ids.sort();

    let sig = '';
    ids.forEach((id, i) => { sig += `${id}@${i}:${overlaySignature(this._overlays.get(id))}|`; });
    if (sig === this._highlightSig) return;
    this._highlightSig = sig;

    for (const mesh of this._highlightMeshes) mesh.dispose();
    this._highlightMeshes = [];
    if (ids.length === 0) return;

    const BABYLON = this._babylon;
    ids.forEach((id, nestedIndex) => {
      const ov    = this._overlays.get(id);
      const color = ov.style?.color || HIGHLIGHT_DEFAULT_RGBA;
      const y     = yForLayer('highlight-disc', nestedIndex);
      for (const key of Array.from(ov.hexes).sort()) {
        const [col, row] = key.split(',').map(Number);
        if (!Number.isFinite(col) || !Number.isFinite(row)) continue;
        // Hex *outline ring* (not a flat tinted disc — that lit the whole tile
        // a muddy colour). Built as a ribbon between two concentric hex polygons
        // so the ring keeps its width regardless of camera distance.
        const { outer, inner } = hexOutlinePaths(col, row, HIGHLIGHT_OUTER_R, HIGHLIGHT_INNER_R, y);
        const toVec = p => new BABYLON.Vector3(p.x, p.y, p.z);
        const ribbon = BABYLON.MeshBuilder.CreateRibbon(
          `highlight_${id}_${col}_${row}`,
          {
            pathArray: [outer.map(toVec), inner.map(toVec)],
            sideOrientation: BABYLON.Mesh.DOUBLESIDE,
          },
          this._scene,
        );
        ribbon.parent     = this._mapRoot;
        ribbon.material   = this._highlightMaterialFor(ov.kind, color);
        ribbon.isPickable = false;
        this._highlightMeshes.push(ribbon);
      }
    });
  }

  /**
   * Build the selection + hover outline rings from the unified overlay map.
   * Walks `kind:'outline'` overlays in the `selection` layer (ids 'hover' and
   * 'selection'), laying one tube ring per tagged hex. The selection ring is
   * owner-tinted (resolved from `meta.entityId`) with a glow-grade emissive;
   * the hover ring is a subtle white-ish thin tube. Alphabetical id order →
   * 'selection' nests above 'hover' in the Y band so it reads on top.
   *
   * Signature-diffed like `_syncOverlays`: selection / hover only change on
   * click + mouse-move events, so the rebuild is skipped when nothing moved.
   * The signature folds in the resolved owner colour (overlaySignature ignores
   * `meta`) so retargeting the selection to another unit on the same hex still
   * rebuilds with the new tint.
   */
  _syncSelectionOverlays() {
    if (!this._scene || !this._babylon) return;

    const ids = [];
    for (const [id, ov] of this._overlays) {
      if (ov.kind === 'outline' && ov.layer === 'selection') ids.push(id);
    }
    ids.sort();

    // Resolve each overlay's draw colour up front so it folds into the signature.
    const resolved = ids.map((id, i) => {
      const ov = this._overlays.get(id);
      const entityId = ov.meta?.entityId ?? null;
      const entity = entityId != null
        ? this.state?.entities?.find(e => e.id === entityId) : null;
      const glow = !!ov.style?.glow;
      let rgb, alpha;
      if (entity) {
        rgb = cssHexToRgb01(unitHexOutlineColor(entity));
        alpha = 1;
      } else {
        const css = ov.style?.color || (glow ? '#f5c842' : 'rgba(255,255,255,0.3)');
        if (css.startsWith('#')) { rgb = cssHexToRgb01(css); alpha = 1; }
        else { const p = parseRgba01(css); rgb = [p[0], p[1], p[2]]; alpha = p[3]; }
      }
      return { id, ov, glow, rgb, alpha, y: yForLayer('selection', i) };
    });

    let sig = '';
    for (const r of resolved) {
      sig += `${r.id}@${r.y}:${overlaySignature(r.ov)}:${r.rgb.join(',')}:${r.alpha}|`;
    }
    if (sig === this._selectionOverlaySig) return;
    this._selectionOverlaySig = sig;

    for (const mesh of this._selectionOverlayMeshes) mesh.dispose();
    this._selectionOverlayMeshes = [];
    if (resolved.length === 0) return;

    const BABYLON = this._babylon;
    for (const { id, ov, glow, rgb, alpha, y } of resolved) {
      const tube = glow ? UNIT_HEX_OUTLINE_THICK_TUBE : UNIT_HEX_OUTLINE_THIN_TUBE;
      const emissiveMul = glow
        ? UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL
        : UNIT_HEX_OUTLINE_THIN_EMISSIVE_MUL;
      const material = this._selectionOverlayMaterialFor(rgb, alpha, emissiveMul);
      for (const key of Array.from(ov.hexes).sort()) {
        const [col, row] = key.split(',').map(Number);
        if (!Number.isFinite(col) || !Number.isFinite(row)) continue;
        const path = unitHexOutlineRingPath(undefined, y).map(
          p => new BABYLON.Vector3(p.x, p.y, p.z),
        );
        const ring = BABYLON.MeshBuilder.CreateTube(`selOverlay_${id}_${col}_${row}`, {
          path,
          radius:          tube,
          tessellation:    6,
          sideOrientation: BABYLON.Mesh.DOUBLESIDE,
        }, this._scene);
        const { x, z } = hexToWorld(col, row);
        ring.position.x     = x;
        ring.position.z     = z;
        ring.parent         = this._mapRoot;
        ring.material       = material;
        ring.isPickable     = false;
        ring.renderingGroupId = 0;
        this._selectionOverlayMeshes.push(ring);
      }
    }
  }

  /** Lazy, colour-keyed material for a selection / hover ring. Emissive is
   *  capped at `emissiveMul × diffuse` (glow-grade for selection, low for the
   *  hover). Alpha lets the hover ring read as a faint white line. */
  _selectionOverlayMaterialFor(rgb, alpha, emissiveMul) {
    const [r, g, b] = rgb;
    const cacheKey = `${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)}|${alpha}|${emissiveMul}`;
    if (this._selectionOverlayMatCache.has(cacheKey)) {
      return this._selectionOverlayMatCache.get(cacheKey);
    }
    const BABYLON = this._babylon;
    const mat = new BABYLON.StandardMaterial(`selOverlayMat_${cacheKey}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(r, g, b);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor = new BABYLON.Color3(r * emissiveMul, g * emissiveMul, b * emissiveMul);
    mat.alpha = alpha;
    mat.backFaceCulling = false;
    this._selectionOverlayMatCache.set(cacheKey, mat);
    return mat;
  }

  /** Cached `ring-pulse` material keyed by `overlayMaterialKey(rgb, alpha,
   *  glow)`. Overlays that share a colour share one StandardMaterial so the
   *  builder never re-allocates per ring. The emissive is `rgb` (a bright,
   *  self-lit tint so the ring reads at any phase); the diffuse is a dim 0.4×
   *  wash. Used for the static node identifier rings — controller rings keep
   *  per-instance materials because they recolour in place when a node flips. */
  _ringPulseMaterialFor(rgb, alpha = 1, glow = true) {
    const key = overlayMaterialKey(rgb, alpha, glow);
    if (this._ringPulseMatCache.has(key)) return this._ringPulseMatCache.get(key);
    const BABYLON = this._babylon;
    const [r, g, b] = rgb;
    const mat = new BABYLON.StandardMaterial(`ringPulseMat_${key}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(r * 0.4, g * 0.4, b * 0.4);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor = new BABYLON.Color3(r, g, b);
    mat.alpha = alpha;
    this._ringPulseMatCache.set(key, mat);
    return mat;
  }

  /** Cached overlay material keyed by `(kind, color-css)`. Hit each frame for
   *  the same colour set, so the dispatcher never disposes+rebuilds materials. */
  _highlightMaterialFor(kind, rgbaCss) {
    const cacheKey = `${kind}|${rgbaCss}`;
    if (this._highlightMatCache.has(cacheKey)) return this._highlightMatCache.get(cacheKey);
    const BABYLON = this._babylon;
    const [dr, dg, db] = deepenHighlight01(parseRgba01(rgbaCss));
    const mat = new BABYLON.StandardMaterial(`highlightMat_${cacheKey}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(dr, dg, db);
    // Emissive at half the deepened diffuse — keeps the ring legible across
    // dawn/day/dusk/night phases without blowing into the glow layer.
    mat.emissiveColor = new BABYLON.Color3(dr * 0.5, dg * 0.5, db * 0.5);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.alpha = HIGHLIGHT_OVERLAY_ALPHA;
    mat.backFaceCulling = false;
    this._highlightMatCache.set(cacheKey, mat);
    return mat;
  }

  // ─── Plan ghost arrows ───────────────────────────────────────────────────

  /** Publish a `plan-arrow` overlay per MOVE step. This is the producer: it
   *  derives the canonical descriptors from `planGhostSteps` (the move's
   *  from/to hexes, owner colour, badge number) and writes them into the
   *  overlay map. `_buildPlanArrows` is the consumer — it materialises meshes
   *  by reading these descriptors back, never `planGhostSteps`. Idempotent —
   *  re-derived each call; stale move overlays are cleared first. */
  _publishPlanMoveOverlays() {
    for (const id of Array.from(this._overlays.keys())) {
      if (id.startsWith('plan-move-')) this._overlays.delete(id);
    }
    const steps = this.planGhostSteps;
    if (!steps) return;
    for (const step of steps) {
      if (!step.arrow) continue;
      const { entityId, fromCol, fromRow, toCol, toRow } = step.arrow;
      const ent = this.state?.entities?.find?.(e => e.id === entityId);
      const ownerColor = entityBaseColor(ent ?? {});
      const stepNumber = step.stepNumber ?? 0;
      const id = `plan-move-${entityId}-${stepNumber}`;
      this.setOverlay(id, makeOverlay({
        id, kind: 'plan-arrow', layer: 'plan-arrow',
        path: [{ col: fromCol, row: fromRow }, { col: toCol, row: toRow }],
        style: { color: ownerColor, alpha: 1 },
        meta: { stepIndex: stepNumber, badge: String(stepNumber), entityId },
      }));
    }
  }

  /** Consumer for the move `plan-arrow` overlays. Reads the descriptors
   *  `_publishPlanMoveOverlays` wrote into `this._overlays` — never
   *  `planGhostSteps` — and materialises the dashed per-entity path plus a
   *  waypoint puck + numbered badge per step. Rebuilt from scratch each draw
   *  (gated by a signature early-out); the per-call cost is a handful of
   *  meshes per MOVE step. */
  _buildPlanArrows() {
    // Babylon loads lazily — bail before the signature check so the first
    // draw() after init isn't stamped as "already rendered" while the build
    // phase below is still no-op.
    if (!this._babylon || !this._scene) return;

    // Change-detect: the signature is derived from `planGhostSteps` (the
    // deterministic source the publisher converts into the move overlays), so
    // it changes iff the published descriptors change — yet the geometry below
    // is built entirely from the overlay map. During plan editing draw() fires
    // on every hover / selection event, so this early-out saves GC + GPU churn.
    const sig = planArrowsSignature(this.planGhostSteps, this.state?.entities);
    if (sig === this._planArrowSig) return;
    this._planArrowSig = sig;

    // Dispose previous frame's plan marker geometry first.
    for (const arrow of this._planArrowMeshes) {
      arrow.disc?.dispose();
      arrow.discMat?.dispose();
      arrow.badge?.dispose();
      arrow.badgeMat?.dispose();
      arrow.badgeTex?.dispose();
      arrow.line?.dispose();
      if (arrow.dashes) for (const m of arrow.dashes) m.dispose();
      arrow.dashMat?.dispose();
    }
    this._planArrowMeshes = [];

    // Collect the move `plan-arrow` overlays (excludes the battle variant).
    const moveOvs = [];
    for (const ov of this._overlays.values()) {
      if (ov.kind === 'plan-arrow' && ov.layer === 'plan-arrow'
          && ov.meta?.variant !== 'battle') {
        moveOvs.push(ov);
      }
    }
    if (moveOvs.length === 0) return;

    const BABYLON = this._babylon;
    const parseKey = (k) => { const [col, row] = k.split(',').map(Number); return { col, row }; };

    // Group overlays by entity, ordered by stepIndex, so we can draw a dashed
    // line connecting consecutive waypoints (origin → step 1 → step 2 → …).
    // Each overlay's `path` is [from, to]; the chain for an entity is
    // [step0.from, step0.to, step1.to, …]. Owner colour rides in `style.color`.
    const byEntity = new Map();
    for (const ov of moveOvs) {
      const eid = ov.meta?.entityId;
      let e = byEntity.get(eid);
      if (!e) { e = { color: ov.style?.color || '#ffffff', steps: [] }; byEntity.set(eid, e); }
      e.steps.push(ov);
    }
    for (const e of byEntity.values()) {
      e.steps.sort((a, b) => (a.meta?.stepIndex ?? 0) - (b.meta?.stepIndex ?? 0));
    }

    // Per-entity dashed path tracing the planned waypoints. We render each
    // dash as a short tube (radius PLAN_LINE_RADIUS) rather than a LinesMesh —
    // native WebGL line width is driver-capped at ~1px, so tubes give us
    // guaranteed visible thickness and let us lift the dashes above tile /
    // marker geometry without z-fight.
    for (const [entityId, e] of byEntity) {
      const path = [];
      e.steps.forEach((ov, i) => {
        if (i === 0) path.push(parseKey(ov.path[0]));
        path.push(parseKey(ov.path[1]));
      });
      if (path.length < 2) continue;
      const [r, g, b] = cssHexToRgb01(e.color);

      const dashMat = new BABYLON.StandardMaterial(
        `planLineMat_${entityId}`, this._scene);
      dashMat.diffuseColor  = new BABYLON.Color3(r, g, b);
      dashMat.emissiveColor = new BABYLON.Color3(r * 0.6, g * 0.6, b * 0.6);
      dashMat.specularColor = new BABYLON.Color3(0, 0, 0);

      const dashes = [];
      for (let i = 0; i < path.length - 1; i++) {
        const a = hexToWorld(path[i].col,     path[i].row);
        const b = hexToWorld(path[i + 1].col, path[i + 1].row);
        const segs = computeDashSegments(
          { x: a.x, z: a.z }, { x: b.x, z: b.z },
          PLAN_LINE_DASH_SIZE, PLAN_LINE_GAP_SIZE, PLAN_LINE_Y,
        );
        for (let s = 0; s < segs.length; s++) {
          const { start, end } = segs[s];
          const tube = BABYLON.MeshBuilder.CreateTube(
            `planDash_${entityId}_${i}_${s}`,
            {
              path: [
                new BABYLON.Vector3(start.x, start.y, start.z),
                new BABYLON.Vector3(end.x,   end.y,   end.z),
              ],
              radius: PLAN_LINE_RADIUS,
              tessellation: 8,
              cap: BABYLON.Mesh.CAP_ALL,
            },
            this._scene,
          );
          tube.parent = this._mapRoot;
          tube.isPickable = false;
          tube.material = dashMat;
          dashes.push(tube);
        }
      }
      this._planArrowMeshes.push({ dashes, dashMat });
    }

    // Waypoint puck + numbered badge per move step.
    for (const ov of moveOvs) {
      const entityId   = ov.meta?.entityId;
      const stepNumber = ov.meta?.stepIndex ?? 0;
      const badgeLabel = ov.meta?.badge ?? String(stepNumber);
      const ownerColor = ov.style?.color || '#ffffff';
      const { col: toCol, row: toRow } = parseKey(ov.path[1]);
      const [r, g, b] = cssHexToRgb01(ownerColor);

      // Small ground-puck cylinder under the badge — reads as a "marker pin"
      // rather than a tinted overlay, so the underlying terrain stays visible.
      const disc = BABYLON.MeshBuilder.CreateCylinder(
        `planMarker_${entityId}_${stepNumber}`,
        { tessellation: 16, height: PLAN_MARKER_HEIGHT, diameter: PLAN_MARKER_DIAMETER },
        this._scene,
      );
      const { x: tx, z: tz } = hexToWorld(toCol, toRow);
      // Waypoint puck lives in the `plan-arrow` overlay layer (Y ≥ 0.180,
      // = PLAN_WAYPOINT_Y) — above UNIT_HEX_OUTLINE_Y (0.10) so the marker
      // never hides under a unit's selection ring.
      disc.position.set(tx, PLAN_WAYPOINT_Y, tz);
      disc.isPickable = false;

      const discMat = new BABYLON.StandardMaterial(
        `planMarkerMat_${entityId}_${stepNumber}`, this._scene);
      discMat.diffuseColor  = new BABYLON.Color3(r, g, b);
      discMat.emissiveColor = new BABYLON.Color3(r * 0.5, g * 0.5, b * 0.5);
      discMat.specularColor = new BABYLON.Color3(0, 0, 0);
      discMat.alpha = PLAN_DISC_ALPHA;
      disc.material = discMat;

      // Numbered badge above the puck — small billboarded plane.
      let badge = null, badgeMat = null, badgeTex = null;
      if (typeof document !== 'undefined') {
        badgeTex = new BABYLON.DynamicTexture(`badgeTex_${entityId}_${stepNumber}`,
          { width: 64, height: 64 }, this._scene, false);
        badgeTex.hasAlpha = true;
        const ctx = badgeTex.getContext();
        ctx.clearRect(0, 0, 64, 64);
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = ownerColor;
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 36px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeLabel, 32, 34);
        badgeTex.update();

        badgeMat = new BABYLON.StandardMaterial(`badgeMat_${entityId}_${stepNumber}`, this._scene);
        badgeMat.diffuseTexture = badgeTex;
        badgeMat.opacityTexture = badgeTex;
        badgeMat.useAlphaFromDiffuseTexture = true;
        badgeMat.specularColor = new BABYLON.Color3(0, 0, 0);
        badgeMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
        badgeMat.backFaceCulling = false;

        badge = BABYLON.MeshBuilder.CreatePlane(`badge_${entityId}_${stepNumber}`,
          { width: 0.45, height: 0.45 }, this._scene);
        badge.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        badge.isPickable    = false;
        badge.material      = badgeMat;
        badge.position.set(tx, 0.6, tz);
      }

      this._planArrowMeshes.push({ disc, discMat, badge, badgeMat, badgeTex });
    }
  }

  /** Publish one `plan-arrow` (variant 'battle') overlay per planned attack
   *  step. This is the producer: it derives the from/to hexes and the per-
   *  target ×N count from `planGhostSteps` and writes them into the overlay
   *  map. `_buildPlanBattleArrows` is the consumer — it materialises the shaft,
   *  arrow head, and ×N badge by reading these descriptors back. Stale battle
   *  overlays are cleared first. */
  _publishPlanBattleOverlays() {
    for (const id of Array.from(this._overlays.keys())) {
      if (id.startsWith('plan-battle-')) this._overlays.delete(id);
    }
    const steps = this.planGhostSteps;
    if (!steps) return;
    const counts = countAttacksPerTarget(steps);
    let i = 0;
    for (const step of steps) {
      if (!step.attackArrow) continue;
      const { fromCol, fromRow, toCol, toRow } = step.attackArrow;
      const id = `plan-battle-${i++}`;
      const fromHex = `${fromCol},${fromRow}`;
      const toHex = `${toCol},${toRow}`;
      this.setOverlay(id, makeOverlay({
        id, kind: 'plan-arrow', layer: 'plan-arrow',
        path: [{ col: fromCol, row: fromRow }, { col: toCol, row: toRow }],
        style: { color: ATTACK_ARROW_COLOR, alpha: 1 },
        meta: { variant: 'battle', fromHex, toHex, count: counts.get(toHex) ?? 1 },
      }));
    }
  }

  /** Consumer for the battle `plan-arrow` overlays. Reads the descriptors
   *  `_publishPlanBattleOverlays` wrote into `this._overlays` — never
   *  `planGhostSteps` — and materialises a red shaft + wedge arrow head per
   *  attack plus a single ×N badge above each unique target hex (single attacks
   *  render the ⚔ glyph). Rebuilt each draw, gated by a signature early-out. */
  _buildPlanBattleArrows() {
    // Babylon loads lazily — bail before the signature check so the first
    // draw() after init doesn't stamp the cache while the build phase below
    // is still no-op.
    if (!this._babylon || !this._scene) return;

    // Change-detect: the signature is derived from `planGhostSteps` (the
    // deterministic source the publisher converts into the battle overlays), so
    // it changes iff the published descriptors change — yet the geometry below
    // is built entirely from the overlay map.
    const sig = planBattleOverlaySignature(this.planGhostSteps);
    if (sig === this._planBattleSig) return;
    this._planBattleSig = sig;

    for (const e of this._planBattleMeshes) {
      e.shaft?.dispose();
      e.head1?.dispose();
      e.head2?.dispose();
      e.badge?.dispose();
      e.badgeMat?.dispose();
      e.badgeTex?.dispose();
    }
    this._planBattleMeshes = [];

    // Collect the battle-variant `plan-arrow` overlays (insertion order = plan
    // order, since the publisher rewrites them just before this builder runs).
    const battleOvs = [];
    for (const ov of this._overlays.values()) {
      if (ov.kind === 'plan-arrow' && ov.layer === 'plan-arrow'
          && ov.meta?.variant === 'battle') {
        battleOvs.push(ov);
      }
    }
    if (battleOvs.length === 0) return;

    const BABYLON = this._babylon;
    const parseHex = (k) => { const [col, row] = k.split(',').map(Number); return { col, row }; };

    // Shared red material — every attack arrow uses the same colour.
    if (!this._attackArrowMat) {
      const [r, g, b] = cssHexToRgb01(ATTACK_ARROW_COLOR);
      const mat = new BABYLON.StandardMaterial('planAttackArrowMat', this._scene);
      mat.diffuseColor  = new BABYLON.Color3(r, g, b);
      mat.emissiveColor = new BABYLON.Color3(r * 0.7, g * 0.4, b * 0.4);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      this._attackArrowMat = mat;
    }
    const arrowMat = this._attackArrowMat;

    // Tube shafts + arrow-head wedges — one per attack overlay.
    let arrowIdx = 0;
    for (const ov of battleOvs) {
      const { col: fromCol, row: fromRow } = parseHex(ov.meta.fromHex);
      const { col: toCol,   row: toRow   } = parseHex(ov.meta.toHex);
      const geo = computeAttackArrowGeometry(fromCol, fromRow, toCol, toRow);
      if (!geo) continue;
      const { shaftStart, shaftEnd, headLeft, headRight } = geo;

      const shaft = BABYLON.MeshBuilder.CreateTube(
        `planAttackShaft_${arrowIdx}`,
        {
          path: [
            new BABYLON.Vector3(shaftStart.x, shaftStart.y, shaftStart.z),
            new BABYLON.Vector3(shaftEnd.x,   shaftEnd.y,   shaftEnd.z),
          ],
          radius: ATTACK_ARROW_RADIUS,
          tessellation: 8,
          cap: BABYLON.Mesh.CAP_ALL,
        },
        this._scene,
      );
      shaft.parent = this._mapRoot;
      shaft.isPickable = false;
      shaft.material = arrowMat;
      shaft.renderingGroupId = ATTACK_OVERLAY_GROUP;

      const head1 = BABYLON.MeshBuilder.CreateTube(
        `planAttackHead1_${arrowIdx}`,
        {
          path: [
            new BABYLON.Vector3(shaftEnd.x, shaftEnd.y, shaftEnd.z),
            new BABYLON.Vector3(headLeft.x, headLeft.y, headLeft.z),
          ],
          radius: ATTACK_ARROW_RADIUS,
          tessellation: 8,
          cap: BABYLON.Mesh.CAP_ALL,
        },
        this._scene,
      );
      head1.parent = this._mapRoot;
      head1.isPickable = false;
      head1.material = arrowMat;
      head1.renderingGroupId = ATTACK_OVERLAY_GROUP;

      const head2 = BABYLON.MeshBuilder.CreateTube(
        `planAttackHead2_${arrowIdx}`,
        {
          path: [
            new BABYLON.Vector3(shaftEnd.x,  shaftEnd.y,  shaftEnd.z),
            new BABYLON.Vector3(headRight.x, headRight.y, headRight.z),
          ],
          radius: ATTACK_ARROW_RADIUS,
          tessellation: 8,
          cap: BABYLON.Mesh.CAP_ALL,
        },
        this._scene,
      );
      head2.parent = this._mapRoot;
      head2.isPickable = false;
      head2.material = arrowMat;
      head2.renderingGroupId = ATTACK_OVERLAY_GROUP;

      this._planBattleMeshes.push({ shaft, head1, head2 });
      arrowIdx++;
    }

    // One ×N badge per unique target hex (⚔ glyph for single attacks). The
    // per-target count rides in each overlay's `meta.count`.
    if (typeof document === 'undefined') return;
    const drawnTargets = new Set();
    for (const ov of battleOvs) {
      const key = ov.meta.toHex;
      if (drawnTargets.has(key)) continue;
      drawnTargets.add(key);
      const { col: toCol, row: toRow } = parseHex(key);

      const count = ov.meta.count ?? 1;
      const label = attackBadgeLabel(count);

      const badgeTex = new BABYLON.DynamicTexture(
        `planAttackBadgeTex_${key}`,
        { width: 96, height: 96 },
        this._scene, false,
      );
      badgeTex.hasAlpha = true;
      const ctx = badgeTex.getContext();
      ctx.clearRect(0, 0, 96, 96);
      ctx.fillStyle = 'rgba(180,30,30,0.92)';
      ctx.beginPath(); ctx.arc(48, 48, 40, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(48, 48, 40, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${count > 1 ? 48 : 56}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 48, 52);
      badgeTex.update();

      const badgeMat = new BABYLON.StandardMaterial(`planAttackBadgeMat_${key}`, this._scene);
      badgeMat.diffuseTexture = badgeTex;
      badgeMat.opacityTexture = badgeTex;
      badgeMat.useAlphaFromDiffuseTexture = true;
      badgeMat.specularColor = new BABYLON.Color3(0, 0, 0);
      badgeMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
      badgeMat.backFaceCulling = false;

      const badge = BABYLON.MeshBuilder.CreatePlane(
        `planAttackBadge_${key}`,
        { width: ATTACK_BADGE_SIZE, height: ATTACK_BADGE_SIZE },
        this._scene,
      );
      badge.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      badge.isPickable = false;
      badge.material = badgeMat;
      badge.renderingGroupId = ATTACK_OVERLAY_GROUP;
      const { x, y, z } = attackBadgePosition(toCol, toRow);
      badge.position.set(x, y, z);
      if (this._mapRoot) badge.parent = this._mapRoot;

      this._planBattleMeshes.push({ badge, badgeMat, badgeTex });
    }
  }

  // ─── Plan ghost (walking previewer) ──────────────────────────────────────
  //
  // Mirrors the 2D path's "ghost walks the plan" preview: a translucent clone
  // of each moving unit's standee plane traces the planned path on a loop.
  // The 2D path uses a shared "heartbeat" cycle across all units; here we use
  // a simpler per-unit loop with a fixed per-step duration — both reads as
  // "this unit is about to walk this path".
  //
  // Implementation notes:
  //   • Path is sourced from `planGhostSteps` (computed in ui.js via
  //     `computeGhostState`). MOVE arrows in step order → [origin, dest1, ...].
  //   • Ghost meshes are rebuilt only when an entity's path *signature*
  //     changes; per-frame motion is pumped from `_onBeforeRender` so the
  //     animation runs independently of `draw()` calls.
  //   • The ghost plane reuses the entity's existing portrait material
  //     (no extra texture allocation) but is rendered at half alpha. We toggle
  //     `mat.alpha` per-frame via a wrapped material clone — cheap, and keeps
  //     the real standee at full opacity.

  /** Refresh ghost meshes from current `planGhostSteps`. Dispose ghosts whose
   *  path no longer exists; build new ghosts for new paths; leave unchanged
   *  paths alone so the walking cycle doesn't snap back to origin every draw. */
  _syncPlanGhosts() {
    if (!this._scene || !this._babylon) return;

    const paths = computePlanGhostPaths(this.planGhostSteps);

    // Compute a combined signature so we can early-out when nothing changed.
    const sig = [...paths.entries()]
      .map(([id, p]) => `${id}:${p.map(s => `${s.col},${s.row}`).join('|')}`)
      .sort()
      .join(';');
    if (sig === this._planGhostSig) return;
    this._planGhostSig = sig;

    // Dispose ghosts whose entity no longer has a path (or has changed path).
    for (const [id, entry] of this._planGhostMeshes) {
      const p = paths.get(id);
      const newKey = p ? p.map(s => `${s.col},${s.row}`).join('|') : null;
      if (newKey !== entry.signature) {
        // Paladin-shape ghost: tear down the clone + its translucent mats.
        if (entry.ghostClone) {
          this._disposePaladinClone({ paladinClone: entry.ghostClone });
        }
        for (const m of entry.ghostMats || []) {
          if (m && typeof m.dispose === 'function') m.dispose();
        }
        entry.plane?.dispose?.();
        entry.sphere?.dispose?.();
        entry.mat?.dispose?.();
        this._planGhostMeshes.delete(id);
      }
    }

    // Build ghosts for any entity that now has a path but no live ghost.
    const BABYLON = this._babylon;
    for (const [id, path] of paths) {
      if (this._planGhostMeshes.has(id)) continue;
      const standee = this._entityStandees.get(id);
      if (!standee) continue; // no live standee to clone — skip
      const ent = this.state?.entities?.find?.(e => e.id === id);
      // Fresh translucent material in the entity's owner colour so the ghost
      // reads as a faint preview of the same token. Alpha is animated in
      // `_pumpPlanGhosts`.
      const ownerColor = this._ownerColorFor(ent ?? {});
      const [r, g, b] = cssHexToRgb01(ownerColor);
      const mat = new BABYLON.StandardMaterial(`ghost_${id}`, this._scene);
      mat.diffuseColor  = new BABYLON.Color3(r, g, b);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.emissiveColor = new BABYLON.Color3(r * 0.4, g * 0.4, b * 0.4);
      mat.backFaceCulling = false;
      mat.alpha = PLAN_GHOST_ALPHA;

      const leader = standee.leader;
      const wMul = leader ? STANDEE_LEADER_WIDTH_MUL  : 1;
      const hMul = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
      const { cone, sphere } = this._buildTokenBody(`planGhost_${id}`, {
        coneHeight:         STANDEE_CONE_HEIGHT          * hMul,
        coneDiameterBottom: STANDEE_CONE_DIAMETER_BOTTOM * wMul,
        coneDiameterTop:    STANDEE_CONE_DIAMETER_TOP    * wMul,
        sphereDiameter:     STANDEE_SPHERE_DIAMETER      * wMul,
      });
      cone.material   = mat;
      sphere.material = mat;
      cone.isPickable = false;
      // Plan ghosts are standees too — share renderingGroupId 0 so they
      // depth-test against buildings the same as live units.
      cone.renderingGroupId   = 0;
      sphere.renderingGroupId = 0;

      // For hero entities with the walking GLB loaded, build the ghost
      // silhouette from the WALKING source (not paladin). Walking's native
      // skeleton + animation drive the ghost independently of the main
      // paladin's skeleton — so the live paladin stays in idle while the
      // ghost walks the preview path. Cone+sphere become invisible
      // positioning anchors (cone drives `entry.plane.position` via the
      // path animation in `_pumpPlanGhosts`); the walking clone parents
      // to cone and inherits its world motion. Materials are cloned
      // per-ghost so the 50% alpha doesn't leak onto the source.
      let ghostClone = null;
      let ghostMats = null;
      if (this._paladinSource && unitUsesPaladinModel(ent)) {
        ghostClone = this._buildWalkingGhostClone(ent, cone);
        if (ghostClone) {
          cone.visibility = 0;
          sphere.visibility = 0;
          ghostMats = [];
          // Babylon glTF loader produces PBRMaterials; mat.alpha alone
          // doesn't always trigger alpha blending — need transparencyMode
          // set explicitly. Also drive mesh.visibility as a belt-and-braces
          // alpha multiplier so any material type ends up at PLAN_GHOST_ALPHA.
          const ALPHABLEND = BABYLON.Material?.MATERIAL_ALPHABLEND ?? 2;
          for (const child of ghostClone.childMeshes || []) {
            if (!child) continue;
            child.visibility = PLAN_GHOST_ALPHA;
            if (child.material && typeof child.material.clone === 'function') {
              const ghostMat = child.material.clone(`ghostMat_${id}_${child.name}`);
              ghostMat.alpha = PLAN_GHOST_ALPHA;
              ghostMat.transparencyMode = ALPHABLEND;
              if ('useAlphaFromDiffuseTexture' in ghostMat) {
                ghostMat.useAlphaFromDiffuseTexture = false;
              }
              ghostMat.backFaceCulling = false;
              // PBRMaterial cache invalidation — ensure the next frame
              // re-evaluates needAlphaBlending() with the new alpha + mode.
              if (typeof ghostMat.markAsDirty === 'function') {
                ghostMat.markAsDirty(BABYLON.Material?.AttributesDirtyFlag ?? 1);
              }
              child.material = ghostMat;
              ghostMats.push(ghostMat);
            }
          }
          // Ghost doesn't cast shadow — it's a preview, not a real entity.
          for (const m of ghostClone.childMeshes || []) this._removeShadowCaster(m);
        }
      }

      this._planGhostMeshes.set(id, {
        plane: cone, mat, sphere, path,
        signature: path.map(s => `${s.col},${s.row}`).join('|'),
        leader,
        ghostClone, ghostMats,
      });
    }
  }

  /** Per-frame: walk each ghost along its path on a loop. Cheap — runs once
   *  per ghost (a handful) regardless of map size. */
  /** Recompute scene fog start/end so the fog kicks in right at the playable
   *  map's edge and is fully thick by the outer border edge. Uses camera-
   *  distance geometry: a point at horizontal distance `d` from the camera's
   *  target sits at √(r² + d²) from the camera (ArcRotateCamera math, β-
   *  independent because the offset axis projects out of the camera-target
   *  vector). Map size adapts via the cached `_mapPanBounds.depth/2` so
   *  skirmish / standard / regional / campaign all read correctly. Border
   *  edge is the playable half plus the band depth (`* 1.5` for pointy-top
   *  vertical hex spacing × 6 hexes; matches `_buildMapBorderForest`). */
  _pumpSceneFog() {
    if (!this._scene || !this._camera) return;
    const r = this._camera.radius;
    const playableHalf = (this._mapPanBounds?.depth ?? 19.5) / 2;
    const borderHalf   = playableHalf + 6 * 1.5;
    // FOG_END_MUL stretches the fog's far edge past the border so the ramp
    // is gentle — border tiles read as "fading into the distance" rather
    // than going fully solid. 1.0 = full opacity at the border edge (too
    // harsh per operator); 1.5 = ~45% opacity at the border, fully solid
    // a half-band further out. Tunable; matched to the muted-fog look the
    // operator asked for.
    const FOG_END_MUL = 1.5;
    this._scene.fogStart = Math.sqrt(r * r + playableHalf * playableHalf);
    this._scene.fogEnd   = Math.sqrt(r * r + (borderHalf * FOG_END_MUL) * (borderHalf * FOG_END_MUL));
  }

  _pumpPlanGhosts(nowMs) {
    if (this._planGhostMeshes.size === 0) return;
    for (const [, entry] of this._planGhostMeshes) {
      const pose = planGhostPose(nowMs, entry.path.length);
      const from = entry.path[pose.segment];
      const to   = entry.path[Math.min(entry.path.length - 1, pose.segment + 1)];
      const a = hexToWorld(from.col, from.row);
      const b = hexToWorld(to.col,   to.row);
      const lerp = (s, e) => s + (e - s) * pose.segT;
      entry.plane.position.x = lerp(a.x, b.x);
      entry.plane.position.z = lerp(a.z, b.z);
      const hMul = entry.leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
      // Same vertical anchor as a real cone token: bottom rim of the cone
      // rests on top of where the base disc would sit.
      entry.plane.position.y = STANDEE_BASE_Y_OFFSET
        + STANDEE_BASE_THICKNESS / 2
        + (STANDEE_CONE_HEIGHT * hMul) / 2;
      entry.mat.alpha = PLAN_GHOST_ALPHA * pose.alpha;
      // Face the direction of motion for hero ghost paladins. Skip when
      // the segment has zero length (e.g. ghost paused on a single hex).
      if (entry.ghostClone?.mesh) {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        if (dx !== 0 || dz !== 0) {
          entry.ghostClone.mesh.rotation.y = Math.atan2(dx, dz);
        }
      }
    }
  }

  // ─── Phase 6: atmosphere — lighting, node glow, fog veil, selection halo ──
  //
  // Scene-global concerns that make 3D mode feel alive: time-of-day lighting
  // that shifts across the four phases, saturated emissive discs on Power Nodes
  // tinted by current controller, a fog-of-war veil that dims tiles and
  // hides standees outside the observer's sight, and an animated glow halo
  // for the selected unit. Per-entity overlays, plan arrows, HP bars, and
  // combat animations are explicitly Phase 5's domain — leave them alone.

  /** Detect state.phase changes and kick off a 3-second eased transition of
   *  the hemispheric light intensity + colour + scene clear colour. The actual
   *  interpolation is pumped per-frame from `_onBeforeRender`. */
  _notePhaseChange() {
    if (!this._light) return;
    const phase = this.state?.phase ?? null;
    if (phase === this._lastPhase) return;
    const from = this._snapshotLight();
    const to   = getPhaseLightConfig(phase);
    this._phaseTransition = {
      from,
      to,
      startMs: this._nowMs(),
      durMs:   PHASE_TRANSITION_MS,
    };
    this._lastPhase = phase;
  }

  _nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  /** Snapshot the current light/clear values as a Phase-light-config-shaped
   *  object. Used as the "from" anchor for the next transition so we always
   *  ease from wherever we are *right now*, even mid-transition. */
  _snapshotLight() {
    const s = this._lightState;
    return {
      intensity: s.intensity,
      color: { r: s.color.r, g: s.color.g, b: s.color.b },
      clear: { r: s.clear.r, g: s.clear.g, b: s.clear.b },
      sun: {
        dir: { x: s.sun.dir.x, y: s.sun.dir.y, z: s.sun.dir.z },
        intensity: s.sun.intensity,
      },
    };
  }

  /** Slam the light + clear colour to a target config with no animation.
   *
   *  `groundColor` (the under-side colour of the hemispheric light, defaults
   *  to pitch black) gets a non-zero value here so any face whose normal
   *  points away from the light still receives some ambient illumination
   *  rather than rendering as a black silhouette. The ribbon top face is now
   *  correctly +Y-facing (this PR vs PR #323), but a low/tilted camera can
   *  still see the underside, and the ribbon-Y is so close to the terrain
   *  disc (0.085 vs 0.084) that the underside getting any colour at all
   *  improves how the strip reads from the side. Scaled `HEMI_GROUND_SCALE ×
   *  diffuse` so it tints with phase but never matches it (which would erase
   *  the lit/unlit contrast entirely). */
  _applyLightConfig(cfg) {
    const BABYLON = this._babylon;
    if (!BABYLON || !this._light || !this._scene) return;
    this._light.intensity = cfg.intensity;
    this._light.diffuse   = new BABYLON.Color3(cfg.color.r, cfg.color.g, cfg.color.b);
    this._light.specular  = new BABYLON.Color3(cfg.color.r * 0.3, cfg.color.g * 0.3, cfg.color.b * 0.3);
    const gs = HEMI_GROUND_SCALE;
    this._light.groundColor = new BABYLON.Color3(cfg.color.r * gs, cfg.color.g * gs, cfg.color.b * gs);
    this._scene.clearColor = new BABYLON.Color4(cfg.clear.r, cfg.clear.g, cfg.clear.b, 1.0);
    // Fog colour mirrors the sky clear colour — the wilderness band fades
    // into the same tint that fills the backdrop, so there's no visible
    // seam where the band ends and the sky begins.
    this._scene.fogColor = new BABYLON.Color3(cfg.clear.r, cfg.clear.g, cfg.clear.b);
    // Phase-tinted ambient — boosts visibility on shadowed faces when the
    // sun is low/off (night/dawn/dusk) while staying neutral at noon.
    if (cfg.ambient) {
      this._scene.ambientColor = new BABYLON.Color3(cfg.ambient.r, cfg.ambient.g, cfg.ambient.b);
    }
    // Per-phase fog-of-war tint — `setFogTint` walks all cached fog
    // materials and re-applies the fog veil so existing fogged tiles
    // immediately match the new darken factor.
    if (typeof cfg.fogTint === 'number') {
      this.setFogTint(cfg.fogTint);
    }
    // Directional sun: drives shadow casting strength + angle. NIGHT
    // intensity≈0 effectively turns the sun off so lanterns / hemi carry the
    // look. Direction is set via Vector3, but only when a sun config exists
    // (defensive — older snapshots may not have one).
    if (cfg.sun && this._sunLight) {
      // Sun direction is round-based (sweeps across the day) rather than
      // phase-locked — every DAY round shows the sun in a different
      // position. _onBeforeRender re-applies the round direction each frame
      // so this assignment is overridden as soon as state.round is known.
      const round = this.state?.round ?? 1;
      const dir = sunDirectionForRound(round, this.state?.cycleConfig);
      this._sunLight.direction = new BABYLON.Vector3(dir.x, dir.y, dir.z);
      this._sunLight.intensity = cfg.sun.intensity;
    }
    // Mirror into _lightState so transition snapshots see the new anchor.
    this._lightState.intensity = cfg.intensity;
    this._lightState.color = { r: cfg.color.r, g: cfg.color.g, b: cfg.color.b };
    this._lightState.clear = { r: cfg.clear.r, g: cfg.clear.g, b: cfg.clear.b };
    if (cfg.sun) {
      this._lightState.sun = {
        dir: { x: cfg.sun.dir.x, y: cfg.sun.dir.y, z: cfg.sun.dir.z },
        intensity: cfg.sun.intensity,
      };
    }
  }

  /** Register a mesh as a shadow caster on the sun ShadowGenerator. No-op
   *  before _initBabylon has run (so build-time call sites in headless tests
   *  stay quiet) or for null meshes. */
  _addShadowCaster(mesh) {
    if (!mesh || !this._shadowGenerator) return;
    this._shadowGenerator.addShadowCaster(mesh);
  }

  /** Un-register a mesh from the sun ShadowGenerator. Used when a hero
   *  standee gets its paladin clone retrofitted on top — the cone+sphere
   *  go invisible but stay in scene as positioning anchors; we strip
   *  them from the caster list so the floor shadow doesn't reflect both
   *  shapes. No-op before _initBabylon or for null meshes. */
  _removeShadowCaster(mesh) {
    if (!mesh || !this._shadowGenerator
      || typeof this._shadowGenerator.removeShadowCaster !== 'function') return;
    this._shadowGenerator.removeShadowCaster(mesh);
  }

  /** Mark a mesh as a shadow receiver. Idempotent + null-safe. Thin wrapper
   *  around the pure `applyShadowReceiving` helper so the instance-method
   *  callsites read cleanly while sharing one source of truth. */
  _setShadowReceiver(mesh) {
    applyShadowReceiving([mesh]);
  }

  /** Per-frame pump: advance the phase-light transition (if any) and update
   *  the selection halo + node-glow pulses. Cheap — runs every render frame
   *  regardless of whether draw() was called, so the pulses keep cycling
   *  even when game state is idle. */
  _onBeforeRender() {
    const now = this._nowMs();
    // Lock the camera target to the ground plane (Y=0). Babylon's
    // ArcRotateCamera pan moves the target along the screen-aligned plane
    // (perpendicular to look direction), so panning vertically on screen
    // would drift target.y above or below the ground — and since camera
    // position is target + radius offset, that drift propagates into camera
    // Y. Clamping target.y here keeps the camera at a fixed height (radius
    // offset above the ground) no matter how the operator pans.
    if (this._camera && this._camera.target && this._camera.target.y !== 0) {
      this._camera.target.y = 0;
    }
    // Pan extent clamp — runs every frame so inertial overshoot past the map
    // edge is corrected by the next render. Bounds come from
    // `panBoundsForPlayableExtent`, which keeps the camera target inside the
    // playable bbox plus a half-hex fudge so even at max zoom-out + max pan
    // the playable map stays clearly the visible subject.
    if (this._camera && (this._panClampBounds || this._mapPanBounds)) {
      const t = this._camera.target;
      const bounds = this._panClampBounds
        || panBoundsForPlayableExtent(this._mapPanBounds);
      const clamped = clampPanTarget(t, bounds, 0);
      // Mutate in place — Babylon's ArcRotateCamera tracks `target` by ref.
      if (t.x !== clamped.x || t.z !== clamped.z) {
        t.x = clamped.x;
        t.z = clamped.z;
        // Kill inertial pan so we don't keep crashing against the wall.
        this._camera.inertialPanningX = 0;
        this._camera.inertialPanningY = 0;
      }
    }
    // Phase-light interpolation.
    const t = this._phaseTransition;
    if (t) {
      const elapsed = now - t.startMs;
      const u = Math.min(1, Math.max(0, elapsed / t.durMs));
      const eased = easeInOutCubic(u);
      const cur = lerpLightConfig(t.from, t.to, eased);
      this._applyLightConfig(cur);
      if (u >= 1) this._phaseTransition = null;
    }
    // Sun direction sweeps across the day — and now eases between rounds
    // instead of snapping. When `state.round` advances we kick off a
    // SUN_ROUND_TRANSITION_MS ease from the previous round's direction to
    // the new one, so the operator sees the sun glide as turns resolve.
    if (this._sunLight && this.state) {
      const round = this.state.round ?? 1;
      const target = sunDirectionForRound(round, this.state.cycleConfig);
      if (this._lastSunRound !== round) {
        // Anchor the from-direction at whatever the sun's pointing at right
        // now (mid-transition or fully settled).
        const cur = this._sunLight.direction;
        this._sunTransition = {
          from: { x: cur.x, y: cur.y, z: cur.z },
          to:   { x: target.x, y: target.y, z: target.z },
          startMs: now,
          durMs:   SUN_ROUND_TRANSITION_MS,
        };
        this._lastSunRound = round;
      }
      const tr = this._sunTransition;
      if (tr) {
        const u = Math.min(1, Math.max(0, (now - tr.startMs) / tr.durMs));
        const eased = easeInOutCubic(u);
        const nx = tr.from.x + (tr.to.x - tr.from.x) * eased;
        const ny = tr.from.y + (tr.to.y - tr.from.y) * eased;
        const nz = tr.from.z + (tr.to.z - tr.from.z) * eased;
        this._sunLight.direction.x = nx;
        this._sunLight.direction.y = ny;
        this._sunLight.direction.z = nz;
        if (u >= 1) this._sunTransition = null;
      } else {
        // No transition in flight — snap to the current round's target so the
        // very first frame after init shows the right sun position.
        this._sunLight.direction.x = target.x;
        this._sunLight.direction.y = target.y;
        this._sunLight.direction.z = target.z;
      }
    }
    // Selection signal is the thick per-unit hex outline + its glow-layer
    // bloom (driven by `_applySelectionAndFocus`); no per-frame standee-
    // material pulse to drive.
    // Node hex outlines no longer pulse — they hold a steady controller tint
    // (task 7). Colour is set by `_buildObjectiveRings` (the ring-pulse
    // consumer in `_syncOverlays`) whenever the controller changes; no
    // per-frame mutation needed.
    // Plan ghost walking previewer.
    this._pumpPlanGhosts(now);
    // Scene fog tracking — keep the start/end relative to the camera so the
    // band fades just past the playable map at every zoom level.
    this._pumpSceneFog();
    // Unit icon scaling — shrink the floating badge as the camera zooms in
    // so it doesn't dominate the model's head. Smoothly ramps between
    // UNIT_ICON_SCALE_FAR (full size) and UNIT_ICON_SCALE_NEAR (1/3 size).
    this._pumpUnitIconScale();
    // FPS chip — throttled DOM text update, 3D-only.
    this._pumpFpsCounter(now);
    // Building hover labels: fade in/out based on camera zoom.
    this._pumpBuildingLabelFade();
  }

  /** Update the on-canvas FPS / ms-per-frame chip. Throttled to
   *  FPS_COUNTER_UPDATE_MS so we don't write to the DOM every frame. The
   *  element is resolved lazily on first call — index.html ships it in the
   *  canvas-wrapper, but a host page that omits it is fine (we just skip). */
  /** Scale every unit icon billboard by the proximity-aware factor so the
   *  badge shrinks as the camera zooms in. Reads camera.radius once per
   *  frame and writes scaling.xyz + position.y on each plane. The position
   *  drops as scale shrinks so the icon bottom stays at a fixed clearance
   *  above the head (sphere top) regardless of scale — closer to the
   *  model when zoomed in, never overlapping. Cheap (few units typical). */
  _pumpUnitIconScale() {
    if (!this._unitIconBadges || this._unitIconBadges.size === 0) return;
    if (!this._camera) return;
    const factor = unitIconScaleForRadius(this._camera.radius);
    for (const entry of this._unitIconBadges.values()) {
      const plane = entry?.plane;
      if (!plane?.scaling) continue;
      if (plane.scaling.x !== factor) plane.scaling.x = factor;
      if (plane.scaling.y !== factor) plane.scaling.y = factor;
      if (plane.scaling.z !== factor) plane.scaling.z = factor;
      // Lower the icon's centre as it shrinks so its bottom keeps the same
      // clearance above the head. `entry.leader` is captured at create time
      // (passed in via standee.leader); for missing entries default to false.
      const leader = entry.leader === true;
      const ny = iconBillboardYForScale(leader, factor);
      if (plane.position && plane.position.y !== ny) plane.position.y = ny;
    }
  }

  _pumpFpsCounter(now) {
    if (now - this._fpsCounterLastMs < FPS_COUNTER_UPDATE_MS) return;
    this._fpsCounterLastMs = now;
    if (!this._fpsCounterEl && typeof document !== 'undefined') {
      this._fpsCounterEl = document.getElementById('fps-counter');
    }
    const el = this._fpsCounterEl;
    if (!el || !this._engine) return;
    el.textContent = formatFpsLabel(this._engine.getFps(), this._engine.getDeltaTime());
    // Poly counter just below — total polys submitted (across every mesh
    // in the scene, regardless of frustum/visibility) vs polys actually
    // drawn this frame (scene.getActiveIndices / 3). Helps the operator
    // tell at a glance whether perf regressions come from too much
    // geometry overall (total) or from too much being VISIBLE (active).
    if (!this._polyCounterEl && typeof document !== 'undefined') {
      this._polyCounterEl = document.getElementById('poly-counter');
    }
    const polyEl = this._polyCounterEl;
    if (!polyEl || !this._scene) return;
    let totalPolys = 0;
    for (const mesh of this._scene.meshes) {
      if (!mesh.getTotalIndices) continue;
      // Instances re-use their source mesh's index buffer — count once
      // per source, but multiply by the count of enabled instances so
      // the "total" reflects the screen-space draw volume.
      if (mesh.sourceMesh) continue; // skip; counted on source below
      const triCount = mesh.getTotalIndices() / 3;
      const instCount = (mesh.instances?.length || 0) + 1;
      totalPolys += triCount * instCount;
    }
    // Count active polys by iterating the scene's active-mesh smart-array
    // directly. Babylon's `scene.getActiveIndices()` returns 0 when read
    // from onBeforeRender (the perf counter hasn't been written yet for
    // this frame), so we compute it here instead. Instances share their
    // source mesh's geometry — count one tris-payload per visible
    // instance plus the source itself when enabled.
    let activePolys = 0;
    const active = this._scene.getActiveMeshes ? this._scene.getActiveMeshes() : null;
    if (active && active.length > 0) {
      for (let i = 0; i < active.length; i++) {
        const m = active.data[i];
        if (!m || !m.getTotalIndices) continue;
        const tris = m.getTotalIndices() / 3;
        if (m.sourceMesh) {
          // It's an InstancedMesh — count its share once.
          activePolys += tris;
        } else {
          // Source mesh: count itself plus any visible instances.
          let count = 1;
          if (m.instances && m.instances.length > 0) {
            for (const inst of m.instances) {
              if (inst.isEnabled && inst.isEnabled()) count++;
            }
          }
          activePolys += tris * count;
        }
      }
    }
    polyEl.textContent = formatPolyLabel(totalPolys, activePolys);
  }

  _setNodeGlowIntensity(ng, k) {
    if (!ng?.disc?.material?.emissiveColor) return;
    const c = ng.glowColor;
    ng.disc.material.emissiveColor.r = c.r * k * NODE_DISC_EMISSIVE_MUL;
    ng.disc.material.emissiveColor.g = c.g * k * NODE_DISC_EMISSIVE_MUL;
    ng.disc.material.emissiveColor.b = c.b * k * NODE_DISC_EMISSIVE_MUL;
  }

  /** Publish two `ring-pulse` overlays per node hex: the controller ring
   *  (recoloured each draw to the current controller) and the static
   *  identifier ring. `animation` is omitted — both rings hold a steady tint
   *  today (the pulse was retired in an earlier pass). IDs are stable per hex
   *  so the overlays upsert without churning the map. */
  _publishObjectiveRingOverlays() {
    const objs = this.state?.witchObjectives;
    if (!objs) return;
    objs.forEach((obj, nodeIndex) => {
      const ctrl = nodeController(obj, this.state.entities);
      const ctrlCss = getNodeGlowColor(ctrl);
      const idCss = nodeIdentifyingColor(obj);
      for (const h of obj.hexes) {
        const hexArg = [{ col: h.col, row: h.row }];
        this.setOverlay(`node-ctrl-${h.col}-${h.row}`, makeOverlay({
          id: `node-ctrl-${h.col}-${h.row}`, kind: 'ring-pulse', layer: 'objective-ring',
          hexes: hexArg,
          style: { color: ctrlCss, alpha: 1, glow: true },
          meta: { nodeIndex, isController: true, factionColorKey: ctrl },
        }));
        this.setOverlay(`node-id-${h.col}-${h.row}`, makeOverlay({
          id: `node-id-${h.col}-${h.row}`, kind: 'ring-pulse', layer: 'objective-ring',
          hexes: hexArg,
          style: { color: idCss, alpha: 1, glow: true },
          meta: { nodeIndex, isController: false },
        }));
      }
    });
  }

  /** Build one emissive disc per Power Node hex on first call, then on every
   *  draw update the per-disc material colour to reflect the current
   *  controller (read from the published `node-ctrl-*` overlay). Cheap because
   *  witchObjectives count rarely exceeds 3. */
  _buildObjectiveRings() {
    if (!this._scene || !this.state?.witchObjectives) return;
    if (!this._nodeGlowBuilt) {
      this._buildNodeGlowMeshes();
      this._nodeGlowBuilt = true;
    }
    // Recolour by controller each draw — controller can flip when entities move.
    // Pulsing was removed (task 7): write the emissive directly so the ring
    // holds a steady controller tint. Colour comes from the published
    // controller-ring overlay so the overlay map drives the visual.
    for (const ng of this._nodeGlowMeshes) {
      const ov = this._overlays.get(`node-ctrl-${ng.col}-${ng.row}`);
      const css = ov?.style?.color
        ?? getNodeGlowColor(nodeController(ng.obj, this.state.entities));
      const [r, g, b] = cssHexToRgb01(css);
      ng.glowColor = { r, g, b };
      const mat = ng.disc?.material;
      if (mat?.emissiveColor) {
        mat.emissiveColor.r = r * 0.7;
        mat.emissiveColor.g = g * 0.7;
        mat.emissiveColor.b = b * 0.7;
      }
      if (mat?.diffuseColor) {
        mat.diffuseColor.r = r * 0.4;
        mat.diffuseColor.g = g * 0.4;
        mat.diffuseColor.b = b * 0.4;
      }
    }
    // Tint discs: same controller-driven recolour, kept on its own loop so the
    // tint can carry a different brightness mix from the ring (the ring is
    // emissive-dominant for bloom, the tint is diffuse-dominant for a faint
    // wash).
    for (const nt of this._nodeTintMeshes) {
      const ctrl = nodeController(nt.obj, this.state.entities);
      const [r, g, b] = cssHexToRgb01(nodeOverlayColor(ctrl));
      const mat = nt.mat;
      if (mat?.diffuseColor) {
        mat.diffuseColor.r = r;
        mat.diffuseColor.g = g;
        mat.diffuseColor.b = b;
      }
      if (mat?.emissiveColor) {
        mat.emissiveColor.r = r * 0.4;
        mat.emissiveColor.g = g * 0.4;
        mat.emissiveColor.b = b * 0.4;
      }
    }
    // Labels are painted once at build time in the node's identifying
    // colour (palette-matched to the HUD score dots) — that colour never
    // changes, so there is no per-frame repaint loop here. Fog visibility
    // still flips through `_setTileFogged` via `_nodeLabelsByCenterHex`.
  }

  _buildNodeGlowMeshes() {
    const BABYLON = this._babylon;
    if (!BABYLON || !this._scene) return;
    const SQRT3 = Math.sqrt(3);
    const ringR = HEX_RADIUS_WORLD * 0.96;
    for (const obj of this.state.witchObjectives) {
      // Hex outline ring tinted with the controller colour — replaces the
      // pulsing disc. CreateTube around a closed hex loop so the ring stays
      // visible at any zoom (LinesMesh aliases hard at zoomed-out distances).
      for (const h of obj.hexes) {
        const { x, z } = hexToWorld(h.col, h.row);
        const path = [];
        for (let i = 0; i <= 6; i++) {
          const a = Math.PI / 6 + i * Math.PI / 3;
          path.push(new BABYLON.Vector3(ringR * Math.cos(a), 0.03, ringR * Math.sin(a)));
        }
        const disc = BABYLON.MeshBuilder.CreateTube(
          `node_ring_${obj.label.replace(/\W+/g, '_')}_${h.col}_${h.row}`,
          { path, radius: 0.06, tessellation: 6, sideOrientation: BABYLON.Mesh.DOUBLESIDE },
          this._scene,
        );
        disc.parent = this._mapRoot;
        disc.position.x = x;
        disc.position.z = z;
        disc.isPickable = false;
        const discMat = new BABYLON.StandardMaterial(`nodeRingMat_${h.col}_${h.row}`, this._scene);
        discMat.diffuseColor  = new BABYLON.Color3(0.05, 0.05, 0.05);
        discMat.specularColor = new BABYLON.Color3(0, 0, 0);
        discMat.emissiveColor = new BABYLON.Color3(0.8, 0.8, 0.8);
        disc.material = discMat;

        this._nodeGlowMeshes.push({
          obj, disc,
          col: h.col, row: h.row,
          glowColor: { r: 1, g: 1, b: 1 },
        });

        // Track in the per-hex prop list so `_applyFogVeil` hides the disc on
        // fogged tiles alongside the rest of the tile's silhouette. A node
        // disc that stayed lit through fog gave the controller away even when
        // every other prop on the hex was hidden.
        const tkey = hexKey(h.col, h.row);
        const props = this._tilePropsByKey.get(tkey);
        if (props) props.push(disc);
        else this._tilePropsByKey.set(tkey, [disc]);
        if (this._fogActiveSet.has(tkey)) disc.isVisible = false;

        // Outer identifier ring: a second, slightly larger hex outline
        // painted in the node's identifying palette colour (matches the
        // HUD score dots). Static for the life of the game — set once,
        // frozen below with the rest of the static map geometry. Sits
        // *outside* the controller ring so the controller signal stays
        // dominant and the identifier reads as a quiet edge.
        const idCss = nodeIdentifyingColor(obj);
        const [ir, ig, ib] = cssHexToRgb01(idCss);
        const idPath = [];
        for (let i = 0; i <= 6; i++) {
          const a = Math.PI / 6 + i * Math.PI / 3;
          idPath.push(new BABYLON.Vector3(
            NODE_IDENTIFIER_RING_RADIUS * Math.cos(a),
            0.028,
            NODE_IDENTIFIER_RING_RADIUS * Math.sin(a),
          ));
        }
        const idRing = BABYLON.MeshBuilder.CreateTube(
          `node_id_ring_${obj.label.replace(/\W+/g, '_')}_${h.col}_${h.row}`,
          { path: idPath, radius: NODE_IDENTIFIER_RING_TUBE, tessellation: 6,
            sideOrientation: BABYLON.Mesh.DOUBLESIDE },
          this._scene,
        );
        idRing.parent = this._mapRoot;
        idRing.position.x = x;
        idRing.position.z = z;
        idRing.isPickable = false;
        // Identifier ring colour never changes, so share one cached material
        // across every hex with the same identifying colour (overlayMaterialKey
        // dedups). diffuse = id×0.4, emissive = id — same look as before, just
        // no longer one fresh StandardMaterial per ring.
        idRing.material = this._ringPulseMaterialFor([ir, ig, ib], 1, true);

        // Same fog-veil registration as the controller ring. By this point
        // the per-tile list exists (we just registered the controller disc
        // a few lines above) so a fresh lookup always returns the array.
        this._tilePropsByKey.get(tkey).push(idRing);
        if (this._fogActiveSet.has(tkey)) idRing.isVisible = false;
      }
    }
    // Build the matching 10%-alpha tint disc + one floating name label per
    // node. Done in the same pass so the freeze sweep below sees both.
    this._buildNodeTintAndLabels();
    // Node rings are static for the rest of the game — fold them into the
    // freeze pass. _freezeStaticMeshes is idempotent; the previously-frozen
    // tile/prop meshes from `_buildMap` are skipped on this second call.
    this._freezeStaticMeshes();
  }

  /** Build the translucent per-hex tint disc and one floating name label per
   *  power node. Called from `_buildNodeGlowMeshes` after the ring tubes are
   *  in place. Tint discs share the per-tile fog registry with the ring tubes;
   *  labels live in their own map so the freeze pass skips them (billboard
   *  rotation requires a per-frame world-matrix update — a frozen plane would
   *  point the wrong way). */
  _buildNodeTintAndLabels() {
    const BABYLON = this._babylon;
    if (!BABYLON || !this._scene) return;
    const SQRT3 = Math.sqrt(3);
    const tintR = (NODE_TINT_DIAMETER / 2) || HEX_RADIUS_WORLD;
    for (const obj of this.state.witchObjectives) {
      // Per-hex tint disc: flat hex prism sitting just above the terrain disc.
      // We build a CreateCylinder with tessellation 6 so the tint snaps to
      // the hex edges; that matches how the existing terrain disc reads.
      for (const h of obj.hexes) {
        const { x, z } = hexToWorld(h.col, h.row);
        const disc = BABYLON.MeshBuilder.CreateCylinder(
          `node_tint_${obj.label.replace(/\W+/g, '_')}_${h.col}_${h.row}`,
          { diameter: NODE_TINT_DIAMETER, height: 0.001, tessellation: 6 },
          this._scene,
        );
        disc.parent = this._mapRoot;
        disc.position.x = x;
        disc.position.y = NODE_TINT_Y;
        disc.position.z = z;
        // Match the existing terrain disc's pointy-top orientation so the
        // tint hex aligns flush over the tile rather than rotating off-axis.
        disc.rotation.y = Math.PI / 6;
        disc.isPickable = false;
        const mat = new BABYLON.StandardMaterial(
          `nodeTintMat_${h.col}_${h.row}`,
          this._scene,
        );
        mat.specularColor = new BABYLON.Color3(0, 0, 0);
        mat.diffuseColor  = new BABYLON.Color3(0.9, 0.9, 0.9);
        mat.emissiveColor = new BABYLON.Color3(0.3, 0.3, 0.3);
        mat.alpha = NODE_TINT_ALPHA;
        mat.backFaceCulling = false;
        disc.material = mat;

        this._nodeTintMeshes.push({
          obj, mesh: disc, mat,
          col: h.col, row: h.row,
        });

        // Register on the per-tile fog list so `_setTileFogged` hides the
        // tint alongside the ring tube. Same defensive pattern as the ring:
        // create the list if missing.
        const tkey = hexKey(h.col, h.row);
        const props = this._tilePropsByKey.get(tkey);
        if (props) props.push(disc);
        else this._tilePropsByKey.set(tkey, [disc]);
        if (this._fogActiveSet.has(tkey)) disc.isVisible = false;
      }

      // Floating name label — one per node, anchored above the centre hex
      // (obj.hexes[0] per `_pickNodeCluster`). The label is the operator's
      // primary "this is Power Node X, controlled by Y" read, so it's a
      // single mesh rather than one per hex.
      const center = obj.hexes[0];
      if (!center) continue;
      const label = this._buildNodeNameLabel(obj, center);
      if (label) {
        this._nodeNameLabels.push(label);
        this._nodeLabelsByCenterHex.set(hexKey(center.col, center.row), label);
      }
    }
  }

  /** Build one floating-name-label entry for a power node. Returns the entry
   *  or null when no DOM is available (headless / node-test). The
   *  DynamicTexture is painted on first build via `_paintNodeLabel`. */
  _buildNodeNameLabel(obj, center) {
    const BABYLON = this._babylon;
    const scene = this._scene;
    if (!BABYLON || !scene || typeof document === 'undefined') return null;
    const tkey = hexKey(center.col, center.row);
    const tex = new BABYLON.DynamicTexture(
      `nodeLabelTex_${tkey}`,
      { width: NODE_LABEL_TEX_W, height: NODE_LABEL_TEX_H },
      scene,
      false,
    );
    tex.hasAlpha = true;

    const mat = new BABYLON.StandardMaterial(`nodeLabelMat_${tkey}`, scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.specularColor  = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor  = new BABYLON.Color3(1, 1, 1);
    mat.backFaceCulling = false;
    mat.alpha = 1;

    const plane = BABYLON.MeshBuilder.CreatePlane(
      `nodeLabel_${tkey}`,
      { width: NODE_LABEL_WIDTH, height: NODE_LABEL_HEIGHT },
      scene,
    );
    plane.parent = this._mapRoot;
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    plane.material = mat;
    // Anchor over the centre hex (the cluster's "head"), not the centroid —
    // the centre is where the ring discs of the three-hex cluster radiate
    // from, so a label above it reads as belonging to the whole node.
    const { x, z } = hexToWorld(center.col, center.row);
    plane.position.set(x, NODE_LABEL_Y, z);

    const entry = {
      obj, plane, mat, tex,
      hexKey: tkey,
    };
    // The label colour is the node's identifying palette colour, which is
    // static for the life of the game — paint once at build time and never
    // repaint. (Earlier rounds painted in the controller colour and so
    // needed a per-controller-flip refresh; that's gone now.)
    this._paintNodeLabel(entry);
    // Mirror the ring's initial fog state — start hidden if the centre hex
    // is already fogged at build time.
    if (this._fogActiveSet.has(tkey)) {
      plane.isVisible = false;
    }
    return entry;
  }

  /** Paint a node-label DynamicTexture with the node's identifying palette
   *  colour (matching the HUD score dots). Idempotent — safe to call again
   *  if the texture is ever evicted. */
  _paintNodeLabel(entry) {
    const tex = entry?.tex;
    if (!tex || typeof tex.getContext !== 'function') return;
    const ctx = tex.getContext();
    const W = NODE_LABEL_TEX_W;
    const H = NODE_LABEL_TEX_H;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font         = 'bold 44px Georgia, serif';
    const cx = W / 2;
    const cy = H / 2;
    // Dark drop-shadow keeps the label legible against bright daytime sky
    // / pale fog tiles. The identifying-colour fill sits on top: the label
    // text matches the HUD score-dot palette so the player can tie a HUD
    // dot to a node on the map at a glance. Controller signal is carried
    // by the underlying tint disc, not the label colour.
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    const text = nodeLabelText(entry.obj);
    ctx.fillText(text, cx + 2, cy + 2);
    ctx.fillStyle = nodeIdentifyingColor(entry.obj);
    ctx.fillText(text, cx, cy);
    tex.update();
  }

  /** Apply the fog-of-war veil: swap fogged-tile materials to a darker variant
   *  and hide standees + props on fogged hexes. No-op when fog is inactive or
   *  there's no human observer (AI-vs-AI / spectator). */
  _applyFogVeil() {
    if (!this._scene) return;
    const state = this.state;
    const fogActive = state?.fogOfWar && state.fogOfWar !== 'none';
    const observerOwner = this._observerOwner();

    let target;
    if (!fogActive || !observerOwner) {
      target = null; // nothing fogged — unfog everything
    } else {
      target = this._buildFogVisibleHexes(observerOwner);
    }

    // Diff against the currently-fogged set: clear any previously-fogged tile
    // that is now visible, then fog any tile that should now be dark.
    for (const [k, mesh] of this._tileMeshByKey) {
      const shouldBeFogged = target ? !target.has(k) : false;
      const isFogged = this._fogActiveSet.has(k);
      if (shouldBeFogged && !isFogged) {
        this._setTileFogged(k, mesh, true);
      } else if (!shouldBeFogged && isFogged) {
        this._setTileFogged(k, mesh, false);
      }
    }

    // Hide standees on fogged hexes; reveal them when visible again. The
    // floating icon badge is parented to the standee cone (`.plane`) but
    // Babylon's `isVisible` does not propagate to children, so we mirror
    // visibility onto the badge plane explicitly — otherwise a hidden
    // standee would leave a floating icon over an empty fogged hex.
    if (target) {
      for (const [id, standee] of this._entityStandees) {
        const k = hexKey(standee.plane.metadata.col, standee.plane.metadata.row);
        const visible = shouldRenderEntityAt(target, k);
        // Use setEnabled (not isVisible) so the standee's child portrait
        // sticker meshes inherit visibility. isVisible only hides the mesh
        // itself, not its parented children — switching to setEnabled
        // propagates the fog-hide through the cone → sphere tree.
        if (standee.plane.isEnabled?.() !== visible) standee.plane.setEnabled(visible);
        const icon = this._unitIconBadges.get(id);
        if (icon && icon.plane.isVisible !== visible) icon.plane.isVisible = visible;
        // Mirror onto the per-unit hex outlines so the ground ring vanishes
        // with its unit. setEnabled (not isVisible) so it composes with the
        // selection-driven isVisible toggle on thin / thick — fogged units
        // hide both rings regardless of selection state.
        const outline = this._entityHexOutlines.get(id);
        if (outline) {
          if (outline.thin.isEnabled?.()  !== visible) outline.thin.setEnabled(visible);
          if (outline.thick.isEnabled?.() !== visible) outline.thick.setEnabled(visible);
        }
      }
    } else {
      // No fog → make sure everything is visible (covers fog-toggling mid-game).
      for (const [id, standee] of this._entityStandees) {
        if (!standee.plane.isEnabled?.()) standee.plane.setEnabled(true);
        const icon = this._unitIconBadges.get(id);
        if (icon && !icon.plane.isVisible) icon.plane.isVisible = true;
        const outline = this._entityHexOutlines.get(id);
        if (outline) {
          if (!outline.thin.isEnabled?.())  outline.thin.setEnabled(true);
          if (!outline.thick.isEnabled?.()) outline.thick.setEnabled(true);
        }
      }
    }
  }

  _setTileFogged(hexK, tileMesh, fogged) {
    const md = tileMesh.metadata;
    if (!md?.baseColor) return;
    const tile = this.state?.tiles?.get(hexK);
    // When we have the tile in state we can pick a textured fog material;
    // otherwise (shouldn't happen for playable hexes) fall back to colour-only.
    tileMesh.material = tile
      ? this._tileMaterialFor(tile, { fogged })
      : (fogged ? this._fogMaterialFor(md.baseColor) : this._materialFor(md.baseColor));
    const props = this._tilePropsByKey.get(hexK);
    if (props) for (const p of props) {
      // Three fog policies per-prop, set via `metadata.respectsFog`:
      //   • undefined / true → hide on fog (standees, HP bars, node discs)
      //   • false             → permanent geometry, ignore fog (trees, buildings)
      //   • 'darken'          → stay visible but tint dimmer (roads, rivers)
      const policy = p.metadata?.respectsFog;
      if (policy === false) continue;
      if (policy === 'darken') {
        // Per-tile material darkening: the ribbon stays at full opacity but
        // its colour is multiplied by FOG_TILE_DARKEN so it matches the
        // fogged ground beneath it. Anchor colours are stashed in metadata
        // at build time so re-revealing a hex restores the exact unfogged
        // tint (avoids accumulating darken multipliers across fog flickers).
        const mat = p.material;
        const bd  = p.metadata?.baseDiffuse;
        const be  = p.metadata?.baseEmissive;
        if (mat?.diffuseColor && bd) {
          const k = fogged ? this._fogTileDarken : 1.0;
          mat.diffuseColor.r  = bd.r * k;
          mat.diffuseColor.g  = bd.g * k;
          mat.diffuseColor.b  = bd.b * k;
        }
        if (mat?.emissiveColor && be) {
          const k = fogged ? this._fogTileDarken : 1.0;
          mat.emissiveColor.r = be.r * k;
          mat.emissiveColor.g = be.g * k;
          mat.emissiveColor.b = be.b * k;
        }
        continue;
      }
      p.isVisible = !fogged;
    }
    // Building labels are tracked separately — dim (not hide) under fog so the
    // operator can still read "this hex has an Inn" even when the interior is
    // unrevealed. Tilemap-driven texture so the tint goes via material alpha.
    const labelEntry = this._buildingLabelsByKey?.get(hexK);
    if (labelEntry?.mat) {
      labelEntry.mat.alpha = fogged ? 0.45 : 1.0;
    }
    // Power-node name labels: anchored to the cluster centre hex only, so
    // visibility tracks that one hex's fog state. Hide fully on fog (unlike
    // building labels) — node ownership IS the tactical secret being hidden.
    const nodeLabelEntry = this._nodeLabelsByCenterHex?.get(hexK);
    if (nodeLabelEntry?.plane) {
      nodeLabelEntry.plane.isVisible = !fogged;
    }
    if (fogged) this._fogActiveSet.add(hexK);
    else this._fogActiveSet.delete(hexK);
  }

  _fogMaterialFor(baseHex) {
    if (this._fogMaterialCache.has(baseHex)) return this._fogMaterialCache.get(baseHex);
    const BABYLON = this._babylon;
    const [r, g, b] = cssHexToRgb01(baseHex);
    const mat = new BABYLON.StandardMaterial(`fog_${baseHex}`, this._scene);
    const d = this._fogTileDarken;
    mat.diffuseColor  = new BABYLON.Color3(r * d, g * d, b * d);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor = new BABYLON.Color3(0, 0, 0);
    this._fogMaterialCache.set(baseHex, mat);
    return mat;
  }

  /** Determine which faction's perspective drives fog of war. Mirrors the 2D
   *  renderer's logic in src/renderer.js (`myFaction` if set, otherwise
   *  inferred from `witchIsAI`/`heroIsAI`); returns null in AI-vs-AI runs
   *  and spectator mode, which suppresses the veil entirely. */
  _observerOwner() {
    const state = this.state;
    if (!state) return null;
    // Prefer the explicit myFaction (set in online/PvP mode); fall back to
    // the unique human side in local-AI games.
    if (state.myFaction) return state.myFaction;
    if (state.witchIsAI && !state.heroIsAI)  return 'hero';
    if (state.heroIsAI  && !state.witchIsAI) return 'witch';
    return null;
  }
}

// Overlay API lives on the prototype (shared impl from overlays.js) so the
// renderer-interface conformance test sees setOverlay / removeOverlay /
// clearOverlaysByLayer / setSelection / setHover as real methods.
Object.assign(Renderer3D.prototype, OVERLAY_METHODS);

// ─── Tile top-face texture constants & pure helpers (exported for tests) ──

/** Disc radius multiplier relative to the cylinder radius. 1.0 lands exactly
 *  on the cylinder's hex edge; the disc and cylinder share matched vertex
 *  positions so the textured face covers the whole top without overhang. */
export const TERRAIN_DISC_RADIUS_MUL = 1.0;

/** Y offset for the textured disc above the cylinder top. Cylinder top sits
 *  at +0.075 (height = 0.15, centred at y=0). The original 0.076 (1 mm gap)
 *  proved too tight — at typical camera distances (radius 20–80) the depth
 *  buffer precision falls into ~1e-3 territory and the disc lost the depth
 *  fight against the prism top, making it invisible in-game even though the
 *  16 unit tests (which only exercise pure helpers, never the actual mesh)
 *  passed. A 0.009 lift comfortably wins the fight at any view distance,
 *  while still staying below the river ribbon (RIVER_RIBBON_Y = 0.085) so a
 *  road/river tile's grass-underlay disc doesn't pop in front of the ribbon. */
export const TERRAIN_DISC_Y_OFFSET = 0.084;

/** Variant counts for each terrain type that has multiple sprite variants.
 *  Mirrors the layout in `Renderer._buildSpriteRects()` — keep in step if the
 *  atlas grows new variants. Single-variant types (road / river / bridge) are
 *  intentionally absent here; `terrainSpriteIdFor` covers them separately. */
export const TERRAIN_VARIANT_COUNTS = Object.freeze({
  grass:  5,
  forest: 5,
  dirt:   5,
});

/**
 * Pure function: which terrain sprite (atlas id) should be used for the top
 * face of a given tile? Returns null when the tile type has no terrain sprite
 * we want to use — the renderer then leaves the cylinder's solid colour on
 * display.
 *
 * Mapping (mirrors the 2D `_drawTile` logic where it makes sense):
 *   • GRASS, FOREST, DIRT → matching `<type>_<N>` variant via the same hash
 *     used in the 2D renderer, so a given hex always picks the same variant.
 *   • BUILDING → a dirt variant (the building box/roof props sit on top).
 *   • ROAD, RIVER, BRIDGE → null (these tiles already carry their own prop
 *     mesh and a colour cue; texturing would muddle the read).
 *   • Anything else → null.
 */
export function terrainSpriteIdFor(tile, col, row) {
  if (!tile) return null;
  // Ground texture = the tile's REAL base material. Roads/rivers/bridges and
  // buildings no longer force a grass/dirt underlay — they sit on whatever
  // base they were laid over.
  let baseType = baseOf(tile);
  // FOREST base is the one exception: trees render as real 3D cones, so the
  // ground beneath uses the grass sprite (a painted-forest sprite would clash
  // with the cone silhouettes). Same trick buildings used for a dirt underlay.
  if (baseType === TileType.FOREST) baseType = TileType.GRASS;
  const count = TERRAIN_VARIANT_COUNTS[baseType] ?? 0;
  if (count <= 0) return null;  // base material has no sprite pool — solid colour
  if (count > 1) {
    const v = (((col * 7 + row * 13 + col * row) % count) + count) % count + 1;
    return `${baseType}_${v}`;
  }
  return baseType;
}

// ─── Map forest border (pure helpers exported for tests) ──────────────────
//
// The playable hex grid is a rectangle. To frame it as "world continues into
// wilderness" — rather than ending at a hard edge — we render a band of
// visual-only forest hexes outside the playable rectangle. These positions
// are NOT in `state.tiles`, so they're impassable by absence (no pathing, no
// fog, no scoring) and the camera pan clamp still binds to the playable
// extent.
//
// Cone density is slightly higher than in-map forest tiles (5–7 vs 3–5) so
// the band reads as thicker wilderness from the default camera angle. Two
// hexes deep gives a continuous mat of trees with room for the silhouette
// to taper — three is also acceptable but adds mesh count without an
// equivalent payoff.

/** Min/max (col, row) extent of a tiles map. Returns `null` on empty. */
export function tilesExtent(tilesMap) {
  if (!tilesMap || tilesMap.size === 0) return null;
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const tile of tilesMap.values()) {
    if (tile.col < minCol) minCol = tile.col;
    if (tile.col > maxCol) maxCol = tile.col;
    if (tile.row < minRow) minRow = tile.row;
    if (tile.row > maxRow) maxRow = tile.row;
  }
  return { minCol, maxCol, minRow, maxRow };
}

/** Depth (in hexes) of the impassable forest band wrapped around the
 *  playable map. 2 reads as a continuous mat of wilderness from the default
 *  camera angle without inflating the mesh count beyond a few hundred extra
 *  cones on the largest map. */
export const BORDER_BAND_DEPTH = 2;

/** Min / max cones per border forest hex. Slightly above in-map forest
 *  (3–5) so the band reads as thicker wilderness from the default camera
 *  angle. Cap at 7 because TILE_SLOTS only has 7 distinct positions and we
 *  don't want overlapping cones. */
export const BORDER_FOREST_TREES_MIN = 5;
export const BORDER_FOREST_TREES_MAX = 7;

/** Returns the (col, row) positions for a `bandDepth`-hex band wrapping the
 *  rectangular playable map. Includes diagonal corner cells (i.e. fills the
 *  full surrounding rectangle minus the playable rectangle), so the formula
 *  is `(playableCols + 2·depth) · (playableRows + 2·depth) − playableCols ·
 *  playableRows`. Returns `[]` on empty input or non-positive depth. */
export function borderTilePositions(tilesMap, bandDepth = BORDER_BAND_DEPTH) {
  const ext = tilesExtent(tilesMap);
  if (!ext || bandDepth <= 0) return [];
  const out = [];
  for (let row = ext.minRow - bandDepth; row <= ext.maxRow + bandDepth; row++) {
    for (let col = ext.minCol - bandDepth; col <= ext.maxCol + bandDepth; col++) {
      const inPlayable = col >= ext.minCol && col <= ext.maxCol
                      && row >= ext.minRow && row <= ext.maxRow;
      if (inPlayable) continue;
      out.push({ col, row });
    }
  }
  return out;
}

/** Alpha tiers for the fade-out at the OUTER edge of the border-forest band,
 *  indexed by rings-from-the-outer-edge. The outermost ring (index 0) is the
 *  most transparent; each ring inward is less so; rings deeper than this list
 *  (closer to the playable map) stay fully opaque. Operator request: fade the
 *  outer 3 rings so the map edge dissolves instead of ending at a hard wall. */
export const BORDER_FOREST_EDGE_ALPHAS = Object.freeze([0.2, 0.5, 0.8]);

/** Chebyshev depth of a tile from the playable rectangle's edge: 0 for tiles
 *  inside the playable rectangle, 1 for the ring immediately outside it, and
 *  growing outward. `ext` is a `{minCol, maxCol, minRow, maxRow}` extent (from
 *  `tilesExtent`). Pure. */
export function borderTileDepthFromPlayable(col, row, ext) {
  if (!ext) return 0;
  const dCol = col < ext.minCol ? ext.minCol - col
             : col > ext.maxCol ? col - ext.maxCol : 0;
  const dRow = row < ext.minRow ? ext.minRow - row
             : row > ext.maxRow ? row - ext.maxRow : 0;
  return Math.max(dCol, dRow);
}

/** Map a border tile's distance (in rings) from the OUTER edge of the band to
 *  its leaf/trunk alpha. Outermost ring (0) → 0.2, next in (1) → 0.5, next (2)
 *  → 0.8; any ring deeper in (≥3, i.e. closer to the playable map) → 1.0 (fully
 *  opaque). Anchoring the fade to the outer edge makes it look identical
 *  regardless of band depth — a 2-deep band still fades outer=0.2, next=0.5.
 *
 *  Rings BEYOND the outer edge (`ringsFromOuter < 0`) are NOT inner/opaque —
 *  they sit past the band's silhouette. This happens for river-extension
 *  centreline samples, which run one hex past the outermost band tile (see
 *  `riverExtensionRingAlphas` / `_buildRiverExtensions`). Returning 1.0 there
 *  snapped the river's far tip back to fully opaque, leaving a hard opaque stub
 *  poking past the faded map edge. Instead we CONTINUE the fade outward at the
 *  same per-ring slope (clamped to ≥ 0) so the water keeps dissolving toward
 *  transparent off the edge — matching how the ground/trees simply end at the
 *  outer ring. NaN is still treated as opaque (defensive). Pure. */
export function borderForestAlphaForOuterRing(ringsFromOuter) {
  if (Number.isNaN(ringsFromOuter)) return 1.0;
  const tiers = BORDER_FOREST_EDGE_ALPHAS;
  if (ringsFromOuter >= tiers.length) return 1.0;          // inner band → opaque
  if (ringsFromOuter >= 0) return tiers[ringsFromOuter];    // within the fade band
  // Beyond the outermost ring: extrapolate the fade toward 0 along the slope
  // between the two outermost tiers (0.2 → 0.5 ⇒ −0.3 per ring outward), so a
  // sample one ring past the edge lands at 0 (fully transparent) rather than
  // snapping to opaque. Clamp so it never goes negative.
  const slope = tiers.length >= 2 ? tiers[1] - tiers[0] : tiers[0];
  return Math.max(0, tiers[0] + ringsFromOuter * slope);
}

/** Convenience: a border tile's leaf/trunk alpha given the playable extent and
 *  the band depth. Computes rings-from-outer-edge = `bandDepth − depthFrom
 *  playableEdge`, then maps to an alpha tier. Tiles inside the playable
 *  rectangle (depth 0) return 1.0. Pure. */
export function borderForestAlphaForTile(col, row, ext, bandDepth) {
  const depth = borderTileDepthFromPlayable(col, row, ext);
  if (depth <= 0) return 1.0;
  return borderForestAlphaForOuterRing(bandDepth - depth);
}

/** Per-ring edge-fade alpha for each centreline sample of a river extension,
 *  so the wilderness river dissolves in lockstep with the border ground +
 *  trees it threads through (operator: the river must fade too). Each
 *  world-space `{x, z}` sample is mapped back to its hex via the odd-r inverse
 *  of `hexToWorld`, then looked up through `borderForestAlphaForTile` — the
 *  SAME per-ring alpha curve the ground and trees use, so a sample sitting over
 *  the outermost ring gets 0.2, the next 0.5, etc. Samples over (or inside) the
 *  playable map return 1.0. Pure — same inputs, same output. */
export function riverExtensionRingAlphas(pts, ext, bandDepth, radius = HEX_RADIUS_WORLD) {
  if (!Array.isArray(pts)) return [];
  return pts.map((p) => {
    if (!p) return 1.0;
    const row = Math.round(p.z / (1.5 * radius));
    const col = Math.round(p.x / (SQRT3 * radius) - 0.5 * (row & 1));
    return borderForestAlphaForTile(col, row, ext, bandDepth);
  });
}

/** Deterministic cone layout for a border-forest hex. Same recipe as
 *  `forestTreesForHex` but with a bumped count range (BORDER_FOREST_TREES_*).
 *  Uses up to all 7 TILE_SLOTS so a denser hex fully covers the disc. Pure:
 *  same (col, row) → same trees. */
export function borderForestTreesForHex(col, row, season = null) {
  const span = BORDER_FOREST_TREES_MAX - BORDER_FOREST_TREES_MIN + 1;
  const n    = BORDER_FOREST_TREES_MIN + Math.floor(_forestHash(col, row, 0) * span);
  const scaleSpan = FOREST_SCALE_MAX - FOREST_SCALE_MIN;
  const rotation = Math.floor(_forestHash(col, row, 99) * TILE_SLOTS.length);
  const trees = [];
  for (let i = 0; i < n; i++) {
    const slotIdx = (i + rotation) % TILE_SLOTS.length;
    const slot = TILE_SLOTS[slotIdx];
    const scale = FOREST_SCALE_MIN + _forestHash(col, row, i * 3 + 3) * scaleSpan;
    trees.push({
      id: `border_tree_${i}`, x: slot.x, z: slot.z, scale, slotIdx,
      species:  treeSpeciesForHex(col, row, i, season),
      shadeIdx: treeLeafShadeIndex(col, row, i),
    });
  }
  return trees;
}

// ─── Phase 3 pure helpers (exported for tests) ─────────────────────────────

/** World-space position of an entity's standee base centre. Useful for
 *  asserting expected camera targets and standee positions without touching
 *  Babylon. Y is the height at which the base disc sits on the tile prism. */
export function entityStandeeWorldPosition(col, row, radius = HEX_RADIUS_WORLD) {
  const { x, z } = hexToWorld(col, row, radius);
  return { x, y: STANDEE_BASE_Y_OFFSET, z };
}

/** Choose the base disc colour for an entity. Mirrors `_ownerColorFor` so it
 *  can be unit-tested without instantiating the renderer. */
export function entityBaseColor(entity) {
  if (entity?.color) return entity.color;
  if (entity?.owner) {
    const theme = getFactionTheme(entity.owner);
    if (theme?.primary) return theme.primary;
  }
  return '#888888';
}

// ─── Per-unit ground-level hex outline (pure helpers + tuning constants) ──
//
// Every alive unit gets a thin owner-tinted hex outline on its tile; the
// selected unit's outline is swapped for a thicker glowing variant. The
// constants below place the ring above the road/river ribbon apex and node
// rings but below the movement-highlight disc, and bound the glow emissive
// so the ring stays owner-tinted at high emissive values.
// See `_syncEntityHexOutlines` for the wiring.

// ─── Hex highlight Y band ──────────────────────────────────────────────────
//
// All ground-level hex highlights (per-unit thin / thick outline ring, the
// move-range highlight disc, the plan disc, the plan line) sit inside an
// explicit Y band defined here. The band sits above the tile-prism top
// (Y = 0.075) and above the road / river ribbon apex (≈ 0.09), so the
// highlights always draw over the floor + the network ribbons. The upper
// bound stays well below the tree-canopy / building-top Ys (~0.5+); because
// the highlights share `renderingGroupId = 0` with the trees and buildings,
// the depth buffer occludes any highlight that a building or tree fronts.
//
// Tests in `renderer-3d-highlight-band.test.js` pin the ordering so a future
// tweak to any one Y can't silently break the band.
/** Lower bound of the hex highlight Y band. */
export const HEX_HIGHLIGHT_BAND_MIN_Y = 0.10;
/** Upper bound of the hex highlight Y band. Held well below the tree-canopy /
 *  building-top Ys so depth-test in group 0 handles "obscured by trees /
 *  buildings" without the highlight ever poking through. */
export const HEX_HIGHLIGHT_BAND_MAX_Y = 0.20;

/** Y of the always-on per-unit hex outline ring. Floor of the highlight band
 *  (= HEX_HIGHLIGHT_BAND_MIN_Y). Above the road apex (≈ 0.09) and well below
 *  `HIGHLIGHT_DISC_Y = 0.15`, so the perimeter outline keeps reading when the
 *  unit is standing on a highlighted movement-range hex. */
export const UNIT_HEX_OUTLINE_Y = HEX_HIGHLIGHT_BAND_MIN_Y;

/** Hex polygon radius for the per-unit outline ring. Set inside
 *  `HIGHLIGHT_OUTER_R = 0.95` so when both rings overlap (unit standing on
 *  its own valid-move source hex) they read as concentric bands rather than
 *  fighting for the same pixels. */
export const UNIT_HEX_OUTLINE_RING_R = HEX_RADIUS_WORLD * 0.88;

/** Tube radius of the always-on thin outline. */
export const UNIT_HEX_OUTLINE_THIN_TUBE  = 0.025;
/** Tube radius of the thicker outline shown on the selected unit. */
export const UNIT_HEX_OUTLINE_THICK_TUBE = 0.06;

/** Emissive cap (× diffuse) for the always-on thin outline material. Low
 *  enough that the ring reads as a tinted line, not a self-lit halo. */
export const UNIT_HEX_OUTLINE_THIN_EMISSIVE_MUL = 0.30;
/** Emissive cap (× diffuse) for the selected unit's glow outline material.
 *  Capped at 0.6 — the same convention `NODE_DISC_EMISSIVE_MUL` uses — so
 *  the ring stays owner-tinted at high emissive values. */
export const UNIT_HEX_OUTLINE_GLOW_EMISSIVE_MUL = 0.6;

/** Pure: closed hex ring of 7 points (last == first) at the given world Y,
 *  centred on the origin. Caller positions the resulting mesh on the tile
 *  centre via `position.x` / `position.z`. Pointy-top — same vertex angles
 *  as `hexOutlinePaths`. */
export function unitHexOutlineRingPath(
  radius = UNIT_HEX_OUTLINE_RING_R,
  y      = UNIT_HEX_OUTLINE_Y,
) {
  const path = [];
  for (let i = 0; i <= 6; i++) {
    const a = Math.PI / 6 + i * (Math.PI / 3);
    path.push({ x: radius * Math.cos(a), y, z: radius * Math.sin(a) });
  }
  return path;
}

/** Resolve the owner colour for a unit's hex outline. Pure delegation to
 *  `entityBaseColor` so the outline and standee token are guaranteed to use
 *  the same tint — exported so tests can lock the linkage in place. */
export function unitHexOutlineColor(entity) {
  return entityBaseColor(entity);
}

/** Derive a darker / desaturated variant of a player colour for dead-unit
 *  tombstone tokens. Pulls each channel toward a neutral grey and dims the
 *  whole result so the dead token reads as "muted version of the living one".
 *  Pure colour math — no Babylon dependency, exported for tests. */
export function tombstoneTokenColor(hex) {
  const [r, g, b] = cssHexToRgb01(hex);
  // 55% blend toward middle grey (0.45), then 65% brightness scale.
  const desat = 0.55;
  const dim   = 0.65;
  const mix = (c) => (c * (1 - desat) + 0.45 * desat) * dim;
  const out = (c) => Math.max(0, Math.min(255, Math.round(mix(c) * 255)));
  const toHex = (n) => n.toString(16).padStart(2, '0');
  return `#${toHex(out(r))}${toHex(out(g))}${toHex(out(b))}`;
}

// ─── Tile slot system (exported for tests) ──────────────────────────────────
//
// Every hex has 7 fixed "slots" arranged as 1 centre + 6 around the rim.
// Co-tenants on a hex (a building, the forest cluster, multiple standees) are
// assigned to deterministic slots so silhouettes don't pile up at the centre
// when more than one occupant lives on the same tile. Slots are described as
// (x, z) offsets from the hex centre, in world units, on the XZ ground plane.
//
//   slot 0 — centre. Reserved for standees (the common case: one unit per hex).
//   slot 1 — building anchor. Aligns with BUILDING_OFFSET for visual stability;
//            a building always occupies this slot when present.
//   slots 2–6 — outer ring at ~0.6 world units, used by trees and overflow
//            standees in deterministic id order.
//
// Outer-slot distance sits within [FOREST_INNER_RADIUS, FOREST_OUTER_RADIUS]
// so existing forest invariants (trees stay out of the centre) still hold.
export const TILE_SLOTS = Object.freeze([
  Object.freeze({ x:  0.00, z:  0.00 }), // 0 — centre
  Object.freeze({ x:  0.42, z: -0.42 }), // 1 — NE (building anchor, BUILDING_OFFSET)
  Object.freeze({ x: -0.42, z: -0.42 }), // 2 — NW
  Object.freeze({ x: -0.60, z:  0.00 }), // 3 — W
  Object.freeze({ x: -0.42, z:  0.42 }), // 4 — SW
  Object.freeze({ x:  0.42, z:  0.42 }), // 5 — SE
  Object.freeze({ x:  0.60, z:  0.00 }), // 6 — E
]);

/** Index of the centre slot (always preferred for the first standee). */
export const CENTRE_SLOT_INDEX = 0;
/** Index of the slot a building always occupies. */
export const BUILDING_SLOT_INDEX = 1;

/**
 * Pure slot assignment for a hex's occupants.
 *
 * Each occupant must be `{ id, kind: 'building' | 'tree' | 'standee' }`.
 * Returns `{ slotByOccupantId: Map<id, slotIndex>, overflow: number }` where
 * `overflow` is the count of standees beyond the 7-slot capacity (those
 * standees still appear in the map, all assigned to CENTRE_SLOT_INDEX, so the
 * +N badge stacks above the centre).
 *
 * Priority:
 *   • Buildings claim slot 1 (BUILDING_SLOT_INDEX). At most one building
 *     per tile is the normal case; extras spill to centre defensively.
 *   • Trees fill outer slots (1..6 minus the building slot) in id-sorted
 *     order. They never take the centre — the centre is reserved for a
 *     standee even on a fully-treed forest hex.
 *   • Standees take the centre first, then any still-free outer slot, then
 *     overflow stacks on the centre.
 *
 * Sort key is the string form of `id` so the function is stable across
 * runs regardless of insertion order in the caller.
 */
export function assignTileSlotIndices(occupants, opts = {}) {
  const out = new Map();
  if (!Array.isArray(occupants) || occupants.length === 0) {
    return { slotByOccupantId: out, overflow: 0 };
  }
  const buildings = [];
  const trees     = [];
  const standees  = [];
  for (const occ of occupants) {
    if (!occ || typeof occ !== 'object') continue;
    if (occ.kind === 'building') buildings.push(occ);
    else if (occ.kind === 'tree')  trees.push(occ);
    else if (occ.kind === 'standee') standees.push(occ);
  }
  const byId = (a, b) => {
    const ka = String(a.id), kb = String(b.id);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  buildings.sort(byId); trees.sort(byId); standees.sort(byId);

  const used = new Set();
  // Buildings → slot 1.
  if (buildings.length > 0) {
    out.set(buildings[0].id, BUILDING_SLOT_INDEX);
    used.add(BUILDING_SLOT_INDEX);
    for (let i = 1; i < buildings.length; i++) {
      out.set(buildings[i].id, CENTRE_SLOT_INDEX);
    }
  }
  // Reserved slots (e.g. a road deck crossing a forest tile, via
  // `roadBlockedTreeSlots`) are unavailable to trees and overflow standees.
  // Applied AFTER the building anchor so a building keeps slot 1 even when the
  // road footprint also covers it — buildings legitimately sit over the road
  // through their own hex. The centre slot is never reserved here (it carries
  // the standee, not a tree). No occupant is assigned to a reserved slot;
  // surplus trees simply go unplaced (caller drops them).
  const reserved = opts.reservedSlots;
  if (reserved && typeof reserved[Symbol.iterator] === 'function') {
    for (const s of reserved) {
      if (typeof s === 'number' && s !== CENTRE_SLOT_INDEX) used.add(s);
    }
  }
  // Trees → outer slots (skip centre, skip building slot).
  const outerForTrees = [];
  for (let i = 1; i < TILE_SLOTS.length; i++) {
    if (!used.has(i)) outerForTrees.push(i);
  }
  for (let i = 0; i < trees.length && i < outerForTrees.length; i++) {
    out.set(trees[i].id, outerForTrees[i]);
    used.add(outerForTrees[i]);
  }
  // Standees → centre first, then any remaining free slot, then overflow at centre.
  const standeeSlots = [];
  if (!used.has(CENTRE_SLOT_INDEX)) standeeSlots.push(CENTRE_SLOT_INDEX);
  for (let i = 1; i < TILE_SLOTS.length; i++) {
    if (!used.has(i)) standeeSlots.push(i);
  }
  let overflow = 0;
  for (let i = 0; i < standees.length; i++) {
    if (i < standeeSlots.length) out.set(standees[i].id, standeeSlots[i]);
    else { out.set(standees[i].id, CENTRE_SLOT_INDEX); overflow++; }
  }
  return { slotByOccupantId: out, overflow };
}

/**
 * Convenience wrapper: same as `assignTileSlotIndices` but returns absolute
 * world (x, z) positions for each occupant on the named hex. Used by the
 * renderer to place building/tree props at build time and to re-slot standees
 * every draw.
 */
export function tileSlotWorldPositions(col, row, occupants, radius = HEX_RADIUS_WORLD, opts = {}) {
  const { slotByOccupantId, overflow } = assignTileSlotIndices(occupants, opts);
  const { x: cx, z: cz } = hexToWorld(col, row, radius);
  const positionByOccupantId = new Map();
  for (const [id, slotIdx] of slotByOccupantId) {
    const slot = TILE_SLOTS[slotIdx] ?? TILE_SLOTS[CENTRE_SLOT_INDEX];
    positionByOccupantId.set(id, { x: cx + slot.x, z: cz + slot.z });
  }
  return { positionByOccupantId, overflow };
}

/** Shortest distance from point (px, pz) to the line segment (ax, az)–(bx, bz)
 *  in the XZ plane. Pure. A degenerate (zero-length) segment reduces to the
 *  point-to-endpoint distance. */
export function _pointSegmentDistanceXZ(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const wx = px - ax, wz = pz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * vx, cz = az + t * vz;
  return Math.hypot(px - cx, pz - cz);
}

/** Which outer tile slots (indices 1..6 of TILE_SLOTS) sit on a road deck
 *  crossing this tile — i.e. their world position is within `reach` of any road
 *  stroke segment. A forest tree placed in such a slot would visibly overlap
 *  the road, so `forestTreesForHex` excludes these slots (dropping surplus
 *  trees rather than relocating them onto the deck).
 *
 *  `strokes` are world-XZ polylines exactly as `networkStrokesForTile` returns
 *  them (`[{x,z}, …]` arrays). `center` is the hex centre `{x, z}` so the
 *  local TILE_SLOTS offsets can be lifted into world space for the comparison.
 *  The centre slot (0) is never returned — it is reserved for a standee and
 *  never carries a tree. Pure; exported for tests. */
export function roadBlockedTreeSlots(strokes, center, reach = FOREST_ROAD_TREE_REACH) {
  const blocked = new Set();
  if (!Array.isArray(strokes) || strokes.length === 0 || !center) return blocked;
  for (let i = 1; i < TILE_SLOTS.length; i++) {
    const px = center.x + TILE_SLOTS[i].x;
    const pz = center.z + TILE_SLOTS[i].z;
    for (const stroke of strokes) {
      if (!Array.isArray(stroke) || stroke.length < 2) continue;
      let hit = false;
      for (let s = 0; s + 1 < stroke.length; s++) {
        const a = stroke[s], b = stroke[s + 1];
        if (_pointSegmentDistanceXZ(px, pz, a.x, a.z, b.x, b.z) <= reach) {
          hit = true;
          break;
        }
      }
      if (hit) { blocked.add(i); break; }
    }
  }
  return blocked;
}

/** Per-tile ribbon width for one network stroke. A ROAD segment on a
 *  FOREST-base tile narrows by FOREST_ROAD_WIDTH_FACTOR (renders 20% thinner)
 *  so the flanking trees have room and the deck doesn't crowd them. Rivers and
 *  roads on any non-forest base keep the full `baseWidth`. Width is decided
 *  per-tile, so a road spanning a forest tile and a grass tile narrows only on
 *  the forest tile's stroke. Pure; exported for tests. */
export function roadTileRibbonWidth(networkName, tile, baseWidth) {
  if (networkName === 'road' && baseOf(tile) === TileType.FOREST) {
    return baseWidth * FOREST_ROAD_WIDTH_FACTOR;
  }
  return baseWidth;
}

// ─── Road / river bezier networks (exported for tests) ─────────────────────
//
// Ports the 2D renderer's _drawRiverLayer / _drawRoadLayer logic to 3D.
// For each river/road/bridge tile we build smooth quadratic-bezier strokes
// between edge midpoints (control point = hex centre), then widen each stroke
// into a flat ribbon strip (parallel-offset paths fed to MeshBuilder.CreateRibbon)
// at a constant Y just above the terrain disc. Finally MergeMeshes collapses
// all per-tile ribbons into ONE mesh per network so the GPU sees minimal
// draw calls. Ribbons lie flat on the terrain — no vertical undulation —
// retaining the curved bezier shape in the XZ plane.
//
// Tile underneath stays grass (see tileColorFor / terrainSpriteIdFor above).
// Bridges are special: they appear in BOTH networks (a water bezier flows
// through, a road bezier crosses); the bridge plank floats above both.

/** River ribbon width in world units. Hex-width = SQRT3 ≈ 1.732, so this is
 *  roughly half the hex width — broad enough to read as a river without
 *  spilling outside the tile diamond. */
// Roads and rivers used to sit ~0.085 above the ground tile so they wouldn't
// z-fight with the hex prism. Now that tiles are flat polygons at Y=0, the
// ribbons just need a small polygon-offset-style epsilon to win the depth
// fight without visibly hovering. 0.005 reads as flush — the new directional
// sun cast shadows ACROSS the old raised ribbons that made them look levitated.
export const RIVER_RIBBON_WIDTH = 0.85;
/** Road ribbon width — narrower than the river (matches the 2D path's strokeWidth
 *  ratio: rivers wider than roads). ~0.35 × hex-width. */
export const ROAD_RIBBON_WIDTH  = 0.6;
/** Road segments laid through a FOREST-base tile render this fraction of the
 *  normal width (20% narrower) so the flanking trees have room and don't crowd
 *  the deck. Non-forest road tiles keep the full ROAD_RIBBON_WIDTH. Applied
 *  per-tile in `_buildNetworkMesh` (see the forest→grass seam note there).
 *  Operator-tunable. */
export const FOREST_ROAD_WIDTH_FACTOR = 0.8;
/** Y above tile prism top (0.075) and disc top (0.084) — ribbon hugs the terrain. */
export const RIVER_RIBBON_Y     = 0.005;
/** Road sits clearly above the river so the road tube paints OVER the water at
 *  river crossings — the bridge plank is disabled (`_renderBridges = false`),
 *  so the road ribbon is the only thing carrying the visual at the crossing.
 *  Previous 0.008 value left a 3 mm gap that was too small for Babylon's
 *  alpha-blend depth sort to reliably resolve at typical camera tilts; with
 *  the river ribbon at 0.005 and road at 0.025 the depth fight is no longer
 *  close. Combined with `alphaIndex` (road > river) in `_buildNetworkMesh`,
 *  this guarantees road > river ordering even when the per-mesh distance
 *  sort flips on a particular camera angle. Still <0.05 so the road keeps
 *  hugging the terrain rather than visibly levitating. */
export const ROAD_RIBBON_Y      = 0.025;
/** Babylon `mesh.alphaIndex` values for the river / road merged ribbon meshes.
 *  Within renderingGroupId 0, Babylon's transparent pass sorts alpha-blended
 *  meshes by `alphaIndex` ascending (lower draws first → behind). Setting
 *  river < road forces the road to render AFTER the river at every river /
 *  road crossing, regardless of the per-mesh distance sort. Paired with the
 *  road's elevated Y (`ROAD_RIBBON_Y`) so the depth-buffer path agrees with
 *  the alpha sort. */
export const RIVER_ALPHA_INDEX = 100;
export const ROAD_ALPHA_INDEX  = 200;
/** Stable `alphaIndex` values for the FADED (alpha < 1) border-forest band
 *  meshes — the dissolving outer rings of ground discs and foliage. Without an
 *  explicit index every faded band mesh sits at Babylon's default
 *  `Number.MAX_VALUE`, so they all tie and the transparent pass falls back to
 *  sorting them by distance-to-camera every frame. Across the ring of coplanar
 *  ground discs and the foliage stacked on top, that distance order reshuffles
 *  constantly as the camera moves (measured: the band's transparent draw order
 *  changed in 59 of 60 frames over a slow yaw sweep), popping the alpha blend —
 *  the same per-mesh-distance-sort flicker the road/river ribbons already pin
 *  away via RIVER/ROAD_ALPHA_INDEX. Ground < trees < river keeps the natural
 *  back-to-front layering (foliage in front of the ground it stands on, water
 *  on top) stable regardless of camera angle. Kept below RIVER_ALPHA_INDEX so
 *  the river extension still draws last. */
export const BORDER_GROUND_ALPHA_INDEX = 80;
export const BORDER_TREE_ALPHA_INDEX   = 90;
/** Number of bezier samples per stroke. 10 is smooth enough at this radius
 *  without bloating the tube vertex count on Campaign-size maps. */
// Bumped from 10 → 22 — at tight bezier bends the old segment count produced
// visible polygon seams (especially on the wider river ribbon), and the ribbon
// width-fade pass (per-vertex alpha tapering at the road endpoints) needs more
// segments to read as a smooth fade rather than a 3-step stair.
export const NETWORK_BEZIER_SEGMENTS = 22;

/** Fraction of the ribbon's diffuse colour copied into `emissiveColor`. After
 *  flipping the ribbon's face normals to point +Y (see `_buildNetworkMesh`),
 *  the lit term carries the full diffuse colour from the hemispheric light —
 *  but the road and river TILE_COLORs are themselves dark (`#6b5a3e` ≈ 0.42,
 *  `#1a3d5c` ≈ 0.10–0.36), and phase tinting can crush channels further at
 *  night/dusk. A 0.45 emissive lift floors the strip's apparent brightness so
 *  it stays legible against the grass and dirt terrain regardless of phase,
 *  without reading as self-glowing. PR #323's
 *  0.15 was sized for tube geometry that already caught wraparound from the
 *  hemi light's rounded cross-section; flat ribbons need more help. */
export const RIBBON_EMISSIVE_SCALE = 0.45;

/** Pure helper: split a CSS hex colour into `{ diffuse, emissive }` Color3
 *  tuples for a ribbon material. `emissive = diffuse × RIBBON_EMISSIVE_SCALE`.
 *  Diffuse is brightened by `RIBBON_DIFFUSE_BOOST` first — the 2D-shared
 *  TILE_COLORs are dark (#1a3d5c river, #6b5a3e road) and the new daytime
 *  lighting wash makes them read as near-black under the bright sun.
 *  Kept pure so the colour math can be unit-tested without Babylon. */
export const RIBBON_DIFFUSE_BOOST = 1.85;
export function ribbonMaterialColors(hexColor) {
  const [r, g, b] = cssHexToRgb01(hexColor);
  const k = RIBBON_DIFFUSE_BOOST;
  const dr = Math.min(1, r * k);
  const dg = Math.min(1, g * k);
  const db = Math.min(1, b * k);
  const s = RIBBON_EMISSIVE_SCALE;
  return {
    diffuse:  [dr, dg, db],
    emissive: [dr * s, dg * s, db * s],
  };
}

/** Apothem (centre-to-edge distance) for a unit-radius pointy-top hex. */
const HEX_APOTHEM = SQRT3 / 2;

/**
 * Given a list of bezier sample points in the XZ plane and a target ribbon
 * width, return two parallel offset paths of the same length, equidistant
 * from each input point along the perpendicular to the local tangent.
 *
 * Pure — no Babylon dependency. The renderer supplies a constant Y when
 * building Vector3s from the returned `{x, z}` records, so the resulting
 * ribbon lies flat on the terrain.
 *
 * Tangent at point i:
 *   • i = 0          → forward difference  (points[1] − points[0])
 *   • i = n − 1      → backward difference (points[n-1] − points[n-2])
 *   • otherwise      → central difference  (points[i+1] − points[i-1])
 *
 * Perpendicular (in XZ): rotate tangent 90° around the Y axis, i.e.
 *   (tx, tz) ↦ (−tz, tx).
 *
 * Returns `{ left, right }` — each an array of `{ x, z }` records of the same
 * length as `points`. Left = +perp side, right = −perp side; the labels are
 * arbitrary, what matters is that the two paths are on opposite sides.
 */
export function ribbonOffsetPaths(points, width) {
  if (!Array.isArray(points) || points.length < 2) {
    return { left: [], right: [] };
  }
  // `width` may be a scalar (uniform width along the ribbon) OR an array of
  // per-point widths (each point gets its own width — used to introduce
  // smooth thickness variation along the ribbon's length).
  const isArray = Array.isArray(width);
  const n = points.length;
  const left  = new Array(n);
  const right = new Array(n);
  for (let i = 0; i < n; i++) {
    let tx, tz;
    if (i === 0) {
      tx = points[1].x - points[0].x;
      tz = points[1].z - points[0].z;
    } else if (i === n - 1) {
      tx = points[n - 1].x - points[n - 2].x;
      tz = points[n - 1].z - points[n - 2].z;
    } else {
      tx = points[i + 1].x - points[i - 1].x;
      tz = points[i + 1].z - points[i - 1].z;
    }
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    const px = -tz, pz = tx;
    const w  = isArray ? width[i] : width;
    const half = w / 2;
    left[i]  = { x: points[i].x + px * half, z: points[i].z + pz * half };
    right[i] = { x: points[i].x - px * half, z: points[i].z - pz * half };
  }
  return { left, right };
}

/** Pure helper: face normal (unit vector) of the first triangle CreateRibbon
 *  emits for a `pathArray = [path0, path1]` ribbon. Babylon builds each rung
 *  of the strip as the triangle `(path0[i], path1[i], path0[i+1])`, so the
 *  normal is `(path1[0] − path0[0]) × (path0[1] − path0[0])` (right-handed
 *  cross), normalised. Inputs are `{ x, y, z }` records.
 *
 *  Exposed so the ribbon-orientation contract — "for our flat top-down strips,
 *  this normal must point +Y so the hemispheric light hits the visible face" —
 *  can be unit-tested without spinning up a Babylon scene. The renderer feeds
 *  `[rightV3, leftV3]` into CreateRibbon precisely so this function returns
 *  `(_, +1, _)` for a forward-going stroke. */
export function ribbonFaceNormal(p0a, p1a, p0b) {
  const ex = p1a.x - p0a.x, ey = (p1a.y ?? 0) - (p0a.y ?? 0), ez = p1a.z - p0a.z;
  const fx = p0b.x - p0a.x, fy = (p0b.y ?? 0) - (p0a.y ?? 0), fz = p0b.z - p0a.z;
  const nx = ey * fz - ez * fy;
  const ny = ez * fx - ex * fz;
  const nz = ex * fy - ey * fx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** Sample a quadratic bezier (p0, control p1, p2) at N+1 evenly-spaced t in [0,1].
 *  Pure — used by the network builder and exposed for unit tests. */
export function sampleQuadBezier(p0, p1, p2, segments = NETWORK_BEZIER_SEGMENTS) {
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push({
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      z: u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
    });
  }
  return out;
}

/** Unit vector and edge midpoint from hex centre `here` toward neighbour `there`.
 *  Returns `{ dx, dz, mx, mz }` — dx/dz normalised; mx/mz the point on the
 *  shared hex edge halfway between centres. */
export function _edgeTo(here, there, radius = HEX_RADIUS_WORLD) {
  const dx = there.x - here.x;
  const dz = there.z - here.z;
  const d  = Math.hypot(dx, dz) || 1;
  const apo = HEX_APOTHEM * radius;
  return {
    dx: dx / d, dz: dz / d,
    mx: here.x + (dx / d) * apo,
    mz: here.z + (dz / d) * apo,
  };
}

/**
 * Compute the bezier strokes for a single river OR road tile.
 *
 *   tile         — the source tile (uses tile.col, tile.row)
 *   neighbours   — array of neighbour offset {col,row} objects that count as
 *                  connected (RIVER+BRIDGE for river network; tile.roadDirs
 *                  → ROAD/BRIDGE/BUILDING for road network).
 *   opts.kind    — 'river' (default) or 'road'. Controls 1-neighbour behaviour:
 *                  rivers extend off-tile (water flows off the map edge),
 *                  roads draw a centre→edge stub (dead-end at a building).
 *
 * Returns an array of "strokes" — each stroke is an array of `{x, z}` sample
 * points (≥ 2 entries) suitable for turning into a tube. May return [] for
 * tiles that should not draw (e.g. an isolated river hex with 0 neighbours).
 *
 * Mirrors src/renderer.js's per-tile geometry:
 *   • 1 neighbour  → river: through-bezier from the off-tile extension to the
 *                    edge. Road: straight stub from centre to edge midpoint.
 *   • 2 neighbours → smooth bezier through centre between the two edges.
 *   • 3+ neighbours → through-bezier on the most-opposing pair, straight
 *                     spokes from centre to the remaining edges.
 */
export function networkStrokesForTile(tile, neighbours, opts = {}) {
  if (!tile || !Array.isArray(neighbours) || neighbours.length === 0) return [];
  const radius = opts.radius ?? HEX_RADIUS_WORLD;
  const segments = opts.segments ?? NETWORK_BEZIER_SEGMENTS;
  const kind = opts.kind ?? 'river';
  const here = hexToWorld(tile.col, tile.row, radius);
  const edges = neighbours.map(n => {
    const there = hexToWorld(n.col, n.row, radius);
    return _edgeTo(here, there, radius);
  });
  const strokes = [];

  if (edges.length === 1) {
    const e = edges[0];
    if (kind === 'road') {
      // Dead-end stub: straight line from centre to the edge midpoint facing
      // the lone neighbour (matches the 2D path at building entrances).
      strokes.push([{ x: here.x, z: here.z }, { x: e.mx, z: e.mz }]);
      return strokes;
    }
    // River: extend off-tile in the opposite direction so endpoints fade past
    // the hex border (matches the 2D path's behaviour at map-edge river tiles).
    const apo = HEX_APOTHEM * radius;
    const p0 = { x: here.x - e.dx * apo, z: here.z - e.dz * apo };
    const p1 = here;
    const p2 = { x: e.mx, z: e.mz };
    strokes.push(sampleQuadBezier(p0, p1, p2, segments));
    return strokes;
  }

  // Pick the most-opposing pair (lowest dot product of unit vectors).
  let pA = 0, pB = 1, minDot = Infinity;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const dot = edges[i].dx * edges[j].dx + edges[i].dz * edges[j].dz;
      if (dot < minDot) { minDot = dot; pA = i; pB = j; }
    }
  }
  const p0 = { x: edges[pA].mx, z: edges[pA].mz };
  const p1 = here;
  const p2 = { x: edges[pB].mx, z: edges[pB].mz };
  strokes.push(sampleQuadBezier(p0, p1, p2, segments));

  // Spokes for any extra branches — straight lines from centre to edge.
  for (let i = 0; i < edges.length; i++) {
    if (i === pA || i === pB) continue;
    strokes.push([{ x: here.x, z: here.z }, { x: edges[i].mx, z: edges[i].mz }]);
  }
  return strokes;
}

/**
 * Walk the full map and build every river segment's bezier strokes.
 * Returns an array of `{ tile, strokes }`. Pure — takes the tile map by
 * reference and a hexKey helper so tests can stub them.
 *
 * River network tiles: RIVER and BRIDGE; neighbours: RIVER and BRIDGE.
 */
export function buildRiverNetworkStrokes(tiles, hexKeyFn = hexKey, getNeighborsFn = getNeighbors) {
  if (!tiles || typeof tiles.values !== 'function') return [];
  const isWater = t => t && (isRiver(t) || isBridge(t));
  const out = [];
  for (const tile of tiles.values()) {
    if (!isWater(tile)) continue;
    const nbrs = getNeighborsFn(tile.col, tile.row)
      .filter(n => isWater(tiles.get(hexKeyFn(n.col, n.row))));
    if (nbrs.length === 0) continue;
    const strokes = networkStrokesForTile(tile, nbrs);
    if (strokes.length > 0) out.push({ tile, strokes });
  }
  return out;
}

/**
 * Walk the full map and build every road segment's bezier strokes.
 * Road network tiles: ROAD, BRIDGE, and BUILDING. Neighbours come from
 * `tile.roadDirs` (a Set of hexKeys recorded at generation time) — this is
 * what the 2D renderer uses, so phantom-junction inference is avoided.
 *
 * BUILDING tiles participate when they sit on the road MST so the 3D ribbon
 * reads as contiguous through the village (the box prop only occupies slot 1,
 * leaving plenty of the hex top for the ribbon underneath).
 */
export function buildRoadNetworkStrokes(tiles, hexKeyFn = hexKey) {
  if (!tiles || typeof tiles.values !== 'function') return [];
  const out = [];
  for (const tile of tiles.values()) {
    if (!tile) continue;
    // Road network = road tiles, bridges, and building tiles. Buildings carry
    // their road-through purely via `roadDirs` (their `path` layer is null), so
    // they're included by hasBuilding(), NOT by a path===road test.
    if (pathOf(tile) !== PathType.ROAD
      && !isBridge(tile)
      && !hasBuilding(tile)) continue;
    if (!tile.roadDirs || tile.roadDirs.size === 0) continue;
    const nbrs = [];
    for (const k of tile.roadDirs) {
      const nt = tiles.get(k);
      if (nt) nbrs.push({ col: nt.col, row: nt.row });
    }
    if (nbrs.length === 0) continue;
    const strokes = networkStrokesForTile(tile, nbrs, { kind: 'road' });
    if (strokes.length > 0) out.push({ tile, strokes });
  }
  return out;
}

// ─── River extensions past the playable map edge ──────────────────────────
//
// The playable map is wrapped in a forest band (see `_buildMapBorderForest`)
// so the edge reads as "world continues into wilderness" rather than a hard
// cut-off. When a river crosses that edge, however, the ribbon stops at the
// last playable tile and the band visually swallows the water — disrupting
// the impression that the river flows on into the forest.
//
// To bridge the gap we identify each river "exit" — a RIVER/BRIDGE tile with
// exactly one water neighbour, i.e. a natural endpoint of the river network
// — and emit a straight-line ribbon continuing outward in the river's exit
// tangent direction for the full depth of the surrounding forest band. The
// extension is built as a Babylon ribbon mesh sharing the same material as
// the in-map river network, so the colour and lighting match exactly. The
// mesh lives in `_borderPropsByKey` alongside the band's forest props, so it
// follows the same visual-only lifecycle (not in `state.tiles`, never
// pathable, ignored by fog).

/** Identify river endpoints that exit the playable map. A RIVER or BRIDGE
 *  tile is an exit when it has exactly ONE water neighbour — the in-map
 *  bezier on such a tile already extends slightly off-tile in the opposite
 *  direction (see the 1-neighbour branch of `networkStrokesForTile`), so the
 *  exit point sits where that bezier ends and the extension's tangent points
 *  outward in the same direction.
 *
 *  Pure (no Babylon dependency). Returns an array of
 *    `{ tile: {col, row}, point: {x, z}, tangent: {x, z} }`
 *  records — `point` is the world-XZ position of the river ribbon's outward
 *  endpoint and `tangent` is the unit vector continuing past the playable
 *  map. Empty input or no-exit maps return `[]`. */
export function riverExitPoints(
  tiles,
  hexKeyFn = hexKey,
  getNeighborsFn = getNeighbors,
  radius = HEX_RADIUS_WORLD,
) {
  if (!tiles || typeof tiles.values !== 'function') return [];
  const isWater = t => t && (isRiver(t) || isBridge(t));
  const apo = HEX_APOTHEM * radius;
  const out = [];
  for (const tile of tiles.values()) {
    if (!isWater(tile)) continue;
    const nbrs = getNeighborsFn(tile.col, tile.row)
      .filter(n => isWater(tiles.get(hexKeyFn(n.col, n.row))));
    if (nbrs.length !== 1) continue;
    const here  = hexToWorld(tile.col, tile.row, radius);
    const there = hexToWorld(nbrs[0].col, nbrs[0].row, radius);
    const dx = there.x - here.x;
    const dz = there.z - here.z;
    const d  = Math.hypot(dx, dz) || 1;
    // Tangent points AWAY from the only water neighbour — i.e. outward.
    const tangent = { x: -dx / d, z: -dz / d };
    // The in-map river bezier on this tile begins at p0 = here + tangent*apo
    // (see `networkStrokesForTile` 1-neighbour branch). That's the exact
    // point the visible river ribbon reaches before stopping.
    const point = { x: here.x + tangent.x * apo, z: here.z + tangent.z * apo };
    out.push({ tile: { col: tile.col, row: tile.row }, point, tangent });
  }
  return out;
}

/** Build the offset-path pair (`{left, right}`) for a straight river ribbon
 *  starting at `exit.point` and running for `length` world units along
 *  `exit.tangent`. Width defaults to RIVER_RIBBON_WIDTH so the extension
 *  matches the in-map ribbon's footprint exactly.
 *
 *  Pure helper — returns the same `{left, right}` shape as
 *  `ribbonOffsetPaths`, ready to be fed into `MeshBuilder.CreateRibbon` by
 *  the caller after wrapping each `{x, z}` in a `Vector3(x, RIVER_RIBBON_Y, z)`.
 *
 *  `segments` controls how many sample points along the line; even a low
 *  value (4) is fine for a straight extension since `ribbonOffsetPaths`'s
 *  per-sample perpendicular only depends on the tangent (constant here). */
export function riverExtensionRibbon(
  exit,
  length,
  width = RIVER_RIBBON_WIDTH,
  segments = 4,
) {
  if (!exit || !exit.point || !exit.tangent || !(length > 0)) {
    return { left: [], right: [] };
  }
  const seg = Math.max(1, segments | 0);
  const points = new Array(seg + 1);
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    points[i] = {
      x: exit.point.x + exit.tangent.x * length * t,
      z: exit.point.z + exit.tangent.z * length * t,
    };
  }
  return ribbonOffsetPaths(points, width);
}

// ─── Forest layout (deterministic per hex, exported for tests) ──────────────

/** Bounds for the forest tree ring around a hex centre. Trees never enter the
 *  inner FOREST_INNER_RADIUS so an entity standee placed on the tile is not
 *  hidden by props. Outer bound stays clear of the hex edge so trees don't
 *  bleed visually into neighbouring tiles at oblique camera angles. */
export const FOREST_INNER_RADIUS = 0.5;
export const FOREST_OUTER_RADIUS = 0.85;
/** Per-tree scale range — picked from a hash so the same hex always looks the
 *  same across runs but the cluster reads as visually varied. */
export const FOREST_SCALE_MIN = 0.5;
export const FOREST_SCALE_MAX = 1.2;
/** Cluster size range (inclusive). */
export const FOREST_TREES_MIN = 3;
export const FOREST_TREES_MAX = 5;

/** Half-width of the (narrowed) road deck through a forest tile, world units. */
export const FOREST_ROAD_HALF_WIDTH = (ROAD_RIBBON_WIDTH * FOREST_ROAD_WIDTH_FACTOR) / 2;
/** Extra clearance past the road half-width when deciding which forest tree
 *  slots sit on the deck (≈ a tree-base radius). Bigger = trees kept further
 *  off the road, but blocks more slots and thins the cluster. Tunable. */
export const FOREST_ROAD_TREE_CLEARANCE = 0.12;
/** A forest tree slot is dropped if its centre lies within this distance of any
 *  road segment crossing the tile. = narrowed half-width + tree-base clearance.
 *  Kept below the diagonal outer-slot distance (~0.42) so an axis-aligned road
 *  only blocks the two in-line slots, leaving the corner slots for trees. */
export const FOREST_ROAD_TREE_REACH = FOREST_ROAD_HALF_WIDTH + FOREST_ROAD_TREE_CLEARANCE;

/** Deterministic [0, 1) hash from (col, row, salt). Tiny integer mixer — not
 *  cryptographic, just stable across runs and well-distributed enough for
 *  placement jitter. */
function _forestHash(col, row, salt) {
  let h = ((col | 0) * 73856093) ^ ((row | 0) * 19349663) ^ ((salt | 0) * 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x100000000;
}

/** Deterministic forest layout for a hex. Returns an array of
 *  `{ id, x, z, scale, slotIdx, species, shadeIdx }` entries — N entries where
 *  N ∈ [FOREST_TREES_MIN, FOREST_TREES_MAX]. Positions come from the unified
 *  tile-slot system (outer ring only — the centre is reserved for standees).
 *  Per-tree scale, species, and leaf-shade index are all hex-stable so the
 *  same forest hex always paints the same cluster across sessions. Pure:
 *  same (col, row) → same trees.
 *
 *  `opts.reserveBuildingSlot` — set on a building-on-forest tile so the trees
 *  SKIP BUILDING_SLOT_INDEX (the slot the procedural building box occupies).
 *  Mirrors the additive staticOccupants the draw-time standee re-slot reserves
 *  (see `_syncEntityStandees`): a building occupant is fed into the slot
 *  assignment but excluded from the returned cluster — only trees are returned.
 *  Without this, tree[0] would be baked at the building's slot and clip through
 *  it. Plain (non-building) forest tiles leave it false and use the full ring.
 *
 *  `opts.blockedSlots` — a Set of TILE_SLOTS indices a road deck crosses on
 *  this tile (computed via `roadBlockedTreeSlots`). Trees skip those slots so
 *  cones never land on the road mesh; surplus trees beyond the remaining free
 *  slots are dropped. Empty / omitted on a roadless forest tile. */
export function forestTreesForHex(col, row, season = null, opts = {}) {
  const reserveBuildingSlot = !!opts.reserveBuildingSlot;
  const span = FOREST_TREES_MAX - FOREST_TREES_MIN + 1;
  const n    = FOREST_TREES_MIN + Math.floor(_forestHash(col, row, 0) * span);
  // _forestHash returns < 1, so floor(<span) ∈ [0, span-1]; n ∈ [MIN, MAX].
  const scaleSpan = FOREST_SCALE_MAX - FOREST_SCALE_MIN;
  // Rotate the slot order per-hex so neighbouring forest hexes don't all
  // start at the same NE slot — keeps the visual variety the ring layout had.
  const rotation = Math.floor(_forestHash(col, row, 99) * 6);
  // Build deterministic occupant ids; assignTileSlotIndices sorts by id, so
  // a rotation embedded in the id is what reorders the slot picks.
  const occupants = [];
  for (let i = 0; i < n; i++) {
    const order = ((i + rotation) % 6).toString().padStart(2, '0');
    occupants.push({ id: `tree_${order}_${i}`, kind: 'tree', _idx: i });
  }
  // On a building tile, hand a building occupant to the slot allocator so it
  // claims BUILDING_SLOT_INDEX and trees fall into the remaining outer slots.
  // It is NOT pushed onto `occupants`, so the returned cluster is trees only.
  const slotInput = reserveBuildingSlot
    ? [{ id: 'building', kind: 'building' }, ...occupants]
    : occupants;
  const { slotByOccupantId } = assignTileSlotIndices(slotInput, {
    reservedSlots: opts.blockedSlots,
  });
  const trees = [];
  for (const occ of occupants) {
    // A tree whose slot was taken by the building or a road deck (blockedSlots)
    // gets no assignment — drop it rather than piling it on the centre (which
    // sits on the road / is reserved for a standee).
    const slotIdx = slotByOccupantId.get(occ.id);
    if (slotIdx === undefined) continue;
    const slot = TILE_SLOTS[slotIdx];
    const scale = FOREST_SCALE_MIN + _forestHash(col, row, occ._idx * 3 + 3) * scaleSpan;
    trees.push({
      id: occ.id, x: slot.x, z: slot.z, scale, slotIdx,
      species:  treeSpeciesForHex(col, row, occ._idx, season),
      shadeIdx: treeLeafShadeIndex(col, row, occ._idx),
    });
  }
  return trees;
}

// ─── Tree species + leaf-shade variety (pure helpers, exported) ─────────────
//
// Three species — pine (current 3-cone silhouette), oak (trunk + sphere
// foliage), spruce (slim, taller 4-tier cone). Per-tree species and a small
// leaf-shade index are both hash-seeded by (col, row, treeIndex) so the same
// forest hex always paints the same cluster.
//
// Leaf-shade index picks one of TREE_LEAF_SHADES_PER_SPECIES entries from the
// species palette. Discretising into a handful of buckets (rather than full
// continuous HSL jitter) keeps the per-tile leaf mesh count bounded: the
// renderer groups leaves by colour and merges each group into one mesh, so
// {3 species × 3 shades} caps leaf draw calls per tile at 9 worst-case —
// in practice ≤ 5 since a hex carries at most 5 trees.

/** Tree species, in stable order. Hash-seeded selection lands one of these
 *  per tree via `treeSpeciesForHex`. */
export const TREE_SPECIES = Object.freeze(['pine', 'oak', 'spruce']);

/** Number of leaf-colour shades per species. */
export const TREE_LEAF_SHADES_PER_SPECIES = 3;

/** Season identifiers, picked deterministically per map. */
export const SEASONS = Object.freeze(['summer', 'fall', 'spring', 'winter']);

/** Species probabilities per season. Pines + spruces dominate; oak is a rare
 *  accent. Winter pushes oak even lower (most deciduous trees are bare). */
export const SEASON_SPECIES_PROBABILITIES = Object.freeze({
  summer: Object.freeze({ pine: 0.50, spruce: 0.43, oak: 0.07 }),
  fall:   Object.freeze({ pine: 0.50, spruce: 0.43, oak: 0.07 }),
  spring: Object.freeze({ pine: 0.50, spruce: 0.43, oak: 0.07 }),
  winter: Object.freeze({ pine: 0.55, spruce: 0.43, oak: 0.02 }),
});

/** Default species probabilities — pine + spruce dominate, oak is a minor
 *  accent (~5-10%). Used when no season is supplied. */
export const DEFAULT_SPECIES_PROBABILITIES = SEASON_SPECIES_PROBABILITIES.summer;

/** Return the species probability table for a season (falls back to summer). */
export function seasonalSpeciesProbabilities(season) {
  return SEASON_SPECIES_PROBABILITIES[season] || DEFAULT_SPECIES_PROBABILITIES;
}

/** Leaf-colour palette per species (bright / lit / "in-map forest" variant).
 *  Summer-default. Seasonal variants live in SEASONAL_LEAF_PALETTES. */
export const TREE_LEAF_PALETTE = Object.freeze({
  pine:   Object.freeze(['#234c1f', '#2c5a22', '#1c4319']),
  oak:    Object.freeze(['#3d6b28', '#4a7a30', '#355f24']),
  spruce: Object.freeze(['#1b3b2a', '#234a32', '#163528']),
});

/** Leaf-colour palette per species, pre-multiplied by the border-forest fog
 *  tint. Matches the historical `#0e1f0c` (the old uniform fogged leaf colour)
 *  in average tone but spreads across three shades per species. Summer-default. */
export const TREE_LEAF_PALETTE_FOG = Object.freeze({
  pine:   Object.freeze(['#0e1f0c', '#11240e', '#0c1a0a']),
  oak:    Object.freeze(['#162a10', '#1a3214', '#13240d']),
  spruce: Object.freeze(['#0c1a12', '#0f2017', '#091410']),
});

/** Per-season leaf-colour palettes. Each season provides the same shape as
 *  TREE_LEAF_PALETTE: 3 species × TREE_LEAF_SHADES_PER_SPECIES shades. That
 *  caps the merged leaf-mesh count at 9 colour buckets per band regardless
 *  of season — the cross-tile merge invariant (≤10 meshes) still holds. */
export const SEASONAL_LEAF_PALETTES = Object.freeze({
  summer: TREE_LEAF_PALETTE,
  // Conifers stay deep green; oaks turn warm orange / red / amber.
  fall: Object.freeze({
    pine:   Object.freeze(['#274a1c', '#305820', '#1d3c15']),
    oak:    Object.freeze(['#c45a16', '#d68b1a', '#a83a0d']),
    spruce: Object.freeze(['#1c3826', '#22422d', '#152a1d']),
  }),
  // Fresh light greens with occasional oak blossom (one shade is a pale
  // pink/white so ~1/3 of oaks blossom).
  spring: Object.freeze({
    pine:   Object.freeze(['#3d7e2a', '#4c8c33', '#357024']),
    oak:    Object.freeze(['#9bd16a', '#f5d6df', '#f0e6e8']),
    spruce: Object.freeze(['#2d6446', '#356f4e', '#235639']),
  }),
  // Cool dark conifers with a desaturated snowy-tint shade for variety; bare
  // oaks (the crown is dropped in winter — see _buildTreeClusterMeshes — so
  // these oak entries are effectively unused but kept for shape parity).
  winter: Object.freeze({
    pine:   Object.freeze(['#1a2a18', '#c8d4d2', '#152418']),
    oak:    Object.freeze(['#5e472a', '#6d5230', '#4a3722']),
    spruce: Object.freeze(['#13251c', '#cdd8d5', '#0d1c14']),
  }),
});

/** Fogged-band variants of the seasonal palettes. Each season has a matching
 *  darkened palette so the border-forest band's atmospheric tint still applies. */
export const SEASONAL_LEAF_PALETTES_FOG = Object.freeze({
  summer: TREE_LEAF_PALETTE_FOG,
  fall: Object.freeze({
    pine:   Object.freeze(['#10210e', '#142a10', '#0c1a09']),
    oak:    Object.freeze(['#5a290a', '#6c3f0c', '#4a1d06']),
    spruce: Object.freeze(['#0e1c13', '#10211a', '#091410']),
  }),
  spring: Object.freeze({
    pine:   Object.freeze(['#1a3812', '#1f4015', '#15300f']),
    oak:    Object.freeze(['#3f5a25', '#5a4b50', '#564a4c']),
    spruce: Object.freeze(['#172e1f', '#1c3624', '#10221a']),
  }),
  winter: Object.freeze({
    pine:   Object.freeze(['#0c130b', '#3a423f', '#0a110b']),
    oak:    Object.freeze(['#231a10', '#2a1f12', '#1c150d']),
    spruce: Object.freeze(['#091310', '#3d4441', '#070e0a']),
  }),
});

/** Look up the leaf-colour palette for a season (with optional fog tint). */
export function seasonalLeafPalette(season, { fogged = false } = {}) {
  const map = fogged ? SEASONAL_LEAF_PALETTES_FOG : SEASONAL_LEAF_PALETTES;
  return map[season] || map.summer;
}

/** Deterministic species pick for one tree on (col, row). When `season` is
 *  passed, uses that season's probability table; otherwise uses the default
 *  (summer-like — pine + spruce dominate, oak ~7%). */
export function treeSpeciesForHex(col, row, treeIndex, season = null) {
  const h = _forestHash(col, row, treeIndex * 7 + 101);
  const p = season ? seasonalSpeciesProbabilities(season) : DEFAULT_SPECIES_PROBABILITIES;
  // Cumulative roll in stable order so the same hash always picks the same
  // species for the same probability table.
  if (h < p.pine) return 'pine';
  if (h < p.pine + p.spruce) return 'spruce';
  return 'oak';
}

/** Deterministic shade index ∈ [0, TREE_LEAF_SHADES_PER_SPECIES). */
export function treeLeafShadeIndex(col, row, treeIndex) {
  return Math.floor(
    _forestHash(col, row, treeIndex * 11 + 137) * TREE_LEAF_SHADES_PER_SPECIES,
  );
}

/** Look up the actual leaf colour string for one tree, given its species and
 *  shade index. `fogged: true` returns the border-forest variant. `season` —
 *  when supplied — picks the seasonal palette; otherwise the summer-default
 *  TREE_LEAF_PALETTE is used. */
export function treeLeafColorFor(species, shadeIdx, { fogged = false, season = null } = {}) {
  const palette = season
    ? seasonalLeafPalette(season, { fogged })
    : (fogged ? TREE_LEAF_PALETTE_FOG : TREE_LEAF_PALETTE);
  const shades  = palette[species] || palette.pine;
  return shades[shadeIdx % shades.length];
}

/** Deterministic 32-bit hash of a tiles map (Map<hexKey, tile>). Used to
 *  derive the per-map season seed when the game state doesn't expose a
 *  `mapSeed` explicitly. Iterates keys in sorted order so two structurally
 *  identical maps always hash equal. Returns an unsigned 32-bit integer. */
export function hashTileLayout(tiles) {
  if (!tiles || typeof tiles.keys !== 'function') return 0;
  const keys = [...tiles.keys()].sort();
  if (keys.length === 0) return 0;
  // FNV-1a 32-bit over the concatenated sorted keys.
  let h = 2166136261 >>> 0;
  for (const key of keys) {
    const s = String(key);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // Separator so "1,2" + "3" doesn't collide with "1" + "2,3".
    h ^= 0x7c;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic season pick from a non-negative integer seed hash. */
export function pickSeason(seedHash) {
  const idx = Math.abs((seedHash | 0)) % SEASONS.length;
  return SEASONS[idx];
}

// ─── Building dimension variation (pure helper, exported) ───────────────────
//
// Buildings used to all share a fixed (0.55 × 0.7 × 0.55) box + matching roof.
// To add silhouette variety we apply a small hash-seeded ±BUILDING_DIM_JITTER
// jitter on each axis independently. Bounded so silhouettes still read as
// buildings (no 3× tall stalks or razor-thin slivers). Roof scales with the
// box footprint so the eave overhang stays proportional; roof height is held
// constant so the lid still reads as a lid.

/** ±jitter applied to each box dimension. ±15% keeps the silhouettes varied
 *  but recognisable as buildings — well under the building-vs-tree-vs-rock
 *  silhouette ambiguity threshold. */
export const BUILDING_DIM_JITTER = 0.15;

/** Base box dimensions before jitter (matches the historical fixed values). */
export const BUILDING_BASE_DIM = Object.freeze({ width: 0.55, height: 0.70, depth: 0.55 });

/** Base roof dimensions before footprint scaling. Roof width / depth scale
 *  with the box; roof height is constant so the lid silhouette stays crisp. */
export const BUILDING_ROOF_DIM = Object.freeze({ width: 0.62, height: 0.15, depth: 0.62 });

/** Deterministic yaw (radians, [0, 2π)) for the house instance on (col, row).
 *  Spins each building around its vertical axis so identical models read as a
 *  village rather than a regimented row. Uses a fresh hash seed so yaw doesn't
 *  correlate with the existing dimension jitter. */
export function houseYawForHex(col, row) {
  return _forestHash(col, row, 251) * Math.PI * 2;
}

/** Per-hex anisotropic scaling factors for the house instance, derived from
 *  the existing `buildingDimensionsForHex` so the procedural-vs-instance paths
 *  share one source of jitter. Each axis ratio = jittered-box-axis / base. */
export function houseInstanceScalingForHex(col, row) {
  const dims = buildingDimensionsForHex(col, row);
  return {
    x: dims.box.width  / BUILDING_BASE_DIM.width,
    y: dims.box.height / BUILDING_BASE_DIM.height,
    z: dims.box.depth  / BUILDING_BASE_DIM.depth,
  };
}

/** Deterministic dimensions for the building on (col, row). Returns
 *  `{ box: {width, height, depth}, roof: {width, height, depth} }`. */
export function buildingDimensionsForHex(col, row) {
  const jw = (_forestHash(col, row, 211) - 0.5) * 2 * BUILDING_DIM_JITTER;
  const jd = (_forestHash(col, row, 223) - 0.5) * 2 * BUILDING_DIM_JITTER;
  const jh = (_forestHash(col, row, 227) - 0.5) * 2 * BUILDING_DIM_JITTER;
  const box = {
    width:  BUILDING_BASE_DIM.width  * (1 + jw),
    height: BUILDING_BASE_DIM.height * (1 + jh),
    depth:  BUILDING_BASE_DIM.depth  * (1 + jd),
  };
  // Roof overhangs the box by the historical ratio (0.62 / 0.55 ≈ 1.127).
  const overhang = BUILDING_ROOF_DIM.width / BUILDING_BASE_DIM.width;
  const roof = {
    width:  box.width * overhang,
    height: BUILDING_ROOF_DIM.height,
    depth:  box.depth * overhang,
  };
  return { box, roof };
}

// ─── Phase 6 constants (exported for tests) ─────────────────────────────────

/** Hemispheric-light + clear-colour config per game phase.
 *  intensity → light.intensity; color → light.diffuse (warm at dawn/dusk,
 *  white at day, cool blue at night); clear → scene.clearColor (sky/horizon
 *  tint that shows through gaps and behind transparent props); sun.dir →
 *  DirectionalLight.direction (low-angle warm at dawn/dusk, near-overhead at
 *  day, irrelevant at night); sun.intensity → DirectionalLight.intensity
 *  (drives the strength of cast shadows). */
// Hemi (ambient fill) is kept low so shadows from the directional sun read as
// real dark patches rather than getting washed out — shadows only darken the
// sun's contribution, so a strong hemi makes them invisible. Sun is boosted to
// keep the overall brightness similar to pre-shadow tuning.
// `ambient` per phase = `scene.ambientColor`, which mixes with each material's
// ambientColor (default white on StandardMaterial) to lift faces that the
// directional sun can't reach. Day uses a low neutral grey (sun dominates),
// dawn/dusk add a warm orange tint, night a cool blue-violet, both at higher
// intensity so the map stays readable when the sun is low or off.
export const PHASE_LIGHT_CONFIG = Object.freeze({
  // Operator-tuned values via /admin/lighting (2026-05-22). Dawn / dusk clear
  // (sky) colours pushed toward warm golden tones, night brightened
  // considerably — hemi intensity 1.16 (up from 0.21) so the moonlit map
  // stays readable without the sun. Per-phase fogTint varies meaningfully:
  // dusk 0.65 (light dusty veil), dawn 0.55, night 0.36, day 0.26 (deepest
  // fog when the sun is brightest, since contrast against lit hexes is
  // highest).
  dawn:  {
    intensity: 0.25, color: { r: 1.00, g: 0.82, b: 0.62 }, clear: { r: 0.84, g: 0.65, b: 0.38 },
    ambient: { r: 0.42, g: 0.35, b: 0.30 },
    fogTint: 0.55,
    // Low sun close to the horizon — long shadows raked across the map east-to-west.
    sun: { dir: { x: -0.85, y: -0.40, z: 0.10 }, intensity: 1.20 },
  },
  day:   {
    intensity: 0.43, color: { r: 1.00, g: 1.00, b: 0.97 }, clear: { r: 0.78, g: 0.93, b: 0.93 },
    ambient: { r: 0.22, g: 0.22, b: 0.24 },
    fogTint: 0.26,
    // Tilt the day sun off vertical so shadows actually project a visible
    // footprint. A near-vertical sun (e.g. 0,-1,0) projects a near-zero
    // offset and shadows disappear into the caster itself.
    sun: { dir: { x:  0.35, y: -0.85, z: 0.40 }, intensity: 2.00 },
  },
  dusk:  {
    intensity: 0.25, color: { r: 1.00, g: 0.62, b: 0.48 }, clear: { r: 1.00, g: 0.81, b: 0.73 },
    ambient: { r: 0.45, g: 0.30, b: 0.28 },
    fogTint: 0.65,
    // Low sun mirrored from dawn — long shadows raked west-to-east.
    sun: { dir: { x:  0.85, y: -0.40, z: 0.10 }, intensity: 1.20 },
  },
  night: {
    intensity: 1.16, color: { r: 0.68, g: 0.73, b: 0.86 }, clear: { r: 0.00, g: 0.05, b: 0.15 },
    // Night ambient + hemi carry general visibility; the directional
    // light here acts as moonlight — kept at a modest intensity (was 0.08
    // = effectively off, which meant zero cast shadows at night) so
    // standees / buildings / trees still throw shadows onto the ground
    // under a near-overhead moon. Cool blue-violet ambient preserves the
    // moonlit mood.
    ambient: { r: 0.58, g: 0.66, b: 0.91 },
    fogTint: 0.36,
    // Moon peak direction — clearly tilted off vertical so cast shadows
    // still project. `sunDirectionForRound` overrides for default cycles to
    // sweep east → peak → west across the three night rounds; this value
    // is the per-phase fallback used by custom cycleConfigs.
    sun: { dir: { x:  0.00, y: -0.75, z: 0.35 }, intensity: 0.60 },
  },
});

/** Sun direction for a phase. Pure helper used both internally and by tests. */
export function sunDirectionForPhase(phase) {
  return getPhaseLightConfig(phase).sun.dir;
}

/** Sun direction for a specific round in the day/night cycle. Where
 *  `sunDirectionForPhase` returns the same vector for every round in a phase
 *  (so all three DAY rounds share one overhead direction), this helper sweeps
 *  the sun across the sky as the day progresses — dawn → day1 → day2 → day3
 *  → dusk reads as a clean linear horizontal lerp with a sinusoidal arc on
 *  the vertical, so the sun rises, peaks at noon, and sets without snapping.
 *
 *  Round indexing: this assumes the default 8-step cycle (dawn, day×3, dusk,
 *  night×3). For custom cycleConfigs, falls back to per-phase direction. */
export function sunDirectionForRound(round, cycleConfig = null) {
  if (cycleConfig) {
    // Custom cycle: fall back to the per-phase sun direction; sweeping across
    // arbitrary cycle shapes isn't well-defined.
    return getPhaseLightConfig(undefined).sun.dir;
  }
  const r = ((round - 1) % 8 + 8) % 8; // 0..7
  const dawn  = getPhaseLightConfig('dawn').sun.dir;
  const dusk  = getPhaseLightConfig('dusk').sun.dir;
  const day   = getPhaseLightConfig('day').sun.dir;
  // ── Daylight band (rounds 0..4 — dawn through dusk) ──────────────────────
  // Linear horizontal lerp east-to-west, sinusoidal arc on Y (low at endpoints,
  // peaking at noon) and on Z (so the noon sun has a meaningful tilt away from
  // vertical — straight-down sun produces zero-offset shadows). Noon Y peaks
  // at the day-phase config sun.dir.y; noon Z peaks at day.dir.z.
  if (r <= 4) {
    const t = r / 4; // 0 at dawn, 1 at dusk
    const x = dawn.x + (dusk.x - dawn.x) * t;
    const horizonY = (dawn.y + dusk.y) / 2;
    const y        = horizonY + (day.y - horizonY) * Math.sin(Math.PI * t);
    const horizonZ = (dawn.z + dusk.z) / 2;
    const z        = horizonZ + (day.z - horizonZ) * Math.sin(Math.PI * t);
    return { x, y, z };
  }
  // ── Night band (rounds 5..7 — moonlight arc) ─────────────────────────────
  // A subtle mirror of the daytime sweep: moon rises in the east at start of
  // night, peaks near (but never at) zenith, sets in the west by end of night.
  // Less steep than day so shadows stay raked; non-zero Z always so the light
  // is never straight down. Endpoints anchored at NIGHT_MOON_HORIZON_Y and
  // peak at the night-phase config's sun.dir.y.
  const night = getPhaseLightConfig('night').sun.dir;
  const t = (r - 5) / 2; // 0 at first night round, 1 at last
  const NIGHT_X_RANGE   = 0.85;
  const NIGHT_HORIZON_Y = -0.40;
  const NIGHT_PEAK_Z    = 0.40;
  const x = -NIGHT_X_RANGE + 2 * NIGHT_X_RANGE * t;
  const y = NIGHT_HORIZON_Y + (night.y - NIGHT_HORIZON_Y) * Math.sin(Math.PI * t);
  // Z sweep — lower at moonrise/set (more horizontal), higher at peak so the
  // angle stays clearly off-vertical throughout night.
  const horizonZ = night.z;
  const z = horizonZ + (NIGHT_PEAK_Z - horizonZ) * Math.sin(Math.PI * t);
  return { x, y, z };
}

/** Sun intensity for a phase. Drives both light strength and shadow darkness
 *  contribution. NIGHT is ~0 so the directional light effectively cuts out
 *  and lanterns/hemi carry the look. */
export function sunIntensityForPhase(phase) {
  return getPhaseLightConfig(phase).sun.intensity;
}

/** Shadow generator config — tuned for legibility without crushing iOS GPUs.
 *  2048 + PCF MEDIUM gives crisp standee shadows on the laptop; if iOS perf
 *  is a problem the operator can drop this to 1024. */
export const SUN_SHADOW_MAP_SIZE = 2048;
/** PCF (percentage-closer filtering) softens the shadow edge so the
 *  silhouettes don't look pixel-stepped on the terrain. */
export const SUN_SHADOW_USE_PCF = true;
/** Babylon shadow-filter quality enum value — 1 = MEDIUM (matches
 *  BABYLON.ShadowGenerator.QUALITY_MEDIUM; pinned here so tests don't have to
 *  import Babylon). */
export const SUN_SHADOW_FILTERING_QUALITY = 1;
/** Slight depth bias to suppress shadow acne on the near-coplanar tile
 *  prism / disc surfaces. */
export const SUN_SHADOW_BIAS = 0.005;
/** 0 = pitch-black shadow, 1 = no shadow. 0.4 gives a strong but not
 *  oppressive shadow — terrain underneath still reads. */
export const SUN_SHADOW_DARKNESS = 0;

/** Easing duration for the directional-sun direction change when state.round
 *  advances. Keeps the sun gliding visibly across the sky as turns resolve
 *  rather than snapping to the new angle. Held to the same general envelope
 *  as PHASE_TRANSITION_MS so the hemi/clear lerp and the sun lerp feel like
 *  one combined "time passes" motion. */
export const SUN_ROUND_TRANSITION_MS = 2500;

/** Look up a phase's lighting config. Falls back to DAY if the phase is
 *  unrecognised (defensive — keeps the renderer usable on weird save loads). */
export function getPhaseLightConfig(phase) {
  return PHASE_LIGHT_CONFIG[phase] ?? PHASE_LIGHT_CONFIG.day;
}

/** Multiplier on `cfg.color` used to derive `HemisphericLight.groundColor` in
 *  `_applyLightConfig`. The hemi light's groundColor defaults to (0,0,0),
 *  which leaves any face whose normal points away from the light rendering
 *  as a pure black silhouette — most painfully visible on the road/river
 *  ribbons before this PR's normal flip, and still useful afterwards for
 *  low-tilt camera angles that show the ribbon underside. Capped well below
 *  1 so the lit/unlit hemispheric contrast that gives the terrain its 3D
 *  feel doesn't get washed out. */
export const HEMI_GROUND_SCALE = 0.30;

/** Power Node glow palette by controller. Playtest feedback: previous values
 *  read as washed out in the lit 3D scene, so each is bumped toward full
 *  saturation. Hero = vivid gold, witch = vivid sickly green, neutral = pale
 *  white, contested = vivid orange (matches the 2D path's contested overlay
 *  family but pushed harder so the disc reads from across the map). */
export const NODE_GLOW_COLORS = Object.freeze({
  hero:      '#ffb800',
  witch:     '#3ee013',
  neutral:   '#e8e8e8',
  contested: '#ff6a00',
});

/** Choose a node's glow colour by current controller. */
export function getNodeGlowColor(controller) {
  return NODE_GLOW_COLORS[controller] ?? NODE_GLOW_COLORS.neutral;
}

/** Duration of phase-to-phase light cross-fade. */
export const PHASE_TRANSITION_MS = 3000;

/** Selection halo pulse. Configurable so designers can tune the breathing.
 *  Round 3: dialled MIN/MAX down ~50% — earlier values produced a halo bright
 *  enough to swallow the standee silhouette at zoomed-out distances. */
export const SELECTION_PULSE_PERIOD_MS = 1500;
export const SELECTION_PULSE_MIN       = 0.06;
export const SELECTION_PULSE_MAX       = 0.18;
/** Base cyan emissive that the selection pulse modulates each frame. */
export const SELECTION_EMISSIVE_BASE = Object.freeze({ r: 0.25, g: 0.85, b: 0.95 });

/** Power-node glow pulse — slower than the selection, so the two reads as
 *  distinct visual languages. */
export const NODE_PULSE_PERIOD_MS = 3000;
export const NODE_PULSE_MIN       = 0.45;
export const NODE_PULSE_MAX       = 0.95;
/** Multiplier applied to the per-frame node-disc emissive (`glowColor * pulseK
 *  * NODE_DISC_EMISSIVE_MUL`). Held at 0.4 so the controller colour stays
 *  tinted without saturating: at 1.0 the brightest channels of hero
 *  (#ffb800 → 1.0), neutral (#e8e8e8 → 0.91), and contested (#ff6a00 → 1.0)
 *  clipped through the emissive and washed every node to white. 0.4 keeps the
 *  peak channel ≤ ~0.38 (after pulse k ≤ 0.95) so the tint reads. */
export const NODE_DISC_EMISSIVE_MUL = 0.4;
/** Disc footprint in world units. Slightly larger than the historical 1.7 so
 *  the saturated colour fills more of the tile's visible top. */
export const NODE_DISC_DIAMETER = 1.9;
/** Disc material alpha — high enough to read as solid colour, low enough that
 *  the underlying tile colour still bleeds through faintly. */
export const NODE_DISC_ALPHA = 0.88;

/** Multiplier applied to fogged-tile diffuse colour. Round 4: bumped
 *  0.32 → 0.55 after playtest feedback that fogged tiles read as nearly black
 *  on the 3D path — terrain identity was barely legible. 0.55 keeps tiles
 *  visibly dimmed (~half brightness) while preserving "there's grass / dirt
 *  / forest there" reads. Props + standees still hide via `_applyFogVeil`. */
// Multiplier applied to fogged tile materials' diffuseColor (which scales both
// hemi and sun contributions). 0.20 reads as clearly "this tile is fogged"
// against a daytime backdrop where the sun is cranked to intensity 2.0 — at
// 0.55 the bright sun would still flood-light the surface and the fog would
// look like a mild tint rather than a tactical signal.
export const FOG_TILE_DARKEN = 0.20;

/** Cubic ease-in-out — interpolates 0→1 smoothly with no jolt at endpoints. */
export function easeInOutCubic(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u < 0.5
    ? 4 * u * u * u
    : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/** Lerp two light-config snapshots: intensity (scalar) + diffuse + clear
 *  (each {r,g,b}) + sun (directional-light direction + intensity, when both
 *  sides carry one). Exported so phase-transition math can be unit-tested
 *  without a Babylon scene. */
export function lerpLightConfig(from, to, t) {
  const tt = Math.min(1, Math.max(0, t));
  const lerp = (a, b) => a + (b - a) * tt;
  const out = {
    intensity: lerp(from.intensity, to.intensity),
    color: {
      r: lerp(from.color.r, to.color.r),
      g: lerp(from.color.g, to.color.g),
      b: lerp(from.color.b, to.color.b),
    },
    clear: {
      r: lerp(from.clear.r, to.clear.r),
      g: lerp(from.clear.g, to.clear.g),
      b: lerp(from.clear.b, to.clear.b),
    },
  };
  if (from.sun && to.sun) {
    out.sun = {
      dir: {
        x: lerp(from.sun.dir.x, to.sun.dir.x),
        y: lerp(from.sun.dir.y, to.sun.dir.y),
        z: lerp(from.sun.dir.z, to.sun.dir.z),
      },
      intensity: lerp(from.sun.intensity, to.sun.intensity),
    };
  }
  if (from.ambient && to.ambient) {
    out.ambient = {
      r: lerp(from.ambient.r, to.ambient.r),
      g: lerp(from.ambient.g, to.ambient.g),
      b: lerp(from.ambient.b, to.ambient.b),
    };
  }
  return out;
}

/** Sine-driven pulse mapping `nowMs` into the [min, max] range over `periodMs`. */
export function pulseFactor(nowMs, periodMs, min, max) {
  const phase = (2 * Math.PI * (nowMs % periodMs)) / periodMs;
  const sin01 = (Math.sin(phase) + 1) / 2; // 0..1
  return min + (max - min) * sin01;
}

/**
 * Pure-functional fog-of-war visibility set. Returns the union of all hex
 * keys within sight range of every alive entity owned by `observerOwner`.
 *
 * Iterates `state.entities` and `state.tiles` (cheap — even a Campaign-size
 * map is ~300 tiles); does NOT include attacker-reveal hints (those live in
 * the animation layer and are layered on top by the 3D renderer separately).
 * Always returns a Set, never null — caller decides whether to apply it via
 * the fogOfWar state field gate.
 */
export function buildFogVisibleSet(state, observerOwner) {
  const visible = new Set();
  if (!state?.entities || !state?.tiles || !observerOwner) return visible;
  for (const e of state.entities) {
    if (!e || !e.alive || e.owner !== observerOwner) continue;
    const range = sightRangeForEntity(e, state.phase);
    for (const tile of state.tiles.values()) {
      if (hexDistance(tile.col, tile.row, e.col, e.row) <= range) {
        visible.add(hexKey(tile.col, tile.row));
      }
    }
  }
  return visible;
}

/**
 * Pure visibility predicate for entity-attached props (HP bars, halos) given
 * a fog-visible-set and the entity's hex key. Wrapped as a helper so the
 * HP-bar-follows-fog rule can be unit-tested without instantiating Babylon.
 * `target` may be null (no fog active) — in which case everything is visible.
 */
export function shouldRenderEntityAt(target, hexK) {
  if (!target) return true;
  return target.has(hexK);
}

/**
 * Pure-functional diff of an existing standee map against a list of live
 * entities. Returns the {add, keep, remove} bucket sets so callers can drive
 * the actual mesh creation/disposal separately. Living + on-map = candidate;
 * everything else is filtered out before bucketing.
 */
export function diffStandees(existingIds, entities) {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const liveIds  = new Set();
  for (const e of entities || []) {
    if (!e || e.alive === false) continue;
    if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
    liveIds.add(e.id);
  }
  const add = new Set(), keep = new Set(), remove = new Set();
  for (const id of liveIds) {
    (existing.has(id) ? keep : add).add(id);
  }
  for (const id of existing) {
    if (!liveIds.has(id)) remove.add(id);
  }
  return { add, keep, remove };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 pure helpers — exported for tests (no Babylon, no DOM)
// ═══════════════════════════════════════════════════════════════════════════

/** Duration (ms) of a single-hex slide. 1000ms gives a deliberate,
 *  readable per-step pacing in 3D mode that lets the walking animation
 *  cycle land cleanly between hexes. FRAMES_MOVE in addMoveAnim derives
 *  from this constant so the cone slide and the cycle's speed-match
 *  stay in lockstep. */
export const MOVE_ANIM_MS = 1000;

/** Duration (ms) of an attack-lunge slide to the midpoint. Scaled
 *  alongside MOVE_ANIM_MS to keep the lunge feeling snappy relative
 *  to a normal move (~80% of one). */
export const LUNGE_ANIM_MS = 800;

/** Per-speed-mode multipliers applied to MOVE_ANIM_MS and friends.
 *  setPlaybackSpeed('cinematic'|'fast'|'vfast') reads from here. Fast
 *  modes compress the cone-slide AND scale walkGroup.speedRatio in
 *  step so the foot-plant math stays correct regardless of mode. */
export const PLAYBACK_SPEED_MULS = Object.freeze({
  cinematic: 1.0,
  fast:      0.55,
  vfast:     0.30,
});

/** Duration (ms) of a projectile arc. ~320ms — matches the 2D path's
 *  default `addProjectileAnim` duration. */
export const PROJECTILE_ANIM_MS = 320;

/** Default lifetime (ms) of a floating combat text label. ~700ms — long
 *  enough to read "CRUSH 3", short enough not to back up the queue. */
export const FLOAT_TEXT_MS = 700;

/** Floating combat-text plane — world-space dimensions of the billboarded
 *  plane that carries the "HIT 2" / "CRUSH 3" / "-2" labels. Roughly 2× the
 *  legacy 1.6×0.6 so the text reads at any zoom; matches the operator brief
 *  to make floaters prominent rather than incidental. */
export const FLOAT_TEXT_PLANE_WIDTH  = 3.2;
export const FLOAT_TEXT_PLANE_HEIGHT = 1.2;
/** DynamicTexture pixel size for the floater. Bumped to 512×192 (2× each
 *  axis) so the larger plane stays crisp without visible upscaling, and
 *  there's room for the outlined text + background pill. */
export const FLOAT_TEXT_TEX_WIDTH  = 512;
export const FLOAT_TEXT_TEX_HEIGHT = 192;

/** HP-bar height (world units) above the standee's base disc. */
export const HP_BAR_Y_ABOVE_BASE = 0.2;

/** Floating unit-icon billboard — circular sticker (portrait + HP ring) that
 *  sits above the cone+sphere head. Plane size is square; the icon disc and
 *  ring are painted inside it with transparent corners.
 *
 *  Sized so the ring around the icon reads cleanly at typical zoom — 2×
 *  the original 0.55 so the portrait + HP ring is legible even when the
 *  camera is fully zoomed out. The badge intentionally now dominates the
 *  silhouette of the token below it; that's the desired readout. */
export const UNIT_ICON_PLANE_SIZE = 0.88;
/** Proximity-aware icon scaling. The badge sits at scale=1 (full size) for
 *  radius ≥ UNIT_ICON_SCALE_FAR; shrinks linearly to UNIT_ICON_MIN_SCALE
 *  by radius = UNIT_ICON_SCALE_NEAR. At max zoom-in the badge reads as
 *  about the size of the paladin's head — close enough to feel attached
 *  to the model rather than a giant floating sticker. */
export const UNIT_ICON_SCALE_FAR  = 25;   // radius at which icon is full-size
export const UNIT_ICON_SCALE_NEAR = 8;    // radius at which icon is min-size
export const UNIT_ICON_MIN_SCALE  = 0.33; // ≈ 1/3, matches head-on-mesh

export function unitIconScaleForRadius(radius) {
  const r = Number.isFinite(radius) ? radius : UNIT_ICON_SCALE_FAR;
  if (r >= UNIT_ICON_SCALE_FAR)  return 1;
  if (r <= UNIT_ICON_SCALE_NEAR) return UNIT_ICON_MIN_SCALE;
  const t = (r - UNIT_ICON_SCALE_NEAR) / (UNIT_ICON_SCALE_FAR - UNIT_ICON_SCALE_NEAR);
  return UNIT_ICON_MIN_SCALE + (1 - UNIT_ICON_MIN_SCALE) * t;
}

/** Clearance between the head (sphere top) and the bottom of the icon
 *  plane. Keeps the icon from ever touching the model regardless of
 *  scale. */
export const UNIT_ICON_HEAD_CLEARANCE = 0.05;

/** Y position of the icon billboard, in cone-relative space, adjusted so
 *  the BOTTOM of the scaled icon plane is exactly UNIT_ICON_HEAD_CLEARANCE
 *  above the head (sphere top). As the icon shrinks toward
 *  UNIT_ICON_MIN_SCALE the centre drops closer to the head; at scale=1 it
 *  matches the legacy `iconBillboardYRelativeToCone` value (UNIT_ICON_Y_GAP
 *  was tuned to give scale=1 the same clearance + half-size offset). */
export function iconBillboardYForScale(leader = false, scale = 1) {
  const hMul = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
  const wMul = leader ? STANDEE_LEADER_WIDTH_MUL  : 1;
  // Head top, expressed cone-relative (cone center at origin):
  //   coneHeight/2 (top of cone) + sphereDiameter (top of sphere)
  const headTopRel = (STANDEE_CONE_HEIGHT * hMul) / 2 + STANDEE_SPHERE_DIAMETER * wMul;
  return headTopRel + UNIT_ICON_HEAD_CLEARANCE + (UNIT_ICON_PLANE_SIZE * scale) / 2;
}
/** Gap above the cone+sphere stack to the icon plane CENTRE, in world
 *  units. With the paladin model now ~0.92 wu tall (15% taller than the
 *  cone+sphere stack it replaced), the icon needs to sit just above the
 *  model's head — close enough to feel anchored to it without occluding.
 *  Tuned so the plane bottom edge clears the model top by a small margin. */
export const UNIT_ICON_Y_GAP      = 0.70;
/** DynamicTexture pixel size for the icon+ring composite. 192² keeps the
 *  portrait crisp at any zoom and the arc rim smooth without burning extra
 *  GPU memory per entity. */
export const UNIT_ICON_TEX_SIZE   = 192;
/** Arc rim thickness as a fraction of the texture half-size — thin enough
 *  to read as a clean line at the icon edge without crowding the portrait.
 *  Halved from the old 0.14 per operator request for a thinner HP border. */
export const UNIT_ICON_RING_THICKNESS_FRAC = 0.07;
/** Plane material alpha — fully opaque. Transparency was tried at 0.8 but
 *  reads as washed-out on the bright icon textures. */
export const UNIT_ICON_PLANE_ALPHA = 1.0;

/** Plan-marker puck alpha. (The legacy flat `PLAN_DISC_Y` disc elevation was
 *  retired in PR 5 — it was dead since the round-4 markers switched to the
 *  smaller PLAN_MARKER_* puck geometry at PLAN_WAYPOINT_Y. This alpha is still
 *  applied to that puck's material.) */
export const PLAN_DISC_ALPHA = 0.85;

/** Round 4 waypoint marker — small ground puck under the numbered badge so
 *  the underlying terrain stays visible. Diameter shrunk from 1.4 (a full
 *  hex's worth) → 0.36, height 0.02 (almost flush with the tile top). */
export const PLAN_MARKER_DIAMETER = 0.36;
export const PLAN_MARKER_HEIGHT   = 0.02;

/** Waypoint puck elevation. Promoted into the unified `plan-arrow` overlay
 *  layer (≥0.180) — see Y_TABLE in src/overlays.js. The legacy PLAN_MARKER_Y
 *  was 0.08, which sat *below* UNIT_HEX_OUTLINE_Y (0.10), so a waypoint dropped
 *  on a unit's hex hid under that unit's selection ring. Lifting it into the
 *  plan-arrow band fixes the long-standing collision and keeps the marker on
 *  top of the highlight discs (0.160–0.175) the same way the dashed line is. */
export const PLAN_WAYPOINT_Y      = yForLayer('plan-arrow', 0);

/** Dashed-line Y for the path-connector tracing the planned waypoints. Lives
 *  at the floor of the unified `plan-arrow` overlay layer (= PLAN_WAYPOINT_Y),
 *  so it shares the waypoint puck's elevation — above the highlight-disc layer
 *  (0.160–0.175) so the tube segments clear ground geometry without z-fight,
 *  and well below the floating badge (0.6) so it still reads as ground-
 *  anchored. See Y_TABLE in src/overlays.js. */
export const PLAN_LINE_Y = yForLayer('plan-arrow', 0);

/** Tube radius for each dash segment. Tuned for "visibly chunky" without
 *  overpowering the waypoint puck (0.36 diameter) — ~33% of the marker's
 *  half-width. Native WebGL `LinesMesh` width is driver-capped at ~1px, so
 *  we render dashes as 3D tubes to get reliable thickness across devices. */
export const PLAN_LINE_RADIUS = 0.06;

/** Dash + gap length in world units. One hex-step is ~sqrt(3) ≈ 1.73 wu,
 *  so a 0.28 dash + 0.16 gap yields ~4 chunky dashes per hop. */
export const PLAN_LINE_DASH_SIZE = 0.28;
export const PLAN_LINE_GAP_SIZE  = 0.16;

/** Attack-arrow overlay (BATTLE_UNIT / BATTLE_HEX plan steps).
 *  Mirrors the 2D renderer's "red dashed arrow + ×N badge" idiom in
 *  `_drawPlanOverlay` (Layer 4) — see `src/renderer.js`. */

/** Y for the attack arrow tubes. Nests near the top of the `plan-arrow`
 *  overlay layer (yForLayer('plan-arrow', 3) = 0.195) so battle arrows clearly
 *  overlay the move plan lines at the layer floor (PLAN_LINE_Y = 0.180)
 *  without z-fighting, while staying well below the floating ×N badge.
 *  See Y_TABLE in src/overlays.js. */
export const ATTACK_ARROW_Y = yForLayer('plan-arrow', 3);

/** Tube radius for the attack-arrow shaft. Slightly thicker than the
 *  move plan dashes (0.06) so the attack reads as a heavier, more
 *  aggressive overlay against the dashed-line move plan. */
export const ATTACK_ARROW_RADIUS = 0.07;

/** Trim from the attacker hex centre — keeps the shaft from spawning
 *  inside the attacker's standee. Matches the 2D path's `hs * 0.38`. */
export const ATTACK_ARROW_TRIM_FROM = 0.42;

/** Trim from the target hex centre — keeps the tip just outside the
 *  target standee, matching the 2D path's `hs * 0.45`. */
export const ATTACK_ARROW_TRIM_TO = 0.50;

/** Arrow head length (world units). Two short tubes splay back from
 *  the tip — same wedge shape as the 2D arrow heads. */
export const ATTACK_ARROW_HEAD_LEN = 0.32;
/** Half-angle of the arrow head wedge, in radians. Matches the 2D
 *  path's `0.4` rad spread. */
export const ATTACK_ARROW_HEAD_ANGLE = 0.4;

/** Red diffuse for the attack arrow. Matches the 2D path's
 *  `rgba(220,60,60,…)`. */
export const ATTACK_ARROW_COLOR = '#dc3c3c';

/** Floating ×N badge above the target hex. Sits above the move-badge
 *  layer (0.6), the unit body, and the floating unit-icon billboard.
 *  With the larger UNIT_ICON_Y_GAP (0.85) needed to clear the paladin GLB
 *  model, the leader icon's top edge sits at iconBillboardY(true) + 0.55
 *  ≈ 1.979 + 0.55 ≈ 2.53, so this constant was raised to 2.8 to stay
 *  above the entire unit token stack. */
export const ATTACK_BADGE_Y = 2.8;

/** Pixel size of the badge billboard plane (world units). Slightly
 *  larger than the move badge (0.45) so the ×N glyph reads cleanly. */
export const ATTACK_BADGE_SIZE = 0.55;

/** Babylon `renderingGroupId` for planning-mode attack overlays (arrow
 *  tubes + ×N target badges). Strictly above all world geometry (group 0
 *  — terrain, ribbons, buildings, standees, hex outlines, plan ghosts) and
 *  the floating unit-icon billboard (group 2, owned by the icon fix in
 *  task t-40ab45b0) so the planning UI always draws on top — rendering
 *  groups bypass the depth buffer, which is what we need at the locked
 *  45° tilt where a unit cone can otherwise occlude an arrow shaft or
 *  badge that lives at the same screen pixel.
 *
 *  Default Babylon `MaxRenderingGroupId` is 4 (valid range 0..3), so
 *  3 is the highest legal group without configuring the scene. */
export const ATTACK_OVERLAY_GROUP = 3;

/**
 * Tally attacks per target hex from a `planGhostSteps` array. Returns
 * Map<"col,row", number>. Mirrors the 2D path's `attackCounts` map in
 * `_drawPlanOverlay`. Pure — safe to unit-test without Babylon.
 */
export function countAttacksPerTarget(steps) {
  const counts = new Map();
  if (!Array.isArray(steps)) return counts;
  for (const s of steps) {
    if (!s?.attackArrow) continue;
    const { toCol, toRow } = s.attackArrow;
    const key = `${toCol},${toRow}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Badge label for `count` attacks on a target hex. Matches the 2D
 * path: a single attack uses the ⚔ glyph; ≥2 collapse into `×N`.
 */
export function attackBadgeLabel(count) {
  return count > 1 ? `×${count}` : '⚔';
}

/**
 * Compute the world-space geometry of a single attack arrow.
 * Returns `{ shaftStart, shaftEnd, headLeft, headRight }` (each a
 * `{x,y,z}`), or `null` if the source and target hexes coincide.
 *
 * The shaft is trimmed back from both hex centres so it does not draw
 * inside the standees, and the head is a wedge whose two strokes
 * spring from the shaft tip — mirrors the 2D path's two-line arrow
 * head in `_drawPlanOverlay`.
 */
export function computeAttackArrowGeometry(fromCol, fromRow, toCol, toRow, y = ATTACK_ARROW_Y) {
  const a = hexToWorld(fromCol, fromRow);
  const b = hexToWorld(toCol,   toRow);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uz = dz / len;
  const shaftStart = {
    x: a.x + ux * ATTACK_ARROW_TRIM_FROM,
    y,
    z: a.z + uz * ATTACK_ARROW_TRIM_FROM,
  };
  const shaftEnd = {
    x: b.x - ux * ATTACK_ARROW_TRIM_TO,
    y,
    z: b.z - uz * ATTACK_ARROW_TRIM_TO,
  };
  const ang = Math.atan2(uz, ux);
  const leftAng  = ang - Math.PI + ATTACK_ARROW_HEAD_ANGLE;
  const rightAng = ang - Math.PI - ATTACK_ARROW_HEAD_ANGLE;
  const headLeft = {
    x: shaftEnd.x + Math.cos(leftAng)  * ATTACK_ARROW_HEAD_LEN,
    y,
    z: shaftEnd.z + Math.sin(leftAng)  * ATTACK_ARROW_HEAD_LEN,
  };
  const headRight = {
    x: shaftEnd.x + Math.cos(rightAng) * ATTACK_ARROW_HEAD_LEN,
    y,
    z: shaftEnd.z + Math.sin(rightAng) * ATTACK_ARROW_HEAD_LEN,
  };
  return { shaftStart, shaftEnd, headLeft, headRight };
}

/**
 * World position for the ×N attack badge — directly above the target
 * hex centre. Mirrors the 2D path's "badge near target" placement,
 * with the 3D camera looking down meaning we float above rather than
 * offsetting to the upper-right.
 */
export function attackBadgePosition(toCol, toRow, y = ATTACK_BADGE_Y) {
  const { x, z } = hexToWorld(toCol, toRow);
  return { x, y, z };
}

/** Plan ghost — translucent standee clone walking the planned path. */
export const PLAN_GHOST_ALPHA          = 0.4;
/** Duration (ms) of a single step of the walking ghost. Mirrors
 *  MOVE_ANIM_MS so the ghost's per-hex slide matches the live paladin's
 *  resolution pace and the walking-animation foot-plant math stays
 *  identical between the two paths. */
export const PLAN_GHOST_STEP_MS        = MOVE_ANIM_MS;
/** Duration (ms) of the post-arrival fade before the ghost teleports back to
 *  the path's origin and starts the next cycle. */
export const PLAN_GHOST_FADE_MS        = 280;

/**
 * Group MOVE arrows from a `planGhostSteps` array into per-entity paths.
 * Returns Map<entityId, [{col,row}, ...]> where each path starts at the move's
 * origin and lists every subsequent destination in plan order. Entities with
 * no MOVE actions don't appear in the map.
 */
export function computePlanGhostPaths(steps) {
  const paths = new Map();
  if (!Array.isArray(steps)) return paths;
  for (const s of steps) {
    if (!s?.arrow) continue;
    const { entityId, fromCol, fromRow, toCol, toRow } = s.arrow;
    let arr = paths.get(entityId);
    if (!arr) {
      arr = [{ col: fromCol, row: fromRow }];
      paths.set(entityId, arr);
    }
    arr.push({ col: toCol, row: toRow });
  }
  return paths;
}

/**
 * Slice a straight 2D segment (XZ plane, fixed Y) into dash-and-gap tube
 * pieces. Returns an array of `{ start: {x,y,z}, end: {x,y,z} }` ready to
 * feed to `MeshBuilder.CreateTube({ path: [start, end], radius })`. Used
 * by the plan-arrow path connector to render thick, z-fight-free dashes
 * (native `LinesMesh` width is driver-capped at ~1px).
 *
 * The dash pattern always *starts with a dash* at `p1` and ends either on
 * a full dash (if the segment length aligns) or truncates the trailing
 * dash if a stub > 25% of `dashSize` remains. Short stubs are dropped to
 * avoid visually awkward fragments.
 */
export function computeDashSegments(p1, p2, dashSize, gapSize, y = 0) {
  const segs = [];
  if (!p1 || !p2 || !(dashSize > 0)) return segs;
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const total = Math.hypot(dx, dz);
  if (total === 0) return segs;
  const gap = Math.max(0, gapSize);
  const period = dashSize + gap;
  const ux = dx / total;
  const uz = dz / total;
  const minStub = dashSize * 0.25;
  let offset = 0;
  while (offset < total) {
    const startT = offset;
    const endT = Math.min(offset + dashSize, total);
    if (endT - startT < minStub) break;
    segs.push({
      start: { x: p1.x + ux * startT, y, z: p1.z + uz * startT },
      end:   { x: p1.x + ux * endT,   y, z: p1.z + uz * endT },
    });
    offset += period;
  }
  return segs;
}

/**
 * Lifecycle pose of a plan-ghost at clock `nowMs` for a path of `pathLen`
 * vertices (origin + N destinations). Returns the segment index, the
 * within-segment progress `segT ∈ [0,1]`, and the alpha modulation.
 *
 * Cycle layout (per ghost, looping):
 *   • Walk: pathLen - 1 segments of PLAN_GHOST_STEP_MS each.
 *   • Fade: PLAN_GHOST_FADE_MS of fading-then-snap-back.
 *
 * When pathLen ≤ 1 (no destinations), returns segment 0 / segT 0 / alpha 1 —
 * a still ghost at the origin, which the caller renders harmlessly.
 */
export function planGhostPose(nowMs, pathLen) {
  if (!Number.isFinite(pathLen) || pathLen <= 1) {
    return { segment: 0, segT: 0, alpha: 1 };
  }
  const segCount = pathLen - 1;
  const cycle = segCount * PLAN_GHOST_STEP_MS + PLAN_GHOST_FADE_MS;
  const tInCycle = ((nowMs % cycle) + cycle) % cycle;
  if (tInCycle < segCount * PLAN_GHOST_STEP_MS) {
    const segment = Math.floor(tInCycle / PLAN_GHOST_STEP_MS);
    const segT = (tInCycle - segment * PLAN_GHOST_STEP_MS) / PLAN_GHOST_STEP_MS;
    return { segment, segT, alpha: 1 };
  }
  // Fade phase: hold at last destination, alpha lerps 1 → 0.
  const fadeT = (tInCycle - segCount * PLAN_GHOST_STEP_MS) / PLAN_GHOST_FADE_MS;
  return {
    segment: segCount - 1,
    segT: 1,
    alpha: Math.max(0, 1 - fadeT),
  };
}

/** HP-bar ratio thresholds — kept as constants so the test can assert them
 *  without re-deriving from the rendering function. */
export const HP_RED_BELOW    = 0.33;
export const HP_YELLOW_BELOW = 0.66;

/**
 * Linear interpolation between two hex world positions. At t=0 returns the
 * source, at t=1 the destination, and at t=0.5 the midpoint. Used by the
 * standee move/lunge animations and unit-tested independently of Babylon.
 */
export function interpolatePosition(from, to, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    x: from.x + (to.x - from.x) * clamped,
    z: from.z + (to.z - from.z) * clamped,
  };
}

/**
 * Polyline points for a single ghost-arrow segment, raised slightly above
 * the tile prism so the dashed line reads against the terrain. The arrow is
 * a straight line for now (no curved/arced ghost arrows) — matches the 2D
 * path's straight-line idiom. `height` is the world-Y the arrow floats at.
 */
export function planArrowPolyline(fromCol, fromRow, toCol, toRow, height = 0.85) {
  const a = hexToWorld(fromCol, fromRow);
  const b = hexToWorld(toCol,   toRow);
  return [
    { x: a.x, y: height, z: a.z },
    { x: b.x, y: height, z: b.z },
  ];
}

/**
 * World-space position of the numbered badge for a plan step — sits at the
 * arrow's terminating hex centre, slightly above the tile prism. Exposed
 * separately from `planArrowPolyline` so callers can place the badge label
 * without re-running the line-build math.
 */
export function planArrowBadgePosition(toCol, toRow, height = 1.0) {
  const { x, z } = hexToWorld(toCol, toRow);
  return { x, y: height, z };
}

/**
 * Rotation (radians, around world Y) for a bridge plank so its long axis
 * follows the road that crosses the river through this hex. Mirrors the 2D
 * renderer's `_drawRoadLayer` bridge-crossing-pair selection (see
 * `src/renderer.js` ≈L1951-1992): the bridge's road axis is the line between
 * the two *road exits* whose directions are most perpendicular to the
 * river-neighbour direction. The plank's long axis (+X) is aligned with that
 * road axis, so it visually sits along the road and across the water.
 *
 *   • If the tile has ≥2 road exits (`tile.roadDirs`):
 *     – With ≥1 water neighbour: pick the road-exit pair maximising the
 *       sum of |cross-product| with the averaged water direction
 *       (i.e. the pair most perpendicular to the river).
 *     – With 0 water neighbours: pick the most-opposing pair
 *       (lowest dot product) as a fallback.
 *     The axis is the unit-direction difference between the chosen exits,
 *     and `rotation.y = atan2(axisZ, axisX)` aligns the plank's +X to it.
 *   • If the tile lacks road metadata (e.g. tests/headless without map gen)
 *     fall back to the previous water-axis behaviour: orient the plank
 *     perpendicular to the river direction (+π/2 offset).
 *   • Returns 0 when no usable orientation cue exists.
 *
 * The plank's default geometry is `{ width: 1.7, depth: 0.7 }` — wide along
 * +X, narrow along +Z. Babylon's left-handed Y-up rotation.y takes
 * X → (cos θ, 0, sin θ).
 *
 * `tilesByKey` is a Map<hexKey, Tile> — typically the state's `tiles` map.
 * Exposed as a pure function so tests can lock down the math without Babylon.
 */
export function bridgeRotationY(tile, tilesByKey) {
  if (!tile || !tilesByKey) return 0;
  const here = hexToWorld(tile.col, tile.row);

  // ── Road exits (mirrors 2D: tile.roadDirs is the source of truth) ──
  const roadDirs = [];
  if (tile.roadDirs && typeof tile.roadDirs[Symbol.iterator] === 'function') {
    for (const k of tile.roadDirs) {
      const nt = tilesByKey.get(k);
      if (!nt) continue;
      const there = hexToWorld(nt.col, nt.row);
      const dx = there.x - here.x, dz = there.z - here.z;
      const d  = Math.hypot(dx, dz) || 1;
      roadDirs.push({ dx: dx / d, dz: dz / d });
    }
  }

  // ── Water neighbours (RIVER + BRIDGE — rivers continue through bridges) ──
  const waterDirs = [];
  for (const n of getNeighbors(tile.col, tile.row)) {
    const nt = tilesByKey.get(hexKey(n.col, n.row));
    if (!nt) continue;
    if (!isRiver(nt) && !isBridge(nt)) continue;
    const there = hexToWorld(n.col, n.row);
    waterDirs.push({ dx: there.x - here.x, dz: there.z - here.z });
  }

  // ── Primary: 2D-style road-pair selection ──
  if (roadDirs.length >= 2) {
    let primaryA = 0, primaryB = 1;
    if (waterDirs.length >= 1) {
      // Averaged water direction (matches 2D bWaterNbrs sum/normalise).
      let wdx = 0, wdz = 0;
      for (const w of waterDirs) { wdx += w.dx; wdz += w.dz; }
      const wl = Math.hypot(wdx, wdz) || 1;
      wdx /= wl; wdz /= wl;
      // Maximise summed |cross product| with water direction = most perpendicular pair.
      let best = -Infinity;
      for (let i = 0; i < roadDirs.length; i++) {
        for (let j = i + 1; j < roadDirs.length; j++) {
          const s = Math.abs(roadDirs[i].dx * wdz - roadDirs[i].dz * wdx)
                  + Math.abs(roadDirs[j].dx * wdz - roadDirs[j].dz * wdx);
          if (s > best) { best = s; primaryA = i; primaryB = j; }
        }
      }
    } else {
      // No water — most-opposing road exits (matches 2D fallback).
      let minDot = Infinity;
      for (let i = 0; i < roadDirs.length; i++) {
        for (let j = i + 1; j < roadDirs.length; j++) {
          const dot = roadDirs[i].dx * roadDirs[j].dx + roadDirs[i].dz * roadDirs[j].dz;
          if (dot < minDot) { minDot = dot; primaryA = i; primaryB = j; }
        }
      }
    }
    // Plank long axis = difference between the two unit road directions
    // (same as 2D `edgeMids[primaryB] − edgeMids[primaryA]` up to scale).
    const axisX = roadDirs[primaryB].dx - roadDirs[primaryA].dx;
    const axisZ = roadDirs[primaryB].dz - roadDirs[primaryA].dz;
    if (Math.hypot(axisX, axisZ) > 1e-9) {
      return Math.atan2(axisZ, axisX);
    }
    // (Degenerate: opposite road exits cancel — fall through to water heuristic.)
  }

  // ── Fallback: orient perpendicular to the river (original 3D behaviour) ──
  if (waterDirs.length === 0) return 0;
  let axisX, axisZ;
  if (waterDirs.length === 1) {
    axisX = waterDirs[0].dx;
    axisZ = waterDirs[0].dz;
  } else {
    let bestDot = Infinity;
    let bestPair = [waterDirs[0], waterDirs[1]];
    for (let i = 0; i < waterDirs.length; i++) {
      for (let j = i + 1; j < waterDirs.length; j++) {
        const a = waterDirs[i], b = waterDirs[j];
        const la = Math.hypot(a.dx, a.dz) || 1;
        const lb = Math.hypot(b.dx, b.dz) || 1;
        const dot = (a.dx * b.dx + a.dz * b.dz) / (la * lb);
        if (dot < bestDot) { bestDot = dot; bestPair = [a, b]; }
      }
    }
    axisX = bestPair[1].dx - bestPair[0].dx;
    axisZ = bestPair[1].dz - bestPair[0].dz;
  }
  return Math.atan2(axisZ, axisX) + Math.PI / 2;
}

/**
 * Choose the HP bar fill colour given current/max HP. Thresholds:
 *   • ratio <  HP_RED_BELOW       → red
 *   • ratio <  HP_YELLOW_BELOW    → yellow
 *   • ratio ≥  HP_YELLOW_BELOW    → green
 *
 * maxHp ≤ 0 is treated as 1 (avoid div-by-zero); negative hp clamps to 0.
 */
export function hpBarColor(hp, maxHp) {
  const safeMax = Math.max(1, maxHp);
  const ratio = Math.max(0, Math.min(1, hp / safeMax));
  if (ratio < HP_RED_BELOW)    return '#d83333';
  if (ratio < HP_YELLOW_BELOW) return '#d8c333';
  return '#46c84a';
}

/**
 * Fraction of the unit-icon HP ring that should read as "filled" (coloured)
 * given the entity's HP. Clamps to [0,1] so a freshly-spawned overheal or a
 * mid-death negative HP can't render an arc of length > 2π or < 0. maxHp ≤ 0
 * is treated as 1 (matching `hpBarColor`).
 */
export function hpRingFraction(hp, maxHp) {
  const safeMax = Math.max(1, maxHp);
  return Math.max(0, Math.min(1, hp / safeMax));
}

/**
 * Y placement (relative to the standee base disc) for the floating
 * unit-icon billboard. Sits above the cone+sphere head with a small gap,
 * scaled up for leaders to match their taller cone.
 *
 * Mirrors `_createUnitIconBadge`'s positioning so tests can lock the
 * geometry without spinning up Babylon.
 */
export function iconBillboardY(leader = false) {
  const hMul = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
  const wMul = leader ? STANDEE_LEADER_WIDTH_MUL  : 1;
  return (STANDEE_BASE_THICKNESS / 2)
    + (STANDEE_CONE_HEIGHT   * hMul)
    + (STANDEE_SPHERE_DIAMETER * wMul)
    + UNIT_ICON_Y_GAP;
}

/**
 * Y placement of the icon billboard expressed as a LOCAL offset from the
 * cone's centre (rather than the legacy base-disc origin). With the ground
 * disc retired, the billboard parents to the cone directly; this helper keeps
 * the world-Y identical by subtracting the cone-centre's offset above the
 * disc anchor. Pure — exported so tests can pin the offset stays in step
 * with `iconBillboardY`.
 */
/**
 * Pure helper: given the sets of entity ids that are currently mid-move /
 * mid-lunge by the resolver, plus the live entities array and a hero
 * predicate, return the target blend weight for the paladin animation
 * crossfade — 0 means "play walking", 1 means "play idle". The blend
 * tick eases toward this target each frame.
 *
 * We only flip to walking when a HERO entity is moving — a witch or
 * zombie sliding to a new hex shouldn't make every paladin in the scene
 * walk in place. Exported for tests so the predicate stays out of
 * Babylon's hot path.
 */
export function paladinAnimTargetWeight(activeMoveIds, activeLungeIds, entities, heroPredicate) {
  const moves = activeMoveIds instanceof Set ? activeMoveIds : null;
  const lunges = activeLungeIds instanceof Set ? activeLungeIds : null;
  if ((!moves || moves.size === 0) && (!lunges || lunges.size === 0)) return 1;
  if (!Array.isArray(entities) || typeof heroPredicate !== 'function') {
    // No entity list available — fall back to "anyone moving = walk".
    return 0;
  }
  for (const e of entities) {
    if (!e || !e.id) continue;
    if (!heroPredicate(e)) continue;
    if ((moves && moves.has(e.id)) || (lunges && lunges.has(e.id))) return 0;
  }
  return 1;
}

export function iconBillboardYRelativeToCone(leader = false) {
  const hMul = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
  // Cone centre sits at  (STANDEE_BASE_THICKNESS / 2) + (coneHeight / 2)
  // above the base-disc origin, so the local-relative Y is the world-relative
  // billboard Y minus that offset.
  const coneCenterAboveDisc =
    (STANDEE_BASE_THICKNESS / 2) + (STANDEE_CONE_HEIGHT * hMul) / 2;
  return iconBillboardY(leader) - coneCenterAboveDisc;
}

/**
 * Resolve the portrait image + source rect for a unit-icon badge from the
 * shared tilemap. Returns `{ img, rect, hasPortrait }` where `hasPortrait`
 * is true only when both pieces are available — the painter falls back
 * cleanly to a neutral disc when it's false.
 *
 * Pure: callers pass in `_tilemapImg` and `_spriteRects` explicitly so the
 * helper has no Babylon / DOM dependency, which lets the diff in
 * `_syncEntityIconBillboards` recheck portrait availability each tick
 * without retouching `tex.update()` when nothing changed.
 */
export function resolveUnitIconPortrait(tilemapImg, spriteRects, assetId) {
  if (!tilemapImg || !spriteRects || !assetId) {
    return { img: null, rect: null, hasPortrait: false };
  }
  const rect = spriteRects.get(assetId) ?? null;
  if (!rect) return { img: null, rect: null, hasPortrait: false };
  return { img: tilemapImg, rect, hasPortrait: true };
}

/**
 * Configure a Babylon material as a flat unit-icon UI sticker: lighting
 * disabled, fog disabled, alpha sourced from the diffuse texture, and
 * emissive cranked to full white so the badge reads at identical
 * brightness across every phase (dawn / day / dusk / night).
 *
 * Factored out so tests can verify the contract without spinning up
 * Babylon, and so `_createUnitIconBadge` can stay focused on geometry.
 */
export function applyFlatUnitIconMaterial(BABYLON, mat) {
  mat.useAlphaFromDiffuseTexture = true;
  mat.specularColor   = new BABYLON.Color3(0, 0, 0);
  mat.diffuseColor    = new BABYLON.Color3(1, 1, 1);
  mat.emissiveColor   = new BABYLON.Color3(1, 1, 1);
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.fogEnabled      = false;
  mat.alpha           = 1;
}

/**
 * Paint a floating combat-text label into a 2D canvas context: a
 * semi-opaque dark "pill" background fitted to the text, the text stroked
 * with a thick black outline for legibility against any tile colour, then
 * the coloured fill on top.
 *
 * Pure with respect to its inputs — no Babylon, no canvas creation. The
 * Babylon-side `_spawnFloatingText` is a thin wrapper that creates the
 * DynamicTexture and calls back into here.
 */
export function paintFloaterText(ctx, opts) {
  const {
    width,
    height,
    text,
    fillColor = '#ffe0a0',
    fontScale = 1,
  } = opts;
  ctx.clearRect(0, 0, width, height);
  if (!text) return;

  // Font: heavy weight + large pixel size so the label reads at zoom-out.
  const fontPx = Math.round(96 * fontScale);
  ctx.font = `900 ${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const metrics = ctx.measureText(text);
  const padX = Math.round(fontPx * 0.45);
  const padY = Math.round(fontPx * 0.20);
  const pillW = Math.min(width - 8, Math.ceil(metrics.width) + padX * 2);
  const pillH = Math.min(height - 8, fontPx + padY * 2);
  const pillX = (width - pillW) / 2;
  const pillY = (height - pillH) / 2;
  const radius = Math.round(pillH / 2);

  // Background pill — semi-opaque dark fill so the text reads against any
  // tile colour. Rounded with the half-height radius for a pill silhouette.
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.beginPath();
  ctx.moveTo(pillX + radius, pillY);
  ctx.lineTo(pillX + pillW - radius, pillY);
  ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + radius, radius);
  ctx.lineTo(pillX + pillW, pillY + pillH - radius);
  ctx.arcTo(pillX + pillW, pillY + pillH, pillX + pillW - radius, pillY + pillH, radius);
  ctx.lineTo(pillX + radius, pillY + pillH);
  ctx.arcTo(pillX, pillY + pillH, pillX, pillY + pillH - radius, radius);
  ctx.lineTo(pillX, pillY + radius);
  ctx.arcTo(pillX, pillY, pillX + radius, pillY, radius);
  ctx.closePath();
  ctx.fill();

  // Outline: chunky black stroke drawn BEFORE the fill so the fill paints
  // over its inner half — gives a crisp halo with no ghosting.
  const cx = width / 2;
  const cy = height / 2;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(6, Math.round(fontPx * 0.14));
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, cx, cy);

  ctx.fillStyle = fillColor;
  ctx.fillText(text, cx, cy);
}

/**
 * Paint the floating unit-icon badge into a 2D canvas context: portrait
 * image clipped to a centred disc, with a coloured HP arc rim around it.
 *
 * The portrait `img` argument is optional — when null/undefined the icon
 * disc is filled with a neutral grey so the ring still reads. The arc is
 * drawn from 12 o'clock clockwise (matching how players read clocks) and
 * shrinks counter-clockwise as HP drops, so a near-dead unit shows a tiny
 * sliver of colour over a dark "empty" track.
 *
 * Pure with respect to its inputs (no Babylon, no canvas creation); the
 * Babylon-side `_createUnitIconBadge` is a thin wrapper that creates the
 * DynamicTexture and calls back into here.
 */
export function paintUnitIconBadge(ctx, opts) {
  const {
    size,
    portraitImg = null,
    portraitRect = null, // { x, y, size } when drawing from a tilemap
    hp,
    maxHp,
  } = opts;
  const W = size;
  const H = size;
  const cx = W / 2;
  const cy = H / 2;
  const ringThickness = Math.max(2, Math.round(W * UNIT_ICON_RING_THICKNESS_FRAC));
  // Outer ring radius is just inside the plane edge; inner radius is the
  // icon disc radius. The icon image is clipped to the inner disc.
  const outerR = (W / 2) - 2;
  const innerR = outerR - ringThickness;

  ctx.clearRect(0, 0, W, H);

  // Dark track behind the arc — so a low-HP unit still shows a full ring
  // outline against the bright terrain.
  ctx.lineWidth = ringThickness;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.beginPath();
  ctx.arc(cx, cy, (outerR + innerR) / 2, 0, Math.PI * 2);
  ctx.stroke();

  // Coloured arc — 12 o'clock start, sweep clockwise by HP fraction.
  const fraction = hpRingFraction(hp, maxHp);
  if (fraction > 0) {
    const startAngle = -Math.PI / 2;
    const endAngle   = startAngle + Math.PI * 2 * fraction;
    ctx.strokeStyle = hpBarColor(hp, maxHp);
    ctx.lineWidth = ringThickness;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, (outerR + innerR) / 2, startAngle, endAngle, false);
    ctx.stroke();
  }

  // Icon disc: portrait clipped to a circle. Neutral pale fill behind the
  // image so the disc reads as a solid sticker even before the portrait
  // pixels paint (and as a fallback when no portrait is available).
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = 'rgba(225,220,210,1)';
  ctx.fillRect(0, 0, W, H);
  if (portraitImg && portraitRect) {
    ctx.drawImage(
      portraitImg,
      portraitRect.x, portraitRect.y, portraitRect.size, portraitRect.size,
      cx - innerR, cy - innerR, innerR * 2, innerR * 2,
    );
  } else if (portraitImg) {
    ctx.drawImage(portraitImg, cx - innerR, cy - innerR, innerR * 2, innerR * 2);
  }
  ctx.restore();
}

/**
 * Lifecycle pose of a floating-text label at progress `t ∈ [0,1]`.
 *
 * Returns:
 *   • y     — vertical offset above the spawn position (0 at t=0, 1.2 at t=1).
 *   • alpha — opacity (1 for first half, lerps 1→0 over second half).
 *
 * Mirrors the keyframes set on the Babylon Animation in `_spawnFloatingText`
 * so tests can verify the curve without a scene.
 */
export function floatingTextTransform(t, riseDistance = 1.2) {
  const clamped = Math.max(0, Math.min(1, t));
  const y = clamped * riseDistance;
  // Alpha holds at 1 for the first half, then lerps 1→0 across the second.
  const alpha = clamped < 0.5 ? 1 : Math.max(0, 1 - (clamped - 0.5) * 2);
  return { y, alpha };
}

// ─── Movement highlight overlay (exported for tests) ────────────────────────

/** Y position of the flat highlight ring above the tile prism top (+0.075).
 *  Must sit clearly above the tallest road-network geometry so the outline
 *  reads from any tilt under the locked isometric camera. Effective Y caps in
 *  the road/river network and node rings (RIVER_RIBBON_Y = 0.005, ROAD_RIBBON_Y
 *  = 0.008, node-ring tube apex ≈ 0.09) sit well below this layer, leaving a
 *  comfortable depth margin instead of the ~0.03 separation 0.12 used to give.
 *  Pinned to the floor of the `highlight-disc` overlay layer (0.160); sits
 *  BELOW the `plan-arrow` layer (PLAN_LINE_Y = 0.180) so the plan overlay still
 *  draws on top. The strict ordering — ribbons < highlight < plan line — is
 *  locked by tests in `renderer-3d-polish-4.test.js` and the
 *  `renderer-3d-highlight-overlay.test.js` suite. See Y_TABLE in overlays.js. */
export const HIGHLIGHT_DISC_Y      = yForLayer('highlight-disc', 0);
/** Applied alpha on the highlight ring material. The overlay reads as a
 *  translucent ring over the tile rather than a solid floor sticker — operator
 *  wants 0.6–0.7 so the underlying terrain stays visible. We OVERRIDE the
 *  source rgba alpha (which can be as low as 0.14 in ui.js for ally hexes, or
 *  as high as 0.85 for the default movement target) with this constant so the
 *  ring's translucency is consistent regardless of the caller's colour string. */
export const HIGHLIGHT_OVERLAY_ALPHA = 0.65;
/** @deprecated retained for tests that import the old name — same value as
 *  HIGHLIGHT_OVERLAY_ALPHA, semantics changed from "clamp floor" to
 *  "applied alpha". */
export const HIGHLIGHT_MIN_ALPHA   = HIGHLIGHT_OVERLAY_ALPHA;
/** RGB darkening factor applied to highlight colours before the material is
 *  built. Operator wants deeper, more saturated green/red overlays rather than
 *  the pastel wash the previous round produced. 0.72 ≈ 28% darker, which moves
 *  the default movement-green from (60,220,80) ≈ pastel mint to (~43,~158,~58)
 *  ≈ deep forest-green, and the default attack-red from (220,60,60) ≈ coral to
 *  (~158,~43,~43) ≈ blood-red. Applied to RGB only — alpha is overridden by
 *  HIGHLIGHT_OVERLAY_ALPHA. */
export const HIGHLIGHT_DEEPEN_FACTOR = 0.72;
/** Fallback rgba when an entry lacks `color` — neutral green (movement). */
export const HIGHLIGHT_DEFAULT_RGBA = 'rgba(60,220,80,0.85)';
/** Outer/inner hex polygon radii (world units) for the outline ring. The gap
 *  between the two defines the ring's visual thickness. Outer is just inside
 *  the tile's footprint (1.0 = HEX_RADIUS_WORLD) so adjacent tiles' rings
 *  don't visually touch; inner is far enough in that the ring reads as a
 *  clear band even when the camera is tilted. */
export const HIGHLIGHT_OUTER_R     = 0.95;
export const HIGHLIGHT_INNER_R     = 0.78;

/**
 * Two concentric pointy-top hex polygons (outer + inner) for a single hex,
 * raised to `y` on the world XZ plane. Used to build the movement-highlight
 * outline ribbon — Babylon ribbons need two paths to fill the annulus between
 * them. Each path has 7 points (last == first) so the ribbon closes around
 * the hex without a seam.
 *
 * Pure function — exported so tests can lock down the geometry without a
 * Babylon scene.
 */
export function hexOutlinePaths(
  col, row,
  outerR = HIGHLIGHT_OUTER_R,
  innerR = HIGHLIGHT_INNER_R,
  y = HIGHLIGHT_DISC_Y,
) {
  const { x, z } = hexToWorld(col, row);
  const outer = [];
  const inner = [];
  for (let i = 0; i <= 6; i++) {
    // Pointy-top hex: vertices at 30°, 90°, 150°, 210°, 270°, 330°.
    const a = Math.PI / 6 + (Math.PI / 3) * i;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    outer.push({ x: x + outerR * cosA, y, z: z + outerR * sinA });
    inner.push({ x: x + innerR * cosA, y, z: z + innerR * sinA });
  }
  return { outer, inner };
}

/**
 * Compute a stable signature for a `highlightHexes` array so the renderer can
 * skip rebuilding the overlay when nothing changed. Order-sensitive: ui.js
 * always rebuilds the list deterministically per selection, so two equal
 * selections produce identical signatures.
 */
export function movementHighlightSignature(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  let out = '';
  for (const h of list) {
    if (!h || typeof h.col !== 'number' || typeof h.row !== 'number') continue;
    out += `${h.col},${h.row},${h.color || ''}|`;
  }
  return out;
}

/**
 * Compute a stable signature for the inputs of `_buildPlanArrows` so the
 * renderer can early-out when nothing in the move plan has changed. The move
 * overlays are derived deterministically from (a) the MOVE arrows in
 * `planGhostSteps` and (b) each acting entity's owner colour (via
 * `entityBaseColor`), so signing those two pieces is equivalent to signing the
 * published descriptors — any plan edit, entity move, or owner-colour change
 * triggers a rebuild, and nothing else does.
 *
 * Pure so it can be unit-tested without a Babylon scene.
 */
export function planArrowsSignature(steps, entities) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  let out = '';
  const seenIds = new Set();
  for (const s of steps) {
    if (!s?.arrow) continue;
    const { entityId, fromCol, fromRow, toCol, toRow } = s.arrow;
    out += `${entityId};${fromCol},${fromRow};${toCol},${toRow};${s.stepNumber ?? ''}|`;
    seenIds.add(entityId);
  }
  if (out === '') return '';
  // Append per-acting-entity owner colour. Looking up via `find` matches the
  // renderer's own lookup (`state.entities.find(e => e.id === entityId)`), so
  // the colour we sign matches the colour the rebuild will read.
  if (Array.isArray(entities) && seenIds.size > 0) {
    const ids = [...seenIds].sort();
    for (const id of ids) {
      const ent = entities.find(e => e?.id === id);
      out += `${id}=${entityBaseColor(ent ?? {})}|`;
    }
  }
  return out;
}

/**
 * Compute a stable signature for the inputs of `_buildPlanBattleArrows`. The
 * battle overlays are derived deterministically from every BATTLE_UNIT /
 * BATTLE_HEX `attackArrow` step in plan order, so a per-step (from, to) hash
 * uniquely identifies the overlay set — the ×N badge counts fall out
 * automatically — and signing it is equivalent to signing the descriptors.
 *
 * Pure so it can be unit-tested without a Babylon scene.
 */
export function planBattleOverlaySignature(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  let out = '';
  for (const s of steps) {
    if (!s?.attackArrow) continue;
    const { fromCol, fromRow, toCol, toRow } = s.attackArrow;
    out += `${fromCol},${fromRow}>${toCol},${toRow}|`;
  }
  return out;
}

/**
 * Parse a CSS rgba string ("rgba(r,g,b,a)" or "rgb(r,g,b)") to [r,g,b,a] in
 * 0..1. Returns a sensible default tuple for unparseable inputs so callers
 * never end up with NaN material colours.
 */
export function parseRgba01(css) {
  if (typeof css !== 'string') return [0.4, 0.85, 0.4, 0.35];
  const m = /rgba?\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)/i.exec(css);
  if (!m) return [0.4, 0.85, 0.4, 0.35];
  const r = clamp01(parseFloat(m[1]) / 255);
  const g = clamp01(parseFloat(m[2]) / 255);
  const b = clamp01(parseFloat(m[3]) / 255);
  const a = m[4] != null ? clamp01(parseFloat(m[4])) : 1;
  return [r, g, b, a];
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Deepen a parsed [r,g,b,a] tuple by scaling RGB toward black by
 * HIGHLIGHT_DEEPEN_FACTOR. Alpha is passed through unchanged — alpha is
 * overridden at the material layer by HIGHLIGHT_OVERLAY_ALPHA. Pure so the
 * colour math can be tested without a Babylon scene.
 */
export function deepenHighlight01(rgba01) {
  if (!Array.isArray(rgba01) || rgba01.length < 3) return [0, 0, 0, 1];
  const k = HIGHLIGHT_DEEPEN_FACTOR;
  const r = clamp01(rgba01[0] * k);
  const g = clamp01(rgba01[1] * k);
  const b = clamp01(rgba01[2] * k);
  const a = rgba01.length > 3 ? clamp01(rgba01[3]) : 1;
  return [r, g, b, a];
}

/**
 * World-space position of a movement-highlight disc for a given hex. Used by
 * tests to assert the overlay lands on the expected tile centre.
 */
export function movementHighlightPosition(col, row) {
  const { x, z } = hexToWorld(col, row);
  return { x, y: HIGHLIGHT_DISC_Y, z };
}

/**
 * Projectile colour by type (linear-RGB, 0..1). Used by `addProjectileAnim`
 * for the sphere's diffuse/emissive colour. Unknown types fall back to a
 * neutral pale yellow.
 */
export function projectileColor01(projectileType) {
  switch (projectileType) {
    case 'sparkle':  // witch
      return [0.4, 1.0, 0.5];
    case 'arrow':    // hero
    case 'crossbow':
      return [0.85, 0.6, 0.25];
    default:
      return [1.0, 0.95, 0.7];
  }
}

// ─── Reaction effects: Sound Horn ring + Power-Node-Discovered burst ────────
//
// Both effects sit just above the tile-prism top so the ground geometry never
// occludes them, but below the standee silhouettes so the unit on the hex
// still reads clearly. Pure curve helpers below let tests lock the radius /
// alpha shapes without spinning up a Babylon scene.

/** Y of the flat sound-horn ring. Above the tile prism top (0.075) and the
 *  road/river ribbon apex (≈ 0.09), well below the icon billboards (>0.5). */
export const SOUND_HORN_RING_Y      = 0.12;
/** Lifetime of the horn ring (ms). 700ms — long enough to register, short
 *  enough that the post-horn dialog opens promptly. */
export const SOUND_HORN_RING_MS     = 700;
/** Starting radius of the ring in world units. ~0.2 wu so the ring spawns
 *  small at the actor's feet rather than blooming out of nowhere. */
export const SOUND_HORN_RING_R0     = 0.2;
/** Ending radius of the ring in world units. 2.5 wu — comfortably larger
 *  than a single hex (radius ≈ 1) but still local enough to read as the
 *  actor's pulse, not a global shockwave. */
export const SOUND_HORN_RING_R1     = 2.5;
/** Tube thickness for the torus that backs the ring mesh. Thin so the ring
 *  reads as a wave, not a blob. Scaled with the ring radius during the
 *  animation (the diameter and thickness scale together on a torus). */
export const SOUND_HORN_RING_TUBE   = 0.03;

/** Linear lerp of the horn ring radius from `r0` to `r1` as `t` walks 0→1.
 *  Mirrors the keyframes set on the Babylon scaling animation in
 *  `addSoundHorn`, so tests can pin the curve without a scene. Clamped
 *  outside [0, 1] so callers can hand in raw elapsed/duration without
 *  worrying about overshoot at the endpoints. */
export function soundHornRingRadius(t, r0 = SOUND_HORN_RING_R0, r1 = SOUND_HORN_RING_R1) {
  const c = Math.max(0, Math.min(1, t));
  return r0 + (r1 - r0) * c;
}

/** Linear fade of the horn ring alpha — 1 at t=0, 0 at t=1, clamped at
 *  the endpoints. Keeps the ring visible at full strength when it spawns
 *  and lets it dissolve over the same window the radius expands. */
export function soundHornRingAlpha(t) {
  const c = Math.max(0, Math.min(1, t));
  return 1 - c;
}

/** Y of the flat node-discovered starburst. Same band as the horn ring so
 *  ground geometry doesn't occlude either effect. */
export const NODE_DISCOVERED_Y          = 0.12;
/** Lifetime of the node-discovered starburst (ms). Shorter than the horn
 *  ring because the floating label carries the punctuation. */
export const NODE_DISCOVERED_MS         = 600;
/** Inner radius of the rays at t=0. The burst starts as a single point at
 *  the hex centre. */
export const NODE_DISCOVERED_R0         = 0;
/** Outer radius of the rays at t=1. 1.5 wu — pokes one hex out from the
 *  node centre so it's visible without splashing onto neighbouring tiles. */
export const NODE_DISCOVERED_R1         = 1.5;
/** Number of rays in the starburst. 8 evenly-spaced spokes — enough to read
 *  as a burst, few enough to keep the LinesMesh cheap. */
export const NODE_DISCOVERED_RAY_COUNT  = 8;
/** Lifetime of the floating "Power Node Discovered" label (ms). Held longer
 *  than a combat floater so the player can read it. */
export const NODE_DISCOVERED_LABEL_MS   = 1500;

/** Endpoint positions for the starburst rays — `count` evenly-spaced spokes
 *  at the unit radius. The renderer scales the resulting mesh from 0 → 1 on
 *  x/z to animate the burst, so the endpoints here represent the final
 *  outer ring. Returns `[{x, z}]` in local space (Y is fixed by the caller). */
export function nodeDiscoveredRayEndpoints(
  count  = NODE_DISCOVERED_RAY_COUNT,
  radius = NODE_DISCOVERED_R1,
) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({ x: Math.cos(a) * radius, z: Math.sin(a) * radius });
  }
  return out;
}

/** Linear scale curve for the node-discovered burst: 0 at t=0, 1 at t=1,
 *  clamped at the endpoints. The renderer applies this to mesh.scaling.x/z
 *  so the rays appear to grow outward from the centre. */
export function nodeDiscoveredRayScale(t) {
  return Math.max(0, Math.min(1, t));
}

/** Alpha curve for the node-discovered burst — full opacity for the first
 *  half of its lifetime, then linear fade to 0 over the second half. Matches
 *  the floating-text fade in `floatingTextTransform` so the burst and its
 *  label sustain together before dissolving in sync. */
export function nodeDiscoveredAlpha(t) {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 1 : Math.max(0, 1 - (c - 0.5) * 2);
}
