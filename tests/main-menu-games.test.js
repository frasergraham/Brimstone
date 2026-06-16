// Unit tests for the pure logic helpers in src/main-menu-games.js:
// urgency scoring, sorting, and row formatting. No DOM needed.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mmUrgencyScore, mmSortRows, mmFormatRow, mmDedupeCampaignRows } from '../src/main-menu-games.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000; // fixed "now" in ms for deterministic tests

function row(overrides = {}) {
  return {
    kind: 'game',
    room_id: 'r1',
    title: '⚔ vs Witch',
    round: 3,
    phase: 'day',
    action_needed: false,
    turn_deadline: null,
    players_submitted: 0,
    players_total: 2,
    players_per_side: 1,
    map_size: 'standard',
    updated_at: Math.floor(NOW / 1000) - 300,
    status: 'playing',
    ...overrides,
  };
}

// ── mmUrgencyScore ──────────────────────────────────────────────────────────

describe('mmUrgencyScore', () => {
  test('action_needed with deadline sorts by remaining time', () => {
    const soon = row({ action_needed: true, turn_deadline: Math.floor(NOW / 1000) + 60 });
    const later = row({ action_needed: true, turn_deadline: Math.floor(NOW / 1000) + 3600 });
    assert.ok(mmUrgencyScore(soon, NOW) < mmUrgencyScore(later, NOW));
  });

  test('overdue (negative remaining) sorts above future deadlines', () => {
    const overdue = row({ action_needed: true, turn_deadline: Math.floor(NOW / 1000) - 60 });
    const future  = row({ action_needed: true, turn_deadline: Math.floor(NOW / 1000) + 60 });
    assert.ok(mmUrgencyScore(overdue, NOW) < mmUrgencyScore(future, NOW));
  });

  test('action_needed without deadline sorts below action_needed with deadline', () => {
    const withDeadline = row({ action_needed: true, turn_deadline: Math.floor(NOW / 1000) + 3600 });
    const noDeadline   = row({ action_needed: true, turn_deadline: null });
    assert.ok(mmUrgencyScore(withDeadline, NOW) < mmUrgencyScore(noDeadline, NOW));
  });

  test('waiting-with-deadline sorts below all action_needed rows', () => {
    const actionNeeded = row({ action_needed: true, turn_deadline: null });
    const waiting      = row({
      action_needed: false,
      turn_deadline: Math.floor(NOW / 1000) + 60,
    });
    assert.ok(mmUrgencyScore(actionNeeded, NOW) < mmUrgencyScore(waiting, NOW));
  });

  test('idle rows (no deadline, no action) sort by updated_at (most recent first)', () => {
    const recent = row({ updated_at: Math.floor(NOW / 1000) - 10 });
    const stale  = row({ updated_at: Math.floor(NOW / 1000) - 10_000 });
    assert.ok(mmUrgencyScore(recent, NOW) < mmUrgencyScore(stale, NOW));
  });

  test('battle-invite always sorts last', () => {
    const idle = row({ updated_at: 0 });
    const invite = { kind: 'battle-invite', turn_deadline: null, action_needed: false };
    assert.ok(mmUrgencyScore(idle, NOW) < mmUrgencyScore(invite, NOW));
  });

  test('battle row with action_needed + nearer deadline outranks an idle regular game', () => {
    const battle = row({
      kind: 'battle',
      action_needed: true,
      turn_deadline: Math.floor(NOW / 1000) + 600,
    });
    const idle = row({ updated_at: Math.floor(NOW / 1000) });
    assert.ok(mmUrgencyScore(battle, NOW) < mmUrgencyScore(idle, NOW));
  });

  test('campaign-next row sorts alongside idle rows by updated_at', () => {
    const campaignNext = {
      kind: 'campaign-next',
      action_needed: false,
      turn_deadline: null,
      updated_at: Math.floor(NOW / 1000) - 100,
    };
    const recentIdle = row({ updated_at: Math.floor(NOW / 1000) - 10 });
    const staleIdle  = row({ updated_at: Math.floor(NOW / 1000) - 10_000 });
    assert.ok(mmUrgencyScore(recentIdle, NOW) < mmUrgencyScore(campaignNext, NOW));
    assert.ok(mmUrgencyScore(campaignNext, NOW) < mmUrgencyScore(staleIdle, NOW));
  });
});

// ── mmSortRows ──────────────────────────────────────────────────────────────

describe('mmSortRows', () => {
  test('produces a total order: overdue > urgent > action-no-deadline > waiting > idle > invite', () => {
    const rows = [
      row({ room_id: 'idle',    updated_at: Math.floor(NOW / 1000) - 500 }),
      row({ room_id: 'urgent',  action_needed: true, turn_deadline: Math.floor(NOW / 1000) + 120 }),
      { kind: 'battle-invite',  room_id: null, turn_deadline: null, action_needed: false },
      row({ room_id: 'waiting', action_needed: false, turn_deadline: Math.floor(NOW / 1000) + 7200 }),
      row({ room_id: 'overdue', action_needed: true, turn_deadline: Math.floor(NOW / 1000) - 60 }),
      row({ room_id: 'no-dl',   action_needed: true, turn_deadline: null }),
    ];
    const sorted = mmSortRows(rows, NOW);
    assert.deepEqual(
      sorted.map(r => r.room_id ?? r.kind),
      ['overdue', 'urgent', 'no-dl', 'waiting', 'idle', 'battle-invite']
    );
  });

  test('does not mutate the input array', () => {
    const rows = [row({ room_id: 'a' }), row({ room_id: 'b' })];
    const before = rows.slice();
    mmSortRows(rows, NOW);
    assert.deepEqual(rows, before);
  });
});

// ── mmFormatRow ─────────────────────────────────────────────────────────────

describe('mmFormatRow', () => {
  test('regular game with action_needed gets classes and badge flag', () => {
    const view = mmFormatRow(row({ action_needed: true }));
    assert.ok(view.classes.includes('mm-game-row'));
    assert.ok(view.classes.includes('mm-game-action'));
    assert.ok(!view.classes.includes('mm-game-battle'));
    assert.equal(view.showTurnBadge, true);
  });

  test('battle row is marked with mm-game-battle class', () => {
    const view = mmFormatRow({
      kind: 'battle',
      title: 'Battle',
      round: 5,
      turn_deadline: Math.floor(NOW / 1000) + 3600,
      action_needed: true,
      players_count: 10,
    });
    assert.ok(view.classes.includes('mm-game-battle'));
    assert.ok(view.classes.includes('mm-game-action'));
    assert.ok(view.meta.includes('Round 5'));
    assert.ok(view.meta.includes('10 players'));
    assert.equal(view.showTurnBadge, true);
    assert.equal(view.deadline, Math.floor(NOW / 1000) + 3600);
  });

  test('battle-invite renders "Tap to join" meta', () => {
    const view = mmFormatRow({
      kind: 'battle-invite',
      title: 'Battle',
      turn_deadline: null,
      action_needed: false,
    });
    assert.ok(view.classes.includes('mm-game-battle'));
    assert.ok(view.meta.includes('Tap to join'));
    assert.equal(view.showTurnBadge, false);
  });

  test('regular 2v2 game shows pps in meta', () => {
    const view = mmFormatRow(row({ players_per_side: 2, players_total: 4, players_submitted: 1 }));
    assert.ok(view.meta.includes('2v2'));
    assert.ok(view.meta.includes('Round 3'));
  });

  test('waiting meta shows "waiting on N"', () => {
    const view = mmFormatRow(row({
      action_needed: false,
      players_submitted: 1,
      players_total: 2,
    }));
    assert.ok(view.meta.includes('waiting on 1'));
  });

  test('title is preserved verbatim', () => {
    const view = mmFormatRow(row({ title: '⚔ vs Zelda' }));
    assert.equal(view.title, '⚔ vs Zelda');
  });

  test('local-sp save is marked with mm-game-local class', () => {
    const view = mmFormatRow({
      kind: 'local-sp',
      title: '⚔ vs AI (Hero)',
      round: 5,
      phase: 'night',
      map_size: 'standard',
    });
    assert.ok(view.classes.includes('mm-game-local'));
    assert.ok(!view.classes.includes('mm-game-battle'));
    assert.ok(view.meta.includes('Round 5'));
    assert.ok(view.meta.includes('Local'));
    assert.equal(view.showTurnBadge, false);
  });

  test('local-campaign save shows Campaign in meta', () => {
    const view = mmFormatRow({
      kind: 'local-campaign',
      title: '📖 The Witch-Finder',
      round: 3,
      phase: 'day',
    });
    assert.ok(view.classes.includes('mm-game-local'));
    assert.ok(view.meta.includes('Campaign'));
    assert.ok(view.meta.includes('Round 3'));
  });

  test('simplified battle row shows N players instead of submission count', () => {
    const view = mmFormatRow({
      kind: 'battle',
      title: '⚔✦ Battle',
      round: 7,
      players_count: 14,
      turn_deadline: null,
    });
    assert.ok(view.meta.includes('14 players'));
    assert.ok(view.meta.includes('Round 7'));
    assert.ok(!view.meta.includes('/'), 'should not show submission count');
  });

  test('completed-sp row shows win reason and rounds for replays', () => {
    const view = mmFormatRow({
      kind: 'completed-sp',
      title: '⚔ Hero wins',
      win_reason: 'Hero kills witch',
      total_rounds: 23,
    });
    assert.ok(view.meta.includes('Hero kills witch'));
    assert.ok(view.meta.includes('23 rounds'));
  });

  test('campaign-next row shows Campaign and next mission title in meta', () => {
    const view = mmFormatRow({
      kind: 'campaign-next',
      title: '📖 Caleb\'s Hollow Prologue',
      _nextMissionTitle: 'The First Night',
    });
    assert.ok(view.classes.includes('mm-game-local'));
    assert.ok(view.meta.includes('Campaign'));
    assert.ok(view.meta.includes('The First Night'));
    assert.equal(view.showTurnBadge, false);
  });

  test('campaign-next row without _nextMissionTitle shows Campaign only', () => {
    const view = mmFormatRow({
      kind: 'campaign-next',
      title: '📖 Caleb\'s Hollow Prologue',
    });
    assert.ok(view.meta.includes('Campaign'));
    assert.equal(view.meta, 'Campaign');
  });

  test('local-campaign row surfaces the slot and mission when present', () => {
    const view = mmFormatRow({
      kind: 'local-campaign',
      title: '📖 The First Night',
      _slotIndex: 2,
      _missionTitle: 'The First Night',
    });
    assert.ok(view.meta.includes('Campaign'));
    assert.ok(view.meta.includes('Slot 2'));
    assert.ok(view.meta.includes('The First Night'));
  });

  test('campaign-next row surfaces the slot when present', () => {
    const view = mmFormatRow({
      kind: 'campaign-next',
      title: '📖 Caleb\'s Hollow Prologue',
      _slotIndex: 3,
      _nextMissionTitle: 'The River Crossing',
    });
    assert.ok(view.meta.includes('Slot 3'));
    assert.ok(view.meta.includes('The River Crossing'));
  });
});

// ── mmDedupeCampaignRows ──────────────────────────────────────────────────────

describe('mmDedupeCampaignRows', () => {
  test('keeps one row per campaign — the most-recently-updated slot', () => {
    const rows = [
      { kind: 'campaign-next',   _campaignId: 'a', _slotIndex: 1, updated_at: 100 },
      { kind: 'local-campaign',  _campaignId: 'a', _slotIndex: 2, updated_at: 500 },
      { kind: 'campaign-next',   _campaignId: 'a', _slotIndex: 3, updated_at: 300 },
    ];
    const out = mmDedupeCampaignRows(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0]._slotIndex, 2);
    assert.equal(out[0].kind, 'local-campaign');
  });

  test('dedupes per campaign independently', () => {
    const rows = [
      { kind: 'campaign-next',  _campaignId: 'a', _slotIndex: 1, updated_at: 100 },
      { kind: 'campaign-next',  _campaignId: 'b', _slotIndex: 1, updated_at: 100 },
      { kind: 'local-campaign', _campaignId: 'a', _slotIndex: 2, updated_at: 200 },
    ];
    const out = mmDedupeCampaignRows(rows);
    assert.equal(out.length, 2);
    const a = out.find(r => r._campaignId === 'a');
    const b = out.find(r => r._campaignId === 'b');
    assert.equal(a._slotIndex, 2);
    assert.equal(b._slotIndex, 1);
  });

  test('passes non-campaign rows through untouched and preserves order', () => {
    const rows = [
      { kind: 'game', room_id: 'g1', updated_at: 10 },
      { kind: 'campaign-next', _campaignId: 'a', _slotIndex: 1, updated_at: 100 },
      { kind: 'local-sp', room_id: 's1', updated_at: 20 },
      { kind: 'local-campaign', _campaignId: 'a', _slotIndex: 2, updated_at: 50 },
    ];
    const out = mmDedupeCampaignRows(rows);
    // g1, (campaign a at first-seen position, now the slot-1 row since it's newer), s1
    assert.deepEqual(out.map(r => r.room_id ?? `campaign-${r._campaignId}`),
      ['g1', 'campaign-a', 's1']);
    assert.equal(out[1]._slotIndex, 1); // slot 1 (updated 100) beats slot 2 (updated 50)
  });

  test('ties keep the first-seen row', () => {
    const rows = [
      { kind: 'campaign-next',  _campaignId: 'a', _slotIndex: 1, updated_at: 100 },
      { kind: 'local-campaign', _campaignId: 'a', _slotIndex: 2, updated_at: 100 },
    ];
    const out = mmDedupeCampaignRows(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0]._slotIndex, 1);
  });
});
