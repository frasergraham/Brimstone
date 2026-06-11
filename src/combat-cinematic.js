// Shared 3D combat cinematic orchestrator.
//
// Lifted out of src/main.js `_run3DCombatCardHold` so both the live game and
// the admin combat tester (src/tools/combat-tester.js) drive the dice/total
// readout the same way. The function is renderer/state-agnostic: callers
// inject the Renderer3D, the live GameState, a redraw callback, an optional
// Continue-button gate, and the result-floaters callback that follows the
// readout fade.
//
// Sequence (mirrors the previous in-file body byte-for-byte):
//   1. ally half-lunges from breakdown.atkAllyIds / defAllyIds
//   2. holdPunchAtImpact — freeze the attacker's strike pose
//   3. spawn attacker + defender combat readouts (numbered cards)
//   4. await the readout final-state, then reveal the Continue button
//   5. waitForAnimations drains the readout stack-up / hold / fade
//   6. outcome cue + resumePunch + reaction clip
//   7. result floaters (damage flashes, fade-out, splash)
//
// All optional renderer methods are guarded so a partial mock (used by
// the combat tester's renderer hooks and by unit tests) won't crash.

/**
 * @param {object} opts
 * @param {object} opts.renderer        Live Renderer3D instance
 * @param {object} opts.state           GameState (used to look up ally entities)
 * @param {object} opts.actorSnap       Attacker snapshot (id, col, row, owner, type, title?)
 * @param {object} opts.targetSnap      Defender snapshot (same shape)
 * @param {object} opts.result          executeBattle() result
 * @param {Function} opts.redrawFn      Forced redraw between phases
 * @param {Function} [opts.getContinueButton]  () => HTMLButtonElement|null — the
 *        button whose click advances past the readout. Hidden until both
 *        readouts reach final-state. Omit to skip the gate (auto-advance).
 * @param {Function} [opts.playBattleResultAnims]  (actorSnap, targetSnap, result, redrawFn)
 *        Called after the punch / reaction clip resolve, to play HP floaters,
 *        death bursts, splash rings, etc. main.js passes its own helper here.
 */
/** G1 v2 — countdown auto-click for the Continue button.
 *
 * The button starts hidden; `run3DCombatCardHold` reveals it the moment both
 * combat readouts reach their final state. Once visible, this helper watches
 * for the reveal, labels the button "Continue (N) ▶", ticks N down once a
 * second, and fires `onAutoClick()` at N == 0 unless the user clicked first.
 *
 * Hover pauses the countdown; mouseleave resumes from the held value. The
 * cleanup function returned by this helper:
 *   - clears any pending timers,
 *   - restores the original label,
 *   - detaches the hover listeners.
 *
 * Cleanup is idempotent. Safe to call from a click handler before the
 * countdown has started ticking. Tolerates a DOM-less environment by
 * no-opping when `button` is missing.
 *
 * Visible for tests via the named export.
 */
export const CONTINUE_COUNTDOWN_SEC = 3;
export const CONTINUE_BTN_BASE_LABEL = 'Continue';

export function startContinueCountdown(button, onAutoClick, opts = {}) {
  if (!button) return () => {};
  const totalSec       = Number.isFinite(opts.totalSec)       ? opts.totalSec
    : CONTINUE_COUNTDOWN_SEC;
  const setIntervalFn  = opts.setIntervalFn  || ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const setTimeoutFn   = opts.setTimeoutFn   || ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const isHiddenFn = opts.isHidden ?? ((el) => !!el.hidden);

  const originalLabel = button.textContent;
  let remaining = totalSec;
  let tickHandle = null;
  let waitHandle = null;
  let hovered = false;
  let cleaned = false;

  const renderLabel = () => {
    button.textContent = `${CONTINUE_BTN_BASE_LABEL} (${Math.max(0, remaining)})`;
  };
  const onTick = () => {
    if (hovered) return;
    remaining -= 1;
    renderLabel();
    if (remaining <= 0) {
      if (tickHandle != null) { clearIntervalFn(tickHandle); tickHandle = null; }
      // Defer onAutoClick to a microtask so cleanup runs in tests' synchronous
      // flow even when the timer fires immediately.
      try { onAutoClick(); } catch {}
    }
  };
  const startTicking = () => {
    if (tickHandle != null) return;
    renderLabel();
    tickHandle = setIntervalFn(onTick, 1000);
  };
  const waitForReveal = () => {
    if (!isHiddenFn(button)) { startTicking(); return; }
    waitHandle = setTimeoutFn(waitForReveal, 50);
  };
  const onEnter = () => { hovered = true; };
  const onLeave = () => { hovered = false; };
  button.addEventListener('mouseenter', onEnter);
  button.addEventListener('mouseleave', onLeave);
  waitForReveal();

  return function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (tickHandle != null) { clearIntervalFn(tickHandle); tickHandle = null; }
    if (waitHandle != null) { clearTimeoutFn(waitHandle); waitHandle = null; }
    button.removeEventListener('mouseenter', onEnter);
    button.removeEventListener('mouseleave', onLeave);
    button.textContent = originalLabel;
  };
}

export async function run3DCombatCardHold({
  renderer, state,
  actorSnap, targetSnap, result, redrawFn,
  getContinueButton,
  playBattleResultAnims,
}) {
  // G2 — position the cluster before the strike freezes: defender re-centres
  // on its hex, the first ADVANTAGE_CAP allies per side slide to the edge they
  // share with the defender's hex, and allies beyond the cap stay put. The
  // attacker is excluded — the caller already kicked off its addLungeAnim via
  // `_playAttackIntroAnim`. Allies are looked up in state by id so the helper
  // gets accurate current hexes (mid-step moves landed already).
  const bd = result?.breakdown || {};
  const atkAllyIds = Array.isArray(bd.atkAllyIds) ? bd.atkAllyIds : [];
  const defAllyIds = Array.isArray(bd.defAllyIds) ? bd.defAllyIds : [];
  const lookupAlly = (id) => {
    if (id === actorSnap.id || id === targetSnap.id) return null;
    const ally = state?.entities?.find(e => e.id === id && e.alive);
    return ally ? { id, col: ally.col, row: ally.row } : null;
  };
  if (typeof renderer.applyCombatPositioning === 'function') {
    // Centre the defender cluster on the defender's LIVE hex, not its pre-move
    // battle snapshot — a unit that moved this turn before being attacked would
    // otherwise warp back to its turn-start hex for the readout then slide back.
    // The attacker lunge already tracks the live hex; this keeps them together.
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
      // Cinematic uses the standard lunge duration so the cluster settles in
      // step with the attacker's lunge.
      { durMs: 400 },
    );
  }
  renderer.holdPunchAtImpact?.();

  // Resolve the Continue-button gate eagerly so both readouts share one promise.
  // G1 v2: also runs a 5-second countdown — the label ticks down each second
  // and the button auto-clicks at 0 if the player hasn't tapped already. The
  // countdown is paused while the cursor hovers (operator-okay-to-skip; cheap
  // to add and welcome on accidentally framed combats).
  const continueBtn = typeof getContinueButton === 'function' ? getContinueButton() : null;
  let cancelCountdown = null;
  const continueGate = continueBtn
    ? new Promise(resolve => {
        const cleanup = () => {
          if (cancelCountdown) { cancelCountdown(); cancelCountdown = null; }
        };
        const onClick = () => { cleanup(); resolve(); };
        continueBtn.addEventListener('click', onClick, { once: true });
        cancelCountdown = startContinueCountdown(continueBtn, () => {
          continueBtn.removeEventListener('click', onClick);
          cleanup();
          resolve();
        });
      })
    : Promise.resolve();

  if (typeof renderer.addCombatReadout === 'function') {
    // G1 redesign — the combat card was replaced by a single big-number
    // readout per combatant. Pass attacker/target hex coords so the renderer
    // can push each number to the OUTER side of its combatant along the
    // attack axis (prevents the two readouts from stacking in screen space
    // at melee range).
    const axis = {
      attackerCol: actorSnap.col,  attackerRow: actorSnap.row,
      targetCol:   targetSnap.col, targetRow:   targetSnap.row,
    };
    const readoutOpts = { ...axis, awaitContinueFn: () => continueGate };
    const atkH = renderer.addCombatReadout(actorSnap.id,  'attacker', result, readoutOpts);
    const defH = renderer.addCombatReadout(targetSnap.id, 'defender', result, readoutOpts);

    // G1 — paint each gang-up ally's icon with the d6 face value they
    // contributed. Each die corresponds to a single ally in the same order
    // as atkAllyIds / defAllyIds (executeBattle zips them). Each ally
    // readout fades along with the main readouts when the Continue gate
    // resolves.
    if (typeof renderer.addAllyDieReadout === 'function') {
      const atkAllyDice = Array.isArray(bd.atkAllyDice) ? bd.atkAllyDice : [];
      const defAllyDice = Array.isArray(bd.defAllyDice) ? bd.defAllyDice : [];
      for (const { allyId, die } of atkAllyDice) {
        if (allyId === actorSnap.id || allyId === targetSnap.id) continue;
        renderer.addAllyDieReadout(allyId, 'attacker', die, { awaitContinueFn: () => continueGate });
      }
      for (const { allyId, die } of defAllyDice) {
        if (allyId === actorSnap.id || allyId === targetSnap.id) continue;
        renderer.addAllyDieReadout(allyId, 'defender', die, { awaitContinueFn: () => continueGate });
      }
    }

    // Show the Continue button the moment BOTH readouts reach final state.
    Promise.all([
      typeof atkH?.awaitFinal === 'function' ? atkH.awaitFinal() : Promise.resolve(),
      typeof defH?.awaitFinal === 'function' ? defH.awaitFinal() : Promise.resolve(),
    ]).then(() => {
      if (continueBtn) continueBtn.hidden = false;
    });
  }
  // Hold while the readout is up — the punch stays paused at impact, allies
  // stay parked at their half-lunge position. waitForAnimations drains the
  // readout stack-up/hold/fade and any ally lunge promises (already resolved).
  await renderer.waitForAnimations();
  if (continueBtn) continueBtn.hidden = true;
  // Resume the strike to completion (no-op resolve if nothing was frozen).
  await (renderer.resumePunch?.() ?? Promise.resolve());
  // G1: play the reaction clip on the shared skeleton AFTER the punch
  // resolves so the two clips don't fight. `hit` when damage landed,
  // `block` when the defender shrugged it off. The Promise resolves when
  // the clip ends (or immediately when not yet loaded — graceful fallback,
  // and the call kicks off the lazy import so the next combat has it).
  if (typeof renderer.playReactionAnim === 'function') {
    const kind = result?.hit ? 'hit' : 'block';
    // Pass the defender so the reaction plays on its OWN rig (paladin or
    // fallback), not just the paladin source.
    await renderer.playReactionAnim(kind, targetSnap?.id);
  }
  if (typeof playBattleResultAnims === 'function') {
    playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
  }
  await renderer.waitForAnimations();
}
