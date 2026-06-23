// ============================================================================
// The Ledger — menu controller (Direction B redesign).
//
// Owns the candlelit RAIL and which destination is shown; renders the active
// destination's panel into #ledger-pane in place — no card stack, nothing
// replaces the frame. DOM/render-only: main.js injects the data + actions
// (`initLedger({ data })`). Built ALONGSIDE the legacy #setup-screen and shown
// behind the `?ledger` dev preview until the single cutover.
// ============================================================================

import { mmSortRows, mmFormatRow, mmIsCampaignRow } from '../main-menu-games.js';
import { ICON } from '../icons.js';
import { mountServerSelector } from '../server-selector.js';
import { loadThumb, missionThumb, campaignMissionRowId } from './thumbnails.js';
import { isModeAvailable, isFactionAvailable, COMING_SOON_LABEL } from '../demo-config.js';

/** The six rail destinations, top to bottom (mirrors the mock). */
const DESTINATIONS = [
  { id: 'continue', icon: ICON.play,  label: 'Continue',         title: 'Continue',         tag: 'Games in Progress',            accent: 'gold' },
  { id: 'campaign', icon: '\uE021',  label: 'Campaign',         title: 'The Campaign',     tag: 'Assemble a party of survivors and follow the story of Ishmael and the Witch',    accent: 'gold' },
  { id: 'skirmish', icon: '\uE061', label: 'Skirmish',         title: 'Skirmish',         tag: 'Single player battle vs. AI - hold the majority of power nodes to win', accent: 'gold' },
  { id: 'others',   icon: '\uE023', label: 'Play Online',       title: 'Play Online',      tag: 'Multiplayer single battles, or join the persistent two-week long async battle for Caleb\'s Hollow',      accent: 'purple' },
  { id: 'replays',  icon: '\uE014', label: 'Replays',          title: 'Replays',          tag: 'Revisit past games',               accent: 'gold' },
  { id: 'account',  icon: '\uE0A1',  label: 'Account',          title: 'Account',          tag: '',                                   accent: 'gold' },
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
const _skOpts = { mapSize: 'standard', nodeCount: 3, aiDifficulty: 'normal', startingResources: 'none' };
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
  return {
    show, hide, select,
    // Land on the campaign mission LIST, clearing any primed briefing / party
    // sub-view — used after a mission ends so we don't re-open the briefing for
    // the mission just played.
    showCampaignList: () => {
      _campBriefing = null;
      _campConfirmDelete = null;
      _campView = 'missions';
      show();
      select('campaign');
    },
  };
}

function _renderRail() {
  const host = document.getElementById('ledger-rail-items');
  if (!host) return;
  host.replaceChildren();
  for (const d of DESTINATIONS) {
    const item = document.createElement('div');
    const available = isModeAvailable(d.id);   // demo builds can flip a mode OFF
    item.className = 'ledger-rail-item' + (available ? '' : ' is-soon');
    item.dataset.dest = d.id;
    item.innerHTML = `<span class="ic">${d.icon}</span><span class="lb">${d.label}</span>` +
      (available ? '' : `<span class="lg-soon-badge">${COMING_SOON_LABEL}</span>`);
    if (available) {
      item.addEventListener('click', () => { _campBriefing = null; _campConfirmDelete = null; select(d.id); });
    } else {
      item.setAttribute('aria-disabled', 'true');
      item.title = `${d.label} — ${COMING_SOON_LABEL}`;
    }
    host.appendChild(item);
  }
}

/** Light up a rail item and re-bind the ledger pane to that destination. */
export function select(id) {
  let dest = DESTINATIONS.find(d => d.id === id);
  if (!dest) return;
  // A demo build can disable a mode — never bind the pane to a coming-soon
  // destination (e.g. via the `start` default); fall back to Continue.
  if (!isModeAvailable(dest.id)) {
    dest = DESTINATIONS.find(d => d.id === 'continue' && isModeAvailable('continue')) ||
           DESTINATIONS.find(d => isModeAvailable(d.id)) || dest;
    if (!isModeAvailable(dest.id)) return;
  }
  id = dest.id;
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
    card.addEventListener('click', () => {
      _campSlot = s.slot; _campBriefing = null;
      _data?.setActiveCampaignSlot?.(s.slot);   // persist so Continue tracks this slot
      select('campaign');
    });

    // Started slots get a ✕ to wipe them (asks for confirmation first).
    if (s.started) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'lg-slot-del';
      del.textContent = '\uE070';
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

  const missions = sel.missions || [];
  if (!missions.length) {
    const chron = document.createElement('div');
    chron.className = 'lg-chronicle';
    chron.appendChild(_empty('No missions found for this campaign.'));
    body.appendChild(chron);
    return;
  }
  // Group missions into chapters (delineated headings), so additional chapters
  // can slot in later just by tagging missions with a higher `chapter` number.
  // Within each chapter the mission's display index stays its overall campaign
  // position (so the Roman numeral matches the briefing's "Mission N").
  for (const chap of _groupByChapter(missions)) {
    body.appendChild(_chapterHeading(chap.chapter));
    const chron = document.createElement('div');
    chron.className = 'lg-chronicle';
    for (const { m, index } of chap.missions) {
      // A disabled mission is shelved — shown greyed + non-selectable, never
      // current/available, regardless of slot progress.
      const status = m.disabled ? 'disabled'
        : m.completed ? 'done'
        : (m.id === sel.nextMissionId ? 'current'
        : (m.available ? 'available' : 'locked'));
      chron.appendChild(_missionRow(sel, m, status, index, data.campaignId));
    }
    body.appendChild(chron);
  }
}

// Display titles for each campaign chapter. Defaults to "Chapter N" for any
// chapter not named here, so adding a chapter is data-only.
const CHAPTER_TITLES = {
  1: 'Welcome to Caleb\'s Hollow',
};

/** Bucket a flat mission list into ordered chapters, preserving each mission's
 *  overall campaign number (used for its Roman-numeral label). We use the stable
 *  catalog `number` (tutorial=0, prologue=1, …), NOT the list position — so a
 *  dropped disabled mission never renumbers the rest. Missions with no `chapter`
 *  tag fall into Chapter 1. */
function _groupByChapter(missions) {
  const order = [];
  const byChapter = new Map();
  missions.forEach((m, pos) => {
    const chapter = Number.isFinite(m.chapter) ? m.chapter : 1;
    const index = Number.isFinite(m.number) ? m.number : pos;
    if (!byChapter.has(chapter)) { byChapter.set(chapter, []); order.push(chapter); }
    byChapter.get(chapter).push({ m, index });
  });
  return order.map(chapter => ({ chapter, missions: byChapter.get(chapter) }));
}

/** A delineating chapter heading above its missions, e.g.
 *  "Chapter 1 — Welcome to Caleb's Hollow". */
function _chapterHeading(chapter) {
  const name = CHAPTER_TITLES[chapter];
  const text = name ? `Chapter ${chapter} — ${name}` : `Chapter ${chapter}`;
  const el = document.createElement('div');
  el.className = 'lg-chapter-head';
  el.textContent = text;
  return el;
}

/** Mission briefing — shown before a mission launches (title, briefing, Begin). */
function _campaignBriefing(body) {
  const b = _campBriefing;
  body.appendChild(_backRow('‹ Back to the chronicle', () => { _campBriefing = null; select('campaign'); }));

  // Two-column briefing: the map image on the LEFT, the mission text (kicker +
  // title + briefing copy) on the RIGHT. The columns stack on narrow widths
  // (see .lg-brief-cols in styles-ledger.css). The back row and the Begin/Resume
  // button stay full-width, above and below the columns.
  const cols = document.createElement('div');
  cols.className = 'lg-brief-cols';

  cols.appendChild(_briefMapImage(b));

  const textCol = document.createElement('div');
  textCol.className = 'lg-brief-col-text';
  const head = document.createElement('div');
  head.className = 'lg-brief-head';
  // Mission number is 0-based from the tutorial — Mission 0 is the tutorial.
  const kicker = `Mission ${b.index ?? 0}`;
  head.innerHTML =
    `<div class="lg-brief-kicker">${esc(kicker)}</div>` +
    `<div class="lg-brief-title gthc">${esc(b.title)}</div>`;
  textCol.appendChild(head);
  const rule = document.createElement('div'); rule.className = 'ledger-rule'; textCol.appendChild(rule);
  const text = document.createElement('p');
  text.className = 'lg-brief-text';
  text.textContent = b.briefing || 'The night waits. Steel yourself and step into the dark.';
  textCol.appendChild(text);
  cols.appendChild(textCol);

  body.appendChild(cols);

  const begin = _button(b.resume ? `${ICON.play} Resume Mission` : `${ICON.play} Begin Mission`, 'gold',
    () => _data?.startMission?.(b.slot, b.missionId, b.resume));
  begin.style.marginTop = '20px';
  body.appendChild(begin);
}

/** Displayed mission number label for a catalog index. The list is 0-based from
 *  the tutorial (index 0 = the tutorial = "Mission 0", index 1 = the first real
 *  mission), so the number shown matches the briefing's "Mission N". */
function _missionNumLabel(index) {
  return index === 0 ? '0' : roman(index);
}

/** Big map preview for the mission briefing — the live saved thumbnail when the
 *  mission is mid-play (keyed by its row id `<campaignId>/slot<N>/<missionId>`,
 *  captured at round-end), else the mission's fixed pre-generated map image. A
 *  larger view than the list-card thumbs, so the briefing shows the board the
 *  player is stepping into. */
function _briefMapImage(b) {
  const rowId = campaignMissionRowId(b.campaignId, b.slot, b.missionId);
  const img = missionThumb(b.missionId, rowId);
  const el = document.createElement('div');
  el.className = 'lg-brief-map' + (img ? ' has-img' : '');
  if (img) el.style.backgroundImage = `url(${img})`;
  else el.textContent = '\uE08D';
  el.setAttribute('aria-hidden', 'true');
  return el;
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
    _ensureInvTab(container);
  };
  Promise.resolve(_data?.preloadPortraits?.()).then(render).catch(render);
}

/** Mobile-only pull-out tab that opens/closes the inventory drawer. */
function _ensureInvTab(container) {
  const shared = container.querySelector('.cprog-shared');
  if (!shared) return;
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'lg-inv-tab';
  tab.textContent = '\uE016 Inventory';
  tab.addEventListener('click', () => shared.classList.toggle('is-open'));
  container.appendChild(tab);
}

function _wirePartyButtons(container, slot) {
  const apply = (kind, idx, weapon) => {
    const html = _data?.partyAction?.(kind, idx, weapon);
    if (html != null) { container.innerHTML = html; _wirePartyButtons(container, slot); _ensureInvTab(container); }
  };
  const wire = (selector, kind) =>
    container.querySelectorAll(selector).forEach((btn) =>
      btn.addEventListener('click', () => apply(kind, btn.dataset.idx)));
  wire('.cprog-promote', 'promote');
  wire('.cprog-demote', 'demote');
  wire('.cprog-heal-btn', 'heal');
  _wirePartyDrag(container, apply);
}

// ── Pointer-based weapon drag (works with mouse AND touch — HTML5 DnD never
//    fires from touch). Tap a carried weapon = equip it; drag pool→unit = carry;
//    drag unit→inventory = stow. On mobile, grabbing a weapon out of the drawer
//    collapses it; dragging a unit's weapon over the Inventory tab opens it.
let _pdrag = null;          // active drag: { src, from, idx, weapon, x0, y0, moved, ghost }
let _pdragApply = null;     // latest party apply()
let _pdragContainer = null; // latest .lg-party container
let _pdragBound = false;

function _wirePartyDrag(container, apply) {
  _pdragApply = apply;
  _pdragContainer = container;
  if (!container._pdragDown) {
    container._pdragDown = true;                  // delegate; survives innerHTML swaps
    container.addEventListener('pointerdown', (e) => {
      const src = e.target.closest('.cprog-wslot[data-weapon], .cprog-slot.is-weapon[data-weapon]');
      if (!src || (e.pointerType === 'mouse' && e.button !== 0)) return;
      _pdrag = { src, from: src.dataset.from, idx: src.dataset.idx ?? null, weapon: src.dataset.weapon,
                 x0: e.clientX, y0: e.clientY, moved: false, ghost: null };
    });
  }
  if (!_pdragBound) {
    _pdragBound = true;
    window.addEventListener('pointermove', _onPdragMove, { passive: false });
    window.addEventListener('pointerup', _onPdragUp);
    window.addEventListener('pointercancel', _onPdragUp);
  }
}

function _onPdragMove(e) {
  const d = _pdrag;
  if (!d) return;
  const shared = _pdragContainer?.querySelector('.cprog-shared');
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;   // below tap threshold
    d.moved = true;
    d.ghost = d.src.cloneNode(true);
    d.ghost.className = 'lg-drag-ghost';
    d.ghost.style.width = `${d.src.offsetWidth}px`;
    document.body.appendChild(d.ghost);
    d.src.classList.add('is-dragging');
    if (d.from === 'pool') shared?.classList.remove('is-open');       // taking out → collapse drawer
  }
  e.preventDefault();
  d.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY - 12}px)`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  // Stowing a unit's weapon: hovering the Inventory tab opens the drawer to drop into.
  if (d.from === 'unit' && under?.closest('.lg-inv-tab')) shared?.classList.add('is-open');
  _pdragContainer?.querySelectorAll('.is-drop').forEach((el) => el.classList.remove('is-drop'));
  const tgt = _pdragTarget(under, d);
  if (tgt) tgt.classList.add('is-drop');
}

function _onPdragUp(e) {
  const d = _pdrag;
  if (!d) return;
  _pdrag = null;
  d.ghost?.remove();
  d.src.classList.remove('is-dragging');
  _pdragContainer?.querySelectorAll('.is-drop').forEach((el) => el.classList.remove('is-drop'));
  if (!d.moved) {                                  // a tap → equip a carried (non-equipped) weapon
    if (d.from === 'unit' && !d.src.classList.contains('is-equipped')) _pdragApply?.('equip', d.idx, d.weapon);
    return;
  }
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const card = under?.closest('.cprog-card[data-drop="unit"]');
  const pool = under?.closest('[data-drop="pool"], .cprog-shared');
  if (card && d.from === 'pool') _pdragApply?.('carry', card.dataset.idx, d.weapon);
  else if (card && d.from === 'unit' && String(card.dataset.idx) !== String(d.idx)) {
    _data?.partyAction?.('stow', d.idx, d.weapon);
    _pdragApply?.('carry', card.dataset.idx, d.weapon);
  } else if (pool && d.from === 'unit') _pdragApply?.('stow', d.idx, d.weapon);
}

function _pdragTarget(under, d) {
  if (!under) return null;
  if (d.from === 'pool') return under.closest('.cprog-card[data-drop="unit"]');
  return under.closest('.cprog-card[data-drop="unit"], [data-drop="pool"], .cprog-shared');
}

/** Skirmish — pick a champion, set the night, start a game vs AI. */
function _panelSkirmish(body) {
  const factions = _data?.skirmishFactions?.() ?? [];
  if (!factions.length) return _placeholderPanel(body, { label: 'Skirmish' });
  // Default the selection to a champion that's actually available in this build
  // (blocked champions can't be picked); only fall back to a blocked one if every
  // champion is blocked (shouldn't happen).
  if (!factions.some(f => f.id === _skFaction && isFactionAvailable(f.id))) {
    _skFaction = (factions.find(f => isFactionAvailable(f.id)) || factions[0]).id;
  }

  // Tag the body so the Skirmish setup gets its own no-scroll layout: the
  // champion picker flexes/scrolls internally while the options + Start row stay
  // pinned and fully visible.
  body.classList.add('lg-skirmish');

  body.appendChild(_cap('Your champion'));
  const champs = document.createElement('div');
  champs.className = 'lg-champ-scroll';
  for (const [side, label, icon] of [['day', 'Day — the Hero', '\uE021'], ['night', 'Night — the Witch', '\uE023']]) {
    // Available champions first; demo-blocked ("coming soon") ones sort to the
    // end of their side (stable sort preserves the authored order otherwise).
    const fs = factions.filter((f) => f.side === side)
      .sort((a, b) => (isFactionAvailable(a.id) ? 0 : 1) - (isFactionAvailable(b.id) ? 0 : 1));
    if (!fs.length) continue;
    const row = document.createElement('div');
    row.className = 'lg-champ-side is-' + side;
    row.innerHTML = `<div class="lg-champ-side-label">${icon} ${label}</div>`;
    const grid = document.createElement('div');
    grid.className = 'lg-champions';
    for (const f of fs) grid.appendChild(_champCard(f));
    row.appendChild(grid);
    champs.appendChild(row);
  }
  body.appendChild(champs);

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
  opts.appendChild(_optSelect('startingResources', 'Starting resources', STARTING_RES_OPTS, (v) => v));
  body.appendChild(opts);

  const startRow = document.createElement('div');
  startRow.className = 'lg-skirmish-start';
  startRow.appendChild(_button(`${ICON.play} Start`, 'gold', () => {
    if (!isFactionAvailable(_skFaction)) return;   // never launch a demo-blocked champion
    _data?.startSkirmish?.(_skFaction, { ..._skOpts });
  }));
  body.appendChild(startRow);
}

function _champCard(f) {
  const card = document.createElement('div');
  const available = isFactionAvailable(f.id);   // demo builds can block a champion
  card.className = 'lg-champion is-' + (f.side === 'night' ? 'night' : 'day') +
    (available && f.id === _skFaction ? ' is-selected' : '') + (available ? '' : ' is-soon');
  const stat = (lbl, val, tip) => `<span class="cprog-ustat"${tip ? ` title="${esc(tip)}"` : ''}>${lbl} <b>${val}</b></span>`;
  const statsHtml = f.atk != null
    ? `<div class="cprog-ustats">${stat('HP', f.hp)}${stat('ATK', f.atk)}${stat('DEF', f.def)}${stat('RNG', f.rng)}` +
      `${stat('AGI', f.agi, 'Agility — higher acts earlier each turn')}</div>`
    : '';
  const weaponHtml = f.weapon
    ? `<div class="lg-champ-weapon">\uE0A2 ${esc(f.weapon.name)}${f.weapon.stats ? ` <span class="lg-champ-wstats">${esc(f.weapon.stats)}</span>` : ''}</div>`
    : '';
  const abilitiesHtml = (f.abilities && f.abilities.length)
    ? `<div class="cprog-uabilities">${f.abilities.map((a) =>
        `<span class="cprog-uability" data-tip="${esc(a.description)}">\uE062 ${esc(a.label)}</span>`).join('')}</div>`
    : '';
  card.innerHTML =
    `<img src="${esc(f.img)}" alt="">` +
    `<div class="lg-champ-info">` +
      `<div class="lg-champ-top"><span class="nm">${esc(f.name)}</span>` +
        (available ? '' : `<span class="lg-soon-badge">${COMING_SOON_LABEL}</span>`) +
      `</div>` +
      statsHtml + weaponHtml + abilitiesHtml +
      (f.blurb ? `<div class="lg-champ-blurb">${esc(f.blurb)}</div>` : '') +
    `</div>`;
  if (available) {
    card.addEventListener('click', () => { _skFaction = f.id; select('skirmish'); });
  } else {
    card.setAttribute('aria-disabled', 'true');
    card.title = `${f.name} — ${COMING_SOON_LABEL}`;
  }
  return card;
}

function _optSelect(key, label, options, parse) {
  const dd = _dropdown(options, String(_skOpts[key]), (v) => { _skOpts[key] = parse(v); });
  return _optWrap(label, dd);
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
    rh.appendChild(_rhythmCard('\uE000 Single Battle', 'live or async', 'One game against another player. Choose the pace when you create it.',
      () => { _createAsync = false; _othersView = 'find'; select('others'); }));
    body.appendChild(rh);

    // The persistent war's home on Play Online — "● live" once you've joined,
    // "View ▸" when it's available to join. Like any online game, a joined Battle
    // gets a live map thumbnail (the round-end snapshot keyed by its room id) and
    // a clickable game-detail modal — see _battleThumb / _feedRow / _openGameDetail.
    const inBattle = battle?.kind === 'battle';
    const battleTime = inBattle ? _gameTimeMeta(battle) : '';
    const battleThumb = inBattle ? _battleThumb(battle) : null;
    const bf = document.createElement('div');
    bf.className = 'lg-battle' + (inBattle ? ' is-live' : '') + (battleThumb ? ' has-thumb' : '');
    bf.innerHTML =
      (inBattle
        // The live snapshot opens game-details; with no snapshot yet a placeholder
        // glyph still shows so the card has a board, matching feed/resume rows.
        ? `<div class="lg-battle-thumb${battleThumb ? ' has-img clickable' : ''}" aria-hidden="true"` +
            `${battleThumb ? ` style="background-image:url(${battleThumb})" title="View battle details"` : ''}>` +
            `${battleThumb ? '' : '\uE08D'}</div>`
        : '') +
      `<div class="lg-battle-body">` +
        `<div class="lg-battle-head"><span class="gthc">${ICON.hero} The Battle for Caleb's Hollow</span>` +
        `${inBattle ? '<span class="lg-battle-live">● live</span>' : '<span class="lg-battle-cta">View ▸</span>'}</div>` +
        `<div class="lg-battle-sub">Persistent 10v10 war — turns resolve at noon &amp; midnight.` +
        `${inBattle && battle.round != null ? ' · Round ' + battle.round : ''}</div>` +
        (battleTime ? `<div class="lg-battle-sub lg-battle-time">${esc(battleTime)}</div>` : '') +
      `</div>`;
    bf.addEventListener('click', () => { _othersView = 'battle'; select('others'); });
    // The thumbnail click opens the detail modal instead of the Battle view (same
    // as feed/resume rows). Stop propagation so the card's own click doesn't fire.
    if (battleThumb) {
      const bte = bf.querySelector('.lg-battle-thumb');
      bte?.addEventListener('click', (e) => { e.stopPropagation(); _openGameDetail(battle); });
    }
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
  const resDd  = _dropdown(STARTING_RES_OPTS, 'none');
  const timeDd = _createAsync
    ? _dropdown([{ value: '43200000', label: '12 hours' }, { value: '86400000', label: '1 day' }, { value: '172800000', label: '2 days' }], '86400000')
    : _dropdown([{ value: '60000', label: '60 sec' }, { value: '90000', label: '90 sec' }, { value: '120000', label: '2 min' }], '90000');
  opts.appendChild(_optWrap('Cadence', modeDd));
  opts.appendChild(_optWrap('Players', ppsDd));
  opts.appendChild(_optWrap('Map', mapDd));
  opts.appendChild(_optWrap('Resources', resDd));
  opts.appendChild(_optWrap(_createAsync ? 'Per turn' : 'Turn timer', timeDd));
  opts.appendChild(_optWrap('Visibility', privDd));
  body.appendChild(opts);
  const createBtn = _button('＋ Create Game', 'gold', () => _data.lobby?.create?.({
    playersPerSide: parseInt(ppsDd.value, 10), mapSize: mapDd.value,
    isPrivate: privDd.value === 'true', isAsync: _createAsync,
    turnIntervalMs: parseInt(timeDd.value, 10), startingResources: resDd.value,
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
    const copy = _button('\uE078 Copy invite link', 'ghost', () => {
      navigator.clipboard?.writeText(link).then(() => {
        copy.textContent = 'Copied \uE071';
        setTimeout(() => { copy.textContent = '\uE078 Copy invite link'; }, 1500);
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
  for (const [side, label, icon] of [['day', 'Day', '\uE021'], ['night', 'Night', '\uE023']]) {
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
  if (isHost) footer.appendChild(_button('\uE07F Fill with AI', 'ghost', () => _data.lobby?.fillAll?.('random')));
  const allFilled = (lobby.slots || []).every((s) => s.status === 'human' || s.status === 'ai');
  const startBtn = _button(`${ICON.play} Start`, 'gold', () => _data.lobby?.start?.());
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
      // Switch your champion within your side. Demo builds block some champions —
      // they stay visible in the menu as a disabled "Coming Soon" entry.
      const facs = (_data.factionsForSide?.(slot.side) || []).map((f) => {
        const ok = isFactionAvailable(f.id);
        return { value: f.id, label: f.name, sub: ok ? undefined : COMING_SOON_LABEL, disabled: !ok };
      });
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
    el.innerHTML = `<span class="nm">${ICON.bot} ${esc(slot.name || 'AI')}</span><span class="fac">${esc(cap(fac))}</span>`;
    if (isHost) {
      const rm = _button('\uE070', 'ghost', () => _data.lobby?.removeSlotAI?.(idx));
      rm.classList.add('lg-seat-x');
      el.appendChild(rm);
    }
  } else {
    el.classList.add('is-open');
    el.innerHTML = `<span class="nm open">Open seat</span>`;
    const acts = document.createElement('div');
    acts.className = 'lg-seat-acts';
    if (canClaim) acts.appendChild(_button('Claim', 'gold', () => _data.lobby?.claimSlot?.(idx)));
    if (isHost) acts.appendChild(_button('\uE07F AI', 'ghost', () => _data.lobby?.setSlotAI?.(idx, 'random')));
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
    // Day = hero side, Night = witch side. The server's battle-status payload
    // carries the cumulative totals as heroScore/witchScore (the canonical
    // nodeScore fields); accept the day/night aliases too for forward-compat.
    const day = b.dayScore ?? b.heroScore ?? 0, night = b.nightScore ?? b.witchScore ?? 0;
    const total = (day + night) || 1;
    const pps = b.maxPerSide ?? 10;
    const card = document.createElement('div');
    card.className = 'lg-battle is-live';
    card.innerHTML =
      `<div class="lg-battle-head"><span class="gthc">${ICON.hero} The Battle for Caleb's Hollow</span><span class="lg-battle-live">● live</span></div>` +
      `<div class="lg-battle-scorebar"><span class="d">${ICON.day} Day ${day}</span>` +
      `<div class="track"><div class="fill" style="width:${Math.round(day / total * 100)}%"></div></div>` +
      `<span class="n">${night} Night ${ICON.night}</span></div>` +
      `<div class="lg-battle-sub">Persistent ${pps}v${pps} war${b.round != null ? ' · Round ' + b.round : ''}.</div>`;
    body.appendChild(card);
    const mySide = st?.mySide;
    if (mySide) {
      body.appendChild(_note(`You fight for ${mySide === 'day' ? '\uE021 Day' : '\uE023 Night'}.`));
    }
    // Always offer a way into the live game. A player already in the battle needs
    // to RETURN to it (joinBattle with no roomId ⇒ the server routes them back to
    // their own room); an unjoined player JOINS. Previously the in-battle branch
    // rendered only the status note with no button, so a joined player had no way
    // to launch back in — a dead "launch screen that does nothing".
    const j = _button(mySide ? '\uE000 Return to Battle' : '\uE000 Join the Battle', 'purple', () => _data.joinBattle?.());
    j.style.marginTop = '14px';
    body.appendChild(j);
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
// "Starting Resources" — a faction-tuned cache each side begins with. 'None'
// keeps the faction defaults (the long-standing baseline); higher levels add
// summon stock for the witch and sustain/economy for the hero.
const STARTING_RES_OPTS = [
  { value: 'none', label: 'None',   sub: 'faction defaults' },
  { value: 'low',  label: 'Low',    sub: 'a small cache' },
  { value: 'med',  label: 'Medium', sub: 'a healthy stock' },
  { value: 'high', label: 'High',   sub: 'a war chest' },
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
    item.className = 'lg-dd-item' + (o.value === cur ? ' is-sel' : '') + (o.disabled ? ' is-soon' : '');
    item.innerHTML = `<span class="lg-dd-item-label">${esc(o.label)}</span>` +
      (o.sub ? `<span class="lg-dd-item-sub">${esc(o.sub)}</span>` : '');
    if (o.disabled) {
      // Visible but unpickable (e.g. a demo-blocked champion).
      item.disabled = true;
      item.setAttribute('aria-disabled', 'true');
    } else {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        cur = o.value;
        renderCap();
        menu.querySelectorAll('.lg-dd-item').forEach((el) => el.classList.toggle('is-sel', el === item));
        root.classList.remove('is-open');
        onChange?.(cur);
      });
    }
    menu.appendChild(item);
  }
  capBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !root.classList.contains('is-open');
    document.querySelectorAll('.lg-dd.is-open').forEach((el) => el.classList.remove('is-open'));
    if (willOpen) {
      // Open UPWARD when there isn't room below for the menu — keeps it fully
      // on-screen (the skirmish dropdowns sit low in the panel), so opening one
      // never gets clipped or forces a scroll.
      const r = capBtn.getBoundingClientRect();
      const want = Math.min(menu.scrollHeight || 240, 280) + 8;
      const below = window.innerHeight - r.bottom;
      root.classList.toggle('is-up', below < want && r.top > below);
    }
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
    mountServerSelector(body);
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
      status(r?.ok ? 'Saved \uE071' : (r?.error || 'Could not change name'), r?.ok);
      if (r?.ok) setTimeout(() => select('account'), 700);
    });
  }));

  body.appendChild(_cap('Link an email'));
  body.appendChild(_editRow('you@example.com', 'email', (val, status) => {
    status('Sending…');
    Promise.resolve(_data?.linkEmail?.(val)).then((r) =>
      status(r?.ok ? (r.message || 'Check your email \uE071') : (r?.error || 'Could not send link'), r?.ok));
  }));

  const out = _button('Sign out', 'ghost', () => _data?.signOut?.());
  out.style.marginTop = '18px';
  body.appendChild(out);

  mountServerSelector(body);
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

// Resolve a game-row's map image. Online/skirmish rows show the live saved
// thumbnail (or nothing). Campaign rows — a mid-mission save ('local-campaign')
// or the next mission ready to start ('campaign-next') — fall back to the
// mission's fixed pre-generated map image when no live thumbnail exists yet, so
// a not-yet-played mission card still shows its board (matching skirmish).
function _rowThumb(row) {
  if (row?.kind === 'local-campaign' || row?.kind === 'campaign-next') {
    const missionId = row._missionDef?.id ?? row._nextMissionId;
    if (missionId) return missionThumb(missionId, row.room_id);
  }
  return loadThumb(row.room_id);
}

// The Battle for Caleb's Hollow is an online game, so its map thumbnail comes
// from the same place every online game's does: the round-end snapshot saved
// under the room id (here the battle's room_id == b.roomId), captured locally
// when this player resolves a round. No snapshot yet ⇒ null (the card shows a
// placeholder glyph). A battle-invite (never joined) has no room_id ⇒ no thumb.
function _battleThumb(battle) {
  return battle?.room_id ? loadThumb(battle.room_id) : null;
}

// A campaign-mission row routes its thumbnail click to the mission BRIEFING —
// the game-detail stats modal is only meaningful for skirmish/online rows.
const _isCampaignRow = mmIsCampaignRow;

/** Open the mission briefing for a campaign feed row (Tweak 6): clicking a
 *  campaign mission's thumbnail in Continue should show the briefing — which
 *  carries the map + objectives — not the skirmish/online stats modal. Hops to
 *  the Campaign destination with the briefing primed. */
function _openCampaignBriefingFromRow(row) {
  const missionDef = row._missionDef;
  const missionId = missionDef?.id ?? row._nextMissionId;
  if (!missionId) return;
  _campBriefing = {
    slot: row._slotIndex ?? 1,
    missionId,
    resume: row.kind === 'local-campaign',
    title: missionDef?.title || row._missionTitle || row._nextMissionTitle || missionId,
    briefing: missionDef?.briefing || '',
    // Catalog index = the 0-based mission number we display.
    index: row._missionNumber ?? 0,
    campaignId: row._campaignId,
  };
  _campSlot = row._slotIndex ?? null;
  select('campaign');
}

function _resumeHero(row) {
  const f = mmFormatRow(row);
  const thumb = _rowThumb(row);
  const wrap = document.createElement('div');
  wrap.className = 'lg-resume';
  wrap.innerHTML =
    `<div class="lg-resume-thumb${thumb ? ' has-img' : ''}" aria-hidden="true"` +
      `${thumb ? ` style="background-image:url(${thumb})"` : ''}>${thumb ? '' : '\uE08D'}</div>` +
    `<div class="lg-resume-body">` +
      `<div class="lg-resume-kicker">${row.action_needed ? 'Your turn' : 'Continue'}</div>` +
      `<div class="lg-resume-title gthc">${esc(f.title)}</div>` +
      `<div class="lg-resume-meta">${esc(f.meta || '')}</div>` +
      (_gameTimeMeta(row) ? `<div class="lg-resume-meta m2">${esc(_gameTimeMeta(row))}</div>` : '') +
    `</div>`;
  // Campaign mission rows route their thumbnail to the BRIEFING (map +
  // objectives) — the game-detail stats modal is meaningless for a campaign
  // mission (Tweak 6). Every campaign row is clickable (it always has a board
  // image). For skirmish/online rows, only the live saved snapshot opens
  // game-details — a fixed mission map image has no captured stats to show.
  if (thumb && _isCampaignRow(row)) {
    const te = wrap.querySelector('.lg-resume-thumb');
    te.classList.add('clickable');
    te.setAttribute('title', 'View mission briefing');
    te.addEventListener('click', () => _openCampaignBriefingFromRow(row));
  } else if (thumb && loadThumb(row.room_id)) {
    const te = wrap.querySelector('.lg-resume-thumb');
    te.classList.add('clickable');
    te.setAttribute('title', 'View game details');
    te.addEventListener('click', () => _openGameDetail(row));
  }
  const actions = document.createElement('div');
  actions.className = 'lg-resume-actions lg-feed-actions';
  _fillGameActions(actions, row, `${ICON.play} Resume`);
  wrap.querySelector('.lg-resume-body').appendChild(actions);
  return wrap;
}

function _feedRow(row, cta = null) {
  const f = mmFormatRow(row);
  const el = document.createElement('div');
  el.className = 'lg-feed-row' + (row.action_needed ? ' is-action' : '');
  const thumb = _rowThumb(row);
  if (thumb) {
    // Campaign mission rows route to the BRIEFING (Tweak 6); skirmish/online
    // rows open the game-detail stats modal, but only when a live snapshot was
    // captured (a fixed mission map image has no stats to show).
    const isCampaign = _isCampaignRow(row);
    const savedThumb = loadThumb(row.room_id);
    const clickable = isCampaign || !!savedThumb;
    const th = document.createElement('div');
    th.className = 'lg-feed-thumb' + (clickable ? ' clickable' : '');
    th.style.backgroundImage = `url(${thumb})`;
    if (clickable) {
      th.setAttribute('title', isCampaign ? 'View mission briefing' : 'View game details');
      th.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isCampaign) _openCampaignBriefingFromRow(row);
        else _openGameDetail(row);
      });
    }
    el.appendChild(th);
  }
  const text = document.createElement('div');
  text.className = 'lg-feed-text';
  const t2 = _gameTimeMeta(row);
  text.innerHTML = `<div class="t">${esc(f.title)}</div><div class="m">${esc(f.meta || '')}</div>` +
    (t2 ? `<div class="m2">${esc(t2)}</div>` : '');
  el.appendChild(text);
  const actions = document.createElement('div');
  actions.className = 'lg-feed-actions';
  _fillGameActions(actions, row, cta);
  el.appendChild(actions);
  return el;
}

// ── Game-detail overlay (thumbnail click) ────────────────────────────────────

function _cap1(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

/** Build the side-panel stats HTML for the detail overlay. */
function _detailStatsHTML(d) {
  const out = [`<div class="lg-detail-title gthc">${esc(d.title)}</div>`];
  const meta = [];
  if (d.round != null) meta.push(`Round ${d.round}`);
  if (d.phaseLabel)    meta.push(esc(d.phaseLabel));
  if (d.mapSize)       meta.push(esc(_cap1(d.mapSize)));
  out.push(`<div class="lg-detail-meta">${meta.join(' · ')}</div>`);

  if (d.score) {
    if (d.kind === 'battle') {
      // The persistent Battle has NO first-to-N node goal, so the 4-dot tracker
      // is misleading. Show the cumulative per-side total instead, mirroring the
      // live battle card's .lg-battle-scorebar (hero score = Day, witch = Night).
      const day = d.score.hero ?? 0, night = d.score.witch ?? 0;
      const total = (day + night) || 1;
      out.push(`<div class="lg-detail-stat lg-detail-score"><span>Score</span>` +
        `<span class="lg-detail-tracks"><span class="lg-battle-scorebar">` +
          `<span class="d">${ICON.day} Day ${day}</span>` +
          `<div class="track"><div class="fill" style="width:${Math.round(day / total * 100)}%"></div></div>` +
          `<span class="n">${night} Night ${ICON.night}</span>` +
        `</span></span></div>`);
      // Battle has no first-to-N score goal, but who currently holds each Power
      // Node is still meaningful — keep the control circles (just not the pips).
      const dots = (d.nodes || []).map((n) =>
        `<span class="node-dot ${esc(n.controller)}" style="border-color:${esc(n.color)}"></span>`).join('');
      if (dots) out.push(`<div class="lg-detail-stat lg-detail-score"><span>Nodes</span>` +
        `<span class="lg-detail-tracks"><span class="node-dots-group">${dots}</span></span></div>`);
    } else {
      const max = d.score.threshold || 4;
      const pips = (side, n) => Array.from({ length: max }, (_, i) =>
        `<span class="score-pip ${side}${i < n ? ' filled' : ''}"></span>`).join('');
      const dots = (d.nodes || []).map((n) =>
        `<span class="node-dot ${esc(n.controller)}" style="border-color:${esc(n.color)}"></span>`).join('');
      out.push(`<div class="lg-detail-stat lg-detail-score"><span>Node score</span>` +
        `<span class="lg-detail-tracks">` +
          `<span class="score-track hero-track">${pips('hero', d.score.hero)}</span>` +
          (dots ? `<span class="node-dots-group">${dots}</span>` : '') +
          `<span class="score-track witch-track">${pips('witch', d.score.witch)}</span>` +
        `</span><i>first to ${max}</i></div>`);
    }
  }
  if (d.kills) {
    out.push(`<div class="lg-detail-stat"><span>Slain</span>` +
      `<b><span class="lg-fac-hero">Hero ${d.kills.hero}</span> · ` +
      `<span class="lg-fac-witch">Witch ${d.kills.witch}</span></b></div>`);
  }
  if (d.players != null) {
    out.push(`<div class="lg-detail-stat"><span>Players</span><b>${d.players}</b></div>`);
  }
  if (d.participants) {
    for (const [side, label] of [['hero', 'Hero'], ['witch', 'Witch']]) {
      const list = d.participants[side] || [];
      if (!list.length) continue;
      out.push(`<div class="lg-detail-group is-${side}"><div class="hd">${label}</div>` +
        list.map((u) => `<div class="u${u.alive ? '' : ' dead'}"><span class="nm">${esc(u.label)}</span>` +
          `<span class="sb">${esc(u.sub)}</span></div>`).join('') + `</div>`);
    }
  }
  return out.join('');
}

/** Open the game-detail modal: a bigger thumbnail beside a stats side panel. */
function _openGameDetail(row) {
  const d = _data?.detail?.(row);
  if (!d) return;
  const back = document.createElement('div');
  back.className = 'lg-detail-back';
  const panel = document.createElement('div');
  panel.className = 'lg-detail';
  panel.innerHTML =
    `<div class="lg-detail-img${d.thumb ? ' has-img' : ''}"` +
      `${d.thumb ? ` style="background-image:url(${d.thumb})"` : ''}>${d.thumb ? '' : '\uE08D'}</div>` +
    `<div class="lg-detail-side">${_detailStatsHTML(d)}</div>` +
    `<button class="lg-detail-close" aria-label="Close">${ICON.close}</button>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  panel.querySelector('.lg-detail-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  back.appendChild(panel);
  document.body.appendChild(back);
}

/** [Resume] [Abandon] for an in-progress game row. Abandon confirms inline, then
 *  re-renders the panel (the abandoned game drops out of the refreshed list). */
function _fillGameActions(actions, row, cta = null) {
  actions.replaceChildren();
  actions.appendChild(_button(cta || (row.action_needed ? 'Your turn ▸' : `${ICON.play} Resume`), 'gold', () => _activateRow(row)));
  if (!_data?.abandonable?.(row)) return;
  actions.appendChild(_button('Abandon', 'danger', () => {
    const q = document.createElement('span');
    q.className = 'lg-confirm-q';
    q.textContent = 'Abandon?';
    actions.replaceChildren(
      q,
      _button('Yes', 'danger', () => { _data?.abandon?.(row); setTimeout(() => select(_activeId), 500); }),
      _button('No', 'ghost', () => _fillGameActions(actions, row, cta)),
    );
  }));
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

function _missionRow(slot, m, status, index, campaignId) {
  const playable = status === 'current' || status === 'available';
  const resume = status === 'current' && slot.resumeMissionId === m.id;
  const mark = status === 'done' ? '\uE071'
    : (status === 'locked' || status === 'disabled') ? '\uE081'
    : '◆';
  // Map image: the live saved thumbnail when this mission is in progress (keyed
  // by its row id `<campaignId>/slot<N>/<missionId>`, captured at round-end like
  // a skirmish), else the mission's fixed pre-generated map image.
  const rowId = campaignMissionRowId(campaignId, slot.slot, m.id);
  const img = missionThumb(m.id, rowId);
  const el = document.createElement('div');
  el.className = 'lg-mission is-' + status + (playable ? ' is-playable' : '');
  el.innerHTML =
    `<span class="lg-mission-thumb" aria-hidden="true"${img ? ` style="background-image:url(${img})"` : ''}></span>` +
    `<span class="lg-mission-n gthc">${esc(_missionNumLabel(index))}</span>` +
    `<span class="lg-mission-name">${esc(m.title || m.id)}</span>` +
    (playable
      ? `<button class="lg-btn lg-btn-gold lg-btn-sm">${resume ? `${ICON.play} Resume` : `${ICON.play} Play`}</button>`
      : `<span class="lg-mission-mark">${mark}</span>`);
  if (playable) {
    const go = (e) => {
      e?.stopPropagation?.();
      _campBriefing = { slot: slot.slot, missionId: m.id, resume, title: m.title || m.id, briefing: m.briefing || '', index, campaignId };
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

// Relative "time ago" for a unix-seconds timestamp (the last turn).
function _relTime(unixSec) {
  if (!unixSec) return null;
  const d = Date.now() / 1000 - unixSec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
// Countdown to a unix-seconds deadline (the next turn deadline).
function _countdown(unixSec) {
  if (!unixSec) return null;
  const left = unixSec - Date.now() / 1000;
  if (left <= 0) return 'overdue';
  if (left < 3600) return `${Math.ceil(left / 60)}m left`;
  if (left < 86400) return `${Math.floor(left / 3600)}h left`;
  return `${Math.floor(left / 86400)}d left`;
}
// "last turn … · ⏱ … left" line for a saved online game or the Battle. MP games
// carry a real updated_at; the Battle's last turn is derived from its deadline
// (turns resolve on a 12h cadence — noon & midnight). '' when there's no data.
function _gameTimeMeta(row) {
  if (row.kind !== 'game' && row.kind !== 'battle') return '';
  // Both games and the Battle carry a real last-resolution time in updated_at
  // (server room.lastTurnAt); the deadline drives the countdown. The Battle no
  // longer guesses "last turn" from turn_deadline − 12h, which was wrong whenever
  // a round resolved off the noon/midnight schedule (e.g. early submit).
  const last = _relTime(row.updated_at);
  const dl = _countdown(row.turn_deadline);
  const bits = [];
  if (last) bits.push(`last turn ${last}`);
  if (dl) bits.push(`${ICON.timer} ${dl}`);
  return bits.join(' · ');
}

export function show() { _root?.classList.add('is-active'); }
export function hide() { _root?.classList.remove('is-active'); }
export function activeDestination() { return _activeId; }
