// Combat-tester DOM wiring — owns the side panel, mounts the Renderer3D
// inside the tab's canvas pane, and forwards user actions to the
// controller in src/tools/combat-tester.js.
//
// The combat sequence MUST go through the real game code: executeBattle
// resolves the dice, run3DCombatCardHold plays the cinematic readout, and
// the renderer's animation queue handles the lunge / floaters / fade-out.

import { createCombatTester, UNIT_FACTORIES } from './combat-tester.js';
import { UNIT_TYPES } from '../unit-types.js';
import { Renderer3D } from '../renderer-3d.js';
import { run3DCombatCardHold } from '../combat-cinematic.js';
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
function _playBattleResultAnims(renderer, actorSnap, targetSnap, result, redrawFn) {
  if (typeof renderer.addAttackAnim === 'function') {
    renderer.addAttackAnim(actorSnap.col, actorSnap.row, targetSnap.col, targetSnap.row);
  }
  if (result?.damage && typeof renderer.addHpChangeFlash === 'function') {
    renderer.addHpChangeFlash(targetSnap.col, targetSnap.row, -(result.damage));
  }
  if (result?.counterDmg && typeof renderer.addHpChangeFlash === 'function') {
    renderer.addHpChangeFlash(actorSnap.col, actorSnap.row, -(result.counterDmg));
  }
  if (result?.killed) {
    const deadColor = targetSnap.owner === 'hero' ? '#d4a72c' : '#9b59b6';
    if (typeof renderer.addDeathAnim === 'function') {
      renderer.addDeathAnim(targetSnap.col, targetSnap.row, deadColor);
    }
    if (typeof renderer.addFadeOutAnim === 'function') {
      renderer.addFadeOutAnim(targetSnap.id, 600);
    }
  }
  redrawFn?.();
}

// Fire the lunge / projectile intro animation against the snapshots. Same
// dispatch rule as main.js — ranged units use a projectile, melee uses a
// lunge.
function _playAttackIntro(renderer, actorSnap, targetSnap) {
  const isRanged = (actorSnap?.range ?? 1) > 1;
  if (isRanged && typeof renderer.addProjectileAnim === 'function') {
    const projectileType = UNIT_TYPES[actorSnap.type]?.projectileType ?? 'sparkle';
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
  sec3.append(runBtn, swapBtn, resetBtn);

  // Section: log
  const sec4 = doc.createElement('div');
  sec4.className = 'c-section';
  sec4.innerHTML = '<h3>Combat log</h3>';
  controlsEl.appendChild(sec4);
  const logEl = doc.createElement('div');
  logEl.id = 'c-log';
  sec4.appendChild(logEl);

  function appendLog(out) {
    const entry = doc.createElement('div');
    entry.className = 'c-log-entry';
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
  function refreshAll() { refreshPickers(); refreshChips(); }

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
    } finally {
      applyingFromUrl = false;
    }
    // Normalise the URL: if the original carried stale unit keys, this writes
    // back the cleaned-up form.
    writeUrl();
  }

  // ── Action buttons ────────────────────────────────────────────────────
  let battleInFlight = false;

  async function runBattleCinematic() {
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
      //    the cinematic's holdPunchAtImpact can freeze the strike.
      _playAttackIntro(renderer, actorSnap, targetSnap);

      // 2. Resolve combat through the real executeBattle.
      const out = tester.runBattle();
      if (!out) return;

      // 3. Cinematic readout + result floaters.
      await run3DCombatCardHold({
        renderer,
        state: tester.state,
        actorSnap,
        targetSnap,
        result: out.result,
        redrawFn: redraw,
        getContinueButton: () => continueBtn,
        playBattleResultAnims: (a, t, r, rd) =>
          _playBattleResultAnims(renderer, a, t, r, rd),
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

  runBtn.addEventListener('click', runBattleCinematic);
  swapBtn.addEventListener('click', () => {
    tester.swapRoles();
  });
  resetBtn.addEventListener('click', () => {
    tester.reset();
    logEl.innerHTML = '';
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
    range: e.range ?? 1,
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
