// URL-param helpers for the unified admin-tools page.
//
// `?tool=<assets|lighting|editor>` selects the active tab; `?mission=<id>`
// (bundled mission) and `?wip=<id>` (in-progress draft) drive the Mission
// Editor's initial load. All helpers are pure so they're unit-testable without
// a real `location`/`history`.

export const KNOWN_TOOLS = Object.freeze(['assets', 'lighting', 'editor', 'combat']);

/**
 * Parse the admin-tools query string. Unknown `tool` values resolve to null
 * (caller falls back to its default), so a stale URL never activates a tab
 * that doesn't exist.
 *
 * @param {string} [search] - typically `location.search`. Leading "?" optional.
 * @returns {{ tool: string|null, mission: string|null, wip: string|null }}
 */
export function parseToolParams(search = '') {
  const params = new URLSearchParams(stripLeadingQ(search));
  const rawTool = params.get('tool');
  const tool = rawTool && KNOWN_TOOLS.includes(rawTool) ? rawTool : null;
  return {
    tool,
    mission: params.get('mission') || null,
    wip: params.get('wip') || null,
  };
}

/**
 * Apply a partial patch to the search string, preserving unrelated params.
 *
 *   • `value` is a string  → set the param to that value
 *   • `value` is null      → DELETE the param
 *   • key omitted from patch → keep the existing value untouched
 *
 * Returns a leading-"?" search string (or "" when empty) suitable for
 * `history.replaceState(null, '', url)`.
 */
export function withToolParams(search, patch = {}) {
  const params = new URLSearchParams(stripLeadingQ(search));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      params.delete(key);
    } else if (value === undefined) {
      // omit / untouched
    } else {
      params.set(key, String(value));
    }
  }
  const out = params.toString();
  return out ? `?${out}` : '';
}

function stripLeadingQ(s) {
  if (typeof s !== 'string') return '';
  return s.startsWith('?') ? s.slice(1) : s;
}

// ── Combat-tester URL params ────────────────────────────────────────────
// Encoded shape: ?atk=<key>&def=<key>&atkAllies=<csv>&defAllies=<csv>
// Unit keys are stable strings from src/unit-types.js (e.g. "paladin",
// "wood_golem"). These coexist with ?tool=combat; both helpers preserve
// every unrelated query param (Nash's pattern — null deletes, undefined
// leaves untouched, value sets).

const COMBAT_ATK         = 'atk';
const COMBAT_DEF         = 'def';
const COMBAT_ATK_ALLIES  = 'atkAllies';
const COMBAT_DEF_ALLIES  = 'defAllies';

/**
 * Parse combat-tester query params.
 *
 * @param {string} [search] — typically `location.search`. Leading "?" optional.
 * @param {(key: string) => boolean} [isValidUnit] — optional predicate; when
 *        supplied, unit keys that fail the check are dropped (atk/def become
 *        null, ally lists drop the bad entries). Lets the UI feed in its
 *        UNIT_FACTORIES catalog so stale URLs don't push junk into the
 *        controller.
 * @returns {{atk: string|null, def: string|null, atkAllies: string[], defAllies: string[]}}
 */
export function parseCombatParams(search = '', isValidUnit = null) {
  const params = new URLSearchParams(stripLeadingQ(search));
  const ok = typeof isValidUnit === 'function' ? isValidUnit : null;
  const one = (key) => {
    const v = params.get(key);
    if (!v) return null;
    if (ok && !ok(v)) return null;
    return v;
  };
  const list = (key) => {
    const v = params.get(key);
    if (!v) return [];
    return v.split(',').map((s) => s.trim())
      .filter((s) => s && (ok ? ok(s) : true));
  };
  return {
    atk:       one(COMBAT_ATK),
    def:       one(COMBAT_DEF),
    atkAllies: list(COMBAT_ATK_ALLIES),
    defAllies: list(COMBAT_DEF_ALLIES),
  };
}

/**
 * Apply a partial combat-config patch to the search string.
 *
 * Patch keys: `atk`, `def`, `atkAllies`, `defAllies`. Same semantics as
 * `withToolParams`:
 *   • string                 → set the param
 *   • null                   → delete the param
 *   • undefined / key absent → leave untouched
 * Arrays: `[]` deletes the param (empty config produces no param), a
 * populated array is comma-joined.
 *
 * Returns a leading-"?" search string (or "" when empty).
 */
export function withCombatParams(search, patch = {}) {
  const params = new URLSearchParams(stripLeadingQ(search));
  const apply = (key, value) => {
    if (value === undefined) return;
    if (value === null) { params.delete(key); return; }
    if (Array.isArray(value)) {
      if (value.length === 0) params.delete(key);
      else params.set(key, value.join(','));
      return;
    }
    params.set(key, String(value));
  };
  apply(COMBAT_ATK,        patch.atk);
  apply(COMBAT_DEF,        patch.def);
  apply(COMBAT_ATK_ALLIES, patch.atkAllies);
  apply(COMBAT_DEF_ALLIES, patch.defAllies);
  // URLSearchParams escapes "," to %2C; comma is a legal query character and
  // the operator spec shows literal commas in the bookmark form, so undo it.
  const out = params.toString().replace(/%2C/g, ',');
  return out ? `?${out}` : '';
}
