// ═══════════════════════════════════════════════════════════════════════════
// Campaign unlock-criterion builder — pure rows ↔ criterion (no JSON)
// ─────────────────────────────────────────────────────────────────────────────
// Backs the Campaign Progression view's unlock editor: a flat AND/OR list of leaf
// criteria instead of a raw-JSON textarea. `criterionToRows` parses an existing
// `unlock` (docs/09 §5.5) into editable rows; `rowsToCriterion` rebuilds it.
// Nested all/any/not sub-trees (rare) are preserved verbatim as an "advanced" row
// so editing flat criteria never drops authored data. Pure + unit-tested.
// ═══════════════════════════════════════════════════════════════════════════

export const LEAF_TYPES = [
  { value: 'missionDone', label: 'Mission completed' },
  { value: 'hasItem', label: 'Has item' },
  { value: 'level', label: 'Level ≥' },
  { value: 'flag', label: 'Story flag' },
  { value: 'resource', label: 'Resource ≥' },
];

const LEAF_KEYS = LEAF_TYPES.map((l) => l.value);

/** Parse an `unlock` criterion into { combinator, rows }. */
export function criterionToRows(unlock) {
  if (unlock == null) return { combinator: 'all', rows: [] };
  if (Array.isArray(unlock)) return { combinator: 'all', rows: unlock.flatMap(leafToRows) };
  if (unlock.all) return { combinator: 'all', rows: unlock.all.flatMap(leafToRows) };
  if (unlock.any) return { combinator: 'any', rows: unlock.any.flatMap(leafToRows) };
  return { combinator: 'all', rows: leafToRows(unlock) };
}

function leafToRows(c) {
  if (c == null || typeof c !== 'object') return [];
  // Nested combinators (all/any/not) and the anyOf threshold form don't fit the
  // flat leaf-row model — keep them verbatim as an "advanced" row so editing the
  // flat criteria never drops authored data.
  if (c.all || c.any || c.not !== undefined || c.anyOf) return [{ type: '__advanced', raw: c }];
  for (const k of LEAF_KEYS) {
    if (k in c) {
      const row = { type: k, value: c[k] };
      if (k === 'flag' && 'equals' in c) row.equals = c.equals;
      if (k === 'resource') row.atLeast = c.atLeast ?? 1;
      return [row];
    }
  }
  return [];
}

/** Rebuild an `unlock` criterion from editor rows. Returns null when empty. */
export function rowsToCriterion(combinator, rows) {
  const parts = [];
  for (const r of rows) {
    if (r.type === '__advanced') { parts.push(r.raw); continue; }
    const leaf = rowToLeaf(r);
    if (leaf) parts.push(leaf);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return combinator === 'any' ? { any: parts } : { all: parts };
}

function rowToLeaf(r) {
  const v = r.value;
  if (v == null || v === '') return null;
  switch (r.type) {
    case 'level': return { level: Number(v) };
    case 'resource': return { resource: String(v), atLeast: r.atLeast != null ? Number(r.atLeast) : 1 };
    case 'flag': return (r.equals !== undefined && r.equals !== '') ? { flag: String(v), equals: r.equals } : { flag: String(v) };
    case 'missionDone': return { missionDone: String(v) };
    case 'hasItem': return { hasItem: String(v) };
    default: return null;
  }
}

/** A blank row for a given leaf type (defaults). */
export function blankRow(type = 'missionDone') {
  const row = { type, value: '' };
  if (type === 'resource') row.atLeast = 1;
  return row;
}
