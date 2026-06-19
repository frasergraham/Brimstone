// Tests for campaign/story mode: Campaign class, victory delegates, no-witch games, wave spawner.

import { describe, test, beforeEach } from 'node:test';
import { legacyTileType } from '../src/tiles.js';
import assert from 'node:assert/strict';
import { GameState, Phase, phaseForRound, getCycleLength, DEFAULT_CYCLE_PHASES } from '../src/game.js';
import { EntityType, createMinion, createZombie, createWoodGolem, createSurvivor, markRosterUsedByName, resetRoster, SURVIVOR_ROSTER, getEquippedWeaponIdOf } from '../src/entities.js';
import { hexKey, getNeighbors, hexDistance } from '../src/hex.js';
import {
  Campaign, buildVictoryDelegate, effectiveAiBudgetBonus, snapshotSurvivor, processWaves,
  reconcileRosterAfterMission, applyCarriedHeroLoadout, rosterSnapshotFromName,
} from '../src/campaign/campaign.js';
import { getFaction } from '../src/factions.js';
import { ObjectiveType, processStoryTriggers } from '../src/campaign/missions.js';
import { CAMPAIGNS, getCampaignById } from '../src/campaign/campaign-registry.js';
import { roundsUntilScoring } from '../src/ai.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { MissionLogicEngine } from '../src/mission-logic/engine.js';
import { createGameContext } from '../src/mission-logic/game-context.js';

// ── Helper: localStorage mock for Node ──────────────────────────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

// ── Helpers ────────────────────────────────────────────────────────────────

const hollowDef = getCampaignById('calebs_hollow_prologue');

// Reconstruct the legacy objectives/waves/storyTriggers from a mission's logic
// graph (the campaign missions are now logic-graph driven — docs/09 #10). Lets
// the design-regression tests below assert the same facts against the graph.
// Note: hero-death = loss is inherent (checkVictory), so it's NOT in the graph.
function graphFacts(mission) {
  const g = mission.logic;
  if (!g) return { objectives: mission.objectives ?? { win: null, lose: [] }, waves: mission.waves ?? [], storyTriggers: mission.storyTriggers ?? [] };
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const inExec = new Map();
  const dataFrom = new Map();
  for (const e of g.edges) {
    if (e.kind === 'exec') { if (!inExec.has(e.to.node)) inExec.set(e.to.node, []); inExec.get(e.to.node).push(e.from); }
    else dataFrom.set(`${e.to.node}:${e.to.pin}`, e.from.node);
  }
  const trace = (startId) => {
    let cur = startId, cond = null, guard = 0;
    for (;;) {
      const n = byId.get(cur);
      if (n?.type === 'branch') { const cn = byId.get(dataFrom.get(`${cur}:cond`)); if (cn?.type === 'conditionNamed') cond = cn.params?.name ?? cond; }
      const ins = inExec.get(cur);
      if (!ins || !ins.length || guard++ > 60) return { event: n, cond };
      cur = ins[0].node;
    }
  };
  const winSpecs = [], loseSpecs = [], waves = [], storyTriggers = [];
  for (const n of g.nodes) {
    if (n.type === 'objectiveOutcome') (n.params.side === 'lose' ? loseSpecs : winSpecs).push(n.params.spec);
    else if (n.type === 'winMission') {
      const inE = g.edges.find(e => e.kind === 'exec' && e.to.node === n.id);
      const from = byId.get(inE?.from.node);
      if (from?.type === 'factionEvent') {
        if (inE.from.pin === 'onAllUnitsDead') winSpecs.push({ type: 'eliminate_all', targetFaction: from.params.faction });
        else if (inE.from.pin === 'onLeaderDead') winSpecs.push({ type: 'slay_witch' });
      }
    } else if (n.type === 'spawnUnits') {
      const { event } = trace(n.id);
      const w = { units: n.params.units ?? [] };
      if (event?.type === 'onRoundStart') w.round = event.params.round;
      else if (event?.type === 'onKillCount') { w.trigger = 'hero_kills'; w.count = event.params.count; }
      else if (event?.type === 'onAreaEnter') { w.trigger = 'area'; w.hexes = event.params.hexes ?? []; }
      waves.push(w);
    } else if (n.type === 'storyBeat' || n.type === 'startConversation') {
      const { event, cond } = trace(n.id);
      const t = { type: event?.type === 'onAreaEnter' ? 'area' : 'round' };
      if (n.type === 'storyBeat') { t.title = n.params.title ?? ''; t.text = n.params.text ?? ''; }
      else t.conversation = n.params.conversationId;
      if (event?.type === 'onRoundStart') t.round = event.params.round;
      if (cond) t.condition = cond;
      storyTriggers.push(t);
    }
  }
  return { objectives: { win: winSpecs[0] ?? null, lose: loseSpecs }, waves, storyTriggers };
}

function buildMap(builderKey) {
  return hollowDef.mapBuilders[builderKey]();
}

// ── Campaign registry ──────────────────────────────────────────────────────

describe('Campaign registry', () => {
  test('CAMPAIGNS array is non-empty', () => {
    assert.ok(CAMPAIGNS.length > 0);
  });

  test('each campaign has required fields', () => {
    for (const c of CAMPAIGNS) {
      assert.ok(c.id, 'campaign missing id');
      assert.ok(c.title, `${c.id} missing title`);
      assert.ok(c.description, `${c.id} missing description`);
      assert.ok(Array.isArray(c.missions), `${c.id} missing missions array`);
      assert.ok(c.mapBuilders, `${c.id} missing mapBuilders`);
      // Disabled (coming soon) campaigns don't need firstMission or populated missions
      if (!c.disabled) {
        assert.ok(c.firstMission, `${c.id} missing firstMission`);
      }
      assert.ok('prerequisiteCampaign' in c, `${c.id} missing prerequisiteCampaign field`);
    }
  });

  test('getCampaignById returns matching campaign', () => {
    assert.ok(hollowDef);
    assert.equal(hollowDef.id, 'calebs_hollow_prologue');
  });

  test('getCampaignById returns null for unknown ID', () => {
    assert.equal(getCampaignById('nonexistent'), null);
  });
});

// ── Mission definitions (inside campaign) ───────────────────────────────────

describe('Mission definitions', () => {
  test('all missions have required fields', () => {
    for (const m of hollowDef.missions) {
      assert.ok(m.id, `mission missing id`);
      assert.ok(m.title, `${m.id} missing title`);
      assert.ok(m.briefing, `${m.id} missing briefing`);
      assert.ok(m.mapBuilder, `${m.id} missing mapBuilder`);
      // Victory comes from either legacy objectives OR a logic graph (docs/09 —
      // a fully graph-driven mission like 'prologue' omits objectives entirely).
      if (m.logic) {
        assert.ok(Array.isArray(m.logic.nodes), `${m.id} logic graph missing nodes`);
      } else if (m.isTutorial) {
        // The guided tutorial is conductor-driven: it wins on conductor_complete
        // and has no lose condition (the tutorial can't be failed).
        assert.equal(m.objectives?.win?.type, 'conductor_complete', `${m.id} tutorial win is conductor_complete`);
        assert.equal(m.objectives?.lose, null, `${m.id} tutorial has no lose objective`);
      } else {
        assert.ok(m.objectives?.win, `${m.id} missing win objective`);
        assert.ok(m.objectives?.lose, `${m.id} missing lose objective`);
      }
    }
  });

  test('all mission map builders exist and return valid mapData', () => {
    for (const m of hollowDef.missions) {
      const builder = hollowDef.mapBuilders[m.mapBuilder];
      assert.ok(builder, `No builder for ${m.mapBuilder}`);
      const mapData = builder();
      assert.ok(mapData.tiles instanceof Map, `${m.id}: tiles is not a Map`);
      assert.ok(mapData.heroStart, `${m.id}: missing heroStart`);
      assert.ok(typeof mapData.cols === 'number', `${m.id}: missing cols`);
      assert.ok(typeof mapData.rows === 'number', `${m.id}: missing rows`);
    }
  });

  test('Chapter 1 has 13 missions total (tutorial + 7 story + 5 villages)', () => {
    assert.equal(hollowDef.missions.length, 13);
  });

  test('the folded-in tutorial is the first mission', () => {
    assert.equal(hollowDef.missions[0].id, 'tutorial');
    assert.equal(hollowDef.missions[0].isTutorial, true);
  });

  test('mission prerequisites form a valid chain', () => {
    const completed = new Set();
    for (const m of hollowDef.missions) {
      if (m.requires) {
        for (const req of m.requires) {
          assert.ok(completed.has(req), `${m.id} requires ${req} which hasn't appeared yet`);
        }
      }
      completed.add(m.id);
    }
  });

  test('firstMission matches the first mission id', () => {
    assert.equal(hollowDef.firstMission, hollowDef.missions[0].id);
  });
});

// ── GameState: no-witch mode ─────────────────────────────────────────────────

describe('GameState no-witch mode', () => {
  test('GameState can be created without a witch', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.witch, null);
    assert.ok(state.hero);
    assert.ok(state.hero.alive);
  });

  test('witch faction is registered but has no leader', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const witchPlayer = state.players.find(p => p.faction === 'witch');
    assert.ok(witchPlayer);
    assert.equal(witchPlayer.leaderId, null);
  });

  test('factionEliminated returns false for no-witch faction', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.factionEliminated('witch'), false);
  });

  test('checkVictory does not crash with null witch', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.checkVictory();
    assert.equal(state.gameOver, false);
  });

  test('no-witch game with witch entities still tracks them', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const z = createZombie(3, 3, 'witch');
    state.entities.push(z);
    assert.equal(state.entities.filter(e => e.owner === 'witch').length, 1);
  });
});

// ── Victory delegate ────────────────────────────────────────────────────────

/** Create a survivor entity owned by the hero faction (matches in-game discovery). */
function makeHeroSurvivor(col, row) {
  const s = createSurvivor(col, row, 'hero');
  s.owner = 'hero';
  return s;
}

describe('Victory delegate', () => {
  test('eliminate_all triggers when all witch entities dead', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'hero');
  });

  test('eliminate_all does not trigger while enemies alive', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.entities.push(createZombie(3, 3, 'witch'));
    const result = delegate(state);
    assert.equal(result, null);
  });

  test('survive_rounds triggers after N rounds', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'survive_rounds', rounds: 5 },
      lose: { type: 'hero_killed' },
    });
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 5;
    assert.equal(delegate(state), null);
    state.round = 6;
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'hero');
  });

  test('hero_killed loss condition triggers on hero death', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    const mapData = buildMap('prologue');
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.hero.hp = 0;
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'witch');
  });

  test('slay_witch triggers when witch faction eliminated', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'slay_witch' },
      lose: { type: 'hero_killed' },
    });
    const state = new GameState(true, false);
    state.witch.hp = 0;
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'hero');
  });

  test('victoryDelegate is called by checkVictory', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.victoryDelegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    state.checkVictory();
    assert.equal(state.winner, 'hero');
  });

  // gather_and_survive — Mission 2 win type
  describe('gather_and_survive win type', () => {
    function buildGatherState() {
      const mapData = buildMap('gathering_survivors');
      mapData.noWitch = true;
      const state = new GameState(true, false, 'skirmish', null, mapData);
      state.heroKills = 0;
      return state;
    }

    test('does not win with only 1 survivor', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'gather_and_survive', survivors: 2, kills: 4, phaseFallback: 'dusk' },
      });
      const state = buildGatherState();
      state.entities.push(makeHeroSurvivor(2, 2));
      state.heroKills = 10;
      assert.equal(delegate(state), null);
    });

    test('wins when survivor count AND kill quota are met', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'gather_and_survive', survivors: 2, kills: 4, phaseFallback: 'dusk' },
      });
      const state = buildGatherState();
      state.entities.push(makeHeroSurvivor(2, 2), makeHeroSurvivor(3, 3));
      state.heroKills = 4;
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'hero');
    });

    test('wins when survivor count met and phase fallback reached, even without kills', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'gather_and_survive', survivors: 2, kills: 4, phaseFallback: 'dusk' },
      });
      const state = buildGatherState();
      state.entities.push(makeHeroSurvivor(2, 2), makeHeroSurvivor(3, 3));
      state.heroKills = 0;
      state.phase = Phase.DUSK;
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'hero');
    });

    test('does not count dead survivors', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'gather_and_survive', survivors: 2, kills: 4, phaseFallback: 'dusk' },
      });
      const state = buildGatherState();
      const s1 = makeHeroSurvivor(2, 2);
      const s2 = makeHeroSurvivor(3, 3);
      s2.hp = 0; // alive is a getter (hp > 0)
      state.entities.push(s1, s2);
      state.heroKills = 10;
      assert.equal(delegate(state), null);
    });
  });

  // phase_without_survivors — Mission 2 lose type
  describe('phase_without_survivors lose type', () => {
    test('loses at dusk when survivors < threshold', () => {
      const delegate = buildVictoryDelegate({
        lose: { type: 'phase_without_survivors', phase: 'dusk', survivors: 2 },
      });
      const mapData = buildMap('gathering_survivors');
      mapData.noWitch = true;
      const state = new GameState(true, false, 'skirmish', null, mapData);
      state.phase = Phase.DUSK;
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'witch');
    });

    test('does not lose at dusk when survivors meet threshold', () => {
      const delegate = buildVictoryDelegate({
        lose: { type: 'phase_without_survivors', phase: 'dusk', survivors: 2 },
      });
      const mapData = buildMap('gathering_survivors');
      mapData.noWitch = true;
      const state = new GameState(true, false, 'skirmish', null, mapData);
      state.phase = Phase.DUSK;
      state.entities.push(makeHeroSurvivor(2, 2), makeHeroSurvivor(3, 3));
      assert.equal(delegate(state), null);
    });

    test('does not trigger before the target phase', () => {
      const delegate = buildVictoryDelegate({
        lose: { type: 'phase_without_survivors', phase: 'dusk', survivors: 2 },
      });
      const mapData = buildMap('gathering_survivors');
      mapData.noWitch = true;
      const state = new GameState(true, false, 'skirmish', null, mapData);
      state.phase = Phase.DAY;
      assert.equal(delegate(state), null);
    });
  });

  // survive_with_party — Mission 3 win type
  describe('survive_with_party win type', () => {
    function buildNightState() {
      const mapData = buildMap('first_night');
      const state = new GameState(true, false, 'standard', null, mapData);
      return state;
    }

    test('wins at dawn with 2+ survivors', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'survive_with_party', phase: 'dawn', survivors: 2 },
      });
      const state = buildNightState();
      state.entities.push(makeHeroSurvivor(2, 8), makeHeroSurvivor(3, 6));
      state.phase = Phase.DAWN;
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'hero');
    });

    test('does not win before dawn even with full party', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'survive_with_party', phase: 'dawn', survivors: 2 },
      });
      const state = buildNightState();
      state.entities.push(makeHeroSurvivor(2, 8), makeHeroSurvivor(3, 6));
      state.phase = Phase.NIGHT;
      assert.equal(delegate(state), null);
    });

    test('does not win at dawn with only 1 survivor', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'survive_with_party', phase: 'dawn', survivors: 2 },
      });
      const state = buildNightState();
      state.entities.push(makeHeroSurvivor(2, 8));
      state.phase = Phase.DAWN;
      assert.equal(delegate(state), null);
    });
  });

  // all_party_at_hexes — Mission 4 win type
  describe('all_party_at_hexes win type', () => {
    function buildCrossingState() {
      const mapData = buildMap('river_crossing');
      mapData.noWitch = true;
      const state = new GameState(true, false, 'standard', null, mapData);
      return state;
    }

    const winCond = {
      type: 'all_party_at_hexes',
      hexes: [{ col: 15, row: 4 }, { col: 14, row: 4 }, { col: 15, row: 3 }, { col: 15, row: 5 }],
    };

    test('wins when hero and both survivors stand on target hexes', () => {
      const delegate = buildVictoryDelegate({ win: winCond });
      const state = buildCrossingState();
      state.hero.col = 15; state.hero.row = 4;
      const s1 = makeHeroSurvivor(14, 4);
      const s2 = makeHeroSurvivor(15, 3);
      state.entities.push(s1, s2);
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'hero');
    });

    test('does not win if any party member is not on target hexes', () => {
      const delegate = buildVictoryDelegate({ win: winCond });
      const state = buildCrossingState();
      state.hero.col = 15; state.hero.row = 4;
      state.entities.push(makeHeroSurvivor(14, 4));
      state.entities.push(makeHeroSurvivor(5, 3)); // still on west bank
      assert.equal(delegate(state), null);
    });

    test('dead party members do not block the win', () => {
      const delegate = buildVictoryDelegate({ win: winCond });
      const state = buildCrossingState();
      state.hero.col = 15; state.hero.row = 4;
      state.entities.push(makeHeroSurvivor(14, 4));
      const dead = makeHeroSurvivor(3, 3);
      dead.hp = 0;
      state.entities.push(dead);
      // Note: with the survivors_below lose guard we would never actually
      // reach this state, but the win check itself should ignore dead party
      // members.
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'hero');
    });
  });

  // survivors_below — Mission 4 lose type
  describe('survivors_below lose type', () => {
    test('triggers whenever survivor count drops below threshold', () => {
      const delegate = buildVictoryDelegate({
        lose: { type: 'survivors_below', count: 2 },
      });
      const mapData = buildMap('river_crossing');
      mapData.noWitch = true;
      const state = new GameState(true, false, 'standard', null, mapData);
      state.entities.push(makeHeroSurvivor(2, 4));
      // Only 1 survivor — should trigger loss immediately.
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'witch');
    });

    test('does not trigger when the threshold is met', () => {
      const delegate = buildVictoryDelegate({
        lose: { type: 'survivors_below', count: 2 },
      });
      const mapData = buildMap('river_crossing');
      mapData.noWitch = true;
      const state = new GameState(true, false, 'standard', null, mapData);
      state.entities.push(makeHeroSurvivor(2, 4), makeHeroSurvivor(1, 5));
      assert.equal(delegate(state), null);
    });
  });

  // witch_denied_nodes / witch_holds_node — Mission 5 win/lose pair
  describe('witch_denied_nodes / witch_holds_node (Mission 5)', () => {
    function buildRitualState() {
      const mapData = buildMap('dark_ritual');
      mapData.noWitch = true;
      const state = new GameState(true, false, 'standard', null, mapData);
      state.disableScoring = true;
      // Clean slate so we can control node occupancy precisely.
      state.entities = state.entities.filter(e => e.type === 'paladin');
      return state;
    }

    test('witch_denied_nodes wins at target phase when witch holds no node', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'witch_denied_nodes', phase: 'dawn' },
      });
      const state = buildRitualState();
      state.phase = Phase.DAWN;
      // No witch units on any node.
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'hero');
    });

    test('witch_denied_nodes does not win on a non-target phase', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'witch_denied_nodes', phase: 'dawn' },
      });
      const state = buildRitualState();
      state.phase = Phase.NIGHT;
      assert.equal(delegate(state), null);
    });

    test('witch_denied_nodes does not win while witch still holds a node', () => {
      const delegate = buildVictoryDelegate({
        win: { type: 'witch_denied_nodes', phase: 'dawn' },
      });
      const state = buildRitualState();
      state.phase = Phase.DAWN;
      // Plant a witch unit on the Ritual Circle.
      state.entities.push(createMinion(5, 4, 'witch'));
      assert.equal(delegate(state), null);
    });

    test('witch_holds_node loses at target phase when witch still holds a node', () => {
      const delegate = buildVictoryDelegate({
        lose: { type: 'witch_holds_node', phase: 'dawn' },
      });
      const state = buildRitualState();
      state.phase = Phase.DAWN;
      state.entities.push(createMinion(5, 4, 'witch'));
      const result = delegate(state);
      assert.ok(result);
      assert.equal(result.winner, 'witch');
    });

    test('witch_holds_node does not fire before the target phase', () => {
      const delegate = buildVictoryDelegate({
        lose: { type: 'witch_holds_node', phase: 'dawn' },
      });
      const state = buildRitualState();
      state.phase = Phase.NIGHT;
      state.entities.push(createMinion(5, 4, 'witch'));
      assert.equal(delegate(state), null);
    });

    test('witch_holds_node does not fire when witch holds zero nodes', () => {
      const delegate = buildVictoryDelegate({
        lose: { type: 'witch_holds_node', phase: 'dawn' },
      });
      const state = buildRitualState();
      state.phase = Phase.DAWN;
      assert.equal(delegate(state), null);
    });
  });

  // Array lose conditions — Mission 2 combines hero_killed + phase_without_survivors
  test('lose array: first matching condition fires', () => {
    const delegate = buildVictoryDelegate({
      lose: [
        { type: 'hero_killed' },
        { type: 'phase_without_survivors', phase: 'dusk', survivors: 2 },
      ],
    });
    const mapData = buildMap('gathering_survivors');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    // Dusk with 0 survivors should still trigger the second condition
    state.phase = Phase.DUSK;
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'witch');
  });
});

// ── Campaign class ──────────────────────────────────────────────────────────

describe('Campaign class', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('new campaign starts at firstMission with empty roster', () => {
    const c = new Campaign(hollowDef);
    assert.equal(c.currentMission, 'tutorial');
    assert.equal(c.roster.length, 0);
    assert.equal(c.completedMissions.size, 0);
  });

  test('campaign stores campaignDef reference', () => {
    const c = new Campaign(hollowDef);
    assert.equal(c.campaignDef.id, 'calebs_hollow_prologue');
    assert.equal(c.campaignDef.missions.length, 13);
  });

  test('save slot defaults to slot 1', () => {
    const c = new Campaign(hollowDef);
    assert.equal(c.slotIndex, 1);
    assert.equal(c.saveSlot, 'campaign-calebs_hollow_prologue-slot1');
  });

  test('save slot reflects the chosen slot index', () => {
    const c = new Campaign(hollowDef, 2);
    assert.equal(c.slotIndex, 2);
    assert.equal(c.saveSlot, 'campaign-calebs_hollow_prologue-slot2');
  });

  test('save and load round-trips', () => {
    const c = new Campaign(hollowDef);
    c.resources.herbs = 5;
    c.roster.push({ name: 'Abigail', hp: 3, maxHp: 4 });
    c.save();

    const c2 = new Campaign(hollowDef);
    const loaded = c2.load();
    assert.ok(loaded);
    assert.equal(c2.resources.herbs, 5);
    assert.equal(c2.roster.length, 1);
    assert.equal(c2.roster[0].name, 'Abigail');
  });

  test('save includes campaignId', () => {
    const c = new Campaign(hollowDef);
    c.save();
    const raw = JSON.parse(localStorage.getItem(`brimstone-campaign-calebs_hollow_prologue-slot1`));
    assert.equal(raw.campaignId, 'calebs_hollow_prologue');
  });

  test('new campaign starts with an empty fallen memorial', () => {
    const c = new Campaign(hollowDef);
    assert.deepEqual(c.fallen, []);
    assert.equal(c.version, 7); // SAVE_VERSION bumped 6 → 7
  });

  test('fallen round-trips through save/load (v7)', () => {
    const c = new Campaign(hollowDef);
    c.recordFallen([{ name: 'Abigail', title: 'Scout', level: 3, diedInMission: 'first_night' }]);
    c.save();
    const raw = JSON.parse(localStorage.getItem(`brimstone-campaign-calebs_hollow_prologue-slot1`));
    assert.equal(raw.version, 7);
    assert.equal(raw.fallen.length, 1);

    const c2 = new Campaign(hollowDef);
    assert.ok(c2.load());
    assert.equal(c2.fallen.length, 1);
    assert.equal(c2.fallen[0].name, 'Abigail');
    assert.equal(c2.fallen[0].diedInMission, 'first_night');
    assert.equal(c2.fallen[0].level, 3);
  });

  test('a v6 save migrates to v7 with fallen backfilled to []', () => {
    // Hand-write a v6 blob (no `fallen` field) into the slot key, then load it.
    const v6 = {
      campaignId: 'calebs_hollow_prologue', version: 6,
      currentMission: 'prologue', completedMissions: ['tutorial'],
      roster: [{ name: 'Bob', hp: 4, maxHp: 4, items: {} }],
      resources: { herbs: 2 }, weapons: {},
      heroStats: { hp: 50, maxHp: 98, attack: 2, defense: 2, level: 1, xp: 0, items: {} },
      storyFlags: {}, updatedAt: Date.now(),
    };
    localStorage.setItem('brimstone-campaign-calebs_hollow_prologue-slot1', JSON.stringify(v6));

    const c = new Campaign(hollowDef);
    assert.ok(c.load());
    assert.equal(c.version, 7, 'migrated to v7');
    assert.deepEqual(c.fallen, [], 'fallen backfilled to empty');
    assert.equal(c.roster.length, 1, 'roster preserved through migration');
    assert.equal(c.roster[0].name, 'Bob');
    assert.equal(c.resources.herbs, 2, 'resources preserved');
    // The migrated form is persisted back so we don't re-migrate next load.
    const persisted = JSON.parse(localStorage.getItem('brimstone-campaign-calebs_hollow_prologue-slot1'));
    assert.equal(persisted.version, 7);
    assert.ok(Array.isArray(persisted.fallen));
  });

  test('fallen rides through the server sync blob (restoreFromServerData)', () => {
    // syncToServer/syncFromServer ship the whole data object as a JSON blob;
    // restoreFromServerData rebuilds it. Verify fallen survives that path.
    const src = new Campaign(hollowDef);
    src.recordFallen([{ name: 'Caleb', title: 'Hunter', level: 2, diedInMission: 'dark_ritual' }]);
    const blob = {
      campaignId: 'calebs_hollow_prologue', version: 7,
      currentMission: src.currentMission, completedMissions: [],
      roster: [], fallen: src.fallen,
      resources: {}, weapons: {}, heroStats: src.heroStats, storyFlags: {},
      updatedAt: Date.now(),
    };
    const dst = new Campaign(hollowDef);
    assert.ok(dst.restoreFromServerData(JSON.parse(JSON.stringify(blob))));
    assert.equal(dst.fallen.length, 1);
    assert.equal(dst.fallen[0].name, 'Caleb');
    assert.equal(dst.fallen[0].diedInMission, 'dark_ritual');
  });

  test('delete clears save', () => {
    const c = new Campaign(hollowDef, 2);
    c.save();
    assert.ok(Campaign.exists(hollowDef, 2));
    c.delete();
    assert.ok(!Campaign.exists(hollowDef, 2));
  });

  test('getMissionList returns correct statuses', () => {
    const c = new Campaign(hollowDef);
    const list = c.getMissionList();
    assert.equal(list.length, 13);     // tutorial + 7 story + 5 villages
    // On a fresh save only the two prereq-free openers are playable.
    assert.ok(list[0].available);      // tutorial — no prereqs
    assert.ok(list[1].available);      // prologue (The Awakening) — no prereqs either
    for (let i = 2; i < list.length; i++) {
      assert.ok(!list[i].available, `${list[i].id} should be locked on a fresh save`);
    }
  });

  test('getMissionList visibility shows only completed + playable + immediate-next', () => {
    const c = new Campaign(hollowDef);
    const list = c.getMissionList();
    assert.ok(list[0].visible);        // tutorial — playable now
    assert.ok(list[1].visible);        // prologue — also playable now (no prereqs)
    assert.ok(list[2].visible);        // gathering_survivors — one step away from prologue
    for (let i = 3; i < list.length; i++) {
      assert.ok(!list[i].visible, `${list[i].id} should be hidden on a fresh save`);
    }

    // Completing The Awakening promotes gathering_survivors to playable and
    // reveals the next mission after it.
    c.completedMissions.add('prologue');
    const list2 = c.getMissionList();
    assert.ok(list2[0].visible && list2[0].available); // tutorial — still playable
    assert.ok(list2[1].visible && list2[1].completed); // prologue — completed
    assert.ok(list2[2].visible && list2[2].available); // gathering_survivors — now playable
    assert.ok(list2[3].visible && !list2[3].available);// first_night — now one step away
    assert.ok(!list2[4].visible);                      // river_crossing — still hidden
  });

  test('getMissionDef looks up from campaignDef missions', () => {
    const c = new Campaign(hollowDef);
    const m = c.getMissionDef('prologue');
    assert.ok(m);
    assert.equal(m.title, 'The Awakening');
  });

  test('getMapBuilder returns builder from campaignDef', () => {
    const c = new Campaign(hollowDef);
    const builder = c.getMapBuilder('prologue');
    assert.equal(typeof builder, 'function');
    const mapData = builder();
    assert.ok(mapData.tiles instanceof Map);
  });

  test('applyMissionResult advances campaign on victory', () => {
    const c = new Campaign(hollowDef);
    // The tutorial (Chapter 1 M1) is already cleared; we're finishing M2.
    c.completedMissions.add('tutorial');
    c.currentMission = 'prologue';
    c.applyMissionResult('prologue', {
      won: true,
      survivors: [{ name: 'Martha', hp: 2, maxHp: 3, attack: 1, defense: 1 }],
      resources: { herbs: 3, food: 1 },
      heroStats: { hp: 12, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.ok(c.completedMissions.has('prologue'));
    assert.equal(c.currentMission, 'gathering_survivors');
    assert.equal(c.roster.length, 1);
    assert.equal(c.roster[0].name, 'Martha');
  });

  test('applyMissionResult applies rewards on victory', () => {
    const c = new Campaign(hollowDef);
    c.applyMissionResult('prologue', {
      won: true,
      survivors: [],
      resources: { herbs: 0 },
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.equal(c.resources.herbs, 2);
    assert.equal(c.resources.food, 1);
  });

  test('applyMissionResult does not advance on defeat', () => {
    const c = new Campaign(hollowDef);
    // Sitting on The Awakening (M2) with the tutorial already cleared.
    c.completedMissions.add('tutorial');
    c.currentMission = 'prologue';
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.ok(!c.completedMissions.has('prologue'));
    assert.equal(c.currentMission, 'prologue');
  });

  // ── Task A: post-mission survivor rewards (rewards.survivors hook) ─────────
  test('rosterSnapshotFromName builds a roster entry from a named roster char', () => {
    const snap = rosterSnapshotFromName('Mary Quinn');
    assert.ok(snap, 'expected a snapshot for a known roster name');
    assert.equal(snap.name, 'Mary Quinn');
    assert.equal(snap.title, 'Nurse');
    assert.equal(snap.hp, snap.maxHp);     // arrives at full health
    assert.equal(snap.level, 1);
    assert.deepEqual(snap.items, {});      // no carried gear
    assert.ok(Array.isArray(snap.abilities));
  });

  test('rosterSnapshotFromName returns null for an unknown name', () => {
    assert.equal(rosterSnapshotFromName('Nobody At All'), null);
  });

  test('grantRewardSurvivors adds a named survivor to the roster', () => {
    const c = new Campaign(hollowDef);
    const granted = c.grantRewardSurvivors([{ name: 'Thomas Putnam' }]);
    assert.deepEqual(granted, ['Thomas Putnam']);
    assert.equal(c.roster.length, 1);
    assert.equal(c.roster[0].name, 'Thomas Putnam');
  });

  test('grantRewardSurvivors with an empty spec adds a random roster survivor', () => {
    const c = new Campaign(hollowDef);
    const granted = c.grantRewardSurvivors([{}]);
    assert.equal(granted.length, 1);
    assert.equal(c.roster.length, 1);
    assert.equal(c.roster[0].name, granted[0]);
    assert.ok(SURVIVOR_ROSTER.some(s => s.name === granted[0]),
      'granted survivor must be a real roster character');
  });

  test('grantRewardSurvivors never duplicates a party member or fallen survivor', () => {
    const c = new Campaign(hollowDef);
    c.roster = [{ name: 'Mary Quinn', hp: 35, maxHp: 35 }];
    c.fallen = [{ name: 'Thomas Putnam' }];
    // Many empty specs — must draw distinct, fresh names each time.
    const granted = c.grantRewardSurvivors([{}, {}, {}]);
    assert.equal(granted.length, 3);
    const names = new Set(granted);
    assert.equal(names.size, 3, 'granted names must be distinct');
    assert.ok(!names.has('Mary Quinn'), 'must not re-grant a party member');
    assert.ok(!names.has('Thomas Putnam'), 'must not resurrect a fallen survivor');
  });

  test('completing Mission 3 (first_night) grants the promised survivor', () => {
    const c = new Campaign(hollowDef);
    // Stand at first_night with the chain already cleared.
    for (const id of ['tutorial', 'prologue', 'gathering_survivors']) c.completedMissions.add(id);
    c.currentMission = 'first_night';
    const before = c.roster.length;
    c.applyMissionResult('first_night', {
      won: true,
      survivors: [],            // no survivors carried out of the mission
      resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, items: {} },
    });
    assert.ok(c.completedMissions.has('first_night'));
    assert.equal(c.roster.length, before + 1,
      'beating Mission 3 must add the promised new ally to the roster');
    assert.ok(SURVIVOR_ROSTER.some(s => s.name === c.roster[0].name));
  });

  test('Mission 3 reward survivor persists across save/load', () => {
    localStorage.clear();
    const c = new Campaign(hollowDef);
    for (const id of ['tutorial', 'prologue', 'gathering_survivors']) c.completedMissions.add(id);
    c.currentMission = 'first_night';
    c.applyMissionResult('first_night', {
      won: true, survivors: [], resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, items: {} },
    });
    const grantedName = c.roster[0].name;
    const reloaded = new Campaign(hollowDef);
    assert.ok(reloaded.load(), 'save should reload');
    assert.equal(reloaded.roster.length, 1);
    assert.equal(reloaded.roster[0].name, grantedName);
    localStorage.clear();
  });

  // ── Task B: beating The Awakening completes a skipped tutorial ─────────────
  test('completing The Awakening (prologue) marks the tutorial complete too', () => {
    const c = new Campaign(hollowDef);
    // Tutorial was SKIPPED: not in completedMissions when we beat The Awakening.
    assert.ok(!c.completedMissions.has('tutorial'));
    c.currentMission = 'prologue';
    c.applyMissionResult('prologue', {
      won: true, survivors: [], resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, items: {} },
    });
    assert.ok(c.completedMissions.has('prologue'));
    assert.ok(c.completedMissions.has('tutorial'),
      'beating The Awakening must also flag the skipped tutorial complete');
  });

  test('The Awakening tutorial-completion is idempotent and does not fire on defeat', () => {
    const c = new Campaign(hollowDef);
    c.currentMission = 'prologue';
    // Defeat: nothing should be marked complete.
    c.applyMissionResult('prologue', {
      won: false, survivors: [], resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, items: {} },
    });
    assert.ok(!c.completedMissions.has('tutorial'));
    assert.ok(!c.completedMissions.has('prologue'));
    // Now win — tutorial flips complete and stays complete on a replay.
    c.applyMissionResult('prologue', {
      won: true, survivors: [], resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, items: {} },
    });
    assert.ok(c.completedMissions.has('tutorial'));
    c.applyMissionResult('prologue', {
      won: true, survivors: [], resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, items: {} },
    });
    assert.equal([...c.completedMissions].filter(id => id === 'tutorial').length, 1);
  });

  test('permadeath: dead survivors are removed from roster', () => {
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Alice', hp: 3, maxHp: 3 },
      { name: 'Bob', hp: 2, maxHp: 3 },
    ];
    c.applyMissionResult('prologue', {
      won: true,
      survivors: [{ name: 'Alice', hp: 3, maxHp: 3, attack: 1, defense: 1 }],
      resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.equal(c.roster.length, 1);
    assert.equal(c.roster[0].name, 'Alice');
  });

  test('isComplete returns false when missions remain', () => {
    const c = new Campaign(hollowDef);
    c.completedMissions.add('prologue');
    assert.ok(!c.isComplete());
  });

  test('isComplete returns true when all missions are completed', () => {
    const c = new Campaign(hollowDef);
    for (const m of hollowDef.missions) c.completedMissions.add(m.id);
    assert.ok(c.isComplete());
  });

  test('static isCampaignCompleted returns false with no save', () => {
    localStorage.clear();
    assert.ok(!Campaign.isCampaignCompleted(hollowDef));
  });

  test('static isCampaignCompleted returns true when all missions done', () => {
    localStorage.clear();
    const c = new Campaign(hollowDef);
    for (const m of hollowDef.missions) c.completedMissions.add(m.id);
    c.save();
    assert.ok(Campaign.isCampaignCompleted(hollowDef));
    localStorage.clear();
  });

  test('getStatus returns "new" for a fresh campaign', () => {
    const c = new Campaign(hollowDef);
    assert.equal(c.getStatus(), 'new');
    assert.equal(c.getCompletedCount(), 0);
    assert.equal(c.getMissionCount(), hollowDef.missions.length);
  });

  test('getStatus returns "in-progress" with some missions completed', () => {
    const c = new Campaign(hollowDef);
    c.completedMissions.add(hollowDef.missions[0].id);
    assert.equal(c.getStatus(), 'in-progress');
    assert.equal(c.getCompletedCount(), 1);
  });

  test('getStatus returns "completed" when all missions are completed', () => {
    const c = new Campaign(hollowDef);
    for (const m of hollowDef.missions) c.completedMissions.add(m.id);
    assert.equal(c.getStatus(), 'completed');
    assert.equal(c.getCompletedCount(), hollowDef.missions.length);
  });

  test('static getCampaignProgress returns "new" with no save', () => {
    localStorage.clear();
    const p = Campaign.getCampaignProgress(hollowDef);
    assert.equal(p.status, 'new');
    assert.equal(p.completed, 0);
    assert.equal(p.total, hollowDef.missions.length);
  });

  test('static getCampaignProgress reports in-progress from saved state', () => {
    localStorage.clear();
    const c = new Campaign(hollowDef);
    c.completedMissions.add(hollowDef.missions[0].id);
    c.save();
    const p = Campaign.getCampaignProgress(hollowDef);
    assert.equal(p.status, 'in-progress');
    assert.equal(p.completed, 1);
    assert.equal(p.total, hollowDef.missions.length);
    localStorage.clear();
  });

  test('static getCampaignProgress reports completed from saved state', () => {
    localStorage.clear();
    const c = new Campaign(hollowDef);
    for (const m of hollowDef.missions) c.completedMissions.add(m.id);
    c.save();
    const p = Campaign.getCampaignProgress(hollowDef);
    assert.equal(p.status, 'completed');
    assert.equal(p.completed, hollowDef.missions.length);
    assert.equal(p.total, hollowDef.missions.length);
    localStorage.clear();
  });

  test('getStatus for an empty-mission campaign stays "new"', () => {
    const emptyDef = { id: 'empty', title: 'Empty', description: '', missions: [], mapBuilders: {}, firstMission: null };
    const c = new Campaign(emptyDef);
    assert.equal(c.getStatus(), 'new');
    assert.equal(c.getMissionCount(), 0);
  });

  test('isComplete returns false for a campaign with no missions', () => {
    // Guard against Array.prototype.every() returning true for empty arrays —
    // an empty-missions definition is unpopulated, not complete.
    const emptyDef = { id: 'empty', title: 'Empty', description: '', missions: [], mapBuilders: {}, firstMission: null };
    const c = new Campaign(emptyDef);
    assert.equal(c.isComplete(), false);
    assert.equal(c.getStatus(), 'new');
  });
});

// ── snapshotSurvivor ────────────────────────────────────────────────────────

describe('snapshotSurvivor', () => {
  test('captures entity data correctly', () => {
    const entity = {
      name: 'Test', title: 'The Brave', bio: 'A hero',
      ability: 'brawler', abilityLabel: 'Brawler',
      color: '#ff0000',
      hp: 3, maxHp: 4, attack: 2, defense: 1,
      items: { sword: { count: 1, equipped: true }, herbs: { count: 1 } },
    };
    const snap = snapshotSurvivor(entity);
    assert.equal(snap.name, 'Test');
    assert.equal(snap.hp, 3);
    assert.equal(getEquippedWeaponIdOf(snap.items), 'sword');
    assert.deepEqual(snap.items, { sword: { count: 1, equipped: true }, herbs: { count: 1 } });
    entity.items.herbs.count = 99;
    assert.equal(snap.items.herbs.count, 1, 'snapshot deep-copies items');
  });
});

// ── Wave spawner ────────────────────────────────────────────────────────────

describe('Wave spawner', () => {
  test('processWaves spawns units on matching round', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 3;

    const waves = [
      { round: 3, units: [{ type: 'zombie', spawnAt: { col: 4, row: 4 } }] },
      { round: 5, units: [{ type: 'minion', spawnAt: { col: 5, row: 5 } }] },
    ];

    const initialCount = state.entities.length;
    const createFn = (type, col, row) => {
      if (type === 'zombie') return createZombie(col, row, 'witch');
      return createMinion(col, row, 'witch');
    };
    const logs = processWaves(state, waves, createFn);

    assert.equal(state.entities.length, initialCount + 1);
    assert.equal(logs.length, 1);
    const witchEntities = state.entities.filter(e => e.owner === 'witch');
    assert.equal(witchEntities.length, 1);
  });

  test('processWaves applies a per-unit level (scaled HP/ATK/DEF)', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 2;

    const waves = [
      { round: 2, units: [{ type: 'zombie', spawnAt: { col: 4, row: 4 }, level: 3 }] },
    ];
    const createFn = (type, col, row) => createZombie(col, row, 'witch');
    processWaves(state, waves, createFn);

    const z = state.entities.find(e => e.owner === 'witch');
    assert.ok(z, 'leveled zombie spawned');
    assert.equal(z.level, 3);
    assert.equal(z.maxHp, 21);          // zombie base 14 → L3 ×1.5
    assert.equal(z.getAttack(), 4);     // base 2 + (3−1)
    assert.equal(z.getDefense(), 1);    // base 0 + floor((3−1)/2)
  });

  test('explicit overrides still win over level scaling', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 2;

    const waves = [
      { round: 2, units: [{ type: 'zombie', spawnAt: { col: 4, row: 4 }, level: 3, overrides: { maxHp: 50, hp: 50 } }] },
    ];
    const createFn = (type, col, row) => createZombie(col, row, 'witch');
    processWaves(state, waves, createFn);

    const z = state.entities.find(e => e.owner === 'witch');
    assert.equal(z.level, 3, 'level still recorded (drives ATK/DEF)');
    assert.equal(z.maxHp, 50, 'explicit maxHp override wins over the level HP scale');
    assert.equal(z.getAttack(), 4, 'level ATK bonus still composes');
  });

  test('processWaves returns empty for null waves', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const logs = processWaves(state, null, () => {});
    assert.deepEqual(logs, []);
  });

  test('processWaves handles graveyard spawn location', () => {
    const mapData = buildMap('first_night');
    const state = new GameState(true, false, 'standard', null, mapData);
    state.round = 3;

    const waves = [
      { round: 3, units: [{ type: 'zombie', spawnAt: 'graveyard' }] },
    ];

    const initialCount = state.entities.length;
    const createFn = (type, col, row) => createZombie(col, row, 'witch');
    processWaves(state, waves, createFn);

    assert.equal(state.entities.length, initialCount + 1);
  });

  test('processWaves applies per-unit stat overrides', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 2;

    const waves = [
      { round: 2, units: [{ type: 'zombie', spawnAt: { col: 4, row: 4 }, overrides: { attack: 1 } }] },
    ];

    const createFn = (type, col, row) => createZombie(col, row, 'witch');
    processWaves(state, waves, createFn);

    const spawned = state.entities.filter(e => e.owner === 'witch');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].attack, 1, 'zombie attack should be overridden to 1');
    assert.equal(spawned[0].hp, 14, 'zombie HP should remain at default (2 × DAMAGE_SCALE)');
  });

  test('hero_kills trigger fires when heroKills >= count', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 1;
    state.heroKills = 2;

    const waves = [
      {
        id: 'golem-awakens',
        trigger: 'hero_kills',
        count: 3,
        units: [{ type: 'wood_golem', spawnAt: { col: 4, row: 4 }, overrides: { maxHp: 2, hp: 2, attack: 1, defense: 1 } }],
      },
    ];
    const createFn = (type, col, row) => createWoodGolem(col, row, 'witch');

    // Below threshold: no spawn
    const logs1 = processWaves(state, waves, createFn);
    assert.equal(state.entities.filter(e => e.type === EntityType.WOOD_GOLEM).length, 0);
    assert.equal(logs1.length, 0);

    // Threshold met: spawn
    state.heroKills = 3;
    const logs2 = processWaves(state, waves, createFn);
    const golems = state.entities.filter(e => e.type === EntityType.WOOD_GOLEM);
    assert.equal(golems.length, 1);
    assert.equal(golems[0].hp, 2);
    assert.equal(golems[0].attack, 1);
    assert.equal(golems[0].defense, 1);
    assert.equal(logs2.length, 1);
  });

  test('hero_kills trigger only fires once', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 1;
    state.heroKills = 5;

    const waves = [
      {
        id: 'golem-awakens',
        trigger: 'hero_kills',
        count: 3,
        units: [{ type: 'wood_golem', spawnAt: { col: 4, row: 4 }, overrides: { maxHp: 2, hp: 2, attack: 1, defense: 1 } }],
      },
    ];
    const createFn = (type, col, row) => createWoodGolem(col, row, 'witch');

    processWaves(state, waves, createFn);
    processWaves(state, waves, createFn);
    processWaves(state, waves, createFn);

    const golems = state.entities.filter(e => e.type === EntityType.WOOD_GOLEM);
    assert.equal(golems.length, 1, 'kill-triggered wave should only fire once');
  });

  test('area trigger fires when hero stands on a listed hex', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 1;
    state.hero.col = 4; state.hero.row = 4;

    const waves = [
      {
        id: 'area-ambush',
        trigger: 'area',
        hexes: [{ col: 4, row: 4 }, { col: 5, row: 4 }],
        units: [{ type: 'wood_golem', spawnAt: { col: 3, row: 3 } }],
      },
    ];
    const createFn = (type, col, row) => createWoodGolem(col, row, 'witch');

    const logs = processWaves(state, waves, createFn);
    const golems = state.entities.filter(e => e.type === EntityType.WOOD_GOLEM);
    assert.equal(golems.length, 1);
    assert.equal(logs.length, 1);
  });

  test('area trigger does not fire when hero is off the hex set', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 1;
    state.hero.col = 0; state.hero.row = 0;

    const waves = [
      {
        id: 'area-ambush',
        trigger: 'area',
        hexes: [{ col: 4, row: 4 }, { col: 5, row: 4 }],
        units: [{ type: 'wood_golem', spawnAt: { col: 3, row: 3 } }],
      },
    ];
    const createFn = (type, col, row) => createWoodGolem(col, row, 'witch');

    processWaves(state, waves, createFn);
    assert.equal(state.entities.filter(e => e.type === EntityType.WOOD_GOLEM).length, 0);
  });

  test('area trigger only fires once', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 1;
    state.hero.col = 4; state.hero.row = 4;

    const waves = [
      {
        id: 'area-ambush',
        trigger: 'area',
        hexes: [{ col: 4, row: 4 }],
        units: [{ type: 'wood_golem', spawnAt: { col: 3, row: 3 } }],
      },
    ];
    const createFn = (type, col, row) => createWoodGolem(col, row, 'witch');

    processWaves(state, waves, createFn);
    processWaves(state, waves, createFn);
    processWaves(state, waves, createFn);

    const golems = state.entities.filter(e => e.type === EntityType.WOOD_GOLEM);
    assert.equal(golems.length, 1, 'area-triggered wave should only fire once');
  });

  test('processWaves uses unit.spawnLog when provided', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 2;

    const waves = [
      {
        round: 2,
        units: [{
          type: 'zombie',
          spawnAt: { col: 4, row: 4 },
          spawnLog: '🗿 A custom message!',
        }],
      },
    ];
    const createFn = (type, col, row) => createZombie(col, row, 'witch');
    const logs = processWaves(state, waves, createFn);
    assert.equal(logs[0], '🗿 A custom message!');
  });
});

// ── Mission 1 balance ───────────────────────────────────────────────────────

describe('Mission 1 (The Awakening) balance', () => {
  const mission1 = hollowDef.missions.find(m => m.id === 'prologue');

  test('has 3 initial zombies (golem triggers after 3 kills)', () => {
    assert.equal(mission1.enemyUnits.length, 3);
    for (const eu of mission1.enemyUnits) {
      assert.equal(eu.type, 'zombie');
    }
  });

  test('all three initial zombies are weakened to attack 1', () => {
    const weakened = mission1.enemyUnits.filter(eu => eu.overrides?.attack === 1);
    assert.equal(weakened.length, 3, 'all three zombies weakened to attack 1');
  });

  // Mission 1 is now fully logic-graph driven (docs/09) — the golem spawn,
  // intro conversation, and win/lose live in `logic`, not waves/objectives.
  test('a kill-triggered logic spawn adds a weakened wood golem after 3 kills', () => {
    const g = mission1.logic;
    const kc = g.nodes.find(n => n.type === 'onKillCount');
    assert.ok(kc && kc.params.faction === 'hero' && kc.params.count === 3, 'onKillCount(hero, 3)');
    assert.ok(g.nodes.some(n => n.type === 'doOnce'), 'gated by a Do Once');
    const unit = g.nodes.find(n => n.type === 'spawnUnits').params.units[0];
    assert.equal(unit.type, 'wood_golem');
    // Weaker than the standard wood golem (maxHp 21, attack 2, defense 3).
    assert.equal(unit.overrides.maxHp, 14);
    assert.equal(unit.overrides.hp, 14);
    assert.equal(unit.overrides.attack, 1);
    assert.equal(unit.overrides.defense, 1);
  });

  test('phase cycle is daytime-only', () => {
    assert.deepEqual(mission1.phaseCycle.phases, ['dawn', 'day', 'day', 'day']);
    assert.equal(mission1.phaseCycle.loop, true);
  });

  test('win is graph-driven (witch-all-dead → hero win); hero-death loss is inherent, not in the graph', () => {
    assert.equal(mission1.objectives, undefined, 'legacy objectives removed — fully graph-driven');
    const g = mission1.logic;
    const win = g.nodes.find(n => n.type === 'winMission');
    assert.equal(win.params.winner, 'hero');
    const witchEv = g.nodes.find(n => n.type === 'factionEvent' && n.params.faction === 'witch');
    assert.ok(g.edges.some(e => e.from.node === witchEv.id && e.from.pin === 'onAllUnitsDead' && e.to.node === win.id));
    // Hero-death = loss is hard-coded in checkVictory, so the graph carries no
    // loseMission / hero-faction-event (see editor wishlist #4).
    assert.ok(!g.nodes.some(n => n.type === 'loseMission'), 'no redundant loseMission node');
    assert.ok(!g.nodes.some(n => n.type === 'factionEvent' && n.params.faction === 'hero'), 'no hero faction-event');
  });

  test('aiBudgetBonus is 0', () => {
    assert.equal(mission1.aiBudgetBonus, 0);
  });

  test('killing the last zombie spawns the golem before victory fires (engine-driven)', () => {
    // Regression: the golem must spawn (via the logic graph's onKillCount path,
    // inside endRound's postResolution pump) BEFORE the all-units-dead win check,
    // so a 3rd kill that empties the board doesn't fire a premature win.
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);

    const ctx = createGameContext(state, {
      createEnemyFn: (type, col, row, s) => createWoodGolem(col, row, 'witch', s),
      emit: (e) => state.logicPresentation.push(e),
    });
    state.attachLogicEngine(new MissionLogicEngine(mission1.logic, ctx));

    // All initial zombies killed this round, heroKills == 3, board momentarily
    // empty of witch units — the golem should spawn before the win is evaluated.
    state.entities = state.entities.filter(e => e.owner !== 'witch');
    state.heroKills = 3;

    state.endRound();

    assert.equal(state.winner, null, 'should not have won yet — golem just spawned');
    assert.equal(state.gameOver, false, 'game should still be in progress');
    const golems = state.entities.filter(e => e.type === EntityType.WOOD_GOLEM);
    assert.equal(golems.length, 1, 'weakened wood golem should have spawned via the graph');
  });
});

// ── Disable scoring ─────────────────────────────────────────────────────────

describe('disableScoring', () => {
  test('disableScoring flag is set from mapDataOverride', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    mapData.disableScoring = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.disableScoring, true);
  });

  test('disableScoring defaults to false', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.disableScoring, false);
  });

  test('endRound skips node scoring when disableScoring is true', () => {
    const mapData = buildMap('first_night');
    mapData.disableScoring = true;
    const state = new GameState(true, false, 'standard', null, mapData);
    state.disableScoring = true;

    const initialScore = { ...state.nodeScore };
    for (let i = 0; i < 8; i++) {
      state.endRound();
      if (state.gameOver) break;
    }
    assert.deepEqual(state.nodeScore, initialScore);
  });

  test('all prologue missions have disableScoring set', () => {
    for (const m of hollowDef.missions) {
      assert.equal(typeof m.disableScoring, 'boolean', `${m.id} missing disableScoring`);
    }
  });
});

// ── Roster balancing (min/max survivors) ─────────────────────────────────────

describe('Roster balancing config', () => {
  test('witchs_trail mission has minSurvivors and maxSurvivors', () => {
    const m = hollowDef.missions.find(m => m.id === 'witchs_trail');
    assert.equal(m.minSurvivors, 2);
    // START-only party cap: witchs_trail was authored at 5 but is clamped to the
    // ≤3 cap (in both JSON and code) — no mission may start with >3 survivors.
    assert.equal(m.maxSurvivors, 3);
  });

  test('no mission START params exceed the ≤3 party cap', () => {
    // The START-only cap (PARTY_CAP=3 / ≤4 total units) is enforced in code
    // (main.js clamps + a final guard), but the mission JSON should also reflect
    // the intent so no authored value silently relies on the clamp. Asserts the
    // two start drivers — deploy-from-roster and the max-balancing bound — are
    // each ≤3 across every campaign mission.
    for (const m of hollowDef.missions) {
      if (m.maxSurvivorsFromRoster != null) {
        assert.ok(m.maxSurvivorsFromRoster <= 3,
          `${m.id}: maxSurvivorsFromRoster (${m.maxSurvivorsFromRoster}) exceeds the start cap of 3`);
      }
      if (m.maxSurvivors != null) {
        assert.ok(m.maxSurvivors <= 3,
          `${m.id}: maxSurvivors (${m.maxSurvivors}) exceeds the start cap of 3`);
      }
      if (m.minSurvivors != null) {
        assert.ok(m.minSurvivors <= 3,
          `${m.id}: minSurvivors (${m.minSurvivors}) exceeds the start cap of 3`);
      }
    }
  });

  test('minSurvivors <= maxSurvivors when both set', () => {
    for (const m of hollowDef.missions) {
      if (m.minSurvivors != null && m.maxSurvivors != null) {
        assert.ok(m.minSurvivors <= m.maxSurvivors,
          `${m.id}: minSurvivors (${m.minSurvivors}) > maxSurvivors (${m.maxSurvivors})`);
      }
    }
  });

  test('maxSurvivors >= maxSurvivorsFromRoster when both set', () => {
    for (const m of hollowDef.missions) {
      if (m.maxSurvivors != null && m.maxSurvivorsFromRoster != null) {
        assert.ok(m.maxSurvivors >= m.maxSurvivorsFromRoster || m.maxSurvivorsFromRoster === 0,
          `${m.id}: maxSurvivors < maxSurvivorsFromRoster`);
      }
    }
  });

  test('missions without min/max are valid (fields are optional)', () => {
    const m = hollowDef.missions.find(m => m.id === 'prologue');
    // These fields are optional; should be undefined or null
    assert.ok(m.minSurvivors == null || typeof m.minSurvivors === 'number');
  });

  test('balancing: too many survivors get trimmed', () => {
    // Simulate the balancing logic from _initCampaignMission
    const mapData = buildMap('witchs_trail');
    const state = new GameState(true, false, 'standard', null, mapData);
    const max = 3;
    // Add 5 survivors (exceeding max of 3)
    for (let i = 0; i < 5; i++) {
      const s = createSurvivor(2 + i, 9, 'hero');
      s.owner = 'hero';
      state.entities.push(s);
    }
    const heroSurvivors = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    );
    assert.equal(heroSurvivors.length, 5);

    // Trim excess
    const excess = heroSurvivors.slice(max);
    for (const s of excess) {
      state.entities.splice(state.entities.indexOf(s), 1);
    }
    const remaining = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    );
    assert.equal(remaining.length, 3);
  });

  test('balancing: too few survivors get reinforced', () => {
    const mapData = buildMap('witchs_trail');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'standard', null, mapData);
    const min = 1;
    // No survivors deployed — below minimum
    const count = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    ).length;
    assert.equal(count, 0);

    // Spawn reinforcements
    const heroStart = mapData.heroStart;
    const spots = getNeighbors(heroStart.col, heroStart.row);
    for (let i = count; i < min && spots.length > 0; i++) {
      const spot = spots.shift();
      const s = createSurvivor(spot.col, spot.row, 'hero');
      s.owner = 'hero';
      state.entities.push(s);
    }
    const newCount = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    ).length;
    assert.equal(newCount, min);
  });
});

// ── markRosterUsedByName ─────────────────────────────────────────────────────

describe('markRosterUsedByName', () => {
  beforeEach(() => {
    resetRoster();
  });

  test('marked survivor is not generated by createSurvivor', () => {
    const targetName = SURVIVOR_ROSTER[0].name;
    markRosterUsedByName(targetName);

    // Create up to the remaining available roster entries
    const remaining = SURVIVOR_ROSTER.length - 1;
    const created = [];
    for (let i = 0; i < remaining; i++) {
      created.push(createSurvivor(0, 0, 'hero'));
    }
    const match = created.find(s => s.name === targetName);
    assert.equal(match, undefined, `${targetName} should not appear after being marked used`);
  });

  test('multiple marked survivors are all excluded', () => {
    const name1 = SURVIVOR_ROSTER[0].name;
    const name2 = SURVIVOR_ROSTER[1].name;
    markRosterUsedByName(name1);
    markRosterUsedByName(name2);

    // Create fewer than the remaining available roster entries to avoid
    // the exhaustion fallback which picks from the full list.
    const remaining = SURVIVOR_ROSTER.length - 2;
    const created = [];
    for (let i = 0; i < remaining; i++) {
      created.push(createSurvivor(0, 0, 'hero'));
    }
    assert.ok(!created.some(s => s.name === name1), `${name1} should be excluded`);
    assert.ok(!created.some(s => s.name === name2), `${name2} should be excluded`);
  });

  test('marking unknown name does not crash', () => {
    markRosterUsedByName('Nonexistent Person');
    // Should not throw, just no-op
    const s = createSurvivor(0, 0, 'hero');
    assert.ok(s.name);
  });
});

// ── maxDiscoverableSurvivors config ────────────────────────────────────────

describe('maxDiscoverableSurvivors config', () => {
  test('mission 1 has no discoverable survivors, mission 2 allows up to 4', () => {
    const m1 = hollowDef.missions.find(m => m.id === 'prologue');
    const m2 = hollowDef.missions.find(m => m.id === 'gathering_survivors');
    assert.equal(m1.maxDiscoverableSurvivors, 0);
    assert.equal(m2.maxDiscoverableSurvivors, 4);
  });

  test('mission 3 does not offer discoverable survivors (fixed-party siege)', () => {
    const m3 = hollowDef.missions.find(m => m.id === 'first_night');
    assert.equal(m3.maxDiscoverableSurvivors, 0);
  });

  test('later missions do not restrict discoverable survivors', () => {
    const late = hollowDef.missions.find(m => m.id === 'witchs_trail');
    assert.equal(late.maxDiscoverableSurvivors, undefined);
  });
});

// ── disableScoring on missions ─────────────────────────────────────────────

describe('disableScoring on missions', () => {
  test('prologue missions have disableScoring set (true except witchs_trail)', () => {
    for (const m of hollowDef.missions) {
      // The conductor-driven tutorial teaches scoring live, so its flag is
      // incidental — skip it here.
      if (m.isTutorial) continue;
      // Scoring-driven battles opt INTO node scoring: witchs_trail uses it as a
      // loss condition, and the optional "battle for the nodes" villages win/lose
      // on the score threshold. Every other (node-less) story mission disables it.
      const scoringBattle = m.id === 'witchs_trail' || m.id.startsWith('village_');
      const expected = scoringBattle ? false : true;
      assert.equal(m.disableScoring, expected,
        `${m.id} disableScoring should be ${expected}`);
    }
  });
});

// ── New map builders ──────────────────────────────────────────────────────

describe('new campaign map builders', () => {
  for (const key of ['gathering_survivors', 'river_crossing', 'dark_ritual']) {
    test(`${key} builder produces valid mapData`, () => {
      const mapData = buildMap(key);
      assert.ok(mapData.tiles instanceof Map, `${key}: tiles should be a Map`);
      assert.ok(mapData.tiles.size > 0, `${key}: tiles should be non-empty`);
      assert.ok(mapData.heroStart, `${key}: should have heroStart`);
      assert.ok(mapData.witchStart, `${key}: should have witchStart`);
      assert.ok(typeof mapData.cols === 'number', `${key}: should have cols`);
      assert.ok(typeof mapData.rows === 'number', `${key}: should have rows`);
      assert.ok(mapData.mapSize, `${key}: should have mapSize`);
    });
  }

  test('river_crossing map is a wide corridor (17x9)', () => {
    const mapData = buildMap('river_crossing');
    assert.equal(mapData.cols, 17);
    assert.equal(mapData.rows, 9);
  });

  test('dark_ritual has 2 power nodes', () => {
    const mapData = buildMap('dark_ritual');
    assert.equal(mapData.witchObjectives.length, 2);
  });

  test('gathering_survivors has no power nodes', () => {
    const mapData = buildMap('gathering_survivors');
    assert.equal(mapData.witchObjectives.length, 0);
  });
});

// ── Story triggers ────────────────────────────────────────────────────────

describe('processStoryTriggers', () => {
  test('round trigger fires on correct round', () => {
    const state = { round: 3, hero: { col: 0, row: 0 } };
    const triggers = [
      { type: 'round', round: 3, title: 'Test', text: 'Hello', flag: 'test_flag' },
    ];
    const flags = {};
    const events = processStoryTriggers(state, triggers, flags);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Test');
    assert.ok(flags.test_flag);
  });

  test('round trigger does not fire on wrong round', () => {
    const state = { round: 2, hero: { col: 0, row: 0 } };
    const triggers = [
      { type: 'round', round: 3, title: 'Test', text: 'Hello', flag: 'test_flag' },
    ];
    const events = processStoryTriggers(state, triggers, {});
    assert.equal(events.length, 0);
  });

  test('area trigger fires when hero is on hex', () => {
    const state = { round: 1, hero: { col: 5, row: 3 } };
    const triggers = [
      { type: 'area', hexes: [{ col: 5, row: 3 }], title: 'Found', text: 'Here', flag: 'area_flag' },
    ];
    const flags = {};
    const events = processStoryTriggers(state, triggers, flags);
    assert.equal(events.length, 1);
    assert.ok(flags.area_flag);
  });

  test('flag prevents re-firing', () => {
    const state = { round: 3, hero: { col: 0, row: 0 } };
    const triggers = [
      { type: 'round', round: 3, title: 'Test', text: 'Hello', flag: 'already_seen' },
    ];
    const flags = { already_seen: true };
    const events = processStoryTriggers(state, triggers, flags);
    assert.equal(events.length, 0);
  });

  test('returns empty for null triggers', () => {
    const events = processStoryTriggers({}, null, {});
    assert.equal(events.length, 0);
  });
});

// ── Mission content validation ────────────────────────────────────────────

describe('mission story triggers and loot overrides', () => {
  test('all missions with storyTriggers have valid trigger structure', () => {
    for (const m of hollowDef.missions) {
      if (!m.storyTriggers) continue;
      for (const t of m.storyTriggers) {
        assert.ok(t.type === 'round' || t.type === 'area', `${m.id}: trigger must be round or area`);
        if (t.conversation) {
          // Conversation trigger: must reference a declared conversation; the
          // flag is optional (no flag = replays every mission attempt).
          assert.ok(
            (m.conversations ?? []).some(c => c.id === t.conversation),
            `${m.id}: trigger references unknown conversation "${t.conversation}"`,
          );
        } else {
          assert.ok(t.title, `${m.id}: trigger must have title`);
          assert.ok(t.text, `${m.id}: trigger must have text`);
          assert.ok(t.flag, `${m.id}: trigger must have flag`);
        }
        if (t.type === 'round') assert.ok(typeof t.round === 'number', `${m.id}: round trigger needs round`);
        if (t.type === 'area') assert.ok(Array.isArray(t.hexes), `${m.id}: area trigger needs hexes`);
      }
    }
  });

  test('missions with lootOverrides have valid structure', () => {
    for (const m of hollowDef.missions) {
      if (!m.lootOverrides) continue;
      if (m.lootOverrides.remove) {
        assert.ok(Array.isArray(m.lootOverrides.remove), `${m.id}: remove should be array`);
      }
    }
  });

  test('river_crossing uses all_party_at_hexes objective', () => {
    const win = graphFacts(hollowDef.missions.find(m => m.id === 'river_crossing')).objectives.win;
    assert.equal(win.type, 'all_party_at_hexes');
    assert.ok(Array.isArray(win.hexes) && win.hexes.length >= 3);
  });

  test('dark_ritual has witch_holds_node lose condition', () => {
    const lose = graphFacts(hollowDef.missions.find(m => m.id === 'dark_ritual')).objectives.lose;
    assert.ok(lose.some(l => l.type === 'witch_holds_node'));
  });

  test('mission progression chain is valid (tutorial + 7 story + 5 villages)', () => {
    const ids = hollowDef.missions.map(m => m.id);
    assert.deepEqual(ids, [
      'tutorial', 'prologue', 'gathering_survivors', 'first_night',
      'river_crossing', 'dark_ritual',
      'village_marsh_end', 'village_thornwick', 'village_gallows_ferry',
      'village_ashford_mill', 'village_blackfen',
      'long_watch', 'witchs_trail',
    ]);
  });

  test('all story missions have a positive healBonus', () => {
    for (const m of hollowDef.missions) {
      assert.ok(typeof m.healBonus === 'number', `${m.id} should have healBonus`);
      // The tutorial is a brief teaching mission with no between-mission heal.
      if (m.isTutorial) continue;
      assert.ok(m.healBonus > 0, `${m.id} healBonus should be positive`);
    }
  });
});

// ── healBonus ─────────────────────────────────────────────────────────────

describe('healBonus on mission victory', () => {
  let campaign;

  beforeEach(() => {
    localStorage.clear();
    campaign = new Campaign(hollowDef);
  });

  test('heals hero and survivors on victory', () => {
    // Set up damaged hero and roster (HP on the scaled ×DAMAGE_SCALE pools)
    campaign.heroStats = { hp: 50, maxHp: 98, attack: 2, defense: 2, weapon: null, items: {} };
    campaign.roster = [
      { name: 'A', title: 'Test', bio: '', ability: 'BRAWLER', abilityLabel: 'Strong', color: '#fff', hp: 10, maxHp: 28, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'B', title: 'Test', bio: '', ability: 'HEAL', abilityLabel: 'Healer', color: '#fff', hp: 25, maxHp: 35, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    // Prologue mission has healBonus: 14
    campaign.applyMissionResult('prologue', {
      won: true,
      survivors: campaign.roster,
      heroStats: { ...campaign.heroStats },
      resources: {},
      flags: {},
    });

    assert.equal(campaign.heroStats.hp, 64); // 50 + 14
    assert.equal(campaign.roster[0].hp, 24); // 10 + 14
    assert.equal(campaign.roster[1].hp, 35); // 25 + 14, capped at maxHp 35
  });

  test('does not heal on defeat', () => {
    campaign.heroStats = { hp: 50, maxHp: 98, attack: 2, defense: 2, weapon: null, items: {} };
    campaign.roster = [
      { name: 'A', title: 'Test', bio: '', ability: 'BRAWLER', abilityLabel: 'Strong', color: '#fff', hp: 10, maxHp: 28, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    campaign.applyMissionResult('prologue', {
      won: false,
      survivors: campaign.roster,
      heroStats: { ...campaign.heroStats },
      resources: {},
      flags: {},
    });

    assert.equal(campaign.heroStats.hp, 50); // unchanged
    assert.equal(campaign.roster[0].hp, 10); // unchanged
  });

  test('heal is capped at maxHp', () => {
    // Use first_night which has healBonus: 21
    campaign.completedMissions.add('prologue');
    campaign.completedMissions.add('gathering_survivors');
    campaign.heroStats = { hp: 90, maxHp: 98, attack: 2, defense: 2, weapon: null, items: {} };
    campaign.roster = [
      { name: 'A', title: 'Test', bio: '', ability: 'BRAWLER', abilityLabel: 'Strong', color: '#fff', hp: 28, maxHp: 28, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    campaign.applyMissionResult('first_night', {
      won: true,
      survivors: campaign.roster,
      heroStats: { ...campaign.heroStats },
      resources: {},
      flags: {},
    });

    assert.equal(campaign.heroStats.hp, 98); // 90 + 21 capped at 98
    assert.equal(campaign.roster[0].hp, 28); // already full, stays at 28
  });

  test('no healBonus field means no healing', () => {
    // Create a campaign with a mission that has no healBonus
    const customDef = {
      id: 'test_campaign',
      title: 'Test',
      description: 'Test',
      firstMission: 'test_mission',
      prerequisiteCampaign: null,
      missions: [{
        id: 'test_mission', title: 'Test', briefing: 'Test',
        mapBuilder: 'prologue', objectives: { win: { type: 'eliminate_all' }, lose: { type: 'hero_killed' } },
        hasWitch: false, disableScoring: true, maxSurvivorsFromRoster: 0,
        // no healBonus
      }],
      mapBuilders: hollowDef.mapBuilders,
    };
    const c = new Campaign(customDef);
    c.heroStats = { hp: 5, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    c.roster = [
      { name: 'A', title: 'Test', bio: '', ability: 'BRAWLER', abilityLabel: 'Strong', color: '#fff', hp: 2, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    c.applyMissionResult('test_mission', {
      won: true,
      survivors: c.roster,
      heroStats: { ...c.heroStats },
      resources: {},
      flags: {},
    });

    assert.equal(c.heroStats.hp, 5); // no change
    assert.equal(c.roster[0].hp, 2); // no change
  });

  test('undeployed roster members are preserved after mission result', () => {
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Deployed', title: 'Test', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 4, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'StayedBehind', title: 'Safe', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
    ];
    // Simulate a mission where only 'Deployed' was in-game and survived
    const deployedSurvivors = [
      { name: 'Deployed', title: 'Test', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 2, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
    ];
    const deployedNames = new Set(deployedSurvivors.map(s => s.name));
    const undeployed = c.roster.filter(s => !deployedNames.has(s.name));
    const allSurvivors = [...deployedSurvivors, ...undeployed];

    c.applyMissionResult('prologue', {
      won: true,
      survivors: allSurvivors,
      heroStats: c.heroStats,
      resources: {},
      flags: {},
    });

    assert.equal(c.roster.length, 2, 'both survivors should be in roster');
    assert.ok(c.roster.some(s => s.name === 'Deployed'), 'deployed survivor preserved');
    assert.ok(c.roster.some(s => s.name === 'StayedBehind'), 'undeployed survivor preserved');
    // The mission applied is 'prologue' (The Awakening) — heal by ITS healBonus.
    const healBonus = hollowDef.missions.find(m => m.id === 'prologue').healBonus ?? 0;
    assert.equal(c.roster.find(s => s.name === 'Deployed').hp, Math.min(2 + healBonus, 4), 'deployed survivor HP updated + healed');
    assert.equal(c.roster.find(s => s.name === 'StayedBehind').hp, Math.min(3 + healBonus, 3), 'undeployed survivor also healed');
  });
});

// ── Mid-mission save/resume ───────────────────────────────────────────────

describe('Campaign mid-mission save/resume', () => {
  beforeEach(() => localStorage.clear());

  test('mid-mission save key format is correct', () => {
    const key = `brimstone_campaign_mission_calebs_hollow_prologue_prologue`;
    const data = { campaignId: 'calebs_hollow_prologue', missionId: 'prologue', state: {}, updatedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(data));
    const loaded = JSON.parse(localStorage.getItem(key));
    assert.equal(loaded.campaignId, 'calebs_hollow_prologue');
    assert.equal(loaded.missionId, 'prologue');
  });

  test('mid-mission save can be deleted', () => {
    const key = `brimstone_campaign_mission_calebs_hollow_prologue_prologue`;
    localStorage.setItem(key, JSON.stringify({ test: true }));
    assert.ok(localStorage.getItem(key));
    localStorage.removeItem(key);
    assert.equal(localStorage.getItem(key), null);
  });

  test('mission list detects in-progress saves', () => {
    const key = `brimstone_campaign_mission_calebs_hollow_prologue_prologue`;
    localStorage.setItem(key, JSON.stringify({ campaignId: 'calebs_hollow_prologue', missionId: 'prologue' }));
    const hasSave = localStorage.getItem(key) !== null;
    assert.ok(hasSave, 'should detect in-progress save');
  });
});

// ── Campaign AI budget bonus ──────────────────────────────────────────────

describe('Campaign AI budget bonus', () => {
  test('every prologue mission resolves to a sane witch budget bonus', () => {
    // aiBudgetBonus may be a static integer, omitted (→ 0, e.g. the optional
    // "normal vs AI" villages), or a dynamic { type:"missing_wins", … } object
    // (the Long Watch). In every case it must resolve to a finite bonus ≥ 0.
    const fullyCleared = new Campaign({ id: 'calebs_hollow_prologue', missions: hollowDef.missions, mapBuilders: {} });
    fullyCleared.completedMissions = new Set(hollowDef.missions.map(m => m.id));
    for (const m of hollowDef.missions) {
      const bonus = effectiveAiBudgetBonus(m, fullyCleared);
      assert.ok(Number.isFinite(bonus), `${m.id} aiBudgetBonus must resolve to a number`);
      assert.ok(bonus >= 0, `${m.id} aiBudgetBonus should be at least 0`);
    }
  });

  test('later missions have higher budget bonus', () => {
    const prologue = hollowDef.missions.find(m => m.id === 'prologue');
    const darkRitual = hollowDef.missions.find(m => m.id === 'dark_ritual');
    assert.ok(darkRitual.aiBudgetBonus > prologue.aiBudgetBonus,
      'dark_ritual should have higher budget bonus than prologue');
  });

  test('campaignAIBudgetBonus survives state serialization', async () => {
    const { serializeState, deserializeState } = await import('../server/state-sync.js');
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.campaignAIBudgetBonus = 3;
    const snap = serializeState(state);
    assert.equal(snap.campaignAIBudgetBonus, 3);
    const restored = deserializeState(snap);
    assert.equal(restored.campaignAIBudgetBonus, 3);
  });
});

// ── Leaderless plan (campaign AI) ─────────────────────────────────────────

describe('Leaderless plan improvements', () => {
  test('leaderless plan attacks adjacent heroes', async () => {
    const { WitchAIEngine } = await import('../src/ai-engine.js');
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    // Place a zombie adjacent to the hero
    const hero = state.hero;
    const neighbors = getNeighbors(hero.col, hero.row);
    const z = createZombie(neighbors[0].col, neighbors[0].row, 'witch');
    state.entities.push(z);
    state.startPlanning();
    const ai = new WitchAIEngine(state, () => {});
    const plan = ai.generatePlan();
    const battles = plan.filter(a => a.type === 'battle-unit');
    assert.ok(battles.length > 0, 'should have at least one battle action');
  });

  test('leaderless plan moves toward heroes when not adjacent', async () => {
    const { WitchAIEngine } = await import('../src/ai-engine.js');
    const mapData = buildMap('gathering_survivors');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    // Place a zombie far from hero
    const z = createZombie(9, 1, 'witch');
    state.entities.push(z);
    state.startPlanning();
    const ai = new WitchAIEngine(state, () => {});
    const plan = ai.generatePlan();
    const moves = plan.filter(a => a.type === 'move');
    assert.ok(moves.length > 0, 'should have at least one move action');
  });
});

// ── Mission failure preserves party state ────────────────────────────────

describe('Mission failure preserves party state', () => {
  beforeEach(() => localStorage.clear());

  test('defeat preserves roster (no permadeath on failure)', () => {
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'Bob', title: 'Guard', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 2, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
    ];
    c.save();

    // Simulate defeat: only Alice survived, Bob died in battle
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [{ name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 1, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} }],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });

    assert.equal(c.roster.length, 2, 'both roster members should be preserved on defeat');
    assert.ok(c.roster.some(s => s.name === 'Alice'), 'Alice should still be in roster');
    assert.ok(c.roster.some(s => s.name === 'Bob'), 'Bob should still be in roster (not permadeath on defeat)');
  });

  test('defeat preserves hero stats (no dead hero carry-over)', () => {
    const c = new Campaign(hollowDef);
    c.heroStats = { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: 'sword', items: { herbs: 2 } };
    c.save();

    // Simulate defeat: hero died (hp: 0)
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });

    assert.equal(c.heroStats.hp, 14, 'hero HP should be preserved at pre-mission value');
    assert.equal(c.heroStats.weapon, 'sword', 'hero weapon should be preserved');
    assert.deepEqual(c.heroStats.items, { herbs: 2 }, 'hero items should be preserved');
  });

  test('defeat preserves resources (no spent resources carry-over)', () => {
    const c = new Campaign(hollowDef);
    c.resources = { wood: 5, metal: 3, herbs: 2, food: 4, silver: 1, scripture: 0 };
    c.save();

    // Simulate defeat: resources were spent during mission
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [],
      resources: { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0 },
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });

    assert.equal(c.resources.wood, 5, 'wood should be preserved');
    assert.equal(c.resources.metal, 3, 'metal should be preserved');
    assert.equal(c.resources.herbs, 2, 'herbs should be preserved');
    assert.equal(c.resources.food, 4, 'food should be preserved');
  });

  test('defeat preserves story flags (no in-mission flags carry-over)', () => {
    const c = new Campaign(hollowDef);
    c.storyFlags = { intro_seen: true };
    c.save();

    // Simulate defeat: new flags were set during mission
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
      flags: { mid_mission_event: true },
    });

    assert.ok(c.storyFlags.intro_seen, 'pre-existing flags should be preserved');
    assert.equal(c.storyFlags.mid_mission_event, undefined, 'in-mission flags should not carry over on defeat');
  });

  test('dead deployed survivor is removed from roster on victory', () => {
    // Regression: previously, a survivor who died during a winning mission
    // was silently restored from the pre-mission roster because the
    // "undeployed" filter looked only at alive-at-end names.
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'Bob',   title: 'Guard', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    // Simulate end-of-mission state.entities: Alice alive, Bob was deployed but died.
    const entities = [
      { owner: 'hero', type: 'survivor', name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 1, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: true },
      { owner: 'hero', type: 'survivor', name: 'Bob',   title: 'Guard', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 0, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: false },
    ];
    const survivors = reconcileRosterAfterMission(c.roster, entities);

    c.applyMissionResult('prologue', {
      won: true,
      survivors,
      resources: {},
      heroStats: { hp: 10, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });

    assert.equal(c.roster.length, 1, 'dead survivor should be dropped from roster');
    assert.equal(c.roster[0].name, 'Alice');
    assert.ok(!c.roster.some(s => s.name === 'Bob'), 'Bob should not be resurrected from pre-mission roster');
  });

  test('reconcileRosterAfterMission keeps undeployed, drops dead deployed, keeps alive deployed', () => {
    const roster = [
      { name: 'Alice', hp: 3, maxHp: 3 },
      { name: 'Bob',   hp: 2, maxHp: 3 },
      { name: 'Carol', hp: 3, maxHp: 3 }, // never deployed — stays behind
    ];
    const entities = [
      // Alice deployed and survived with reduced HP
      { owner: 'hero', type: 'survivor', name: 'Alice', hp: 1, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: true },
      // Bob deployed and died
      { owner: 'hero', type: 'survivor', name: 'Bob',   hp: 0, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: false },
      // Hero and an enemy are also in the entity list — must be ignored
      { owner: 'hero',  type: 'hero',    name: null, hp: 10, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {}, alive: true },
      { owner: 'witch', type: 'zombie',  name: null, hp: 0,  maxHp: 2,  attack: 1, defense: 1, weapon: null, items: {}, alive: false },
    ];

    const result = reconcileRosterAfterMission(roster, entities);

    const names = result.map(s => s.name).sort();
    assert.deepEqual(names, ['Alice', 'Carol'], 'only Alice (survived) and Carol (undeployed) remain');
    assert.equal(result.find(s => s.name === 'Alice').hp, 1, 'Alice HP taken from end-of-mission entity');
    assert.equal(result.find(s => s.name === 'Carol').hp, 3, 'Carol HP taken from pre-mission roster');
  });

  test('reconcileRosterAfterMission handles empty roster and no survivor entities', () => {
    const result = reconcileRosterAfterMission([], [
      { owner: 'hero', type: 'hero', name: null, hp: 10, maxHp: 14, alive: true },
    ]);
    assert.deepEqual(result, []);
  });

  test('reconcileRosterAfterMission drops a roster survivor with the same name even if only dead deployed copy exists', () => {
    const roster = [{ name: 'Ghost', hp: 3, maxHp: 3 }];
    const entities = [
      { owner: 'hero', type: 'survivor', name: 'Ghost', hp: 0, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: false },
    ];
    const result = reconcileRosterAfterMission(roster, entities);
    assert.equal(result.length, 0, 'Ghost died in mission — gone from roster');
  });

  test('victory still applies permadeath and state changes', () => {
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'Bob', title: 'Guard', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 2, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
    ];
    c.heroStats = { hp: 98, maxHp: 98, attack: 2, defense: 2, weapon: null, items: {} };
    c.save();

    // Victory: only Alice survived
    c.applyMissionResult('prologue', {
      won: true,
      survivors: [{ name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 1, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} }],
      resources: { wood: 1 },
      heroStats: { hp: 80, maxHp: 98, attack: 2, defense: 2, items: { axe: { count: 1, equipped: true } } },
    });

    assert.equal(c.roster.length, 1, 'only surviving roster member on victory');
    assert.equal(c.roster[0].name, 'Alice');
    assert.equal(c.heroStats.hp, 94, 'hero HP updated + healBonus (prologue healBonus=14)');
    assert.equal(getEquippedWeaponIdOf(c.heroStats.items), 'axe', 'hero weapon updated on victory');
    assert.equal(c.resources.wood, 2, 'resources updated on victory (1 carry-forward + 1 reward)');
    assert.ok(c.completedMissions.has('prologue'), 'mission completed');
  });
});

// ── Custom phase cycles ────────────────────────────────────────────────────

describe('Custom phase cycles', () => {
  const daytimeLoop = { phases: ['dawn', 'day', 'day', 'day'], loop: true };
  const dayNightFixed = {
    phases: ['dawn', 'day', 'day', 'day', 'dusk', 'night', 'night', 'night'],
    loop: false,
  };

  describe('phaseForRound with looping custom cycle', () => {
    test('round 1 = dawn', () => {
      assert.equal(phaseForRound(1, daytimeLoop), 'dawn');
    });
    test('rounds 2-4 = day', () => {
      assert.equal(phaseForRound(2, daytimeLoop), 'day');
      assert.equal(phaseForRound(3, daytimeLoop), 'day');
      assert.equal(phaseForRound(4, daytimeLoop), 'day');
    });
    test('wraps: round 5 = dawn again', () => {
      assert.equal(phaseForRound(5, daytimeLoop), 'dawn');
    });
    test('wraps: round 8 = day', () => {
      assert.equal(phaseForRound(8, daytimeLoop), 'day');
    });
    test('wraps: round 9 = dawn (3rd cycle)', () => {
      assert.equal(phaseForRound(9, daytimeLoop), 'dawn');
    });
  });

  describe('phaseForRound with fixed custom cycle', () => {
    test('round 1 = dawn', () => {
      assert.equal(phaseForRound(1, dayNightFixed), 'dawn');
    });
    test('round 5 = dusk', () => {
      assert.equal(phaseForRound(5, dayNightFixed), 'dusk');
    });
    test('round 8 = night (last phase)', () => {
      assert.equal(phaseForRound(8, dayNightFixed), 'night');
    });
    test('round 9 clamps to last phase (night)', () => {
      assert.equal(phaseForRound(9, dayNightFixed), 'night');
    });
    test('round 20 still clamps to night', () => {
      assert.equal(phaseForRound(20, dayNightFixed), 'night');
    });
  });

  describe('phaseForRound without cycleConfig uses default', () => {
    test('null cycleConfig uses hardcoded 8-step cycle', () => {
      assert.equal(phaseForRound(1, null), 'dawn');
      assert.equal(phaseForRound(2, null), 'day');
      assert.equal(phaseForRound(5, null), 'dusk');
      assert.equal(phaseForRound(6, null), 'night');
      assert.equal(phaseForRound(9, null), 'dawn');
    });
  });

  describe('getCycleLength', () => {
    test('returns 8 for null cycleConfig', () => {
      assert.equal(getCycleLength(null), 8);
    });
    test('returns custom length', () => {
      assert.equal(getCycleLength(daytimeLoop), 4);
      assert.equal(getCycleLength(dayNightFixed), 8);
    });
  });

  describe('roundsUntilScoring with daytime-only looping cycle', () => {
    test('round 1 (dawn) = scoring now', () => {
      assert.equal(roundsUntilScoring(1, daytimeLoop), 0);
    });
    test('round 2 (day) = 3 rounds until next dawn', () => {
      assert.equal(roundsUntilScoring(2, daytimeLoop), 3);
    });
    test('round 4 (day) = 1 round until next dawn', () => {
      assert.equal(roundsUntilScoring(4, daytimeLoop), 1);
    });
    test('round 5 (dawn, wrapped) = scoring now', () => {
      assert.equal(roundsUntilScoring(5, daytimeLoop), 0);
    });
  });

  describe('roundsUntilScoring with fixed day-night cycle', () => {
    test('round 1 (dawn) = scoring now', () => {
      assert.equal(roundsUntilScoring(1, dayNightFixed), 0);
    });
    test('round 2 (day) = 3 until dusk', () => {
      assert.equal(roundsUntilScoring(2, dayNightFixed), 3);
    });
    test('round 5 (dusk) = scoring now', () => {
      assert.equal(roundsUntilScoring(5, dayNightFixed), 0);
    });
    test('round 6 (night) = Infinity (no more scoring in fixed cycle)', () => {
      assert.equal(roundsUntilScoring(6, dayNightFixed), Infinity);
    });
    test('round 9 (past end) = Infinity', () => {
      assert.equal(roundsUntilScoring(9, dayNightFixed), Infinity);
    });
  });

  describe('roundsUntilScoring without cycleConfig uses default', () => {
    test('round 1 = 0 (dawn)', () => {
      assert.equal(roundsUntilScoring(1, null), 0);
    });
    test('round 2 = 3 (until dusk at round 5)', () => {
      assert.equal(roundsUntilScoring(2, null), 3);
    });
  });

  describe('GameState endRound with custom cycle', () => {
    test('looping daytime cycle stays in day phases', () => {
      const state = new GameState(true, false, 'skirmish');
      state.cycleConfig = { ...daytimeLoop, phases: [...daytimeLoop.phases] };
      state.phase = phaseForRound(1, state.cycleConfig);
      state.disableScoring = true;

      const phases = [state.phase];
      for (let i = 0; i < 8; i++) {
        state.endRound();
        phases.push(state.phase);
      }
      // 9 phases total: rounds 1..9
      assert.deepEqual(phases, [
        'dawn', 'day', 'day', 'day',   // cycle 1
        'dawn', 'day', 'day', 'day',   // cycle 2
        'dawn',                          // cycle 3 start
      ]);
    });

    test('fixed cycle clamps to last phase after exhaustion', () => {
      const state = new GameState(true, false, 'skirmish');
      state.cycleConfig = { ...dayNightFixed, phases: [...dayNightFixed.phases] };
      state.phase = phaseForRound(1, state.cycleConfig);
      state.disableScoring = true;

      for (let i = 0; i < 9; i++) {
        state.endRound();
      }
      // Round 10, past the 8-phase fixed cycle — should clamp to 'night'
      assert.equal(state.round, 10);
      assert.equal(state.phase, 'night');
    });
  });

  describe('cycleConfig serialization round-trip', () => {
    test('looping cycle survives serialize/deserialize', () => {
      const state = new GameState(true, false, 'skirmish');
      state.cycleConfig = { phases: ['dawn', 'day', 'day', 'day'], loop: true };

      const snap = serializeState(state);
      assert.deepEqual(snap.cycleConfig, { phases: ['dawn', 'day', 'day', 'day'], loop: true });

      const restored = deserializeState(snap);
      assert.deepEqual(restored.cycleConfig, { phases: ['dawn', 'day', 'day', 'day'], loop: true });
    });

    test('null cycleConfig survives serialize/deserialize', () => {
      const state = new GameState(true, false, 'skirmish');
      assert.equal(state.cycleConfig, null);

      const snap = serializeState(state);
      assert.equal(snap.cycleConfig, null);

      const restored = deserializeState(snap);
      assert.equal(restored.cycleConfig, null);
    });
  });

  describe('mission definitions have phaseCycle', () => {
    const missions = hollowDef.missions;

    test('prologue mission has daytime-only looping cycle', () => {
      const prologue = missions.find(m => m.id === 'prologue');
      assert.ok(prologue.phaseCycle, 'prologue should have phaseCycle');
      assert.deepEqual(prologue.phaseCycle.phases, ['dawn', 'day', 'day', 'day']);
      assert.equal(prologue.phaseCycle.loop, true);
    });

    test('gathering_survivors mission has a daytime block ending at dusk', () => {
      const gs = missions.find(m => m.id === 'gathering_survivors');
      assert.ok(gs.phaseCycle, 'gathering_survivors should have phaseCycle');
      const phases = gs.phaseCycle.phases;
      assert.equal(phases[0], 'dawn');
      assert.equal(phases.at(-1), 'dusk');
      assert.ok(phases.slice(1, -1).every(p => p === 'day'),
        `expected only day phases between dawn and dusk, got ${JSON.stringify(phases)}`);
      assert.equal(gs.phaseCycle.loop, false);
    });
  });
});

// ── Mission 2 balance ───────────────────────────────────────────────────────

describe('Mission 2 (Gathering Survivors) balance', () => {
  const mission2 = hollowDef.missions.find(m => m.id === 'gathering_survivors');
  const facts2 = graphFacts(mission2);

  test('uses gather_and_survive win type with 2 survivors / 4 kills / dusk fallback', () => {
    assert.equal(facts2.objectives.win.type, 'gather_and_survive');
    assert.equal(facts2.objectives.win.survivors, 2);
    assert.equal(facts2.objectives.win.kills, 4);
    assert.equal(facts2.objectives.win.phaseFallback, 'dusk');
  });

  test('lose condition includes phase_without_survivors at dusk (hero death is inherent)', () => {
    const pws = facts2.objectives.lose.find(l => l.type === 'phase_without_survivors');
    assert.ok(pws);
    assert.equal(pws.phase, 'dusk');
    assert.equal(pws.survivors, 2);
  });

  test('story trigger fires on round 6 warning of impending night', () => {
    const lastDay = facts2.storyTriggers.find(t => t.round === 6);
    assert.ok(lastDay, 'Mission 2 should have a round-6 warning trigger');
    assert.ok(/dusk|night|fading|time/i.test((lastDay.text ?? '') + (lastDay.title ?? '')),
      'warning trigger text should mention the coming night');
  });

  test('map places four survivors spread across the map (exploration required)', () => {
    const mapData = buildMap('gathering_survivors');
    const survivorTiles = [];
    for (const [, tile] of mapData.tiles) {
      if (tile.hiddenSurvivor) survivorTiles.push({ col: tile.col, row: tile.row });
    }
    assert.equal(survivorTiles.length, 4, 'should have 4 hidden survivors on the map');

    // The survivors are distributed across the board (not clustered by the hero
    // start) so finding them all means exploring — assert a wide distance spread.
    const distances = survivorTiles.map(t => offsetHexDistance(mapData.heroStart, t));
    const far = distances.filter(d => d >= 5);
    assert.ok(far.length >= 3, 'at least three survivors are 5+ hexes from the hero start');
    assert.ok(Math.max(...distances) - Math.min(...distances) >= 5, 'survivors span the map, not clustered');
  });
});

/** Odd-r offset → axial → cube distance between two hex coords. */
function offsetHexDistance(a, b) {
  const toAxial = ({ col, row }) => ({ q: col - ((row - (row & 1)) >> 1), r: row });
  const A = toAxial(a), B = toAxial(b);
  const dq = A.q - B.q, dr = A.r - B.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

// ── Mission 3 balance ───────────────────────────────────────────────────────

describe('Mission 3 (The First Night) balance', () => {
  const mission3 = hollowDef.missions.find(m => m.id === 'first_night');
  const facts3 = graphFacts(mission3);

  test('phase cycle is one dusk + five nights + one dawn (non-looping)', () => {
    assert.ok(mission3.phaseCycle, 'first_night should have phaseCycle');
    assert.deepEqual(mission3.phaseCycle.phases,
      ['dusk', 'night', 'night', 'night', 'night', 'night', 'dawn']);
    assert.equal(mission3.phaseCycle.loop, false);
  });

  test('uses survive_with_party win at dawn with 2 survivors', () => {
    assert.equal(facts3.objectives.win.type, 'survive_with_party');
    assert.equal(facts3.objectives.win.phase, 'dawn');
    assert.equal(facts3.objectives.win.survivors, 2);
  });

  test('lose condition includes phase_without_survivors at dawn (hero death is inherent)', () => {
    const pws = facts3.objectives.lose.find(l => l.type === 'phase_without_survivors');
    assert.ok(pws);
    assert.equal(pws.phase, 'dawn');
    assert.equal(pws.survivors, 2);
  });

  test('guarantees a party of two via minSurvivors and maxSurvivorsFromRoster', () => {
    assert.equal(mission3.minSurvivors, 2);
    assert.equal(mission3.maxSurvivorsFromRoster, 2);
    // No hidden-survivor discovery — the night is a fixed-party defense.
    assert.equal(mission3.missionSurvivors, 0);
    assert.equal(mission3.maxDiscoverableSurvivors, 0);
  });

  test('survivorStartPositions points into town buildings (church + house)', () => {
    const positions = mission3.survivorStartPositions;
    assert.ok(Array.isArray(positions) && positions.length >= 2);
    const mapData = buildMap('first_night');
    for (const pos of positions) {
      const tile = mapData.tiles.get(`${pos.col},${pos.row}`);
      assert.ok(tile, `survivor start (${pos.col},${pos.row}) must exist on map`);
      assert.equal(legacyTileType(tile), 'building',
        `survivor start (${pos.col},${pos.row}) should be a building tile`);
    }
  });

  test('map includes resources clustered in town for the starting party', () => {
    const mapData = buildMap('first_night');
    const resources = [];
    for (const [, tile] of mapData.tiles) {
      if (tile.resource) resources.push({ col: tile.col, row: tile.row, kind: tile.resource });
    }
    assert.ok(resources.length >= 3, 'first_night map should include at least 3 resources');
  });

  test('enemy wave count — heavy swarm across dusk + five nights', () => {
    // Round 7 is dawn; no wave needed there. Waves should cover rounds 1-6.
    const waveRounds = facts3.waves.map(w => w.round);
    for (const r of [1, 2, 3, 4, 5, 6]) {
      assert.ok(waveRounds.includes(r), `should have a wave in round ${r}`);
    }
    const total = facts3.waves.reduce((sum, w) => sum + w.units.length, 0);
    assert.ok(total >= 12, `expected heavy swarm (>=12 wave spawns), got ${total}`);
  });

  test('minions arrive from night 1 and every night after', () => {
    // Round 2 is the first full night (round 1 is dusk). The party should
    // face at least one minion from night 1 onward every round.
    for (const r of [2, 3, 4, 5, 6]) {
      const wave = facts3.waves.find(w => w.round === r);
      assert.ok(wave, `round ${r} should have a wave`);
      const minionCount = wave.units.filter(u => u.type === 'minion').length;
      assert.ok(minionCount >= 1,
        `round ${r} wave should include >=1 minion, got ${minionCount}`);
    }
  });

  test('pre-placed enemies stand right by the town (not strewn across the map)', () => {
    // Every pre-placed enemy should be within 2 hexes of at least one town
    // building, except up to 2 distant graveyard shamblers allowed for flavor.
    const mapData = buildMap('first_night');
    const buildings = [];
    for (const [, tile] of mapData.tiles) {
      if (legacyTileType(tile) === 'building' && tile.building !== 'graveyard') {
        buildings.push({ col: tile.col, row: tile.row });
      }
    }
    const distant = mission3.enemyUnits.filter(u => {
      const minDist = Math.min(...buildings.map(b => offsetHexDistance(u, b)));
      return minDist > 2;
    });
    assert.ok(distant.length <= 2,
      `at most 2 distant shamblers allowed; found ${distant.length}`);
    // And at least one minion should be pre-placed — so the party is
    // threatened from turn 1 by a sturdy attacker.
    const minions = mission3.enemyUnits.filter(u => u.type === 'minion');
    assert.ok(minions.length >= 1,
      `expected >=1 pre-placed minion, got ${minions.length}`);
  });
});

// ── Mission 4 balance ───────────────────────────────────────────────────────

describe('Mission 4 (The River Crossing) balance', () => {
  const mission4 = hollowDef.missions.find(m => m.id === 'river_crossing');
  const facts4 = graphFacts(mission4);

  test('uses all_party_at_hexes win centred on the far-bank church', () => {
    assert.equal(facts4.objectives.win.type, 'all_party_at_hexes');
    const hexes = facts4.objectives.win.hexes;
    assert.ok(hexes.some(h => h.col === 15 && h.row === 4),
      'target hex set must include the church at (15,4)');
    assert.ok(hexes.length >= 3, 'target hex set should include the church and neighbors');
  });

  test('lose condition includes survivors_below(2) (hero death is inherent)', () => {
    const below = facts4.objectives.lose.find(l => l.type === 'survivors_below');
    assert.ok(below, 'lose should include survivors_below');
    assert.equal(below.count, 2);
  });

  test('phase cycle is daytime-only (day-looping)', () => {
    assert.ok(mission4.phaseCycle);
    assert.deepEqual(mission4.phaseCycle.phases, ['day']);
    assert.equal(mission4.phaseCycle.loop, true);
  });

  test('starts with a guaranteed party of two survivors', () => {
    assert.equal(mission4.maxSurvivorsFromRoster, 2);
    assert.equal(mission4.minSurvivors, 2);
    assert.ok(Array.isArray(mission4.survivorStartPositions));
    assert.equal(mission4.survivorStartPositions.length, 2);
  });

  test('removes horses from loot', () => {
    assert.ok(mission4.lootOverrides?.remove?.includes('horse'),
      'Mission 4 must override loot to remove horses');
  });

  test('river area is swarming — at least 8 pre-placed enemies plus waves', () => {
    assert.ok(mission4.enemyUnits.length >= 8,
      `expected a swarming river (>=8 initial enemies), got ${mission4.enemyUnits.length}`);
    const waveTotal = facts4.waves.reduce((sum, w) => sum + w.units.length, 0);
    assert.ok(waveTotal >= 6,
      `expected meaningful reinforcement waves (>=6 total spawns), got ${waveTotal}`);
    const types = new Set([
      ...mission4.enemyUnits.map(u => u.type),
      ...facts4.waves.flatMap(w => w.units.map(u => u.type)),
    ]);
    assert.ok(types.has('zombie'), 'enemy mix should include zombies');
    assert.ok(types.has('minion'), 'enemy mix should include minions');
  });

  test('map places a church on the far bank with 4 herbs clustered nearby', () => {
    const mapData = buildMap('river_crossing');
    const church = mapData.tiles.get('15,4');
    assert.ok(church);
    assert.equal(legacyTileType(church), 'building');
    assert.equal(church.building, 'church');
    // The church tile itself conceals the final survivor.
    assert.ok(church.hiddenSurvivor, 'church should hide a survivor to rescue');

    // Count herb resources within 2 hexes of the church.
    let herbsNearChurch = 0;
    for (const [, tile] of mapData.tiles) {
      if (tile.resource !== 'herbs') continue;
      const dx = tile.col - 15, dy = tile.row - 4;
      const dist = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy));
      if (dist <= 2) herbsNearChurch++;
    }
    assert.ok(herbsNearChurch >= 4,
      `expected 4 herb caches near the church, found ${herbsNearChurch}`);
  });
});

// ── Mission 5 balance ───────────────────────────────────────────────────────

describe('Mission 5 (Dark Ritual) balance', () => {
  const mission5 = hollowDef.missions.find(m => m.id === 'dark_ritual');
  const facts5 = graphFacts(mission5);

  test('phase cycle is 11 rounds, 3 day → 1 dusk → 6 night → 1 dawn, non-looping', () => {
    assert.ok(mission5.phaseCycle);
    assert.deepEqual(mission5.phaseCycle.phases, [
      'day','day','day','dusk','night','night','night','night','night','night','dawn',
    ]);
    assert.equal(mission5.phaseCycle.loop, false);
    assert.equal(mission5.phaseCycle.phases.length, 11);
  });

  test('uses witch_denied_nodes at dawn as the win condition', () => {
    assert.equal(facts5.objectives.win.type, 'witch_denied_nodes');
    assert.equal(facts5.objectives.win.phase, 'dawn');
  });

  test('lose condition includes witch_holds_node at dawn (hero death is inherent)', () => {
    const holds = facts5.objectives.lose.find(l => l.type === 'witch_holds_node');
    assert.ok(holds, 'lose should include witch_holds_node');
    assert.equal(holds.phase, 'dawn');
  });

  test('witch starts with a heavy garrison on each node', () => {
    const mapData = buildMap('dark_ritual');
    const nodeHexKeys = new Set();
    for (const obj of mapData.witchObjectives) {
      for (const h of obj.hexes) nodeHexKeys.add(`${h.col},${h.row}`);
    }
    // At least 3 pre-placed enemy units per node cluster.
    for (const obj of mapData.witchObjectives) {
      const clusterKeys = new Set(obj.hexes.map(h => `${h.col},${h.row}`));
      const onNode = mission5.enemyUnits.filter(u => clusterKeys.has(`${u.col},${u.row}`));
      assert.ok(onNode.length >= 3,
        `expected >=3 enemies on node "${obj.label}", got ${onNode.length}`);
    }
  });

  test('has an area-triggered golem ambush at the second clearing', () => {
    const ambush = facts5.waves.find(w => w.trigger === 'area');
    assert.ok(ambush, 'should have an area-triggered wave');
    assert.ok(ambush.hexes && ambush.hexes.length > 0, 'ambush should have hex list');
    const golems = ambush.units.filter(u => u.type === 'wood_golem');
    assert.ok(golems.length >= 3, `expected >=3 golems in ambush, got ${golems.length}`);
    // Ambush hex set should include at least one Dark Altar hex.
    const altarHexes = new Set(['9,6', '10,6', '9,5']);
    assert.ok(ambush.hexes.some(h => altarHexes.has(`${h.col},${h.row}`)),
      'ambush hex set should overlap the Dark Altar');
  });

  test('removes horses from loot', () => {
    assert.ok(mission5.lootOverrides?.remove?.includes('horse'),
      'Mission 5 must override loot to remove horses');
  });

  test('disables node scoring (custom win check runs instead)', () => {
    assert.equal(mission5.disableScoring, true);
  });

  test('map is forest-dominant with no river and minimal buildings', () => {
    const mapData = buildMap('dark_ritual');
    let forest = 0, river = 0, building = 0, grass = 0;
    for (const [, tile] of mapData.tiles) {
      if (legacyTileType(tile) === 'forest')   forest++;
      if (legacyTileType(tile) === 'river')    river++;
      if (legacyTileType(tile) === 'building') building++;
      if (legacyTileType(tile) === 'grass')    grass++;
    }
    assert.equal(river, 0, 'dark_ritual map should have no river');
    assert.ok(building <= 2, `expected ≤2 buildings, got ${building}`);
    assert.ok(forest > grass, `expected forest-dominant map (forest ${forest} > grass ${grass})`);
  });

  test('map has two power nodes with distinct clearings', () => {
    const mapData = buildMap('dark_ritual');
    assert.equal(mapData.witchObjectives.length, 2);
    // Both node centre hexes should be passable (not forest, not building).
    for (const obj of mapData.witchObjectives) {
      const t = mapData.tiles.get(`${obj.col},${obj.row}`);
      assert.ok(t, `node hex (${obj.col},${obj.row}) missing`);
      assert.notEqual(legacyTileType(t), 'forest', `node hex (${obj.col},${obj.row}) should not be forest`);
      assert.notEqual(legacyTileType(t), 'building', `node hex (${obj.col},${obj.row}) should not be a building`);
    }
  });
});

// ── resolveSpawnPosition map_edge ──────────────────────────────────────────

describe('processWaves map_edge spawn covers all four edges', () => {
  test('spawns can land on col=0, col=max, row=0, and row=max', () => {
    const mapData = buildMap('first_night');
    const state = new GameState(true, false, 'standard', null, mapData);

    let maxCol = 0, maxRow = 0;
    for (const [, t] of state.tiles) {
      if (t.col > maxCol) maxCol = t.col;
      if (t.row > maxRow) maxRow = t.row;
    }
    const edgeHits = { left: 0, right: 0, top: 0, bottom: 0 };

    // Use a deterministic seed via Math.random shim? Just sample many times.
    for (let i = 0; i < 200; i++) {
      state.round = 1;
      const before = state.entities.length;
      processWaves(state, [{ round: 1, units: [{ type: 'zombie', spawnAt: 'map_edge' }] }],
        (_type, col, row) => createZombie(col, row, 'witch'));
      const spawned = state.entities[before];
      if (!spawned) continue;
      if (spawned.col === 0) edgeHits.left++;
      if (spawned.col === maxCol) edgeHits.right++;
      if (spawned.row === 0) edgeHits.top++;
      if (spawned.row === maxRow) edgeHits.bottom++;
    }
    assert.ok(edgeHits.left > 0, 'never spawned on west edge');
    assert.ok(edgeHits.right > 0, 'never spawned on east edge');
    assert.ok(edgeHits.top > 0, 'never spawned on north edge');
    assert.ok(edgeHits.bottom > 0, 'never spawned on south edge');
  });
});

// ── resolveSpawnPosition near_hero ─────────────────────────────────────────

describe('processWaves near_hero spawn appears in view', () => {
  test('spawns within hero sight (2-3 hexes) and never on top of the hero', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);

    const createFn = (_type, col, row) => createWoodGolem(col, row, 'witch');

    let sawInRing = false;
    for (let i = 0; i < 200; i++) {
      const before = state.entities.length;
      processWaves(
        state,
        [{ round: 1, units: [{ type: 'wood_golem', spawnAt: 'near_hero' }] }],
        createFn,
      );
      const spawned = state.entities[before];
      if (!spawned) continue;
      const d = hexDistance(spawned.col, spawned.row, state.hero.col, state.hero.row);
      // Must be close enough for the hero to see on spawn (day sight = 3)
      // and must not overlap the hero.
      assert.ok(d >= 1 && d <= 4, `spawn distance ${d} outside expected range`);
      if (d >= 2 && d <= 3) sawInRing = true;
      // Remove the spawned entity so each iteration is independent
      state.entities.pop();
    }
    assert.ok(sawInRing, 'expected at least one spawn in the preferred 2-3 hex ring');
  });

  test('falls back to the 1-4 ring when the 2-3 ring is fully blocked', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);

    // Saturate every passable 2-3 hex ring tile so the preferred ring cannot
    // produce a candidate — forces the fallback branch to pick from 1 or 4.
    for (const [, tile] of state.tiles) {
      const d = hexDistance(tile.col, tile.row, state.hero.col, state.hero.row);
      if (d >= 2 && d <= 3 && legacyTileType(tile) !== 'river' && legacyTileType(tile) !== 'building') {
        state.entities.push(createZombie(tile.col, tile.row, 'witch'));
      }
    }

    const createFn = (_type, col, row) => createWoodGolem(col, row, 'witch');
    const before = state.entities.length;
    processWaves(
      state,
      [{ round: 1, units: [{ type: 'wood_golem', spawnAt: 'near_hero' }] }],
      createFn,
    );
    const spawned = state.entities[before];
    assert.ok(spawned, 'expected a fallback spawn');
    const d = hexDistance(spawned.col, spawned.row, state.hero.col, state.hero.row);
    // Strict: only distance 1 or 4 proves the fallback widened the ring.
    // If the fallback silently re-picked from 2-3, this would fail.
    assert.ok(d === 1 || d === 4,
      `fallback spawn distance ${d} should be 1 or 4 (2-3 ring is saturated)`);
  });
});

// ── Hero starting loadout (weapons overhaul) ─────────────────────────────────

describe('Campaign — hero starting loadout', () => {
  test('a new campaign defaults to the Paladin loadout (sword, base ATK 2)', () => {
    const c = new Campaign(hollowDef);
    assert.deepEqual(c.heroStats.items.sword, { count: 1, equipped: true });
    assert.equal(c.heroStats.attack, 2);
  });

  test('applyCarriedHeroLoadout keeps the starting sword when no weapon is carried', () => {
    // Reproduces the bug: pre-overhaul / default heroStats carry no equipped
    // weapon, which must NOT strip the fresh starting sword on mission load.
    const hero = getFaction('hero').createLeader(0, 0, 'hero');
    assert.equal(hero.getEquippedWeaponId(), 'sword', 'precondition: freshly created Paladin holds a sword');
    applyCarriedHeroLoadout(hero, { hp: 14, items: {} });
    assert.equal(hero.getEquippedWeaponId(), 'sword', 'no carried weapon must not disarm the hero');
    assert.equal(hero.getRange(), 1);
  });

  test('a freshly created Paladin is issued a Horn innately', () => {
    const hero = getFaction('hero').createLeader(0, 0, 'hero');
    assert.ok(hero.hasItem('horn'), 'the horn-trained Paladin carries a horn');
  });

  test('campaign deploy strips the innate horn — the hero re-finds it in Ch1 M4', () => {
    // The carried backpack (default = sword only) replaces the innate pack on
    // mission load, so a fresh campaign hero arrives WITHOUT a horn and must
    // discover one at the river church (Ch1M4 exploreOverride).
    const hero = getFaction('hero').createLeader(0, 0, 'hero');
    assert.ok(hero.hasItem('horn'), 'precondition: innate horn present pre-deploy');
    applyCarriedHeroLoadout(hero, { hp: 98, maxHp: 98, items: { sword: { count: 1, equipped: true } } });
    assert.ok(!hero.hasItem('horn'), 'carried loadout must not retain the innate horn');
    assert.equal(hero.getEquippedWeaponId(), 'sword');
  });

  test('applyCarriedHeroLoadout adopts a carried weapon and syncs range', () => {
    const hero = getFaction('hero').createLeader(0, 0, 'hero');
    applyCarriedHeroLoadout(hero, {
      hp: 10,
      items: { musket: { count: 1, equipped: true }, sword: { count: 1 } },
    });
    assert.equal(hero.getEquippedWeaponId(), 'musket');
    assert.equal(hero.getRange(), 2, 'range tracks the carried ranged weapon');
    assert.equal(hero.hp, 10);
    assert.equal(hero.getItemCount('sword'), 1, 'carried spare sword preserved');
  });

  test('applyCarriedHeroLoadout carries the wounded fraction (scale-invariant)', () => {
    // A save written before HP×DAMAGE_SCALE stores the old "14/14". It must
    // resolve to the Paladin's full scaled pool, not clamp the hero down to 14.
    const carriedSword = { sword: { count: 1, equipped: true } };
    const full = getFaction('hero').createLeader(0, 0, 'hero');
    applyCarriedHeroLoadout(full, { hp: 14, maxHp: 14, items: { ...carriedSword } });
    assert.equal(full.hp, full.maxHp, 'stale "full" save → full scaled HP');

    const half = getFaction('hero').createLeader(0, 0, 'hero');
    applyCarriedHeroLoadout(half, { hp: 7, maxHp: 14, items: { ...carriedSword } });
    assert.equal(half.hp, Math.round(half.maxHp * 0.5), 'half-HP save → half the scaled pool');

    // A current-scale save round-trips exactly.
    const cur = getFaction('hero').createLeader(0, 0, 'hero');
    applyCarriedHeroLoadout(cur, { hp: 70, maxHp: 98, items: { ...carriedSword } });
    assert.equal(cur.hp, 70);
  });
});
