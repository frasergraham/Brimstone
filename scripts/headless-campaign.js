#!/usr/bin/env node
/**
 * Headless campaign-mission runner — plays a campaign mission with the
 * Hero AI driving the hero (and the configured Witch AI driving the witch
 * when present) to estimate mission difficulty.
 *
 * Usage:
 *   node scripts/headless-campaign.js [missionId] [count]
 *   node scripts/headless-campaign.js --all [count]
 *   node scripts/headless-campaign.js --render <missionId> [out.gif]
 *   node scripts/headless-campaign.js --render --all     (renders one GIF per mission)
 *
 * Examples:
 *   node scripts/headless-campaign.js dark_ritual 50
 *   node scripts/headless-campaign.js --render long_watch
 *   node scripts/headless-campaign.js --render --all
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GameState, phaseForRound } from '../src/game.js';
import { HeroAIEngine } from '../src/hero-ai-engine.js';
import { WitchAIEngine } from '../src/ai-engine.js';
import { WITCH_PERSONALITIES, HERO_PERSONALITIES } from '../src/ai.js';
import { resolvePlansMP } from '../server/resolver.js';
import { getCampaignById } from '../src/campaign/campaign-registry.js';
import { buildVictoryDelegate, processWaves } from '../src/campaign/campaign.js';
import { processStoryTriggers } from '../src/campaign/missions.js';
import {
  EntityType, createSurvivor, createMinion, createZombie,
  createWoodGolem, createIronGolem,
} from '../src/entities.js';
import { SURVIVOR_ROSTER } from '../src/content/survivors.js';
import { getNeighbors, hexKey } from '../src/hex.js';
import { TileType } from '../src/tiles.js';

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const VERBOSE = args.includes('--verbose');
const RENDER = args.includes('--render');
const positional = args.filter(a => !a.startsWith('--'));
const MISSION_ID = ALL ? null : (positional[0] ?? 'dark_ritual');
const COUNT = parseInt(positional[ALL ? 0 : 1] ?? '30', 10);
const RENDER_OUT = RENDER ? (positional[ALL ? 0 : 1] ?? null) : null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const hollow = getCampaignById('calebs_hollow_prologue');
if (!hollow) { console.error('campaign not found'); process.exit(1); }

// ── Mission init (DOM-free port of main.js _initCampaignMission) ───────────

function createEnemyEntity(type, col, row, state) {
  switch (type) {
    case 'zombie':     return createZombie(col, row, 'witch', state);
    case 'minion':     return createMinion(col, row, 'witch', state);
    case 'wood_golem': return createWoodGolem(col, row, 'witch', state);
    case 'iron_golem': return createIronGolem(col, row, 'witch', state);
    default:           return createMinion(col, row, 'witch', state);
  }
}

function buildMissionState(missionDef) {
  const mapData = hollow.mapBuilders[missionDef.mapBuilder]();
  mapData.noWitch         = !missionDef.hasWitch;
  mapData.disableScoring  = !!missionDef.disableScoring;
  mapData.disableCycleBar = !!missionDef.disableCycleBar;
  mapData.disableNodeSweep = !!missionDef.disableNodeSweep;
  mapData.disableScoreWin  = !!missionDef.disableScoreWin;
  if (missionDef.nodeScoreThreshold != null) {
    mapData.nodeScoreThreshold = missionDef.nodeScoreThreshold;
  }
  if (missionDef.maxDiscoverableSurvivors != null) {
    mapData.maxDiscoverableSurvivors = missionDef.maxDiscoverableSurvivors;
  }

  const state = new GameState(true, true, missionDef.mapSize, null, mapData);
  state.fogOfWar = 'none';   // headless — no fog so AI sees everything

  if (missionDef.phaseCycle) {
    state.cycleConfig = {
      phases: [...missionDef.phaseCycle.phases],
      loop: missionDef.phaseCycle.loop !== false,
      ...(missionDef.phaseCycle.extraScoringPhases
          ? { extraScoringPhases: [...missionDef.phaseCycle.extraScoringPhases] } : {}),
      ...(missionDef.phaseCycle.extendOnWitchScore
          ? { extendOnWitchScore: [...missionDef.phaseCycle.extendOnWitchScore] } : {}),
    };
    state.phase = phaseForRound(1, state.cycleConfig);
  }

  if (missionDef.aiBudgetBonus) state.campaignAIBudgetBonus = missionDef.aiBudgetBonus;
  if (missionDef.lootOverrides) state.lootOverrides = missionDef.lootOverrides;
  if (missionDef.startingResources) {
    Object.assign(state.inventory.hero, missionDef.startingResources);
  }

  state.victoryDelegate = buildVictoryDelegate(missionDef.objectives);
  if (missionDef.waves) {
    state._waveProcessor = () => processWaves(state, missionDef.waves, createEnemyEntity);
  }

  // Deploy survivors from the canonical roster (no campaign carry-over).
  // Filter spawn spots to valid, unoccupied land — otherwise survivors land
  // on river/buildings/off-map and the engine treats them as broken.
  const wantSurvivors = missionDef.maxSurvivorsFromRoster ?? 0;
  const minSurvivors  = missionDef.minSurvivors ?? 0;
  const deployN = Math.max(wantSurvivors, minSurvivors);
  const heroStart = mapData.heroStart;
  const candidateSpots = missionDef.survivorStartPositions
    ? [...missionDef.survivorStartPositions]
    : getNeighbors(heroStart.col, heroStart.row);
  const occupied = new Set(
    state.entities.filter(e => e.alive).map(e => hexKey(e.col, e.row))
  );
  const validSpots = candidateSpots.filter(s => {
    const k = hexKey(s.col, s.row);
    if (occupied.has(k)) return false;
    const t = state.tiles.get(k);
    if (!t) return false;
    if (t.type === TileType.RIVER) return false;
    return true;
  });
  let deployed = 0;
  for (let i = 0; i < deployN && i < validSpots.length; i++) {
    const r = SURVIVOR_ROSTER[i % SURVIVOR_ROSTER.length];
    const s = createSurvivor(validSpots[i].col, validSpots[i].row, 'hero', state);
    s.name = r.name; s.title = r.title; s.bio = r.bio;
    s.maxHp = r.maxHp; s.hp = r.maxHp;
    s.attack = r.attack; s.defense = r.defense;
    s.abilities = r.ability ? [r.ability] : [];
    s.abilityLabel = r.abilityLabel;
    state.markRosterUsedByName(r.name);
    state.entities.push(s);
    occupied.add(hexKey(s.col, s.row));
    deployed++;
  }
  state._headlessStartSurvivors = deployed;
  state._headlessRequestedSurvivors = deployN;

  // Pre-place enemy units.
  if (missionDef.enemyUnits) {
    for (const enemy of missionDef.enemyUnits) {
      const e = createEnemyEntity(enemy.type, enemy.col, enemy.row, state);
      if (e) {
        if (enemy.overrides) Object.assign(e, enemy.overrides);
        state.entities.push(e);
      }
    }
  }
  return state;
}

// ── One game ─────────────────────────────────────────────────────────────────

// Build the AIs and play the mission to completion. If `onBeforeRound` is
// provided it's called once per round AFTER endRound (so the caller can
// snapshot a frame for rendering).
function playMissionGame(missionDef, opts = {}) {
  const state = buildMissionState(missionDef);
  const HeroAIClass = HERO_PERSONALITIES[missionDef.heroPersonality] ?? HeroAIEngine;
  const heroAI = new HeroAIClass(state, () => {}, 0);
  let witchAI = null;
  if (missionDef.hasWitch !== false && state.witch) {
    const AIClass = WITCH_PERSONALITIES[missionDef.aiPersonality] ?? WitchAIEngine;
    witchAI = new AIClass(state, () => {}, 0);
  }

  const storyFlags = {};
  const cycleLen = state.cycleConfig?.phases?.length ?? 8;
  const MAX_ROUNDS = missionDef.phaseCycle && !missionDef.phaseCycle.loop
    ? cycleLen + 30
    : 60;

  if (opts.onFrame) opts.onFrame(state, []);   // initial frame

  while (!state.gameOver && state.round <= MAX_ROUNDS) {
    state.startPlanning();
    if (missionDef.storyTriggers) {
      processStoryTriggers(state, missionDef.storyTriggers, storyFlags);
    }

    const heroPlan = heroAI.generatePlan(undefined);
    const witchPlan = witchAI ? witchAI.generatePlan(undefined) : [];

    const playerEntries = [];
    const heroPlayer  = state.players.find(p => p.faction === 'hero');
    const witchPlayer = state.players.find(p => p.faction === 'witch');
    if (heroPlayer) {
      state.submitPlayerPlan(heroPlayer.id, heroPlan);
      playerEntries.push({ playerId: heroPlayer.id, faction: 'hero', plan: heroPlan });
    }
    if (witchPlayer && witchAI) {
      state.submitPlayerPlan(witchPlayer.id, witchPlan);
      playerEntries.push({ playerId: witchPlayer.id, faction: 'witch', plan: witchPlan });
    }

    const logBefore = state.log.length;
    resolvePlansMP(state, playerEntries);
    state.endRound();
    if (opts.onFrame) opts.onFrame(state, state.log.slice(logBefore));
  }
  return state;
}

function runMission(missionDef, gameIdx) {
  const state = playMissionGame(missionDef);
  return {
    won: state.winner === 'hero',
    winner: state.winner ?? 'timeout',
    rounds: state.round,
    winReason: state.winReason ?? 'round-cap',
    finalHeroHp: state.hero?.hp ?? 0,
    finalSurvivors: state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    ).length,
    finalWitchScore: state.nodeScore?.witch ?? 0,
    cyclePhases: state.cycleConfig?.phases?.length ?? null,
  };
}

// ── Reporter ─────────────────────────────────────────────────────────────────

function summarise(missionDef, results) {
  const wins = results.filter(r => r.won).length;
  const losses = results.length - wins;
  const winRate = (100 * wins / results.length).toFixed(1);
  const meanRounds = (results.reduce((a, r) => a + r.rounds, 0) / results.length).toFixed(1);
  const meanHeroHp = (results.reduce((a, r) => a + r.finalHeroHp, 0) / results.length).toFixed(1);
  const meanSurv   = (results.reduce((a, r) => a + r.finalSurvivors, 0) / results.length).toFixed(1);
  const meanWScore = (results.reduce((a, r) => a + r.finalWitchScore, 0) / results.length).toFixed(2);
  const meanCycle  = results.some(r => r.cyclePhases !== null)
    ? (results.reduce((a, r) => a + (r.cyclePhases ?? 0), 0) / results.length).toFixed(1)
    : null;

  // Group win-reasons
  const reasons = {};
  for (const r of results) {
    const k = `${r.winner}: ${r.winReason}`;
    reasons[k] = (reasons[k] ?? 0) + 1;
  }

  console.log('');
  console.log(`══ ${missionDef.title} (${missionDef.id}) — ${results.length} games ══`);
  console.log(`  Hero win rate    : ${winRate}%   (${wins}W / ${losses}L)`);
  console.log(`  Mean rounds      : ${meanRounds}`);
  console.log(`  Mean hero HP end : ${meanHeroHp}`);
  console.log(`  Mean survivors   : ${meanSurv}`);
  if (meanCycle !== null) console.log(`  Mean cycle length: ${meanCycle} phases`);
  if (parseFloat(meanWScore) > 0) console.log(`  Mean witch score : ${meanWScore}`);
  console.log(`  Outcomes:`);
  for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    const pct = (100 * n / results.length).toFixed(0);
    console.log(`    ${pct.padStart(3)}% ${k}`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

function run(missionDef, count) {
  const results = [];
  for (let i = 0; i < count; i++) results.push(runMission(missionDef, i));
  summarise(missionDef, results);
  if (VERBOSE) {
    const state = playMissionGame(missionDef);
    console.log('\n  --- sample game log (full) ---');
    for (const line of state.log) {
      const text = typeof line === 'string' ? line : (line?.text ?? '');
      console.log('    ' + text);
    }
  }
}

// ── Render mode (one GIF per mission) ─────────────────────────────────────────

async function renderMissionToGif(missionDef, outPath) {
  const { renderGameState, loadTilemap, renderFramesToGif } = await import('./game-render.js');
  await loadTilemap(path.join(__dirname, '..', 'assets', 'tilemap.png'));

  console.log(`\n  Rendering ${missionDef.title}…`);
  const frames = [];
  const state = playMissionGame(missionDef, {
    onFrame: (s, roundLog) => {
      frames.push(renderGameState(s, { chronicle: roundLog.length ? roundLog : [...s.log.slice(-10)] }));
      process.stdout.write(`    Round ${s.round} (${frames.length} frames)\r`);
    },
  });
  // Final hold-frame
  frames.push(renderGameState(state, { chronicle: state.log.slice(-15) }));

  console.log(`\n    ${frames.length} frames captured. Encoding GIF…`);
  const result = await renderFramesToGif(frames, outPath);
  const kb = (result.bytes / 1024).toFixed(0);
  console.log(`    GIF saved → ${outPath}  (${kb} KB, winner=${state.winner ?? 'timeout'} in ${state.round}r)`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

if (RENDER) {
  const renderDir = path.join(__dirname, 'renders');
  const targets = ALL
    ? hollow.missions.filter(m => !m.conductorSteps)
    : (() => {
        const m = hollow.missions.find(x => x.id === MISSION_ID);
        if (!m) {
          console.error(`Unknown mission "${MISSION_ID}". Choices: ${hollow.missions.map(m=>m.id).join(', ')}`);
          process.exit(1);
        }
        return [m];
      })();

  for (const m of targets) {
    const out = (!ALL && RENDER_OUT)
      ? RENDER_OUT
      : path.join(renderDir, `campaign_${m.id}.gif`);
    await renderMissionToGif(m, out);
  }
} else if (ALL) {
  console.log(`Playing every campaign mission ${COUNT} times…`);
  for (const m of hollow.missions) {
    if (m.conductorSteps) continue;
    run(m, COUNT);
  }
} else {
  const m = hollow.missions.find(x => x.id === MISSION_ID);
  if (!m) {
    console.error(`Unknown mission "${MISSION_ID}". Choices: ${hollow.missions.map(m=>m.id).join(', ')}`);
    process.exit(1);
  }
  console.log(`Playing ${m.title} ${COUNT} times…`);
  run(m, COUNT);
}
