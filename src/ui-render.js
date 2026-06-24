// Pure render helpers — no DOM access, no side effects.
// Each function takes plain data and returns an HTML string.
// Imported by UIController to keep rendering logic separate from DOM wiring.

import { PlanActionType } from './planner.js';
import { ICON, coloredResourceIcon, coloredResourceLabel, tintResourceGlyphs } from './icons.js';
import { ITEMS } from './items.js';
import { EntityType, ENTITY_COLOR, getEquippedWeaponIdOf, getItemCountOf, removeItemInItems, normalizeItems, isLeaderType } from './entities.js';
import { ResourceType, WEAPON_LABEL, RESOURCE_LABEL } from './tiles.js';
import { nodeController, PHASE_ICON, DEFAULT_CYCLE_PHASES } from './game.js';
import { hexKey } from './hex.js';
import { getFactionTheme } from './theme.js';
import { EFFECTS } from './effects.js';
import { buildOutcomeSummary } from './replay-timeline.js';

// Effects whose mods make a unit weaker (red pip), vs. those that strengthen
// it (green pip). Anything not listed renders neutral.
const _BAD_EFFECTS  = new Set(['wounded', 'poisoned', 'bleeding', 'stunned', 'slowed', 'marked', 'cursed']);
const _GOOD_EFFECTS = new Set(['frenzied', 'inspired', 'fortified', 'eagle_eyed']);

/**
 * Render the veterancy level pill — a small gold rounded badge carrying the
 * level number, drawn beside a unit's name. Replaces the old "Name L2" string
 * suffix. Returns '' for level 1 / null (the bare default), so callers can
 * unconditionally append it. Shared by the Unit Stats Bar, the action-popup
 * arc portrait and the battle dialog combatant card. Pure (no DOM).
 */
export function levelPillHtml(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 1) return '';
  return `<span class="level-pill" title="Veterancy level ${n}">${n}</span>`;
}

/**
 * Render the active effects pip strip for an entity. Each pip shows the
 * effect's icon and (for finite durations) a small remaining-rounds badge.
 * The full label/description is exposed via the title attribute for
 * desktop hover and mobile long-press. Pure — shared by the Unit Stats Bar
 * (ui.js) and the plan-panel unit detail.
 */
export function buildEffectsHtml(entity) {
  if (!entity || !Array.isArray(entity.effects) || entity.effects.length === 0) {
    return '';
  }
  const pips = entity.effects.map(rec => {
    const def = EFFECTS[rec.id];
    if (!def) return '';
    const kind = _BAD_EFFECTS.has(rec.id) ? 'bad'
               : _GOOD_EFFECTS.has(rec.id) ? 'good'
               : '';
    const durLabel = typeof rec.duration === 'number'
      ? `${rec.duration}`
      : (rec.duration === 'mission' ? '∞' : '');
    const stacksLabel = (rec.stacks ?? 1) > 1 ? `×${rec.stacks}` : '';
    const tooltipBits = [def.label, def.description];
    if (typeof rec.duration === 'number') tooltipBits.push(`${rec.duration} round${rec.duration === 1 ? '' : 's'} remaining`);
    else if (rec.duration === 'mission') tooltipBits.push('Lasts the mission');
    else if (rec.duration === 'permanent') tooltipBits.push('Permanent');
    const tooltip = tooltipBits.join(' — ').replace(/"/g, '&quot;');
    return `<span class="usb-effect-pip" data-kind="${kind}" title="${tooltip}">`
         + `<span class="usb-effect-letter">${def.badge ?? '●'}</span>${stacksLabel}`
         + (durLabel ? `<span class="usb-effect-pip-dur">${durLabel}</span>` : '')
         + `</span>`;
  }).join('');
  return `<span class="usb-effects">${pips}</span>`;
}

// ── Plan action description ───────────────────────────────────────────────────

/**
 * Return a human-readable description of a single plan action.
 * @param {{ type: string, entityId: string, [key: string]: * }} action
 * @param {Array<{ id: string, displayName?: string }>} entities
 * @param {number} index  Zero-based step index (used for fallback label).
 */
export function describePlanAction(action, entities, index = 0) {
  const entity = entities.find(e => e.id === action.entityId);
  const who    = entity?.displayName ?? 'Unit';
  switch (action.type) {
    case PlanActionType.MOVE:
      return `${who} → (${action.toCol},${action.toRow})`;
    case PlanActionType.BATTLE_UNIT: {
      const target = entities.find(e => e.id === action.targetId);
      return `${who} attacks ${target?.displayName ?? '?'}`;
    }
    case PlanActionType.BATTLE_HEX:
      return `${who} attacks (${action.targetCol},${action.targetRow})`;
    case PlanActionType.EXPLORE:
      return `${who} explores`;
    case PlanActionType.FORTIFY:
      return `${who} fortifies`;
    case PlanActionType.GUARD:
      return `${who} guards`;
    case PlanActionType.SUMMON:
      return `${who} summons`;
    case PlanActionType.HEAL:
      return `${who} heals`;
    case PlanActionType.USE_ITEM:
      return `${who} uses ${action.item}`;
    case PlanActionType.EQUIP_WEAPON:
      return `${who} equips ${action.weapon}`;
    case PlanActionType.USE_ABILITY:
      return `${who} uses ability`;
    case PlanActionType.SOUND_HORN:
      return `${who} sounds the horn`;
    case PlanActionType.SENT_TO: {
      // The actor IS the survivor (entityId === survivorId). The destination
      // leader is keyed by ownerId — find a live leader on that ownerId in
      // the snapshot so the label reads names, not UUIDs.
      const survivorName = entity?.displayName ?? 'Survivor';
      const destLeader = action.destOwnerId
        ? entities.find(e => e.ownerId === action.destOwnerId && isLeaderType(e.type))
        : null;
      const destName = destLeader?.displayName ?? 'another leader';
      return `\uE08F Send ${survivorName} to ${destName}`;
    }
    default:
      return `Step ${index + 1}`;
  }
}

/**
 * Compact plan-step label split into a verb line and an optional target line.
 *
 * The plan panel groups steps under a per-unit header, so the actor name and
 * hex coordinates are redundant — a step reads as just its action (MOVE, GUARD,
 * EXPLORE…). Only actions aimed at something carry a `target` (attacks, sends),
 * which the panel renders on a second line so a long target name wraps instead
 * of truncating. `entity` (the actor) drives melee-vs-ranged attack wording.
 *
 * Distinct from {@link describePlanAction}, which keeps the verbose, actor-
 * prefixed phrasing used by the AI-debug overlay.
 *
 * @param {{ type: string, entityId: string, [key: string]: * }} action
 * @param {Array<{ id: string, displayName?: string }>} entities
 * @param {number} index  Zero-based step index (fallback label only).
 * @returns {{ verb: string, target: string|null }}
 */
export function describePlanActionParts(action, entities, index = 0) {
  const entity = entities.find(e => e.id === action.entityId);
  // Mirror planner.js: range is weapon-derived (getRange) with a plain `range`
  // fallback for snapshot entities that don't carry the method.
  const rangeOf = e => (typeof e?.getRange === 'function' ? e.getRange() : (e?.range ?? 1));
  switch (action.type) {
    case PlanActionType.MOVE:         return { verb: 'Move',       target: null };
    case PlanActionType.EXPLORE:      return { verb: 'Explore',    target: null };
    case PlanActionType.FORTIFY:      return { verb: 'Fortify',    target: null };
    case PlanActionType.GUARD:        return { verb: 'Guard',      target: null };
    case PlanActionType.SUMMON:       return { verb: 'Summon',     target: null };
    case PlanActionType.HEAL:         return { verb: 'Heal',       target: null };
    case PlanActionType.SOUND_HORN:   return { verb: 'Sound Horn', target: null };
    case PlanActionType.USE_ABILITY:  return { verb: 'Use Ability', target: null };
    case PlanActionType.USE_ITEM:     return { verb: `Use ${RESOURCE_LABEL[action.item] || action.item}`, target: null };
    case PlanActionType.EQUIP_WEAPON: return { verb: `Equip ${WEAPON_LABEL[action.weapon] || action.weapon}`, target: null };
    case PlanActionType.BATTLE_UNIT: {
      const target = entities.find(e => e.id === action.targetId);
      return { verb: rangeOf(entity) > 1 ? 'Ranged Attack' : 'Attack', target: target?.displayName ?? '?' };
    }
    case PlanActionType.BATTLE_HEX:
      return {
        verb: rangeOf(entity) > 1 ? 'Ranged Attack' : 'Attack',
        target: `(${action.targetCol},${action.targetRow})`,
      };
    case PlanActionType.SENT_TO: {
      const destLeader = action.destOwnerId
        ? entities.find(e => e.ownerId === action.destOwnerId && isLeaderType(e.type))
        : null;
      return { verb: 'Send', target: destLeader?.displayName ?? 'another leader' };
    }
    default:
      return { verb: `Step ${index + 1}`, target: null };
  }
}

// ── Action budget pips + breakdown ────────────────────────────────────────────
//
// The top-bar ACTION BUDGET shows one diamond per earned action, tinted by where
// it came from (shades of yellow — see .act-pip--* in styles.css). The same
// shades colour the breakdown tooltip. `parts` is the faction's budget breakdown
// ({ key:'base'|'phase'|'unit'|'node', value }); `used` is how many budget
// actions are queued; `foodOverflow` is actions taken beyond the budget (each
// powered by a spare ration).

/**
 * Flatten budget `parts` into colour-coded pips. The first `total - used` pips
 * render filled (◆, available); the rest render hollow (◇, spent). Food-powered
 * actions taken beyond the budget append as spent food-shade pips.
 */
export function buildActionPipsHtml(parts, used = 0) {
  const keys = [];
  for (const p of (parts || [])) for (let i = 0; i < p.value; i++) keys.push(p.key);
  const total = keys.length;
  const remaining = Math.max(0, total - Math.min(used, total));
  let html = keys.map((key, i) => {
    const spent = i >= remaining;
    return `<span class="act-pip act-pip--${key}${spent ? ' act-pip--spent' : ''}">${spent ? '◇' : '◆'}</span>`;
  }).join('');
  for (let i = 0; i < Math.max(0, used - total); i++) {
    html += `<span class="act-pip act-pip--food act-pip--spent">◇</span>`;
  }
  return html;
}

/**
 * Breakdown tooltip — each source row tinted with its pip shade. `rows` is
 * [{ key, label, value }] (only positive rows); `foodLabel` (optional) adds a
 * trailing food row.
 */
export function buildActionBudgetTooltipHtml(rows, total, foodLabel = '') {
  let html = '<div class="action-breakdown-table">';
  for (const r of (rows || [])) {
    html += `<div class="abkd-row act-src--${r.key}"><span class="abkd-label">${r.label}</span>`
          + `<span class="abkd-val">+${r.value}</span></div>`;
  }
  html += `<hr class="abkd-divider">`;
  html += `<div class="abkd-row abkd-total"><span class="abkd-label">Total</span><span class="abkd-val">${total}</span></div>`;
  if (foodLabel) {
    html += `<div class="abkd-row act-src--food abkd-food"><span class="abkd-label">${foodLabel}</span>`
          + `<span class="abkd-val">extra</span></div>`;
  }
  html += '</div>';
  return html;
}

// ── Turn-card auto-scroll (replay timeline) ───────────────────────────────────
//
// A long turn card (a big game's busy resolution step) overflows the screen.
// The card is CSS-scrollable; as resolution advances we auto-scroll the active
// action into the upper portion of the card so the player always sees what's
// happening — UNLESS the player has just scrolled manually, in which case we
// stand down so we don't fight them.
//
// This module owns only the *decision* logic (DOM-free, unit-testable); the
// wiring (scroll listeners, scrollIntoView) lives in ui.js.

/** How long (ms) a manual scroll suppresses auto-scroll before it resumes. */
export const TURN_CARD_AUTOSCROLL_SUSPEND_MS = 4000;

/**
 * Tracks whether the player has manually scrolled a turn card recently, so the
 * auto-scroll-to-active logic can suspend itself and not yank the card away
 * while the player is reading.
 *
 * Pure + DOM-free: callers feed it a millisecond timestamp (`Date.now()`); it
 * owns no timers and touches no DOM, so it unit-tests without a browser.  A
 * manual scroll is recorded via {@link notifyUserScroll}; it then reports
 * `isSuspended(now) === true` for `windowMs` after that scroll, then resumes.
 */
export class TurnCardAutoScroll {
  constructor({ windowMs = TURN_CARD_AUTOSCROLL_SUSPEND_MS } = {}) {
    this.windowMs = windowMs;
    this._lastUserScrollTs = null;   // null → the player has never scrolled
  }

  /** Record a manual user scroll (wheel / touch / key) at time `now` (ms). */
  notifyUserScroll(now) {
    this._lastUserScrollTs = now;
  }

  /** True while a recent manual scroll should suppress auto-scroll. */
  isSuspended(now) {
    if (this._lastUserScrollTs == null) return false;
    return (now - this._lastUserScrollTs) < this.windowMs;
  }

  /** Convenience inverse of {@link isSuspended} — auto-scroll may run now. */
  shouldAutoScroll(now) {
    return !this.isSuspended(now);
  }

  /** Forget any recent scroll (e.g. when a fresh round's cards mount). */
  reset() {
    this._lastUserScrollTs = null;
  }
}

/**
 * Decide whether the active turn-card entry should be auto-scrolled into view.
 *
 * Pure gate shared by ui.js's `_autoScrollActiveEntry`.  Auto-scroll runs only
 * when: there IS an active step to target, the card isn't collapsed (a collapsed
 * card shows just the active row — scrolling it would only cause a jump), and
 * the player hasn't scrolled manually inside the suspend window.
 *
 * @param {object} opts
 * @param {boolean} [opts.suspended]  Player scrolled recently (TurnCardAutoScroll.isSuspended).
 * @param {boolean} [opts.collapsed]  Card is in its collapsed (active-row-only) state.
 * @param {boolean} [opts.hasActive]  An `.is-acting` entry exists to scroll to.
 * @returns {boolean}
 */
export function shouldAutoScrollToActive({ suspended = false, collapsed = false, hasActive = true } = {}) {
  if (suspended) return false;   // don't fight a player who just scrolled
  if (collapsed) return false;   // collapsed card shows only the active row → nothing to scroll, no jump
  return !!hasActive;            // only scroll when there's an active action to follow
}

/**
 * Compute whether a scroll viewport should show a top/bottom fade gradient.
 * A fade is only warranted when there's content hidden in that direction —
 * a card whose content fits entirely within `clientHeight` gets neither fade
 * (so we don't dim readable text for no reason).
 *
 * Pure + DOM-free: callers feed in measured numbers; the function returns
 * the two boolean flags. UI wiring then toggles the corresponding classes
 * on the scroll viewport.
 *
 * @param {object} [opts]
 * @param {number} [opts.scrollTop]      Current scroll offset (px).
 * @param {number} [opts.clientHeight]   Viewport visible height (px).
 * @param {number} [opts.scrollHeight]   Full content height (px).
 * @returns {{ top: boolean, bottom: boolean }}
 */
export function computeFadeFlags({ scrollTop = 0, clientHeight = 0, scrollHeight = 0 } = {}) {
  // Fits entirely → no overflow either direction.
  if (scrollHeight <= clientHeight) return { top: false, bottom: false };
  // 1px tolerance absorbs sub-pixel rounding (mid-smooth-scroll fractional offsets,
  // device-pixel ratios) so the fade doesn't flicker right at the edges.
  const atTop    = scrollTop <= 0;
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
  return { top: !atTop, bottom: !atBottom };
}

// ── Plan steps list HTML ──────────────────────────────────────────────────────

/**
 * Return a short cost badge string (e.g. "−2⚙") for a plan action, given the
 * projected inventory AT THAT STEP.  Returns '' for free / action-point-only actions.
 */
function _stepCostLabel(action, projShared, projWitch, projEntityItems) {
  switch (action.type) {
    case PlanActionType.SUMMON: {
      if (getItemCountOf(projWitch, ResourceType.METAL) >= 2) return `−2 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.METAL])}`;
      if (getItemCountOf(projWitch, ResourceType.WOOD)  >= 2) return `−2 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.WOOD])}`;
      return '−2 res';
    }
    case PlanActionType.FORTIFY:
      if (getItemCountOf(projShared, ResourceType.METAL) > 0) return `−1 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.METAL])}`;
      if (getItemCountOf(projShared, ResourceType.WOOD)  > 0) return `−1 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.WOOD])}`;
      return '';
    case PlanActionType.HEAL:
      return `−1 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.HERBS])}`;
    case PlanActionType.USE_ITEM: {
      const item = action.item;
      if (!item || ITEMS[item]?.kind === 'weapon') return '';
      return `−1 ${coloredResourceLabel(RESOURCE_LABEL[item] || item)}`;
    }
    case PlanActionType.SOUND_HORN:
      return `−1 ${coloredResourceLabel(RESOURCE_LABEL[ResourceType.FOOD])}`;
    default: return '';
  }
}

/**
 * Build the innerHTML for the #plan-steps list.
 *
 * @param {Array}   plan             Current plan action array.
 * @param {number}  budget           Total action budget for this round.
 * @param {number}  foodAvailable    Total food rations in inventory.
 * @param {boolean} submitted        Whether the plan has been locked in.
 * @param {Array}   entities         Live entity array (for name lookups).
 * @param {object}  [initialInv]     Starting inventory snapshot { shared, witch, entityItems }.
 *                                   When provided, each step shows a resource-cost badge and
 *                                   over-budget steps are marked accordingly.
 * @returns {string}  HTML string safe to assign to stepsEl.innerHTML.
 */
export function buildPlanStepsHtml(plan, budget, foodAvailable, submitted, entities, initialInv) {
  const ENTITY_GLYPH = {
    [EntityType.HERO]:       '\uE000',
    [EntityType.WITCH]:      '\uE001',
    [EntityType.SURVIVOR]:   '\uE002',
    [EntityType.ZOMBIE]:     '\uE005',
    [EntityType.MINION]:     '\uE004',
    [EntityType.WOOD_GOLEM]: '\uE006',
    [EntityType.IRON_GOLEM]: '\uE007',
  };

  // Projected inventory — updated as we walk through steps. Deep-clone the
  // resource dicts (dict-of-objects shape) so mutating projected counts never
  // touches the real state.inventory entries.
  const projShared      = normalizeItems(initialInv?.hero);
  const projWitch       = normalizeItems(initialInv?.witch);
  const projEntityItems = {};
  if (initialInv?.entityItems) {
    for (const [id, items] of Object.entries(initialInv.entityItems)) {
      projEntityItems[id] = { ...items };
    }
  }

  let runningCost = 0;
  let foodUsed    = 0;
  let html        = '';

  plan.forEach((a, i) => {
    const isFree     = a.type === PlanActionType.EQUIP_WEAPON || a.type === PlanActionType.USE_ITEM;
    if (!isFree) runningCost++;
    const overBudget  = !isFree && runningCost > budget;
    // Food is auto-applied to over-budget actions until we run out
    const foodPowered = overBudget && foodUsed < foodAvailable;
    if (foodPowered) foodUsed++;

    const desc      = describePlanAction(a, entities, i);
    const foodTag   = foodPowered ? ` <span class="plan-food-tag">${coloredResourceIcon('food')}</span>` : '';
    const rmBtn     = submitted
      ? ''
      : `<button class="plan-step-remove" data-plan-idx="${i}" title="Remove">\uE070</button>`;
    const cls       = foodPowered ? ' food-powered' : overBudget ? ' over-budget' : '';

    const stepEntity = entities.find(e => e.id === a.entityId);
    const stepGlyph  = stepEntity ? (ENTITY_GLYPH[stepEntity.type] || '?') : '';
    const stepColor  = stepEntity ? (ENTITY_COLOR[stepEntity.type]  || '#aaa') : '#aaa';
    const avatar     = stepEntity
      ? `<span class="plan-step-avatar" style="background:${stepColor}">${stepGlyph}</span>`
      : '';

    // Resource cost badge — only shown when inventory data is available
    const costLbl = initialInv ? _stepCostLabel(a, projShared, projWitch, projEntityItems) : '';
    const costTag = costLbl ? ` <span class="plan-step-cost">${costLbl}</span>` : '';

    html += `<div class="plan-step${cls}">
        <span class="plan-step-num">${i + 1}</span>
        ${avatar}
        <span class="plan-step-desc" title="${desc}">${desc}${foodTag}${costTag}</span>
        ${rmBtn}
      </div>`;

    // Advance projected inventory for subsequent steps
    _advanceProjectedInventory(a, projShared, projWitch, projEntityItems, entities);
  });

  return html || `<div class="plan-step"><span class="plan-step-desc" style="color:var(--muted)">No actions queued — click units to add</span></div>`;
}

// ── Per-unit plan blocks HTML ────────────────────────────────────────────────

const UNIT_GLYPH = {
  [EntityType.HERO]:       '\uE000',
  [EntityType.WITCH]:      '\uE001',
  [EntityType.SURVIVOR]:   '\uE002',
  [EntityType.ZOMBIE]:     '\uE005',
  [EntityType.MINION]:     '\uE004',
  [EntityType.WOOD_GOLEM]: '\uE006',
  [EntityType.IRON_GOLEM]: '\uE007',
};

/**
 * Read-only unit detail shown inside the selected unit's plan block — mirrors
 * the Unit Stats Bar (ui.js _renderUnitStatsBar): HP, equipped weapon, ATK/DEF/
 * RNG, ability + effects, plus the unit's personal pack. Pure (no DOM/`this`).
 *
 * @param {object} entity  Live Entity (getAttack/getDefense/getRange available).
 * @param {object} [items] key→count pack map (projected); falls back to entity.items.
 * @returns {string} HTML for the `.plan-unit-detail` block.
 */
export function buildUnitDetailHtml(entity, items, expanded = false) {
  if (!entity) return '';
  const pack = items ?? entity.items ?? {};

  const hpPct   = Math.max(0, Math.min(100, (entity.hp / entity.maxHp) * 100));
  const hpColor = hpPct > 60 ? '#4caf7d' : hpPct > 30 ? '#f5c842' : '#c0392b';
  const atk = typeof entity.getAttack === 'function' ? entity.getAttack() : (entity.attack ?? 0);
  const def = typeof entity.getDefense === 'function' ? entity.getDefense() : (entity.defense ?? 0);
  const rng = typeof entity.getRange === 'function' ? entity.getRange() : (entity.range ?? 1);

  // Equipped weapon is the entity's own equipped weapon (shown in the vitals
  // line), independent of the projected `items` arg used for the pack listing.
  const equippedId = typeof entity.getEquippedWeaponId === 'function'
    ? entity.getEquippedWeaponId()
    : getEquippedWeaponIdOf(entity.items);
  const weaponLabel = equippedId
    ? (WEAPON_LABEL[equippedId] || equippedId)
    : '\uE08C Unarmed';
  const abilityHtml = entity.abilityLabel
    ? `<span class="usb-ability">\uE062 ${entity.abilityLabel}</span>`
    : '';
  const effectsHtml = buildEffectsHtml(entity);

  // Pack rows: weapons via WEAPON_LABEL, everything else via RESOURCE_LABEL.
  // The equipped weapon shows in the vitals line, so its *wielded* copy is
  // excluded here — but any spare copies of that same weapon (count > 1) still
  // belong in the pack, otherwise a duplicate equipped weapon would vanish.
  const packRows = Object.entries(pack)
    .map(([k, e]) => {
      // Hide the single wielded copy; surface the rest as spares.
      const spare = (e?.count ?? 0) - (k === equippedId ? 1 : 0);
      return [k, spare];
    })
    .filter(([, spare]) => spare > 0)
    .map(([k, spare]) => {
      const label = ITEMS[k]?.kind === 'weapon'
        ? (WEAPON_LABEL[k] || k)
        : coloredResourceLabel(RESOURCE_LABEL[k] || k);
      return `<div class="inv-resource-row">`
           + `<span class="inv-resource-label">${label}</span>`
           + `<span class="inv-resource-val">×${spare}</span></div>`;
    }).join('');

  // Each group on its own line — a long weapon label wrapping next to the
  // stats looks bad in the narrow side panel.
  const hpHtml = `<span class="usb-hp-wrap"><span class="usb-stat">HP</span>`
    + `<span class="usb-hp-track"><span class="usb-hp-fill" style="width:${hpPct}%;background:linear-gradient(to bottom,rgba(255,255,255,0.28) 0%,rgba(255,255,255,0) 55%),${hpColor}"></span></span>`
    + `<span class="usb-stat-val">${entity.hp}/${entity.maxHp}</span></span>`;
  const agi = typeof entity.getAgility === 'function' ? entity.getAgility() : (entity.agility ?? 0);
  const statsHtml = `<span class="usb-stat">ATK <span class="usb-stat-val">${atk}</span></span>`
    + `<span class="usb-stat">DEF <span class="usb-stat-val">${def}</span></span>`
    + `<span class="usb-stat">RNG <span class="usb-stat-val">${rng}</span></span>`
    + `<span class="usb-stat" title="Agility — higher acts earlier each turn">AGI <span class="usb-stat-val">${agi}</span></span>`;
  const extraLine = (abilityHtml || effectsHtml)
    ? `<div class="plan-unit-vline">${abilityHtml}${effectsHtml}</div>`
    : '';

  // Compact line mirrors the Unit Stats Bar: HP bar + weapon + the (i) toggle.
  // The (i) reveals the rest (ATK/DEF/RNG/AGI + abilities + pack), kept ABOVE
  // the action list so a unit's vitals always sit at the top of its block.
  const infoBtn = `<button class="usb-info-btn plan-stats-btn ${expanded ? 'usb-info-btn-active' : ''}" `
    + `title="${expanded ? 'Hide stats & pack' : 'Show stats & pack'}">i</button>`;
  const expandedHtml = expanded
    ? `<div class="plan-unit-vline">${statsHtml}</div>`
      + extraLine
      + `<div class="plan-unit-pack">`
      +   (packRows || `<div class="inv-empty">No spare items</div>`)
      + `</div>`
    : '';

  return `<div class="plan-unit-detail">`
    + `<div class="plan-unit-vitalrow">${hpHtml}`
    +   `<span class="usb-weapon">${weaponLabel}</span>${infoBtn}</div>`
    + expandedHtml
    + `</div>`;
}

/**
 * Build plan panel HTML with visually distinct blocks per unit.
 *
 * Renders a row for every controllable unit (even units with zero queued
 * actions), highlighting the currently selected unit. This lets the plan panel
 * double as a unit selector.
 *
 * @param {Map<string, Array>} unitPlans       Map of entityId → PlanAction[].
 * @param {number}  budget                     Total action budget for this round.
 * @param {number}  foodAvailable              Total food rations in inventory.
 * @param {boolean} submitted                  Whether the plan has been locked in.
 * @param {Array}   entities                   Live entity array (for name lookups).
 * @param {object}  [initialInv]               Starting inventory snapshot.
 * @param {Array}   [controllableUnits]        Every unit the local player controls, in display order.
 * @param {string}  [selectedEntityId]         The selected unit — its block renders an expanded
 *                                             read-only detail (HP/weapon/stats + pack) and a ▾ chevron.
 *                                             (The .plan-unit-selected highlight is still applied
 *                                             post-render by UIController._syncPlanSelectionClass.)
 * @param {Map<string,string>} [portraitMap]   entityId → portrait data URL (optional; falls back to glyph).
 * @returns {string}  HTML string safe to assign to stepsEl.innerHTML.
 */
export function buildUnitPlanBlocksHtml(
  unitPlans, budget, foodAvailable, submitted, entities, initialInv,
  controllableUnits, selectedEntityId, portraitMap, statsExpanded = false,
) {
  // Pre-compute budget state and cost labels by walking actions in interleaved
  // order (matching resolution execution order).  Store results keyed by
  // "entityId:stepIdx" for lookup during per-unit rendering.
  const budgetState = new Map();   // key → 'ok' | 'food' | 'over'
  const costLabels  = new Map();   // key → string

  const projShared      = normalizeItems(initialInv?.hero);
  const projWitch       = normalizeItems(initialInv?.witch);
  const projEntityItems = {};
  if (initialInv?.entityItems) {
    for (const [id, items] of Object.entries(initialInv.entityItems)) {
      projEntityItems[id] = { ...items };
    }
  }

  const unitPlansMap = unitPlans ?? new Map();
  let runningCost = 0;
  let foodUsed    = 0;
  const unitIds = [...unitPlansMap.keys()];
  let step = 0;
  while (unitIds.length > 0) {
    let any = false;
    for (const eid of unitIds) {
      const actions = unitPlansMap.get(eid);
      if (step >= actions.length) continue;
      any = true;
      const a = actions[step];
      const key = `${eid}:${step}`;
      const isFree = a.type === PlanActionType.EQUIP_WEAPON || a.type === PlanActionType.USE_ITEM;
      if (!isFree) runningCost++;
      const overBudget  = !isFree && runningCost > budget;
      const foodPowered = overBudget && foodUsed < foodAvailable;
      if (foodPowered) foodUsed++;

      budgetState.set(key, foodPowered ? 'food' : overBudget ? 'over' : 'ok');
      costLabels.set(key, initialInv ? _stepCostLabel(a, projShared, projWitch, projEntityItems) : '');

      // Advance projected inventory
      _advanceProjectedInventory(a, projShared, projWitch, projEntityItems, entities);
    }
    if (!any) break;
    step++;
  }

  // Determine the render order. Prefer the full controllable-units list so
  // units without actions still appear; fall back to unitPlans keys otherwise.
  let renderOrder;
  if (controllableUnits && controllableUnits.length > 0) {
    const ids = controllableUnits.map(e => e.id);
    // Tail on any unit that has queued actions but isn't in the controllable
    // list (e.g. just-killed unit with pending plan steps) so actions never vanish.
    for (const id of unitPlansMap.keys()) {
      if (!ids.includes(id)) ids.push(id);
    }
    renderOrder = ids;
  } else {
    renderOrder = [...unitPlansMap.keys()];
  }

  if (renderOrder.length === 0) {
    return `<div class="plan-step"><span class="plan-step-desc" style="color:var(--muted)">No units to command</span></div>`;
  }

  // Render per-unit blocks
  let html = '';

  for (const entityId of renderOrder) {
    const entity = entities.find(e => e.id === entityId);
    const glyph  = entity ? (UNIT_GLYPH[entity.type] || '?') : '?';
    const color  = entity ? (ENTITY_COLOR[entity.type] || '#aaa') : '#aaa';
    const name   = entity?.displayName ?? 'Unit';
    const actions = unitPlansMap.get(entityId) ?? [];
    const count  = actions.filter(a =>
      a.type !== PlanActionType.EQUIP_WEAPON && a.type !== PlanActionType.USE_ITEM
    ).length;

    const portraitSrc = portraitMap?.get(entityId);
    const avatarHtml = portraitSrc
      ? `<img class="plan-step-avatar" src="${portraitSrc}" style="border-color:${color}" alt="">`
      : `<span class="plan-step-avatar" style="background:${color}">${glyph}</span>`;

    // The `.plan-unit-selected` highlight is applied post-render by
    // UIController._syncPlanSelectionClass (single subscriber to the renderer's
    // onSelectionChange hook), not baked into this HTML.
    const isSelected = !!selectedEntityId && entityId === selectedEntityId;
    const chevron = isSelected ? '▾' : '▸';
    html += `<div class="plan-unit-block" data-entity-id="${entityId}">`;
    html += `<div class="plan-unit-header">`;
    html += `<span class="plan-unit-chevron">${chevron}</span>`;
    html += avatarHtml;
    html += `<span class="plan-unit-name">${name}</span>`;
    html += levelPillHtml(entity?.level);
    html += `<span class="plan-unit-count">${count} action${count !== 1 ? 's' : ''}</span>`;
    html += `</div>`;

    // Read-only vitals for the selected unit, ABOVE its action list: HP + weapon
    // + an (i) toggle (mirrors the Unit Stats Bar). Uses projected per-unit items
    // so queued equips/uses are reflected.
    if (isSelected && entity) {
      const items = projEntityItems[entityId] ?? entity.items ?? {};
      html += buildUnitDetailHtml(entity, items, statsExpanded);
    }

    html += `<div class="plan-unit-steps">`;

    if (actions.length === 0) {
      html += `<div class="plan-step plan-step-empty"><span class="plan-step-desc">No actions queued</span></div>`;
    } else {
      actions.forEach((a, idx) => {
        const key  = `${entityId}:${idx}`;
        const bst  = budgetState.get(key) ?? 'ok';
        const cls  = bst === 'food' ? ' food-powered' : bst === 'over' ? ' over-budget' : '';
        // Compact label: just the verb (the unit name lives in the block header
        // above, hex coords are noise). Targeted actions (attack/send) carry the
        // target onto a second line so a long name wraps instead of truncating.
        const { verb, target } = describePlanActionParts(a, entities, idx);
        const title   = target ? `${verb} \u2192 ${target}` : verb;
        const verbHtml   = `<span class="plan-step-verb">${tintResourceGlyphs(verb)}</span>`;
        const targetHtml = target ? `<span class="plan-step-target">\u2192 ${target}</span>` : '';
        const foodTag = bst === 'food' ? ` <span class="plan-food-tag">${coloredResourceIcon('food')}</span>` : '';
        const rmBtn   = submitted
          ? ''
          : `<button class="plan-step-remove" data-entity-id="${entityId}" data-step-idx="${idx}" title="Remove">\uE070</button>`;
        const costLbl = costLabels.get(key) ?? '';
        const costTag = costLbl ? ` <span class="plan-step-cost">${costLbl}</span>` : '';

        html += `<div class="plan-step${cls}">
            <span class="plan-step-num">${idx + 1}</span>
            <span class="plan-step-desc" title="${title}">${verbHtml}${foodTag}${costTag}${targetHtml}</span>
            ${rmBtn}
          </div>`;
      });
    }

    html += `</div>`; // close .plan-unit-steps

    html += `</div>`; // close .plan-unit-block
  }

  return html;
}

/** Advance projected inventory for one action (shared between flat and per-unit renderers). */
function _advanceProjectedInventory(a, projShared, projWitch, projEntityItems, entities) {
  switch (a.type) {
    case PlanActionType.SUMMON:
      if (getItemCountOf(projWitch, ResourceType.METAL) >= 2) { removeItemInItems(projWitch, ResourceType.METAL, 2); }
      else if (getItemCountOf(projWitch, ResourceType.WOOD) >= 2) { removeItemInItems(projWitch, ResourceType.WOOD, 2); }
      else {
        let rem = 2;
        for (const k of Object.keys(projWitch).sort((a, b) => getItemCountOf(projWitch, b) - getItemCountOf(projWitch, a))) {
          const spend = Math.min(getItemCountOf(projWitch, k), rem); removeItemInItems(projWitch, k, spend); rem -= spend;
          if (rem === 0) break;
        }
      }
      break;
    case PlanActionType.FORTIFY:
      if (getItemCountOf(projShared, ResourceType.METAL) > 0) removeItemInItems(projShared, ResourceType.METAL, 1);
      else if (getItemCountOf(projShared, ResourceType.WOOD) > 0) removeItemInItems(projShared, ResourceType.WOOD, 1);
      break;
    case PlanActionType.HEAL: {
      const healEnt = entities?.find(e => e.id === a.entityId);
      const healPools = { hero: projShared, witch: projWitch };
      const healPool = healPools[healEnt?.owner] || projShared;
      if (getItemCountOf(healPool, ResourceType.HERBS) > 0) removeItemInItems(healPool, ResourceType.HERBS, 1);
      break;
    }
    case PlanActionType.USE_ITEM: {
      const item = a.item;
      if (!item || ITEMS[item]?.kind === 'weapon') break;
      if (getItemCountOf(projShared, item) > 0) { removeItemInItems(projShared, item, 1); }
      break;
    }
    case PlanActionType.SOUND_HORN:
      if (getItemCountOf(projShared, ResourceType.FOOD) >= 1) removeItemInItems(projShared, ResourceType.FOOD, 1);
      break;
  }
}

// ── Player status panel HTML ──────────────────────────────────────────────────

/** Strict hex-color validator — guarantees no CSS/HTML injection via inline style. */
const PLAYER_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/**
 * Build the innerHTML for the #plan-players ready list.
 *
 * @param {Array<{ playerId: string, name: string, faction: string, color?: string|null, _submitted?: boolean }>} players
 * @param {{ myPlayerId?: string, nudgedSet?: Set<string> }} [nudgeCtx]
 *   When provided, renders a nudge button for other human players who haven't submitted.
 * @returns {string}  HTML string.
 */
export function buildPlayerStatusHtml(players, nudgeCtx) {
  const myId    = nudgeCtx?.myPlayerId ?? null;
  const nudged  = nudgeCtx?.nudgedSet ?? null;
  let html = '';
  for (const p of players) {
    const pid       = p.playerId ?? p.id;
    const submitted = p._submitted ?? false;
    const icon      = submitted ? '\uE071' : '⋯';
    const cls       = submitted ? 'player-ready' : 'player-waiting';
    const label     = p.name;
    const fCls      = p.faction === 'hero' ? 'faction-hero' : 'faction-witch';
    const safeName  = String(label)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Per-player color (matches map unit outlines). Validated to prevent injection —
    // falls back to the faction CSS class when absent or invalid.
    const safeColor  = (p.color && PLAYER_COLOR_RE.test(p.color)) ? p.color : null;
    const colorStyle = safeColor ? ` style="color: ${safeColor}"` : '';
    // Presence dot: green = active, yellow = connected but backgrounded, grey = disconnected
    const presenceCls = p.active ? 'presence-active'
      : p.connected ? 'presence-inactive'
      : 'presence-offline';
    const presenceDot = (p.isAI || p.connected === undefined) ? ''
      : `<span class="presence-dot ${presenceCls}"></span>`;

    // Nudge button: shown for other human players who haven't submitted
    let nudgeBtn = '';
    if (nudged && myId && pid !== myId && !p.isAI && !submitted) {
      const already = nudged.has(pid);
      nudgeBtn = already
        ? `<button class="nudge-btn nudge-sent" disabled title="Nudge sent">NUDGE</button>`
        : `<button class="nudge-btn" data-nudge-id="${pid}" title="Nudge">NUDGE</button>`;
    }

    html += `<div class="plan-player-row ${cls}">
        <span class="plan-player-icon ${fCls}"${colorStyle}>${p.faction === 'hero' ? '\uE000' : '\uE001'}</span>
        ${presenceDot}<span class="plan-player-name"${colorStyle}>${safeName}</span>
        ${nudgeBtn}<span class="plan-player-status">${icon}</span>
      </div>`;
  }
  return html;
}

// ── Objectives / node-status HTML ────────────────────────────────────────────

/**
 * Build innerHTML for the #node-status element and return { html, title }.
 *
 * @param {{ col: number, row: number, label: string }[]} witchObjectives
 * @param {Array<{ alive: boolean, owner: string, col: number, row: number }>} entities
 * @param {{ hero: number, witch: number }} nodeScore
 * @returns {{ html: string, title: string }}
 */
export function buildObjectivesHtml(witchObjectives, entities, nodeScore, gameMode = 'standard') {
  let nodeDots  = '';

  for (const obj of witchObjectives) {
    const ctrl = nodeController(obj, entities);
    let cls;
    if      (ctrl === 'witch')     { cls = 'witch';     }
    else if (ctrl === 'hero')      { cls = 'hero';      }
    else if (ctrl === 'contested') { cls = 'contested'; }
    else                           { cls = 'neutral';   }
    const nodeColor = obj.color ?? '#888';
    nodeDots += `<span class="node-dot ${cls}" style="border-color:${nodeColor}"></span>`;
  }

  const score = nodeScore ?? { hero: 0, witch: 0 };
  let html;

  // No native title tooltips here — tapping the bar opens the game-styled
  // cycle & scoring info panel (buildCycleInfoHtml) instead.
  if (gameMode === 'battle') {
    // Battle mode: numeric score display (unbounded)
    html =
      `<span class="score-track hero-track battle-score">` +
        `<span class="score-num hero">${score.hero}</span>` +
      `</span>` +
      `<span class="node-dots-group">${nodeDots}</span>` +
      `<span class="score-track witch-track battle-score">` +
        `<span class="score-num witch">${score.witch}</span>` +
      `</span>`;
  } else {
    // Standard mode: pip-based score display (max 4)
    const scoreMax = 4;
    const heroPips  = Array.from({ length: scoreMax }, (_, i) =>
      `<span class="score-pip hero${i < score.hero ? ' filled' : ''}"></span>`).join('');
    const witchPips = Array.from({ length: scoreMax }, (_, i) =>
      `<span class="score-pip witch${i < score.witch ? ' filled' : ''}"></span>`).join('');
    html =
      `<span class="score-track hero-track">${heroPips}</span>` +
      `<span class="node-dots-group">${nodeDots}</span>` +
      `<span class="score-track witch-track">${witchPips}</span>`;
  }

  return { html };
}

/** Minimal HTML escape for author-supplied objective labels. */
function _escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the Mission Log description/briefing header block — the mission's
 * briefing text shown ABOVE the objective list at the top of the Mission Log.
 * Pure presentation (Show): a deterministic, HTML-escaped read of the mission's
 * static description; never touches the DOM or engine state.
 *
 * @param {string} description - the mission briefing text (e.g. missionDef.briefing).
 * @returns {string} the description markup, or '' when there is no description.
 */
export function buildMissionLogDescriptionHtml(description) {
  const text = String(description ?? '').trim();
  if (!text) return '';
  return `<span class="mission-log-desc-text">${_escHtml(text)}</span>`;
}

/**
 * Build the Mission Log to-do list HTML (the top half of the Chronicle sidebar).
 * Pure — reads the authoritative objective list from the mission-logic engine and
 * returns markup; never touches the DOM or engine state (Sim/Show split).
 *
 * @param {Array<{ id, label, current, target, completed }>} objectives
 * @returns {string} `<li>` rows; '' when there are no objectives.
 */
export function buildMissionLogHtml(objectives) {
  const objs = Array.isArray(objectives) ? objectives : [];
  return objs.map((o) => {
    const done = !!o.completed;
    const hasTarget = o.target != null;
    const marker = done ? '\uE071'
      : hasTarget ? `${Math.max(0, o.current ?? 0)}/${o.target}`
      : '\uE09C';
    return `<li class="mission-log-item${done ? ' done' : ''}">`
      + `<span class="mission-log-marker">${marker}</span>`
      + `<span class="mission-log-label">${_escHtml(o.label ?? o.id ?? '')}</span>`
      + `</li>`;
  }).join('');
}

/**
 * Badge describing the Power Node occupying a hex, for the Unit Stats Bar.
 * Returns '' when the hex (col,row) is not part of any node cluster.
 * Shows the node name in its own color plus the controlling faction.
 */
export function buildNodeBadgeHtml(witchObjectives, entities, col, row) {
  if (!witchObjectives || !witchObjectives.length) return '';
  const key = hexKey(col, row);
  const node = witchObjectives.find(o =>
    (o.hexes ?? []).some(h => hexKey(h.col, h.row) === key));
  if (!node) return '';

  const ctrl = nodeController(node, entities ?? []);
  const CTRL_DISPLAY = {
    hero:      { label: 'Hero',         color: getFactionTheme('hero').highlight },
    witch:     { label: 'Witch',        color: getFactionTheme('witch').highlight },
    contested: { label: 'Contested',    color: '#ffaa00' },
    neutral:   { label: 'Uncontrolled', color: '#9a9488' },
  };
  const disp = CTRL_DISPLAY[ctrl] ?? CTRL_DISPLAY.neutral;

  const nodeColor = node.color ?? '#c89dff';
  const name = node.label ?? 'Power Node';
  return `<span class="usb-terrain-node" style="color:${nodeColor}">\uE08E ${name}</span>` +
    ` · <span style="color:${disp.color}">${disp.label}</span>`;
}

// ── Cycle & scoring info panel ────────────────────────────────────────────────
//
// Content for the panel that opens when the player taps the bottom score bar
// or the day-cycle pill. Replaces the native title tooltips with a
// game-styled, touch-friendly explanation of the phase cycle and the node
// scoring rules. Pure HTML string — no DOM.

/** Per-phase display metadata — shared by the turn-info pill and this panel. */
export const PHASE_META = Object.freeze({
  dawn:  { sprite: 'cycle_dawn',  label: 'Dawn',  desc: 'Hero +1 action · node scoring · attrition rises' },
  day:   { sprite: 'cycle_day',   label: 'Day',   desc: 'Witch undead in the open suffer' },
  dusk:  { sprite: 'cycle_dusk',  label: 'Dusk',  desc: 'Node scoring · seek cover before night' },
  night: { sprite: 'cycle_night', label: 'Night', desc: 'Witch +2 ATK · Survivors in the open suffer' },
});

// Phase blurbs for missions that disable node scoring — same effects minus
// the scoring mention, so the panel doesn't promise points that never come.
const PHASE_DESC_NO_SCORING = Object.freeze({
  dawn: 'Hero +1 action · attrition rises',
  dusk: 'Seek cover before night',
});

/**
 * Deadline-countdown data + track HTML for a fixed-end (non-looping) mission's
 * cycle bar. Returns null for normal/looping games so they render unchanged.
 *
 * The track is one segment per round of the cycle: rounds already played are
 * filled, the current round pulses, and the final round (the deadline) is
 * marked. Pure — the HUD passes the rendered string straight into the DOM.
 *
 * @returns {{ total:number, current:number, remaining:number, deadlinePhase:string,
 *             countLabel:string, trackHtml:string } | null}
 */
export function buildCycleDeadlineHtml(state) {
  const cfg = state.cycleConfig;
  if (!cfg || cfg.loop || !Array.isArray(cfg.phases) || cfg.phases.length === 0) return null;

  const total = cfg.phases.length;
  // Clamp the displayed round into the cycle: the final turn (and any clamped
  // overflow) reads as the deadline round, never N+1 (see phaseForRound clamp).
  const current   = Math.min(Math.max(state.round, 1), total);
  const remaining = Math.max(0, total - current);   // full rounds left AFTER this one
  const deadlinePhase = cfg.phases[total - 1];

  // Segmented track: past = filled, current = active, future = empty; the final
  // (deadline) segment carries a marker class regardless of state.
  let trackHtml = '';
  for (let i = 0; i < total; i++) {
    const phase = cfg.phases[i];
    const cls = ['cd-seg', `phase-${phase}`];
    if (i + 1 < current)  cls.push('past');
    else if (i + 1 === current) cls.push('active');
    else cls.push('future');
    if (i === total - 1) cls.push('deadline');
    trackHtml += `<span class="${cls.join(' ')}"></span>`;
  }

  return {
    total,
    current,
    remaining,
    deadlinePhase,
    // The cycle-bump label already states "<Phase> — Round N of N"; the countdown
    // names the DEADLINE instead (the segmented track shows per-round progress)
    // so the round isn't stated twice in the same bar.
    countLabel: `${ICON.hourglass} Ends ${PHASE_META[deadlinePhase]?.label ?? deadlinePhase}`,
    trackHtml,
  };
}

export function buildCycleInfoHtml(state, icons = {}) {
  const phases   = state.cycleConfig?.phases ?? DEFAULT_CYCLE_PHASES;
  const cycleLen = phases.length;
  const idx      = (state.round - 1) % cycleLen;
  const cycleNum = Math.ceil(state.round / cycleLen);
  const cur      = phases[idx];
  const next     = phases[(idx + 1) % cycleLen];
  const meta     = (p) => {
    const m = PHASE_META[p] ?? { label: p, desc: '' };
    return (state.disableScoring && PHASE_DESC_NO_SCORING[p])
      ? { ...m, desc: PHASE_DESC_NO_SCORING[p] }
      : m;
  };
  // The caller passes the game's cycle sprites (renderer data URLs) keyed by
  // phase; the emoji is only the headless/loading fallback.
  const icon = (p) => icons[p]
    ? `<img class="cip-icon" src="${icons[p]}" alt="${meta(p).label}">`
    : `${PHASE_ICON[p] ?? ''}`;

  // Cycle strip — one chip per round in the cycle, current highlighted.
  const strip = phases.map((p, i) =>
    `<span class="cip-chip phase-${p}${i === idx ? ' current' : ''}">${icon(p)}</span>`
  ).join('');

  let html = `<div class="cip-title">Day ${cycleNum} · Round ${state.round}</div>`;
  html += `<div class="cip-strip">${strip}</div>`;
  html += `<div class="cip-phase"><span class="cip-phase-name">${icon(cur)} ${meta(cur).label}</span>`
        + `<span class="cip-phase-desc">${meta(cur).desc}</span></div>`;
  html += `<div class="cip-phase cip-next"><span class="cip-phase-name">Next: ${icon(next)} ${meta(next).label}</span>`
        + `<span class="cip-phase-desc">${meta(next).desc}</span></div>`;

  // Scoring rules + live node status. Campaign missions can turn node scoring
  // off entirely (state.disableScoring) — suppress the rule text and the score
  // pips so the panel doesn't promise points the mission will never award.
  const threshold = state.nodeScoreThreshold ?? 4;
  const scoringOn = !state.disableScoring;
  if (scoringOn) {
    html += `<hr class="cip-divider">`;
    if (state.gameMode === 'battle') {
      html += `<div class="cip-rule">Points score every round. The faction leading when time runs out wins.</div>`;
    } else {
      html += `<div class="cip-rule">At every <b>dawn</b> and <b>dusk</b>, the side holding <b>more Power Nodes</b> scores a point — ties score nothing. First to <b>${threshold} points</b> wins.</div>`;
    }
  }
  const CTRL = {
    hero:      { label: 'Hero',       cls: 'hero' },
    witch:     { label: 'Witch',      cls: 'witch' },
    contested: { label: 'Contested',  cls: 'contested' },
    neutral:   { label: 'Unclaimed',  cls: 'neutral' },
  };
  const nodes = (state.witchObjectives ?? []).map(o => {
    const c = CTRL[nodeController(o, state.entities ?? [])] ?? CTRL.neutral;
    return `<div class="cip-node"><span class="cip-node-name" style="color:${o.color ?? '#c89dff'}">\uE08E ${o.label ?? 'Power Node'}</span>`
      + `<span class="cip-node-ctrl ${c.cls}">${c.label}</span></div>`;
  }).join('');
  if (nodes) {
    if (!scoringOn) html += `<hr class="cip-divider">`;
    html += `<div class="cip-nodes">${nodes}</div>`;
  }
  // Score — the same pips as the bar (battle mode is unbounded → numeric).
  if (scoringOn) {
    const score = state.nodeScore ?? { hero: 0, witch: 0 };
    if (state.gameMode === 'battle') {
      html += `<div class="cip-score">\uE000 ${score.hero} — ${score.witch} \uE001</div>`;
    } else {
      const pips = (cls, n) => Array.from({ length: threshold }, (_, i) =>
        `<span class="score-pip ${cls}${i < n ? ' filled' : ''}"></span>`).join('');
      html += `<div class="cip-score">`
        + `<span class="cip-score-glyph">\uE000</span>${pips('hero', score.hero)}`
        + `<span class="cip-score-sep">—</span>`
        + `${pips('witch', score.witch)}<span class="cip-score-glyph">\uE001</span></div>`;
    }
  }
  return html;
}

// ── Turn-card roll breakdown popup (game-styled hover tooltip content) ───────
//
// Renders buildRollRows() as the old 2D battle dialog did: attack and
// defense COLUMNS side by side — each headed by its combatant's icon + name —
// building line by line: dice pool (picked die highlighted against the
// discards), one row per modifier (positive green / negative red), divider,
// Total — followed by the outcome (what happened, why, and who took how much
// damage) and the rules notes. Pure HTML string — no DOM.
//
// `opts.portraitFor(unitRef)` returns a portrait data-URL (or null) for the
// combatant header icons; without it (or on a miss) the header falls back to
// the unit's coloured glyph chip.
export function buildRollRowsTipHtml(rows, entry = {}, { portraitFor = null } = {}) {
  if (!rows) return '';
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const combatantHead = (u) => {
    if (!u) return '';
    const src = portraitFor ? portraitFor(u) : null;
    const icon = src
      ? `<img class="gtt-combatant-icon" src="${src}" style="border-color:${u.color}" alt="">`
      : `<span class="gtt-combatant-icon" style="background:${u.color}">${esc(u.glyph ?? '')}</span>`;
    return `<div class="gtt-combatant">${icon}`
      + `<span class="gtt-combatant-name">${esc(u.name)}</span></div>`;
  };

  const diceRow = ({ pool, picked, advantage }) => {
    let usedPick = false;
    const discards = [];
    let pickedHtml = '';
    for (const v of (Array.isArray(pool) ? pool : [picked])) {
      const isPick = !usedPick && v === picked;
      if (isPick) { usedPick = true; pickedHtml = `<span class="gtt-die gtt-die-picked">${v}</span>`; }
      else discards.push(`<span class="gtt-die gtt-die-discard">${v}</span>`);
    }
    const note = advantage > 0 ? `adv ${advantage}` : advantage < 0 ? `disadv ${-advantage}` : 'die';
    return `<div class="gtt-row gtt-dice-row">`
      + `<span class="gtt-label">${note}${discards.length ? ` ${discards.join('')}` : ''}</span>`
      + `<span class="gtt-val">${pickedHtml}</span></div>`;
  };

  const column = (name, cls, side, padTo, headHtml) => {
    let html = `<div class="gtt-col ${cls}">`;
    html += `<div class="gtt-col-head">${name}</div>`;
    html += headHtml;
    html += diceRow(side.dice);
    for (const t of side.terms) {
      const sign = t.val > 0 ? 'positive' : 'negative';
      const v = t.val > 0 ? `+${t.val}` : `−${Math.abs(t.val)}`;
      html += `<div class="gtt-row" data-sign="${sign}">`
        + `<span class="gtt-label">${esc(t.label)}</span>`
        + `<span class="gtt-val">${v}</span></div>`;
    }
    // Spacer rows so both Totals sit on the same baseline (old dialog padTo).
    for (let i = side.terms.length; i < padTo; i++) {
      html += `<div class="gtt-row gtt-row-spacer">&nbsp;</div>`;
    }
    html += `<div class="gtt-row gtt-total-row"><span class="gtt-label">Total</span>`
      + `<span class="gtt-val">${side.roll}</span></div>`;
    return html + `</div>`;
  };

  const padTo = Math.max(rows.atk.terms.length, rows.def.terms.length);
  let html = `<div class="gtt-bkd">`;
  html += `<div class="gtt-cols">`
    + column('\uE000 ATTACK', 'gtt-atk', rows.atk, padTo, combatantHead(entry.actor))
    + column('\uE042 DEFENSE', 'gtt-def', rows.def, padTo, combatantHead(entry.target))
    + `</div>`;

  // Outcome: what happened, why, and the damage dealt.
  const outcome = buildOutcomeSummary(entry);
  if (outcome) {
    html += `<div class="gtt-outcome" data-kind="${outcome.kind}">`
      + `<div class="gtt-outcome-word">${esc(outcome.headline)}</div>`
      + `<div class="gtt-outcome-reason">${esc(outcome.reason)}</div>`
      + outcome.lines.map(l => `<div class="gtt-outcome-line">${esc(l)}</div>`).join('')
      + `</div>`;
  }

  for (const n of rows.notes) html += `<div class="gtt-note">${esc(n)}</div>`;
  html += `<div class="gtt-rule">${esc(rows.rule)}</div>`;
  html += `</div>`;
  return html;
}

// ── Game-tooltip placement ────────────────────────────────────────────────────
//
// Pure geometry for initGameTooltips. Default placement: above the hovered
// target, clamped to the viewport, flipping below when there's no headroom.
// When the target lives inside a replay turn card (`cardRect` given), the
// popup must never cover the card the player is reading: it goes BELOW the
// whole card, or docks BESIDE it when there's no room below.
export function computeGameTooltipPos({
  targetRect: r, cardRect = null, tipW, tipH, viewportW, viewportH,
}) {
  let x = r.left + r.width / 2 - tipW / 2;
  x = Math.max(6, Math.min(x, viewportW - tipW - 6));
  if (cardRect) {
    let y = cardRect.bottom + 10;
    if (y + tipH > viewportH - 6) {
      // No room below the card — dock beside it (right, else left).
      x = cardRect.right + 10;
      if (x + tipW > viewportW - 6) x = Math.max(6, cardRect.left - tipW - 10);
      y = Math.max(6, Math.min(cardRect.top, viewportH - tipH - 6));
    }
    return { x, y };
  }
  let y = r.top - tipH - 10;
  if (y < 6) y = r.bottom + 10;
  return { x, y };
}
