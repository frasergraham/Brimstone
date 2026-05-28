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
export async function run3DCombatCardHold({
  renderer, state,
  actorSnap, targetSnap, result, redrawFn,
  getContinueButton,
  playBattleResultAnims,
}) {
  // G1 — fire ally half-lunges so gang-up participants visibly join the
  // strike before the punch freezes. Allies read from result.breakdown
  // (set by executeBattle); ranged attacks intentionally have empty arrays.
  // Skip allies that are the attacker/defender themselves (defensive — the
  // ID arrays should already exclude them).
  const bd = result?.breakdown || {};
  const atkAllyIds = Array.isArray(bd.atkAllyIds) ? bd.atkAllyIds : [];
  const defAllyIds = Array.isArray(bd.defAllyIds) ? bd.defAllyIds : [];
  if (typeof renderer.addAllyHalfLunge === 'function') {
    for (const id of atkAllyIds) {
      if (id === actorSnap.id || id === targetSnap.id) continue;
      const ally = state?.entities?.find(e => e.id === id && e.alive);
      if (!ally) continue;
      renderer.addAllyHalfLunge(id, ally.col, ally.row, targetSnap.col, targetSnap.row);
    }
    for (const id of defAllyIds) {
      if (id === actorSnap.id || id === targetSnap.id) continue;
      const ally = state?.entities?.find(e => e.id === id && e.alive);
      if (!ally) continue;
      // Defender's allies "brace" toward the attacker — same half-distance
      // visual but oriented to face the threat.
      renderer.addAllyHalfLunge(id, ally.col, ally.row, actorSnap.col, actorSnap.row);
    }
  }
  renderer.holdPunchAtImpact?.();

  // Resolve the Continue-button gate eagerly so both readouts share one promise.
  const continueBtn = typeof getContinueButton === 'function' ? getContinueButton() : null;
  const continueGate = continueBtn
    ? new Promise(resolve => {
        continueBtn.addEventListener('click', () => resolve(), { once: true });
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
  // G1: punch up winner/loser with a quick scale pop on the standees right as
  // the cards fade out. The cue plays in parallel with `resumePunch` so the
  // strike continues to follow through while the outcome reads.
  if (typeof renderer.addCombatOutcomeCue === 'function') {
    const winnerId = result?.hit ? actorSnap.id  : targetSnap.id;
    const loserId  = result?.hit ? targetSnap.id : actorSnap.id;
    renderer.addCombatOutcomeCue(winnerId, loserId);
  }
  // Resume the strike to completion (no-op resolve if nothing was frozen).
  await (renderer.resumePunch?.() ?? Promise.resolve());
  // G1: play the reaction clip on the shared skeleton AFTER the punch
  // resolves so the two clips don't fight. `hit` when damage landed,
  // `block` when the defender shrugged it off. The Promise resolves when
  // the clip ends (or immediately when not yet loaded — graceful fallback,
  // and the call kicks off the lazy import so the next combat has it).
  if (typeof renderer.playReactionAnim === 'function') {
    const kind = result?.hit ? 'hit' : 'block';
    await renderer.playReactionAnim(kind);
  }
  if (typeof playBattleResultAnims === 'function') {
    playBattleResultAnims(actorSnap, targetSnap, result, redrawFn);
  }
  await renderer.waitForAnimations();
}
