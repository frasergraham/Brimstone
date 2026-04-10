// Tests for the gamesUpdate WebSocket notification flow — ensures the server
// sends gamesUpdate to affected players when plans are submitted or rounds
// resolve, and the client routes the message correctly.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

const serverSource = readFileSync(join(root, 'server.js'), 'utf8');
const lobbySource  = readFileSync(join(root, 'server', 'lobby.js'), 'utf8');
const asyncRoomsSource = readFileSync(join(root, 'server', 'async-game-rooms.js'), 'utf8');
const mpSource     = readFileSync(join(root, 'src', 'multiplayer.js'), 'utf8');
const mainSource   = readFileSync(join(root, 'src', 'main.js'), 'utf8');

// ── server.js: playerWsMap infrastructure ───────────────────────────────────

describe('server.js — playerWsMap', () => {
  test('declares playerWsMap for player→WebSocket tracking', () => {
    assert.ok(
      serverSource.includes('playerWsMap'),
      'server.js should declare playerWsMap',
    );
  });

  test('exports sendToPlayer function', () => {
    assert.ok(
      serverSource.includes('function sendToPlayer'),
      'server.js should define a sendToPlayer function',
    );
  });

  test('registers player WebSocket on auth', () => {
    // Both auth cases should call _registerPlayerWs
    const matches = serverSource.match(/_registerPlayerWs/g);
    assert.ok(
      matches && matches.length >= 2,
      'server.js should register player WebSocket in both auth handlers',
    );
  });

  test('unregisters player WebSocket on close', () => {
    assert.ok(
      serverSource.includes('_unregisterPlayerWs'),
      'server.js should unregister player WebSocket on connection close',
    );
  });

  test('calls setSendToPlayer to inject callback into lobby.js', () => {
    assert.ok(
      serverSource.includes('setSendToPlayer(sendToPlayer)'),
      'server.js should inject sendToPlayer into lobby.js via setSendToPlayer',
    );
  });
});

// ── server/lobby.js: _notifyGamesUpdate calls ──────────────────────────────

describe('server/lobby.js — gamesUpdate notifications', () => {
  test('defines _notifyGamesUpdate helper', () => {
    assert.ok(
      lobbySource.includes('function _notifyGamesUpdate'),
      'lobby.js should define _notifyGamesUpdate',
    );
  });

  test('exports setSendToPlayer for callback injection', () => {
    assert.ok(
      lobbySource.includes('export function setSendToPlayer'),
      'lobby.js should export setSendToPlayer',
    );
  });

  test('sends gamesUpdate after sync plan submission', () => {
    // _notifyGamesUpdate should appear in the handlePlanSubmit area
    // (near broadcastExcept for playerSubmitted)
    const planSubmitArea = lobbySource.indexOf('broadcastExcept(room, playerId, submittedMsg)');
    const nextNotify = lobbySource.indexOf('_notifyGamesUpdate', planSubmitArea);
    assert.ok(
      planSubmitArea > -1 && nextNotify > -1 && nextNotify - planSubmitArea < 300,
      'lobby.js should call _notifyGamesUpdate near sync plan submission broadcast',
    );
  });

  test('sends gamesUpdate after sync round resolution', () => {
    // Should appear near the resolutionComplete broadcast
    const resArea = lobbySource.indexOf("type: 'resolutionComplete'");
    const nextNotify = lobbySource.indexOf('_notifyGamesUpdate', resArea);
    assert.ok(
      resArea > -1 && nextNotify > -1 && nextNotify - resArea < 400,
      'lobby.js should call _notifyGamesUpdate near sync resolution broadcast',
    );
  });

  test('sends gamesUpdate after async plan submission', () => {
    const asyncPlanArea = asyncRoomsSource.indexOf("type: 'asyncPlanAccepted'");
    const nextNotify = asyncRoomsSource.indexOf('_notifyGamesUpdate', asyncPlanArea);
    assert.ok(
      asyncPlanArea > -1 && nextNotify > -1 && nextNotify - asyncPlanArea < 300,
      'async-game-rooms.js should call _notifyGamesUpdate near async plan acceptance',
    );
  });

  test('sends gamesUpdate after async round resolution', () => {
    const asyncResArea = asyncRoomsSource.indexOf('_asyncBroadcast(roomId, resolutionMsg)');
    const nextNotify = asyncRoomsSource.indexOf('_notifyGamesUpdate', asyncResArea);
    assert.ok(
      asyncResArea > -1 && nextNotify > -1 && nextNotify - asyncResArea < 200,
      'async-game-rooms.js should call _notifyGamesUpdate near async resolution broadcast',
    );
  });
});

// ── src/multiplayer.js: gamesUpdate routing ─────────────────────────────────

describe('multiplayer.js — gamesUpdate routing', () => {
  test('routes gamesUpdate message to onGamesUpdate callback', () => {
    assert.ok(
      mpSource.includes("case 'gamesUpdate'"),
      'multiplayer.js _route should handle gamesUpdate message type',
    );
    assert.ok(
      mpSource.includes('onGamesUpdate'),
      'multiplayer.js should call onGamesUpdate callback',
    );
  });
});

// ── src/main.js: badge refresh on navigation ────────────────────────────────

describe('main.js — badge refresh on navigation', () => {
  test('refreshes badge when showing online screen', () => {
    // _showOnlineScreen should call _updateMultiplayerBadge
    const fnStart = mainSource.indexOf('function _showOnlineScreen()');
    const fnEnd = mainSource.indexOf('\nfunction', fnStart + 1);
    const fnBody = mainSource.slice(fnStart, fnEnd);
    assert.ok(
      fnBody.includes('_updateMultiplayerBadge()'),
      '_showOnlineScreen should call _updateMultiplayerBadge',
    );
  });

  test('refreshes badge when showing async screen', () => {
    const fnStart = mainSource.indexOf('function _showAsyncScreen()');
    const fnEnd = mainSource.indexOf('\nfunction', fnStart + 1);
    const fnBody = mainSource.slice(fnStart, fnEnd);
    assert.ok(
      fnBody.includes('_updateMultiplayerBadge()'),
      '_showAsyncScreen should call _updateMultiplayerBadge',
    );
  });

  test('wires onGamesUpdate handler in MP client options', () => {
    assert.ok(
      mainSource.includes('onGamesUpdate'),
      'main.js should wire onGamesUpdate in MultiplayerClient options',
    );
  });
});
