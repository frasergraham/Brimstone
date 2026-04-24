// ABILITIES registry — single source of truth for the 8 survivor
// abilities.
//
// Registry entries carry:
//   - metadata: id / kind / label / description
//   - passive effects: statMods (composed at call time by Entity getters)
//   - active effects: validate(state, actor) / execute(state, actor)
//
// HERBALIST, FORTIFY_DOUBLE, SCOUT remain passive-but-hook-less for now:
// their effects live at the call sites (executeExplore, executeFortify,
// sightRange) and are gated by entity.hasAbility(id). A generic
// passive-hook dispatcher is deferred until a fourth hook makes the
// abstraction pay for itself.
//
// Faction-innate abilities (sound_horn, summon) land in Phase 5.
//
// See docs/design/units-items-abilities-refactor.md.
//
// Note: this module has no imports beyond stdlib. The validate/execute
// helpers rely on `entity.hasTag('leader')` to identify the actor's
// leader rather than importing factions.js, which would create a cycle
// (factions.js → entities.js → abilities.js).

// Shared helper — find an alive leader on the actor's hex that belongs
// to the same player (or the same faction, for legacy singleplayer plans
// that predate per-player ownership).
function _coLocatedLeader(state, actor) {
  return state.entities.find(e =>
    e.alive && e.hasTag('leader') &&
    e.col === actor.col && e.row === actor.row &&
    (e.ownerId === actor.ownerId || e.owner === actor.owner)
  );
}

export const ABILITIES = Object.freeze({
  fortify_double: {
    id: 'fortify_double',
    kind: 'passive',
    label: 'Fortify Double',
    description: 'Wood fortifies to full strength (level 2)',
  },
  heal: {
    id: 'heal',
    kind: 'active',
    label: 'Heal',
    description: 'Action (1): heals hero on same hex 1 HP',
    validate(state, actor) {
      const leader = _coLocatedLeader(state, actor);
      return !!leader && leader.hp < leader.maxHp;
    },
    execute(state, actor) {
      const leader = _coLocatedLeader(state, actor);
      if (!leader)
        return { success: false, log: ['A leader must be on the same hex.'] };
      if (leader.hp >= leader.maxHp)
        return { success: false, log: ['Leader is already at full health.'] };
      leader.heal(1);
      return {
        success: true,
        log: [`${actor.displayName} tends ${leader.displayName}'s wounds. (+1 HP, now ${leader.hp}/${leader.maxHp})`],
        cost: 1,
      };
    },
  },
  brawler: {
    id: 'brawler',
    kind: 'passive',
    label: 'Brawler',
    description: '+1 ATK',
    statMods: { attack: 1 },
  },
  sturdy: {
    id: 'sturdy',
    kind: 'passive',
    label: 'Sturdy',
    description: '+1 DEF',
    statMods: { defense: 1 },
  },
  herbalist: {
    id: 'herbalist',
    kind: 'passive',
    label: 'Herbalist',
    description: 'Each exploration also yields 1 Herbs',
  },
  inspire: {
    id: 'inspire',
    kind: 'active',
    label: 'Inspire',
    description: 'Action (free): hero gets +1 ATK next battle',
    validate(state, actor) {
      return !!_coLocatedLeader(state, actor);
    },
    execute(state, actor) {
      const leader = _coLocatedLeader(state, actor);
      if (!leader)
        return { success: false, log: ['A leader must be on the same hex.'] };
      leader.attackBonus += 1;
      return {
        success: true,
        log: [`${actor.displayName} rallies ${leader.displayName}! (+1 ATK this battle)`],
        cost: 0,
      };
    },
  },
  rally: {
    id: 'rally',
    kind: 'active',
    label: 'Rally',
    description: 'Action (free): hero gets 1 bonus action',
    validate() { return true; },
    execute(state, actor) {
      // Return budgetBonus so both offline and multiplayer resolvers can
      // apply it per-player without touching shared state.actionsLeft.
      const rallyLeader = state.entities.find(e =>
        e.alive && e.hasTag('leader') &&
        (e.ownerId === actor.ownerId || e.owner === actor.owner)
      );
      return {
        success: true,
        log: [`${actor.displayName}'s words fortify ${rallyLeader?.displayName ?? 'the leader'}'s spirit! (+1 action)`],
        cost: 0,
        budgetBonus: 1,
      };
    },
  },
  scout: {
    id: 'scout',
    kind: 'passive',
    label: 'Scout',
    description: 'Reveals night-side units within 3 hexes',
  },
  berserker: {
    id: 'berserker',
    kind: 'passive',
    label: 'Berserker',
    description: 'Enters frenzy after the second kill in a round',
    // After a kill is registered (killsThisRound incremented), if the unit has
    // killed >= 2 times this round, they gain Frenzied (+1 ATK / -1 DEF) for
    // 1 round. Effect is dispatched by src/effects.js → dispatchTrigger('kill').
    triggers: [
      { on: 'kill', condition: 'killsThisRound>=2', apply: 'frenzied' },
    ],
  },
  eagle_eye: {
    id: 'eagle_eye',
    kind: 'passive',
    label: 'Eagle Eye',
    description: '+1 attack range',
    // Range bonus is composed via Entity.getRange(). Implemented as a
    // statMods-style hook so adding range mods via abilities is uniform
    // with weapons/effects.
    statMods: { range: 1 },
  },

  // ── Faction-innate leader abilities (Phase 5) ────────────────────────
  // Pushed onto leaders by `Faction.createLeader()` via
  // `innateLeaderAbilities`; the action-availability gates in
  // src/actions.js check `actor.hasAbility(id)` instead of the legacy
  // `isLeaderType + owner` pair. Execute bodies still live in
  // src/actions.js (`executeSoundHorn`, `executeSummon`) — a full
  // registry-delegated dispatch is deferred to a follow-up PR because
  // the executor bodies depend on getFaction / createMinion / the
  // _triggerSurvivorEncounter helper, which would create cross-module
  // cycles if inlined here.
  sound_horn: {
    id: 'sound_horn',
    kind: 'active',
    label: 'Sound Horn',
    description: 'Action (1 food): reveal your leader and discover survivors within 4 hexes',
  },
  summon: {
    id: 'summon',
    kind: 'active',
    label: 'Summon',
    description: 'Action: spend 2 resources to summon a Minion, Wood Golem, or Iron Golem',
  },
});

// Derived enum for backwards compatibility with the `SurvivorAbility`
// name used throughout src/ and tests/. New code should reference
// ABILITIES[id] directly.
export const SurvivorAbility = Object.freeze(
  Object.fromEntries(
    Object.values(ABILITIES).map(a => [a.id.toUpperCase(), a.id])
  )
);

export function getAbility(id) {
  return ABILITIES[id];
}
