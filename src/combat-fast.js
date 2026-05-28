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
    renderer.applyCombatPositioning(
      {
        defender: { id: targetSnap.id, col: targetSnap.col, row: targetSnap.row },
        attackAllies:  atkAllyIds.map(lookupAlly).filter(Boolean),
        defenseAllies: defAllyIds.map(lookupAlly).filter(Boolean),
      },
      { durMs: speed === 'vfast' ? 200 : 400 },
    );
  }
  if (!result?.hit && missText) {
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
