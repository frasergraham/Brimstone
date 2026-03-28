#!/usr/bin/env node
// Combat simulation — runs a matrix of realistic in-game combat scenarios
// and generates a fairness / variability report.
// Usage: node scripts/combat-sim.js [rounds=100]

import { Entity, EntityType } from '../src/entities.js';

const N = parseInt(process.argv[2] ?? '100', 10);
if (isNaN(N) || N < 1) { console.error('Usage: node scripts/combat-sim.js [rounds]'); process.exit(1); }

// ── Entity builder ─────────────────────────────────────────────────────────
// Creates a plain stat object that satisfies Entity.resolveCombat's interface.
function ent(label, { type = EntityType.HERO, attack, defense, maxHp, weapon = null } = {}) {
  const e = {
    label, type, attack, defense, maxHp,
    hp: maxHp, attackBonus: 0, defenseBonus: 0, weapon,
    get alive() { return this.hp > 0; },
    takeDamage(n) { this.hp = Math.max(0, this.hp - n); return !this.alive; },
    // Satisfy resolveCombat's weapon check via the entity fields
  };
  // Apply weapon bonuses to base stats (like equipWeapon does)
  if (weapon === 'sword')  { e.attack  += 2; }
  if (weapon === 'axe')    { e.attack  += 1; e.defense += 1; }
  if (weapon === 'bow')    { e.attack  += 1; }
  if (weapon === 'shield') { e.defense += 2; }
  if (weapon === 'staff')  { e.attack  += 1; }
  if (weapon === 'dagger') { e.attack  += 1; }
  return e;
}

function clone(e) {
  return { ...e, hp: e.maxHp, attackBonus: 0, defenseBonus: 0 };
}

// ── Single-swing analysis ──────────────────────────────────────────────────
function analyseSwing(attDef, defDef, { phaseBonus = 0, extraAtk = 0, extraDef = 0, extraAtkDice = 0, extraDefDice = 0 } = {}, n = N) {
  let hits = 0, crushes = 0, counters = 0;
  const margins = [];

  for (let i = 0; i < n; i++) {
    const att = clone(attDef);
    const def = clone(defDef);
    const { attackRoll, defenseRoll, margin } = Entity.resolveCombat(att, def, phaseBonus, extraAtk, extraDef, extraAtkDice, extraDefDice);
    margins.push(margin);
    if (margin > 0)  { hits++; if (attackRoll >= 2 * defenseRoll) crushes++; }
    if (defenseRoll >= 2 * attackRoll) counters++;
  }

  const hitRate     = hits / n;
  const crushRate   = crushes / n;
  const counterRate = counters / n;
  const expDmg      = (hits - crushes) / n + (crushes * 2) / n; // crush = 2 dmg
  const avgMargin   = margins.reduce((s, m) => s + m, 0) / n;

  return { hitRate, crushRate, counterRate, expDmg, avgMargin };
}

// ── Duel simulation (alternating attacks until one side is dead) ───────────
// Models an extended fight: attacker and defender take turns attacking each other.
// Fort on the defender side is consumed per hit.
function simulateDuel(attDef, defDef, {
  phaseBonus = 0, extraAtk = 0, extraDef = 0, defFort = 0, extraAtkDice = 0, extraDefDice = 0,
} = {}, n = N) {
  let attWins = 0;
  const totalSwings = [];
  const attHpLeft   = [];

  for (let i = 0; i < n; i++) {
    let aHp   = attDef.maxHp;
    let dHp   = defDef.maxHp;
    let dFort = defFort;
    let swings = 0;
    const MAX_SWINGS = 200;

    while (aHp > 0 && dHp > 0 && swings < MAX_SWINGS) {
      // ── Attacker's swing ──
      swings++;
      const att = clone(attDef);
      const def = clone(defDef);
      const { attackRoll: ar, defenseRoll: dr, margin: am } = Entity.resolveCombat(att, def, phaseBonus, extraAtk, extraDef + dFort, extraAtkDice, extraDefDice);

      if (am > 0) {
        const dmg = ar >= 2 * dr ? 2 : 1;
        const fortAbsorb = Math.min(dFort, dmg);
        dFort  -= fortAbsorb;
        dHp    -= (dmg - fortAbsorb);
      } else if (am === 0 && dFort > 0) {
        dFort -= 1; // tie chips fortification by 1
      } else if (dr >= 2 * ar) {
        aHp -= 1; // counter-attack (defender doubled attacker's roll)
      }

      if (aHp <= 0 || dHp <= 0) break;

      // ── Defender's swing (same stats but roles reversed, no phase/extra bonuses) ──
      swings++;
      const { attackRoll: dr2, defenseRoll: ar2, margin: dm } = Entity.resolveCombat(clone(defDef), clone(attDef), 0, 0, 0);
      if (dm > 0) {
        const dmg = dr2 >= 2 * ar2 ? 2 : 1;
        aHp -= dmg;
      } else if (ar2 >= 2 * dr2) {
        dHp -= 1;
      }
    }

    if (aHp > 0) {
      attWins++;
      attHpLeft.push(aHp);
    }
    totalSwings.push(swings);
  }

  const attWinRate   = attWins / n;
  const avgSwings    = totalSwings.reduce((s, v) => s + v, 0) / n;
  const avgHpLeft    = attHpLeft.length
    ? attHpLeft.reduce((s, v) => s + v, 0) / attHpLeft.length
    : 0;

  return { attWinRate, avgSwings, avgHpLeft };
}

// ── Scenario matrix ────────────────────────────────────────────────────────
const HERO         = ent('Hero',         { type: EntityType.HERO,       attack: 3, defense: 2, maxHp: 10 });
const WITCH        = ent('Witch',        { type: EntityType.WITCH,      attack: 2, defense: 2, maxHp: 10 });
const ZOMBIE       = ent('Zombie',       { type: EntityType.ZOMBIE,     attack: 2, defense: 0, maxHp: 2  });
const MINION       = ent('Minion',       { type: EntityType.MINION,     attack: 1, defense: 0, maxHp: 2  });
const WOOD_GOLEM   = ent('Wood Golem',   { type: EntityType.WOOD_GOLEM, attack: 2, defense: 3, maxHp: 4  });
const IRON_GOLEM   = ent('Iron Golem',   { type: EntityType.IRON_GOLEM, attack: 3, defense: 4, maxHp: 6  });
const SURV_BRAWLER = ent('Brawler Surv', { type: EntityType.SURVIVOR,   attack: 3, defense: 2, maxHp: 3  }); // Thomas Putnam
const SURV_TANK    = ent('Tank Surv',    { type: EntityType.SURVIVOR,   attack: 1, defense: 3, maxHp: 4  }); // Hannah Marsh
const SURV_MID     = ent('Mid Surv',     { type: EntityType.SURVIVOR,   attack: 2, defense: 2, maxHp: 2  }); // typical survivor
const HERO_SWORD   = ent('Hero+Sword',   { type: EntityType.HERO,       attack: 3, defense: 2, maxHp: 10, weapon: 'sword'  });
const HERO_STAFF   = ent('Hero+Staff',   { type: EntityType.HERO,       attack: 3, defense: 2, maxHp: 10, weapon: 'staff'  });
const HERO_SHIELD  = ent('Hero+Shield',  { type: EntityType.HERO,       attack: 3, defense: 2, maxHp: 10, weapon: 'shield' });

const SCENARIOS = [
  // ── Baseline: hero clearing enemies ─────────────────────────────────────
  { label: 'Hero vs Zombie          (neutral)',      att: HERO,       def: ZOMBIE,     ctx: {} },
  { label: 'Hero vs Minion          (neutral)',      att: HERO,       def: MINION,     ctx: {} },
  { label: 'Hero vs Witch           (neutral)',      att: HERO,       def: WITCH,      ctx: {} },
  { label: 'Hero vs Wood Golem      (neutral)',      att: HERO,       def: WOOD_GOLEM, ctx: {} },
  { label: 'Hero vs Iron Golem      (neutral)',      att: HERO,       def: IRON_GOLEM, ctx: {} },

  // ── Phase bonuses (witch +2 ATK at night; hero has no day bonus) ──────
  { label: 'Witch vs Hero           (night +2)',     att: WITCH,      def: HERO,       ctx: { phaseBonus: 2 } },
  { label: 'Witch vs Survivor       (night +2)',     att: WITCH,      def: SURV_MID,   ctx: { phaseBonus: 2 } },
  { label: 'Zombie vs Hero          (night)',        att: ZOMBIE,     def: HERO,       ctx: {} },
  { label: 'Minion vs Survivor      (night)',        att: MINION,     def: SURV_MID,   ctx: {} },

  // ── Fortification ────────────────────────────────────────────────────────
  { label: 'Hero vs Minion          (fort 1)',       att: HERO,       def: MINION,     ctx: { extraDef: 1 }, defFort: 1 },
  { label: 'Hero vs Minion          (fort 2)',       att: HERO,       def: MINION,     ctx: { extraDef: 2 }, defFort: 2 },
  { label: 'Hero vs Witch           (fort 2)',       att: HERO,       def: WITCH,      ctx: { extraDef: 2 }, defFort: 2 },
  { label: 'Hero vs Iron Golem      (fort 2)',       att: HERO,       def: IRON_GOLEM, ctx: { extraDef: 2 }, defFort: 2 },

  // ── Gang-up bonus: 2+ on attacker side → +d3 ────────────────────────────
  { label: 'Hero vs Witch           (gang-up +d3)',  att: HERO,       def: WITCH,      ctx: { extraAtkDice: 1 } },
  { label: 'Hero vs Witch           (gang-up +d3)',  att: HERO,       def: WITCH,      ctx: { extraAtkDice: 1 } },
  { label: 'Witch vs Hero           (night+gang)',   att: WITCH,      def: HERO,       ctx: { phaseBonus: 2, extraAtkDice: 1 } },

  // ── Ally defence: 2+ on defender side → +d3 ─────────────────────────────
  { label: 'Hero vs Witch           (defender ally)',att: HERO,       def: WITCH,      ctx: { extraDefDice: 1 } },
  { label: 'Witch vs Hero           (hero has ally)',att: WITCH,      def: HERO,       ctx: { extraDefDice: 1 } },

  // ── Survivor combat ──────────────────────────────────────────────────────
  { label: 'Mid Surv vs Zombie      (neutral)',      att: SURV_MID,   def: ZOMBIE,     ctx: {} },
  { label: 'Mid Surv vs Minion      (neutral)',      att: SURV_MID,   def: MINION,     ctx: {} },
  { label: 'Brawler Surv vs Zombie  (neutral)',      att: SURV_BRAWLER,def: ZOMBIE,    ctx: {} },
  { label: 'Tank Surv vs Zombie     (neutral)',      att: SURV_TANK,  def: ZOMBIE,     ctx: {} },
  { label: 'Zombie vs Mid Surv      (night)',        att: ZOMBIE,     def: SURV_MID,   ctx: {} },

  // ── Weapons ──────────────────────────────────────────────────────────────
  { label: 'Hero+Sword vs Witch     (neutral)',      att: HERO_SWORD, def: WITCH,      ctx: {} },
  { label: 'Hero+Sword vs Iron Golem(neutral)',      att: HERO_SWORD, def: IRON_GOLEM, ctx: {} },
  { label: 'Hero+Staff vs Zombie    (undead +2)',    att: HERO_STAFF, def: ZOMBIE,     ctx: {} },
  { label: 'Hero+Staff vs Iron Golem(undead +2)',    att: HERO_STAFF, def: IRON_GOLEM, ctx: {} },
  { label: 'Hero+Shield vs Witch    (night+2 atk)', att: HERO_SHIELD,def: WITCH,      ctx: { phaseBonus: 2 } }, // witch attacks at night

  // ── Witch offensive scenarios ─────────────────────────────────────────────
  { label: 'Witch vs Mid Surv       (neutral)',      att: WITCH,      def: SURV_MID,   ctx: {} },
  { label: 'Witch vs Brawler Surv   (neutral)',      att: WITCH,      def: SURV_BRAWLER,ctx:{} },
  { label: 'Witch vs Tank Surv      (neutral)',      att: WITCH,      def: SURV_TANK,  ctx: {} },
  { label: 'Iron Golem vs Hero      (neutral)',      att: IRON_GOLEM, def: HERO,       ctx: {} },
  { label: 'Wood Golem vs Survivor  (neutral)',      att: WOOD_GOLEM, def: SURV_MID,   ctx: {} },
];

// ── Formatting helpers ─────────────────────────────────────────────────────
const pct  = (v) => `${(v * 100).toFixed(1).padStart(5)}%`;
const num  = (v, d = 2) => v.toFixed(d).padStart(6);
const bar  = (v, w = 20) => '█'.repeat(Math.round(v * w)).padEnd(w);

// ── Run and print ──────────────────────────────────────────────────────────
const RUNS = Math.max(N, 1000); // use more samples for better precision
console.log(`\nBrimstone Combat Simulation — ${RUNS.toLocaleString()} rolls per scenario\n`);
console.log(`${'Scenario'.padEnd(45)} ${'HIT%'.padStart(6)} ${'CRUSH%'.padStart(7)} ${'CNTR%'.padStart(6)} ${'E[DMG]'.padStart(7)} ${'MARGIN'.padStart(7)}`);
console.log('─'.repeat(80));

const swingResults = [];
for (const s of SCENARIOS) {
  const r = analyseSwing(s.att, s.def, s.ctx, RUNS);
  swingResults.push({ ...s, ...r });

  console.log(
    s.label.padEnd(45),
    pct(r.hitRate),
    pct(r.crushRate).padStart(7),
    pct(r.counterRate).padStart(6),
    num(r.expDmg).padStart(7),
    num(r.avgMargin).padStart(7),
  );
}

// ── Duel report ─────────────────────────────────────────────────────────────
const DUEL_RUNS = Math.max(N, 1000);
const DUELS = [
  { label: 'Hero vs Zombie          (neutral)',att: HERO,       def: ZOMBIE,     ctx: {} },
  { label: 'Hero vs Witch           (neutral)',att: HERO,       def: WITCH,      ctx: {} },
  { label: 'Hero vs Iron Golem      (neutral)',att: HERO,       def: IRON_GOLEM, ctx: {} },
  { label: 'Hero+Sword vs Witch     (neutral)',att: HERO_SWORD, def: WITCH,      ctx: {} },
  { label: 'Hero+Staff vs Iron Golem(neutral)',att: HERO_STAFF, def: IRON_GOLEM, ctx: {} },
  { label: 'Brawler Surv vs Zombie  (neutral)',att: SURV_BRAWLER,def: ZOMBIE,    ctx: {} },
  { label: 'Mid Surv vs Zombie      (neutral)',att: SURV_MID,   def: ZOMBIE,     ctx: {} },
  { label: 'Zombie vs Mid Surv      (night)',  att: ZOMBIE,     def: SURV_MID,   ctx: {} },
  { label: 'Witch vs Hero           (night)',  att: WITCH,      def: HERO,       ctx: { phaseBonus: 2 } },
  { label: 'Witch vs Hero+Shield    (night)',  att: WITCH,      def: HERO_SHIELD,ctx: { phaseBonus: 2 } },
  { label: 'Iron Golem vs Hero      (night)',  att: IRON_GOLEM, def: HERO,       ctx: {} },
  { label: 'Hero vs Witch   (gang-up+d3)',     att:HERO,       def: WITCH,      ctx: { extraAtkDice:1 } },
  { label: 'Hero vs Witch   (fort 2)',         att: HERO,       def: WITCH,      ctx: {}, defFort: 2 },
  { label: 'Witch vs Hero   (night+gang-up)',  att: WITCH,      def: HERO,       ctx: { phaseBonus:2, extraAtkDice:1 } },
];

console.log(`\n${'DUEL SIMULATION'.padEnd(45)} ${'ATT WIN%'.padStart(9)} ${'AVG SWINGS'.padStart(11)} ${'ATT HP LEFT'.padStart(12)}`);
console.log('─'.repeat(80));

for (const d of DUELS) {
  const r = simulateDuel(d.att, d.def, { ...d.ctx, defFort: d.defFort || 0 }, DUEL_RUNS);
  console.log(
    d.label.padEnd(45),
    pct(r.attWinRate).padStart(9),
    num(r.avgSwings, 1).padStart(11),
    num(r.avgHpLeft, 1).padStart(12),
  );
}

// ── Variability analysis ─────────────────────────────────────────────────────
console.log('\n── Variability: Hit-rate range across all scenarios ──────────────────────────');
const hitRates = swingResults.map(r => r.hitRate).sort((a, b) => a - b);
console.log(`  Min hit rate : ${pct(hitRates[0])}  (${swingResults[swingResults.findIndex(r => r.hitRate === hitRates[0])].label.trim()})`);
console.log(`  Max hit rate : ${pct(hitRates[hitRates.length - 1])}  (${swingResults[swingResults.findIndex(r => r.hitRate === hitRates[hitRates.length - 1])].label.trim()})`);
const median = hitRates[Math.floor(hitRates.length / 2)];
console.log(`  Median hit rate: ${pct(median)}`);

// Scenarios where counterattack is non-trivial
console.log('\n── Counter-attack risk (scenarios with >5% counter rate) ──────────────────────');
const counters = swingResults.filter(r => r.counterRate > 0.05).sort((a, b) => b.counterRate - a.counterRate);
for (const r of counters) {
  console.log(`  ${r.label.trim().padEnd(44)} counter: ${pct(r.counterRate)}`);
}

// Crushing blow opportunities
console.log('\n── Crushing blow rate (scenarios with >10% crush rate) ─────────────────────');
const crushes = swingResults.filter(r => r.crushRate > 0.10).sort((a, b) => b.crushRate - a.crushRate);
for (const r of crushes) {
  console.log(`  ${r.label.trim().padEnd(44)} crush: ${pct(r.crushRate)}`);
}

console.log(`\nDone. (${RUNS.toLocaleString()} swing samples, ${DUEL_RUNS.toLocaleString()} duel samples per scenario)\n`);
