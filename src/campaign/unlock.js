// ═══════════════════════════════════════════════════════════════════════════
// Campaign mission unlock criteria (docs/09 §5.5)
// ─────────────────────────────────────────────────────────────────────────────
// A mission may carry an `unlock` criterion — a small boolean expression over the
// player's campaign progress — that gates whether it becomes available, richer
// than the legacy `requires: string[]` (completed-mission list, which still works
// and is AND-ed with `unlock`). Pure + DOM-free so it's unit-testable and shared
// by the runtime (Campaign.getNextMission) and the Campaign Progression editor.
//
// Criterion grammar (a plain-data tree):
//   { missionDone: "id" }                  — that mission is completed
//   { hasItem: "itemId" }                  — item held (inventory or equipped weapon)
//   { level: N }                           — progression level ≥ N
//   { flag: "key" }                        — story flag is truthy
//   { flag: "key", equals: value }         — story flag === value
//   { resource: "silver", atLeast: N }     — resource count ≥ N (default 1)
//   { all: [criterion, …] }                — AND
//   { any: [criterion, …] }                — OR
//   { not: criterion }                     — NOT
//   [criterion, …]                         — array is AND sugar
//
// Evaluation reads a context (built by Campaign.buildUnlockContext) so the
// evaluator stays decoupled from campaign internals.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object|array|null} criterion
 * @param {object} ctx - { isCompleted(id), hasItem(id), level, getFlag(key), getResource(key) }
 * @returns {boolean} whether the criterion is satisfied (null/undefined ⇒ true — no gate).
 */
export function evaluateUnlock(criterion, ctx = {}) {
  if (criterion == null) return true;
  if (Array.isArray(criterion)) return criterion.every((c) => evaluateUnlock(c, ctx));
  if (typeof criterion !== 'object') return false;

  if (criterion.all) return criterion.all.every((c) => evaluateUnlock(c, ctx));
  if (criterion.any) return criterion.any.some((c) => evaluateUnlock(c, ctx));
  if (criterion.not !== undefined) return !evaluateUnlock(criterion.not, ctx);

  if ('missionDone' in criterion) return !!ctx.isCompleted?.(criterion.missionDone);
  if ('hasItem' in criterion) return !!ctx.hasItem?.(criterion.hasItem);
  if ('level' in criterion) return (ctx.level ?? 0) >= criterion.level;
  if ('flag' in criterion) {
    const v = ctx.getFlag?.(criterion.flag);
    return 'equals' in criterion ? v === criterion.equals : !!v;
  }
  if ('resource' in criterion) {
    return (ctx.getResource?.(criterion.resource) ?? 0) >= (criterion.atLeast ?? 1);
  }
  // Fail CLOSED on an unrecognised criterion so a typo never silently unlocks.
  console.warn('[unlock] unknown criterion', criterion);
  return false;
}

/** The set of mission ids referenced by `missionDone` leaves — used by the
 *  progression editor to draw prerequisite edges. */
export function unlockMissionRefs(criterion, acc = new Set()) {
  if (criterion == null) return acc;
  if (Array.isArray(criterion)) { for (const c of criterion) unlockMissionRefs(c, acc); return acc; }
  if (typeof criterion !== 'object') return acc;
  if (criterion.all) for (const c of criterion.all) unlockMissionRefs(c, acc);
  if (criterion.any) for (const c of criterion.any) unlockMissionRefs(c, acc);
  if (criterion.not !== undefined) unlockMissionRefs(criterion.not, acc);
  if ('missionDone' in criterion) acc.add(criterion.missionDone);
  return acc;
}

const VALID_LEAVES = ['missionDone', 'hasItem', 'level', 'flag', 'resource'];

/**
 * Validate an unlock criterion's shape. Throws Error with a clear message on the
 * first problem; returns the criterion on success. Used by the mission loader.
 */
export function validateUnlock(criterion, path = 'unlock') {
  if (criterion == null) return criterion;
  if (Array.isArray(criterion)) { criterion.forEach((c, i) => validateUnlock(c, `${path}[${i}]`)); return criterion; }
  if (typeof criterion !== 'object') throw new Error(`${path}: criterion must be an object/array`);

  let combinators = 0;
  if (criterion.all) { if (!Array.isArray(criterion.all)) throw new Error(`${path}.all must be an array`); criterion.all.forEach((c, i) => validateUnlock(c, `${path}.all[${i}]`)); combinators++; }
  if (criterion.any) { if (!Array.isArray(criterion.any)) throw new Error(`${path}.any must be an array`); criterion.any.forEach((c, i) => validateUnlock(c, `${path}.any[${i}]`)); combinators++; }
  if (criterion.not !== undefined) { validateUnlock(criterion.not, `${path}.not`); combinators++; }

  const leaves = VALID_LEAVES.filter((k) => k in criterion);
  if (combinators === 0 && leaves.length === 0) {
    throw new Error(`${path}: criterion has no known key (${VALID_LEAVES.join(', ')}, all, any, not)`);
  }
  if ('level' in criterion && !(Number.isFinite(criterion.level))) throw new Error(`${path}.level must be a number`);
  if ('resource' in criterion && typeof criterion.resource !== 'string') throw new Error(`${path}.resource must be a string`);
  return criterion;
}
