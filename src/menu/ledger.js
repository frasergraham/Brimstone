// ============================================================================
// The Ledger — menu controller (Direction B redesign).
//
// Owns the candlelit RAIL and which destination is shown; renders the active
// destination's panel into #ledger-pane in place — no card stack, nothing
// replaces the frame. DOM/render-only: main.js injects the data + actions
// (`initLedger({ data })`). Built ALONGSIDE the legacy #setup-screen and shown
// behind the `?ledger` dev preview until the single cutover.
// ============================================================================

import { mmSortRows, mmFormatRow } from '../main-menu-games.js';

/** The six rail destinations, top to bottom (mirrors the mock). */
const DESTINATIONS = [
  { id: 'continue', icon: '▶',  label: 'Continue',         title: 'Continue',         tag: '— the night is not over',            accent: 'gold' },
  { id: 'campaign', icon: '☀',  label: 'Campaign',         title: 'The Campaign',     tag: '— six nights to break the curse',    accent: 'gold' },
  { id: 'skirmish', icon: '🎯', label: 'Skirmish',         title: 'Skirmish',         tag: '— choose a champion, set the night', accent: 'gold' },
  { id: 'others',   icon: '🌙', label: 'Play With Others', title: 'Play With Others', tag: '— choose your rhythm',               accent: 'purple' },
  { id: 'replays',  icon: '📜', label: 'Replays',          title: 'Replays',          tag: '— games already told',               accent: 'gold' },
  { id: 'account',  icon: '⚙',  label: 'Account',          title: 'Account',          tag: '',                                   accent: 'gold' },
];

let _root = null;
let _activeId = null;
let _data = null;
let _renderToken = 0;            // guards against out-of-order async panel renders
let _campSlot = null;            // selected campaign slot (Campaign destination)
let _campView = 'missions';      // Campaign sub-view: 'missions' | 'party'
let _skFaction = null;           // selected Skirmish champion
const _skOpts = { mapSize: 'standard', nodeCount: 3, aiDifficulty: 'normal' };

export function initLedger({ playerName, start = 'continue', data = null } = {}) {
  _root = document.getElementById('ledger-screen');
  if (!_root) return null;
  _data = data;
  const nameEl = document.getElementById('ledger-user-name');
  if (nameEl) nameEl.textContent = playerName || _data?.session?.()?.username || 'Wanderer';
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
    (dest.tag ? `<span class="ledger-pane-tag">${esc(dest.tag)}</span>` : '');
  pane.appendChild(head);

  const rule = document.createElement('div');
  rule.className = 'ledger-rule' + (dest.accent === 'purple' ? ' is-purple' : '');
  pane.appendChild(rule);

  const body = document.createElement('div');
  body.className = 'ledger-pane-body';
  pane.appendChild(body);

  (PANELS[dest.id] || _placeholderPanel)(body, dest);
}

// ── Per-destination panels ───────────────────────────────────────────────────

const PANELS = {
  continue: _panelContinue,
  campaign: _panelCampaign,
  skirmish: _panelSkirmish,
  others:   _panelOthers,
  replays:  _panelReplays,
  account:  _panelAccount,
};

/** Continue — your last save as the hero object, then everything else waiting. */
function _panelContinue(body) {
  if (!_data?.activeGames) return _placeholderPanel(body, { label: 'Continue' });
  const token = ++_renderToken;
  body.innerHTML = `<p class="ledger-placeholder">Reading the ledger…</p>`;
  _data.activeGames().then((rows) => {
    if (token !== _renderToken) return;              // a newer render superseded us
    const sorted = mmSortRows(rows || []);
    body.replaceChildren();
    if (!sorted.length) {
      body.appendChild(_empty('Nothing in progress. Begin a Campaign or a Skirmish from the rail.'));
      return;
    }
    const [hero, ...rest] = sorted;
    body.appendChild(_resumeHero(hero));
    if (rest.length) {
      body.appendChild(_cap('Also waiting on you'));
      const list = document.createElement('div');
      list.className = 'lg-feed';
      for (const r of rest.slice(0, 5)) list.appendChild(_feedRow(r));
      body.appendChild(list);
    }
  }).catch(() => { if (token === _renderToken) body.replaceChildren(_empty('Could not read the ledger.')); });
}

/** Campaign — pick a playthrough slot, then play any available mission. */
function _panelCampaign(body) {
  const data = _data?.campaign?.();
  if (!data) return _placeholderPanel(body, { label: 'Campaign' });
  // Resolve the selected slot (default to the active/most-recent playthrough).
  if (!data.slots.some(s => s.slot === _campSlot)) _campSlot = data.activeSlotIndex;
  const sel = data.slots.find(s => s.slot === _campSlot) || data.slots[0];

  body.appendChild(_cap('Your playthroughs'));
  const slotRow = document.createElement('div');
  slotRow.className = 'lg-slots';
  for (const s of data.slots) {
    const card = document.createElement('div');
    card.className = 'lg-slot' + (s.slot === sel.slot ? ' is-active' : '') + (s.started ? '' : ' is-new');
    card.innerHTML = s.started
      ? `<div class="lg-slot-tag">Slot ${roman(s.slot)}${s.slot === sel.slot ? ' · selected' : ''}</div>` +
        `<div class="lg-slot-title gthc">${s.isComplete ? 'Complete' : s.completedCount + ' cleared'}</div>` +
        `<div class="lg-slot-sub">${s.completedCount} mission${s.completedCount === 1 ? '' : 's'} won</div>`
      : `<div class="lg-slot-tag">Slot ${roman(s.slot)}</div>` +
        `<div class="lg-slot-title gthc">New</div>` +
        `<div class="lg-slot-sub">begin a playthrough</div>`;
    card.addEventListener('click', () => { _campSlot = s.slot; select('campaign'); });
    slotRow.appendChild(card);
  }
  body.appendChild(slotRow);

  // Party / Missions page-turn (the mock's between-mission toggle).
  const toggle = document.createElement('div');
  toggle.className = 'lg-toggle';
  for (const [view, label] of [['missions', 'Missions'], ['party', 'Party']]) {
    const opt = document.createElement('span');
    opt.className = 'lg-toggle-opt' + (_campView === view ? ' is-active' : '');
    opt.textContent = label;
    opt.addEventListener('click', () => { _campView = view; select('campaign'); });
    toggle.appendChild(opt);
  }
  body.appendChild(toggle);

  if (_campView === 'party') { _renderPartyView(body, sel); return; }

  body.appendChild(_cap(`The Chronicle of Missions · Slot ${roman(sel.slot)}`));
  const chron = document.createElement('div');
  chron.className = 'lg-chronicle';
  const missions = sel.missions || [];
  if (!missions.length) {
    chron.appendChild(_empty('No missions found for this campaign.'));
  } else {
    missions.forEach((m, i) => {
      const status = m.completed ? 'done' : (m.id === sel.nextMissionId ? 'current' : (m.available ? 'available' : 'locked'));
      chron.appendChild(_missionRow(sel, m, status, i));
    });
  }
  body.appendChild(chron);
}

/** Warband (Party) view — reuses the existing party-pane renderer + mutations.
 *  Injects the party HTML and wires its controls back to partyAction. */
function _renderPartyView(body, sel) {
  const container = document.createElement('div');
  container.className = 'lg-party';
  body.appendChild(container);
  const data = _data?.campaignParty?.(sel.slot);
  if (!data || !data.html) {
    container.appendChild(_empty('No warband yet — start this playthrough to gather survivors.'));
    return;
  }
  container.innerHTML = data.html;
  _wirePartyButtons(container, sel.slot);
}

function _wirePartyButtons(container, slot) {
  const wire = (selector, kind, withWeapon = false) => {
    container.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('click', () => {
        const html = _data?.partyAction?.(kind, btn.dataset.idx, withWeapon ? btn.dataset.weapon : undefined);
        if (html != null) { container.innerHTML = html; _wirePartyButtons(container, slot); }
      });
    });
  };
  wire('.cprog-promote', 'promote');
  wire('.cprog-demote', 'demote');
  wire('.cprog-heal-btn', 'heal');
  wire('.cprog-equip-btn', 'equip', true);
  wire('.cprog-return-btn', 'return', true);
  wire('.cprog-pool-equip-btn', 'pool-equip', true);
}

/** Skirmish — pick a champion, set the night, start a game vs AI. */
function _panelSkirmish(body) {
  const factions = _data?.skirmishFactions?.() ?? [];
  if (!factions.length) return _placeholderPanel(body, { label: 'Skirmish' });
  if (!factions.some(f => f.id === _skFaction)) _skFaction = factions[0].id;

  body.appendChild(_cap('Your champion'));
  const grid = document.createElement('div');
  grid.className = 'lg-champions';
  for (const f of factions) {
    const card = document.createElement('div');
    card.className = 'lg-champion ' + (f.side === 'night' ? 'is-night' : 'is-day') + (f.id === _skFaction ? ' is-selected' : '');
    card.innerHTML = `<img src="${esc(f.img)}" alt=""><div class="nm">${esc(f.name)}</div>` +
      `<div class="sd">${f.side === 'day' ? '☀ Day' : '🌙 Night'}</div>`;
    card.addEventListener('click', () => { _skFaction = f.id; select('skirmish'); });
    grid.appendChild(card);
  }
  body.appendChild(grid);

  body.appendChild(_cap('The night ahead'));
  const opts = document.createElement('div');
  opts.className = 'lg-opts';
  opts.appendChild(_optSelect('mapSize', 'Map size', [['skirmish', 'Skirmish'], ['standard', 'Standard'], ['regional', 'Regional']], (v) => v));
  opts.appendChild(_optSelect('nodeCount', 'Power nodes', [['2', '2'], ['3', '3'], ['4', '4']], (v) => parseInt(v, 10)));
  opts.appendChild(_optSelect('aiDifficulty', 'AI cunning', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], (v) => v));
  body.appendChild(opts);

  const startRow = document.createElement('div');
  startRow.className = 'lg-skirmish-start';
  startRow.appendChild(_button('▶ Start', 'gold', () => _data?.startSkirmish?.(_skFaction, { ..._skOpts })));
  const summ = document.createElement('span');
  summ.className = 'lg-skirmish-summary';
  summ.id = 'lg-sk-summary';
  startRow.appendChild(summ);
  body.appendChild(startRow);
  _updateSkirmishSummary();
}

function _optSelect(key, label, options, parse) {
  const wrap = document.createElement('label');
  wrap.className = 'lg-opt';
  const span = document.createElement('span');
  span.className = 'lg-opt-label';
  span.textContent = label;
  const sel = document.createElement('select');
  sel.className = 'lg-opt-select';
  for (const [val, lbl] of options) {
    const o = document.createElement('option');
    o.value = val; o.textContent = lbl;
    if (parse(val) === _skOpts[key]) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { _skOpts[key] = parse(sel.value); _updateSkirmishSummary(); });
  wrap.appendChild(span);
  wrap.appendChild(sel);
  return wrap;
}

function _updateSkirmishSummary() {
  const el = document.getElementById('lg-sk-summary');
  if (!el) return;
  const f = (_data?.skirmishFactions?.() ?? []).find((x) => x.id === _skFaction);
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  el.textContent = [f?.name, cap(_skOpts.mapSize), `${_skOpts.nodeCount} nodes`, cap(_skOpts.aiDifficulty)].filter(Boolean).join(' · ');
}

/** Play With Others — the three rhythms (Live / Async / Battle) + your games.
 *  Create/Join/Lobby bridge to the legacy flow for now (native lobby is next). */
function _panelOthers(body) {
  if (!_data?.online) return _placeholderPanel(body, { label: 'Play With Others' });
  const token = ++_renderToken;
  body.innerHTML = `<p class="ledger-placeholder">Reading the table…</p>`;
  Promise.resolve(_data.online()).then(({ signedIn, games, battle }) => {
    if (token !== _renderToken) return;
    body.replaceChildren();

    if (!signedIn) {
      body.appendChild(_empty('Sign in to play with others — Live, Async, or the Battle.'));
      const b = _button('Sign in', 'purple', () => _data?.signIn?.(() => select('others')));
      b.style.marginTop = '14px';
      body.appendChild(b);
      return;
    }

    const rh = document.createElement('div');
    rh.className = 'lg-rhythms';
    rh.appendChild(_rhythmCard('⚡ Live match', '~15 min', 'Timed turns, one sitting. Quick-match or invite.', () => _data.openOnline?.()));
    rh.appendChild(_rhythmCard('🌒 Async match', 'days', 'Play at your own pace; we notify you.', () => _data.openAsync?.()));
    body.appendChild(rh);

    const bf = document.createElement('div');
    bf.className = 'lg-battle' + (battle ? ' is-live' : '');
    bf.innerHTML =
      `<div class="lg-battle-head"><span class="gthc">⚔ The Battle for Caleb's Hollow</span>` +
      `${battle ? '<span class="lg-battle-live">● live</span>' : '<span class="lg-battle-cta">View ▸</span>'}</div>` +
      `<div class="lg-battle-sub">Persistent 10v10 war — turns resolve at noon &amp; midnight.` +
      `${battle && battle.round != null ? ' · Round ' + battle.round : ''}</div>`;
    bf.addEventListener('click', () => _data.openBattle?.());
    body.appendChild(bf);

    body.appendChild(_cap('Your games'));
    if (!games.length) {
      body.appendChild(_empty('No live games yet — start one above.'));
    } else {
      const list = document.createElement('div');
      list.className = 'lg-feed';
      for (const r of mmSortRows(games)) list.appendChild(_feedRow(r));
      body.appendChild(list);
    }
  }).catch(() => { if (token === _renderToken) body.replaceChildren(_empty('Could not reach the table.')); });
}

function _rhythmCard(title, time, desc, onClick) {
  const el = document.createElement('div');
  el.className = 'lg-rhythm';
  el.innerHTML = `<div class="lg-rhythm-top"><span class="t">${esc(title)}</span><span class="time">${esc(time)}</span></div>` +
    `<div class="d">${esc(desc)}</div>`;
  el.addEventListener('click', onClick);
  return el;
}

/** Replays — completed games (SP + MP), newest first, click to watch. */
function _panelReplays(body) {
  if (!_data?.replays) return _placeholderPanel(body, { label: 'Replays' });
  const token = ++_renderToken;
  body.innerHTML = `<p class="ledger-placeholder">Gathering the chronicles…</p>`;
  Promise.resolve(_data.replays()).then((rows) => {
    if (token !== _renderToken) return;
    body.replaceChildren();
    const sorted = mmSortRows(rows || []);
    if (!sorted.length) { body.appendChild(_empty('No completed games yet — finish a match to see it told here.')); return; }
    const list = document.createElement('div');
    list.className = 'lg-feed';
    for (const r of sorted) list.appendChild(_feedRow(r, '▸ Watch'));
    body.appendChild(list);
  }).catch(() => { if (token === _renderToken) body.replaceChildren(_empty('Could not load replays.')); });
}

/** Account — signed-in identity (sign-in/out via the existing auth dialog). */
function _panelAccount(body) {
  const session = _data?.session?.();
  if (session?.username) {
    const card = document.createElement('div');
    card.className = 'lg-account';
    card.innerHTML =
      `<img src="assets/char-paladin.png" alt="">` +
      `<div class="lg-account-id"><div class="nm gthc">${esc(session.username)}</div>` +
      `<div class="sub">${session.email ? esc(session.email) : 'passwordless — link an email to play across devices'}</div></div>`;
    body.appendChild(card);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:10px; margin-top:14px;';
    actions.appendChild(_button('Manage account', 'ghost', () => _data?.openAccount?.()));
    actions.appendChild(_button('Sign out', 'ghost', () => _data?.signOut?.()));
    body.appendChild(actions);
    body.appendChild(_note('Edit your name, link an email to play across devices, or set the server.'));
  } else {
    body.appendChild(_empty('Not signed in.'));
    const btn = _button('Sign in', 'gold', () => _data?.signIn?.(() => select('account')));
    btn.style.marginTop = '14px';
    body.appendChild(btn);
    body.appendChild(_note('Passwordless — pick any name. Sign in to play online, async and the Battle.'));
  }
}

function _placeholderPanel(body, dest) {
  body.appendChild(_empty(`“${dest.label}” — coming soon to the ledger.`));
}

// ── Small render helpers ─────────────────────────────────────────────────────

function _resumeHero(row) {
  const f = mmFormatRow(row);
  const wrap = document.createElement('div');
  wrap.className = 'lg-resume';
  wrap.innerHTML =
    `<div class="lg-resume-thumb" aria-hidden="true">🜂</div>` +
    `<div class="lg-resume-body">` +
      `<div class="lg-resume-kicker">${row.action_needed ? 'Your turn' : 'Continue'}</div>` +
      `<div class="lg-resume-title gthc">${esc(f.title)}</div>` +
      `<div class="lg-resume-meta">${esc(f.meta || '')}</div>` +
    `</div>`;
  const actions = document.createElement('div');
  actions.className = 'lg-resume-actions';
  actions.appendChild(_button('▶ Resume', 'gold', () => _data?.activate?.(row)));
  wrap.querySelector('.lg-resume-body').appendChild(actions);
  return wrap;
}

function _feedRow(row, cta = null) {
  const f = mmFormatRow(row);
  const el = document.createElement('div');
  el.className = 'lg-feed-row' + (row.action_needed ? ' is-action' : '');
  el.innerHTML =
    `<div class="lg-feed-text"><div class="t">${esc(f.title)}</div><div class="m">${esc(f.meta || '')}</div></div>` +
    `<span class="lg-feed-cta">${cta || (row.action_needed ? 'your turn ▸' : 'open ▸')}</span>`;
  el.addEventListener('click', () => _data?.activate?.(row));
  return el;
}

function _missionRow(slot, m, status, index) {
  const playable = status === 'current' || status === 'available';
  const resume = status === 'current' && slot.resumeMissionId === m.id;
  const mark = status === 'done' ? '✓' : status === 'locked' ? '🔒' : '◆';
  const el = document.createElement('div');
  el.className = 'lg-mission is-' + status + (playable ? ' is-playable' : '');
  el.innerHTML =
    `<span class="lg-mission-n gthc">${roman(index + 1)}</span>` +
    `<span class="lg-mission-name">${esc(m.title || m.id)}</span>` +
    (playable
      ? `<button class="lg-btn lg-btn-gold lg-btn-sm">${resume ? '▶ Resume' : '▶ Play'}</button>`
      : `<span class="lg-mission-mark">${mark}</span>`);
  if (playable) {
    const go = (e) => { e?.stopPropagation?.(); _data?.startMission?.(slot.slot, m.id, resume); };
    el.querySelector('button')?.addEventListener('click', go);
    el.addEventListener('click', go);
    el.style.cursor = 'pointer';
  }
  return el;
}

function _button(label, variant, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lg-btn lg-btn-' + (variant || 'ghost');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function _cap(text)  { const d = document.createElement('div'); d.className = 'lg-cap'; d.textContent = text; return d; }
function _empty(text){ const p = document.createElement('p'); p.className = 'ledger-placeholder'; p.textContent = text; return p; }
function _note(text) { const p = document.createElement('p'); p.className = 'lg-note'; p.textContent = text; return p; }
function roman(n)    { return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || String(n); }
function esc(s)      { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export function show() { _root?.classList.add('is-active'); }
export function hide() { _root?.classList.remove('is-active'); }
export function activeDestination() { return _activeId; }
