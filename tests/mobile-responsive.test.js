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
const adminHTML = readFileSync(resolve(root, 'admin.html'), 'utf8');
const adminStatsHTML = readFileSync(resolve(root, 'admin-stats.html'), 'utf8');

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

  test('game-menu-item has 44px touch target', () => {
    assert.ok(block.includes('.game-menu-item'), 'Missing .game-menu-item rule');
    assert.ok(block.includes('44px'), 'Missing 44px min-height');
  });
});

// ── admin-stats.html — stats page mobile rules ──────────────────────────────

describe('admin-stats.html mobile breakpoint (max-width: 600px)', () => {
  const block = extractMediaBlock(adminStatsHTML, '@media (max-width: 600px)');

  test('media block exists', () => {
    assert.ok(block.length > 0, 'Expected @media (max-width: 600px) block');
  });

  test('container padding reduced', () => {
    assert.ok(block.includes('.wrap'), 'Missing .wrap rule');
  });

  test('card grid uses smaller minmax for phones', () => {
    assert.ok(block.includes('.cards'), 'Missing .cards rule');
    assert.ok(block.includes('130px'), 'Missing 130px minmax for cards');
  });

  test('sections scrollable for wide tables', () => {
    assert.ok(block.includes('.section'), 'Missing .section rule');
    assert.ok(block.includes('overflow-x'), 'Missing overflow-x for sections');
  });

  test('bar-label width reduced for narrow screens', () => {
    assert.ok(block.includes('.bar-label'), 'Missing .bar-label rule');
    assert.ok(block.includes('80px'), 'Missing 80px width for bar-label');
  });

  test('balance meter side-label min-width reduced', () => {
    assert.ok(block.includes('.balance-meter .side-label'), 'Missing .balance-meter .side-label rule');
  });

  test('refresh button float removed on mobile', () => {
    assert.ok(block.includes('.refresh-btn'), 'Missing .refresh-btn rule');
    assert.ok(block.includes('float: none'), 'Missing float: none for refresh-btn');
  });
});

// ── admin.html — admin panel mobile rules ────────────────────────────────────

describe('admin.html mobile breakpoint (max-width: 600px)', () => {
  const block = extractMediaBlock(adminHTML, '@media (max-width: 600px)');

  test('media block exists', () => {
    assert.ok(block.length > 0, 'Expected @media (max-width: 600px) block');
  });

  test('container padding reduced', () => {
    assert.ok(block.includes('.admin-wrap'), 'Missing .admin-wrap rule');
  });

  test('stat-box min-width removed for flexible sizing', () => {
    assert.ok(block.includes('.stat-box'), 'Missing .stat-box rule');
    assert.ok(block.includes('min-width: 0') || block.includes('min-width:0'),
      'Missing min-width: 0 for stat-box');
  });

  test('tabs horizontally scrollable on narrow screens', () => {
    assert.ok(block.includes('.tabs'), 'Missing .tabs rule');
    assert.ok(block.includes('overflow-x'), 'Missing overflow-x for tabs');
  });

  test('tab-btn has smaller padding and nowrap', () => {
    assert.ok(block.includes('.tab-btn'), 'Missing .tab-btn rule');
    assert.ok(block.includes('white-space: nowrap') || block.includes('white-space:nowrap'),
      'Missing white-space: nowrap for tab-btn');
  });

  test('tab-content scrollable for wide tables', () => {
    assert.ok(block.includes('.tab-content'), 'Missing .tab-content rule');
    assert.ok(block.includes('overflow-x'), 'Missing overflow-x for tab-content');
  });

  test('buttons have 44px touch targets', () => {
    assert.ok(block.includes('.btn'), 'Missing .btn rule');
    assert.ok(block.includes('44px'), 'Missing 44px min-height for buttons');
  });

  test('refresh-row wraps on mobile', () => {
    assert.ok(block.includes('.refresh-row'), 'Missing .refresh-row rule');
    assert.ok(block.includes('flex-wrap'), 'Missing flex-wrap for refresh-row');
  });
});
