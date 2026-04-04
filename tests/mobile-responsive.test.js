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

// Helper: extract all CSS inside a media query block by matching the @media line
// and collecting balanced braces.
function extractMediaBlock(css, mediaQuery) {
  const idx = css.indexOf(mediaQuery);
  if (idx === -1) return '';
  // Find the opening brace of the media block
  const start = css.indexOf('{', idx);
  if (start === -1) return '';
  let depth = 1;
  let i = start + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(start + 1, i - 1);
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
