// Tests for spectate mode fixes:
//  1. Admin panel spectate URL must use /spectate (not /spectate.html).
//  2. The resolutionComplete handler in initSpectator must call
//     _animateResolutionSteps with msg.steps rather than jumping straight to
//     the final state.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const adminHtml  = readFileSync(join(root, 'admin.html'),  'utf8');
const mainJs     = readFileSync(join(root, 'src', 'main.js'), 'utf8');

// ── Fix 1: admin panel spectate link ─────────────────────────────────────────

describe('admin.html spectateRoom URL', () => {
  test('opens /spectate?room= (not /spectate.html?room=)', () => {
    assert.ok(
      adminHtml.includes('/spectate?room='),
      'admin.html should use /spectate?room= to open the spectator window',
    );
  });

  test('does not contain the broken /spectate.html?room= URL', () => {
    assert.ok(
      !adminHtml.includes('/spectate.html?room='),
      'admin.html must not use the old broken /spectate.html?room= URL',
    );
  });
});

// ── Fix 2: spectator resolutionComplete animates steps ────────────────────────

describe('initSpectator resolutionComplete handler', () => {
  // Locate the resolutionComplete case inside _handleSpectatorMessage.
  // We isolate only the spectator function body to avoid matching the online
  // client's own resolutionComplete handler.
  const spectatorFnStart = mainJs.indexOf('function initSpectator(');
  assert.ok(spectatorFnStart !== -1, 'initSpectator function must exist in src/main.js');
  // The function closes at the matching brace; grab enough context.
  const spectatorSection = mainJs.slice(spectatorFnStart, spectatorFnStart + 8000);

  test('calls _animateResolutionSteps inside resolutionComplete case', () => {
    assert.ok(
      spectatorSection.includes('_animateResolutionSteps'),
      'resolutionComplete in initSpectator must call _animateResolutionSteps',
    );
  });

  test('passes msg.steps to _animateResolutionSteps', () => {
    assert.ok(
      spectatorSection.includes('msg.steps'),
      'resolutionComplete must forward msg.steps to the animation function',
    );
  });

  test('applies final state inside .then() callback', () => {
    // The pattern: _animateResolutionSteps(...).then(() => { state = ... })
    assert.ok(
      spectatorSection.includes('.then('),
      'final state should be applied after animation via .then()',
    );
  });

  test('sets ui.speedMode = fast in _initSpectatorUI', () => {
    assert.ok(
      spectatorSection.includes("ui.speedMode = 'fast'"),
      "_initSpectatorUI must set ui.speedMode = 'fast' for spectators",
    );
  });
});
