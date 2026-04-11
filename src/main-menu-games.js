// Pure helpers for the main menu "active games" list. No DOM, no globals —
// exported so they can be unit-tested without a DOM harness.
//
// A "row" is a normalized object shared by:
//   - regular multiplayer games (shape mirrors /api/games)
//   - the persistent Battle for Caleb's Hollow (synthesized from /api/battle-status)
//
// Row fields:
//   kind: 'game' | 'battle' | 'battle-invite'
//   room_id            string
//   title              display title (opponent or "Battle for Caleb's Hollow")
//   round              int
//   phase              'dawn'|'day'|'dusk'|'night'|undefined
//   action_needed      bool — your turn
//   turn_deadline      unix seconds, or null
//   players_submitted  int
//   players_total      int
//   players_per_side   int (undefined for battle)
//   map_size           'skirmish'|'standard'|'regional'|'campaign'
//   updated_at         unix seconds

/**
 * Assign an urgency score to a row. Lower score = higher priority.
 *
 * Buckets (total order):
 *   1. action_needed with a deadline     — most urgent deadline first
 *   2. action_needed without a deadline
 *   3. submitted, waiting with a deadline — soonest deadline first
 *   4. idle / lobby                       — most-recently-touched first
 *   5. unjoined "Join the Battle" invite  — always last, but still in top 5
 *
 * Battle rows are NOT pinned — they sort by urgency like anything else.
 * They're only visually distinguished by the caller via CSS class.
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
 * Sort rows by urgency (low score → high priority) in place and return them.
 */
export function mmSortRows(rows, nowMs = Date.now()) {
  return rows.slice().sort((a, b) => mmUrgencyScore(a, nowMs) - mmUrgencyScore(b, nowMs));
}

const PHASE_LABELS = {
  dawn:  '🌅 Dawn',
  day:   '☀ Day',
  dusk:  '🌇 Dusk',
  night: '🌙 Night',
};

/**
 * Produce a formatted view-model for a row: title, line2 meta text, and
 * CSS class names. No DOM, returns plain data.
 */
export function mmFormatRow(row) {
  const classes = ['mm-game-row'];
  if (row.kind === 'battle' || row.kind === 'battle-invite') classes.push('mm-game-battle');
  if (row.action_needed) classes.push('mm-game-action');

  const title = row.title || 'Game';

  // Build the line 2 meta string.
  const parts = [];

  if (row.kind === 'battle-invite') {
    parts.push('10v10 Battle');
    parts.push('Tap to join');
  } else if (row.kind === 'battle') {
    if (row.round != null) parts.push(`Round ${row.round}`);
    parts.push('10v10 Battle');
    if (row.players_total > 0) {
      const waiting = row.players_total - (row.players_submitted ?? 0);
      if (row.action_needed) {
        parts.push(`${row.players_submitted ?? 0}/${row.players_total} in`);
      } else {
        parts.push(waiting > 0 ? `waiting on ${waiting}` : 'waiting');
      }
    }
  } else {
    // Regular game
    if (row.round != null) parts.push(`Round ${row.round}`);
    if (row.phase) parts.push(PHASE_LABELS[row.phase] ?? row.phase);
    const pps = row.players_per_side ?? 1;
    if (pps > 1) parts.push(`${pps}v${pps}`);
    else if (row.map_size) {
      const ms = row.map_size;
      parts.push(ms.charAt(0).toUpperCase() + ms.slice(1));
    }
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
