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
  { id: 'others',   icon: '🌙', label: 'Play Online',       title: 'Play Online',      tag: '— a single battle, or the war',      accent: 'purple' },
  { id: 'replays',  icon: '📜', label: 'Replays',          title: 'Replays',          tag: '— games already told',               accent: 'gold' },
  { id: 'account',  icon: '⚙',  label: 'Account',          title: 'Account',          tag: '',                                   accent: 'gold' },
];

let _root = null;
let _activeId = null;
let _data = null;
let _renderToken = 0;            // guards against out-of-order async panel renders
let _campSlot = null;            // selected campaign slot (Campaign destination)
let _campView = 'missions';      // Campaign sub-view: 'missions' | 'party'
let _campBriefing = null;        // active mission briefing ({slot,missionId,resume,title,briefing,index})
let _campConfirmDelete = null;   // slot index awaiting delete confirmation
let _skFaction = null;           // selected Skirmish champion
const _skOpts = { mapSize: 'standard', nodeCount: 3, aiDifficulty: 'normal' };
let _othersView = 'landing';     // Play With Others sub-view: 'landing'|'find'|'lobby'|'battle'
let _lobby = null;               // current lobby state (from the onLobby push)
let _lobbyList = [];             // open public lobbies (from onLobbyList)
let _openLobbiesEl = null;       // the live open-lobbies <div> in the Find view
let _createAsync = false;        // Find-a-Game create defaults to async cadence

// Game-styled hover tooltip (position:fixed so the scrolling pane never clips it).
let _tipEl = null, _tipAnchor = null;
function _showTip(anchor, text) {
  _hideTip();
  if (!text) return;
  _tipEl = document.createElement('div');
  _tipEl.className = 'lg-tip';
  _tipEl.textContent = text;
  document.body.appendChild(_tipEl);
  const r = anchor.getBoundingClientRect();
  const t = _tipEl.getBoundingClientRect();
  let left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
  let top = r.top - t.height - 8;
  if (top < 8) top = r.bottom + 8;          // flip below when there's no room above
  _tipEl.style.left = `${left}px`;
  _tipEl.style.top = `${top}px`;
}
function _hideTip() { if (_tipEl) { _tipEl.remove(); _tipEl = null; } _tipAnchor = null; }

export function initLedger({ playerName, start = 'continue', data = null } = {}) {
  _root = document.getElementById('ledger-screen');
  if (!_root) return null;
  _data = data;
  // Delegate hover tooltips for any [data-tip] in the pane (abilities, etc.).
  const paneEl = document.getElementById('ledger-pane');
  if (paneEl && !paneEl._tipsBound) {
    paneEl._tipsBound = true;
    paneEl.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-tip]');
      if (t && t !== _tipAnchor) { _tipAnchor = t; _showTip(t, t.dataset.tip); }
    });
    paneEl.addEventListener('mouseout', (e) => {
      const t = e.target.closest('[data-tip]');
      if (t && !t.contains(e.relatedTarget)) _hideTip();
    });
  }
  const nameEl = document.getElementById('ledger-user-name');
  if (nameEl) nameEl.textContent = playerName || _data?.session?.()?.username || 'Wanderer';
  // Live lobby pushes → switch Play With Others into the lobby view + re-render.
  _data?.onLobby?.((lobby) => {
    _lobby = lobby;
    _othersView = 'lobby';
    if (_activeId === 'others') select('others');
  });
  _data?.onLobbyList?.((rooms) => {
    _lobbyList = rooms || [];
    // Update the list IN PLACE — never select()/re-render here. _othersFind()
    // calls browse() on every render, so re-rendering from this callback would
    // loop (browse → onLobbyList → render → browse → …).
    _renderOpenLobbiesList();
  });
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
    item.addEventListener('click', () => { _campBriefing = null; _campConfirmDelete = null; select(d.id); });
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
  if (_campBriefing) return _campaignBriefing(body);
  // Resolve the selected slot (default to the active/most-recent playthrough).
  if (!data.slots.some(s => s.slot === _campSlot)) _campSlot = data.activeSlotIndex;
  const sel = data.slots.find(s => s.slot === _campSlot) || data.slots[0];

  body.appendChild(_cap('Your playthroughs'));
  const slotRow = document.createElement('div');
  slotRow.className = 'lg-slots';
  for (const s of data.slots) {
    const card = document.createElement('div');
    card.className = 'lg-slot' + (s.slot === sel.slot ? ' is-active' : '') + (s.started ? '' : ' is-new');

    // Inline delete confirmation (replaces the card's body while pending).
    if (_campConfirmDelete === s.slot) {
      card.classList.add('is-confirm');
      card.innerHTML = `<div class="lg-slot-tag">Slot ${roman(s.slot)}</div>` +
        `<div class="lg-slot-confirm-q">Wipe this slot? This can't be undone.</div>`;
      const btns = document.createElement('div');
      btns.className = 'lg-slot-confirm';
      btns.appendChild(_button('Delete', 'danger', () => {
        _data?.deleteCampaignSlot?.(s.slot);
        _campConfirmDelete = null;
        if (_campSlot === s.slot) _campSlot = null;
        select('campaign');
      }));
      btns.appendChild(_button('Cancel', 'ghost', () => { _campConfirmDelete = null; select('campaign'); }));
      card.appendChild(btns);
      slotRow.appendChild(card);
      continue;
    }

    card.innerHTML = s.started
      ? `<div class="lg-slot-tag">Slot ${roman(s.slot)}${s.slot === sel.slot ? ' · selected' : ''}</div>` +
        `<div class="lg-slot-title gthc">${s.isComplete ? 'Complete' : s.completedCount + ' cleared'}</div>` +
        `<div class="lg-slot-sub">${s.completedCount} mission${s.completedCount === 1 ? '' : 's'} won</div>`
      : `<div class="lg-slot-tag">Slot ${roman(s.slot)}</div>` +
        `<div class="lg-slot-title gthc">New</div>` +
        `<div class="lg-slot-sub">begin a playthrough</div>`;
    card.addEventListener('click', () => { _campSlot = s.slot; _campBriefing = null; select('campaign'); });

    // Started slots get a ✕ to wipe them (asks for confirmation first).
    if (s.started) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'lg-slot-del';
      del.textContent = '✕';
      del.title = 'Delete this slot';
      del.addEventListener('click', (e) => { e.stopPropagation(); _campConfirmDelete = s.slot; select('campaign'); });
      card.appendChild(del);
    }
    slotRow.appendChild(card);
  }
  body.appendChild(slotRow);

  // Page-turn between the mission chronicle and the warband — full-width tabs.
  const tabs = document.createElement('div');
  tabs.className = 'lg-camp-tabs';
  tabs.appendChild(_button('Choose Next Mission', _campView === 'missions' ? 'gold' : 'ghost',
    () => { _campView = 'missions'; select('campaign'); }));
  tabs.appendChild(_button('Manage the Party', _campView === 'party' ? 'gold' : 'ghost',
    () => { _campView = 'party'; select('campaign'); }));
  body.appendChild(tabs);

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

/** Mission briefing — shown before a mission launches (title, briefing, Begin). */
function _campaignBriefing(body) {
  const b = _campBriefing;
  body.appendChild(_backRow('‹ Back to the chronicle', () => { _campBriefing = null; select('campaign'); }));
  const head = document.createElement('div');
  head.className = 'lg-brief-head';
  head.innerHTML =
    `<div class="lg-brief-kicker">Mission ${roman((b.index ?? 0) + 1)}</div>` +
    `<div class="lg-brief-title gthc">${esc(b.title)}</div>`;
  body.appendChild(head);
  const rule = document.createElement('div'); rule.className = 'ledger-rule'; body.appendChild(rule);
  const text = document.createElement('p');
  text.className = 'lg-brief-text';
  text.textContent = b.briefing || 'The night waits. Steel yourself and step into the dark.';
  body.appendChild(text);
  const begin = _button(b.resume ? '▶ Resume Mission' : '▶ Begin Mission', 'gold',
    () => _data?.startMission?.(b.slot, b.missionId, b.resume));
  begin.style.marginTop = '20px';
  body.appendChild(begin);
}

/** Warband (Party) view — reuses the existing party-pane renderer + mutations.
 *  Injects the party HTML and wires its controls back to partyAction. */
function _renderPartyView(body, sel) {
  const container = document.createElement('div');
  container.className = 'lg-party';
  body.appendChild(container);
  container.appendChild(_empty('Gathering the warband…'));
  // Portraits load lazily; await them so the character icons render (not glyphs).
  const render = () => {
    const data = _data?.campaignParty?.(sel.slot);
    if (!data || !data.html) {
      container.replaceChildren(_empty('No warband yet — start this playthrough to gather survivors.'));
      return;
    }
    container.innerHTML = data.html;
    _wirePartyButtons(container, sel.slot);
  };
  Promise.resolve(_data?.preloadPortraits?.()).then(render).catch(render);
}

function _wirePartyButtons(container, slot) {
  const apply = (kind, idx, weapon) => {
    const html = _data?.partyAction?.(kind, idx, weapon);
    if (html != null) { container.innerHTML = html; _wirePartyButtons(container, slot); }
  };
  const wire = (selector, kind) =>
    container.querySelectorAll(selector).forEach((btn) =>
      btn.addEventListener('click', () => apply(kind, btn.dataset.idx)));
  wire('.cprog-promote', 'promote');
  wire('.cprog-demote', 'demote');
  wire('.cprog-heal-btn', 'heal');

  // Click a carried (non-equipped) weapon slot to make it the equipped weapon.
  container.querySelectorAll('.cprog-wslot[data-weapon]:not(.is-equipped)').forEach((el) =>
    el.addEventListener('click', () => apply('equip', el.dataset.idx, el.dataset.weapon)));

  // Drag sources: every weapon slot (unit or pool) carrying a weapon id.
  container.querySelectorAll('[draggable="true"][data-weapon]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({
        from: el.dataset.from, idx: el.dataset.idx ?? null, weapon: el.dataset.weapon,
      }));
      el.classList.add('is-dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
  });

  const allowDrop = (el) => {
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('is-drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
  };
  // Drop on a unit card → arm it from the pool (or hand off from another unit).
  container.querySelectorAll('.cprog-card[data-drop="unit"]').forEach((card) => {
    allowDrop(card);
    card.addEventListener('drop', (e) => {
      e.preventDefault(); card.classList.remove('is-drop');
      const d = _parseDrag(e); if (!d) return;
      const idx = card.dataset.idx;
      if (d.from === 'pool') apply('carry', idx, d.weapon);
      else if (d.from === 'unit' && String(d.idx) !== String(idx)) {
        _data?.partyAction?.('stow', d.idx, d.weapon); // source → pool
        apply('carry', idx, d.weapon);                 // pool → target
      }
    });
  });
  // Drop on the inventory grid → stow a unit's weapon back to the pool.
  container.querySelectorAll('.cprog-inv-grid[data-drop="pool"]').forEach((grid) => {
    allowDrop(grid);
    grid.addEventListener('drop', (e) => {
      e.preventDefault(); grid.classList.remove('is-drop');
      const d = _parseDrag(e); if (!d) return;
      if (d.from === 'unit') apply('stow', d.idx, d.weapon);
    });
  });
}

function _parseDrag(e) {
  try { return JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return null; }
}

/** Skirmish — pick a champion, set the night, start a game vs AI. */
function _panelSkirmish(body) {
  const factions = _data?.skirmishFactions?.() ?? [];
  if (!factions.length) return _placeholderPanel(body, { label: 'Skirmish' });
  if (!factions.some(f => f.id === _skFaction)) _skFaction = factions[0].id;

  body.appendChild(_cap('Your champion'));
  for (const [side, label, icon] of [['day', 'Day — the Hero', '☀'], ['night', 'Night — the Witch', '🌙']]) {
    const fs = factions.filter((f) => f.side === side);
    if (!fs.length) continue;
    const row = document.createElement('div');
    row.className = 'lg-champ-side is-' + side;
    row.innerHTML = `<div class="lg-champ-side-label">${icon} ${label}</div>`;
    const grid = document.createElement('div');
    grid.className = 'lg-champions';
    for (const f of fs) grid.appendChild(_champCard(f));
    row.appendChild(grid);
    body.appendChild(row);
  }

  body.appendChild(_cap('The night ahead'));
  const opts = document.createElement('div');
  opts.className = 'lg-opts';
  opts.appendChild(_optSelect('mapSize', 'Map size', MAP_SIZE_OPTS, (v) => v));
  opts.appendChild(_optSelect('nodeCount', 'Power nodes', [
    { value: '2', label: '2', sub: 'sparse' }, { value: '3', label: '3', sub: 'default' }, { value: '4', label: '4', sub: 'crowded' },
  ], (v) => parseInt(v, 10)));
  opts.appendChild(_optSelect('aiDifficulty', 'AI cunning', [
    { value: 'easy', label: 'Easy', sub: 'forgiving' }, { value: 'normal', label: 'Normal', sub: 'balanced' }, { value: 'hard', label: 'Hard', sub: 'ruthless' },
  ], (v) => v));
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

function _champCard(f) {
  const card = document.createElement('div');
  card.className = 'lg-champion is-' + (f.side === 'night' ? 'night' : 'day') + (f.id === _skFaction ? ' is-selected' : '');
  const stat = (lbl, val, tip) => `<span class="cprog-ustat"${tip ? ` title="${esc(tip)}"` : ''}>${lbl} <b>${val}</b></span>`;
  const statsHtml = f.atk != null
    ? `<div class="cprog-ustats">${stat('HP', f.hp)}${stat('ATK', f.atk)}${stat('DEF', f.def)}${stat('RNG', f.rng)}` +
      `${stat('AGI', f.agi, 'Agility — higher acts earlier each turn')}</div>`
    : '';
  const weaponHtml = f.weapon
    ? `<div class="lg-champ-weapon">⚔ ${esc(f.weapon.name)}${f.weapon.stats ? ` <span class="lg-champ-wstats">${esc(f.weapon.stats)}</span>` : ''}</div>`
    : '';
  const abilitiesHtml = (f.abilities && f.abilities.length)
    ? `<div class="cprog-uabilities">${f.abilities.map((a) =>
        `<span class="cprog-uability" data-tip="${esc(a.description)}">✦ ${esc(a.label)}</span>`).join('')}</div>`
    : '';
  card.innerHTML =
    `<img src="${esc(f.img)}" alt="">` +
    `<div class="lg-champ-info">` +
      `<div class="lg-champ-top"><span class="nm">${esc(f.name)}</span></div>` +
      statsHtml + weaponHtml + abilitiesHtml +
      (f.blurb ? `<div class="lg-champ-blurb">${esc(f.blurb)}</div>` : '') +
    `</div>`;
  card.addEventListener('click', () => { _skFaction = f.id; select('skirmish'); });
  return card;
}

function _optSelect(key, label, options, parse) {
  const dd = _dropdown(options, String(_skOpts[key]), (v) => { _skOpts[key] = parse(v); _updateSkirmishSummary(); });
  return _optWrap(label, dd);
}

function _updateSkirmishSummary() {
  const el = document.getElementById('lg-sk-summary');
  if (!el) return;
  const f = (_data?.skirmishFactions?.() ?? []).find((x) => x.id === _skFaction);
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  el.textContent = [f?.name, cap(_skOpts.mapSize), `${_skOpts.nodeCount} nodes`, cap(_skOpts.aiDifficulty)].filter(Boolean).join(' · ');
}

/** Play With Others — landing (rhythms + Battle + games), Find-a-Game, and the
 *  native lobby. Live/create/join/lobby are native; Async + Battle still bridge. */
function _panelOthers(body) {
  if (!_data?.online) return _placeholderPanel(body, { label: 'Play Online' });
  if (_othersView === 'lobby' && _lobby) return _othersLobby(body, _lobby);
  if (_othersView === 'find') return _othersFind(body);
  if (_othersView === 'battle') return _othersBattle(body);
  _othersLanding(body);
}

function _othersLanding(body) {
  const token = ++_renderToken;
  body.innerHTML = `<p class="ledger-placeholder">Reading the table…</p>`;
  Promise.resolve(_data.online()).then(({ signedIn, games, battle }) => {
    if (token !== _renderToken) return;
    body.replaceChildren();
    if (!signedIn) {
      body.appendChild(_empty('Sign in to play online — a single battle, or the Battle for Caleb\'s Hollow.'));
      body.appendChild(_signInForm(() => select('others')));
      return;
    }
    const rh = document.createElement('div');
    rh.className = 'lg-rhythms';
    rh.appendChild(_rhythmCard('⚔ Single Battle', 'live or async', 'One game against another player. Choose the pace when you create it.',
      () => { _createAsync = false; _othersView = 'find'; select('others'); }));
    body.appendChild(rh);

    const bf = document.createElement('div');
    bf.className = 'lg-battle' + (battle ? ' is-live' : '');
    bf.innerHTML =
      `<div class="lg-battle-head"><span class="gthc">⚔ The Battle for Caleb's Hollow</span>` +
      `${battle ? '<span class="lg-battle-live">● live</span>' : '<span class="lg-battle-cta">View ▸</span>'}</div>` +
      `<div class="lg-battle-sub">Persistent 10v10 war — turns resolve at noon &amp; midnight.` +
      `${battle && battle.round != null ? ' · Round ' + battle.round : ''}</div>`;
    bf.addEventListener('click', () => { _othersView = 'battle'; select('others'); });
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

/** Find a Game — quick-match, create (with config), join-by-code, open lobbies. */
function _othersFind(body) {
  body.appendChild(_backRow('‹ Back', () => { _othersView = 'landing'; select('others'); }));

  body.appendChild(_cap('Create a Single Battle'));
  const opts = document.createElement('div');
  opts.className = 'lg-opts';
  const modeDd = _dropdown(CADENCE_OPTS, _createAsync ? 'async' : 'live', (v) => { _createAsync = v === 'async'; select('others'); });
  const ppsDd  = _dropdown([{ value: '1', label: '1v1' }, { value: '2', label: '2v2' }, { value: '3', label: '3v3' }, { value: '4', label: '4v4' }], '1');
  const mapDd  = _dropdown(MAP_SIZE_OPTS, 'standard');
  const privDd = _dropdown([{ value: 'false', label: 'Public', sub: 'Listed; anyone can join' }, { value: 'true', label: 'Private', sub: 'Join by code only' }], 'false');
  const timeDd = _createAsync
    ? _dropdown([{ value: '43200000', label: '12 hours' }, { value: '86400000', label: '1 day' }, { value: '172800000', label: '2 days' }], '86400000')
    : _dropdown([{ value: '60000', label: '60 sec' }, { value: '90000', label: '90 sec' }, { value: '120000', label: '2 min' }], '90000');
  opts.appendChild(_optWrap('Cadence', modeDd));
  opts.appendChild(_optWrap('Players', ppsDd));
  opts.appendChild(_optWrap('Map', mapDd));
  opts.appendChild(_optWrap(_createAsync ? 'Per turn' : 'Turn timer', timeDd));
  opts.appendChild(_optWrap('Visibility', privDd));
  body.appendChild(opts);
  const createBtn = _button('＋ Create Game', 'gold', () => _data.lobby?.create?.({
    playersPerSide: parseInt(ppsDd.value, 10), mapSize: mapDd.value,
    isPrivate: privDd.value === 'true', isAsync: _createAsync,
    turnIntervalMs: parseInt(timeDd.value, 10),
  }));
  createBtn.style.marginTop = '12px';
  body.appendChild(createBtn);

  body.appendChild(_cap('Have a code?'));
  const jrow = document.createElement('div');
  jrow.className = 'lg-join-row';
  const input = document.createElement('input');
  input.className = 'lg-code-input';
  input.placeholder = 'CODE';
  input.maxLength = 8;
  jrow.appendChild(input);
  jrow.appendChild(_button('Join ▸', 'gold', () => { const c = input.value.trim(); if (c) _data.lobby?.join?.(c); }));
  body.appendChild(jrow);

  body.appendChild(_cap('Open lobbies'));
  _openLobbiesEl = document.createElement('div');
  _openLobbiesEl.className = 'lg-feed';
  body.appendChild(_openLobbiesEl);
  _renderOpenLobbiesList();          // paint with whatever we have
  _data.lobby?.browse?.();           // then refresh — onLobbyList repaints in place
}

/** Repaint the open-lobbies list in place (no panel re-render — see onLobbyList). */
function _renderOpenLobbiesList() {
  const list = _openLobbiesEl;
  if (!list || !list.isConnected) return;
  list.replaceChildren();
  if (!_lobbyList.length) { list.appendChild(_empty('Looking for open games…')); return; }
  for (const room of _lobbyList) {
    const pps = room.playersPerSide ?? room.pps ?? 1;
    const el = document.createElement('div');
    el.className = 'lg-feed-row';
    el.innerHTML = `<div class="lg-feed-text"><div class="t">${esc(room.hostName || room.host || 'Open game')}</div>` +
      `<div class="m">${pps}v${pps} · ${esc(cap(room.mapSize || 'standard'))}</div></div><span class="lg-feed-cta">join ▸</span>`;
    el.addEventListener('click', () => _data.lobby?.join?.(room.code || room.id));
    list.appendChild(el);
  }
}

/** The native lobby — Day/Night seats from live room state, with the seat
 *  actions (claim, faction, add/remove AI, fill, invite, start). */
function _othersLobby(body, lobby) {
  body.appendChild(_backRow('‹ Leave lobby', () => {
    _data.lobby?.leave?.(); _lobby = null; _othersView = 'landing'; select('others');
  }));

  const cfg = lobby.config || {};
  const pps = cfg.playersPerSide ?? 1;
  const myId = _data.myPlayerId?.();
  const isHost = lobby.hostPlayerId === myId;
  const unassigned = lobby.unassigned || [];
  const meUnassigned = unassigned.some((u) => u.playerId === myId);
  const meInSlot = (lobby.slots || []).some((s) => s.playerId === myId && s.status === 'human');
  const canClaim = meUnassigned || meInSlot;

  const head = document.createElement('div');
  head.className = 'lg-lobby-head';
  head.innerHTML =
    `<div><span class="gthc lg-lobby-title">Game Lobby</span>` +
    `<div class="lg-lobby-sub">${pps}v${pps} · ${cfg.isAsync ? 'Async' : 'Live'}${cfg.mapSize ? ' · ' + cap(cfg.mapSize) : ''}</div></div>` +
    (lobby.isPrivate && lobby.code
      ? `<div class="lg-lobby-code"><div class="lbl">Private code</div><span class="gthc code">${esc(lobby.code)}</span></div>`
      : '');
  body.appendChild(head);
  const rule = document.createElement('div'); rule.className = 'ledger-rule'; body.appendChild(rule);

  const link = _data.inviteLink?.();
  if (link) {
    const inviteRow = document.createElement('div');
    inviteRow.className = 'lg-invite-row';
    const copy = _button('📋 Copy invite link', 'ghost', () => {
      navigator.clipboard?.writeText(link).then(() => {
        copy.textContent = 'Copied ✓';
        setTimeout(() => { copy.textContent = '📋 Copy invite link'; }, 1500);
      }).catch(() => {});
    });
    inviteRow.appendChild(copy);
    body.appendChild(inviteRow);
  }

  // Players who haven't picked a side yet (the host starts here).
  if (unassigned.length) {
    const ua = document.createElement('div');
    ua.className = 'lg-unassigned';
    ua.innerHTML = `<span class="lbl">Pick a side</span> ` + unassigned.map((u) =>
      `<span class="chip${u.playerId === myId ? ' you' : ''}">${esc(u.name)}${u.playerId === myId ? ' · you' : ''}</span>`).join(' ');
    body.appendChild(ua);
  }

  const cols = document.createElement('div');
  cols.className = 'lg-seats';
  for (const [side, label, icon] of [['day', 'Day', '☀'], ['night', 'Night', '🌙']]) {
    const col = document.createElement('div');
    col.className = 'lg-seat-col is-' + side;
    col.innerHTML = `<div class="lg-seat-label">${icon} ${label}</div>`;
    const slots = (lobby.slots || []).filter((s) => s.side === side);
    for (const slot of slots) col.appendChild(_lobbySeat(lobby, slot, { myId, isHost, canClaim }));
    cols.appendChild(col);
  }
  body.appendChild(cols);

  const footer = document.createElement('div');
  footer.className = 'lg-lobby-footer';
  if (isHost) footer.appendChild(_button('🤖 Fill with AI', 'ghost', () => _data.lobby?.fillAll?.('random')));
  const allFilled = (lobby.slots || []).every((s) => s.status === 'human' || s.status === 'ai');
  const startBtn = _button('▶ Start', 'gold', () => _data.lobby?.start?.());
  if (!isHost || !allFilled) startBtn.disabled = true;
  footer.appendChild(startBtn);
  body.appendChild(footer);
}

function _lobbySeat(lobby, slot, { myId, isHost, canClaim }) {
  const idx = (lobby.slots || []).indexOf(slot);
  const el = document.createElement('div');
  el.className = 'lg-seat';
  const fac = slot.factionId || slot.faction || '';
  if (slot.status === 'human') {
    const isMe = slot.playerId === myId;
    el.classList.add('is-human');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = (slot.name || 'Player') + (isMe ? ' · you' : '');
    el.appendChild(nm);
    if (isMe) {
      // Switch your champion within your side.
      const facs = (_data.factionsForSide?.(slot.side) || []).map((f) => ({ value: f.id, label: f.name }));
      const dd = _dropdown(facs, slot.factionId || slot.faction, (v) => _data.lobby?.setFaction?.(v));
      dd.classList.add('lg-fac-dd');
      el.appendChild(dd);
    } else {
      const fc = document.createElement('span');
      fc.className = 'fac';
      fc.textContent = cap(fac);
      el.appendChild(fc);
    }
  } else if (slot.status === 'ai') {
    el.classList.add('is-ai');
    el.innerHTML = `<span class="nm">🤖 ${esc(slot.name || 'AI')}</span><span class="fac">${esc(cap(fac))}</span>`;
    if (isHost) {
      const rm = _button('✕', 'ghost', () => _data.lobby?.removeSlotAI?.(idx));
      rm.classList.add('lg-seat-x');
      el.appendChild(rm);
    }
  } else {
    el.classList.add('is-open');
    el.innerHTML = `<span class="nm open">Open seat</span>`;
    const acts = document.createElement('div');
    acts.className = 'lg-seat-acts';
    if (canClaim) acts.appendChild(_button('Claim', 'gold', () => _data.lobby?.claimSlot?.(idx)));
    if (isHost) acts.appendChild(_button('🤖 AI', 'ghost', () => _data.lobby?.setSlotAI?.(idx, 'random')));
    el.appendChild(acts);
  }
  return el;
}

/** The Battle for Caleb's Hollow — native status panel + join (no legacy screen). */
function _othersBattle(body) {
  body.appendChild(_backRow('‹ Back', () => { _othersView = 'landing'; select('others'); }));
  const token = ++_renderToken;
  const loading = _empty('Reading the battlefield…');
  body.appendChild(loading);
  Promise.resolve(_data.battleStatus?.()).then((st) => {
    if (token !== _renderToken) return;
    loading.remove();
    const b = st?.myBattle || (st?.battles && st.battles[0]) || null;
    if (!b) { body.appendChild(_empty('No active Battle right now — check back at the next muster.')); return; }
    const day = b.dayScore ?? 0, night = b.nightScore ?? 0, total = (day + night) || 1;
    const pps = b.maxPerSide ?? 10;
    const card = document.createElement('div');
    card.className = 'lg-battle is-live';
    card.innerHTML =
      `<div class="lg-battle-head"><span class="gthc">⚔ The Battle for Caleb's Hollow</span><span class="lg-battle-live">● live</span></div>` +
      `<div class="lg-battle-scorebar"><span class="d">☀ Day ${day}</span>` +
      `<div class="track"><div class="fill" style="width:${Math.round(day / total * 100)}%"></div></div>` +
      `<span class="n">${night} Night 🌙</span></div>` +
      `<div class="lg-battle-sub">Persistent ${pps}v${pps} war${b.round != null ? ' · Round ' + b.round : ''}.</div>`;
    body.appendChild(card);
    const mySide = st?.mySide;
    if (mySide) {
      body.appendChild(_note(`You fight for ${mySide === 'day' ? '☀ Day' : '🌙 Night'}.`));
    } else {
      const j = _button('⚔ Join the Battle', 'purple', () => _data.joinBattle?.());
      j.style.marginTop = '14px';
      body.appendChild(j);
    }
  }).catch(() => { if (token === _renderToken) { loading.remove(); body.appendChild(_empty('Could not reach the Battle.')); } });
}

function _backRow(label, onClick) {
  const el = document.createElement('div');
  el.className = 'lg-back';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}
// Shared option lists (with subtext) for the create/skirmish dropdowns.
const MAP_SIZE_OPTS = [
  { value: 'skirmish', label: 'Skirmish', sub: '10×10 · quick duel' },
  { value: 'standard', label: 'Standard', sub: '14×14 · balanced' },
  { value: 'regional', label: 'Regional', sub: '19×19 · roomy' },
  { value: 'campaign', label: 'Campaign', sub: '23×23 · long game' },
  { value: 'battle',   label: 'Battle',   sub: '42×42 · epic war' },
];
const CADENCE_OPTS = [
  { value: 'live',  label: 'Live',  sub: 'Timed turns, one sitting' },
  { value: 'async', label: 'Async', sub: 'Play over days; we notify you' },
];

let _ddCloseBound = false;
function _bindDropdownClose() {
  if (_ddCloseBound) return;
  _ddCloseBound = true;
  document.addEventListener('click', () => {
    document.querySelectorAll('.lg-dd.is-open').forEach((el) => el.classList.remove('is-open'));
  });
}

/** Custom dropdown matching the ledger aesthetic, with per-option subtext.
 *  options: [{ value, label, sub? }]. Returns an element exposing a live `.value`. */
function _dropdown(options, value, onChange) {
  _bindDropdownClose();
  let cur = value ?? options[0]?.value;
  const root = document.createElement('div');
  root.className = 'lg-dd';
  Object.defineProperty(root, 'value', { get: () => cur, configurable: true });
  const labelFor = (v) => options.find((o) => o.value === v)?.label ?? v;
  const capBtn = document.createElement('button');
  capBtn.type = 'button';
  capBtn.className = 'lg-dd-cap';
  const renderCap = () => { capBtn.innerHTML = `<span class="lg-dd-cur">${esc(labelFor(cur))}</span><span class="lg-dd-arrow">▾</span>`; };
  renderCap();
  const menu = document.createElement('div');
  menu.className = 'lg-dd-menu';
  for (const o of options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lg-dd-item' + (o.value === cur ? ' is-sel' : '');
    item.innerHTML = `<span class="lg-dd-item-label">${esc(o.label)}</span>` +
      (o.sub ? `<span class="lg-dd-item-sub">${esc(o.sub)}</span>` : '');
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      cur = o.value;
      renderCap();
      menu.querySelectorAll('.lg-dd-item').forEach((el) => el.classList.toggle('is-sel', el === item));
      root.classList.remove('is-open');
      onChange?.(cur);
    });
    menu.appendChild(item);
  }
  capBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !root.classList.contains('is-open');
    document.querySelectorAll('.lg-dd.is-open').forEach((el) => el.classList.remove('is-open'));
    root.classList.toggle('is-open', willOpen);
  });
  root.appendChild(capBtn);
  root.appendChild(menu);
  return root;
}

function _optWrap(label, sel) {
  const wrap = document.createElement('label');
  wrap.className = 'lg-opt';
  const span = document.createElement('span');
  span.className = 'lg-opt-label';
  span.textContent = label;
  wrap.appendChild(span);
  wrap.appendChild(sel);
  return wrap;
}
function cap(s) { return s ? String(s)[0].toUpperCase() + String(s).slice(1) : s; }

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
  if (!session?.username) {
    body.appendChild(_empty('Not signed in.'));
    body.appendChild(_signInForm(() => select('account')));
    return;
  }
  const card = document.createElement('div');
  card.className = 'lg-account';
  card.innerHTML =
    `<img src="assets/char-paladin.png" alt="">` +
    `<div class="lg-account-id"><div class="nm gthc">${esc(session.username)}</div>` +
    `<div class="sub">${session.email ? esc(session.email) : 'passwordless'}</div></div>`;
  body.appendChild(card);

  body.appendChild(_cap('Change name'));
  body.appendChild(_editRow('New name', 'text', (val, status) => {
    status('Saving…');
    Promise.resolve(_data?.setUsername?.(val)).then((r) => {
      status(r?.ok ? 'Saved ✓' : (r?.error || 'Could not change name'), r?.ok);
      if (r?.ok) setTimeout(() => select('account'), 700);
    });
  }));

  body.appendChild(_cap('Link an email'));
  body.appendChild(_editRow('you@example.com', 'email', (val, status) => {
    status('Sending…');
    Promise.resolve(_data?.linkEmail?.(val)).then((r) =>
      status(r?.ok ? (r.message || 'Check your email ✓') : (r?.error || 'Could not send link'), r?.ok));
  }));

  const out = _button('Sign out', 'ghost', () => _data?.signOut?.());
  out.style.marginTop = '18px';
  body.appendChild(out);
}

/** Native passwordless sign-in form (no old auth dialog). */
function _signInForm(onDone) {
  const wrap = document.createElement('div');
  wrap.style.marginTop = '14px';
  const input = document.createElement('input');
  input.className = 'lg-code-input';
  input.placeholder = 'Choose a name';
  input.maxLength = 24;
  input.style.textTransform = 'none';
  input.style.letterSpacing = '0';
  const btn = _button('Sign in', 'gold', () => {
    const name = input.value.trim();
    if (name.length < 2) { input.focus(); return; }
    _data?.signInWithName?.(name, onDone);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
  const row = document.createElement('div');
  row.className = 'lg-join-row';
  row.appendChild(input);
  row.appendChild(btn);
  wrap.appendChild(row);
  wrap.appendChild(_note('Passwordless — pick any name. Link an email later to play across devices.'));
  return wrap;
}

/** Inline labelled input + Save button with a status line. */
function _editRow(placeholder, type, onSubmit) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'lg-join-row';
  const input = document.createElement('input');
  input.className = 'lg-code-input';
  input.placeholder = placeholder;
  input.type = type;
  input.style.textTransform = 'none';
  input.style.letterSpacing = '0';
  const status = document.createElement('span');
  status.className = 'lg-edit-status';
  const setStatus = (txt, ok) => { status.textContent = txt; status.className = 'lg-edit-status' + (ok ? ' ok' : ''); };
  const btn = _button('Save', 'gold', () => { const v = input.value.trim(); if (v) onSubmit(v, setStatus); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
  row.appendChild(input);
  row.appendChild(btn);
  wrap.appendChild(row);
  wrap.appendChild(status);
  return wrap;
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
  actions.appendChild(_button('▶ Resume', 'gold', () => _activateRow(row)));
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
  el.addEventListener('click', () => _activateRow(row));
  return el;
}

// Activate a feed row WITHOUT ever falling into the legacy menu: campaign rows
// launch natively, Battle rows open the native Battle view; everything else
// (online resume, SP resume, replays) hands straight to the game screen.
function _activateRow(row) {
  if (row.kind === 'local-campaign') { _data?.startMission?.(row._slotIndex, row._missionDef?.id, true); return; }
  if (row.kind === 'campaign-next') { _data?.startMission?.(row._slotIndex, row._nextMissionId, false); return; }
  if (row.kind === 'battle' || row.kind === 'battle-invite') { _othersView = 'battle'; select('others'); return; }
  _data?.activate?.(row);
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
    const go = (e) => {
      e?.stopPropagation?.();
      _campBriefing = { slot: slot.slot, missionId: m.id, resume, title: m.title || m.id, briefing: m.briefing || '', index };
      select('campaign');
    };
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
function roman(n) {
  if (!(n > 0)) return String(n ?? '');
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '', v = Math.floor(n);
  for (const [val, sym] of map) while (v >= val) { out += sym; v -= val; }
  return out;
}
function esc(s)      { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export function show() { _root?.classList.add('is-active'); }
export function hide() { _root?.classList.remove('is-active'); }
export function activeDestination() { return _activeId; }
