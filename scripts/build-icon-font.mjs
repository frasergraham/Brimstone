// Builds assets/fonts/brimstone-icons.{woff2,ttf} from the icon manifest, pulling
// SVG paths out of @iconify-json/game-icons. Run: node scripts/build-icon-font.mjs
//
// The woff2/ttf are COMMITTED artifacts; this only re-runs when the manifest's art
// (`gi`) or codepoints change. Requires devDeps: @iconify-json/game-icons, fantasticon.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { generateFonts } from 'fantasticon';
import { ICONS } from './icon-manifest.mjs';

const require = createRequire(import.meta.url);
const giData = require('@iconify-json/game-icons/icons.json');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = giData.width || 512, H = giData.height || 512;

// Fallback glyph for any art id that can't be resolved (a hollow box) — keeps the
// build green and is obvious on screen so it gets noticed.
const FALLBACK = `<path d="M64 64h384v384H64z" fill="none" stroke="#000" stroke-width="32"/>`;

const tmp = mkdtempSync(join(tmpdir(), 'brimstone-icons-'));
const codepoints = {};
const misses = [];
for (const it of ICONS) {
  const key = (it.gi || '').split('/').pop();      // iconify keys drop the author prefix
  const entry = key && giData.icons[key];
  if (!entry) misses.push(`${it.name} (${it.gi})`);
  const body = entry ? entry.body : FALLBACK;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`
            + `<g fill="#000">${body}</g></svg>`;
  writeFileSync(join(tmp, `${it.name}.svg`), svg);
  codepoints[it.name] = it.code;
}

const outDir = join(root, 'assets/fonts');
mkdirSync(outDir, { recursive: true });

await generateFonts({
  name: 'brimstone-icons',
  inputDir: tmp,
  outputDir: outDir,
  fontTypes: ['woff2', 'ttf'],
  assetTypes: ['json'],          // emits brimstone-icons.json (name→codepoint) for auditing
  codepoints,
  normalize: true,
  fontHeight: 1000,
  formatOptions: { json: { indent: 2 } },
});

rmSync(tmp, { recursive: true, force: true });

console.log(`\nBuilt brimstone-icons.woff2 + .ttf (${ICONS.length} glyphs) → assets/fonts/`);
if (misses.length) {
  console.log(`\n⚠ ${misses.length} icon(s) fell back to a placeholder box — fix the \`gi\` id in the manifest:`);
  misses.forEach(m => console.log('   ' + m));
} else {
  console.log('All art ids resolved against @iconify-json/game-icons. ✓');
}
for (const f of ['brimstone-icons.woff2', 'brimstone-icons.ttf']) {
  const p = join(outDir, f);
  if (!existsSync(p)) throw new Error(`expected output missing: ${f}`);
}
