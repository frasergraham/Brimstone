// Tests for the multiplayer nudge system.
//
// Covers:
// 1. buildPlayerStatusHtml nudge button rendering
// 2. Server-side nudge handler validation (source inspection)
// 3. Client multiplayer.js nudge method

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlayerStatusHtml } from '../src/ui-render.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

// ── buildPlayerStatusHtml nudge button tests ─────────────────────────────────

describe('buildPlayerStatusHtml — nudge buttons', () => {
  const players = [
    { playerId: 'me',    name: 'Alice', faction: 'hero',  isAI: false, _submitted: false },
    { playerId: 'other', name: 'Bob',   faction: 'witch', isAI: false, _submitted: false },
    { playerId: 'ai1',   name: 'BotX',  faction: 'witch', isAI: true,  _submitted: false },
  ];

  test('no nudge buttons when nudgeCtx is omitted', () => {
    const html = buildPlayerStatusHtml(players);
    assert.ok(!html.includes('nudge-btn'), 'should not render nudge buttons without context');
  });

  test('no nudge button for self', () => {
    const html = buildPlayerStatusHtml(players, {
      myPlayerId: 'me',
      nudgedSet: new Set(),
    });
    // Count nudge buttons — should not appear for 'me' or the AI
    const matches = html.match(/data-nudge-id/g) || [];
    assert.equal(matches.length, 1, 'exactly one nudge button (for Bob)');
    assert.ok(html.includes('data-nudge-id="other"'), 'nudge button targets Bob');
  });

  test('no nudge button for AI players', () => {
    const html = buildPlayerStatusHtml(players, {
      myPlayerId: 'me',
      nudgedSet: new Set(),
    });
    assert.ok(!html.includes('data-nudge-id="ai1"'), 'AI player should not have nudge button');
  });

  test('nudge button is disabled after nudging', () => {
    const html = buildPlayerStatusHtml(players, {
      myPlayerId: 'me',
      nudgedSet: new Set(['other']),
    });
    assert.ok(!html.includes('data-nudge-id="other"'), 'no active nudge button after nudging');
    assert.ok(html.includes('nudge-sent'), 'should show nudge-sent class');
    assert.ok(html.includes('disabled'), 'button should be disabled');
  });

  test('no nudge button for players who already submitted', () => {
    const submitted = [
      { playerId: 'me',    name: 'Alice', faction: 'hero',  isAI: false, _submitted: false },
      { playerId: 'other', name: 'Bob',   faction: 'witch', isAI: false, _submitted: true },
    ];
    const html = buildPlayerStatusHtml(submitted, {
      myPlayerId: 'me',
      nudgedSet: new Set(),
    });
    assert.ok(!html.includes('nudge-btn'), 'submitted player should not have nudge button');
  });
});

// ── Server-side nudge handler (source inspection) ────────────────────────────

describe('server nudge handler — lobby.js', () => {
  const lobbySource = readFileSync(join(root, 'server/lobby.js'), 'utf8');

  test('handleNudge is exported', () => {
    assert.ok(
      lobbySource.includes('export function handleNudge'),
      'lobby.js should export handleNudge',
    );
  });

  test('handleNudge checks room is playing', () => {
    assert.ok(
      lobbySource.includes("room.status !== 'playing'"),
      'should reject nudges when room is not playing',
    );
  });

  test('handleNudge checks planning phase', () => {
    assert.ok(
      lobbySource.includes('room.state.planningPhase'),
      'should only allow nudges during planning phase',
    );
  });

  test('handleNudge prevents self-nudge', () => {
    assert.ok(
      lobbySource.includes('targetPlayerId === senderId'),
      'should prevent players from nudging themselves',
    );
  });

  test('handleNudge checks target is not AI', () => {
    // The handler should check target.isAI
    assert.ok(
      lobbySource.includes('target.isAI'),
      'should check that the target is not an AI',
    );
  });

  test('handleNudge checks target has not submitted', () => {
    assert.ok(
      lobbySource.includes('playerReady'),
      'should check if target has already submitted',
    );
  });

  test('handleNudge sends nudgeAck to sender', () => {
    assert.ok(
      lobbySource.includes("type: 'nudgeAck'"),
      'should send nudgeAck back to the sender',
    );
  });

  test('handleNudge sends nudged message to target', () => {
    assert.ok(
      lobbySource.includes("type: 'nudged'"),
      'should send nudged message to the target player',
    );
  });
});

// ── Server route — server.js ─────────────────────────────────────────────────

describe('server.js nudge routing', () => {
  const serverSource = readFileSync(join(root, 'server.js'), 'utf8');

  test('routes nudge message type', () => {
    assert.ok(
      serverSource.includes("case 'nudge':"),
      'server.js should route the nudge message type',
    );
  });

  test('calls handleNudge with targetPlayerId', () => {
    assert.ok(
      serverSource.includes('handleNudge(cs.player.id, cs.roomId, msg.targetPlayerId)'),
      'should call handleNudge with sender, room, and target',
    );
  });
});

// ── Client multiplayer.js ────────────────────────────────────────────────────

describe('multiplayer.js nudge support', () => {
  const mpSource = readFileSync(join(root, 'src/multiplayer.js'), 'utf8');

  test('has sendNudge method', () => {
    assert.ok(
      mpSource.includes('sendNudge'),
      'MultiplayerClient should have a sendNudge method',
    );
  });

  test('routes nudged message to callback', () => {
    assert.ok(
      mpSource.includes("case 'nudged':"),
      'should route nudged messages',
    );
    assert.ok(
      mpSource.includes('onNudged'),
      'should call onNudged callback',
    );
  });

  test('routes nudgeAck message to callback', () => {
    assert.ok(
      mpSource.includes("case 'nudgeAck':"),
      'should route nudgeAck messages',
    );
  });

  test('stores isAsync from matchFound', () => {
    assert.ok(
      mpSource.includes('this.isAsync'),
      'should store isAsync flag',
    );
  });
});

// ── Notifications ────────────────────────────────────────────────────────────

describe('notifications.js nudge support', () => {
  const notifSource = readFileSync(join(root, 'server/notifications.js'), 'utf8');

  test('exports notifyNudge function', () => {
    assert.ok(
      notifSource.includes('export async function notifyNudge'),
      'should export notifyNudge',
    );
  });

  test('uses nudge notification type for dedup', () => {
    assert.ok(
      notifSource.includes("'nudge'"),
      'should use nudge type for dedup tracking',
    );
  });
});
