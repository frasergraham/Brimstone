// Shared 3D discovery cinematic orchestrator.
//
// The survivor/zombie discovery analogue of src/combat-cinematic.js. When a
// hidden survivor is revealed (or a zombie raised) in the 3D renderer, instead
// of the legacy Encounter Dialog modal we frame the camera on the discovered
// unit and float a billboarded "discovery readout" card above it, held until
// the player taps Continue (or a 5-second countdown auto-advances). Hovering
// the Continue button pauses the countdown — same idiom as the combat readout.
//
// Structure mirrors combat-cinematic.js: the renderer owns the card lifecycle
// (`Renderer3D.addDiscoveryReadout`), this module owns the camera framing and
// the Continue-button gate, and the caller (src/main.js) decides — per speed
// mode / 2D-vs-3D — whether to call this at all.
//
// Fast/vfast/autoplay never reach here (main.js gates on cinematic speed); the
// 2D renderer keeps the modal. When the renderer can't anchor the card (no
// standee yet), `runDiscoveryReadout` returns false so the caller falls back
// to the modal.

import { startContinueCountdown } from './combat-cinematic.js';

/** Continue-button countdown for discoveries — auto-advances after this many
 *  seconds unless the player taps (or hovers to pause). */
export const DISCOVERY_COUNTDOWN_SEC = 5;

/**
 * The discovery sentence shown on the card, by discovery method. Mirrors the
 * wording the 2D Encounter Dialog uses (src/ui.js `_showEncounterDialog`) so
 * the two presentations agree. Pure — `unit` only needs `type` and `name`.
 */
export function discoveryText(unit, method = 'explore') {
  const u = unit || {};
  if (u.type === 'zombie') {
    return 'A cowering survivor is found… raised as a zombie by the witch!';
  }
  const name = u.name || 'A survivor';
  const prefix = method === 'horn'
    ? "Drawn by the horn's call, "
    : method === 'power_node'
      ? 'Drawn to the power node, '
      : '';
  return prefix
    ? `${prefix}${name} steps from the shadows and joins the party!`
    : `${name} steps from the shadows and joins the party!`;
}

/**
 * Run the 3D discovery readout for one discovered entity.
 *
 * @param {object}   opts
 * @param {object}   opts.renderer           Live Renderer3D instance
 * @param {object}   [opts.state]            GameState (reserved; entity is passed directly)
 * @param {object}   opts.entity             The live discovered entity (needs `.id`)
 * @param {string}   opts.text               The discovery sentence (see discoveryText)
 * @param {Function} [opts.getContinueButton] () => HTMLButtonElement|null — the
 *        button whose click advances past the card. Hidden until the card
 *        settles, then revealed with a 5s auto-advance countdown.
 * @param {object}   [opts.frameOpts]        Extra opts for renderer.frameEntities
 * @returns {Promise<boolean>} true when the readout ran; false when the caller
 *        should fall back to the 2D modal (no 3D renderer, no live entity, or
 *        the card couldn't be anchored to a standee).
 */
export async function runDiscoveryReadout({
  renderer, state, entity, text, getContinueButton, frameOpts,
}) {
  if (!renderer || !renderer.is3D) return false;
  if (typeof renderer.addDiscoveryReadout !== 'function') return false;
  if (!entity || entity.id == null) return false;

  // Zoom the camera onto the discovered unit and await the move so the card
  // appears on a framed shot (mirrors the combat arm's frame-then-act order).
  if (typeof renderer.frameEntities === 'function') {
    try { await renderer.frameEntities([entity.id], { padding: 1.4, ...(frameOpts || {}) }); }
    catch { /* framing is best-effort; keep going */ }
  }

  // Continue-button gate (mirrors run3DCombatCardHold): a click resolves the
  // gate immediately; otherwise the countdown auto-advances at 0. The gate is
  // created up-front so it can be the card's `awaitContinueFn`, but the button
  // listeners are only wired once we know the card actually rendered.
  let resolveGate;
  const gate = new Promise(r => { resolveGate = r; });

  const handle = renderer.addDiscoveryReadout(entity, {
    text,
    awaitContinueFn: () => gate,
  });
  if (!handle || typeof handle.then !== 'function') {
    // Couldn't anchor the card — fall back to the modal. Nothing was wired
    // (no button listeners, gate never consumed), so just bail.
    return false;
  }

  const continueBtn = typeof getContinueButton === 'function' ? getContinueButton() : null;
  let cancelCountdown = null;
  if (continueBtn) {
    const cleanup = () => { if (cancelCountdown) { cancelCountdown(); cancelCountdown = null; } };
    const onClick = () => { cleanup(); resolveGate(); };
    continueBtn.addEventListener('click', onClick, { once: true });
    cancelCountdown = startContinueCountdown(continueBtn, () => {
      continueBtn.removeEventListener('click', onClick);
      cleanup();
      resolveGate();
    }, { totalSec: DISCOVERY_COUNTDOWN_SEC });
    // Reveal the button (and start the countdown — it waits for `hidden=false`)
    // once the card settles into its final state.
    Promise.resolve(typeof handle.awaitFinal === 'function' ? handle.awaitFinal() : null)
      .then(() => { continueBtn.hidden = false; });
  } else {
    // No button (headless / DOM-less): the card's own reveal hold is the only
    // pause before it fades.
    resolveGate();
  }

  await handle;
  if (continueBtn) continueBtn.hidden = true;
  return true;
}
