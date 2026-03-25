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
const CONFIG_PATH = path.join(ROOT, 'assets', 'image-list.json');
const OUT_DIR     = path.join(ROOT, 'assets', 'generated');

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function flag(...names)  { return names.some(n => argv.includes(n)); }
function argVal(name)    { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] ?? null : null; }

const DRY_RUN     = flag('--dry-run', '-d');
const TEST_MODE   = flag('--test',    '-t');
const STITCH_ONLY = flag('--stitch-only');
const FILTER_CAT  = argVal('--category');
const FILTER_ID   = argVal('--id');
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

async function submitInference(asset, auth) {
  const params = {
    ...apiConfig.defaultParameters,
    ...asset.parameters,
  };

  const res = await fetch(
    `${apiConfig.baseUrl}/models/${apiConfig.modelId}/inferences`,
    {
      method:  'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify({ parameters: params }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Submit failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.inference.id;
}

async function pollInference(inferenceId, auth) {
  const url      = `${apiConfig.baseUrl}/models/${apiConfig.modelId}/inferences/${inferenceId}`;
  const interval = apiConfig.pollIntervalMs ?? 3000;
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min ceiling

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));

    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Poll failed ${res.status}: ${body}`);
    }

    const { inference } = await res.json();
    process.stdout.write(`    polling… status=${inference.status}   \r`);

    if (inference.status === 'succeeded') {
      process.stdout.write('\n');
      return inference;
    }
    if (inference.status === 'failed' || inference.status === 'canceled') {
      process.stdout.write('\n');
      throw new Error(`Inference ended with status "${inference.status}"`);
    }
  }

  throw new Error(`Inference ${inferenceId} timed out after 10 minutes`);
}

async function downloadImage(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

async function generateAsset(asset, auth) {
  const dest = path.join(OUT_DIR, `${asset.id}.png`);

  if (fs.existsSync(dest)) {
    console.log(`  ↩ skip   ${asset.id}.png  (already exists)`);
    return dest;
  }

  const inferenceId = await submitInference(asset, auth);
  console.log(`  ✦ poll   ${asset.id}  →  ${inferenceId}`);

  const inference = await pollInference(inferenceId, auth);

  const imageUrl = inference.images?.[0]?.url;
  if (!imageUrl) throw new Error(`No image URL in result for ${asset.id}`);

  await downloadImage(imageUrl, dest);
  console.log(`  ✔ saved  ${path.relative(ROOT, dest)}`);
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
  const BG      = { r: 13, g: 17, b: 23, alpha: 1 };  // #0d1117

  const groups = [
    { label: 'Tiles',     items: assets.filter(a => a.category === 'tile')     },
    { label: 'Buildings', items: assets.filter(a => a.category === 'building') },
    { label: 'Units',     items: assets.filter(a => a.category === 'unit')     },
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

      const imgPath = path.join(OUT_DIR, `${asset.id}.png`);
      if (!fs.existsSync(imgPath)) {
        console.warn(`  [warn] missing ${asset.id}.png — placeholder used`);
        // Grey placeholder
        const placeholder = await sharp({
          create: { width: CELL, height: CELL, channels: 4, background: { r: 40, g: 40, b: 50, alpha: 1 } },
        }).png().toBuffer();
        composites.push({ input: placeholder, top: cellY, left: x });
        continue;
      }

      const cell = await sharp(imgPath).resize(CELL, CELL, { fit: 'contain', background: BG }).png().toBuffer();
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
      console.log(`  POST ${apiConfig.baseUrl}/models/${apiConfig.modelId}/inferences`);
      console.log(`  ${p.width}×${p.height}  steps=${p.numInferenceSteps}  guidance=${p.guidance}`);
      console.log(`  prompt: ${p.prompt.slice(0, 100)}…`);
      console.log();
    }
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
