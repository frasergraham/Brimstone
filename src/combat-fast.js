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
  renderer, actorSnap, targetSnap, result,
  playBattleResultAnims, speed, missText,
  playbackDelay,
}) {
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
