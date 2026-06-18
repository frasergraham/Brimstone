// ============================================================================
// The Ledger — menu controller (Direction B redesign).
//
// Owns the candlelit RAIL and which destination is shown; renders the active
// destination's panel into #ledger-pane in place — no card stack, nothing
// replaces the frame. Built ALONGSIDE the legacy #setup-screen menu and shown
// only behind the `?ledger` dev preview until the single cutover, at which point
// AppMode.MENU will point here and the per-destination panels (currently
// placeholders) get filled in with the existing data layer.
// ============================================================================

/** The six rail destinations, top to bottom (mirrors the mock). */
const DESTINATIONS = [
  { id: 'continue', icon: '▶',  label: 'Continue',         title: 'Continue',         tag: '— the night is not over',         accent: 'gold' },
  { id: 'campaign', icon: '☀',  label: 'Campaign',         title: 'The Campaign',     tag: '— six nights to break the curse', accent: 'gold' },
  { id: 'skirmish', icon: '🎯', label: 'Skirmish',         title: 'Skirmish',         tag: '— choose a champion, set the night', accent: 'gold' },
  { id: 'others',   icon: '🌙', label: 'Play With Others', title: 'Play With Others', tag: '— choose your rhythm',            accent: 'purple' },
  { id: 'replays',  icon: '📜', label: 'Replays',          title: 'Replays',          tag: '— games already told',            accent: 'gold' },
  { id: 'account',  icon: '⚙',  label: 'Account',          title: 'Account',          tag: '',                                accent: 'gold' },
];

let _root = null;
let _activeId = null;

/**
 * Wire up the rail + show the default destination. Idempotent.
 * @param {{ playerName?: string, start?: string }} opts
 * @returns {{ show, hide, select }|null}
 */
export function initLedger({ playerName, start = 'continue' } = {}) {
  _root = document.getElementById('ledger-screen');
  if (!_root) return null;
  const nameEl = document.getElementById('ledger-user-name');
  if (nameEl && playerName) nameEl.textContent = playerName;
  _renderRail();
  select(start);
  return { show, hide, select };
}

function _renderRail() {
  const host = document.getElementById('ledger-rail-items');
  if (!host) return;
  host.replaceChildren();
  for (const d of DESTINATIONS) {
    const item = document.createElement('div');
    item.className = 'ledger-rail-item';
    item.dataset.dest = d.id;
    item.innerHTML = `<span class="ic">${d.icon}</span><span class="lb">${d.label}</span>`;
    item.addEventListener('click', () => select(d.id));
    host.appendChild(item);
  }
}

/** Light up a rail item and re-bind the ledger pane to that destination. */
export function select(id) {
  const dest = DESTINATIONS.find(d => d.id === id);
  if (!dest) return;
  _activeId = id;
  document.querySelectorAll('#ledger-rail-items .ledger-rail-item').forEach((el) =>
    el.classList.toggle('is-active', el.dataset.dest === id));
  _renderPane(dest);
}

function _renderPane(dest) {
  const pane = document.getElementById('ledger-pane');
  if (!pane) return;
  pane.replaceChildren();

  const head = document.createElement('div');
  head.className = 'ledger-pane-head';
  head.innerHTML = `<span class="ledger-pane-title">${dest.title}</span>` +
    (dest.tag ? `<span class="ledger-pane-tag">${dest.tag}</span>` : '');
  pane.appendChild(head);

  const rule = document.createElement('div');
  rule.className = 'ledger-rule' + (dest.accent === 'purple' ? ' is-purple' : '');
  pane.appendChild(rule);

  const body = document.createElement('div');
  body.className = 'ledger-pane-body';
  body.style.flex = '1';
  (PANELS[dest.id] || _placeholderPanel)(body, dest);
  pane.appendChild(body);
}

// ── Per-destination panel renderers ─────────────────────────────────────────
// Foundations ship placeholders. As each screen is built it replaces its entry
// here, reusing the existing data layer (main-menu-games, campaign saves, the
// async/battle fetchers, lobby, auth) — see the implementation plan.
const PANELS = {};

function _placeholderPanel(body, dest) {
  const p = document.createElement('p');
  p.className = 'ledger-placeholder';
  p.textContent = `“${dest.label}” — coming soon to the ledger.`;
  body.appendChild(p);
}

export function show() { _root?.classList.add('is-active'); }
export function hide() { _root?.classList.remove('is-active'); }
export function activeDestination() { return _activeId; }
