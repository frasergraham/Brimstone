// Combat-tester DOM wiring — owns the side panel, mounts the Renderer3D
// inside the tab's canvas pane, and forwards user actions to the
// controller in src/tools/combat-tester.js.
//
// The combat sequence MUST go through the real game code: executeBattle
// resolves the dice, run3DCombatCardHold plays the cinematic readout, and
// the renderer's animation queue handles the lunge / floaters / fade-out.

import { createCombatTester, battleWrapupPair, UNIT_FACTORIES, SPEED_MODES, ATTACK_MODES } from './combat-tester.js';
import { UNIT_TYPES } from '../unit-types.js';
import { ITEMS } from '../items.js';
import { rangeOf, getEquippedWeaponIdOf } from '../entities.js';
import { Renderer } from '../renderer.js';
import { Renderer3D, BLOCK_WORD_VARIANTS } from '../renderer-3d.js';
import { buildWrapupCombatsHtml, wrapupIconHtml, wrapupUnitCellHtml } from '../wrapup-summary.js';
import { run3DCombatCardHold } from '../combat-cinematic.js';
import { playFastCombatDisplay } from '../combat-fast.js';
import { parseCombatParams, withCombatParams } from './url-state.js';

// Picker options — leader / minion / construct / survivor types from the
// UNIT_TYPES registry, in display order. The labels match the in-game
// names so the operator picks "Paladin" rather than "paladin".
const PICKER_ORDER = [
  // hero-side leaders & grunts
  'paladin', 'rogue', 'captain', 'survivor', 'soldier',
  // witch-side leaders & grunts
  'witch', 'necromancer', 'brute', 'minion', 'wood_golem', 'iron_golem',
  // neutral
  'zombie',
];

const UNIT_LABELS = {
  paladin: 'Paladin (Hero)',
  rogue: 'Rogue',
  captain: 'Captain',
  survivor: 'Survivor',
  soldier: 'Soldier',
  witch: 'Witch',
  necromancer: 'Necromancer',
  brute: 'Brute',
  minion: 'Minion',
  wood_golem: 'Wood Golem',
  iron_golem: 'Iron Golem',
  zombie: 'Zombie',
};

function _opt(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function _buildPicker(includeBlank = true) {
  const sel = document.createElement('select');
  if (includeBlank) sel.appendChild(_opt('', '— pick a unit —'));
  for (const key of PICKER_ORDER) {
    if (!UNIT_TYPES[key] || !UNIT_FACTORIES[key]) continue;
    sel.appendChild(_opt(key, UNIT_LABELS[key] ?? key));
  }
  return sel;
}

function _renderAllies(host, side, slots, onRemove) {
  host.innerHTML = '';
  const list = side === 'attacker' ? slots.atkAllies : slots.defAllies;
  if (list.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'c-empty';
    empty.textContent = '(no allies)';
    host.appendChild(empty);
    return;
  }
  for (let i = 0; i < list.length; i++) {
    const chip = document.createElement('span');
    chip.className = 'c-chip';
    chip.textContent = UNIT_LABELS[list[i]] ?? list[i];
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'c-chip-x';
    x.textContent = '✕';
    x.title = 'Remove ally';
    x.addEventListener('click', () => onRemove(side, i));
    chip.appendChild(x);
    host.appendChild(chip);
  }
}

// Mirror main.js `_playBattleResultAnims` — damage floaters, death burst,
// fade-out. Splash effects intentionally omitted: the tester combatants
// sit on a clearing, so brute splash adds clutter without a useful read.
// Exported for unit tests (driven against a spy renderer).
export function playBattleResultAnims(renderer, actorSnap, targetSnap, result, redrawFn) {
  if (typeof renderer.addAttackAnim === 'function') {
    renderer.addAttackAnim(actorSnap.col, actorSnap.row, targetSnap.col, targetSnap.row);
  }
  // entityId opt activates the renderer's protectEntityId path: the standee
  // is flagged `_pendingDespawn=true` for the floater's lifetime, the next
  // _syncEntityStandees pass (triggered by redrawFn) skips its dispose, and
  // the floater's completion callback disposes the standee once the "-N"
  // finishes. Without this, the dying standee vanishes mid-rise and the
  // floater orphans in empty air.
  if (result?.damage && typeof renderer.addHpChangeFlash === 'function') {
    renderer.addHpChangeFlash(targetSnap.col, targetSnap.row, -(result.damage), { entityId: targetSnap.id });
  }
  if (result?.counterDmg && typeof renderer.addHpChangeFlash === 'function') {
    renderer.addHpChangeFlash(actorSnap.col, actorSnap.row, -(result.counterDmg), { entityId: actorSnap.id });
  }
  if (result?.killed) {
    const deadColor = targetSnap.owner === 'hero' ? '#d4a72c' : '#9b59b6';
    if (typeof renderer.playDeathAnimAndFade === 'function') {
      renderer.playDeathAnimAndFade(targetSnap.id, targetSnap.col, targetSnap.row, deadColor);
    } else {
      // Legacy fallback (older renderer without the combined method).
      renderer.addDeathAnim?.(targetSnap.col, targetSnap.row, deadColor);
      renderer.addFadeOutAnim?.(targetSnap.id, 600);
    }
  }
  redrawFn?.();
}

// Speed-branched combat display: cinematic runs the readout + Continue gate
// (run3DCombatCardHold); fast / vfast skip the readout entirely through the
// shared playFastCombatDisplay helper the live game also uses. Extracted from
// runBattle (and exported) so the branch is unit-testable with injected
// display functions — `fastFn` / `cinematicFn` / `randomFn` / `delayFn`
// default to the real implementations.
export async function playCombatDisplay({
  speed, renderer, state, actorSnap, targetSnap, result,
  redrawFn, getContinueButton, playAnims,
  fastFn = playFastCombatDisplay,
  cinematicFn = run3DCombatCardHold,
  randomFn = Math.random,
  // Tester runs outside the live playback machinery — a plain setTimeout
  // matches the in-game delay without depending on src/playback.js's
  // mode gating.
  delayFn = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  if (speed === 'fast' || speed === 'vfast') {
    const missText = !result.hit
      ? BLOCK_WORD_VARIANTS[Math.floor(randomFn() * BLOCK_WORD_VARIANTS.length)]
      : null;
    return fastFn({
      renderer, state, actorSnap, targetSnap, result,
      playBattleResultAnims: (a, t, r) => playAnims(a, t, r, redrawFn),
      speed, missText,
      playbackDelay: delayFn,
    });
  }
  return cinematicFn({
    renderer, state, actorSnap, targetSnap, result,
    redrawFn, getContinueButton,
    playBattleResultAnims: (a, t, r, rd) => playAnims(a, t, r, rd),
  });
}

// Fire the lunge / projectile intro animation against the snapshots. Same
// dispatch rule as main.js — ranged units use a projectile, melee uses a
// lunge.
function _playAttackIntro(renderer, actorSnap, targetSnap) {
  const isRanged = (actorSnap?.range ?? 1) > 1;
  if (isRanged && typeof renderer.addProjectileAnim === 'function') {
    const projectileType = ITEMS[actorSnap.weapon]?.projectileType ?? 'sparkle';
    renderer.addProjectileAnim(projectileType, actorSnap.col, actorSnap.row,
      targetSnap.col, targetSnap.row, { owner: actorSnap.owner });
  } else if (typeof renderer.addLungeAnim === 'function') {
    renderer.addLungeAnim(actorSnap.id,
      actorSnap.col, actorSnap.row, targetSnap.col, targetSnap.row,
      actorSnap.type, actorSnap.owner, actorSnap.title ?? null);
  }
}

/**
 * Boot the Combat tester tab. Builds the side panel into #c-controls,
 * mounts a Renderer3D into #c-render-canvas, and returns the standard
 * `{ pause, resume }` lifecycle handle the tab shell expects.
 *
 * @param {Document} doc — usually `document`. Passed in for testability.
 * @returns {Promise<{pause: Function, resume: Function}>}
 */
export async function initCombat(doc = document) {
  const stageEl     = doc.getElementById('c-stage');
  const canvasEl    = doc.getElementById('c-render-canvas');
  const controlsEl  = doc.getElementById('c-controls');
  const continueBtn = doc.getElementById('c-continue-btn');
  if (!canvasEl || !controlsEl) {
    return { pause() {}, resume() {} };
  }

  const tester = createCombatTester();

  // ── Side panel DOM ────────────────────────────────────────────────────
  controlsEl.innerHTML = '';
  const h2 = doc.createElement('h2');
  h2.textContent = 'Combat Tester';
  controlsEl.appendChild(h2);

  // Section: Attacker / Defender pickers
  const sec1 = doc.createElement('div');
  sec1.className = 'c-section';
  sec1.innerHTML = '<h3>Combatants</h3>';
  controlsEl.appendChild(sec1);

  const atkRow = doc.createElement('div'); atkRow.className = 'c-row';
  const atkLabel = doc.createElement('label'); atkLabel.textContent = 'Attacker';
  const atkSel = _buildPicker();
  atkRow.append(atkLabel, atkSel);
  sec1.appendChild(atkRow);

  const defRow = doc.createElement('div'); defRow.className = 'c-row';
  const defLabel = doc.createElement('label'); defLabel.textContent = 'Defender';
  const defSel = _buildPicker();
  defRow.append(defLabel, defSel);
  sec1.appendChild(defRow);

  // Section: Allies
  const sec2 = doc.createElement('div');
  sec2.className = 'c-section';
  sec2.innerHTML = '<h3>Allies (gang-up)</h3>';
  controlsEl.appendChild(sec2);

  const atkSideLabel = doc.createElement('div');
  atkSideLabel.className = 'c-side-label';
  atkSideLabel.textContent = 'Attacker side';
  sec2.appendChild(atkSideLabel);

  const atkAlliesEl = doc.createElement('div');
  atkAlliesEl.className = 'c-allies';
  sec2.appendChild(atkAlliesEl);

  const atkAddRow = doc.createElement('div'); atkAddRow.className = 'c-add-row';
  const atkAddSel = _buildPicker();
  const atkAddBtn = doc.createElement('button');
  atkAddBtn.type = 'button'; atkAddBtn.textContent = 'Add';
  atkAddRow.append(atkAddSel, atkAddBtn);
  sec2.appendChild(atkAddRow);

  const defSideLabel = doc.createElement('div');
  defSideLabel.className = 'c-side-label';
  defSideLabel.textContent = 'Defender side';
  sec2.appendChild(defSideLabel);

  const defAlliesEl = doc.createElement('div');
  defAlliesEl.className = 'c-allies';
  sec2.appendChild(defAlliesEl);

  const defAddRow = doc.createElement('div'); defAddRow.className = 'c-add-row';
  const defAddSel = _buildPicker();
  const defAddBtn = doc.createElement('button');
  defAddBtn.type = 'button'; defAddBtn.textContent = 'Add';
  defAddRow.append(defAddSel, defAddBtn);
  sec2.appendChild(defAddRow);

  // Section: Attack type picker (melee / ranged). Ranged moves the defender
  // out to distance 3 and forces the attacker's range so executeBattle
  // routes through its ranged branch (no gang-up, no counter, point-blank
  // disadvantage if dist <= 1). Default melee.
  const secMode = doc.createElement('div');
  secMode.className = 'c-section';
  secMode.innerHTML = '<h3>Attack type</h3>';
  controlsEl.appendChild(secMode);

  const modeRow = doc.createElement('div');
  modeRow.className = 'c-speed-row';
  const modeBtns = {};
  const MODE_LABELS = { melee: 'Melee', ranged: 'Ranged' };
  for (const mode of ATTACK_MODES) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'c-speed-btn';
    b.dataset.attackMode = mode;
    b.textContent = MODE_LABELS[mode] ?? mode;
    b.addEventListener('click', () => tester.setAttackMode(mode));
    modeBtns[mode] = b;
    modeRow.appendChild(b);
  }
  secMode.appendChild(modeRow);

  // Section: Speed mode picker (3-button group). Mirrors the in-game
  // cinematic / fast / vfast modes. Cinematic runs the dice-card readout +
  // Continue gate; fast / vfast skip the readout entirely and use the
  // shared playFastCombatDisplay helper that the live game also uses.
  const secSpeed = doc.createElement('div');
  secSpeed.className = 'c-section';
  secSpeed.innerHTML = '<h3>Display speed</h3>';
  controlsEl.appendChild(secSpeed);

  const speedRow = doc.createElement('div');
  speedRow.className = 'c-speed-row';
  const speedBtns = {};
  const SPEED_LABELS = { cinematic: 'Cinematic', fast: 'Fast', vfast: 'Very Fast' };
  for (const mode of SPEED_MODES) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'c-speed-btn';
    b.dataset.speed = mode;
    b.textContent = SPEED_LABELS[mode] ?? mode;
    b.addEventListener('click', () => tester.setSpeedMode(mode));
    speedBtns[mode] = b;
    speedRow.appendChild(b);
  }
  secSpeed.appendChild(speedRow);

  // Section: Actions
  const sec3 = doc.createElement('div');
  sec3.className = 'c-section';
  sec3.innerHTML = '<h3>Actions</h3>';
  controlsEl.appendChild(sec3);

  const runBtn   = doc.createElement('button');
  runBtn.type = 'button'; runBtn.className = 'c-action';
  runBtn.textContent = 'Run Battle Round';
  const swapBtn  = doc.createElement('button');
  swapBtn.type = 'button'; swapBtn.className = 'c-action';
  swapBtn.textContent = 'Swap Roles';
  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button'; resetBtn.className = 'c-action';
  resetBtn.textContent = 'Reset';
  const randomizeBtn = doc.createElement('button');
  randomizeBtn.type = 'button'; randomizeBtn.className = 'c-action';
  randomizeBtn.textContent = 'Randomize Allies';
  sec3.append(runBtn, swapBtn, resetBtn, randomizeBtn);

  // Section: log
  const sec4 = doc.createElement('div');
  sec4.className = 'c-section';
  sec4.innerHTML = '<h3>Combat log</h3>';
  controlsEl.appendChild(sec4);
  const logEl = doc.createElement('div');
  logEl.id = 'c-log';
  sec4.appendChild(logEl);

  // Portrait lookup for the wrap-up summary cells — same asset-id rule as
  // ui.js (survivors resolve via their title, everything else maps 1:1).
  function _summaryIconFor(u, size) {
    const assetId = (u.type === 'survivor' && u.title)
      ? Renderer.survivorAssetId(u.title) : u.type;
    const src = assetId ? renderer.getPortraitDataURL(assetId, size) : null;
    return wrapupIconHtml(u, { src });
  }

  function appendLog(out) {
    const entry = doc.createElement('div');
    entry.className = 'c-log-entry';

    // Wrap-up battle summary — the same [icon] vs [icon] element the game's
    // end-of-turn card shows, with splash victims as extra skull cells.
    const summary = doc.createElement('div');
    summary.className = 'c-log-summary';
    let summaryHtml = buildWrapupCombatsHtml([battleWrapupPair(out)], _summaryIconFor);
    const splashKilled = out.result.splashKills ?? [];
    if (splashKilled.length) {
      const cells = splashKilled
        .map(k => wrapupUnitCellHtml({ ...k, hpLost: 0, killed: true },
          _summaryIconFor({ ...k, title: null }, 56)))
        .join('');
      summaryHtml += `<div class="wrapup-casualties">${cells}</div>`;
    }
    summary.innerHTML = summaryHtml;
    entry.appendChild(summary);

    const head = doc.createElement('div');
    head.className = 'c-log-head';
    const atkName = UNIT_LABELS[out.attackerSnap.type] ?? out.attackerSnap.type;
    const defName = UNIT_LABELS[out.defenderSnap.type] ?? out.defenderSnap.type;
    head.textContent = `${atkName} → ${defName} · roll ${out.result.attackRoll ?? '?'} vs ${out.result.defenseRoll ?? '?'}`;
    entry.appendChild(head);
    for (const line of (out.result.log ?? [])) {
      const li = doc.createElement('div');
      li.textContent = `· ${line}`;
      entry.appendChild(li);
    }
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── Renderer3D mount ──────────────────────────────────────────────────
  const renderer = new Renderer3D(canvasEl, tester.state);
  // Absolute base — admin-tools.html is served from /admin/tools, so the
  // default `'assets'` would 404. Mirrors initLighting().
  renderer.beginLoad('/assets');
  await _waitForRenderer(renderer);

  function redraw() { renderer.draw?.(); }

  // Re-draw whenever the layout mutates so newly-placed entities get
  // meshes spawned (and stale ones disposed).
  tester.onChange(() => { redraw(); });
  // Initial draw.
  redraw();

  // ── Picker wiring ─────────────────────────────────────────────────────
  function refreshChips() {
    _renderAllies(atkAlliesEl, 'attacker', tester.slots, tester.removeAlly);
    _renderAllies(defAlliesEl, 'defender', tester.slots, tester.removeAlly);
  }
  function refreshPickers() {
    atkSel.value = tester.slots.attacker ?? '';
    defSel.value = tester.slots.defender ?? '';
  }
  function refreshSpeed() {
    for (const mode of SPEED_MODES) {
      const b = speedBtns[mode];
      if (!b) continue;
      const active = tester.speedMode === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
  function refreshAttackMode() {
    for (const mode of ATTACK_MODES) {
      const b = modeBtns[mode];
      if (!b) continue;
      const active = tester.attackMode === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
  function refreshRandomize() {
    const hasAllies =
      tester.slots.atkAllies.length + tester.slots.defAllies.length > 0;
    randomizeBtn.disabled = !hasAllies;
  }
  function refreshAll() {
    refreshPickers();
    refreshChips();
    refreshSpeed();
    refreshAttackMode();
    refreshRandomize();
  }

  atkSel.addEventListener('change', () => tester.setAttacker(atkSel.value || null));
  defSel.addEventListener('change', () => tester.setDefender(defSel.value || null));
  atkAddBtn.addEventListener('click', () => {
    if (!atkAddSel.value) return;
    tester.addAlly('attacker', atkAddSel.value);
    atkAddSel.value = '';
  });
  defAddBtn.addEventListener('click', () => {
    if (!defAddSel.value) return;
    tester.addAlly('defender', defAddSel.value);
    defAddSel.value = '';
  });

  tester.onChange(refreshAll);
  refreshAll();

  // ── URL ⇄ slots sync ──────────────────────────────────────────────────
  // Every slot change writes the current config to `location.search` via
  // history.replaceState so the URL stays bookmarkable. On first load we
  // pull the URL into the controller (unknown unit keys are dropped).
  let applyingFromUrl = false;
  function writeUrl() {
    if (applyingFromUrl) return;
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    const slots = tester.slots;
    const patch = {
      atk:       slots.attacker || null,
      def:       slots.defender || null,
      atkAllies: slots.atkAllies.slice(),
      defAllies: slots.defAllies.slice(),
      speed:     tester.speedMode,
      mode:      tester.attackMode,
    };
    const next = withCombatParams(location.search, patch);
    const url = `${location.pathname}${next}${location.hash || ''}`;
    try { history.replaceState(null, '', url); } catch {}
  }
  tester.onChange(writeUrl);

  if (typeof location !== 'undefined') {
    applyingFromUrl = true;
    try {
      const cfg = parseCombatParams(location.search, (k) => k in UNIT_FACTORIES);
      if (cfg.atk) tester.setAttacker(cfg.atk);
      if (cfg.def) tester.setDefender(cfg.def);
      for (const a of cfg.atkAllies) tester.addAlly('attacker', a);
      for (const a of cfg.defAllies) tester.addAlly('defender', a);
      if (cfg.speed) tester.setSpeedMode(cfg.speed);
      if (cfg.mode) tester.setAttackMode(cfg.mode);
    } finally {
      applyingFromUrl = false;
    }
    // Normalise the URL: if the original carried stale unit keys, this writes
    // back the cleaned-up form.
    writeUrl();
  }

  // ── Action buttons ────────────────────────────────────────────────────
  let battleInFlight = false;

  async function runBattle() {
    if (battleInFlight) return;
    if (!tester.layout?.attackerEntity || !tester.layout?.defenderEntity) return;
    battleInFlight = true;
    runBtn.disabled = true;
    swapBtn.disabled = true;
    resetBtn.disabled = true;
    try {
      // Snapshot positions BEFORE executeBattle mutates HP / removes dead.
      const atkEntity = tester.layout.attackerEntity;
      const defEntity = tester.layout.defenderEntity;
      const actorSnap = _snap(atkEntity);
      const targetSnap = _snap(defEntity);

      // 1. Lunge / projectile intro — kicks off before the dice resolve so
      //    the cinematic's holdPunchAtImpact can freeze the strike (cinematic
      //    mode); in fast / vfast it just plays as the visible attack motion.
      _playAttackIntro(renderer, actorSnap, targetSnap);

      // 2. Resolve combat through the real executeBattle.
      const out = tester.runBattle();
      if (!out) return;

      // 3. Branch on speed: cinematic runs the readout + Continue gate;
      //    fast / vfast skip the readout entirely (shared with live game).
      await playCombatDisplay({
        speed: tester.speedMode,
        renderer,
        state: tester.state,
        actorSnap, targetSnap, result: out.result,
        redrawFn: redraw,
        getContinueButton: () => continueBtn,
        playAnims: (a, t, r, rd) => playBattleResultAnims(renderer, a, t, r, rd),
      });

      // 4. Return any lunge anims to rest so the next battle starts clean.
      renderer.returnAllLungeAnims?.();
      redraw();

      // 5. Append the log entry — outcome + per-line breakdown.
      appendLog(out);
    } catch (err) {
      console.error('[combat-tester] battle failed:', err);
    } finally {
      battleInFlight = false;
      runBtn.disabled = false;
      swapBtn.disabled = false;
      resetBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', runBattle);
  swapBtn.addEventListener('click', () => {
    tester.swapRoles();
  });
  resetBtn.addEventListener('click', () => {
    tester.reset();
    logEl.innerHTML = '';
  });
  randomizeBtn.addEventListener('click', () => {
    tester.randomizeAllies();
  });

  // ── Lifecycle handle ──────────────────────────────────────────────────
  return {
    pause() {
      try { renderer._engine?.stopRenderLoop(); } catch {}
    },
    resume() {
      try {
        renderer._engine?.stopRenderLoop();
        renderer._engine?.runRenderLoop(() => renderer._scene?.render());
        renderer._engine?.resize();
      } catch {}
    },
  };
}

function _snap(e) {
  return {
    id: e.id, col: e.col, row: e.row,
    owner: e.owner, type: e.type, title: e.title ?? null,
    range: rangeOf(e),
    weapon: getEquippedWeaponIdOf(e.items),
  };
}

// Wait for Renderer3D's lazy Babylon import to populate _scene + lights.
// Mirrors the same helper used by initLighting in admin-tools.html.
async function _waitForRenderer(renderer) {
  for (let i = 0; i < 60; i++) {
    if (renderer._scene && renderer._light && renderer._sunLight) return;
    await new Promise(r => setTimeout(r, 100));
  }
}
