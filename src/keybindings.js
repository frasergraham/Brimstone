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
 * are gone — those toggles now live behind the `Escape` command console
 * (`/inspector`, `/forest`, `/fog`), freeing the rest of the keyboard for
 * gameplay controls.
 */

// AppModes during which the camera / unit controls are meaningful. MENU is
// excluded — there is no map to drive there.
const IN_GAME = new Set(['PLANNING', 'SUBMITTED', 'RESOLVING', 'SUMMARY', 'PLAYBACK', 'SPECTATING']);

// Rotation step per Shift+Arrow press (radians) and zoom multiplier per press.
const ROTATE_STEP = Math.PI / 12;
const ZOOM_FACTOR = 1.18;

/**
 * The canonical shortcut list — single source of truth for the `H` overlay so
 * the help stays in sync with what `resolveKeyAction` actually does.
 */
export const SHORTCUTS = Object.freeze([
  { keys: 'Esc',              label: 'Open the command console' },
  { keys: 'H (hold)',         label: 'Show this shortcuts overlay' },
  { keys: 'Arrow keys',       label: 'Pan the map' },
  { keys: 'Shift + ←/→', label: 'Rotate the camera' },
  { keys: 'Shift + ↑/↓', label: 'Zoom in / out' },
  { keys: 'Tab',              label: 'Cycle to the next unit' },
  { keys: 'Shift + Tab',      label: 'Cycle to the previous unit' },
  { keys: 'F',                label: 'Focus the camera on the selected unit' },
  { keys: 'M',                label: 'Fit the whole map to the view' },
  { keys: 'X',                label: 'Clear the selected unit’s actions' },
  { keys: 'Space',            label: 'Next step (replay)' },
  { keys: 'Shift + Enter',    label: 'Submit plan' },
  { keys: 'Enter',            label: 'Continue (round summary)' },
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
});

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
 * @param {{key:string, shiftKey?:boolean, ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean}} e
 * @param {{appMode?:string, replayActive?:boolean}} ctx
 * @returns {null | {id:string, [k:string]:any}}
 */
export function resolveKeyAction(e, { appMode, replayActive } = {}) {
  // Ctrl/Cmd/Alt combos belong to the browser/OS — never intercept them.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  const shift = !!e.shiftKey;
  const key = e.key;
  const inGame = IN_GAME.has(appMode);

  // Escape toggles the command console from anywhere.
  if (key === 'Escape') return { id: 'console-toggle' };

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

  // Tab cycles units (planning only).
  if (key === 'Tab') {
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

  // Space — advance the replay one step (whenever a manual step bar is up).
  if (key === ' ' || key === 'Spacebar') {
    return replayActive ? { id: 'replay-next' } : null;
  }

  // Enter — Shift+Enter submits a plan; plain Enter confirms a round summary.
  if (key === 'Enter') {
    if (shift && appMode === 'PLANNING') return { id: 'submit-plan' };
    if (!shift && appMode === 'SUMMARY') return { id: 'summary-continue' };
    return null;
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
    // Releasing focus (alt-tab, etc.) should drop a held help overlay.
    window.addEventListener('blur', () => this._hideHelp());
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

    const ui = this.ui;
    const action = resolveKeyAction(e, {
      appMode: ui?.appMode,
      replayActive: !!ui?._isReplayActive?.(),
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

    if (action.id === 'help-show') {
      if (e.repeat) { e.preventDefault(); return; }
      e.preventDefault();
      this._showHelp();
      return;
    }

    e.preventDefault();
    this._execute(action);
  }

  _onKeyUp(e) {
    if (this._helpVisible && (e.key === 'h' || e.key === 'H')) this._hideHelp();
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
    const r = this.renderer;
    switch (action.id) {
      case 'pan':
        this._camera(() => r?.panByScreen?.(action.dx, action.dy));
        ui?.onRedraw?.();
        break;
      case 'rotate':
        this._camera(() => r?.rotateBy?.(action.dir * ROTATE_STEP, 0));
        ui?.onRedraw?.();
        break;
      case 'zoom': {
        const cx = (r?.canvas?.width ?? 0) / 2;
        const cy = (r?.canvas?.height ?? 0) / 2;
        const factor = action.dir > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
        this._camera(() => r?.setZoom?.((r?.zoomLevel ?? 1) * factor, cx, cy));
        ui?.onRedraw?.();
        break;
      }
      case 'cycle-unit':
        ui?._cycleSelection?.(action.dir);
        break;
      case 'focus-unit': {
        const sel = ui?._selectedEntity;
        if (sel) this._camera(() => ui._centerOnEntity(sel));
        break;
      }
      case 'fit-map':
        this._camera(() => r?.resetView?.());
        ui?.onRedraw?.();
        break;
      case 'clear-unit':
        this._clearSelectedUnit();
        break;
      case 'replay-next': {
        const btn = document.getElementById('replay-next-btn');
        if (btn && !btn.disabled) btn.click();
        break;
      }
      case 'submit-plan':
        ui?._doSubmitPlan?.();
        break;
      case 'summary-continue':
        this._summaryContinueBtn()?.click();
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
      if (e.key === 'Escape') { e.preventDefault(); this._toggleConsole(); }
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
    const { ok, message } = executeConsoleCommand(raw, { renderer: this.renderer });
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
