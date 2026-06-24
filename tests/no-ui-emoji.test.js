// Guard: no color emoji in player-facing UI source.
//
// The game uses a monochrome icon font (BrimstoneIcons, U+E000–E0FF) instead of
// color emoji — see scripts/icon-manifest.mjs + src/icons.js and the CLAUDE.md
// "No emoji in the UI" rule. Color emoji render inconsistently across platforms
// (and as full-color glyphs on iOS/Android even for BMP symbols like ⚔ ☀ ⛪), so
// this test fails if any creep back into a UI string. Use ICON.x (or a \uE0xx
// escape / &#xE0xx; entity / \eXXXX CSS escape) instead.
//
// Emoji are allowed in: code comments (descriptive), tests, scripts, docs, the
// admin tools, and src/icons.js (the EMOJI_TO_ICON migration map).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Codepoint ranges that render as color emoji on at least one shipping platform.
// (Excludes plain arrows/box-drawing/geometric shapes, which stay monochrome.)
const isColorEmoji = (cp) =>
  (cp >= 0x1F000 && cp <= 0x1FAFF) ||  // supplementary pictographs
  (cp >= 0x2600 && cp <= 0x27BF) ||    // misc symbols + dingbats (color on mobile)
  (cp >= 0x2300 && cp <= 0x23FF) ||    // media/technical (⏩ ⏸ ⏳ …)
  (cp >= 0x2B00 && cp <= 0x2BFF) ||    // misc symbols & arrows (⬡ ⭕ …)
  // A couple of "Geometric Shapes" have an emoji presentation and render as
  // full-color glyphs on iOS/Android: ▶ (play) and ◀ (reverse). Use ICON.play
  // instead. (The rest of the block — ◆ ◇ pips, ▸ — stays monochrome.)
  cp === 0x25B6 || cp === 0x25C0;

// Strip comments so descriptive emoji in comments don't trip the guard. Handles
// /* */ and <!-- --> (all file types) and // line comments (.js only). Does NOT
// track strings, so it can't desync on a regex literal containing a quote.
function stripComments(src, isJs) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  if (isJs) s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // keep ":" so `http://` survives
  return s;
}

// A color emoji written as a JS escape — `\u{1F4A2}` or a `💢` surrogate
// pair — has no actual emoji codepoint in the file bytes, so the raw-character scan
// below sails right past it (this is exactly how `\u{1F4A2}` slipped into
// wrapup-summary.js). Decode supplementary-plane escapes (cp >= 0x1F000, the
// pictograph/emoji planes — and the *only* form for which a `\u` escape can never
// be a legitimate BMP glyph) back into their literal codepoint so the scanner sees
// them. We deliberately do NOT decode BMP escapes (⛌, ✓, ▶ …): those have
// non-emoji uses and stay readable as escapes; only the unambiguous astral emoji
// are un-hidden here. Keeps line numbers intact (no newlines introduced).
function decodeAstralEmojiEscapes(src) {
  // \u{1Fxxxx} braced form.
  let s = src.replace(/\\u\{([0-9A-Fa-f]{4,6})\}/g, (m, hex) => {
    const cp = parseInt(hex, 16);
    return cp >= 0x1F000 ? String.fromCodePoint(cp) : m;
  });
  // \uD8xx\uDCxx surrogate-pair form → astral codepoint.
  s = s.replace(/\\u(D[89AB][0-9A-Fa-f]{2})\\u(D[C-Fc-f][0-9A-Fa-f]{2})/g, (m, hi, lo) => {
    const cp = (parseInt(hi, 16) - 0xD800) * 0x400 + (parseInt(lo, 16) - 0xDC00) + 0x10000;
    return cp >= 0x1F000 ? String.fromCodePoint(cp) : m;
  });
  return s;
}

// Internal authoring tools (the mission editor / admin) are not player-facing UI
// and may use emoji freely — same carve-out as admin.html / admin-tools.html.
const SKIP_DIRS = new Set(['tools']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { yield* walk(p); } else { yield p; }
  }
}

test('no color emoji in player-facing UI source (use the BrimstoneIcons font)', () => {
  const targets = [
    ...walk(join(ROOT, 'src')),
    ...walk(join(ROOT, 'server')),
    join(ROOT, 'index.html'),
    join(ROOT, 'styles.css'),
    join(ROOT, 'styles-ledger.css'),
  ].filter(p => /\.(js|json|html|css)$/.test(p));

  const ALLOW = new Set(['src/icons.js']); // the EMOJI_TO_ICON migration map
  const offenders = [];

  for (const file of targets) {
    const rel = relative(ROOT, file);
    if (ALLOW.has(rel)) continue;
    const isJs = file.endsWith('.js');
    const lines = decodeAstralEmojiEscapes(stripComments(readFileSync(file, 'utf8'), isJs)).split('\n');
    lines.forEach((ln, i) => {
      for (const ch of ln) {
        const cp = ch.codePointAt(0);
        if (isColorEmoji(cp)) {
          offenders.push(`${rel}:${i + 1}  ${ch} (U+${cp.toString(16).toUpperCase()})  ${ln.trim().slice(0, 60)}`);
          break;
        }
      }
    });
  }

  assert.deepEqual(offenders, [],
    `Color emoji found in UI source — replace with ICON.<name> (src/icons.js):\n  ${offenders.join('\n  ')}`);
});
