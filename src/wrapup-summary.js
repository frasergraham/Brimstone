// Shared builders for the wrap-up card's combat summary — pure HTML-string
// assembly, no DOM. Renders the "[icon] vs [icon] with HP loss / skull
// beneath each unit" element used by the in-game end-of-turn wrap-up card
// (ui.js _buildWrapUpBody) and the admin Combat tester, so both present
// battles with the same .wrapup-* classes from styles.css.
//
// Portrait lookup is renderer-bound, so callers inject an `iconFor(unit,
// size)` function (mirrors battle-utils' enum-injection convention); the
// glyph fallback for portrait-less units lives here.

import { ENTITY_COLOR } from './entities.js';
import { ICON } from './icons.js';

export const WRAPUP_GLYPHS = Object.freeze({
  hero: '\uE000', witch: '\uE001', survivor: '\uE002', soldier: '\uE003',
  zombie: '\uE005', skeleton: '\uE00D', minion: '\uE004', wood_golem: '\uE006', iron_golem: '\uE007',
});

/**
 * Icon for a wrap-up unit: portrait <img> when the caller resolved a src,
 * coloured glyph badge otherwise.
 *
 * @param {object} u — { type, color? } unit (compileTurnBattlePairs shape).
 * @param {object} [opts] — { src, cls } portrait data-URL + CSS class.
 */
export function wrapupIconHtml(u, { src = null, cls = 'wrapup-unit-icon' } = {}) {
  const color = u.color || ENTITY_COLOR[u.type] || '#888';
  return src
    ? `<img class="${cls}" src="${src}" style="border-color:${color}" alt="">`
    : `<span class="${cls}" style="background:${color}">${WRAPUP_GLYPHS[u.type] ?? '?'}</span>`;
}

/**
 * One unit column: icon above its HP delta — "☠ DIED" on kill, "−N" when
 * hurt, dash when untouched.
 *
 * @param {object} u — { hpLost, killed } unit.
 * @param {string} iconHtml — pre-built icon (wrapupIconHtml / caller's own).
 */
export function wrapupUnitCellHtml(u, iconHtml) {
  const effect = u.killed
    ? `<div class="wrapup-dmg kill">\uE097 DIED</div>`
    : (u.hpLost > 0 ? `<div class="wrapup-dmg">−${u.hpLost}</div>` : `<div class="wrapup-dmg none">—</div>`);
  return `<div class="wrapup-unit">${iconHtml}${effect}</div>`;
}

/**
 * The Power Node reckoning sentence: who scored a victory point this round and
 * why, or the tied "no points" line. Pure — drives both the wrap-up card and
 * the resolution-summary modal so they word scoring identically.
 *
 * @param {object} reck — { heroDelta, witchDelta, heroCount, witchCount }
 *   deltas are this round's nodeScore change; counts are the live holdings.
 * @returns {string}
 */
export function reckoningText({ heroDelta, witchDelta, heroCount, witchCount }) {
  const nodes = (n) => `${n} Power Node${n !== 1 ? 's' : ''}`;
  if (witchDelta > 0) return `Witch holds ${nodes(witchCount)} to Hero's ${heroCount}. Witch scores 1 victory point.`;
  if (heroDelta > 0)  return `Hero holds ${nodes(heroCount)} to Witch's ${witchCount}. Hero scores 1 victory point.`;
  return `Nodes tied ${heroCount}–${witchCount}. No points scored.`;
}

/**
 * The reckoning block for the wrap-up card: a phase-titled callout that names
 * the point scored (or the tie). Pure HTML; '' when `reck` is null (a
 * non-scoring round). Phase drives the dawn/dusk label + icon.
 *
 * @param {object|null} reck — reckoningText() shape plus `phase` ('dawn'|'dusk'|…).
 * @returns {string}
 */
export function buildWrapupReckoningHtml(reck) {
  if (!reck) return '';
  const title = reck.phase === 'dawn'
    ? `${ICON.dawn} Dawn Reckoning`
    : reck.phase === 'dusk'
      ? `${ICON.dusk} Dusk Reckoning`
      : `${ICON.balance} Power Node Reckoning`;
  const scored = reck.heroDelta > 0 || reck.witchDelta > 0;
  const who = reck.witchDelta > 0 ? ' witch' : reck.heroDelta > 0 ? ' hero' : '';
  return `<div class="wrapup-reckoning${scored ? ' scored' : ''}${who}">`
    + `<div class="wrapup-reckoning-title">${title}</div>`
    + `<div class="wrapup-reckoning-result">${reckoningText(reck)}</div></div>`;
}

/**
 * The combat section of a wrap-up body. Up to 3 pairs render as
 * "[icon] vs [icon]" rows; more would be too tall, so they condense into a
 * single wrapping casualties row aggregating each hurt unit across all its
 * fights. Returns '' when there are no combats — the caller decides the
 * quiet-turn copy (the tester never shows one).
 *
 * @param {Array<{a: object, b: object}>} combats — compileTurnBattlePairs()
 *   shape: a/b = { id, type, title, color, hpLost, killed }.
 * @param {Function} iconFor — (unit, size) => icon HTML.
 * @returns {string}
 */
export function buildWrapupCombatsHtml(combats, iconFor) {
  if (!combats?.length) return '';
  const cell = (u) => wrapupUnitCellHtml(u, iconFor(u, 56));
  if (combats.length > 3) {
    const hurt = new Map();
    for (const { a, b, splash } of combats) {
      for (const u of [a, b, ...(splash ?? [])]) {
        if (!(u.hpLost > 0 || u.killed)) continue;
        const prev = hurt.get(u.id);
        if (prev) { prev.hpLost += u.hpLost; prev.killed = prev.killed || u.killed; }
        else hurt.set(u.id, { ...u });
      }
    }
    return hurt.size
      ? `<div class="wrapup-casualties">${[...hurt.values()].map(cell).join('')}</div>`
      : `<div class="wrapup-line muted">${combats.length} skirmishes — no casualties.</div>`;
  }
  let html = '';
  for (const { a, b, splash } of combats) {
    html += `<div class="wrapup-combat">${cell(a)}<span class="wrapup-vs">vs</span>${cell(b)}</div>`;
    // Splash victims (brute blast) — smaller cells on a labelled sub-row so
    // bystander damage is called out rather than silently absorbed.
    if (splash?.length) {
      const splashCells = splash.map(u => wrapupUnitCellHtml(u, iconFor(u, 36))).join('');
      html += `<div class="wrapup-splash"><span class="wrapup-splash-label">${ICON.splash} splash</span>${splashCells}</div>`;
    }
  }
  return html;
}
