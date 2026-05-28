// URL-param helpers for the unified admin-tools page.
//
// `?tool=<assets|lighting|editor>` selects the active tab; `?mission=<id>`
// (bundled mission) and `?wip=<id>` (in-progress draft) drive the Mission
// Editor's initial load. All helpers are pure so they're unit-testable without
// a real `location`/`history`.

export const KNOWN_TOOLS = Object.freeze(['assets', 'lighting', 'editor']);

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
