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
