#!/usr/bin/env node
/**
 * scripts/generate-assets.js
 *
 * Generate Brimstone game assets via the Scenario API, then stitch them
 * into a labelled PNG tilemap.
 *
 * Usage:
 *   node scripts/generate-assets.js [options]
 *
 * Options:
 *   --dry-run, -d          Print requests without calling the API
 *   --test, -t             Generate one asset per category (tile, building, unit)
 *   --category <cat>       Only process: tile | building | unit
 *   --id <id>              Generate a single asset by id (e.g. --id grass)
 *   --stitch-only          Skip generation, stitch already-downloaded images
 *   --remove-bg-only       Re-run background removal on existing building images
 *   --postprocess-only     Re-apply circle/border post-process to existing unit images
 *   --output <path>        Tilemap output path (default: assets/tilemap.png)
 *
 * Environment variables:
 *   SCENARIO_API_KEY       Your Scenario API key
 *   SCENARIO_API_SECRET    Your Scenario API secret
 *
 * Examples:
 *   node scripts/generate-assets.js --dry-run
 *   node scripts/generate-assets.js --test
 *   node scripts/generate-assets.js --id graveyard
 *   node scripts/generate-assets.js --category tile
 *   node scripts/generate-assets.js
 *   node scripts/generate-assets.js --stitch-only
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT        = path.resolve(__dirname, '..');

// Load .env from project root if present
const ENV_PATH = path.join(ROOT, '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
const CONFIG_PATH = path.join(ROOT, 'assets', 'image-list.json');
const OUT_DIR     = path.join(ROOT, 'assets', 'generated');

// Generated assets are organised by category into subfolders. Units also keep
// an unbordered transparent-bg cutout in a sibling `units-raw/` folder — the
// bordered version in `units/` is what the tilemap stitch reads.
const CATEGORY_DIRS = {
  tile:     'tiles',
  building: 'buildings',
  unit:     'units',
  icon:     'icons',
};
const UNITS_RAW_DIR = 'units-raw';

function assetPath(asset) {
  const sub = CATEGORY_DIRS[asset.category] ?? asset.category;
  return path.join(OUT_DIR, sub, `${asset.id}.png`);
}
function unitRawPath(asset) {
  return path.join(OUT_DIR, UNITS_RAW_DIR, `${asset.id}.png`);
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function flag(...names)  { return names.some(n => argv.includes(n)); }
function argVal(name)    { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] ?? null : null; }

const DRY_RUN     = flag('--dry-run', '-d');
const TEST_MODE   = flag('--test',    '-t');
const STITCH_ONLY    = flag('--stitch-only');
const REMOVE_BG_ONLY = flag('--remove-bg-only');
const POSTPROCESS_ONLY = flag('--postprocess-only');
const FILTER_CAT     = argVal('--category');
const FILTER_ID      = argVal('--id');
const OUT_PATH    = argVal('--output') ?? path.join(ROOT, 'assets', 'tilemap.png');

// ── Config ────────────────────────────────────────────────────────────────────

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}

const config    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const apiConfig = config.apiConfig;

if (!apiConfig?.modelId || apiConfig.modelId === 'FILL_IN_MODEL_ID') {
  console.error('Set apiConfig.modelId in assets/image-list.json before generating.');
  process.exit(1);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function makeAuthHeader() {
  const key    = process.env.SCENARIO_API_KEY;
  const secret = process.env.SCENARIO_API_SECRET;
  if (!key || !secret) {
    console.error('Missing env vars: SCENARIO_API_KEY and SCENARIO_API_SECRET must both be set.');
    process.exit(1);
  }
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

// ── Asset selection ───────────────────────────────────────────────────────────

function selectAssets() {
  let assets = config.assets;

  if (FILTER_ID) {
    const found = assets.find(a => a.id === FILTER_ID);
    if (!found) {
      console.error(`No asset with id "${FILTER_ID}". Available ids:\n  ${assets.map(a => a.id).join('\n  ')}`);
      process.exit(1);
    }
    return [found];
  }

  if (FILTER_CAT) {
    assets = assets.filter(a => a.category === FILTER_CAT);
    if (!assets.length) {
      console.error(`No assets in category "${FILTER_CAT}". Valid categories: tile, building, unit`);
      process.exit(1);
    }
  }

  if (TEST_MODE) {
    // First asset from each represented category, in category order
    const order = ['tile', 'building', 'unit'];
    const seen  = new Set();
    assets = order.flatMap(cat =>
      assets.filter(a => a.category === cat && !seen.has(cat) && seen.add(cat))
    );
  }

  return assets;
}

// ── Scenario API ──────────────────────────────────────────────────────────────

async function submitJob(asset, auth) {
  const merged = {
    ...apiConfig.defaultParameters,
    ...asset.parameters,
  };

  // Custom models (e.g. Seedream) use /generate/custom/{modelId} with flat body
  const body = {
    prompt:     merged.prompt,
    width:      merged.width,
    height:     merged.height,
    numSamples: merged.numSamples ?? 1,
  };
  if (merged.negativePrompt) body.negativePrompt = merged.negativePrompt;

  // Reference image(s): per-asset override > global config; arrays win over
  // singletons. Multiple references push the model toward varied outputs —
  // useful for a diverse cast that shouldn't all share one reference face.
  let refIds =
    asset.referenceAssetIds ??
    (asset.referenceAssetId ? [asset.referenceAssetId] : null) ??
    apiConfig.referenceAssetIds ??
    (apiConfig.referenceAssetId ? [apiConfig.referenceAssetId] : null);
  if (refIds && refIds.length) {
    body.type = 'img2img';
    body.referenceImages = refIds;
  }

  const res = await fetch(
    `${apiConfig.baseUrl}/generate/custom/${apiConfig.modelId}`,
    {
      method:  'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Submit failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.job.jobId;
}

async function pollJob(jobId, auth) {
  const url      = `${apiConfig.baseUrl}/jobs/${jobId}`;
  const interval = apiConfig.pollIntervalMs ?? 3000;
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min ceiling

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));

    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Poll failed ${res.status}: ${text}`);
    }

    const { job } = await res.json();
    process.stdout.write(`    polling… status=${job.status}   \r`);

    if (job.status === 'success') {
      process.stdout.write('\n');
      return job;
    }
    if (job.status === 'failure' || job.status === 'canceled') {
      process.stdout.write('\n');
      const err = job.metadata?.error ?? 'unknown error';
      const hint = job.metadata?.hint ?? '';
      throw new Error(`Job ${job.status}: ${err}${hint ? ' — ' + hint : ''}`);
    }
  }

  throw new Error(`Job ${jobId} timed out after 10 minutes`);
}

async function fetchAssetUrl(assetId, auth) {
  const res = await fetch(`${apiConfig.baseUrl}/assets/${assetId}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Asset fetch failed ${res.status}`);
  const { asset } = await res.json();
  return asset.url;
}

async function downloadImage(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

// Photoroom replaced the deprecated bria-remove-background model on Scenario.
// Same request shape: POST /generate/custom/{modelId} with {image: assetId | dataUrl}.
const REMOVE_BG_MODEL = 'model_photoroom-background-removal';

async function removeBackground(assetId, auth) {
  const res = await fetch(
    `${apiConfig.baseUrl}/generate/custom/${REMOVE_BG_MODEL}`,
    {
      method:  'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify({ image: assetId }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Remove-bg submit failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  const job = await pollJob(data.job.jobId, auth);
  const resultIds = job.metadata?.assetIds ?? [];
  if (!resultIds.length) throw new Error('Remove-bg returned no assets');
  return resultIds[0];
}

// ── Unit portrait post-process ───────────────────────────────────────────────
// Assumes the image already has a transparent background (bria-remove-background
// is run before this step). Composites in three layers so the character's head
// and shoulders overlap the top of the border ring — the "popping out of the
// frame" effect:
//
//   1. light-grey disc                 (inside of the circle)
//   2. gradient-stroked border ring    (warm highlight → dark shadow, top→bottom)
//   3. character cutout on top         (transparent bg lets ring show through
//                                       except where the body is, producing the
//                                       overlap)
//
// The ring is shifted down slightly so the head naturally lands above its top
// edge. Anything of the character that falls outside the ring is kept visible.

const PORTRAIT_BORDER      = 84;        // ring thickness in px (at source resolution)
const PORTRAIT_BUFFER_PX   = 30;        // transparent buffer between the ring and the
                                        // canvas edge. The top half of this buffer is
                                        // where the head/shoulders can extend above the
                                        // ring. Fixed buffer + centered ring means the
                                        // image center == circle center, so downstream
                                        // code can treat the PNG as a centered icon.
const PORTRAIT_DISC_COLOR  = '#bdb5a4'; // warm light grey inside the ring
const PORTRAIT_RING_TOP    = '#7a6a4c'; // muted bronze highlight (subtle)
const PORTRAIT_RING_BOTTOM = '#1c100a'; // near-black shadow (bottom of frame)

async function applyCirclePortraitBorder(srcPath, dstPath = srcPath) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('  [warn] sharp not installed — skipping portrait border');
    return;
  }

  const buffer = PORTRAIT_BUFFER_PX;
  const meta   = await sharp(srcPath).metadata();
  const src    = Math.min(meta.width, meta.height);

  // Output canvas is source + buffer on all four sides. Ring is centered in
  // the canvas, outer edge sits exactly `buffer` from the canvas edge.
  const out     = src + 2 * buffer;
  const cx      = out / 2;
  const cy      = out / 2;
  const r       = src / 2;                      // == out/2 - buffer
  const strokeR = r - PORTRAIT_BORDER / 2;
  const cutoff  = Math.round(cy);               // horizontal midline of ring

  // Squared, alpha-guaranteed cutout of the character.
  const cutoutSquare = await sharp(srcPath)
    .resize(src, src, { fit: 'cover', position: 'centre' })
    .ensureAlpha()
    .png()
    .toBuffer();

  // Find the tight bounding box of the non-transparent pixels. We scale the
  // box to fill the "character zone" — canvas top (so the head occupies the
  // pop-out buffer) down to the ring's bottom arc — which keeps half-body
  // and full-body portraits looking equally full in the disc instead of
  // leaving empty space below waist-up crops.
  const alpha = await sharp(cutoutSquare)
    .extractChannel('alpha')
    .raw()
    .toBuffer();
  let bboxTop = src, bboxBottom = -1, bboxLeft = src, bboxRight = -1;
  for (let y = 0; y < src; y++) {
    const row = y * src;
    for (let x = 0; x < src; x++) {
      if (alpha[row + x] > 10) {
        if (y < bboxTop)    bboxTop = y;
        if (y > bboxBottom) bboxBottom = y;
        if (x < bboxLeft)   bboxLeft = x;
        if (x > bboxRight)  bboxRight = x;
      }
    }
  }
  const bboxW = bboxRight - bboxLeft + 1;
  const bboxH = bboxBottom - bboxTop + 1;

  // Target zone: full canvas width × from canvas top (y=0, pop-out starts) to
  // ring's bottom edge (y = out - buffer). We scale to fit the target zone,
  // limited by whichever axis maxes out first.
  const targetH = out - buffer;           // y = 0 … ring bottom
  const targetW = out;                    // full canvas width
  const scale = Math.min(targetH / bboxH, targetW / bboxW);
  const scaledW = Math.round(bboxW * scale);
  const scaledH = Math.round(bboxH * scale);

  // Extract the tight bbox and scale it.
  const scaled = await sharp(cutoutSquare)
    .extract({ left: bboxLeft, top: bboxTop, width: bboxW, height: bboxH })
    .resize(scaledW, scaledH, { kernel: 'lanczos3' })
    .png()
    .toBuffer();

  // Place scaled cutout: horizontally centered, anchored at canvas top.
  const placeX = Math.round((out - scaledW) / 2);
  const cutoutCanvas = await sharp({
    create: { width: out, height: out, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: scaled, left: placeX, top: 0 }])
    .png()
    .toBuffer();

  // SVG layers sized to the padded canvas.
  const svg = inner =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${out}" height="${out}">${inner}</svg>`);

  const discSvg = svg(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PORTRAIT_DISC_COLOR}"/>`);
  const ringSvg = svg(
    `<defs><linearGradient id="frame" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0%" stop-color="${PORTRAIT_RING_TOP}"/>` +
      `<stop offset="100%" stop-color="${PORTRAIT_RING_BOTTOM}"/>` +
    `</linearGradient></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${strokeR}" fill="none" ` +
    `stroke="url(#frame)" stroke-width="${PORTRAIT_BORDER}"/>`
  );
  const circleMask      = svg(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="white"/>`);
  const aboveCutoffMask = svg(`<rect x="0" y="0" width="${out}" height="${cutoff}" fill="white"/>`);
  const belowCutoffMask = svg(`<rect x="0" y="${cutoff}" width="${out}" height="${out - cutoff}" fill="white"/>`);

  // Character above the midline — drawn on top of ring (head/shoulders pop out).
  const topChar = await sharp(cutoutCanvas)
    .composite([{ input: aboveCutoffMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // Character below the midline — clipped to disc, drawn behind ring.
  const bottomChar = await sharp(cutoutCanvas)
    .composite([
      { input: circleMask,      blend: 'dest-in' },
      { input: belowCutoffMask, blend: 'dest-in' },
    ])
    .png()
    .toBuffer();

  const composed = await sharp({
    create: { width: out, height: out, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: discSvg },
      { input: bottomChar },
      { input: ringSvg },
      { input: topChar },
    ])
    .png()
    .toBuffer();

  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, composed);
}

// Local background removal via edge flood-fill + morphological opening.
//
// 1. Flood-fill bg from edges with strict tolerance (connected component only).
// 2. Morphological opening (erode → dilate) on the bg mask to kill thin
//    bg-coloured tendrils that flood through fabric grunge / cracks and
//    would otherwise hollow out character interiors.
// 3. Apply as HARD binary alpha (0 or 255) — no partial-alpha feather band,
//    so the original character RGB is never mixed with bg-tinted fringe
//    pixels when later composited onto the disc (this was the "halo" bug).
// 4. Blur the alpha channel only (RGB untouched) to anti-alias the cutout
//    edge without reintroducing bg colour contamination.
async function removeFlatBackgroundLocal(imgPath) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('  [warn] sharp not installed — skipping bg removal');
    return;
  }

  const TOLERANCE      = 30;  // strict bg colour-distance threshold
  const OPEN_ITERS     = 3;   // erode/dilate passes — kills tendrils up to ~3 px wide

  const { data, info } = await sharp(imgPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const N = W * H;

  const samplePoints = [
    [0, 0], [W >> 1, 0], [W - 1, 0],
    [0, H >> 1], [W - 1, H >> 1],
    [0, H - 1], [W >> 1, H - 1], [W - 1, H - 1],
  ];
  const samples = samplePoints.map(([x, y]) => {
    const i = (y * W + x) * C;
    return [data[i], data[i + 1], data[i + 2]];
  });

  const isBg = (r, g, b) => {
    const t2 = TOLERANCE * TOLERANCE;
    for (let s = 0; s < samples.length; s++) {
      const dr = r - samples[s][0], dg = g - samples[s][1], db = b - samples[s][2];
      if (dr * dr + dg * dg + db * db < t2) return true;
    }
    return false;
  };

  // ── Flood-fill BG mask from edges ────────────────────────────────────────
  let mask = new Uint8Array(N);  // 1 = bg
  const queue = [];
  const trySeed = (x, y) => {
    const pi = y * W + x;
    if (mask[pi]) return;
    const i = pi * C;
    if (isBg(data[i], data[i + 1], data[i + 2])) {
      mask[pi] = 1;
      queue.push(pi);
    }
  };
  for (let x = 0; x < W; x++) { trySeed(x, 0); trySeed(x, H - 1); }
  for (let y = 0; y < H; y++) { trySeed(0, y); trySeed(W - 1, y); }

  while (queue.length) {
    const pi = queue.pop();
    const x = pi % W;
    const y = (pi - x) / W;
    const check = (npi) => {
      if (mask[npi]) return;
      const ni = npi * C;
      if (isBg(data[ni], data[ni + 1], data[ni + 2])) {
        mask[npi] = 1;
        queue.push(npi);
      }
    };
    if (x > 0)     check(pi - 1);
    if (x < W - 1) check(pi + 1);
    if (y > 0)     check(pi - W);
    if (y < H - 1) check(pi + W);
  }

  // ── Morphological opening on BG mask (erode × N, then dilate × N) ───────
  // Edges of the canvas are always treated as bg for erosion so we don't
  // gouge the true canvas border.
  const erode = (src) => {
    const dst = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!src[p]) continue;
        if (x === 0 || x === W - 1 || y === 0 || y === H - 1) { dst[p] = 1; continue; }
        if (src[p - 1] && src[p + 1] && src[p - W] && src[p + W]) dst[p] = 1;
      }
    }
    return dst;
  };
  const dilate = (src) => {
    const dst = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (src[p]) { dst[p] = 1; continue; }
        if ((x > 0     && src[p - 1]) ||
            (x < W - 1 && src[p + 1]) ||
            (y > 0     && src[p - W]) ||
            (y < H - 1 && src[p + W])) dst[p] = 1;
      }
    }
    return dst;
  };
  for (let i = 0; i < OPEN_ITERS; i++) mask = erode(mask);
  for (let i = 0; i < OPEN_ITERS; i++) mask = dilate(mask);

  // ── Hard binary alpha, then 3×3 box blur on alpha (RGB untouched) ───────
  const hardAlpha = new Uint8Array(N);
  for (let p = 0; p < N; p++) hardAlpha[p] = mask[p] ? 0 : 255;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          sum += hardAlpha[ny * W + nx];
          cnt++;
        }
      }
      data[(y * W + x) * C + 3] = Math.round(sum / cnt);
    }
  }

  await sharp(data, { raw: { width: W, height: H, channels: C } }).png().toFile(imgPath);
}

// Upload an existing local image to Scenario, run bg-removal, download the
// transparent cutout back to the same path. Used by --postprocess-only so we
// can re-do the border/overlap pass on files that have a baked-in background.
async function bgRemoveExistingFile(imgPath, auth) {
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(imgPath).toString('base64');
  const res = await fetch(
    `${apiConfig.baseUrl}/generate/custom/${REMOVE_BG_MODEL}`,
    {
      method:  'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify({ image: dataUrl }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Remove-bg submit failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  const job = await pollJob(data.job.jobId, auth);
  const resultIds = job.metadata?.assetIds ?? [];
  if (!resultIds.length) throw new Error('Remove-bg returned no assets');
  const imageUrl = await fetchAssetUrl(resultIds[0], auth);
  await downloadImage(imageUrl, imgPath);
}

async function generateAsset(asset, auth) {
  const dest = assetPath(asset);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest)) {
    console.log(`  ↩ skip   ${path.relative(ROOT, dest)}  (already exists)`);
    return dest;
  }

  const jobId = await submitJob(asset, auth);
  console.log(`  ✦ poll   ${asset.id}  →  ${jobId}`);

  const job = await pollJob(jobId, auth);

  const assetIds = job.metadata?.assetIds ?? [];
  if (!assetIds.length) throw new Error(`No assets returned for ${asset.id}`);

  let finalAssetId = assetIds[0];

  // Buildings and units: remove background on the Scenario side. Passing the
  // generated asset ID keeps the payload small (no re-upload) and uses the
  // bria model which handles edges better than a local chroma-key.
  if (asset.category === 'building' || asset.category === 'unit') {
    console.log(`  ✂ removing background…`);
    try {
      finalAssetId = await removeBackground(finalAssetId, auth);
    } catch (err) {
      if (asset.category === 'unit') {
        console.warn(`  [warn] scenario bg-remove failed (${err.message}); falling back to local chroma-key`);
        finalAssetId = null;  // signal: use local
      } else {
        throw err;
      }
    }
  }

  if (asset.category === 'unit') {
    const rawDest = unitRawPath(asset);
    fs.mkdirSync(path.dirname(rawDest), { recursive: true });

    if (finalAssetId) {
      const imageUrl = await fetchAssetUrl(finalAssetId, auth);
      await downloadImage(imageUrl, rawDest);
    } else {
      // Fallback: download original + local chroma-key
      const imageUrl = await fetchAssetUrl(assetIds[0], auth);
      await downloadImage(imageUrl, rawDest);
      console.log(`  ✂ removing flat background (local)…`);
      await removeFlatBackgroundLocal(rawDest);
    }

    console.log(`  ◯ circle+border post-process…`);
    await applyCirclePortraitBorder(rawDest, dest);

    console.log(`  ✔ saved  ${path.relative(ROOT, rawDest)}`);
    console.log(`  ✔ saved  ${path.relative(ROOT, dest)}`);
  } else {
    const imageUrl = await fetchAssetUrl(finalAssetId, auth);
    await downloadImage(imageUrl, dest);
    console.log(`  ✔ saved  ${path.relative(ROOT, dest)}`);
  }

  return dest;
}

// ── Tilemap stitch ────────────────────────────────────────────────────────────

async function stitchTilemap(assets) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('\n[warn] sharp not installed — skipping tilemap stitch.');
    console.warn('       Run: npm install --save-dev sharp\n');
    return;
  }

  const CELL    = 256;  // normalise everything to this cell size
  const GAP     = 6;
  const COLS    = 7;
  const LABEL_H = 30;
  const BG      = { r: 0, g: 0, b: 0, alpha: 0 };  // transparent

  const groups = [
    { label: 'Tiles',     items: assets.filter(a => a.category === 'tile')     },
    { label: 'Buildings', items: assets.filter(a => a.category === 'building') },
    { label: 'Units',     items: assets.filter(a => a.category === 'unit')     },
    { label: 'Icons',     items: assets.filter(a => a.category === 'icon')     },
  ].filter(g => g.items.length > 0);

  // Calculate canvas dimensions
  const W = COLS * (CELL + GAP) + GAP;
  let H = GAP;
  for (const g of groups) {
    H += LABEL_H + GAP;
    H += Math.ceil(g.items.length / COLS) * (CELL + GAP);
  }

  const composites = [];
  let y = GAP;

  for (const group of groups) {
    // Category label via SVG
    composites.push({
      input: Buffer.from(
        `<svg width="${W}" height="${LABEL_H}">` +
        `<rect width="${W}" height="${LABEL_H}" fill="#1a1025" rx="3"/>` +
        `<text x="10" y="21" font-family="monospace" font-size="14" font-weight="bold" fill="#c8a96e">${group.label} (${group.items.length})</text>` +
        `</svg>`
      ),
      top:  y,
      left: 0,
    });
    y += LABEL_H + GAP;

    for (let i = 0; i < group.items.length; i++) {
      const asset = group.items[i];
      const col   = i % COLS;
      const row   = Math.floor(i / COLS);
      const x     = GAP + col * (CELL + GAP);
      const cellY = y + row * (CELL + GAP);

      const imgPath = assetPath(asset);
      if (!fs.existsSync(imgPath)) {
        console.warn(`  [warn] missing ${path.relative(ROOT, imgPath)} — placeholder used`);
        // Grey placeholder
        const placeholder = await sharp({
          create: { width: CELL, height: CELL, channels: 4, background: { r: 40, g: 40, b: 50, alpha: 1 } },
        }).png().toBuffer();
        composites.push({ input: placeholder, top: cellY, left: x });
        continue;
      }

      const cell = await sharp(imgPath)
        .ensureAlpha()
        .resize(CELL, CELL, { fit: 'cover' })
        .png()
        .toBuffer();
      composites.push({ input: cell, top: cellY, left: x });
    }

    y += Math.ceil(group.items.length / COLS) * (CELL + GAP);
  }

  await sharp({ create: { width: W, height: H, channels: 4, background: BG } })
    .png()
    .composite(composites)
    .toFile(OUT_PATH);

  console.log(`\nTilemap → ${path.relative(ROOT, OUT_PATH)}  (${W}×${H}px)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const assets = selectAssets();

  console.log(`\nBrimstone asset generator`);
  console.log(`  model    : ${apiConfig.modelId}`);
  console.log(`  assets   : ${assets.length}  (${[...new Set(assets.map(a => a.category))].join(', ')})`);
  console.log(`  dry run  : ${DRY_RUN}`);
  console.log(`  test mode: ${TEST_MODE}`);
  console.log(`  output   : ${path.relative(ROOT, OUT_PATH)}`);
  console.log();

  // ── Dry run ────────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    for (const a of assets) {
      const p = { ...apiConfig.defaultParameters, ...a.parameters };
      console.log(`[${a.category.padEnd(8)}] ${a.id}`);
      const ref = a.referenceAssetId ?? apiConfig.referenceAssetId;
      console.log(`  POST ${apiConfig.baseUrl}/generate/custom/${apiConfig.modelId}`);
      console.log(`  ${p.width}×${p.height}${ref ? '  ref=' + ref : ''}`);
      console.log(`  prompt: ${p.prompt.slice(0, 100)}…`);
      console.log();
    }
    return;
  }

  // ── Remove background only ────────────────────────────────────────────────
  if (REMOVE_BG_ONLY) {
    const auth = makeAuthHeader();
    const buildings = assets.filter(a => a.category === 'building');
    console.log(`\nRemoving backgrounds from ${buildings.length} building assets…`);
    for (const asset of buildings) {
      const imgPath = assetPath(asset);
      if (!fs.existsSync(imgPath)) {
        console.log(`  ⊘ skip   ${asset.id}.png  (not found)`);
        continue;
      }
      // Upload the existing image as a data URL
      const dataUrl = 'data:image/png;base64,' + fs.readFileSync(imgPath).toString('base64');
      console.log(`  ✂ ${asset.id}…`);
      const res = await fetch(
        `${apiConfig.baseUrl}/generate/custom/${REMOVE_BG_MODEL}`,
        {
          method:  'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
          body:    JSON.stringify({ image: dataUrl }),
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`  ✗ failed ${res.status}: ${text}`);
        continue;
      }
      const data = await res.json();
      const job = await pollJob(data.job.jobId, auth);
      const resultIds = job.metadata?.assetIds ?? [];
      if (!resultIds.length) { console.error(`  ✗ no result for ${asset.id}`); continue; }
      const imageUrl = await fetchAssetUrl(resultIds[0], auth);
      await downloadImage(imageUrl, imgPath);
      console.log(`  ✔ saved  ${asset.id}.png`);
    }
    // Stitch after removing backgrounds
    console.log(`\nStitching ${config.assets.length} assets into tilemap…`);
    await stitchTilemap(config.assets);
    return;
  }

  // ── Post-process only ─────────────────────────────────────────────────────
  // Re-applies the circle/border composite to the preserved raw unit cutouts
  // so we can retune the frame without paying for fresh character generation.
  // Reads units-raw/<id>.png, writes units/<id>.png.
  if (POSTPROCESS_ONLY) {
    const units = assets.filter(a => a.category === 'unit');
    console.log(`\nRe-applying circle/border to ${units.length} unit portraits…`);
    for (const asset of units) {
      const rawPath = unitRawPath(asset);
      const outPath = assetPath(asset);
      if (!fs.existsSync(rawPath)) {
        console.log(`  ⊘ skip   ${asset.id}  (no raw cutout at ${path.relative(ROOT, rawPath)})`);
        continue;
      }
      console.log(`  ◯ ${asset.id} — circle+border composite…`);
      await applyCirclePortraitBorder(rawPath, outPath);
    }
    console.log(`\nStitching ${config.assets.length} assets into tilemap…`);
    await stitchTilemap(config.assets);
    return;
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  if (!STITCH_ONLY) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const auth = makeAuthHeader();
    let done = 0;

    for (const asset of assets) {
      console.log(`\n[${++done}/${assets.length}] [${asset.category}] ${asset.id}`);
      await generateAsset(asset, auth);
    }
  }

  // ── Stitch ─────────────────────────────────────────────────────────────────
  // Stitch when: stitch-only flag, or we generated more than one asset
  const shouldStitch = STITCH_ONLY || (!FILTER_ID && assets.length > 1);
  if (shouldStitch) {
    const stitchAssets = STITCH_ONLY ? config.assets : assets;
    console.log(`\nStitching ${stitchAssets.length} assets into tilemap…`);
    await stitchTilemap(stitchAssets);
  }
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
