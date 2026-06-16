// Shared "fast" / "vfast" combat-display helper.
//
// Lifted out of src/main.js so the live game and the admin combat tester
// drive the no-modal fast presentation through the same code path. The
// helper is renderer/state-agnostic: callers inject the Renderer3D, the
// pre-bound result-floater callback, the speed mode, an already-picked
// miss-flavour word (or null when result.hit), and a playbackDelay so the
// live game retains its playback-aware timing while the tester can use a
// plain setTimeout.
//
// Sequence (mirrors the previous inline body byte-for-byte):
//   1. On a miss: paint the BLOCK_WORD_VARIANTS flavour flash on the target hex
//      (the cinematic readout shows the same word set on its block side, so
//      fast + vfast + cinematic communicate "didn't connect" identically).
//   2. Fire the result floaters (damage flash, counter-damage flash, death
//      burst, fade-out) via the injected callback.
//   3. Wait — 200 ms in vfast, 400 ms in fast — so floaters from different
//      battles don't pile up on the same hex.

const MISS_FLASH_BG   = 'rgba(100,100,100,0.1)';
const MISS_FLASH_DUR  = 1000;
const MISS_FLASH_ZOOM = 0.65;
const MISS_FLASH_FG   = '#888';

// Summary (fast) readout pacing — the final-total readout holds this long
// after the outcome flash before fading. Speedy (vfast) skips readouts.
const FAST_READOUT_HOLD_MS  = 800;
const FAST_READOUT_BASE_MS  = 200; // total in side colour before the outcome flash
const FAST_READOUT_FINAL_MS = 150;
const FAST_READOUT_FADE_MS  = 300;

/**
 * @param {object} opts
 * @param {object} opts.renderer        Live Renderer3D instance
 * @param {object} [opts.state]         GameState — used to look up ally entity
 *        positions for the G2 cluster positioning. Optional for back-compat,
 *        but without it the positioning step is skipped.
 * @param {object} opts.actorSnap       Attacker snapshot (id, col, row, owner, type, title?)
 * @param {object} opts.targetSnap      Defender snapshot (same shape)
 * @param {object} opts.result          executeBattle() result
 * @param {Function} opts.playBattleResultAnims (actorSnap, targetSnap, result)
 *        Pre-bound floater callback. main.js wraps its in-file helper so the
 *        closure's redrawFn is captured; the tester wraps its own.
 * @param {'fast'|'vfast'} opts.speed
 * @param {string|null} opts.missText   Pre-picked miss flavour word. Caller
 *        supplies it only when the result is a miss (matches main.js's prior
 *        Math.random() consumption); helper paints the flash iff non-null
 *        AND `!result.hit`.
 * @param {Function} opts.playbackDelay (ms) => Promise — injected so the live
 *        game keeps its replay-aware playbackDelay() while the tester uses
 *        a plain setTimeout.
 */
export async function playFastCombatDisplay({
  renderer, state, actorSnap, targetSnap, result,
  playBattleResultAnims, speed, missText,
  playbackDelay,
}) {
  // G2 — same spatial choreography as cinematic (defender re-centre + allies
  // slide to the shared edge of the defender's hex, capped at ADVANTAGE_CAP),
  // just with a compressed duration so it lands inside the fast/vfast window.
  // The attacker is already lunging via the caller's _playAttackIntroAnim;
  // positioning fires for defender + allies only. Skipped on rangged battles
  // where the breakdown has no ally arrays (executeBattle empties them).
  if (typeof renderer.applyCombatPositioning === 'function') {
    const bd = result?.breakdown || {};
    const atkAllyIds = Array.isArray(bd.atkAllyIds) ? bd.atkAllyIds : [];
    const defAllyIds = Array.isArray(bd.defAllyIds) ? bd.defAllyIds : [];
    const lookupAlly = (id) => {
      if (id === actorSnap.id || id === targetSnap.id) return null;
      const ally = state?.entities?.find(e => e.id === id && e.alive);
      return ally ? { id, col: ally.col, row: ally.row } : null;
    };
    // Centre on the defender's LIVE hex (mid-turn moves landed), not its
    // pre-move battle snapshot — otherwise a unit that moved this turn warps
    // back to its turn-start hex for the readout, then slides back.
    const liveDef = state?.entities?.find(e => e.id === targetSnap.id && e.alive);
    // The attacker's live hex reserves its edge of the defender's hex so no
    // ally is assigned the spot the attacker's lunge freezes on.
    const liveAtk = state?.entities?.find(e => e.id === actorSnap.id && e.alive);
    renderer.applyCombatPositioning(
      {
        defender: { id: targetSnap.id, col: liveDef?.col ?? targetSnap.col, row: liveDef?.row ?? targetSnap.row },
        attacker: { id: actorSnap.id, col: liveAtk?.col ?? actorSnap.col, row: liveAtk?.row ?? actorSnap.row },
        attackAllies:  atkAllyIds.map(lookupAlly).filter(Boolean),
        defenseAllies: defAllyIds.map(lookupAlly).filter(Boolean),
      },
      { durMs: speed === 'vfast' ? 200 : 400 },
    );
  }
  // Summary (fast) keeps the cinematic mode's final-score readout over each
  // combatant's icon — but with summaryOnly set, so the icon flips straight
  // to the side's final total (no dice stack-up, no Continue gate) and the
  // defender shows its HIT/BLOCKED/… result label. The readout promises
  // register with the renderer's anim tracker, so the caller's
  // waitForAnimations() paces the hold. Speedy (vfast) stays readout-free.
  const showReadouts = speed === 'fast'
    && typeof renderer.addCombatReadout === 'function';
  if (showReadouts) {
    const readoutOpts = {
      summaryOnly: true,
      attackerCol: actorSnap.col,  attackerRow: actorSnap.row,
      targetCol:   targetSnap.col, targetRow:   targetSnap.row,
      baseHoldMs: FAST_READOUT_BASE_MS, stepMs: 0,
      finalHoldMs: FAST_READOUT_FINAL_MS, fadeMs: FAST_READOUT_FADE_MS,
      awaitContinueFn: () => new Promise(r => setTimeout(r, FAST_READOUT_HOLD_MS)),
    };
    renderer.addCombatReadout(actorSnap.id,  'attacker', result, readoutOpts);
    renderer.addCombatReadout(targetSnap.id, 'defender', result, readoutOpts);
  }
  // The defender readout's result label already says BLOCKED/dodged/…, so the
  // hex flash only fires when no readout is shown (vfast, or a 2D renderer).
  if (!result?.hit && missText && !showReadouts) {
    renderer.addFlash(
      targetSnap.col, targetSnap.row,
      missText,
      MISS_FLASH_BG, MISS_FLASH_DUR, MISS_FLASH_ZOOM, MISS_FLASH_FG,
    );
  }
  if (typeof playBattleResultAnims === 'function') {
    playBattleResultAnims(actorSnap, targetSnap, result);
  }
  await playbackDelay(speed === 'vfast' ? 200 : 400);
}
