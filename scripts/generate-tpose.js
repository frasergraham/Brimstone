#!/usr/bin/env node
/**
 * scripts/generate-tpose.js
 *
 * Phase 1 of the character → 3D-model pipeline.
 *
 * Takes the raw character icons (the transparent cut-outs under
 * assets/generated/units-raw/) and, for each one, generates a full-height
 * character standing in a strict T-pose with legs slightly apart and a
 * transparent background. These T-pose sheets are the intermediate art that
 * feeds the image-to-3D step (scripts/generate-building-models.js does the
 * equivalent for buildings — a character variant will consume these).
 *
 * Pipeline per character (Scenario API, same backend as generate-assets.js):
 *   1. Upload the raw icon            → POST /v1/assets          (reference id)
 *   2. img2img to a T-pose full body  → POST /v1/generate/custom/{model}
 *   3. Remove the flat background     → Photoroom bg-removal model (transparent)
 *   4. Download + trim/centre (sharp) → assets/generated/tpose/<id>.png
 *      (the pre-removal flat-bg frame is kept in assets/generated/tpose-flat/)
 *
 * Usage:
 *   node scripts/generate-tpose.js --list                # list character ids, exit
 *   node scripts/generate-tpose.js --dry-run             # print the plan, no API calls
 *   node scripts/generate-tpose.js --id paladin          # one character
 *   node scripts/generate-tpose.js --id paladin,witch    # an explicit subset
 *   node scripts/generate-tpose.js --limit 3             # first 3 icons
 *   node scripts/generate-tpose.js --all --yes           # every icon (paid! needs --yes)
 *
 * Options:
 *   --id <ids>          Comma-separated character ids (matches units-raw/<id>.png)
 *   --all              Process every icon in the source dir (requires --yes)
 *   --limit <n>        Process only the first N icons
 *   --list             List available character ids and exit
 *   --dry-run, -d      Print the plan without calling the API or writing files
 *   --yes, -y          Skip the "this is a paid API" confirmation for --all
 *   --source <dir>     Source icon dir (default: assets/generated/units-raw)
 *   --model <id>       Override the img2img model (default: image-list.json apiConfig.modelId)
 *   --size <px>        Square generation size (default 2048; a T-pose's arm-span ≈ height)
 *   --no-remove-bg     Skip background removal (keep the flat-bg frame)
 *   --no-trim          Skip the sharp trim/centre post-step
 *   --overwrite        Regenerate even if assets/generated/tpose/<id>.png exists
 *
 * Environment (read from process.env or ./.env):
 *   SCENARIO_API_KEY, SCENARIO_API_SECRET
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ── .env loader (mirrors generate-assets.js) ──────────────────────────────────
const ENV_PATH = path.join(ROOT, '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag    = (...names) => names.some(n => argv.includes(n));
const argVal  = (name, def = null) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : def;
};

const LIST       = flag('--list');
const DRY_RUN    = flag('--dry-run', '-d');
const ALL        = flag('--all');
const CONFIRM    = flag('--yes', '-y');
const NO_REMOVE  = flag('--no-remove-bg');
const NO_TRIM    = flag('--no-trim');
const OVERWRITE  = flag('--overwrite');
const LIMIT      = argVal('--limit') ? parseInt(argVal('--limit'), 10) : null;
const ID_FILTER  = argVal('--id');
const SIZE       = argVal('--size') ? parseInt(argVal('--size'), 10) : 2048;

// ── Config / paths ────────────────────────────────────────────────────────────
const config    = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'image-list.json'), 'utf8'));
const apiConfig = config.apiConfig ?? {};
const BASE_URL  = apiConfig.baseUrl || 'https://api.cloud.scenario.com/v1';
const MODEL     = argVal('--model') || apiConfig.modelId;
const REMOVE_BG_MODEL = 'model_photoroom-background-removal';

const SRC_DIR   = path.resolve(ROOT, argVal('--source') || 'assets/generated/units-raw');
const OUT_DIR   = path.join(ROOT, 'assets', 'generated', 'tpose');      // transparent final
const FLAT_DIR  = path.join(ROOT, 'assets', 'generated', 'tpose-flat'); // pre-removal flat-bg

// ── Prompt ────────────────────────────────────────────────────────────────────
function readableName(id) {
  // survivor_blacksmith → "blacksmith"; wood_golem → "wood golem"
  const base = id.replace(/^survivor_/, '').replace(/_/g, ' ');
  // Enrich from image-list.json if the unit asset is registered.
  const asset = (config.assets ?? []).find(a => a.id === id);
  return asset?.name ? asset.name.replace(/^the\s+/i, '') : base;
}

function buildTposePrompt(id) {
  const name = readableName(id);
  return (
    `Full-body character reference of the SAME character shown in the reference image (${name}), ` +
    `redrawn standing in a strict symmetrical T-pose: facing the camera straight on, ` +
    `both arms fully extended horizontally out to the sides at shoulder height, open EMPTY hands holding nothing, palms down, fingers together, ` +
    `legs straight and slightly apart, feet flat on the ground and pointing forward. ` +
    `The ENTIRE body is visible from the top of the head to the soles of the feet, centered and filling the frame vertically. ` +
    `Keep the reference character's exact face, hairstyle, skin tone, body proportions, the clothing and armour they WEAR with its colours, and the same art style. ` +
    `This is a PLAIN base character model with NO embellishments: hands empty, holding nothing. ` +
    `Remove every weapon (held or sheathed), sword, staff, axe, knife, dagger, bow, shield, tool, bag, backpack, pouch, lantern and any carried or held item. ` +
    `Remove ALL magic, smoke, fire, glow, aura, particles, sparkles and special effects. Show ONLY the character's body and the clothes/armour they wear. ` +
    `Exactly one figure — no duplicates, no character sheet, no multiple poses, no side-by-side panels. ` +
    `Arms and legs clearly separated from the torso with empty space around each limb (clean silhouette for 3D reconstruction). ` +
    `Plain flat neutral light-grey background, even flat lighting, no shadows, no ground plane, no props, no text, no border.`
  );
}

const NEGATIVE_PROMPT =
  'multiple characters, duplicate, character sheet, turnaround panels, side view, back view, sitting, ' +
  'crossed arms, arms down, cropped body, cut off feet, extra limbs, extra fingers, ' +
  'weapon, sword, staff, axe, knife, dagger, gun, bow, shield, spear, tool, bag, backpack, pouch, lantern, ' +
  'held item, carried item, item in hand, prop, ' +
  'magic, magical effect, spell, smoke, fire, flames, glow, glowing, aura, halo, particles, sparkles, energy, mist, embers, ' +
  'busy background, scenery, shadows, drop shadow, ground, frame, watermark, text';

// ── Scenario API ──────────────────────────────────────────────────────────────
function makeAuthHeader() {
  const key = process.env.SCENARIO_API_KEY, secret = process.env.SCENARIO_API_SECRET;
  if (!key || !secret) {
    console.error('Missing env vars: SCENARIO_API_KEY and SCENARIO_API_SECRET must both be set (process.env or ./.env).');
    process.exit(1);
  }
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${opts?.method || 'GET'} ${url} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

// Downscale the reference before upload: the icons are 2048² (3–5MB) and the
// base64 JSON upload has a request-size cap (large icons 413 "Request Too Long").
// The reference only guides identity/style, so 1024px is ample — the T-pose is
// still generated at the full SIZE.
const REF_UPLOAD_MAX_PX = 1024;

async function uploadIcon(localPath, name, auth) {
  let buf = fs.readFileSync(localPath);
  try {
    const sharp = (await import('sharp')).default;
    buf = await sharp(buf)
      .resize({ width: REF_UPLOAD_MAX_PX, height: REF_UPLOAD_MAX_PX, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch { /* sharp unavailable — upload original (may 413 on the largest icons) */ }
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
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

async function submitImg2Img(id, referenceAssetId, auth) {
  const body = {
    prompt:          buildTposePrompt(id),
    negativePrompt:  NEGATIVE_PROMPT,
    width:           SIZE,
    height:          SIZE,
    numSamples:      1,
    type:            'img2img',
    referenceImages: [referenceAssetId],
  };
  const res = await apiFetch(`${BASE_URL}/generate/custom/${MODEL}`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  return data.job.jobId;
}

async function pollJob(jobId, auth, label = '') {
  const interval = apiConfig.pollIntervalMs ?? 3000;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    const res = await apiFetch(`${BASE_URL}/jobs/${jobId}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    const { job } = await res.json();
    process.stdout.write(`    ${label} polling… status=${job.status}    \r`);
    if (job.status === 'success') { process.stdout.write('\n'); return job; }
    if (job.status === 'failure' || job.status === 'canceled') {
      process.stdout.write('\n');
      throw new Error(`Job ${job.status}: ${job.metadata?.error ?? 'unknown error'}`);
    }
  }
  throw new Error(`Job ${jobId} timed out after 10 minutes`);
}

async function removeBackground(assetId, auth) {
  const res = await apiFetch(`${BASE_URL}/generate/custom/${REMOVE_BG_MODEL}`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({ image: assetId }),
  });
  const data = await res.json();
  const job  = await pollJob(data.job.jobId, auth, 'bg-removal');
  const ids  = job.metadata?.assetIds ?? [];
  if (!ids.length) throw new Error('Background removal returned no assets');
  return ids[0];
}

async function fetchAssetUrl(assetId, auth) {
  const res = await apiFetch(`${BASE_URL}/assets/${assetId}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  const { asset } = await res.json();
  return asset.url;
}

async function download(url, destPath) {
  const res = await apiFetch(url);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

// Trim the transparent border and re-centre the figure in a square canvas with
// a small margin, so every T-pose sheet is framed consistently for the 3D step.
async function trimAndCentre(srcPath) {
  let sharp;
  try { sharp = (await import('sharp')).default; }
  catch { console.warn('  [warn] sharp not installed — skipping trim/centre'); return; }
  try {
    const trimmed = await sharp(srcPath).trim().toBuffer({ resolveWithObject: true });
    const { data, info } = trimmed;
    const side = Math.round(Math.max(info.width, info.height) * 1.12); // ~12% margin
    const out  = await sharp({
      create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: data, gravity: 'centre' }]).png().toBuffer();
    fs.writeFileSync(srcPath, out);
  } catch (err) {
    console.warn(`  [warn] trim/centre failed (${err.message}); kept untrimmed image`);
  }
}

// ── Character selection ───────────────────────────────────────────────────────
function availableIds() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`Source dir not found: ${SRC_DIR}`);
    process.exit(1);
  }
  return fs.readdirSync(SRC_DIR)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .map(f => f.replace(/\.png$/i, ''))
    .sort();
}

function selectIds() {
  const all = availableIds();
  if (ID_FILTER) {
    const want = ID_FILTER.split(',').map(s => s.trim()).filter(Boolean);
    const missing = want.filter(id => !all.includes(id));
    if (missing.length) {
      console.error(`Unknown id(s): ${missing.join(', ')}\nAvailable:\n  ${all.join('\n  ')}`);
      process.exit(1);
    }
    return want;
  }
  let ids = all;
  if (LIMIT != null) ids = ids.slice(0, LIMIT);
  return ids;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function processOne(id, auth) {
  const srcIcon = path.join(SRC_DIR, `${id}.png`);
  const flatOut = path.join(FLAT_DIR, `${id}.png`);
  const finalOut = path.join(OUT_DIR, `${id}.png`);

  if (!OVERWRITE && fs.existsSync(finalOut)) {
    console.log(`• ${id}: exists, skipping (use --overwrite)`);
    return;
  }
  console.log(`• ${id}: uploading reference icon…`);
  const refId = await uploadIcon(srcIcon, `tpose-ref-${id}`, auth);

  console.log(`  ${id}: img2img T-pose (${SIZE}×${SIZE})…`);
  const jobId   = await submitImg2Img(id, refId, auth);
  const job     = await pollJob(jobId, auth, '2D');
  const genIds  = job.metadata?.assetIds ?? [];
  if (!genIds.length) throw new Error('img2img returned no assets');
  let resultId  = genIds[0];

  // Keep the flat-bg frame as an intermediate.
  await download(await fetchAssetUrl(resultId, auth), flatOut);
  console.log(`  ${id}: saved flat-bg intermediate → ${path.relative(ROOT, flatOut)}`);

  if (!NO_REMOVE) {
    console.log(`  ${id}: removing background…`);
    resultId = await removeBackground(resultId, auth);
  }
  await download(await fetchAssetUrl(resultId, auth), finalOut);

  if (!NO_TRIM && !NO_REMOVE) await trimAndCentre(finalOut);
  const kb = (fs.statSync(finalOut).size / 1024).toFixed(1);
  console.log(`  ✔ ${id}: saved → ${path.relative(ROOT, finalOut)} (${kb} KB)`);
}

async function main() {
  if (LIST) {
    console.log('Available character ids:\n  ' + availableIds().join('\n  '));
    return;
  }

  const ids = selectIds();

  if (!ID_FILTER && LIMIT == null && !ALL) {
    console.error(
      `Refusing to process all ${ids.length} icons without --all.\n` +
      'Use --id <id[,id]> or --limit <n> for a trial, or --all --yes for the full set.'
    );
    process.exit(1);
  }
  if (ALL && !CONFIRM && !DRY_RUN) {
    console.error(
      `Refusing to generate ALL ${ids.length} T-poses without --yes (Scenario is a paid API).\n` +
      'Re-run with --all --yes, or use --id / --limit for a small trial.'
    );
    process.exit(1);
  }

  console.log(`T-pose generation plan (${ids.length}):`);
  console.log(`  source : ${path.relative(ROOT, SRC_DIR)}/<id>.png`);
  console.log(`  output : ${path.relative(ROOT, OUT_DIR)}/<id>.png  (flat-bg: ${path.relative(ROOT, FLAT_DIR)}/)`);
  console.log(`  model  : ${MODEL}   size ${SIZE}×${SIZE}   remove-bg=${!NO_REMOVE}`);
  console.log(`  ids    : ${ids.join(', ')}`);

  if (DRY_RUN) {
    console.log('\n[dry-run] sample prompt for first id:\n' + buildTposePrompt(ids[0]));
    console.log('\n[dry-run] no API calls made, no files written.');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(FLAT_DIR, { recursive: true });
  const auth = makeAuthHeader();

  let ok = 0;
  for (const id of ids) {
    try { await processOne(id, auth); ok++; }
    catch (err) { console.error(`  ✗ ${id}: ${err.message}`); }
  }
  console.log(`\nDone: ${ok}/${ids.length} succeeded.`);
}

main().catch(err => { console.error(err); process.exit(1); });
