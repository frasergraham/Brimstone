// Generates a visual contact sheet of every icon in the manifest, on the game's
// dark theme, at the woff2 we just built. Output: /tmp/brimstone-icon-sheet.html
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ICONS } from './icon-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const woff2 = 'file://' + join(root, 'assets/fonts/brimstone-icons.woff2');

const cell = it => {
  const chr = `&#x${it.code.toString(16)};`;
  const old = it.glyphs.length ? it.glyphs.join(' ') : '—';
  return `<div class="cell">
    <div class="ico">${chr}</div>
    <div class="name">${it.name}</div>
    <div class="old">${old}</div>
    <div class="gi">${it.gi.split('/').pop()}</div>
  </div>`;
};

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:BrimstoneIcons;src:url('${woff2}') format('woff2');}
:root{--bg:#14110d;--panel:#1d1812;--ink:#e8dcc0;--accent:#c9a227;--dim:#8a7a5c;}
*{box-sizing:border-box;margin:0;}
body{background:var(--bg);color:var(--ink);font-family:Georgia,serif;padding:28px;}
h1{color:var(--accent);font-size:22px;margin-bottom:4px;}
p.sub{color:var(--dim);margin-bottom:20px;font-size:13px;}
.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:10px;}
.cell{background:var(--panel);border:1px solid #2c241a;border-radius:8px;padding:12px 6px;text-align:center;}
.ico{font-family:BrimstoneIcons;font-size:38px;line-height:1;color:var(--ink);height:42px;}
.name{font-size:11px;color:var(--accent);margin-top:8px;word-break:break-word;}
.old{font-size:14px;color:var(--ink);margin-top:3px;}
.gi{font-size:9px;color:var(--dim);margin-top:2px;font-family:monospace;word-break:break-word;}
.tints{display:flex;gap:18px;align-items:center;margin:22px 0 6px;font-family:BrimstoneIcons;font-size:34px;}
.tints .h{color:#5b9bd5;} .tints .w{color:#c0392b;} .tints .g{color:var(--accent);} .tints .d{color:var(--dim);}
.lbl{font-family:Georgia,serif;font-size:12px;color:var(--dim);}
</style></head><body>
<h1>Brimstone monochrome icon set — ${ICONS.length} glyphs</h1>
<p class="sub">font: assets/fonts/brimstone-icons.woff2 · gold = ICON.name · white = old glyph it replaces · grey = game-icons source</p>
<div class="tints">
  <span class="lbl">tint test (one glyph, inherits color):</span>
  <span class="h">&#xE099;</span><span class="w">&#xE09A;</span>
  <span class="g">&#xE000;</span><span class="d">&#xE004;</span>
  <span class="g">&#xE042;</span><span class="g">&#xE014;</span><span class="g">&#xE066;</span>
</div>
<div class="grid">${ICONS.map(cell).join('')}</div>
</body></html>`;

const out = '/tmp/brimstone-icon-sheet.html';
writeFileSync(out, html);
console.log(out);
