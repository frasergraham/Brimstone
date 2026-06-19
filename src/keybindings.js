/**
 * In-game keyboard shortcuts + debug command console.
 *
 * Two layers live here:
 *   1. A pure routing core — `resolveKeyAction()` maps a keydown event (key +
 *      modifiers) and the current AppMode to an abstract action descriptor.
 *      It touches no DOM, so it is unit-tested directly.
 *   2. A DOM-bound manager — `installKeybindings()` wires the window listeners,
 *      lazily builds the command console / shortcuts overlay / confirm prompt,
 *      and executes the resolved actions against the live UIController and
 *      renderer.
 *
 * The debug hotkeys that used to be bound globally in renderer-3d.js (D/F/T)
 * are gone — those toggles now live behind the backtick (`` ` ``) command
 * console (`/inspector`, `/forest`, `/fog`, `/fps`), freeing the rest of the
 * keyboard for gameplay controls. Escape deselects the current unit.
 */

import { MAP_SIZES } from './map.js';
import { toggleAllyLunge } from './debug-flags.js';

// AppModes during which the camera / unit controls are meaningful. MENU is
// excluded — there is no map to drive there.
const IN_GAME = new Set(['PLANNING', 'SUBMITTED', 'RESOLVING', 'SUMMARY', 'PLAYBACK', 'SPECTATING']);

// Continuous (held-key) camera rates, applied per 60fps frame and scaled by the
// real frame delta so motion is smooth and frame-rate independent. Arrow keys
// drive a requestAnimationFrame loop rather than one jump per keydown.
const PAN_RATE  = 0.02;    // fraction of the view extent per frame
const ROT_RATE  = 0.025;   // radians per frame
const ZOOM_RATE = 1.02;    // zoom multiplier per frame

/**
 * The canonical shortcut list — single source of truth for the `H` overlay so
 * the help stays in sync with what `resolveKeyAction` actually does.
 */
export const SHORTCUTS = Object.freeze([
  { keys: '`',                label: 'Open the command console' },
  { keys: 'Esc',              label: 'Deselect the current unit' },
  { keys: 'H (hold)',         label: 'Show this shortcuts overlay' },
  { keys: 'Arrow keys',       label: 'Pan the map' },
  { keys: 'Shift + ←/→', label: 'Rotate the camera' },
  { keys: 'Shift + ↑/↓', label: 'Zoom in / out' },
  { keys: 'Tab',              label: 'Next unit (planning) · next card (summary review)' },
  { keys: 'Shift + Tab',      label: 'Previous unit · previous card' },
  { keys: 'F',                label: 'Focus: zoom to selection (or all your units)' },
  { keys: 'M',                label: 'Fit map to view (again: orient north-up)' },
  { keys: 'X',                label: 'Clear the selected unit’s actions' },
  { keys: 'Space / Enter',    label: 'Next action · Continue (replay / summary)' },
  { keys: 'P',                label: 'Play / pause replay auto-play' },
  { keys: 'Shift + Enter',    label: 'Submit plan' },
]);

/**
 * Debug console command registry. Each command runs against a context object
 * that carries `{ renderer, args }`. `run()` may return a string to echo back;
 * otherwise the console echoes the command name.
 */
export const COMMANDS = Object.freeze({
  inspector: {
    describe: 'Toggle the Babylon 3D scene inspector',
    run: (ctx) => ctx.renderer?._toggleInspector?.(),
  },
  forest: {
    describe: 'Toggle the visual border-forest band',
    run: (ctx) => ctx.renderer?._toggleBorderForest?.(),
  },
  fog: {
    describe: 'Cycle the fog debug display mode',
    run: (ctx) => ctx.renderer?._cycleFogDebugMode?.(),
  },
  fps: {
    describe: 'Show/hide the on-canvas FPS counter',
    run: (ctx) => ctx.renderer?._toggleFpsCounter?.(),
  },
  aiassist: {
    describe: 'Watch an AI play: /aiassist (manual button) · /aiassist auto · /aiassist off',
    run: (ctx) => {
      if (!ctx.ui?.setAIAssistMode) {
        return 'AI-assist unavailable — start a mission first.';
      }
      const arg = (ctx.args?.[0] || '').toLowerCase();
      const mode = (arg === 'off' || arg === 'false' || arg === '0' || arg === 'stop') ? false
                 : (arg === 'auto' || arg === 'autorun') ? 'auto'
                 : true;
      const { enabled, autorun } = ctx.ui.setAIAssistMode(mode);
      if (autorun) return '🤖 Autorun ON — the AI plans & submits every round. /aiassist off to stop.';
      if (enabled) return '🤖 AI-assist ON — each round, click the "🤖 AI Plan" button then Submit. (/aiassist auto to autorun.)';
      return '🤖 AI-assist off.';
    },
  },
  seed: {
    describe: 'Show the current map seed + size (for bug repro)',
    run: (ctx) => formatSeedLine(ctx.ui?.state),
  },
  lunge: {
    describe: 'Toggle the ally gang-up lunge animation in battle replays',
    run: () => {
      const on = toggleAllyLunge();
      return on
        ? '🤺 Ally lunge ON — gang-up allies slide in during battle replays.'
        : '🚫 Ally lunge OFF — gang-up allies stay put (presentation only).';
    },
  },
});

/**
 * Format the `/seed` status line from a live GameState. Pure — no DOM — so it
 * is unit-tested directly. Reads `state.mapSeed` / `state.mapSize` and the
 * MAP_SIZES dimensions; handles the no-active-game and override-map cases.
 * @param {{mapSeed?:number|null, mapSize?:string}|null|undefined} state
 * @returns {string}
 */
export function formatSeedLine(state) {
  if (!state) return 'No active game — start a mission first.';
  const size = state.mapSize ?? 'standard';
  const cfg = MAP_SIZES[size];
  const dims = cfg ? `${cfg.cols}×${cfg.rows}` : '?×?';
  const seed = (state.mapSeed === null || state.mapSeed === undefined)
    ? 'n/a (pre-built map)'
    : state.mapSeed;
  return `🌱 seed: ${seed} · size: ${size} (${dims})`;
}

/**
 * Parse and execute a console line. Accepts an optional leading `/`.
 * @param {string} raw
 * @param {{renderer?:object}} ctx
 * @returns {{ ok: boolean, message: string }}
 */
export function executeConsoleCommand(raw, ctx = {}) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: false, message: '' };

  const body = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const parts = body.split(/\s+/);
  const name = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);

  if (name === 'help' || name === '?') {
    const lines = Object.entries(COMMANDS).map(([n, c]) => `/${n} — ${c.describe}`);
    return { ok: true, message: ['Available commands:', ...lines].join('\n') };
  }

  const cmd = COMMANDS[name];
  if (!cmd) return { ok: false, message: `Unknown command: /${name} (try /help)` };

  try {
    const res = cmd.run({ ...ctx, args });
    return { ok: true, message: typeof res === 'string' && res ? res : `/${name}` };
  } catch (err) {
    return { ok: false, message: `Error running /${name}: ${err?.message ?? err}` };
  }
}

/**
 * Map a keydown event to an abstract action. Pure — no DOM, no side effects.
 * Returns null when the key is not bound in the current context.
 *
 * `appMode` is the centralized AppMode (now driven in both online and offline
 * play). `replayActive` is the one genuinely UI-transient signal: a manual
 * replay/resolution step bar is on screen — true for BOTH the full-game replay
 * (PLAYBACK) and the inline "replay last turn" (RESOLVING), which is why Space
 * keys off it rather than a single mode.
 *
 * `reviewActive` mirrors it for the end-of-round wrap-up review (scrub arrows
 * on screen) — Tab keys off it to scrub cards instead of cycling units.
 *
 * @param {{key:string, shiftKey?:boolean, ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean}} e
 * @param {{appMode?:string, replayActive?:boolean, reviewActive?:boolean}} ctx
 * @returns {null | {id:string, [k:string]:any}}
 */
export function resolveKeyAction(e, { appMode, replayActive, reviewActive } = {}) {
  // Ctrl/Cmd/Alt combos belong to the browser/OS — never intercept them.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  const shift = !!e.shiftKey;
  const key = e.key;
  const inGame = IN_GAME.has(appMode);

  // Backtick toggles the command console from anywhere.
  if (key === '`') return { id: 'console-toggle' };

  // Escape deselects the current unit (in-game only).
  if (key === 'Escape') return inGame ? { id: 'deselect' } : null;

  // H (hold) shows the shortcuts overlay.
  if (!shift && (key === 'h' || key === 'H')) {
    return inGame ? { id: 'help-show' } : null;
  }

  // Arrow keys: pan (plain) or rotate/zoom (with Shift).
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
    if (!inGame) return null;
    if (shift) {
      if (key === 'ArrowLeft')  return { id: 'rotate', dir: -1 };
      if (key === 'ArrowRight') return { id: 'rotate', dir:  1 };
      if (key === 'ArrowUp')    return { id: 'zoom',   dir:  1 };
      return { id: 'zoom', dir: -1 }; // ArrowDown
    }
    const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
    const dy = key === 'ArrowUp'   ? -1 : key === 'ArrowDown'  ? 1 : 0;
    return { id: 'pan', dx, dy };
  }

  // Tab — scrubs the turn cards while the wrap-up review is up (same as the
  // ◀ ▶ arrows); otherwise cycles units (planning only).
  if (key === 'Tab') {
    if (reviewActive) return { id: 'review-scrub', dir: shift ? -1 : 1 };
    if (appMode !== 'PLANNING') return null;
    return { id: 'cycle-unit', dir: shift ? -1 : 1 };
  }

  // F — focus selected unit.
  if (!shift && (key === 'f' || key === 'F')) return inGame ? { id: 'focus-unit' } : null;

  // M — fit map to view.
  if (!shift && (key === 'm' || key === 'M')) return inGame ? { id: 'fit-map' } : null;

  // X — clear selected unit's queued actions (planning only).
  if (!shift && (key === 'x' || key === 'X')) {
    return appMode === 'PLANNING' ? { id: 'clear-unit' } : null;
  }

  // P — toggle replay auto-play (play ⇄ pause). Active only while a replay /
  // resolution step bar is on screen (both the full-game replay and the inline
  // round-end resolution replay share the same #replay-playpause-btn). Inert
  // elsewhere so it can't be pressed by accident during planning.
  if (!shift && (key === 'p' || key === 'P')) {
    return replayActive ? { id: 'replay-playpause' } : null;
  }

  // Space / Enter — one shared "advance" key: the executor clicks whichever
  // advance affordance is on screen (combat-readout Continue, round-summary
  // Continue, or replay NEXT). Shift+Enter stays the plan submit; both keys
  // are inert elsewhere so planning can't be advanced by accident.
  if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
    if (key === 'Enter' && shift) {
      return appMode === 'PLANNING' ? { id: 'submit-plan' } : null;
    }
    return (replayActive || appMode === 'SUMMARY') ? { id: 'advance' } : null;
  }

  return null;
}

// IDs of dialogs that own the keyboard while open; Escape must dismiss them
// rather than opening the console behind them.
const BLOCKING_DIALOG_IDS = ['result-dialog', 'battle-dialog', 'encounter-dialog', 'grace-dialog', 'phase-modal'];

/**
 * DOM-bound controller. One instance per page; reads the live UIController via
 * the `getUi` accessor so it keeps working across the page's ui/renderer
 * re-creations (new game, online, spectator).
 */
class KeybindingManager {
  constructor(getUi) {
    this._getUi = getUi;
    this._consoleEl = null;
    this._consoleInput = null;
    this._consoleOutput = null;
    this._helpEl = null;
    this._confirmEl = null;
    this._helpVisible = false;
    this._consoleVisible = false;
    // Held-key camera motion (arrows): set of held arrow keys + live shift,
    // driven by a requestAnimationFrame loop.
    this._held = new Set();
    this._shift = false;
    this._rafId = null;
    this._lastTs = 0;
  }

  get ui() { return this._getUi?.() ?? null; }
  get renderer() { return this.ui?.renderer ?? null; }

  /** The on-screen round-summary "Continue" button, or null — drives Enter. */
  _summaryContinueBtn() {
    const a = document.querySelector('.replay-wrapup-btn[data-act="next"]');
    if (a && this._isVisible(a)) return a;
    const b = document.getElementById('round-summary-next');
    if (b && this._isVisible(b)) return b;
    return null;
  }

  _isVisible(el) {
    if (!el) return false;
    if (typeof el.offsetParent !== 'undefined') return el.offsetParent !== null;
    return el.style ? el.style.display !== 'none' : true;
  }

  install() {
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => this._onKeyUp(e));
    // Releasing focus (alt-tab, etc.) should drop a held help overlay and any
    // in-progress camera motion (otherwise a key "sticks" if keyup is missed).
    window.addEventListener('blur', () => { this._hideHelp(); this._stopMoveLoop(); });
  }

  _isArrow(key) {
    return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
  }

  _isEditableTarget(e) {
    const t = e.target;
    if (!t) return false;
    if (t === this._consoleInput) return false; // console input handles itself
    const tag = (t.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
  }

  _onKeyDown(e) {
    // The console input swallows its own keys (Enter/Escape) via its handler.
    if (this._consoleVisible) return;
    if (this._isEditableTarget(e)) return;

    // Track live shift so toggling it mid-hold switches pan ⇄ rotate/zoom.
    this._shift = e.shiftKey;

    const ui = this.ui;
    const action = resolveKeyAction(e, {
      appMode: ui?.appMode,
      replayActive: !!ui?._isReplayActive?.(),
      reviewActive: !!ui?._replayReviewMode,
    });
    if (!action) return;

    if (action.id === 'console-toggle') {
      // Let an open dialog keep Escape; only open the console when the field
      // is clear.
      if (this._helpVisible) { e.preventDefault(); this._hideHelp(); return; }
      if (this._blockingDialogOpen()) return;
      e.preventDefault();
      this._toggleConsole();
      return;
    }

    if (action.id === 'deselect') {
      // A blocking dialog owns the keyboard — don't deselect behind it.
      if (this._blockingDialogOpen()) return;
      e.preventDefault();
      this.ui?._clearSelection?.();
      return;
    }

    if (action.id === 'help-show') {
      if (e.repeat) { e.preventDefault(); return; }
      e.preventDefault();
      this._showHelp();
      return;
    }

    // Arrow keys (pan/rotate/zoom) drive a continuous held-key loop for smooth
    // sliding instead of one jump per keydown. resolveKeyAction already gated
    // them to in-game modes; we register the key and let the loop apply motion
    // using the LIVE shift state (so toggling Shift mid-hold switches modes).
    if (action.id === 'pan' || action.id === 'rotate' || action.id === 'zoom') {
      e.preventDefault();
      this._held.add(e.key);
      this._startMoveLoop();
      return;
    }

    e.preventDefault();
    this._execute(action);
  }

  _onKeyUp(e) {
    this._shift = e.shiftKey;
    if (this._isArrow(e.key)) {
      this._held.delete(e.key);
      if (this._held.size === 0) this._stopMoveLoop();
    }
    if (this._helpVisible && (e.key === 'h' || e.key === 'H')) this._hideHelp();
  }

  // ── Continuous camera motion (held arrow keys) ───────────────────────────

  _startMoveLoop() {
    if (this._rafId != null) return;
    this._lastTs = 0;
    this._rafId = requestAnimationFrame((ts) => this._moveTick(ts));
  }

  _stopMoveLoop() {
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this._held.clear();
  }

  _moveTick(ts) {
    this._rafId = null;
    const r = this.renderer;
    // Bail (and clear) if we left an in-game mode or lost the renderer.
    if (!r || !IN_GAME.has(this.ui?.appMode) || this._held.size === 0) {
      this._held.clear();
      return;
    }
    // Frame-delta factor: 1.0 at 60fps, clamped so a stutter can't lurch.
    const f = this._lastTs ? Math.min(3, (ts - this._lastTs) / 16.67) : 1;
    this._lastTs = ts;

    let dx = 0, dy = 0;
    if (this._held.has('ArrowLeft'))  dx -= 1;
    if (this._held.has('ArrowRight')) dx += 1;
    if (this._held.has('ArrowUp'))    dy -= 1;
    if (this._held.has('ArrowDown'))  dy += 1;

    this._camera(() => {
      if (this._shift) {
        // Shift: ←/→ rotate, ↑/↓ zoom.
        if (dx) r.rotateBy?.(dx * ROT_RATE * f, 0);
        if (dy) r.zoomBy?.(Math.pow(ZOOM_RATE, -dy * f)); // ↑ (dy<0) zooms in
      } else if (dx || dy) {
        // Plain: pan. Horizontal is flipped so ←/→ track the on-screen axis.
        r.panByScreen?.(-dx * PAN_RATE * f, dy * PAN_RATE * f);
      }
    });
    this.ui?.onRedraw?.();

    this._rafId = requestAnimationFrame((t) => this._moveTick(t));
  }

  _blockingDialogOpen() {
    if (this.ui?._popupVisible) return true;
    for (const id of BLOCKING_DIALOG_IDS) {
      const el = document.getElementById(id);
      if (el && ['flex', 'block', 'grid'].includes(el.style.display)) return true;
    }
    return false;
  }

  // Run a camera mutation so it survives replay's FIXED/FOLLOW suppression.
  _camera(fn) {
    const ui = this.ui;
    if (ui?._replayManualCamera) ui._replayManualCamera(fn);
    else fn();
  }

  _execute(action) {
    const ui = this.ui;
    // pan / rotate / zoom are handled by the held-key loop, not here.
    switch (action.id) {
      case 'cycle-unit':
        ui?._cycleSelection?.(action.dir);
        break;
      case 'review-scrub':
        // Reuse the review arrows' own handlers so Tab matches ◀ ▶ exactly.
        document.getElementById(action.dir > 0 ? 'replay-review-next' : 'replay-review-prev')?.click();
        break;
      case 'focus-unit':
        // Reuse the "Focus" map control: zoom to the selected unit, or frame
        // all of the player's units when nothing is selected.
        document.getElementById('zoom-me')?.click();
        break;
      case 'fit-map':
        // Reuse the fit button so M matches it exactly: tap frames the map;
        // tapping again when already framed orients north-up. The handler has
        // no double-tap window, so repeated M presses are safe.
        document.getElementById('zoom-fit')?.click();
        break;
      case 'clear-unit':
        this._clearSelectedUnit();
        break;
      case 'replay-playpause': {
        // Reuse the AutoPlay button's own click handler so P toggles play/pause
        // exactly like the on-screen control — for both the full-game replay and
        // the inline round-end resolution replay (same #replay-playpause-btn).
        const pp = document.getElementById('replay-playpause-btn');
        if (pp && this._isVisible(pp)) pp.click();
        break;
      }
      case 'advance': {
        // Click whichever advance affordance is up, most specific first: the
        // cinematic combat-readout Continue, the round-summary Continue, then
        // the replay NEXT button.
        const combat = document.getElementById('combat-continue-btn');
        if (combat && !combat.hidden && this._isVisible(combat)) { combat.click(); break; }
        const summary = this._summaryContinueBtn();
        if (summary) { summary.click(); break; }
        const next = document.getElementById('replay-next-btn');
        if (next && !next.disabled && this._isVisible(next)) next.click();
        break;
      }
      case 'submit-plan':
        ui?._doSubmitPlan?.();
        break;
    }
  }

  _clearSelectedUnit() {
    const ui = this.ui;
    if (!ui || ui._planSubmitted) return;
    const sel = ui._selectedEntity;
    if (!sel) return;
    const queue = ui._unitPlans?.get(sel.id);
    if (!queue || queue.length === 0) return;
    const name = sel.title || sel.name || sel.type || 'this unit';
    this._confirm(`Clear all ${queue.length} action(s) for ${name}?`).then((ok) => {
      if (!ok) return;
      ui._unitPlans.delete(sel.id);
      ui._refreshPlanOverlay?.();
      ui._renderPlanPanel?.();
      ui._refreshUndoButtons?.();
      ui._selectEntity?.(sel);
      ui.onRedraw?.();
    });
  }

  // ── Overlay construction ────────────────────────────────────────────────

  _ensureConsole() {
    if (this._consoleEl) return;
    const el = document.createElement('div');
    el.id = 'cmd-console';
    el.className = 'cmd-console hidden';
    el.innerHTML = `
      <div class="cmd-console-output"></div>
      <div class="cmd-console-line">
        <span class="cmd-console-prompt">&gt;</span>
        <input class="cmd-console-input" type="text" autocomplete="off"
               autocapitalize="off" spellcheck="false" placeholder="type a command, e.g. /help" />
      </div>`;
    document.body.appendChild(el);
    this._consoleEl = el;
    this._consoleOutput = el.querySelector('.cmd-console-output');
    this._consoleInput = el.querySelector('.cmd-console-input');

    this._consoleInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === '`') { e.preventDefault(); this._toggleConsole(); }
      else if (e.key === 'Enter') { e.preventDefault(); this._runConsoleLine(); }
    });
    el.addEventListener('mousedown', (e) => {
      if (e.target === el) this._toggleConsole(); // click backdrop to close
    });
  }

  _runConsoleLine() {
    const raw = this._consoleInput.value;
    if (!raw.trim()) return;
    this._echo(`> ${raw}`, 'cmd');
    const { ok, message } = executeConsoleCommand(raw, { renderer: this.renderer, ui: this.ui });
    if (message) this._echo(message, ok ? 'ok' : 'err');
    this._consoleInput.value = '';
  }

  _echo(text, kind) {
    if (!this._consoleOutput) return;
    for (const line of String(text).split('\n')) {
      const div = document.createElement('div');
      div.className = `cmd-console-msg cmd-${kind}`;
      div.textContent = line;
      this._consoleOutput.appendChild(div);
    }
    this._consoleOutput.scrollTop = this._consoleOutput.scrollHeight;
  }

  _toggleConsole() {
    this._ensureConsole();
    this._consoleVisible = !this._consoleVisible;
    this._consoleEl.classList.toggle('hidden', !this._consoleVisible);
    if (this._consoleVisible) {
      this._consoleInput.value = '';
      this._consoleInput.focus();
    } else {
      this._consoleInput.blur();
    }
  }

  _ensureHelp() {
    if (this._helpEl) return;
    const el = document.createElement('div');
    el.id = 'kb-help';
    el.className = 'kb-help hidden';
    const rows = SHORTCUTS
      .map((s) => `<tr><td class="kb-help-keys">${s.keys}</td><td class="kb-help-label">${s.label}</td></tr>`)
      .join('');
    el.innerHTML = `
      <div class="kb-help-panel">
        <h2 class="kb-help-title">Keyboard Shortcuts</h2>
        <table class="kb-help-table">${rows}</table>
      </div>`;
    document.body.appendChild(el);
    this._helpEl = el;
  }

  _showHelp() {
    this._ensureHelp();
    this._helpVisible = true;
    this._helpEl.classList.remove('hidden');
  }

  _hideHelp() {
    if (!this._helpVisible || !this._helpEl) return;
    this._helpVisible = false;
    this._helpEl.classList.add('hidden');
  }

  _ensureConfirm() {
    if (this._confirmEl) return;
    const el = document.createElement('div');
    el.id = 'kb-confirm';
    el.className = 'kb-confirm hidden';
    el.innerHTML = `
      <div class="kb-confirm-panel">
        <div class="kb-confirm-msg"></div>
        <div class="kb-confirm-btns">
          <button class="kb-confirm-yes">Clear</button>
          <button class="kb-confirm-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    this._confirmEl = el;
  }

  _confirm(message) {
    this._ensureConfirm();
    const el = this._confirmEl;
    el.querySelector('.kb-confirm-msg').textContent = message;
    el.classList.remove('hidden');
    const yes = el.querySelector('.kb-confirm-yes');
    const cancel = el.querySelector('.kb-confirm-cancel');
    return new Promise((resolve) => {
      const done = (val) => {
        el.classList.add('hidden');
        yes.onclick = cancel.onclick = el.onmousedown = null;
        resolve(val);
      };
      yes.onclick = () => done(true);
      cancel.onclick = () => done(false);
      el.onmousedown = (e) => { if (e.target === el) done(false); };
    });
  }
}

/**
 * Install the global keyboard shortcuts. No-op outside a browser (tests).
 * @param {() => (object|null)} getUi  accessor for the live UIController.
 * @returns {KeybindingManager|null}
 */
export function installKeybindings(getUi) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const mgr = new KeybindingManager(getUi);
  mgr.install();
  return mgr;
}
