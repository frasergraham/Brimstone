// Pure helpers for the main menu "active games" list. No DOM, no globals —
// exported so they can be unit-tested without a DOM harness.
//
// A "row" is a normalized object shared by several sources:
//   - regular multiplayer games      (kind: 'game')
//   - the persistent Battle          (kind: 'battle' | 'battle-invite')
//   - local single-player saves      (kind: 'local-sp')
//   - campaign mid-mission saves     (kind: 'local-campaign')
//   - completed games (replays)      (kind: 'completed-sp' | 'completed-mp')
//
// Row fields:
//   kind               see above
//   room_id            string identifier (room id, save id, etc.)
//   title              display title
//   round              int (optional)
//   phase              'dawn'|'day'|'dusk'|'night'|undefined
//   action_needed      bool — your turn (for online)
//   turn_deadline      unix seconds, or null
//   players_submitted  int
//   players_total      int
//   players_per_side   int (undefined for battle)
//   players_count      int — used by the simplified battle row
//   map_size           'skirmish'|'standard'|'regional'|'campaign'
//   updated_at         unix seconds
//   is_local           bool — true for local-sp / local-campaign (styling hint)

/**
 * Assign an urgency score to a row. Lower score = higher priority.
 *
 * Buckets (total order):
 *   1. action_needed with a deadline         — most urgent deadline first
 *   2. action_needed without a deadline
 *   3. submitted, waiting with a deadline    — soonest deadline first
 *   4. idle / lobby / local saves             — most-recently-touched first
 *   5. unjoined "Join the Battle" invite     — always last, but still in top 5
 *
 * Local single-player saves live in bucket 4 (no deadline, no action). Battle
 * rows are not pinned — they sort by urgency like anything else. They're only
 * visually distinguished via CSS class.
 */
export function mmUrgencyScore(row, nowMs = Date.now()) {
  if (row.kind === 'battle-invite') return 1e14;

  const deadlineMs = row.turn_deadline ? row.turn_deadline * 1000 : null;

  if (row.action_needed) {
    if (deadlineMs != null) {
      // Remaining ms. Overdue (negative) naturally sorts before positive.
      return deadlineMs - nowMs;
    }
    return 1e11;
  }

  if (deadlineMs != null) {
    return 1e12 + (deadlineMs - nowMs);
  }

  const updatedMs = (row.updated_at ?? 0) * 1000;
  return 1e13 - updatedMs;
}

/**
 * Sort rows by urgency (low score → high priority). Returns a new array.
 */
export function mmSortRows(rows, nowMs = Date.now()) {
  return rows.slice().sort((a, b) => mmUrgencyScore(a, nowMs) - mmUrgencyScore(b, nowMs));
}

/**
 * Collapse campaign rows so the games list shows ONE row per campaign — the
 * slot touched most recently. A campaign can produce several rows (a
 * mid-mission save per slot, plus a 'campaign-next' per slot); keeping them all
 * would clutter the list and bury the row the player actually wants. Rows are
 * keyed by `_campaignId`; the one with the largest `updated_at` wins (ties keep
 * the first seen). Non-campaign rows pass through untouched, and order is
 * preserved at each campaign's first appearance. Returns a new array.
 */
export function mmDedupeCampaignRows(rows) {
  const CAMPAIGN_KINDS = new Set(['local-campaign', 'campaign-next']);
  const bestByCampaign = new Map(); // campaignId → chosen row
  const out = [];
  for (const r of rows) {
    if (!CAMPAIGN_KINDS.has(r.kind) || r._campaignId == null) {
      out.push(r);
      continue;
    }
    const prev = bestByCampaign.get(r._campaignId);
    if (!prev) {
      bestByCampaign.set(r._campaignId, r);
      out.push(r);
    } else if ((r.updated_at ?? 0) > (prev.updated_at ?? 0)) {
      out[out.indexOf(prev)] = r;
      bestByCampaign.set(r._campaignId, r);
    }
  }
  return out;
}

const PHASE_LABELS = {
  dawn:  '🌅 Dawn',
  day:   '☀ Day',
  dusk:  '🌇 Dusk',
  night: '🌙 Night',
};

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Produce a formatted view-model for a row: title, line2 meta text, and
 * CSS class names. No DOM, returns plain data.
 */
export function mmFormatRow(row) {
  const classes = ['mm-game-row'];
  if (row.kind === 'battle' || row.kind === 'battle-invite') classes.push('mm-game-battle');
  if (row.is_local || row.kind === 'local-sp' || row.kind === 'local-campaign' || row.kind === 'campaign-next') {
    classes.push('mm-game-local');
  }
  if (row.action_needed) classes.push('mm-game-action');

  const title = row.title || 'Game';

  // Build the line 2 meta string.
  const parts = [];

  if (row.kind === 'battle-invite') {
    const pps = row.players_per_side ?? 10;
    parts.push(`${pps}v${pps} Battle`);
    parts.push('Tap to join');
  } else if (row.kind === 'battle') {
    // Simplified battle row: just "N players" (and round if known).
    if (row.round != null) parts.push(`Round ${row.round}`);
    const players = row.players_count ?? row.players_total ?? 0;
    if (players > 0) parts.push(`${players} player${players === 1 ? '' : 's'}`);
    else parts.push('Battle');
  } else if (row.kind === 'local-sp') {
    // Local single-player save
    if (row.round != null) parts.push(`Round ${row.round}`);
    if (row.phase) parts.push(PHASE_LABELS[row.phase] ?? row.phase);
    if (row.map_size) parts.push(capitalize(row.map_size));
    parts.push('Local');
  } else if (row.kind === 'local-campaign') {
    // Campaign mission-in-progress
    parts.push('Campaign');
    if (row._slotIndex != null) parts.push(`Slot ${row._slotIndex}`);
    if (row._missionTitle) parts.push(row._missionTitle);
    if (row.round != null) parts.push(`Round ${row.round}`);
    if (row.phase) parts.push(PHASE_LABELS[row.phase] ?? row.phase);
  } else if (row.kind === 'campaign-next') {
    // Campaign with a next mission ready to play
    parts.push('Campaign');
    if (row._slotIndex != null) parts.push(`Slot ${row._slotIndex}`);
    if (row._nextMissionTitle) parts.push(row._nextMissionTitle);
  } else if (row.kind === 'completed-sp') {
    // Completed local game (for the Replays page)
    if (row.win_reason) parts.push(row.win_reason);
    if (row.total_rounds != null) parts.push(`${row.total_rounds} rounds`);
  } else if (row.kind === 'completed-mp') {
    // Completed online game (for the Replays page)
    if (row.win_reason) parts.push(row.win_reason);
    if (row.total_rounds != null) parts.push(`${row.total_rounds} rounds`);
  } else {
    // Regular online multiplayer game
    if (row.round != null) parts.push(`Round ${row.round}`);
    if (row.phase) parts.push(PHASE_LABELS[row.phase] ?? row.phase);
    const pps = row.players_per_side ?? 1;
    if (pps > 1) parts.push(`${pps}v${pps}`);
    else if (row.map_size) parts.push(capitalize(row.map_size));
    if (row.players_total > 0) {
      if (row.action_needed && row.players_submitted > 0) {
        parts.push(`${row.players_submitted}/${row.players_total} in`);
      } else if (!row.action_needed) {
        const waiting = row.players_total - (row.players_submitted ?? 0);
        parts.push(waiting > 0 ? `waiting on ${waiting}` : 'waiting');
      }
    }
  }

  return {
    title,
    meta: parts.join(' · '),
    classes,
    showTurnBadge: !!row.action_needed,
    deadline: row.turn_deadline ?? null,
  };
}
