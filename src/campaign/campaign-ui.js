// Campaign UI helpers — save/load utilities, HTML generators, and constants.
// Extracted from main.js to reduce its size and colocate campaign logic.

import { Renderer } from '../renderer.js';
import { ENTITY_COLOR, EntityType } from '../entities.js';

// ── Campaign mid-mission save/resume ────────────────────────────────────────

export function campaignMissionSaveKey(campaignId, missionId) {
  return `brimstone_campaign_mission_${campaignId}_${missionId}`;
}

export function loadCampaignMissionSave(campaignId, missionId) {
  const key = campaignMissionSaveKey(campaignId, missionId);
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

export function deleteCampaignMissionSave(campaignId, missionId) {
  const key = campaignMissionSaveKey(campaignId, missionId);
  localStorage.removeItem(key);
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
