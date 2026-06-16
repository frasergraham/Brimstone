// Tests for the Faction class hierarchy and registry
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Faction, HeroFaction, WitchFaction, RogueFaction, CaptainFaction, NecromancerFaction, BruteFaction, getFaction, allFactions, getFactionsForSide, sideOf } from '../src/factions.js';
import { Side } from '../src/sides.js';
import { Phase, GameState } from '../src/game.js';
import { EntityType, SURVIVOR_ROSTER } from '../src/entities.js';
import { ResourceType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { triggerSurvivorEncounter } from '../src/survivor-discovery.js';

// ── Registry ────────────────────────────────────────────────────────────────

describe('Faction registry', () => {
  test('getFaction returns HeroFaction for "hero"', () => {
    const f = getFaction('hero');
    assert.ok(f instanceof HeroFaction);
    assert.equal(f.id, 'hero');
  });

  test('getFaction returns WitchFaction for "witch"', () => {
    const f = getFaction('witch');
    assert.ok(f instanceof WitchFaction);
    assert.equal(f.id, 'witch');
  });

  test('getFaction throws for unknown faction', () => {
    assert.throws(() => getFaction('goblin'), /Unknown faction/);
  });

  test('allFactions returns the six registered factions (hero/rogue/captain + witch/necromancer/brute)', () => {
    const all = allFactions();
    assert.equal(all.length, 6);
    for (const id of ['hero', 'rogue', 'captain', 'witch', 'necromancer', 'brute']) {
      assert.ok(all.some(f => f.id === id), `allFactions should include ${id}`);
    }
  });

  test('getFaction returns singletons', () => {
    assert.equal(getFaction('hero'), getFaction('hero'));
    assert.equal(getFaction('witch'), getFaction('witch'));
  });
});

// ── Identity ────────────────────────────────────────────────────────────────

describe('Faction identity', () => {
  test('HeroFaction identity', () => {
    const h = getFaction('hero');
    assert.equal(h.name, 'Hero');
    assert.equal(h.leaderType, EntityType.HERO);
  });

  test('WitchFaction identity', () => {
    const w = getFaction('witch');
    assert.equal(w.name, 'Witch');
    assert.equal(w.leaderType, EntityType.WITCH);
  });
});

// ── Side membership ────────────────────────────────────────────────────────

describe('Faction side membership', () => {
  test('HeroFaction belongs to the day side', () => {
    assert.equal(getFaction('hero').side, Side.DAY);
  });

  test('WitchFaction belongs to the night side', () => {
    assert.equal(getFaction('witch').side, Side.NIGHT);
  });

  test('getOpposingSide returns the other side', () => {
    assert.equal(getFaction('hero').getOpposingSide(),  Side.NIGHT);
    assert.equal(getFaction('witch').getOpposingSide(), Side.DAY);
  });

  test('getFactionsForSide groups factions by side', () => {
    const day   = getFactionsForSide('day');
    const night = getFactionsForSide('night');
    assert.ok(day.some(f => f.id === 'hero'),   'day side includes hero');
    assert.ok(night.some(f => f.id === 'witch'),'night side includes witch');
    // No cross-contamination.
    assert.equal(day.some(f => f.id === 'witch'),  false);
    assert.equal(night.some(f => f.id === 'hero'), false);
  });

  test('getFactionsForSide returns [] for unknown side', () => {
    assert.deepEqual(getFactionsForSide('twilight'), []);
  });

  test('sideOf maps faction id to side id', () => {
    assert.equal(sideOf('hero'),  Side.DAY);
    assert.equal(sideOf('witch'), Side.NIGHT);
  });

  test('sideOf returns null for unknown faction', () => {
    assert.equal(sideOf('goblin'), null);
    assert.equal(sideOf(null), null);
  });
});

// ── Stub factions ──────────────────────────────────────────────────────────

describe('Stub factions (PR 5)', () => {
  test('all four stub factions are registered with their side', () => {
    assert.equal(getFaction('rogue').side,       Side.DAY);
    assert.equal(getFaction('captain').side,     Side.DAY);
    assert.equal(getFaction('necromancer').side, Side.NIGHT);
    assert.equal(getFaction('brute').side,       Side.NIGHT);
  });

  test('stub factions report isStub() === true; side defaults do not', () => {
    // Rogue and Brute have grown real distinct behaviour (rogue: ranged
    // attack, melee-weapon ban, sight bonus, agility-loot bonus,
    // building-survivor auto-detect, no Sound Horn; brute: lumbering
    // movement, minions-only summons, building-survivor auto-zombify,
    // crushing-blow blast splash) — no longer stubs. The remaining
    // day/night stubs still inherit their parent's behaviour wholesale.
    assert.equal(getFaction('rogue').isStub(),       false);
    assert.equal(getFaction('captain').isStub(),     true);
    assert.equal(getFaction('necromancer').isStub(), true);
    assert.equal(getFaction('brute').isStub(),       false);
    assert.equal(getFaction('hero').isStub(),        false);
    assert.equal(getFaction('witch').isStub(),       false);
  });

  test('stub factions are subclasses of their side primary', () => {
    assert.ok(getFaction('rogue')       instanceof HeroFaction);
    assert.ok(getFaction('captain')     instanceof HeroFaction);
    assert.ok(getFaction('necromancer') instanceof WitchFaction);
    assert.ok(getFaction('brute')       instanceof WitchFaction);
  });

  test('stub createLeader returns an entity with the stub-specific type and stats', () => {
    const r = getFaction('rogue').createLeader(0, 0, 'p1');
    assert.equal(r.type,    'rogue');
    assert.equal(r.maxHp,   70);
    assert.equal(r.attack,  3);
    assert.equal(r.defense, 1);
    assert.equal(r.agility, 8);
    // Day-side membership: owner string stays 'hero' for compat with
    // existing `e.owner === 'hero'` checks across the codebase.
    assert.equal(r.owner,     'hero');
    assert.equal(r.factionId, 'rogue');
  });

  test('stub day factions belong to the day side ordering', () => {
    const day = getFactionsForSide('day').map(f => f.id);
    assert.deepEqual(day, ['hero', 'rogue', 'captain']);
  });

  test('stub night factions belong to the night side ordering', () => {
    const night = getFactionsForSide('night').map(f => f.id);
    assert.deepEqual(night, ['witch', 'necromancer', 'brute']);
  });
});

// ── Faction inventory routes through side accessor ─────────────────────────

describe('Faction.getInventory routes through state.inventoryForSide', () => {
  test('reads inventory for the faction\'s side', () => {
    const dayInv   = { food: 2 };
    const nightInv = { wood: 2, metal: 2 };
    const state = {
      inventoryForSide(sideId) {
        if (sideId === 'day')   return dayInv;
        if (sideId === 'night') return nightInv;
        return null;
      },
    };
    assert.equal(getFaction('hero').getInventory(state),  dayInv);
    assert.equal(getFaction('witch').getInventory(state), nightInv);
  });
});

// ── Action Budget ───────────────────────────────────────────────────────────

describe('Action budget', () => {
  test('Hero base budget is 3', () => {
    assert.equal(getFaction('hero').baseBudget, 3);
  });

  test('Witch base budget is 3', () => {
    assert.equal(getFaction('witch').baseBudget, 3);
  });

  test('Hero action cap is 8', () => {
    assert.equal(getFaction('hero').actionCap, 8);
  });

  test('Witch action cap is 8', () => {
    assert.equal(getFaction('witch').actionCap, 8);
  });

  test('Hero unit bonus cap is 5', () => {
    assert.equal(getFaction('hero').unitBonusCap, 5);
  });

  test('Witch unit bonus cap is 4', () => {
    assert.equal(getFaction('witch').unitBonusCap, 4);
  });

  test('Hero favorable phases are DAY and DAWN', () => {
    const h = getFaction('hero');
    assert.equal(h.isFavorablePhase(Phase.DAY), true);
    assert.equal(h.isFavorablePhase(Phase.DAWN), true);
    assert.equal(h.isFavorablePhase(Phase.DUSK), false);
    assert.equal(h.isFavorablePhase(Phase.NIGHT), false);
  });

  test('Witch favorable phase is NIGHT', () => {
    const w = getFaction('witch');
    assert.equal(w.isFavorablePhase(Phase.NIGHT), true);
    assert.equal(w.isFavorablePhase(Phase.DAY), false);
    assert.equal(w.isFavorablePhase(Phase.DAWN), false);
    assert.equal(w.isFavorablePhase(Phase.DUSK), false);
  });

  test('Hero budget: base + time bonus in DAY with 3 survivors and 1 node', () => {
    // 3 + 1 (DAY) + 3 (survivors, cap 5) + 1 (node) = 8
    assert.equal(getFaction('hero').computeBudget(Phase.DAY, 3, 1), 8);
  });

  test('Hero budget: capped at 8', () => {
    // 3 + 1 (DAY) + 5 (cap) + 3 (nodes) = 12 → capped to 8
    assert.equal(getFaction('hero').computeBudget(Phase.DAY, 10, 3), 8);
  });

  test('Hero budget: no time bonus at NIGHT', () => {
    // 3 + 0 + 0 + 0 = 3
    assert.equal(getFaction('hero').computeBudget(Phase.NIGHT, 0, 0), 3);
  });

  test('Witch budget: base + time bonus at NIGHT with 2 units', () => {
    // 3 + 1 (NIGHT) + 2 (units) + 0 = 6
    assert.equal(getFaction('witch').computeBudget(Phase.NIGHT, 2, 0), 6);
  });

  test('Witch budget: capped at 8', () => {
    // 3 + 1 + 3 (cap) + 3 = 10 → capped to 8
    assert.equal(getFaction('witch').computeBudget(Phase.NIGHT, 5, 3), 8);
  });

  test('Witch budget: no time bonus in DAY', () => {
    // 3 + 0 + 0 + 0 = 3
    assert.equal(getFaction('witch').computeBudget(Phase.DAY, 0, 0), 3);
  });
});

// ── Available Actions ───────────────────────────────────────────────────────

describe('Available actions', () => {
  test('Hero can fortify, cannot summon', () => {
    const h = getFaction('hero');
    assert.equal(h.canFortify(), true);
    assert.equal(h.canSummon(), false);
  });

  test('Witch can summon, cannot fortify', () => {
    const w = getFaction('witch');
    assert.equal(w.canFortify(), false);
    assert.equal(w.canSummon(), true);
  });

  test('Hero can use items', () => {
    assert.equal(getFaction('hero').canUseItems(), true);
  });

  test('Witch cannot use hero items', () => {
    assert.equal(getFaction('witch').canUseItems(), false);
  });

  test('Witch summon options with sufficient resources', () => {
    const inv = { [ResourceType.METAL]: 2, [ResourceType.WOOD]: 1 };
    const opts = getFaction('witch').getSummonOptions(inv);
    assert.equal(opts.length, 3);
    assert.equal(opts[0].summonType, EntityType.IRON_GOLEM);
    assert.equal(opts[0].affordable, true);
    assert.equal(opts[1].summonType, EntityType.WOOD_GOLEM);
    assert.equal(opts[1].affordable, false); // only 1 wood
    assert.equal(opts[2].summonType, EntityType.MINION);
    assert.equal(opts[2].affordable, true);
  });

  test('Witch summon options empty with insufficient resources', () => {
    const inv = { [ResourceType.METAL]: 1 };
    assert.deepEqual(getFaction('witch').getSummonOptions(inv), []);
  });

  test('Hero summon options always empty', () => {
    assert.deepEqual(getFaction('hero').getSummonOptions({}), []);
  });
});

// ── Combat Modifiers ────────────────────────────────────────────────────────

describe('Combat modifiers', () => {
  test('Witch gets +2 combat bonus at NIGHT', () => {
    assert.equal(getFaction('witch').getPhaseCombatBonus(Phase.NIGHT), 2);
  });

  test('Witch gets no combat bonus in DAY', () => {
    assert.equal(getFaction('witch').getPhaseCombatBonus(Phase.DAY), 0);
  });

  test('Hero gets no phase combat bonus in any phase', () => {
    for (const phase of Object.values(Phase)) {
      assert.equal(getFaction('hero').getPhaseCombatBonus(phase), 0);
    }
  });

  test('Hero defense fatigue: floor(count/2)', () => {
    const h = getFaction('hero');
    assert.equal(h.getDefenseFatigue(0), 0);
    assert.equal(h.getDefenseFatigue(1), 0);
    assert.equal(h.getDefenseFatigue(2), 1);
    assert.equal(h.getDefenseFatigue(3), 1);
    assert.equal(h.getDefenseFatigue(4), 2);
  });

  test('Witch has no defense fatigue', () => {
    assert.equal(getFaction('witch').getDefenseFatigue(4), 0);
  });
});

// ── Discovery & Loot ────────────────────────────────────────────────────────

describe('Discovery & loot', () => {
  test('Hero discovery creates a survivor with owner=hero', () => {
    const entity = getFaction('hero').createDiscoveryEntity(3, 4, 'player1');
    assert.equal(entity.owner, 'hero');
    assert.equal(entity.type, EntityType.SURVIVOR);
    assert.equal(entity.col, 3);
    assert.equal(entity.row, 4);
    assert.equal(entity.ownerId, 'player1');
  });

  test('Hero discovery honours a forced survivor id (authored mission tile)', () => {
    const target = SURVIVOR_ROSTER[3].name;
    const entity = getFaction('hero').createDiscoveryEntity(3, 4, 'player1', null, target);
    assert.equal(entity.name, target);
    assert.equal(entity.owner, 'hero');
    assert.equal(entity.type, EntityType.SURVIVOR);
  });

  test('Hero discovery falls back to random when forced id is null', () => {
    const entity = getFaction('hero').createDiscoveryEntity(3, 4, 'player1', null, null);
    assert.ok(SURVIVOR_ROSTER.some(r => r.name === entity.name));
  });

  test('Hero discovery result includes survivor data', () => {
    const entity = getFaction('hero').createDiscoveryEntity(0, 0, null);
    const result = getFaction('hero').buildDiscoveryResult(entity);
    assert.equal(result.encounterLog.length, 1);
    assert.ok(result.encounterLog[0].includes('joins the party'));
    assert.equal(result.encounterSurvivor.type, 'survivor');
  });

  test('Witch discovery creates a zombie', () => {
    const entity = getFaction('witch').createDiscoveryEntity(5, 6, 'witch1');
    assert.equal(entity.owner, 'witch');
    assert.equal(entity.type, EntityType.ZOMBIE);
  });

  test('Witch discovery result includes zombie data', () => {
    const entity = getFaction('witch').createDiscoveryEntity(0, 0, null);
    const result = getFaction('witch').buildDiscoveryResult(entity);
    assert.ok(result.encounterLog[0].includes('zombie'));
    assert.equal(result.encounterSurvivor.type, 'zombie');
  });

  test('end-to-end: authored hiddenSurvivorId spawns THAT survivor on discovery', () => {
    const state = new GameState(true, true);
    const hero = state.entities.find(e => e.type === EntityType.HERO);
    assert.ok(hero, 'expected a hero entity');

    // Author a specific survivor on the hero's own tile.
    const target = SURVIVOR_ROSTER[5].name;
    const tile = state.tiles.get(hexKey(hero.col, hero.row));
    tile.hiddenSurvivor = true;
    tile.hiddenSurvivorId = target;

    const result = triggerSurvivorEncounter(state, hero, hero.col, hero.row);
    assert.ok(result, 'expected an encounter');
    const spawned = state.entities.find(e => e.type === EntityType.SURVIVOR && e.name === target);
    assert.ok(spawned, `expected spawned survivor named ${target}`);
    // Tile flags cleared after discovery.
    assert.equal(tile.hiddenSurvivor, false);
    assert.equal(tile.hiddenSurvivorId, null);
  });

  test('Hero can equip horse and weapon', () => {
    assert.equal(getFaction('hero').canEquipHorse(), true);
    assert.equal(getFaction('hero').canEquipWeapon(), true);
  });

  test('Witch cannot equip horse or weapon', () => {
    assert.equal(getFaction('witch').canEquipHorse(), false);
    assert.equal(getFaction('witch').canEquipWeapon(), false);
  });
});

// ── Visibility ──────────────────────────────────────────────────────────────

describe('Sight range', () => {
  test('Hero sight: DAY=6, NIGHT=3, DAWN/DUSK=4', () => {
    const h = getFaction('hero');
    assert.equal(h.getSightRange(Phase.DAY, false), 6);
    assert.equal(h.getSightRange(Phase.NIGHT, false), 3);
    assert.equal(h.getSightRange(Phase.DAWN, false), 4);
    assert.equal(h.getSightRange(Phase.DUSK, false), 4);
  });

  test('Hero sight with scout: +1', () => {
    const h = getFaction('hero');
    assert.equal(h.getSightRange(Phase.DAY, true), 7);
    assert.equal(h.getSightRange(Phase.NIGHT, true), 4);
  });

  test('Witch sight: fixed 5 regardless of phase or scout', () => {
    const w = getFaction('witch');
    assert.equal(w.getSightRange(Phase.DAY, false), 5);
    assert.equal(w.getSightRange(Phase.NIGHT, false), 5);
    assert.equal(w.getSightRange(Phase.NIGHT, true), 5);
  });
});

// ── Entity Registry ─────────────────────────────────────────────────────────

describe('Entity registry', () => {
  test('Hero unit types', () => {
    assert.deepEqual(getFaction('hero').getUnitTypes(), [EntityType.SURVIVOR]);
  });

  test('Witch unit types', () => {
    const types = getFaction('witch').getUnitTypes();
    assert.ok(types.includes(EntityType.ZOMBIE));
    assert.ok(types.includes(EntityType.MINION));
    assert.ok(types.includes(EntityType.WOOD_GOLEM));
    assert.ok(types.includes(EntityType.IRON_GOLEM));
  });

  test('Hero createLeader makes a hero entity', () => {
    const leader = getFaction('hero').createLeader(2, 3, 'p1');
    assert.equal(leader.type, EntityType.HERO);
    assert.equal(leader.owner, 'hero');
  });

  test('Witch createLeader makes a witch entity', () => {
    const leader = getFaction('witch').createLeader(2, 3, 'p1');
    assert.equal(leader.type, EntityType.WITCH);
    assert.equal(leader.owner, 'witch');
  });
});

// ── Kill / Summon Tracking ─────────────────────────────────────────────────

describe('Kill and summon tracking', () => {
  // Faction.trackKill / trackSummon now delegate to state-level mutators;
  // provide minimal spies so the routing can be verified without pulling
  // in a full GameState.
  function spyState() {
    const calls = { killSides: [], summonSides: [] };
    return {
      calls,
      recordKillForSide(side)   { calls.killSides.push(side); },
      recordSummonForSide(side) { calls.summonSides.push(side); },
    };
  }

  test('Hero (day) trackKill routes to recordKillForSide("day")', () => {
    const state = spyState();
    getFaction('hero').trackKill(state);
    assert.deepEqual(state.calls.killSides, ['day']);
  });

  test('Witch (night) trackKill routes to recordKillForSide("night")', () => {
    const state = spyState();
    getFaction('witch').trackKill(state);
    assert.deepEqual(state.calls.killSides, ['night']);
  });

  test('Hero (day) trackSummon still calls recordSummonForSide("day")', () => {
    // Day has no summon mechanic today, but the routing must still fire
    // so a future day-side summoner doesn't need to edit Faction again.
    const state = spyState();
    getFaction('hero').trackSummon(state);
    assert.deepEqual(state.calls.summonSides, ['day']);
  });

  test('Witch (night) trackSummon routes to recordSummonForSide("night")', () => {
    const state = spyState();
    getFaction('witch').trackSummon(state);
    assert.deepEqual(state.calls.summonSides, ['night']);
  });
});

// ── Opponent / Actions / Node Keys ─────────────────────────────────────────

describe('Faction helpers', () => {
  test('getOpponentId', () => {
    assert.equal(getFaction('hero').getOpponentId(), 'witch');
    assert.equal(getFaction('witch').getOpponentId(), 'hero');
  });

  test('getActionsLeft reads from the side-keyed accessor', () => {
    // Faction.getActionsLeft now delegates to state.actionsLeftForSide().
    // Provide a minimal stub to verify the routing.
    const state = {
      actionsLeftForSide(sideId) { return sideId === 'day' ? 5 : 3; },
    };
    assert.equal(getFaction('hero').getActionsLeft(state),  5);
    assert.equal(getFaction('witch').getActionsLeft(state), 3);
  });

  test('getNodeSeenKey', () => {
    assert.equal(getFaction('hero').getNodeSeenKey(), 'seenByHero');
    assert.equal(getFaction('witch').getNodeSeenKey(), 'seenByWitch');
  });
});

// ── hasHorse ───────────────────────────────────────────────────────────────

describe('hasHorse', () => {
  test('Hero with horse returns true', () => {
    assert.equal(getFaction('hero').hasHorse({ items: { horse: { count: 1 } } }), true);
  });

  test('Hero without horse returns false', () => {
    assert.equal(getFaction('hero').hasHorse({ items: {} }), false);
    assert.equal(getFaction('hero').hasHorse({ items: { horse: { count: 0 } } }), false);
    assert.equal(getFaction('hero').hasHorse({}), false);
  });

  test('Witch always returns false even with horse item', () => {
    assert.equal(getFaction('witch').hasHorse({ items: { horse: { count: 1 } } }), false);
  });
});

// ── canExplore ─────────────────────────────────────────────────────────────

describe('canExplore', () => {
  test('Hero faction: any entity can explore', () => {
    assert.equal(getFaction('hero').canExplore({ type: EntityType.HERO }), true);
    assert.equal(getFaction('hero').canExplore({ type: EntityType.SURVIVOR }), true);
  });

  test('Witch faction: only a night-side leader can explore', () => {
    // All leader types on the night side are eligible explorers.
    assert.equal(getFaction('witch').canExplore({ type: EntityType.WITCH,       owner: 'witch' }), true);
    assert.equal(getFaction('witch').canExplore({ type: EntityType.NECROMANCER, owner: 'witch' }), true);
    assert.equal(getFaction('witch').canExplore({ type: EntityType.BRUTE,       owner: 'witch' }), true);
    // Summoned units and zombies do not explore.
    assert.equal(getFaction('witch').canExplore({ type: EntityType.MINION,      owner: 'witch' }), false);
    assert.equal(getFaction('witch').canExplore({ type: EntityType.ZOMBIE,      owner: 'witch' }), false);
    assert.equal(getFaction('witch').canExplore({ type: EntityType.IRON_GOLEM,  owner: 'witch' }), false);
  });
});
