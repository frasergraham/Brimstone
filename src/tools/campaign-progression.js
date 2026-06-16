// ═══════════════════════════════════════════════════════════════════════════
// Campaign Progression — editor model (pure, DOM-free)
// ─────────────────────────────────────────────────────────────────────────────
// Builds the mission-dependency DAG from a campaign's missions (docs/09 §5.5):
// nodes are missions, edges are prerequisites drawn from BOTH the legacy
// `requires` list and the `missionDone` leaves of the rich `unlock` criterion.
// Pure + unit-testable; the SVG view (campaign-progression-view.js) renders it.
// ═══════════════════════════════════════════════════════════════════════════

import { unlockMissionRefs } from '../campaign/unlock.js';

/**
 * @param {object[]} missions - [{ id, title?, chapter?, requires?, unlock?, rewards? }]
 * @returns {{ nodes: object[], edges: {from,to}[] }}
 */
export function buildProgressionModel(missions) {
  const byId = new Map(missions.map((m) => [m.id, m]));
  const nodes = missions.map((m) => ({
    id: m.id,
    title: m.title ?? m.id,
    chapter: m.chapter ?? 0,
    requires: [...(m.requires ?? [])],
    unlock: m.unlock ?? null,
    rewards: m.rewards ?? {},
    x: 0, y: 0,
  }));

  const edges = [];
  const seen = new Set();
  for (const m of missions) {
    const refs = new Set([...(m.requires ?? []), ...unlockMissionRefs(m.unlock ?? null)]);
    for (const r of refs) {
      const key = `${r}->${m.id}`;
      if (byId.has(r) && !seen.has(key)) { edges.push({ from: r, to: m.id }); seen.add(key); }
    }
  }
  layoutProgression(nodes, edges);
  return { nodes, edges };
}

/** Layered left→right layout: a node's column is the longest prerequisite chain
 *  feeding it (roots in column 0); rows stack within a column. Mutates x/y. */
export function layoutProgression(nodes, edges, { colGap = 230, rowGap = 96, x0 = 30, y0 = 30 } = {}) {
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length + 1; pass++) {
    let changed = false;
    for (const e of edges) {
      const want = (depth.get(e.from) ?? 0) + 1;
      if (want > (depth.get(e.to) ?? 0)) { depth.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }
  const rowByCol = new Map();
  const ordered = [...nodes].sort((a, b) =>
    (depth.get(a.id) - depth.get(b.id)) || (a.chapter - b.chapter) || a.id.localeCompare(b.id));
  for (const n of ordered) {
    const c = depth.get(n.id);
    const r = rowByCol.get(c) ?? 0;
    rowByCol.set(c, r + 1);
    n.x = x0 + c * colGap;
    n.y = y0 + r * rowGap;
    n.col = c;
  }
  return nodes;
}

/** A short human summary of a node's gate, for the card. */
export function gateSummary(node) {
  const parts = [];
  if (node.requires?.length) parts.push(`needs ${node.requires.join(', ')}`);
  if (node.unlock) parts.push(unlockSummary(node.unlock));
  return parts.join(' · ') || 'available from start';
}

function unlockSummary(c) {
  if (c == null) return '';
  if (Array.isArray(c)) return c.map(unlockSummary).join(' AND ');
  if (c.all) return '(' + c.all.map(unlockSummary).join(' AND ') + ')';
  if (c.any) return '(' + c.any.map(unlockSummary).join(' OR ') + ')';
  if (c.not !== undefined) return 'NOT ' + unlockSummary(c.not);
  if (c.anyOf) {
    const { count = 1, of = [] } = c.anyOf;
    const items = of.map((e) => (typeof e === 'string' ? `done:${e}` : unlockSummary(e)));
    return `any ${count} of (${items.join(', ')})`;
  }
  if ('missionDone' in c) return `done:${c.missionDone}`;
  if ('hasItem' in c) return `item:${c.hasItem}`;
  if ('level' in c) return `lvl≥${c.level}`;
  if ('flag' in c) return 'equals' in c ? `flag:${c.flag}=${c.equals}` : `flag:${c.flag}`;
  if ('resource' in c) return `${c.resource}≥${c.atLeast ?? 1}`;
  return '?';
}

/** A short reward summary for the card. */
export function rewardSummary(rewards) {
  const r = rewards ?? {};
  const parts = Object.entries(r)
    .filter(([, v]) => v != null && v !== 0 && !(typeof v === 'object' && Object.keys(v).length === 0))
    .map(([k, v]) => (typeof v === 'object' ? k : `${k}:${v}`));
  return parts.length ? parts.join(', ') : 'none';
}

/** Add a prerequisite mission to a node's legacy `requires` (kept idempotent). */
export function addPrereq(node, prereqId) {
  if (!node.requires.includes(prereqId)) node.requires.push(prereqId);
  return node;
}

/** Remove a prerequisite from a node's `requires`. */
export function removePrereq(node, prereqId) {
  node.requires = node.requires.filter((r) => r !== prereqId);
  return node;
}

/** The fields the editor writes back into a mission JSON on save. `requires` and
 *  `unlock` are emitted only when non-empty so missions stay clean. */
export function nodeToMissionPatch(node) {
  const patch = { rewards: node.rewards ?? {} };
  if (node.requires?.length) patch.requires = node.requires; else patch.requires = undefined;
  patch.unlock = node.unlock ?? undefined;
  return patch;
}
