// Guard: no raw rem font-size literals in player-facing UI — use the type scale.
//
// styles.css defines a single type scale as CSS custom properties on :root
// (--fs-2xs … --fs-2xl). Every `font-size` in the player-facing UI must
// reference one of those tokens (`var(--fs-…)`) instead of a hand-set rem
// literal, so density can be tuned in one place and never re-fragments into the
// ~470 ad-hoc values it grew into. See CLAUDE.md and the :root "Type scale" block.
//
// Allowed (NOT flagged): `var(--fs-…)`; `px` literals (the 14px base + mobile
// base, dev/debug overlays like #fps-counter and .cmd-console, touch-button
// glyph sizing like .zoom-btn); `em`/`%` (parent-relative, intentional).
// Canvas text (`ctx.font = '12px …'`) never uses the `font-size:` property, so
// it is unaffected. Carve-outs below mirror the no-ui-emoji guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

// Player-facing UI surfaces. Admin/tools HTML and editor JS are carved out
// (same rationale as the emoji guard); they aren't shipped game UI.
const FILES = ['styles.css', 'src/main.js', 'src/ui.js', 'index.html'];

// Strip CSS/HTML block comments so a "0.75rem" mentioned in a comment (e.g. the
// token table) can't trip the regex.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');

// A `font-size` value that is a bare rem literal — the thing we forbid.
const RAW_REM = /font-size:\s*[\d.]+rem/g;

test('no raw rem font-size literals — use the --fs-* type scale tokens', () => {
  const offenders = [];
  for (const rel of FILES) {
    const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (RAW_REM.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
      RAW_REM.lastIndex = 0;
    });
  }
  assert.equal(
    offenders.length,
    0,
    `Raw rem font-size literals found — replace with a var(--fs-*) token:\n` +
      offenders.join('\n'),
  );
});
