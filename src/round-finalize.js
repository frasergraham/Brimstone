// Offline round finalize-and-persist sequencing — the deterministic Sim + save
// half of one round, factored out of src/main.js's `_runLocalResolution` so the
// ordering is unit-testable without a DOM.
//
// WHY THIS EXISTS (the bug it fixes):
//   The offline flow used to be: resolvePlans (round computed / replay-ready) →
//   WATCH the replay (blocks on the human) → finalizeRound → save. Both offline
//   saves (single-player + campaign mid-mission) were therefore gated behind the
//   player WATCHING the animation. Closing or crashing the app mid-replay lost
//   the just-computed round — the persisted save still reflected the PRIOR round.
//
//   This helper runs the round's finalize + persist as a sealed, deterministic
//   unit the instant resolution is ready (per the Mission-Logic "sealed
//   resolution" invariant — the Sim is already sealed when resolvePlans returns),
//   BEFORE the player watches. The replay then plays as pure Show, phase-pinned
//   to the round's fought phase (the live phase has since advanced inside
//   finalizeRound), exactly like the end-of-round re-watch path.
//
// Online already persists server-side at resolve-time (server/lobby.js
// `_resolveRoom`: resolvePlansMP → finalizeRound → appendSaveRound, decoupled
// from any client replay), so no online change is needed — this is offline-only.
//
// SIM vs SHOW (docs/09 invariant 3): everything here is Sim (mutates the
// authoritative GameState deterministically) or persistence. Presentation
// (the replay animation, dialogs, toasts, the summary card, thumbnails) stays in
// the caller, AFTER this returns. The one nuance: the battle-summary log push is
// Sim (it appends to state.log) and MUST run before endRound inserts its phase
// entries — so it lives here, first.

/**
 * Run the deterministic finalize + persist sequence for one resolved offline
 * round, in the fixed order:
 *   1. push the aggregate battle summary into state.log (before endRound's
 *      phase entries),
 *   2. capture the round's fought phase + pre-endRound node score,
 *   3. finalizeRound() (advances the day cycle, scoring, victory),
 *   4. append the round to the full-game replay history (MUST precede saveSp,
 *      which serializes that history), and
 *   5. write the offline saves (single-player localStorage + campaign
 *      mid-mission).
 *
 * Returns `{ prevScore, roundPhase }` — captured BEFORE finalizeRound so the
 * caller can drive the score-bar animation and phase-pin the replay.
 *
 * All side effects are injected so this stays DOM-free and unit-testable. The
 * caller (src/main.js) wires the real implementations.
 *
 * @param {Object}   o
 * @param {Object}   o.state              live GameState (mutated by finalizeRound)
 * @param {Function} o.compileSummary     () => string[]   aggregate battle log lines
 * @param {Function} [o.renderLog]        ()=>void         re-render the chronicle (Show, but cheap; matches prior call site)
 * @param {Function} o.appendRoundHistory ()=>void         push this round onto _roundHistory
 * @param {Function} o.saveSp             ()=>void          persist single-player progress
 * @param {Function} o.saveCampaign       ()=>void          persist campaign mid-mission progress
 * @returns {{ prevScore: {hero:number,witch:number}, roundPhase: string }}
 */
export function finalizeAndPersistRound(o) {
  const { state, compileSummary, renderLog, appendRoundHistory, saveSp, saveCampaign } = o;

  // 1. Aggregate battle summary → state.log, BEFORE endRound inserts phase
  //    entries (log ordering is observable in the chronicle + persisted save).
  const summaryLines = compileSummary();
  for (const line of summaryLines) state.log.push(line);
  if (summaryLines.length && renderLog) renderLog();

  // 2. Snapshot score + fought phase BEFORE finalizeRound advances them. The
  //    round's own phase pins the replay's lighting / sight ranges (the live
  //    phase advances in finalizeRound), and prevScore drives the score-bar
  //    delta after the watch.
  const prevScore  = { hero: state.nodeScore.hero, witch: state.nodeScore.witch };
  const roundPhase = state.phase;

  // 3. Sealed Sim — node discovery → control-change log → explored-hex update →
  //    endRound (phase advance, scoring, wave/mission-logic pumps, checkVictory).
  state.finalizeRound();

  // 4. Accumulate the round for full-game replay — MUST run before saveSp(),
  //    which serializes _roundHistory to localStorage. Pushing first keeps the
  //    persisted history in lockstep with the live game so a resumed save shows
  //    the replay exactly as a fresh round-end (and the "Last Turn" button
  //    appears). state.gameOver is now set (checkVictory ran in finalizeRound),
  //    so the history entry can choose whether to carry finalEntities.
  appendRoundHistory();

  // 5. Durably persist NOW — before the player watches the replay — so closing
  //    or crashing mid-replay never loses the round. saveSp early-returns on
  //    game over (the game-over cleanup path persists the completed game
  //    instead); saveCampaign is gated by the caller on !gameOver + non-conductor.
  saveSp();
  saveCampaign();

  return { prevScore, roundPhase };
}
