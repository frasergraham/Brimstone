// Tests for mobile responsiveness rules across all pages.
// Verifies that mobile media queries exist and cover key elements
// that would otherwise overflow on phone screens (~375px).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const stylesCSS = readFileSync(resolve(root, 'styles.css'), 'utf8');

// Helper: extract the CSS inside EVERY media block matching the @media line,
// concatenated, by collecting balanced braces. A stylesheet may legitimately
// declare the same breakpoint more than once (e.g. a component-local block
// kept next to its component's desktop rules), so reading only the first
// occurrence would miss rules that live in later blocks.
function extractMediaBlock(css, mediaQuery) {
  let out = '';
  let idx = css.indexOf(mediaQuery);
  while (idx !== -1) {
    const start = css.indexOf('{', idx);
    if (start === -1) break;
    let depth = 1;
    let i = start + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out += css.slice(start + 1, i - 1) + '\n';
    idx = css.indexOf(mediaQuery, i);
  }
  return out;
}

// ── styles.css — main game mobile rules ──────────────────────────────────────

describe('styles.css mobile breakpoint (max-width: 700px)', () => {
  const block = extractMediaBlock(stylesCSS, '@media (max-width: 700px)');

  test('media block exists', () => {
    assert.ok(block.length > 0, 'Expected @media (max-width: 700px) block');
  });

  test('how-to-play two-column stacks to single column', () => {
    assert.ok(block.includes('.htp-two-col'), 'Missing .htp-two-col rule');
    assert.ok(block.includes('grid-template-columns'), 'Missing grid-template-columns override');
  });

  test('how-to-play table allows text wrapping', () => {
    assert.ok(block.includes('.htp-table'), 'Missing .htp-table rule');
    assert.ok(block.includes('white-space'), 'Missing white-space override');
  });

  test('round-summary-card capped to viewport width', () => {
    assert.ok(block.includes('.round-summary-card'), 'Missing .round-summary-card rule');
    assert.ok(block.includes('90vw'), 'Missing vw cap for round-summary-card');
  });

  test('phase-modal-card capped to viewport width', () => {
    assert.ok(block.includes('.phase-modal-card'), 'Missing .phase-modal-card rule');
  });

  test('encounter-card min-width removed on mobile', () => {
    assert.ok(block.includes('#encounter-card'), 'Missing #encounter-card rule');
  });

  test('game-menu-btn has 44px touch target', () => {
    assert.ok(block.includes('.game-menu-btn'), 'Missing .game-menu-btn rule');
    assert.ok(block.includes('44px'), 'Missing 44px min-height');
  });
});
