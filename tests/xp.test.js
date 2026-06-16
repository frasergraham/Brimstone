// Phase B — XP / veterancy data model.
//
// Covers the balance.js XP curve, the awardXP() helper (campaign-gated,
// idempotent multi-level jumps), and persistence: snapshotSurvivor → deploy
// re-application without double-boosting, and the serialize round-trip for the
// per-entity `xp` field + the top-level `isCampaign` flag.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  xpForLevel, levelForXp, hpForLevel,
  XP_PER_EXPLORE, XP_PER_FORTIFY_BASE, XP_PER_FORTIFY_LEVEL_BONUS,
  XP_PER_HIT, XP_PER_CRUSH, XP_PER_KILL, XP_PER_DEFEND, XP_PER_COUNTER,
  ALLY_XP_SHARE,
} from '../src/balance.js';
import {
  createZombie, createSurvivor, applyLevel, awardXP, SURVIVOR_ROSTER,
} from '../src/entities.js';
import { snapshotSurvivor } from '../src/campaign/campaign.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { GameState } from '../src/game.js';

const campaign = () => ({ isCampaign: true });

describe('XP curve (balance.js)', () => {
  test('xpForLevel: cumulative totals from level 1', () => {
    assert.equal(xpForLevel(1), 0);
    assert.equal(xpForLevel(2), 200);
    assert.equal(xpForLevel(3), 600);
    assert.equal(xpForLevel(4), 1200);
    assert.equal(xpForLevel(5), 2000);
  });

  test('xpForLevel clamps level to ≥1', () => {
    assert.equal(xpForLevel(0), 0);
    assert.equal(xpForLevel(-3), 0);
  });

  test('levelForXp is the inverse, flooring at the threshold', () => {
    assert.equal(levelForXp(0), 1);
    assert.equal(levelForXp(199), 1);  // one short of L2
    assert.equal(levelForXp(200), 2);  // exactly L2
    assert.equal(levelForXp(599), 2);
    assert.equal(levelForXp(600), 3);
    assert.equal(levelForXp(1999), 4);
    assert.equal(levelForXp(2000), 5);
  });

  test('levelForXp caps at 99', () => {
    assert.equal(levelForXp(Number.MAX_SAFE_INTEGER), 99);
  });

  test('award constants are clean round numbers', () => {
    assert.equal(XP_PER_EXPLORE, 5);
    assert.equal(XP_PER_FORTIFY_BASE, 10);
    assert.equal(XP_PER_FORTIFY_LEVEL_BONUS, 5);
    assert.equal(XP_PER_HIT, 15);
    assert.equal(XP_PER_CRUSH, 25);
    assert.equal(XP_PER_KILL, 50);
    assert.equal(XP_PER_DEFEND, 5);
    assert.equal(XP_PER_COUNTER, 15);
    assert.equal(ALLY_XP_SHARE, 0.25);
  });
});

describe('awardXP — gating no-ops', () => {
  test('no-op when state is not a campaign', () => {
    const z = createZombie(0, 0);
    const r = awardXP(z, 500, { isCampaign: false });
    assert.deepEqual(r, { xpGained: 0, leveledUp: false, newLevel: 1 });
    assert.equal(z.xp, 0);
    assert.equal(z.level, 1);
  });

  test('no-op when state is null/undefined', () => {
    const z = createZombie(0, 0);
    assert.deepEqual(awardXP(z, 500, null), { xpGained: 0, leveledUp: false, newLevel: 1 });
    assert.deepEqual(awardXP(z, 500, undefined), { xpGained: 0, leveledUp: false, newLevel: 1 });
    assert.equal(z.xp, 0);
  });

  test('no-op when entity is null', () => {
    const r = awardXP(null, 500, campaign());
    assert.deepEqual(r, { xpGained: 0, leveledUp: false, newLevel: 1 });
  });

  test('no-op when amount <= 0', () => {
    const z = createZombie(0, 0);
    assert.deepEqual(awardXP(z, 0, campaign()), { xpGained: 0, leveledUp: false, newLevel: 1 });
    assert.deepEqual(awardXP(z, -10, campaign()), { xpGained: 0, leveledUp: false, newLevel: 1 });
    assert.equal(z.xp, 0);
  });
});

describe('awardXP — accumulation + level-up', () => {
  test('accumulates xp without leveling below the threshold', () => {
    const z = createZombie(0, 0);
    const r = awardXP(z, 199, campaign()); // one short of L2 (200)
    assert.equal(z.xp, 199);
    assert.equal(z.level, 1);
    assert.deepEqual(r, { xpGained: 199, leveledUp: false, newLevel: 1 });
  });

  test('levels up at the exact xpForLevel threshold', () => {
    const z = createZombie(0, 0); // base 14hp atk2 def0
    awardXP(z, 199, campaign());
    const r = awardXP(z, 1, campaign()); // now 200 → L2
    assert.equal(z.xp, 200);
    assert.equal(z.level, 2);
    assert.equal(r.leveledUp, true);
    assert.equal(r.newLevel, 2);
    assert.equal(r.xpGained, 1);
    // applyLevel rescaled HP + exposed the ATK/DEF bonus via the getters.
    assert.equal(z.maxHp, hpForLevel(14, 2)); // 21
    assert.equal(z.getAttack(), 3);           // 2 + 1
  });

  test('floors a fractional grant before accumulating', () => {
    const z = createZombie(0, 0);
    const r = awardXP(z, 15.9, campaign());
    assert.equal(z.xp, 15);
    assert.equal(r.xpGained, 15);
  });

  test('a level-up full-heals (applyLevel sets hp = maxHp)', () => {
    const z = createZombie(0, 0);
    z.hp = 3; // wounded
    awardXP(z, 200, campaign());
    assert.equal(z.hp, z.maxHp, 'level-up restores full HP');
  });
});

describe('awardXP — multi-level jump applies once with the final level', () => {
  test('a huge grant lands directly on the final level with correct stats', () => {
    const z = createZombie(0, 0); // base 14hp atk2 def0
    const r = awardXP(z, 2000, campaign()); // xpForLevel(5) = 2000 → L5
    assert.equal(z.xp, 2000);
    assert.equal(z.level, 5);
    assert.equal(r.newLevel, 5);
    assert.equal(r.leveledUp, true);
    // HP scaled once from the true L1 base (14), not iteratively/compounded.
    assert.equal(z.maxHp, hpForLevel(14, 5)); // round(14 × 3.0) = 42
    assert.equal(z._baseMaxHp, 14, 'base snapshot is the L1 maxHp, never an intermediate');
    assert.equal(z.getAttack(), 6); // 2 + (5−1)
    assert.equal(z.getDefense(), 2); // 0 + floor((5−1)/2)
  });
});

describe('applyLevel regression — ATK/DEF/maxHp per balance.js curves', () => {
  test('boosts intrinsic stats (confirms the static-level path still works)', () => {
    const z = createZombie(0, 0); // base 14hp atk2 def0
    applyLevel(z, 3);
    assert.equal(z.maxHp, hpForLevel(14, 3)); // 28
    assert.equal(z.getAttack(), 4);  // 2 + 2
    assert.equal(z.getDefense(), 1); // 0 + floor(2/2)
  });
});

describe('snapshotSurvivor → deploy re-application (no double-apply)', () => {
  // Mirrors the campaign deploy path in main.js: spawn the SPECIFIC roster
  // character (forcedName) so applyLevel recomputes maxHp from the true L1 base
  // instead of double-boosting the already-leveled snapshot maxHp.
  function deployFromSnapshot(snap, state) {
    const s = createSurvivor(0, 0, 'hero', state, snap.name);
    s.name = snap.name;
    s.abilities = Array.isArray(snap.abilities) ? [...snap.abilities] : [];
    s.attack = snap.attack;
    s.defense = snap.defense;
    s.weapon = snap.weapon;
    s.items = { ...snap.items };
    s.owner = 'hero';
    s.xp = snap.xp || 0;
    applyLevel(s, snap.level || 1);
    if (typeof snap.hp === 'number') s.hp = Math.min(snap.hp, s.maxHp);
    return s;
  }

  test('snapshotSurvivor captures level + xp', () => {
    const s = createSurvivor(0, 0, 'hero', null, SURVIVOR_ROSTER[0].name);
    applyLevel(s, 3);
    s.xp = 700;
    const snap = snapshotSurvivor(s);
    assert.equal(snap.level, 3);
    assert.equal(snap.xp, 700);
  });

  test('deploy preserves level/xp without double-boosting maxHp', () => {
    const charName = SURVIVOR_ROSTER[0].name;
    const charBaseHp = SURVIVOR_ROSTER[0].maxHp;

    // Build a leveled, lightly-wounded survivor, then snapshot it.
    const s = createSurvivor(0, 0, 'hero', null, charName);
    applyLevel(s, 3);          // maxHp = hpForLevel(base, 3)
    s.xp = 650;                // partway to L4
    s.hp = 5;                  // wounded
    const snap = snapshotSurvivor(s);
    const expectedMaxHp = hpForLevel(charBaseHp, 3);
    assert.equal(snap.maxHp, expectedMaxHp);

    // Deploy into a fresh mission state.
    const state = new GameState(true, false);
    const deployed = deployFromSnapshot(snap, state);

    assert.equal(deployed.level, 3, 'level survives deploy');
    assert.equal(deployed.xp, 650, 'xp survives deploy');
    assert.equal(deployed.maxHp, expectedMaxHp,
      'maxHp recomputed from the true base — NOT double-boosted');
    assert.equal(deployed._baseMaxHp, charBaseHp,
      'base snapshot is the character L1 base, not the boosted snapshot maxHp');
    assert.equal(deployed.hp, 5, 'carried (wounded) current HP preserved');
    // ATK/DEF bonus composes live off the restored level.
    assert.equal(deployed.getAttack(), SURVIVOR_ROSTER[0].attack + 2);
  });

  test('a level-1 survivor round-trips unchanged through deploy', () => {
    const charName = SURVIVOR_ROSTER[1].name;
    const s = createSurvivor(0, 0, 'hero', null, charName);
    s.hp = Math.max(1, s.maxHp - 4);
    const snap = snapshotSurvivor(s);
    assert.equal(snap.level, 1);
    assert.equal(snap.xp, 0);

    const state = new GameState(true, false);
    const deployed = deployFromSnapshot(snap, state);
    assert.equal(deployed.level, 1);
    assert.equal(deployed.maxHp, SURVIVOR_ROSTER[1].maxHp);
    assert.equal(deployed.hp, snap.hp);
  });
});

describe('persistence round-trip', () => {
  test('per-entity xp survives serialize → deserialize', () => {
    const state = new GameState(true, true);
    state.hero.xp = 137;
    state.hero.level = 2;
    const restored = deserializeState(serializeState(state));
    const hero = restored.entities.find(e => e.id === state.hero.id);
    assert.equal(hero.xp, 137);
    assert.equal(hero.level, 2);
  });

  test('missing xp on a legacy snapshot hydrates to 0', () => {
    const state = new GameState(true, true);
    const snap = serializeState(state);
    for (const e of snap.entities) delete e.xp;
    const restored = deserializeState(snap);
    for (const e of restored.entities) assert.equal(e.xp, 0);
  });

  test('top-level isCampaign survives a mid-mission round-trip', () => {
    const state = new GameState(false, false);
    state.isCampaign = true;
    const restored = deserializeState(serializeState(state));
    assert.equal(restored.isCampaign, true);
  });

  test('isCampaign defaults to false for non-campaign saves', () => {
    const state = new GameState(true, true); // default: not a campaign
    assert.equal(state.isCampaign, false);
    const restored = deserializeState(serializeState(state));
    assert.equal(restored.isCampaign, false);
    // Legacy snapshot with the field absent also defaults to false.
    const snap = serializeState(state);
    delete snap.isCampaign;
    assert.equal(deserializeState(snap).isCampaign, false);
  });
});
