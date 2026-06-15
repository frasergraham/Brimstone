// ═══════════════════════════════════════════════════════════════════════════
// Mission Logic Graph — WorldContext adapter
// ─────────────────────────────────────────────────────────────────────────────
// The engine (engine.js) is decoupled from GameState: it talks to the world ONLY
// through a WorldContext. This keeps the engine pure + unit-testable and lets the
// SAME engine run against the real GameState (offline + server) or an in-memory
// stub (tests). The real GameState-backed context is a later phase — it routes
// every mutation through actions.js so online/offline parity holds.
//
// WorldContext contract (all reads are deterministic; all mutations go through
// the authority's game-logic functions in the real impl):
//
//   getState()                  → authoritative snapshot (round, phase, kills, …)
//   getEntity(id)               → entity | undefined
//   entitiesAt(col, row)        → entity[]
//   getHero()                   → the hero leader entity | undefined
//   spawnUnit(spec)             → entity  (SIM — resolves spawnAt, applies level)
//   despawnUnit(id)             → void    (SIM)
//   setOutcome(winner, reason)  → void    (SIM — declares win/lose)
//   setFlag(key, value)         → void    (campaign/mission flag write)
//   getFlag(key)                → value
//   evaluateObjective(spec)     → bool    (delegates to existing victory logic)
//   random()                    → number in [0,1) from the SEEDED game RNG
//   emit(presentationEvent)     → void    (the only presentation sink)
//
// `emit` events are the "turn action data" the render/UI layer interprets — the
// system stays decoupled: logic emits intent, presentation decides how to show it.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * An in-memory WorldContext for tests (and a reference implementation of the
 * contract). Records every mutation and emitted event so assertions can inspect
 * them. NOT for production — the real context wraps GameState.
 *
 * @param {object} [seed]
 * @param {object} [seed.state]      - snapshot returned by getState()
 * @param {object[]} [seed.entities] - initial entities ({ id, faction|owner, type, col, row, … })
 * @param {object} [seed.flags]      - initial flags
 * @param {(spec:object)=>boolean} [seed.objectives] - evaluateObjective impl
 * @param {()=>number} [seed.rng]    - deterministic RNG (defaults to a fixed LCG)
 */
export function makeTestContext(seed = {}) {
  const state = { round: 1, phase: 'dawn', heroKills: 0, witchKills: 0, ...(seed.state ?? {}) };
  const entities = new Map((seed.entities ?? []).map((e) => [e.id, e]));
  const flags = { ...(seed.flags ?? {}) };
  const emitted = [];
  const mutations = [];
  let spawnSeq = 0;
  let rngState = 0x2545f4;
  const defaultRng = () => { // deterministic LCG — no Math.random
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };
  const rng = seed.rng ?? defaultRng;

  const ctx = {
    // reads
    getState: () => state,
    getEntity: (id) => entities.get(id),
    entitiesAt: (col, row) => [...entities.values()].filter((e) => e.col === col && e.row === row),
    // Test entities flag the hero leader with `isHeroLeader` (the production
    // context uses GameState.hero) — avoids a faction string-literal in the stub.
    getHero: () => [...entities.values()].find((e) => e.isHeroLeader),
    getFlag: (key) => flags[key],
    random: () => rng(),

    // sim mutations
    spawnUnit: (spec) => {
      const at = typeof spec.spawnAt === 'object' ? spec.spawnAt : { col: -1, row: -1 };
      const ent = {
        id: spec.id ?? `spawn:${spec.type}:${spawnSeq++}`,
        type: spec.type,
        faction: spec.faction ?? 'witch',
        col: at.col, row: at.row,
        ...(spec.overrides ?? {}),
      };
      entities.set(ent.id, ent);
      mutations.push({ op: 'spawn', spec, entity: ent });
      return ent;
    },
    despawnUnit: (id) => { entities.delete(id); mutations.push({ op: 'despawn', id }); },
    setOutcome: (winner, reason) => {
      state.winner = winner; state.winReason = reason;
      mutations.push({ op: 'outcome', winner, reason });
    },
    setFlag: (key, value) => { flags[key] = value; mutations.push({ op: 'flag', key, value }); },
    evaluateObjective: (spec, side = 'win') => (seed.objectives ? !!seed.objectives(spec, side) : false),

    // presentation sink
    emit: (event) => { emitted.push(event); },

    // test introspection (not part of the production contract)
    _emitted: emitted,
    _mutations: mutations,
    _entities: entities,
    _flags: flags,
  };
  return ctx;
}
