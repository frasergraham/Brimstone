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
  zombie: '\uE005', minion: '\uE004', wood_golem: '\uE006', iron_golem: '\uE007',
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
