// Campaign UI helpers — save/load utilities, HTML generators, and constants.
// Extracted from main.js to reduce its size and colocate campaign logic.

import { Renderer } from '../renderer.js';
import { ICON } from '../icons.js';
import { ENTITY_COLOR, EntityType, getEquippedWeaponIdOf } from '../entities.js';
import { xpForLevel } from '../balance.js';
import { ITEMS } from '../items.js';
import { WEAPON_LABEL } from '../tiles.js';
import { ABILITIES } from '../abilities.js';

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
  wood: '\uE010', metal: '\uE011', herbs: '\uE015', food: '\uE012', silver: '\uE013', scripture: '\uE014',
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
    : `<span class="cp-glyph" style="background:${color}">${isHero ? '\uE000' : '\uE002'}</span>`;
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

/**
 * Pure selector for the post-mission debrief headline + flavor text. `won` ⇒
 * VICTORY + the mission's victoryText; a loss ⇒ DEFEAT + defeatText, each with a
 * safe fallback. DOM-free so the WIN/LOSE selection is unit-testable.
 * @param {{victoryText?:string, defeatText?:string}} missionDef
 * @param {boolean} won
 * @returns {{title:string, text:string}}
 */
export function buildDebriefHeader(missionDef, won) {
  return {
    title: won ? 'VICTORY' : 'DEFEAT',
    text: won
      ? (missionDef?.victoryText || 'Mission complete.')
      : (missionDef?.defeatText || 'Mission failed.'),
  };
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

// Minimal HTML-escape for mission-title strings rendered into the memorial.
// Survivor names come from a fixed roster today, but the resolver may surface
// arbitrary authored mission titles — escape defensively.
function _esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * The ⚰ Fallen memorial: a desaturated tombstone card per survivor who fell on
 * a completed mission, naming where they died (+ level). Rendered after the
 * surviving roster on both the debrief and the campaign Progress screen. An
 * empty list yields '' (no heading) so the section vanishes when no one has
 * fallen.
 *
 * @param {{name:string, title?:string, level?:number, diedInMission:string}[]} fallen
 * @param {(missionId:string)=>string} [missionTitleResolver]  maps a mission id
 *   to its display title; defaults to the raw id.
 * @returns {string} memorial HTML, or '' when `fallen` is empty.
 */
export function fallenSectionHTML(fallen, missionTitleResolver = (id) => id) {
  if (!Array.isArray(fallen) || fallen.length === 0) return '';
  const cards = fallen.map(f => {
    const name = _esc(f.name);
    const title = f.title ? ` <span class="fallen-title">${_esc(f.title)}</span>` : '';
    const level = f.level ? `<span class="fallen-level">Lv ${f.level}</span>` : '';
    const where = _esc(missionTitleResolver(f.diedInMission));
    return `<div class="fallen-card" data-name="${name}">
      <span class="fallen-glyph">${ICON.coffin}</span>
      <div class="fallen-info">
        <div class="fallen-name">${name}${title}</div>
        <div class="fallen-where">fell in ${where}</div>
      </div>
      ${level}
    </div>`;
  }).join('');
  return `<div class="fallen-section">
    <h3 class="fallen-heading">${ICON.coffin} Fallen</h3>
    <div class="fallen-list">${cards}</div>
  </div>`;
}

/**
 * The debrief's ✦ Rewards section — what a WON mission GRANTED this run. Two
 * parts, either of which may be empty:
 *   • Granted survivors: each rendered through the SAME survivorCardHTML the
 *     roster/party use, so the reward card matches the roster cards exactly
 *     (icon + ATK/DEF/HP + ability label). A small NEW badge flags the fresh
 *     ally. The granted objects ARE roster snapshots (see grantRewardSurvivors).
 *   • Resource gains: a single line of "\uE001 +N <resource>" chips for the positive
 *     deltas the mission's `rewards.*` numeric keys applied.
 * Returns '' when there is nothing to show — a loss grants nothing, and the
 * caller already gates on the WIN, so the section simply vanishes when empty.
 *
 * @param {{survivors?:object[], resources?:Object<string,number>}} rewards
 * @returns {string} rewards HTML, or '' when there's nothing granted.
 */
export function rewardsSectionHTML(rewards) {
  const survivors = Array.isArray(rewards?.survivors) ? rewards.survivors : [];
  const resources = rewards?.resources && typeof rewards.resources === 'object'
    ? rewards.resources : {};
  const resEntries = Object.entries(resources).filter(([, v]) => v > 0);
  if (survivors.length === 0 && resEntries.length === 0) return '';

  let body = '';
  if (survivors.length) {
    // Reuse the roster survivor card verbatim, wrapped so a NEW badge can sit
    // over the corner — consistent style with the surviving-roster cards above.
    const cards = survivors.map(s =>
      `<div class="reward-survivor"><span class="reward-new-badge">NEW</span>${survivorCardHTML(s)}</div>`
    ).join('');
    body += `<div class="reward-survivors">${cards}</div>`;
  }
  if (resEntries.length) {
    const chips = resEntries.map(([k, v]) =>
      `<span class="reward-resource"><span class="reward-res-icon">${RESOURCE_ICONS[k] || '\uE016'}</span>+${v} ${k}</span>`
    ).join('');
    body += `<div class="reward-resources">\uE09F ${chips}</div>`;
  }
  return `<div class="reward-section">
    <h3 class="reward-heading">\uE09F Rewards</h3>
    ${body}
  </div>`;
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
  return first || '\uE016';
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
 * The shared-armory block for the Shared Inventory section: every pooled weapon
 * with per-unit Equip controls. '' when the pool is empty.
 * @param {object} weapons  shared pool, `{ weaponId: { count } }`
 * @param {{idx:(number|'leader'), label:string}[]} targets  equip candidates
 */
/** Resource slots (display only) — the whole stockpile travels to every mission. */
function resourceGridHTML(resources) {
  const slots = [];
  for (const [k, v] of Object.entries(resources || {})) {
    if (!(v > 0)) continue;
    slots.push(`<div class="cprog-slot is-resource" title="${k}">`
      + `<span class="cprog-slot-glyph">${RESOURCE_ICONS[k] || '\uE016'}</span>`
      + `<span class="cprog-slot-n">×${v}</span>`
      + `<span class="cprog-slot-name">${k}</span></div>`);
  }
  if (!slots.length) return '<div class="cprog-empty">No resources gathered yet.</div>';
  return `<div class="cprog-inv-grid is-resources">${slots.join('')}</div>`;
}

/**
 * Equipment slots — the shared weapon armory (the bench). Each weapon is a
 * two-wide draggable slot showing its name + stats; the grid is a drop target so
 * a weapon dragged off a unit lands back here. Only weapons a unit actually
 * carries reach the mission, so anything left in this pool stays behind.
 */
function equipmentGridHTML(weapons) {
  const slots = [];
  for (const [id, e] of Object.entries(weapons || {})) {
    const count = (e && typeof e === 'object') ? (e.count ?? 0) : (e ?? 0);
    if (count < 1 || !isWeapon(id)) continue;
    const stat = weaponStatString(id);
    slots.push(`<div class="cprog-slot is-weapon" data-from="pool" data-weapon="${id}" title="${weaponName(id)}${stat ? ' — ' + stat : ''}">`
      + `<span class="cprog-slot-glyph">${itemGlyph(id)}</span>`
      + `<span class="cprog-slot-info">`
      + `<span class="cprog-slot-name">${weaponName(id)}${count > 1 ? ` ×${count}` : ''}</span>`
      + (stat ? `<span class="cprog-slot-stats">${stat}</span>` : '')
      + `</span></div>`);
  }
  const pad = Math.max(2, 6 - slots.length);
  for (let i = 0; i < pad; i++) slots.push('<div class="cprog-slot is-empty"></div>');
  return `<div class="cprog-inv-grid is-equipment" data-drop="pool">${slots.join('')}</div>`;
}

/**
 * Weapons list for a unit card: the equipped weapon (with a ✓ badge) followed
 * by every other weapon in the backpack (each with an Equip control). Returns
 * '' when the unit carries no weapons. `idx` ('leader' or a roster index) is
 * stamped onto each Equip button for event wiring.
 */
// Weapons a unit may carry into a mission (mirrors campaign.js WEAPON_CARRY_CAP).
const WEAPON_SLOTS = 2;

/**
 * A unit's weapon slots: up to WEAPON_SLOTS squares. Filled slots show the
 * carried weapon (equipped first, marked ✓) and are draggable to the shared
 * inventory or clickable to equip; empty slots are drop targets for arming the
 * unit from the armory.
 */
function weaponSlotsHTML(unit, idx) {
  const items = unit.items || {};
  const equipped = getEquippedWeaponIdOf(items);
  const carried = [];
  if (equipped) carried.push([equipped, items[equipped]?.count ?? 1, true]);
  for (const [id, e] of Object.entries(items)) {
    if (id === equipped || !isWeapon(id) || (e?.count ?? 0) < 1) continue;
    carried.push([id, e.count, false]);
  }
  const slots = [];
  for (let s = 0; s < WEAPON_SLOTS; s++) {
    const w = carried[s];
    if (w) {
      const [id, count, eq] = w;
      const stat = weaponStatString(id);
      const tip = `${weaponName(id)}${stat ? ' — ' + stat : ''}${eq ? ' · equipped' : ' · click to equip'}`;
      slots.push(`<div class="cprog-wslot${eq ? ' is-equipped' : ''}" data-from="unit" data-idx="${idx}" data-weapon="${id}" title="${tip}">`
        + `<span class="cprog-wslot-glyph">${itemGlyph(id)}</span>`
        + `<span class="cprog-wslot-info">`
        + `<span class="cprog-wslot-name">${weaponName(id)}${count > 1 ? ` ×${count}` : ''}`
        + (eq ? ' <span class="cprog-wslot-eq" title="Equipped">\uE071</span>' : '') + `</span>`
        + (stat ? `<span class="cprog-wslot-stats">${stat}</span>` : '')
        + `</span></div>`);
    } else {
      slots.push('<div class="cprog-wslot is-empty" title="Drag a weapon here">'
        + '<span class="cprog-wslot-glyph">+</span>'
        + '<span class="cprog-wslot-info"><span class="cprog-wslot-name">Empty slot</span></span></div>');
    }
  }
  return `<div class="cprog-wslots">${slots.join('')}</div>`;
}

/**
 * In-game-style stat line: ATK / DEF / RNG / AGI (folding the equipped weapon's
 * mods + range, like the in-game Unit Stats Bar) plus the unit's special-ability
 * badges. Mirrors src/ui.js's usb-stat presentation.
 */
function unitStatsHTML(unit) {
  const eqId = getEquippedWeaponIdOf(unit.items || {});
  const w = eqId ? ITEMS[eqId] : null;
  const atk = (unit.attack ?? 0) + (w?.statMods?.attack || 0);
  const def = (unit.defense ?? 0) + (w?.statMods?.defense || 0);
  const rng = w?.range || 1;
  const agi = unit.agility ?? 0;
  const stat = (lbl, val, title) =>
    `<span class="cprog-ustat"${title ? ` title="${title}"` : ''}>${lbl} <b>${val}</b></span>`;
  let html = `<div class="cprog-ustats">${stat('ATK', atk)}${stat('DEF', def)}${stat('RNG', rng)}` +
    `${stat('AGI', agi, 'Agility — higher acts earlier each turn')}</div>`;
  const abilities = (unit.abilities || []).map((id) => ABILITIES[id]).filter(Boolean);
  if (abilities.length) {
    html += `<div class="cprog-uabilities">${abilities.map((a) =>
      `<span class="cprog-uability" data-tip="${String(a.description || '').replace(/"/g, '&quot;')}">\uE062 ${a.label}</span>`).join('')}</div>`;
  }
  return html;
}

/** Row for a unit's carried non-weapon items — icon + name (e.g. "Horn"). */
function itemRowHTML(items) {
  const rows = [];
  for (const [id, entry] of Object.entries(items || {})) {
    const count = entry?.count ?? 0;
    if (!count || isWeapon(id)) continue; // weapons render via weaponSlotsHTML
    const n = count > 1 ? ` ×${count}` : '';
    rows.push(`<span class="cprog-item" title="${ITEMS[id]?.label || id}">`
      + `<span class="cprog-item-glyph">${itemGlyph(id)}</span>`
      + `<span class="cprog-item-name">${weaponName(id)}${n}</span></span>`);
  }
  return rows.length ? `<div class="cprog-inv">${rows.join('')}</div>` : '';
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
    : `<span class="cprog-glyph" style="background:${unit.color}">${isHero ? '\uE000' : '\uE002'}</span>`;

  const controlHtml = control
    ? `<button class="cprog-ctrl ${control.cls}" data-idx="${idx}" title="${control.title}">${control.label}</button>`
    : '';
  const healHtml = canHeal
    ? `<button class="cprog-heal-btn" data-idx="${idx}">${ICON.herb} Use 1 herb</button>`
    : '';

  return `<div class="${cls.join(' ')}" data-idx="${idx}" data-drop="unit">
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
    ${unitStatsHTML(unit)}
    ${weaponSlotsHTML(unit, idx)}
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

  const heroUnit = heroStatsToUnit(heroStats);

  let html = '<div class="cprog-party-scroll">';

  // Active squad — the always-deployed leader (never counts toward the cap)
  // plus up to maxActive survivors, all on a single row.
  html += `<div class="cprog-section-label active-label">Active Squad <span class="cprog-count">${active.length}/${maxActive}</span></div>`;
  html += '<div class="cprog-grid cprog-squad-grid">';
  html += progressUnitCardHTML(heroUnit, {
    idx: 'leader', isHero: true,
    canHeal: herbs > 0 && heroStats.hp < heroStats.maxHp,
  });
  for (const i of active) {
    const s = roster[i];
    html += progressUnitCardHTML(survivorToUnit(s), {
      idx: i,
      canHeal: herbs > 0 && s.hp < s.maxHp,
      control: { cls: 'cprog-demote', label: '−', title: 'Move to reserve' },
    });
  }
  html += '</div>';
  if (active.length === 0 && reserve.length > 0) {
    html += '<div class="cprog-empty">Promote a reserve survivor to deploy them alongside the leader.</div>';
  }

  // Reserve.
  html += '<div class="cprog-section-label reserve-label">Reserve</div>';
  if (reserve.length === 0) {
    html += '<div class="cprog-empty">No reserve survivors.</div>';
  } else {
    html += '<div class="cprog-grid reserve-grid">';
    for (const i of reserve) {
      const s = roster[i];
      html += progressUnitCardHTML(survivorToUnit(s), {
        idx: i, reserve: true,
        canHeal: herbs > 0 && s.hp < s.maxHp,
        control: canAddMore ? { cls: 'cprog-promote', label: '+', title: 'Move to active' } : null,
      });
    }
    html += '</div>';
  }
  html += '</div>'; // .cprog-party-scroll

  // Shared inventory as a slot grid: pooled weapons (drag onto a unit to arm
  // them) plus raw resources. The grid is a drop target — a weapon dragged off a
  // unit lands back here.
  html += '<div class="cprog-shared">';
  html += '<div class="cprog-section-label">Resources ' +
    '<span class="cprog-inv-hint">the whole stockpile is available in every mission</span></div>';
  html += resourceGridHTML(resources);
  html += '<div class="cprog-section-label">Equipment ' +
    '<span class="cprog-inv-hint">drag a weapon onto a unit — only weapons your active units carry reach the mission</span></div>';
  html += equipmentGridHTML(opts.weapons);
  html += '</div>';

  return html;
}

/** Map a roster snapshot into the unit shape progressUnitCardHTML expects. */
export function survivorToUnit(s) {
  return {
    name: s.name, title: s.title,
    assetId: Renderer.survivorAssetId(s.title) || 'survivor_innkeeper',
    color: s.color || ENTITY_COLOR.survivor,
    hp: s.hp, maxHp: s.maxHp, attack: s.attack, defense: s.defense,
    agility: s.agility ?? 4,            // survivor base agility (UNIT_TYPES.survivor)
    abilities: s.abilities || [],
    level: s.level, xp: s.xp, items: s.items,
  };
}

/** Map the fixed campaign hero's stats into the party-pane unit shape. */
export function heroStatsToUnit(heroStats) {
  return {
    name: 'Ishmael Charger', title: null, assetId: 'paladin',
    color: ENTITY_COLOR[EntityType.PALADIN],
    hp: heroStats.hp, maxHp: heroStats.maxHp,
    attack: heroStats.attack, defense: heroStats.defense,
    agility: heroStats.agility ?? 6,    // paladin base agility (UNIT_TYPES.paladin)
    abilities: heroStats.abilities || [],
    level: heroStats.level, xp: heroStats.xp,
    items: heroStats.items,
  };
}

// ── Debrief party + rewards (party-management card UX) ──────────────────────
//
// The post-mission debrief renders its surviving roster and its reward survivors
// with the EXACT same per-unit card the Party Management screen uses
// (progressUnitCardHTML — the rich card: portrait, level/XP, HP bar, ATK/DEF,
// abilities, weapon slots). debriefPartyHTML / debriefRewardsSectionHTML are the
// debrief-side wrappers; the cards are byte-identical to the party pane so the
// two screens match. The debrief is read-only — no idx/heal/promote controls are
// passed (the cards are static), keeping the surface free of dangling buttons.

/**
 * The debrief's surviving-roster body — the fixed campaign hero card followed by
 * one card per surviving survivor, each rendered through the party-management
 * card builder (progressUnitCardHTML). Read-only: no heal/promote/demote controls.
 * @param {object} heroStats  hero snapshot ({ hp, maxHp, attack, defense, level?, xp?, items? })
 * @param {object[]} survivors  roster snapshots (snapshotSurvivor / reconciled)
 * @returns {string} debrief roster HTML
 */
export function debriefPartyHTML(heroStats, survivors) {
  const cards = [
    progressUnitCardHTML(heroStatsToUnit(heroStats), { idx: 'leader', isHero: true }),
    ...survivors.map((s, i) => progressUnitCardHTML(survivorToUnit(s), { idx: i })),
  ].join('');
  return `<div class="cprog-grid debrief-party-grid">${cards}</div>`;
}

/**
 * The debrief's Rewards section, rendered with the party-management card UX.
 * Granted survivors use progressUnitCardHTML (same rich card as the surviving
 * roster + the party screen), each wrapped so a NEW badge hangs over the corner.
 * Resource gains keep the "+N <resource>" chip line. Returns '' when there is
 * nothing granted (a loss, or a win that granted nothing).
 *
 * @param {{survivors?:object[], resources?:Object<string,number>}} rewards
 * @returns {string} rewards HTML, or '' when there's nothing granted.
 */
export function debriefRewardsSectionHTML(rewards) {
  const survivors = Array.isArray(rewards?.survivors) ? rewards.survivors : [];
  const resources = rewards?.resources && typeof rewards.resources === 'object'
    ? rewards.resources : {};
  const resEntries = Object.entries(resources).filter(([, v]) => v > 0);
  if (survivors.length === 0 && resEntries.length === 0) return '';

  let body = '';
  if (survivors.length) {
    // Reuse the party-management unit card verbatim, wrapped so a NEW badge can
    // sit over the corner — consistent style with the surviving-roster cards.
    const cards = survivors.map((s, i) =>
      `<div class="reward-survivor"><span class="reward-new-badge">NEW</span>${progressUnitCardHTML(survivorToUnit(s), { idx: `reward-${i}` })}</div>`
    ).join('');
    body += `<div class="reward-survivors cprog-grid debrief-party-grid">${cards}</div>`;
  }
  if (resEntries.length) {
    const chips = resEntries.map(([k, v]) =>
      `<span class="reward-resource"><span class="reward-res-icon">${RESOURCE_ICONS[k] || '\uE016'}</span>+${v} ${k}</span>`
    ).join('');
    body += `<div class="reward-resources">\uE09F ${chips}</div>`;
  }
  return `<div class="reward-section">
    <h3 class="reward-heading">\uE09F Rewards</h3>
    ${body}
  </div>`;
}

/**
 * Build the mission-list row descriptors for a campaign's Progress screen.
 * Only `visible` missions are shown (Phase E heuristic) unless `unlockAll` (the
 * admin bypass) is set, in which case every mission is shown and treated as
 * launchable. Each row carries a status and, for locked rows, a hint naming the
 * blocking mission.
 *
 * A `disabled` mission (shelved via `disabled:true` in its JSON) always renders
 * as its own non-selectable `disabled` status — even under the admin `unlockAll`
 * bypass it never becomes launchable.
 * @returns {{id, title, briefing, status:'completed'|'available'|'locked'|'disabled', lockedHint?}[]}
 */
export function missionRows(campaign, unlockAll = false) {
  return campaign.getMissionList()
    .filter(m => m.disabled || unlockAll || m.visible)
    .map(m => {
      const unlocked = !m.disabled && (unlockAll || m.available);
      const status = m.disabled ? 'disabled'
        : m.completed ? 'completed'
        : unlocked ? 'available' : 'locked';
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
    const icon = r.status === 'completed' ? ICON.check : r.status === 'available' ? '→' : ICON.lock;
    const desc = r.status === 'disabled'
      ? 'Unavailable'
      : r.status === 'locked'
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
