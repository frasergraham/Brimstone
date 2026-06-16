// Campaign UI helpers — save/load utilities, HTML generators, and constants.
// Extracted from main.js to reduce its size and colocate campaign logic.

import { Renderer } from '../renderer.js';
import { ENTITY_COLOR, EntityType, getEquippedWeaponIdOf } from '../entities.js';
import { xpForLevel } from '../balance.js';
import { ITEMS } from '../items.js';
import { WEAPON_LABEL } from '../tiles.js';

// ── Campaign mid-mission save/resume ────────────────────────────────────────
// Mid-mission saves are slot-aware so a mission-in-progress in one save slot
// never clobbers another. The legacy unsuffixed key (pre multi-save) is treated
// as slot 1: read through to it when slot 1 has no save of its own, and cleared
// alongside slot 1 on delete so a finished/abandoned mission can't resurrect.

export function campaignMissionSaveKey(campaignId, missionId, slotIndex = 1) {
  return `brimstone_campaign_mission_${campaignId}_slot${slotIndex}_${missionId}`;
}

function legacyCampaignMissionSaveKey(campaignId, missionId) {
  return `brimstone_campaign_mission_${campaignId}_${missionId}`;
}

export function loadCampaignMissionSave(campaignId, missionId, slotIndex = 1) {
  let raw = localStorage.getItem(campaignMissionSaveKey(campaignId, missionId, slotIndex));
  if (raw == null && slotIndex === 1) {
    raw = localStorage.getItem(legacyCampaignMissionSaveKey(campaignId, missionId));
  }
  return raw ? JSON.parse(raw) : null;
}

export function deleteCampaignMissionSave(campaignId, missionId, slotIndex = 1) {
  localStorage.removeItem(campaignMissionSaveKey(campaignId, missionId, slotIndex));
  if (slotIndex === 1) {
    localStorage.removeItem(legacyCampaignMissionSaveKey(campaignId, missionId));
  }
}

// ── Resource display ────────────────────────────────────────────────────────

export const RESOURCE_ICONS = {
  wood: '🪵', metal: '⚙', herbs: '🌿', food: '🍞', silver: '⚔', scripture: '📜',
};

// ── HP color helper ─────────────────────────────────────────────────────────

export function hpColor(hp, maxHp) {
  const pct = hp / maxHp;
  return pct > 0.6 ? '#4caf50' : pct > 0.3 ? '#ff9800' : '#f44336';
}

// ── Portrait loading (lightweight, no full Renderer needed) ─────────────────

const _portraitCache = { img: null, rects: null, cache: new Map(), loading: false };

export async function loadCampaignPortraits() {
  if (_portraitCache.img || _portraitCache.loading) return;
  _portraitCache.loading = true;
  const img = new Image();
  await new Promise(resolve => {
    img.onload = resolve;
    img.onerror = resolve;
    img.src = 'assets/tilemap.png';
  });
  if (img.naturalWidth) {
    _portraitCache.img = img;
    _portraitCache.rects = Renderer._buildSpriteRects().rects;
  }
  _portraitCache.loading = false;
}

export function getCampaignPortrait(assetId, size = 48) {
  const p = _portraitCache;
  if (!p.img || !p.rects) return null;
  const rect = p.rects.get(assetId);
  if (!rect) return null;
  const key = `${assetId}@${size}`;
  if (p.cache.has(key)) return p.cache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(p.img, rect.x, rect.y, rect.size, rect.size, 0, 0, size, size);
  const url = c.toDataURL();
  p.cache.set(key, url);
  return url;
}

// ── HTML card generators ────────────────────────────────────────────────────

export function campaignCardHTML(name, title, assetId, color, hp, maxHp, attack, defense, ability, isHero) {
  const hpPct = Math.round((hp / maxHp) * 100);
  const hpClr = hpColor(hp, maxHp);
  const cls = isHero ? 'campaign-party-card hero' : 'campaign-party-card';
  const portrait = getCampaignPortrait(assetId, 48);
  const iconHtml = portrait
    ? `<img class="cp-portrait" src="${portrait}" style="border-color:${color}" alt="">`
    : `<span class="cp-glyph" style="background:${color}">${isHero ? '⚔' : '☺'}</span>`;
  return `<div class="${cls}">
    ${iconHtml}
    <div class="cp-info">
      <div class="cp-name" style="color:${color}">${name}${title ? ` <span class="cp-title">${title}</span>` : ''}</div>
      <div class="cp-hp-track"><div class="cp-hp-fill" style="width:${hpPct}%;background:${hpClr}"></div></div>
      <div class="cp-stats">
        <span>ATK ${attack}</span><span>DEF ${defense}</span>${ability ? `<span class="cp-ability">${ability}</span>` : ''}
        <span class="cp-hp-label">${hp}/${maxHp}</span>
      </div>
    </div>
  </div>`;
}

export function survivorCardHTML(s, idx, actionBtn) {
  const assetId = Renderer.survivorAssetId(s.title) || 'survivor_innkeeper';
  const card = campaignCardHTML(s.name, s.title, assetId, s.color || ENTITY_COLOR.survivor, s.hp, s.maxHp, s.attack, s.defense, s.abilityLabel, false);
  if (idx == null) return card;
  const btnHtml = actionBtn
    ? `<button class="roster-action-btn ${actionBtn.cls}" data-idx="${idx}" title="${actionBtn.title}">${actionBtn.label}</button>`
    : '';
  return `<div class="roster-row" data-idx="${idx}">
    ${card}
    ${btnHtml}
  </div>`;
}

export function campaignPartyHTML(heroStats, roster) {
  let html = '<div class="campaign-party">';
  const weaponLabel = heroStats.weapon ? ` (${heroStats.weapon.name || heroStats.weapon})` : '';
  // The campaign is always played as the Paladin (Ishmael Charger). No
  // faction choice here — the campaign narrative and mission scripting
  // assume a single fixed day-side leader.
  html += campaignCardHTML('Ishmael Charger' + weaponLabel, null, 'paladin', ENTITY_COLOR[EntityType.PALADIN], heroStats.hp, heroStats.maxHp, heroStats.attack, heroStats.defense, null, true);
  for (const s of roster) {
    html += survivorCardHTML(s);
  }
  html += '</div>';
  return html;
}

// ── Campaign Progress screen (between-mission landing) ──────────────────────
//
// A richer party view than campaignPartyHTML: per-unit level/XP, HP, ATK/DEF,
// a small inventory row, and an optional heal button + promote/demote control.
// All builders are pure string functions so they can be unit-tested without a
// DOM (getCampaignPortrait returns null outside the browser → glyph fallback).

/**
 * XP progress within the unit's current level.
 * @returns {{level:number, into:number, span:number, pct:number}}
 *   `into`/`span` are XP earned toward the next level / total needed for it.
 */
export function xpProgress(level, xp) {
  const lvl  = Math.max(1, Math.floor(level) || 1);
  const base = xpForLevel(lvl);
  const next = xpForLevel(lvl + 1);
  const span = Math.max(1, next - base);
  const into = Math.max(0, Math.min(span, (Math.floor(xp) || 0) - base));
  return { level: lvl, into, span, pct: Math.round((into / span) * 100) };
}

/** Emoji glyph for an item/weapon id (the leading token of its label). */
function itemGlyph(id) {
  const label = ITEMS[id]?.label || WEAPON_LABEL[id] || '';
  const first = String(label).trim().split(/\s+/)[0];
  return first || '🎒';
}

/** True when an id names a weapon in the ITEMS registry. */
function isWeapon(id) {
  return ITEMS[id]?.kind === 'weapon';
}

/**
 * Clean display name for a weapon, derived from its ITEMS label. Labels are
 * shaped "<glyph> <Name> (<stats>)" (e.g. "⚔ Great Sword (+3 ATK)"), so we
 * strip the leading glyph token and the trailing parenthetical.
 */
export function weaponName(id) {
  const label = ITEMS[id]?.label || WEAPON_LABEL[id] || id;
  return String(label).replace(/^\S+\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || id;
}

/**
 * Human-readable stat string for a weapon, read straight off its definition —
 * ATK/DEF deltas from `statMods` and `range` when > 1. No fields are invented;
 * a weapon that grants nothing (none currently) yields ''.
 */
export function weaponStatString(id) {
  const def = ITEMS[id];
  if (!def) return '';
  const parts = [];
  const atk = def.statMods?.attack || 0;
  const dfn = def.statMods?.defense || 0;
  if (atk) parts.push(`ATK ${atk > 0 ? '+' : ''}${atk}`);
  if (dfn) parts.push(`DEF ${dfn > 0 ? '+' : ''}${dfn}`);
  if (def.range > 1) parts.push(`range ${def.range}`);
  return parts.join(' · ');
}

/**
 * One weapon row: glyph, name, stat string, and controls. The equipped weapon
 * shows a ✓ badge plus an Unequip control that banks it in the shared armory
 * (equipped slot → pool, no replacement); a carried (backpack) weapon gets an
 * Equip control plus a Stow control that returns it to the shared armory (so
 * another unit can take it). `idx` ('leader' or a roster index) is stamped onto
 * every control.
 */
function weaponRowHTML(id, count, idx, isEquipped) {
  const name = weaponName(id);
  const stats = weaponStatString(id);
  const n = count > 1 ? ` <span class="cprog-w-n">×${count}</span>` : '';
  const statHtml = stats ? `<span class="cprog-w-stats">${stats}</span>` : '';
  const ctrl = isEquipped
    ? '<span class="cprog-w-eq" title="Equipped">✓ Equipped</span>'
      + `<button class="cprog-unequip-btn" data-idx="${idx}" data-weapon="${id}" title="Unequip ${name} into the shared armory">⊘ Unequip</button>`
    : `<button class="cprog-equip-btn" data-idx="${idx}" data-weapon="${id}" title="Equip ${name}">Equip</button>`
      + `<button class="cprog-return-btn" data-idx="${idx}" data-weapon="${id}" title="Stow ${name} in the shared armory">↩ Stow</button>`;
  return `<div class="cprog-weapon${isEquipped ? ' equipped' : ''}" data-weapon="${id}">
    <span class="cprog-w-glyph">${itemGlyph(id)}</span>
    <span class="cprog-w-name">${name}${n}</span>
    ${statHtml}
    ${ctrl}
  </div>`;
}

/**
 * One shared-armory weapon row: glyph, name, stat string, and an Equip control
 * per candidate unit (the leader + the active squad) — clicking one draws the
 * weapon out of the shared pool and onto that unit. `targets` is
 * `[{ idx, label }]` where `idx` is 'leader' or a roster index.
 */
function poolWeaponRowHTML(id, count, targets) {
  const name = weaponName(id);
  const stats = weaponStatString(id);
  const n = count > 1 ? ` <span class="cprog-w-n">×${count}</span>` : '';
  const statHtml = stats ? `<span class="cprog-w-stats">${stats}</span>` : '';
  const btns = targets.map(t =>
    `<button class="cprog-pool-equip-btn" data-idx="${t.idx}" data-weapon="${id}" title="Equip ${name} on ${t.label}">▸ ${t.label}</button>`
  ).join('');
  return `<div class="cprog-pool-weapon" data-weapon="${id}">
    <span class="cprog-w-glyph">${itemGlyph(id)}</span>
    <span class="cprog-w-name">${name}${n}</span>
    ${statHtml}
    <div class="cprog-pool-equip">${btns}</div>
  </div>`;
}

/**
 * The shared-armory block for the Shared Inventory section: every pooled weapon
 * with per-unit Equip controls. '' when the pool is empty.
 * @param {object} weapons  shared pool, `{ weaponId: { count } }`
 * @param {{idx:(number|'leader'), label:string}[]} targets  equip candidates
 */
function sharedWeaponsHTML(weapons, targets) {
  const entries = Object.entries(weapons || {}).filter(([id, e]) => (e?.count ?? 0) > 0 && isWeapon(id));
  if (entries.length === 0) return '';
  const rows = entries.map(([id, e]) => poolWeaponRowHTML(id, e.count, targets)).join('');
  return `<div class="cprog-section-label armory-label">Armory</div>
    <div class="cprog-pool-weapons">${rows}</div>`;
}

/**
 * Weapons list for a unit card: the equipped weapon (with a ✓ badge) followed
 * by every other weapon in the backpack (each with an Equip control). Returns
 * '' when the unit carries no weapons. `idx` ('leader' or a roster index) is
 * stamped onto each Equip button for event wiring.
 */
function weaponListHTML(unit, idx) {
  const items = unit.items || {};
  const equipped = getEquippedWeaponIdOf(items);
  const carried = Object.entries(items)
    .filter(([id, e]) => (e?.count ?? 0) > 0 && isWeapon(id) && id !== equipped);
  if (!equipped && carried.length === 0) return '';
  const rows = [];
  if (equipped) rows.push(weaponRowHTML(equipped, 1, idx, true));
  for (const [id, e] of carried) rows.push(weaponRowHTML(id, e.count, idx, false));
  return `<div class="cprog-weapons">${rows.join('')}</div>`;
}

/** Badge row for a unit's carried non-weapon items. Empty string if none. */
function itemRowHTML(items) {
  const badges = [];
  for (const [id, entry] of Object.entries(items || {})) {
    const count = entry?.count ?? 0;
    if (!count || isWeapon(id)) continue; // weapons render via weaponListHTML
    const n = count > 1 ? `<span class="cprog-item-n">×${count}</span>` : '';
    badges.push(`<span class="cprog-item" title="${ITEMS[id]?.label || id}">${itemGlyph(id)}${n}</span>`);
  }
  return badges.length ? `<div class="cprog-inv">${badges.join('')}</div>` : '';
}

/**
 * One unit card for the party pane.
 * @param {object} unit  { name, title?, assetId, color, hp, maxHp, attack,
 *                         defense, level?, xp?, weapon?, items? }
 * @param {object} opts  { idx, isHero?, reserve?, canHeal?, control? }
 *   `control` is `{ cls, label, title }` for the promote/demote button (or null).
 */
export function progressUnitCardHTML(unit, opts = {}) {
  const { idx, isHero = false, reserve = false, canHeal = false, control = null } = opts;
  const hp = unit.hp, maxHp = unit.maxHp || 1;
  const hpPct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
  const hpClr = hpColor(hp, maxHp);
  const { level, into, span, pct: xpPct } = xpProgress(unit.level, unit.xp);

  const cls = ['cprog-card'];
  if (isHero) cls.push('hero');
  if (reserve) cls.push('reserve');

  const portrait = getCampaignPortrait(unit.assetId, 56);
  const iconHtml = portrait
    ? `<img class="cprog-portrait" src="${portrait}" style="border-color:${unit.color}" alt="">`
    : `<span class="cprog-glyph" style="background:${unit.color}">${isHero ? '⚔' : '☺'}</span>`;

  const controlHtml = control
    ? `<button class="cprog-ctrl ${control.cls}" data-idx="${idx}" title="${control.title}">${control.label}</button>`
    : '';
  const healHtml = canHeal
    ? `<button class="cprog-heal-btn" data-idx="${idx}">🌿 Use 1 herb</button>`
    : '';

  return `<div class="${cls.join(' ')}" data-idx="${idx}">
    <div class="cprog-card-head">
      ${iconHtml}
      <div class="cprog-id">
        <div class="cprog-name" style="color:${unit.color}">${unit.name}${unit.title ? ` <span class="cprog-title">${unit.title}</span>` : ''}</div>
        <div class="cprog-level">Lv ${level}</div>
      </div>
      ${controlHtml}
    </div>
    <div class="cprog-bar-row">
      <span class="cprog-bar-label">HP</span>
      <div class="cprog-track"><div class="cprog-fill hp" style="width:${hpPct}%;background:${hpClr}"></div></div>
      <span class="cprog-bar-num">${hp}/${maxHp}</span>
    </div>
    <div class="cprog-bar-row">
      <span class="cprog-bar-label">XP</span>
      <div class="cprog-track"><div class="cprog-fill xp" style="width:${xpPct}%"></div></div>
      <span class="cprog-bar-num">${into}/${span}</span>
    </div>
    <div class="cprog-statline"><span class="cprog-stat">⚔ ${unit.attack}</span><span class="cprog-stat">🛡 ${unit.defense}</span></div>
    ${weaponListHTML(unit, idx)}
    ${itemRowHTML(unit.items)}
    ${healHtml}
  </div>`;
}

/**
 * Active-squad cap for the between-mission Progress screen. The whole roster is
 * pickable here — the campaign menu is a loadout-management screen, not a launch
 * gate, so it must never read a misleading "0/0 — you go alone" just because the
 * next mission happens to be a solo one. Per-mission caps (the mission def's
 * `maxSurvivorsFromRoster`) are enforced later, in the mission start dialog.
 * @param {object[]} roster  Campaign.roster
 * @returns {number} the cap (= roster size)
 */
export function progressSquadCap(roster) {
  return Array.isArray(roster) ? roster.length : 0;
}

/**
 * The whole party pane: featured hero card, Active Squad section (capped at
 * `maxActive`), Reserve section, then the shared-inventory row.
 * @param {object} heroStats  Campaign.heroStats
 * @param {object[]} roster   Campaign.roster (snapshotSurvivor objects)
 * @param {number[]} activeIndices  roster indices currently deployed
 * @param {number} maxActive  active-squad cap (next playable mission's value)
 * @param {object} opts  { resources?: {herbs,...} }
 */
export function partyPaneHTML(heroStats, roster, activeIndices, maxActive, opts = {}) {
  const resources = opts.resources || {};
  const herbs = resources.herbs ?? 0;
  const active = activeIndices.filter(i => roster[i]);
  const reserve = roster.map((_, i) => i).filter(i => !active.includes(i));
  const canAddMore = active.length < maxActive;

  const heroUnit = {
    name: 'Ishmael Charger', title: null, assetId: 'paladin',
    color: ENTITY_COLOR[EntityType.PALADIN],
    hp: heroStats.hp, maxHp: heroStats.maxHp,
    attack: heroStats.attack, defense: heroStats.defense,
    level: heroStats.level, xp: heroStats.xp,
    items: heroStats.items,
  };

  let html = '<div class="cprog-party-scroll">';

  // Featured leader card — always deployed, never counts toward the cap.
  html += '<div class="cprog-section-label leader-label">Leader</div>';
  html += progressUnitCardHTML(heroUnit, {
    idx: 'leader', isHero: true,
    canHeal: herbs > 0 && heroStats.hp < heroStats.maxHp,
  });

  // Active squad.
  html += `<div class="cprog-section-label active-label">Active Squad <span class="cprog-count">${active.length}/${maxActive}</span></div>`;
  if (maxActive === 0) {
    html += '<div class="cprog-empty">You go alone on the next mission.</div>';
  } else if (active.length === 0) {
    html += '<div class="cprog-empty">No survivors selected — tap a reserve unit to deploy.</div>';
  } else {
    html += '<div class="cprog-grid">';
    for (const i of active) {
      const s = roster[i];
      html += progressUnitCardHTML(_survivorUnit(s), {
        idx: i,
        canHeal: herbs > 0 && s.hp < s.maxHp,
        control: { cls: 'cprog-demote', label: '−', title: 'Move to reserve' },
      });
    }
    html += '</div>';
  }

  // Reserve.
  html += '<div class="cprog-section-label reserve-label">Reserve</div>';
  if (reserve.length === 0) {
    html += '<div class="cprog-empty">No reserve survivors.</div>';
  } else {
    html += '<div class="cprog-grid reserve-grid">';
    for (const i of reserve) {
      const s = roster[i];
      html += progressUnitCardHTML(_survivorUnit(s), {
        idx: i, reserve: true,
        canHeal: herbs > 0 && s.hp < s.maxHp,
        control: canAddMore ? { cls: 'cprog-promote', label: '+', title: 'Move to active' } : null,
      });
    }
    html += '</div>';
  }
  html += '</div>'; // .cprog-party-scroll

  // Shared inventory: raw resources plus the shared armory (weapons any unit can
  // draw on). Armory weapons each offer an Equip control per candidate unit —
  // the leader and the current active squad.
  const resEntries = Object.entries(resources).filter(([, v]) => v > 0);
  const equipTargets = [{ idx: 'leader', label: 'Ishmael' }];
  for (const i of active) {
    equipTargets.push({ idx: i, label: String(roster[i].name || `Unit ${i}`).split(/\s+/)[0] });
  }
  const resHtml = resEntries.length
    ? `<div class="cprog-resources">${resEntries.map(([k, v]) =>
        `<span class="cr-item"><span class="cr-icon">${RESOURCE_ICONS[k] || ''}</span><span class="cr-count">${v}</span><span class="cr-label">${k}</span></span>`).join('')}</div>`
    : '';
  const armoryHtml = sharedWeaponsHTML(opts.weapons, equipTargets);

  html += '<div class="cprog-shared">';
  html += '<div class="cprog-section-label">Shared Inventory</div>';
  html += resHtml;
  html += armoryHtml;
  if (!resHtml && !armoryHtml) html += '<div class="cprog-empty">Empty.</div>';
  html += '</div>';

  return html;
}

/** Map a roster snapshot into the unit shape progressUnitCardHTML expects. */
function _survivorUnit(s) {
  return {
    name: s.name, title: s.title,
    assetId: Renderer.survivorAssetId(s.title) || 'survivor_innkeeper',
    color: s.color || ENTITY_COLOR.survivor,
    hp: s.hp, maxHp: s.maxHp, attack: s.attack, defense: s.defense,
    level: s.level, xp: s.xp, items: s.items,
  };
}

/**
 * Build the mission-list row descriptors for a campaign's Progress screen.
 * Only `visible` missions are shown (Phase E heuristic) unless `unlockAll` (the
 * admin bypass) is set, in which case every mission is shown and treated as
 * launchable. Each row carries a status and, for locked rows, a hint naming the
 * blocking mission.
 * @returns {{id, title, briefing, status:'completed'|'available'|'locked', lockedHint?}[]}
 */
export function missionRows(campaign, unlockAll = false) {
  return campaign.getMissionList()
    .filter(m => unlockAll || m.visible)
    .map(m => {
      const unlocked = unlockAll || m.available;
      const status = m.completed ? 'completed' : unlocked ? 'available' : 'locked';
      const def = campaign.getMissionDef(m.id);
      let lockedHint;
      if (status === 'locked') {
        const blockers = campaign._missionBlockers(def);
        const prev = blockers && blockers.length ? campaign.getMissionDef(blockers[0]) : null;
        lockedHint = prev ? `Locked — complete “${prev.title}” to unlock` : 'Locked';
      }
      return {
        id: m.id,
        title: m.title,
        briefing: def?.briefing || m.briefing || '',
        status,
        lockedHint,
      };
    });
}

/**
 * The mission-list pane.
 * @param {string} chapterTitle  campaign.def.title
 * @param {object[]} rows  [{ id, title, briefing?, status:'completed'|'available'|'locked', lockedHint? }]
 */
export function missionListPaneHTML(chapterTitle, rows) {
  let html = `<div class="cprog-chapter-title">${chapterTitle}</div>`;
  html += '<div class="cprog-mission-list">';
  if (rows.length === 0) {
    html += '<div class="cprog-empty">No missions available.</div>';
  }
  for (const r of rows) {
    const icon = r.status === 'completed' ? '✓' : r.status === 'available' ? '→' : '🔒';
    const desc = r.status === 'locked'
      ? (r.lockedHint || 'Locked')
      : (r.briefing || '');
    html += `<div class="cprog-mission ${r.status}" data-mission="${r.id}">
      <span class="cprog-mission-icon">${icon}</span>
      <div class="cprog-mission-body">
        <div class="cprog-mission-name">${r.title}</div>
        ${desc ? `<div class="cprog-mission-desc">${desc}</div>` : ''}
      </div>
    </div>`;
  }
  html += '</div>';
  return html;
}

// ── Objective description ───────────────────────────────────────────────────

export function objectiveDescription(obj) {
  if (!obj) return '';
  switch (obj.type) {
    case 'kill_witch':   return 'Slay the Witch';
    case 'hold_nodes':   return `Hold ${obj.count ?? 2}+ Power Nodes at scoring`;
    case 'survive':      return `Survive ${obj.rounds ?? 8} rounds`;
    case 'kill_all':     return 'Eliminate all enemies';
    case 'score':        return `Reach ${obj.points ?? 3} score points`;
    case 'explore':      return 'Explore all buildings';
    default:             return obj.type;
  }
}

// ── Flavor messages ─────────────────────────────────────────────────────────

const _DEPARTURE_MESSAGES = [
  name => `${name} left town to search for supplies in the outlying farms.`,
  name => `${name} slipped away at dawn to scout the old trade road.`,
  name => `${name} volunteered to warn the neighboring settlement.`,
  name => `${name} departed to tend to a wounded traveler found on the road.`,
  name => `${name} set off alone to bury the dead in the churchyard.`,
  name => `${name} vanished into the fog — perhaps the strain was too much.`,
  name => `${name} headed south, hoping to find reinforcements.`,
  name => `${name} left to guard the bridge crossing overnight.`,
];

const _ARRIVAL_MESSAGES = [
  name => `${name} wanders into town, weary but willing to fight.`,
  name => `${name} stumbles out of the tree line, clutching a makeshift weapon.`,
  name => `${name} emerges from the cellar of a ruined house and joins you.`,
  name => `A voice calls from the fog — ${name} steps forward, ready for battle.`,
  name => `${name} was hiding in the church. Hearing your approach, they join the cause.`,
  name => `${name} arrives breathless, having fled the horrors to the north.`,
  name => `The door of the inn creaks open — ${name} has been waiting for someone to lead.`,
  name => `${name} crawls from the wreckage of a collapsed barn, bruised but alive.`,
];

export function departureMessage(name) {
  return _DEPARTURE_MESSAGES[Math.floor(Math.random() * _DEPARTURE_MESSAGES.length)](name);
}

export function arrivalMessage(name) {
  return _ARRIVAL_MESSAGES[Math.floor(Math.random() * _ARRIVAL_MESSAGES.length)](name);
}
