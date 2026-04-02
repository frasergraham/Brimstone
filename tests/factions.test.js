// Tests for the Faction class hierarchy and registry
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Faction, HeroFaction, WitchFaction, getFaction, allFactions } from '../src/factions.js';
import { Phase } from '../src/game.js';
import { EntityType } from '../src/entities.js';
import { ResourceType } from '../src/tiles.js';

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

  test('allFactions returns both factions', () => {
    const all = allFactions();
    assert.equal(all.length, 2);
    assert.ok(all.some(f => f.id === 'hero'));
    assert.ok(all.some(f => f.id === 'witch'));
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

  test('Witch action cap is 10', () => {
    assert.equal(getFaction('witch').actionCap, 10);
  });

  test('Hero unit bonus cap is 5', () => {
    assert.equal(getFaction('hero').unitBonusCap, 5);
  });

  test('Witch unit bonus cap is 3', () => {
    assert.equal(getFaction('witch').unitBonusCap, 3);
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

  test('Witch budget: capped at 10', () => {
    // 3 + 1 + 3 (cap) + 3 = 10
    assert.equal(getFaction('witch').computeBudget(Phase.NIGHT, 5, 3), 10);
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
  test('Hero sight: DAY=3, NIGHT=1, DAWN/DUSK=2', () => {
    const h = getFaction('hero');
    assert.equal(h.getSightRange(Phase.DAY, false), 3);
    assert.equal(h.getSightRange(Phase.NIGHT, false), 1);
    assert.equal(h.getSightRange(Phase.DAWN, false), 2);
    assert.equal(h.getSightRange(Phase.DUSK, false), 2);
  });

  test('Hero sight with scout: +1', () => {
    const h = getFaction('hero');
    assert.equal(h.getSightRange(Phase.DAY, true), 4);
    assert.equal(h.getSightRange(Phase.NIGHT, true), 2);
  });

  test('Witch sight: fixed 2 regardless of phase or scout', () => {
    const w = getFaction('witch');
    assert.equal(w.getSightRange(Phase.DAY, false), 2);
    assert.equal(w.getSightRange(Phase.NIGHT, false), 2);
    assert.equal(w.getSightRange(Phase.NIGHT, true), 2);
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
