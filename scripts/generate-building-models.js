#!/usr/bin/env node
/**
 * scripts/generate-building-models.js
 *
 * Generate a 3D model (GLB) for each Brimstone building from the building's
 * current 2D art, using the Scenario generative-AI image-to-3D pipeline
 * (Hunyuan 3D). Downloads the resulting GLBs to a scratch output directory for
 * evaluation in the 3D asset viewer (/admin/tools → Assets tab, or
 * /admin/assets).
 *
 * THIS CALLS AN EXTERNAL PAID API. By default it generates ONE building. Use
 * --limit / --id to control scope explicitly. It never loops all buildings
 * unless you pass --all.
 *
 * ── Flow (per building) ──────────────────────────────────────────────────────
 *   1. Obtain an input image *asset* on Scenario:
 *        a. If a local sprite exists (assets/generated/buildings/<id>.png),
 *           upload it via POST /v1/assets → assetId.    [--source local]
 *        b. Otherwise generate the 2D building art with the same txt2img model
 *           + prompt the 2D asset pipeline uses (from assets/image-list.json),
 *           and reuse the generated assetId directly.   [--source generate, default]
 *   2. Submit an image-to-3D job:
 *        POST /v1/generate/custom/{MODEL_3D}  { image: assetId, prompt, paint,
 *                                               steps, guidanceScale, targetFaceNum, format: 'glb' }
 *   3. Poll GET /v1/jobs/{jobId} until status=success.
 *   4. Resolve the result asset(s): GET /v1/assets/{id} → asset.url → download GLB.
 *   5. Look-preserving simplify (offline, no API): decimate the downloaded GLB
 *      from the rich ~10k-face generation down to a leaner triangle target using
 *      meshoptimizer's error-bounded simplifier (via gltf-transform). Materials,
 *      textures and UVs are preserved. The raw mesh is kept as <id>.raw.glb and
 *      the simplified mesh becomes the final <id>.glb.
 *
 * Rationale: generating rich (10k faces) then decimating with an appearance-
 * preserving decimator yields a better-looking low-poly asset than asking the
 * generator for a low face count directly.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/generate-building-models.js --list           # list building ids, exit
 *   node scripts/generate-building-models.js --dry-run         # print plan, no API calls
 *   node scripts/generate-building-models.js --id church       # one building
 *   node scripts/generate-building-models.js --limit 3         # first 3 buildings
 *   node scripts/generate-building-models.js --id house,church,inn   # explicit subset
 *   node scripts/generate-building-models.js --all             # ALL buildings (paid! prompts unless --yes)
 *
 * ── Options ──────────────────────────────────────────────────────────────────
 *   --id <a,b,c>       Comma-separated building id(s) to process
 *   --limit <n>        Process the first n buildings (default: 1)
 *   --all              Process every building (requires --yes to skip confirm)
 *   --yes              Skip the "this is a paid API" confirmation for --all
 *   --source <mode>    'generate' (txt2img the 2D art first, default) | 'local'
 *                      (upload existing assets/generated/buildings/<id>.png)
 *   --out <dir>        Output dir for GLBs (default: /tmp/scenario-buildings)
 *   --model <id>       3D model id (default: model_hunyuan-3d-v2-1)
 *   --txt2img-model    txt2img model id (default: from image-list.json apiConfig.modelId)
 *   --steps <n>        3D sampling steps (default: 30)
 *   --guidance <n>     3D guidance scale (default: 5.5)
 *   --faces <n>        3D generation target face count (default: 10000 — rich base for decimation)
 *   --simplify-target <n>  Triangle target after look-preserving simplify (default: 5000)
 *   --no-simplify      Skip the simplify post-step (keep the raw generated mesh as <id>.glb)
 *   --simplify-error <n>   Meshopt error bound for simplify (default: 0.01; higher = more aggressive)
 *   --no-paint         Skip PBR texture painting (geometry only, faster/cheaper)
 *   --dry-run          Print the planned requests without calling the API
 *   --list             List available building ids and exit
 *
 * ── Environment variables ────────────────────────────────────────────────────
 *   SCENARIO_API_KEY      Scenario API key      (read from process.env or ./.env)
 *   SCENARIO_API_SECRET   Scenario API secret
 *
 * Auth uses HTTP Basic: Authorization: Basic base64("<KEY>:<SECRET>"), matching
 * scripts/generate-assets.js. Verify your credentials with:
 *   curl -s -u "$SCENARIO_API_KEY:$SCENARIO_API_SECRET" \
 *        https://api.cloud.scenario.com/v1/models | head
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ── Load .env from project root if present (same loader as generate-assets.js) ─
const ENV_PATH = path.join(ROOT, '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const CONFIG_PATH    = path.join(ROOT, 'assets', 'image-list.json');
const LOCAL_ART_DIR  = path.join(ROOT, 'assets', 'generated', 'buildings');

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(...names) { return names.some(n => argv.includes(n)); }
function argVal(name, fallback = null) {
  const i = argv.indexOf(name);
  return i !== -1 ? (argv[i + 1] ?? fallback) : fallback;
}

const LIST_ONLY = flag('--list');
const DRY_RUN   = flag('--dry-run', '-d');
const DO_ALL    = flag('--all');
const CONFIRM   = flag('--yes', '-y');
const NO_PAINT  = flag('--no-paint');
const SOURCE    = (argVal('--source', 'generate') || 'generate').toLowerCase();
const OUT_DIR   = argVal('--out', '/tmp/scenario-buildings');
const ID_ARG    = argVal('--id');
const LIMIT     = parseInt(argVal('--limit', '1'), 10);

const MODEL_3D       = argVal('--model', 'model_hunyuan-3d-v2-1');
const TXT2IMG_MODEL  = argVal('--txt2img-model');   // null → fall back to config.apiConfig.modelId
const STEPS          = parseInt(argVal('--steps', '30'), 10);
const GUIDANCE       = parseFloat(argVal('--guidance', '5.5'));
const FACES          = parseInt(argVal('--faces', '10000'), 10);

// Look-preserving simplify post-step (offline; no API).
const NO_SIMPLIFY      = flag('--no-simplify');
const SIMPLIFY_TARGET  = parseInt(argVal('--simplify-target', '5000'), 10);
const SIMPLIFY_ERROR   = parseFloat(argVal('--simplify-error', '0.01'));

// ── Config / building list ──────────────────────────────────────────────────

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}
const config    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const apiConfig = config.apiConfig ?? {};
const BASE_URL  = apiConfig.baseUrl || 'https://api.cloud.scenario.com/v1';
const POLL_MS   = apiConfig.pollIntervalMs ?? 3000;
const txt2imgModel = TXT2IMG_MODEL || apiConfig.modelId;

const allBuildings = (config.assets || []).filter(a => a.category === 'building');
if (!allBuildings.length) {
  console.error('No building assets found in assets/image-list.json (category "building").');
  process.exit(1);
}

if (LIST_ONLY) {
  console.log('Available building ids:');
  for (const b of allBuildings) console.log(`  ${b.id.padEnd(14)} ${b.name ?? ''}`);
  process.exit(0);
}

function selectBuildings() {
  if (ID_ARG) {
    const wanted = ID_ARG.split(',').map(s => s.trim()).filter(Boolean);
    const picked = [];
    for (const id of wanted) {
      const found = allBuildings.find(b => b.id === id);
      if (!found) {
        console.error(`No building with id "${id}". Run --list to see ids.`);
        process.exit(1);
      }
      picked.push(found);
    }
    return picked;
  }
  if (DO_ALL) return allBuildings;
  const n = Number.isFinite(LIMIT) && LIMIT > 0 ? LIMIT : 1;
  return allBuildings.slice(0, n);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function makeAuthHeader() {
  const key    = process.env.SCENARIO_API_KEY;
  const secret = process.env.SCENARIO_API_SECRET;
  if (!key || !secret) {
    console.error(
      'Missing credentials. Set both env vars (or put them in ./.env):\n' +
      '  SCENARIO_API_KEY=<your key>\n' +
      '  SCENARIO_API_SECRET=<your secret>\n\n' +
      'Verify with:\n' +
      '  curl -s -u "$SCENARIO_API_KEY:$SCENARIO_API_SECRET" ' +
      `${BASE_URL}/models | head`
    );
    process.exit(1);
  }
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

// ── Scenario API helpers ────────────────────────────────────────────────────

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return res;
}

// Poll a job until it terminates. Returns the success job object.
async function pollJob(jobId, auth, label = '') {
  const url      = `${BASE_URL}/jobs/${jobId}`;
  const deadline = Date.now() + 20 * 60 * 1000; // 3D jobs can take a while
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const res = await apiFetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    const { job } = await res.json();
    process.stdout.write(`    ${label} polling… status=${job.status}   \r`);
    if (job.status === 'success') { process.stdout.write('\n'); return job; }
    if (job.status === 'failure' || job.status === 'canceled') {
      process.stdout.write('\n');
      const err  = job.metadata?.error ?? 'unknown error';
      const hint = job.metadata?.hint ? ' — ' + job.metadata.hint : '';
      throw new Error(`Job ${job.status}: ${err}${hint}`);
    }
  }
  throw new Error(`Job ${jobId} timed out`);
}

// Resolve an asset id → its downloadable URL.
async function fetchAssetUrl(assetId, auth) {
  const res = await apiFetch(`${BASE_URL}/assets/${assetId}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  const { asset } = await res.json();
  return asset.url;
}

async function download(url, destPath) {
  const res = await apiFetch(url);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

// (a) Generate the 2D building art via txt2img; return the generated assetId.
async function generate2DArt(building, auth) {
  const body = {
    prompt:     building.parameters?.prompt,
    width:      apiConfig.defaultParameters?.width ?? 2048,
    height:     apiConfig.defaultParameters?.height ?? 2048,
    numSamples: 1,
  };
  // Carry the building's style reference image if the config defines one.
  const refId = building.referenceAssetId ?? apiConfig.referenceAssetId;
  if (refId) { body.type = 'img2img'; body.referenceImages = [refId]; }

  const res = await apiFetch(`${BASE_URL}/generate/custom/${txt2imgModel}`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify(body),
  });
  const { job } = await res.json();
  const done = await pollJob(job.jobId, auth, '2D');
  const ids  = done.metadata?.assetIds ?? [];
  if (!ids.length) throw new Error('txt2img returned no assets');
  return ids[0];
}

// (b) Upload an existing local PNG → return its assetId. Uses base64 JSON
// (simplest, no multipart deps); the docs also accept multipart/form-data.
async function uploadLocalArt(localPath, name, auth) {
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(localPath).toString('base64');
  const res = await apiFetch(`${BASE_URL}/assets`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({ image: dataUrl, name }),
  });
  const data = await res.json();
  const assetId = data.asset?.assetId ?? data.asset?.id;
  if (!assetId) throw new Error(`Upload returned no asset id: ${JSON.stringify(data).slice(0, 200)}`);
  return assetId;
}

// 3D prompt: keep faithful to the building's identity but steer toward a
// clean low-poly game asset rather than the top-down sprite framing.
function prompt3D(building) {
  const name = (building.name ?? building.id).toLowerCase();
  return `low-poly colonial New England ${name}, clean game asset, single isolated building, neutral background`;
}

// Submit the image-to-3D job, poll, download the GLB. Returns dest path.
async function generate3D(building, inputAssetId, auth) {
  const body = {
    image:         inputAssetId,
    prompt:        prompt3D(building),
    paint:         !NO_PAINT,   // PBR texture pass
    steps:         STEPS,
    guidanceScale: GUIDANCE,
    targetFaceNum: FACES,
    format:        'glb',
  };
  const res = await apiFetch(`${BASE_URL}/generate/custom/${MODEL_3D}`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify(body),
  });
  const { job } = await res.json();
  console.log(`  ✦ 3D job ${building.id} → ${job.jobId}`);
  const done = await pollJob(job.jobId, auth, '3D');

  const ids = done.metadata?.assetIds ?? [];
  if (!ids.length) throw new Error('3D job returned no assets');

  // Prefer a .glb asset if multiple are returned (mesh + preview image, etc.).
  let chosen = ids[0];
  let chosenUrl = await fetchAssetUrl(chosen, auth);
  if (ids.length > 1) {
    for (const id of ids) {
      const url = await fetchAssetUrl(id, auth);
      if (/\.glb(\?|$)/i.test(url)) { chosen = id; chosenUrl = url; break; }
    }
  }

  const dest = path.join(OUT_DIR, `${building.id}.glb`);
  await download(chosenUrl, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`  ✔ saved  ${dest}  (${kb} KB)`);

  if (!NO_SIMPLIFY) {
    // Keep the rich generated mesh alongside for comparison, simplify into <id>.glb.
    const raw = path.join(OUT_DIR, `${building.id}.raw.glb`);
    fs.copyFileSync(dest, raw);
    try {
      // Lazy import: devDeps only needed when actually simplifying, so
      // --list / --dry-run / --no-simplify never load gltf-transform/meshopt.
      const { simplifyGlb } = await import('./simplify-glb.js');
      const { before, after, hitTarget } =
        await simplifyGlb(raw, dest, SIMPLIFY_TARGET, SIMPLIFY_ERROR);
      const skb = (fs.statSync(dest).size / 1024).toFixed(1);
      const note = hitTarget ? '' : `  (could not reach ${SIMPLIFY_TARGET} within error ${SIMPLIFY_ERROR} — kept best)`;
      console.log(`  ◆ simplify ${before} → ${after} tris  (target ${SIMPLIFY_TARGET})${note}`);
      console.log(`  ✔ final  ${dest}  (${skb} KB)   raw kept: ${raw}`);
    } catch (err) {
      // Don't lose the generated asset if simplify fails — restore the raw mesh.
      fs.copyFileSync(raw, dest);
      console.error(`  ⚠ simplify failed (${err.message}); kept raw mesh as ${dest}`);
    }
  }
  return dest;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const buildings = selectBuildings();

  console.log('\nBrimstone building → 3D model generator (Scenario)');
  console.log(`  3D model    : ${MODEL_3D}`);
  console.log(`  txt2img     : ${txt2imgModel ?? '(none configured)'}`);
  console.log(`  source      : ${SOURCE}`);
  console.log(`  paint (PBR) : ${!NO_PAINT}`);
  console.log(`  steps/guid/faces : ${STEPS} / ${GUIDANCE} / ${FACES}`);
  console.log(`  simplify    : ${NO_SIMPLIFY ? 'off' : `→ ${SIMPLIFY_TARGET} tris (meshopt, error ${SIMPLIFY_ERROR})`}`);
  console.log(`  output dir  : ${OUT_DIR}`);
  console.log(`  buildings   : ${buildings.map(b => b.id).join(', ')}  (${buildings.length})`);
  console.log();

  if (DRY_RUN) {
    for (const b of buildings) {
      console.log(`[${b.id}]`);
      if (SOURCE === 'local') {
        const lp = path.join(LOCAL_ART_DIR, `${b.id}.png`);
        console.log(`  input : upload ${path.relative(ROOT, lp)}${fs.existsSync(lp) ? '' : '  (MISSING!)'} → POST ${BASE_URL}/assets`);
      } else {
        console.log(`  input : txt2img via ${txt2imgModel} → assetId`);
        console.log(`          prompt: ${(b.parameters?.prompt ?? '').slice(0, 80)}…`);
      }
      console.log(`  3D    : POST ${BASE_URL}/generate/custom/${MODEL_3D}  { image, paint:${!NO_PAINT}, steps:${STEPS}, guidanceScale:${GUIDANCE}, targetFaceNum:${FACES}, format:'glb' }`);
      console.log(`          3D prompt: ${prompt3D(b)}`);
      if (NO_SIMPLIFY) {
        console.log(`  simplify: skipped (--no-simplify)`);
      } else {
        console.log(`  simplify: meshopt decimate ~${FACES} faces → ${SIMPLIFY_TARGET} tris (error ${SIMPLIFY_ERROR}); raw kept as ${b.id}.raw.glb`);
      }
      console.log(`  out   : ${path.join(OUT_DIR, b.id + '.glb')}`);
      console.log();
    }
    console.log('(dry run — no API calls made)');
    return;
  }

  if (DO_ALL && !CONFIRM) {
    console.error(
      `Refusing to generate ALL ${buildings.length} buildings without --yes.\n` +
      'This calls a paid external API once (or twice, with --source generate) per building.\n' +
      'Re-run with --all --yes to confirm, or use --limit / --id for a small trial.'
    );
    process.exit(1);
  }

  const auth = makeAuthHeader();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  let n = 0;
  for (const b of buildings) {
    console.log(`\n[${++n}/${buildings.length}] ${b.id}`);
    try {
      let inputAssetId;
      if (SOURCE === 'local') {
        const lp = path.join(LOCAL_ART_DIR, `${b.id}.png`);
        if (!fs.existsSync(lp)) {
          throw new Error(`No local art at ${path.relative(ROOT, lp)} — generate it first or use --source generate`);
        }
        console.log(`  ⬆ uploading ${path.relative(ROOT, lp)}…`);
        inputAssetId = await uploadLocalArt(lp, `${b.id}-src`, auth);
      } else {
        console.log(`  🎨 generating 2D art…`);
        inputAssetId = await generate2DArt(b, auth);
      }
      console.log(`  input assetId: ${inputAssetId}`);
      const dest = await generate3D(b, inputAssetId, auth);
      results.push({ id: b.id, ok: true, dest });
    } catch (err) {
      console.error(`  ✗ ${b.id} failed: ${err.message}`);
      results.push({ id: b.id, ok: false, error: err.message });
    }
  }

  console.log('\n── Summary ──────────────────────────────');
  for (const r of results) {
    console.log(r.ok ? `  ✔ ${r.id.padEnd(14)} ${r.dest}` : `  ✗ ${r.id.padEnd(14)} ${r.error}`);
  }
  const failed = results.filter(r => !r.ok).length;
  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
