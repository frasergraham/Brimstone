// Spec-based tests for src/entities.js
// Asserts what SHOULD be true per game design doc.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Entity, EntityType, SurvivorAbility, SURVIVOR_ROSTER,
  createHero, createWitch, createZombie, createMinion,
  createWoodGolem, createIronGolem, createSurvivor, resetRoster,
} from '../src/entities.js';
import { WeaponType, WEAPON_STATS } from '../src/tiles.js';

// ── Base stats ────────────────────────────────────────────────────────────────
// Expected values from game design doc:
//   Hero:       HP=14, ATK=3, DEF=2, owner='hero'
//   Witch:      HP=10, ATK=2, DEF=2, owner='witch'
//   Zombie:     HP=2,  ATK=2, DEF=0, owner='witch'
//   Minion:     HP=2,  ATK=1, DEF=0, owner='witch'
//   Wood Golem: HP=3,  ATK=2, DEF=3, owner='witch'
//   Iron Golem: HP=5,  ATK=3, DEF=4, owner='witch'

describe('Base stats — Hero', () => {
  test('HP=14, ATK=3, DEF=2, owner=hero, type=hero', () => {
    const hero = createHero(0, 0);
    assert.equal(hero.maxHp, 14);
    assert.equal(hero.hp, 14, 'starts at full HP');
    assert.equal(hero.attack, 3);
    assert.equal(hero.defense, 2);
    assert.equal(hero.owner, 'hero');
    assert.equal(hero.type, EntityType.HERO);
  });

  test('starts alive with no weapon and no items', () => {
    const hero = createHero(0, 0);
    assert.equal(hero.alive, true);
    assert.equal(hero.weapon, null);
    assert.deepEqual(hero.items, {});
  });
});

describe('Base stats — Witch', () => {
  test('HP=10, ATK=2, DEF=2, owner=witch, type=witch', () => {
    const witch = createWitch(0, 0);
    assert.equal(witch.maxHp, 10);
    assert.equal(witch.hp, 10);
    assert.equal(witch.attack, 2);
    assert.equal(witch.defense, 2);
    assert.equal(witch.owner, 'witch');
    assert.equal(witch.type, EntityType.WITCH);
  });
});

describe('Base stats — Zombie', () => {
  test('HP=2, ATK=2, DEF=0, owner=witch', () => {
    const z = createZombie(0, 0);
    assert.equal(z.maxHp, 2);
    assert.equal(z.attack, 2);
    assert.equal(z.defense, 0);
    assert.equal(z.owner, 'witch');
    assert.equal(z.type, EntityType.ZOMBIE);
  });
});

describe('Base stats — Minion', () => {
  test('HP=2, ATK=1, DEF=0, owner=witch', () => {
    const m = createMinion(0, 0);
    assert.equal(m.maxHp, 2);
    assert.equal(m.attack, 1);
    assert.equal(m.defense, 0);
    assert.equal(m.owner, 'witch');
  });
});

describe('Base stats — Wood Golem', () => {
  test('HP=3, ATK=2, DEF=3, owner=witch', () => {
    const g = createWoodGolem(0, 0);
    assert.equal(g.maxHp, 3);
    assert.equal(g.attack, 2);
    assert.equal(g.defense, 3);
    assert.equal(g.owner, 'witch');
    assert.equal(g.type, EntityType.WOOD_GOLEM);
  });
});

describe('Base stats — Iron Golem', () => {
  test('HP=5, ATK=3, DEF=2, owner=witch', () => {
    const g = createIronGolem(0, 0);
    assert.equal(g.maxHp, 5);
    assert.equal(g.attack, 3);
    assert.equal(g.defense, 2);
    assert.equal(g.owner, 'witch');
    assert.equal(g.type, EntityType.IRON_GOLEM);
  });
});

// ── Entity IDs ────────────────────────────────────────────────────────────────

describe('Entity IDs', () => {
  test('each entity gets a unique ID', () => {
    const ids = [
      createHero(0, 0).id,
      createWitch(0, 0).id,
      createMinion(0, 0).id,
      createZombie(0, 0).id,
    ];
    assert.equal(new Set(ids).size, ids.length, 'IDs should be unique');
  });

  test('IDs are strings starting with "e"', () => {
    const hero = createHero(0, 0);
    assert.ok(typeof hero.id === 'string');
    assert.ok(hero.id.startsWith('e'), `ID should start with 'e', got ${hero.id}`);
  });
});

// ── alive getter ──────────────────────────────────────────────────────────────

describe('alive getter', () => {
  test('alive when hp > 0', () => {
    const hero = createHero(0, 0);
    assert.equal(hero.alive, true);
  });

  test('dead when hp === 0', () => {
    const hero = createHero(0, 0);
    hero.hp = 0;
    assert.equal(hero.alive, false);
  });
});

// ── takeDamage ────────────────────────────────────────────────────────────────

describe('takeDamage', () => {
  test('reduces HP by the stated amount', () => {
    const hero = createHero(0, 0);
    hero.takeDamage(3);
    assert.equal(hero.hp, 11);
  });

  test('HP is clamped to 0 — never goes negative', () => {
    const hero = createHero(0, 0);
    hero.takeDamage(999);
    assert.equal(hero.hp, 0);
  });

  test('returns true (dead) when HP reaches 0', () => {
    const minion = createMinion(0, 0); // HP=2
    const dead = minion.takeDamage(2);
    assert.equal(dead, true);
    assert.equal(minion.alive, false);
  });

  test('returns false (alive) when HP remains above 0', () => {
    const hero = createHero(0, 0); // HP=14
    const dead = hero.takeDamage(5);
    assert.equal(dead, false);
    assert.equal(hero.alive, true);
  });

  test('exactly lethal damage kills entity', () => {
    const zombie = createZombie(0, 0); // HP=2
    const dead = zombie.takeDamage(zombie.maxHp);
    assert.equal(dead, true);
    assert.equal(zombie.hp, 0);
  });

  test('zero damage does not kill', () => {
    const hero = createHero(0, 0);
    const dead = hero.takeDamage(0);
    assert.equal(dead, false);
    assert.equal(hero.hp, 14);
  });
});

// ── heal ──────────────────────────────────────────────────────────────────────

describe('heal', () => {
  test('increases HP', () => {
    const hero = createHero(0, 0);
    hero.takeDamage(5);
    hero.heal(3);
    assert.equal(hero.hp, 12);
  });

  test('clamps HP at maxHp', () => {
    const hero = createHero(0, 0);
    hero.takeDamage(2);
    hero.heal(999);
    assert.equal(hero.hp, hero.maxHp);
  });

  test('heal on full-HP entity does nothing', () => {
    const hero = createHero(0, 0);
    hero.heal(5);
    assert.equal(hero.hp, hero.maxHp);
  });
});

// ── equipWeapon ───────────────────────────────────────────────────────────────
// Weapon bonus spec (from tiles.js WEAPON_STATS):
//   sword:  +2 ATK, +0 DEF
//   axe:    +1 ATK, +1 DEF
//   bow:    +1 ATK, +0 DEF
//   shield: +0 ATK, +2 DEF
//   staff:  +1 ATK, +0 DEF  (+ special vs undead at combat time)
//   dagger: +1 ATK, +0 DEF

describe('equipWeapon', () => {
  // Phase 3 decoupled weapon bonuses from base stats. getAttack() /
  // getDefense() compose the ITEMS[weapon].statMods contribution at
  // call time; hero.attack / hero.defense stay at the base value.
  // These tests assert the effective (character-sheet) value via the
  // getters and leave the base stat untouched.
  test('sword gives +2 ATK, no DEF change', () => {
    const hero = createHero(0, 0);
    hero.equipWeapon(WeaponType.SWORD);
    assert.equal(hero.getAttack(), 5);   // base 3 + sword +2
    assert.equal(hero.getDefense(), 2);  // unchanged
    assert.equal(hero.weapon, WeaponType.SWORD);
  });

  test('shield gives +2 DEF, no ATK change', () => {
    const hero = createHero(0, 0);
    hero.equipWeapon(WeaponType.SHIELD);
    assert.equal(hero.getAttack(), 3);   // unchanged
    assert.equal(hero.getDefense(), 4);  // base 2 + shield +2
  });

  test('axe gives +1 ATK and +1 DEF', () => {
    const hero = createHero(0, 0);
    hero.equipWeapon(WeaponType.AXE);
    assert.equal(hero.getAttack(), 4);
    assert.equal(hero.getDefense(), 3);
  });

  test('staff gives +1 ATK', () => {
    const hero = createHero(0, 0);
    hero.equipWeapon(WeaponType.STAFF);
    assert.equal(hero.getAttack(), 4);
    assert.equal(hero.getDefense(), 2);
  });

  test('switching weapons: old bonus is no longer contributing', () => {
    const hero = createHero(0, 0);
    hero.equipWeapon(WeaponType.SWORD);
    hero.equipWeapon(WeaponType.SHIELD);
    assert.equal(hero.getAttack(), 3, 'sword bonus should not persist');
    assert.equal(hero.getDefense(), 4, 'shield bonus should apply');
  });

  test('equipping null (unequip) removes weapon bonus', () => {
    const hero = createHero(0, 0);
    hero.equipWeapon(WeaponType.SWORD);
    assert.equal(hero.getAttack(), 5);
    hero.equipWeapon(null);
    assert.equal(hero.getAttack(), 3, 'effective attack returns to base after unequip');
    assert.equal(hero.weapon, null);
  });

  test('equipping same weapon twice does not double-apply bonus', () => {
    const hero = createHero(0, 0);
    hero.equipWeapon(WeaponType.SWORD);
    hero.equipWeapon(WeaponType.SWORD);
    assert.equal(hero.getAttack(), 5, 'should not double-stack same weapon');
  });

  test('base stats stay stable across weapon swaps', () => {
    // Weapon bonus is now composed at call time, not baked into the
    // base stat via mutation — this is the Phase 3 invariant.
    const hero = createHero(0, 0);
    const baseAttack = hero.attack;
    const baseDefense = hero.defense;
    hero.equipWeapon(WeaponType.SWORD);
    hero.equipWeapon(WeaponType.SHIELD);
    hero.equipWeapon(null);
    assert.equal(hero.attack, baseAttack, 'base attack never mutated');
    assert.equal(hero.defense, baseDefense, 'base defense never mutated');
  });
});

// ── resetTurn ─────────────────────────────────────────────────────────────────

describe('resetTurn', () => {
  test('clears attackBonus, defenseBonus, and actedThisTurn', () => {
    const hero = createHero(0, 0);
    hero.attackBonus = 3;
    hero.defenseBonus = 2;
    hero.actedThisTurn = true;
    hero.resetTurn();
    assert.equal(hero.attackBonus, 0);
    assert.equal(hero.defenseBonus, 0);
    assert.equal(hero.actedThisTurn, false);
  });

  test('does not reset HP or stats', () => {
    const hero = createHero(0, 0);
    hero.takeDamage(3);
    hero.equipWeapon(WeaponType.SWORD);
    hero.resetTurn();
    assert.equal(hero.hp, 11, 'HP should not reset');
    assert.equal(hero.getAttack(), 5, 'weapon bonus should not reset');
  });
});

// ── resolveCombat ─────────────────────────────────────────────────────────────
// Formula (advantage/disadvantage dice-pool combat):
//   atkBaseDie  = best/worst of (1 + atkNet) d6 — advantage if atkNet > 0,
//                 disadvantage if atkNet < 0, plain d6 otherwise
//   defBaseDie  = best/worst of (1 + defNet) d6 — same convention
//   attackRoll  = atkBaseDie + attack + attackBonus + extraAtkBonus
//   defenseRoll = defBaseDie + defense + defenseBonus + extraDefBonus - fatigue
//   hit         = attackRoll > defenseRoll
//   crush       = attackRoll >= 2 * defenseRoll
//   counter     = defenseRoll >= 2 * attackRoll

// Helper: override Math.random for a single call
function withRNG(sequence, fn) {
  let idx = 0;
  const orig = Math.random;
  // Math.ceil(random() * 6) is the die roll pattern used
  Math.random = () => sequence[idx++ % sequence.length];
  try { return fn(); }
  finally { Math.random = orig; }
}

// Math.ceil(x * 6): x=1/6→1, x=2/6→2, x=3/6→3, x=4/6→4, x=5/6→5, x=1→6
// We pass the raw value that Math.random() returns.
// ceil(0.001 * 6) = 1, ceil(0.999 * 6) = 6

describe('Entity.resolveCombat', () => {
  test('hit is true when attackRoll strictly exceeds defenseRoll', () => {
    const hero = createHero(0, 0);   // ATK=3
    const witch = createWitch(0, 0); // DEF=2
    // atkDie=6, defDie=1: 6+3=9 vs 1+2=3 → hit
    const r = withRNG([0.999, 0.001], () => Entity.resolveCombat(hero, witch));
    assert.equal(r.hit, true);
    assert.ok(r.attackRoll > r.defenseRoll);
  });

  test('hit is false when defenseRoll equals attackRoll (tie = miss)', () => {
    const hero = createHero(0, 0);   // ATK=3
    const witch = createWitch(0, 0); // DEF=2
    // Need attackRoll === defenseRoll: d6_atk + 3 = d6_def + 2 → d6_atk = d6_def - 1
    // d6_atk=2: ceil(0.333*6) = ceil(1.998) = 2
    // d6_def=3: ceil(0.5*6)   = ceil(3.0)   = 3
    // attackRoll = 2+3=5, defenseRoll = 3+2=5 → tie → miss
    const r = withRNG([0.333, 0.5], () => Entity.resolveCombat(hero, witch));
    assert.equal(r.margin, 0);
    assert.equal(r.hit, false, 'tie should be a miss, not a hit');
  });

  test('hit is false when defenseRoll exceeds attackRoll', () => {
    const hero = createHero(0, 0);   // ATK=3
    const witch = createWitch(0, 0); // DEF=2
    // atkDie=1, defDie=6: 1+3=4 vs 6+2=8 → miss
    const r = withRNG([0.001, 0.999], () => Entity.resolveCombat(hero, witch));
    assert.equal(r.hit, false);
    assert.ok(r.attackRoll < r.defenseRoll);
  });

  test('margin equals attackRoll minus defenseRoll', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    const r = withRNG([0.999, 0.001], () => Entity.resolveCombat(hero, witch));
    assert.equal(r.margin, r.attackRoll - r.defenseRoll);
  });

  test('phaseAdvantage adds an advantage die to the attacker', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    // Sequence used twice: neutral run consumes 2 dice, advantage run consumes 3
    // (1 atk pool of 2 + 1 def). Advantage picks the max.
    const r0 = withRNG([0.5, 0.5], () => Entity.resolveCombat(hero, witch));
    // Low-then-high for atk pool → advantage picks high (6); def die = 3.
    const r1 = withRNG([0.001, 0.999, 0.5],
      () => Entity.resolveCombat(hero, witch, { phaseAdvantage: 1 }));
    assert.equal(r0.atkPool.length, 1);
    assert.equal(r1.atkPool.length, 2);
    assert.equal(r1.atkBaseDie, 6, 'advantage picks the highest of two dice');
    assert.equal(r1.defenseRoll, r0.defenseRoll);
  });

  test('staff grants attacker advantage vs undead (zombie, minion, golems)', () => {
    const hero = createHero(0, 0);
    hero.equipWeapon(WeaponType.STAFF); // +1 ATK, plus +1 advantage die vs undead
    const zombie = createZombie(0, 0);
    const minion = createMinion(0, 0);
    const woodGolem = createWoodGolem(0, 0);
    const ironGolem = createIronGolem(0, 0);

    for (const undead of [zombie, minion, woodGolem, ironGolem]) {
      const r = withRNG([0.5, 0.5, 0.5], () => Entity.resolveCombat(hero, undead));
      assert.equal(r.atkStaffBonus, 1, `Staff vs ${undead.type} should grant 1 advantage die`);
      assert.equal(r.atkAdvantage, 1);
      assert.equal(r.atkPool.length, 2);
    }
  });

  test('staff does NOT grant advantage vs hero or witch', () => {
    const attacker = createHero(0, 0);
    attacker.equipWeapon(WeaponType.STAFF);
    const witch = createWitch(0, 0);
    const r = withRNG([0.5, 0.5], () => Entity.resolveCombat(attacker, witch));
    assert.equal(r.atkStaffBonus, 0, 'No staff bonus vs non-undead');
    assert.equal(r.atkAdvantage, 0);
  });

  test('extraAtkBonus is added to attackRoll', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    const r0 = withRNG([0.5, 0.5], () => Entity.resolveCombat(hero, witch));
    const r2 = withRNG([0.5, 0.5], () => Entity.resolveCombat(hero, witch, { extraAtkBonus: 2 }));
    assert.equal(r2.attackRoll, r0.attackRoll + 2);
  });

  test('extraDefBonus is added to defenseRoll', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    const r0 = withRNG([0.5, 0.5], () => Entity.resolveCombat(hero, witch));
    const r3 = withRNG([0.5, 0.5], () => Entity.resolveCombat(hero, witch, { extraDefBonus: 3 }));
    assert.equal(r3.defenseRoll, r0.defenseRoll + 3);
  });

  test('atkAdvantageDice adds advantage dice to the attacker pool', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    // Pool of 3 d6 → picks the max. Low, high, low → picks 6.
    const r = withRNG([0.001, 0.999, 0.001, 0.5],
      () => Entity.resolveCombat(hero, witch, { atkAdvantageDice: 2 }));
    assert.equal(r.atkPool.length, 3);
    assert.equal(r.atkBaseDie, 6);
    assert.equal(r.atkExtraDice.length, 2);
  });

  test('attackBonus from entity is included in attackRoll', () => {
    const hero = createHero(0, 0);
    hero.attackBonus = 2;
    const witch = createWitch(0, 0);
    const r0 = withRNG([0.5, 0.5], () => {
      const freshHero = createHero(0, 0);
      return Entity.resolveCombat(freshHero, witch);
    });
    const r = withRNG([0.5, 0.5], () => Entity.resolveCombat(hero, witch));
    assert.equal(r.attackRoll, r0.attackRoll + 2, 'attackBonus should be in attackRoll');
  });

  test('defenseBonus from entity is included in defenseRoll', () => {
    const hero = createHero(0, 0);
    const witch = createWitch(0, 0);
    witch.defenseBonus = 2;
    const r0 = withRNG([0.5, 0.5], () => {
      const freshWitch = createWitch(0, 0);
      return Entity.resolveCombat(hero, freshWitch);
    });
    const r = withRNG([0.5, 0.5], () => Entity.resolveCombat(hero, witch));
    assert.equal(r.defenseRoll, r0.defenseRoll + 2);
  });
});

// ── Survivor roster ───────────────────────────────────────────────────────────

describe('Survivor roster', () => {
  test('roster has exactly 20 characters', () => {
    assert.equal(SURVIVOR_ROSTER.length, 20);
  });

  test('no two roster entries share the same name', () => {
    const names = SURVIVOR_ROSTER.map(s => s.name);
    assert.equal(new Set(names).size, names.length, 'roster names should be unique');
  });

  test('createSurvivor draws without replacement (no duplicates in one game)', () => {
    resetRoster();
    const names = [];
    for (let i = 0; i < 20; i++) {
      const s = createSurvivor(0, 0);
      assert.ok(!names.includes(s.name), `Duplicate survivor drawn: ${s.name}`);
      names.push(s.name);
    }
  });

  test('created survivor matches roster stats', () => {
    resetRoster();
    const s = createSurvivor(0, 0);
    const rosterEntry = SURVIVOR_ROSTER.find(r => r.name === s.name);
    assert.ok(rosterEntry, `Survivor ${s.name} not found in roster`);
    assert.equal(s.maxHp, rosterEntry.maxHp);
    assert.equal(s.attack, rosterEntry.attack);
    assert.equal(s.defense, rosterEntry.defense);
    assert.deepEqual(s.abilities, rosterEntry.ability ? [rosterEntry.ability] : []);
  });

  test('survivor starts at full HP', () => {
    resetRoster();
    const s = createSurvivor(0, 0);
    assert.equal(s.hp, s.maxHp);
  });
});

describe('Phase 4 — BRAWLER / STURDY passives un-baked from roster', () => {
  test('BRAWLER roster entries have base attack 1 less than effective attack', () => {
    const brawlers = SURVIVOR_ROSTER.filter(r => r.ability === SurvivorAbility.BRAWLER);
    assert.ok(brawlers.length >= 3, 'roster should contain ≥3 brawlers');
    for (const entry of brawlers) {
      resetRoster();
      // Force the draw by scanning until we hit this entry.
      let s;
      for (let i = 0; i < 40; i++) {
        s = createSurvivor(0, 0);
        if (s.name === entry.name) break;
      }
      assert.equal(s.name, entry.name, `expected to draw ${entry.name}`);
      assert.equal(s.attack,      entry.attack,     'base attack matches roster');
      assert.equal(s.getAttack(), entry.attack + 1, 'getAttack() adds +1 via brawler statMods');
    }
  });

  test('STURDY roster entries have base defense 1 less than effective defense', () => {
    const sturdyOnes = SURVIVOR_ROSTER.filter(r => r.ability === SurvivorAbility.STURDY);
    assert.ok(sturdyOnes.length >= 3, 'roster should contain ≥3 sturdy survivors');
    for (const entry of sturdyOnes) {
      resetRoster();
      let s;
      for (let i = 0; i < 40; i++) {
        s = createSurvivor(0, 0);
        if (s.name === entry.name) break;
      }
      assert.equal(s.name, entry.name, `expected to draw ${entry.name}`);
      assert.equal(s.defense,      entry.defense,     'base defense matches roster');
      assert.equal(s.getDefense(), entry.defense + 1, 'getDefense() adds +1 via sturdy statMods');
    }
  });

  test('un-baked base stats match pre-refactor effective values', () => {
    // Lock the parity promise: effective stats under Phase 4 must equal
    // the pre-refactor baked numbers (attack=3/2/2 for brawler trio,
    // defense=3/3/3 for sturdy trio).
    const expected = {
      'Thomas Putnam':    { attack: 3, defense: 2 },
      'Silas Holt':       { attack: 2, defense: 2 },
      'Nathaniel Corwin': { attack: 3, defense: 2 },
      'Hannah Marsh':     { attack: 1, defense: 3 },
      'Isaac Graves':     { attack: 1, defense: 3 },
      'Mercy Hale':       { attack: 2, defense: 3 },
    };
    for (const [name, exp] of Object.entries(expected)) {
      resetRoster();
      let s;
      for (let i = 0; i < 40; i++) {
        s = createSurvivor(0, 0);
        if (s.name === name) break;
      }
      assert.equal(s.name, name, `failed to draw ${name}`);
      assert.equal(s.getAttack(),  exp.attack,  `${name} effective attack parity`);
      assert.equal(s.getDefense(), exp.defense, `${name} effective defense parity`);
    }
  });

  test('hasAbility works with abilities array and supports multi-ability', () => {
    const e = new Entity(EntityType.SURVIVOR, 'hero', 0, 0);
    e.abilities = [SurvivorAbility.HEAL, SurvivorAbility.SCOUT];
    assert.equal(e.hasAbility(SurvivorAbility.HEAL),  true);
    assert.equal(e.hasAbility(SurvivorAbility.SCOUT), true);
    assert.equal(e.hasAbility(SurvivorAbility.BRAWLER), false);
  });

  test('getAttack/getDefense compose passive + weapon', () => {
    const e = new Entity(EntityType.SURVIVOR, 'hero', 0, 0);
    e.attack = 2; e.defense = 2;
    e.abilities = [SurvivorAbility.BRAWLER, SurvivorAbility.STURDY];
    assert.equal(e.getAttack(),  3, 'base 2 + brawler 1');
    assert.equal(e.getDefense(), 3, 'base 2 + sturdy 1');
    e.equipWeapon('sword'); // +2 attack
    assert.equal(e.getAttack(), 5, 'base 2 + brawler 1 + sword 2');
  });
});

