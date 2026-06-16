// Campaign UI helpers — save/load utilities, HTML generators, and constants.
// Extracted from main.js to reduce its size and colocate campaign logic.

import { Renderer } from '../renderer.js';
import { ENTITY_COLOR, EntityType } from '../entities.js';
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
  html += campaignCardHTML('Ishmael Charger' + weaponLabel, null, 'hero', ENTITY_COLOR[EntityType.PALADIN], heroStats.hp, heroStats.maxHp, heroStats.attack, heroStats.defense, null, true);
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

/** Small badge row for a unit's carried weapon + items. Empty string if none. */
function itemRowHTML(items, weapon) {
  const badges = [];
  if (weapon) {
    const wId = typeof weapon === 'string' ? weapon : weapon.id;
    if (wId) badges.push(`<span class="cprog-item" title="${WEAPON_LABEL[wId] || wId}">${itemGlyph(wId)}</span>`);
  }
  for (const [id, count] of Object.entries(items || {})) {
    if (!count) continue;
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
    ${itemRowHTML(unit.items, unit.weapon)}
    ${healHtml}
  </div>`;
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
    name: 'Ishmael Charger', title: null, assetId: 'hero',
    color: ENTITY_COLOR[EntityType.PALADIN],
    hp: heroStats.hp, maxHp: heroStats.maxHp,
    attack: heroStats.attack, defense: heroStats.defense,
    level: heroStats.level, xp: heroStats.xp,
    weapon: heroStats.weapon, items: heroStats.items,
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

  // Shared inventory.
  const resEntries = Object.entries(resources).filter(([, v]) => v > 0);
  html += '<div class="cprog-shared">';
  html += '<div class="cprog-section-label">Shared Inventory</div>';
  html += resEntries.length
    ? `<div class="cprog-resources">${resEntries.map(([k, v]) =>
        `<span class="cr-item"><span class="cr-icon">${RESOURCE_ICONS[k] || ''}</span><span class="cr-count">${v}</span><span class="cr-label">${k}</span></span>`).join('')}</div>`
    : '<div class="cprog-empty">Empty.</div>';
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
    level: s.level, xp: s.xp, weapon: s.weapon, items: s.items,
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
