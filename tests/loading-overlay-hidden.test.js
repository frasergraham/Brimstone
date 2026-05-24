// Loading-overlay hidden contract — regression guard for the "overlay reappears
// after reveal and gets stuck" bug.
//
// The overlay is styled `#loading-overlay { display: flex }` — an ID selector
// (specificity 1,0,0) that BEATS the UA `[hidden] { display: none }` rule
// (specificity 0,1,0). Without an explicit ID+attribute override, setting
// `overlay.hidden = true` in _showLoadingAndReveal() does nothing: the moment
// the `.fading-out` class is removed, opacity snaps back to 1 and the overlay
// re-covers the just-revealed 3D scene (operator report: "world fades in, then
// it reappears for loading houses and gets stuck").
//
// This test reads styles.css and asserts the `#loading-overlay[hidden]`
// display:none rule is present so the hidden contract can't silently regress.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  fileURLToPath(new URL('../styles.css', import.meta.url)),
  'utf8',
);

// Strip /* … */ comments so prose mentioning "[hidden]" can't satisfy the match.
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('loading overlay hidden contract', () => {
  test('the base #loading-overlay rule sets display:flex (why the override is needed)', () => {
    const base = cssNoComments.match(/#loading-overlay\s*\{([^}]*)\}/);
    assert.ok(base, '#loading-overlay rule should exist');
    assert.match(
      base[1],
      /display\s*:\s*flex/,
      'base overlay should use display:flex (an ID selector that outranks [hidden])',
    );
  });

  test('#loading-overlay[hidden] forces display:none so the overlay can be hidden', () => {
    const rule = cssNoComments.match(/#loading-overlay\[hidden\]\s*\{([^}]*)\}/);
    assert.ok(
      rule,
      'missing `#loading-overlay[hidden]` rule — overlay.hidden=true would be a no-op '
      + 'against `#loading-overlay { display:flex }` and the overlay would reappear after reveal',
    );
    assert.match(
      rule[1],
      /display\s*:\s*none/,
      '#loading-overlay[hidden] must set display:none',
    );
  });
});
