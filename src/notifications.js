/**
 * notifications.js — Browser Notification API wrapper for async game alerts.
 *
 * Shows desktop notifications when the game tab is hidden (e.g. player
 * switched to another tab while waiting for their opponent's turn).
 * Only fires when permission is granted and the tab is not visible.
 */

// ── Tab visibility tracking ──────────────────────────────────────────────────

let _tabVisible = typeof document !== 'undefined' ? !document.hidden : true;

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    _tabVisible = !document.hidden;
  });
}

// ── Permission ───────────────────────────────────────────────────────────────

/** Prompt the user for notification permission (no-op if already decided). */
export function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

/** True when notifications are available and the user has granted permission. */
export function canNotify() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Show a browser notification if the tab is hidden and permission granted.
 * @param {string} title
 * @param {string} body
 * @param {string} tag  — deduplicates; only latest notification per tag shows.
 * @returns {Notification|null}
 */
function _notify(title, body, tag) {
  if (_tabVisible || !canNotify()) return null;
  const n = new Notification(title, { body, tag });
  n.onclick = () => { window.focus(); n.close(); };
  return n;
}

// ── Public notification helpers ──────────────────────────────────────────────

/** Everyone else has submitted — waiting on you! */
export function notifyWaitingOnYou() {
  return _notify('Waiting on you!', "Everyone else has submitted. Your turn to plan!", 'brimstone-waiting-on-you');
}

/** New round is ready — everyone submitted, resolution complete. */
export function notifyRoundReady(round) {
  return _notify('Your Turn', `Round ${round} is ready — plan your moves!`, 'brimstone-round-ready');
}

/** Deadline is approaching — submit soon! */
export function notifyDeadlineApproaching(minutesLeft) {
  return _notify('Deadline approaching', `You have ~${minutesLeft} minutes to submit your plan!`, 'brimstone-deadline');
}

/** Game is over. */
export function notifyGameOver(won) {
  return _notify('Game Over', won ? 'Victory!' : 'Defeat.', 'brimstone-game-over');
}
