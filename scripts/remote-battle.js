#!/usr/bin/env node
// CLI for remote-battle management.
// Uses the same helper functions as the admin panel.
//
// Usage:
//   node scripts/remote-battle.js create [--name "My Battle"] [--map standard] [--players 2]
//   node scripts/remote-battle.js list
//   node scripts/remote-battle.js status <battleId>
//   node scripts/remote-battle.js add-player <battleId> --faction hero [--type ai] [--personality balanced]
//   node scripts/remote-battle.js add-player <battleId> --faction witch --type llm --endpoint https://...
//   node scripts/remote-battle.js start <battleId>
//   node scripts/remote-battle.js take-turn <battleId> <playerId>
//   node scripts/remote-battle.js take-all-turns <battleId>
//   node scripts/remote-battle.js resolve <battleId>
//   node scripts/remote-battle.js resign <battleId> <playerId>
//   node scripts/remote-battle.js auto <battleId> [--rounds 10]
//   node scripts/remote-battle.js personalities

import {
  createBattle,
  addPlayer,
  resignPlayer,
  startBattle,
  generateTurn,
  generateAllTurns,
  resolveRound,
  getBattleStatus,
  listBattles,
  getPersonalities,
} from '../server/remote-battle.js';

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name, defaultVal = null) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function printStatus(status) {
  console.log(`\n  Battle: ${status.name} (${status.id.slice(0, 8)})`);
  console.log(`  Phase: ${status.phase}  |  Round: ${status.round}  |  Game Phase: ${status.currentPhase || '-'}`);
  if (status.gameOver) {
    console.log(`  GAME OVER — Winner: ${status.winner} (${status.winReason})`);
  }
  if (status.nodeScore) {
    console.log(`  Score — Hero: ${status.nodeScore.hero}  Witch: ${status.nodeScore.witch}`);
  }
  console.log(`\n  Roster:`);
  for (const r of status.roster) {
    const plan = r.hasPlan ? `[${r.planLength} actions]` : '[no plan]';
    const leader = r.leader?.alive ? `HP ${r.leader.hp}/${r.leader.maxHp}` : (r.status === 'resigned' ? 'resigned' : 'dead');
    const typeInfo = r.type === 'llm' ? 'LLM' : (r.personality || 'balanced');
    console.log(`    ${r.faction.padEnd(5)} ${r.name.padEnd(20)} ${typeInfo.padEnd(12)} ${leader.padEnd(12)} ${r.entityCount} units  ${plan}  [${r.status}]`);
  }
  if (status.log.length > 0) {
    console.log(`\n  Recent log:`);
    for (const l of status.log.slice(-10)) console.log(`    ${l}`);
  }
  console.log('');
}

async function main() {
  if (!command || command === 'help') {
    console.log(`
Usage:
  node scripts/remote-battle.js create [--name "..."] [--map standard] [--players 2]
  node scripts/remote-battle.js list
  node scripts/remote-battle.js status <battleId>
  node scripts/remote-battle.js add-player <battleId> --faction hero [--type ai] [--personality balanced]
  node scripts/remote-battle.js add-player <battleId> --faction witch --type llm --endpoint https://...
  node scripts/remote-battle.js start <battleId>
  node scripts/remote-battle.js take-turn <battleId> [playerId]
  node scripts/remote-battle.js take-all-turns <battleId>
  node scripts/remote-battle.js resolve <battleId>
  node scripts/remote-battle.js resign <battleId> <playerId>
  node scripts/remote-battle.js auto <battleId> [--rounds 10]
  node scripts/remote-battle.js personalities
`);
    return;
  }

  if (command === 'personalities') {
    console.log('Hero personalities:', getPersonalities('hero').join(', '));
    console.log('Witch personalities:', getPersonalities('witch').join(', '));
    return;
  }

  if (command === 'create') {
    const battle = createBattle({
      name:           getFlag('name'),
      mapSize:        getFlag('map', 'standard'),
      playersPerSide: parseInt(getFlag('players', '2'), 10),
    });
    console.log(`Created: ${battle.name} (${battle.id})`);
    return;
  }

  if (command === 'list') {
    const all = listBattles();
    if (all.length === 0) { console.log('No remote battles.'); return; }
    console.log(`\n${'ID'.padEnd(10)} ${'Name'.padEnd(30)} ${'Map'.padEnd(10)} ${'Round'.padEnd(6)} ${'Phase'.padEnd(12)} ${'Players'.padEnd(8)} Winner`);
    for (const b of all) {
      console.log(`${b.id.slice(0, 8).padEnd(10)} ${b.name.padEnd(30)} ${b.mapSize.padEnd(10)} ${String(b.round).padEnd(6)} ${b.phase.padEnd(12)} ${String(b.rosterCount).padEnd(8)} ${b.winner || '-'}`);
    }
    console.log('');
    return;
  }

  const battleId = args[1];
  if (!battleId) {
    console.error('Error: battleId required. Use "list" to see available battles.');
    process.exit(1);
  }

  if (command === 'status') {
    const status = getBattleStatus(battleId);
    if (!status) { console.error('Battle not found.'); process.exit(1); }
    printStatus(status);
    return;
  }

  if (command === 'add-player') {
    const faction = getFlag('faction');
    if (!faction) { console.error('--faction required (hero or witch)'); process.exit(1); }
    const result = addPlayer(battleId, {
      faction,
      type:        getFlag('type', 'ai'),
      personality: getFlag('personality', 'balanced'),
      name:        getFlag('name'),
      llmEndpoint: getFlag('endpoint'),
      llmPrompt:   getFlag('prompt'),
    });
    if (result.ok) {
      console.log(`Added ${faction} player: ${result.playerId}`);
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'start') {
    const result = startBattle(battleId);
    if (result.ok) {
      console.log('Battle started!');
      const status = getBattleStatus(battleId);
      if (status) printStatus(status);
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'take-turn') {
    const playerId = args[2];
    if (!playerId) { console.error('playerId required.'); process.exit(1); }
    const result = await generateTurn(battleId, playerId);
    if (result.ok) {
      console.log(`Generated ${result.plan.length} actions.`);
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'take-all-turns') {
    const result = await generateAllTurns(battleId);
    if (result.ok) {
      for (const r of result.results) {
        console.log(`  ${r.name}: ${r.ok ? `${r.plan.length} actions` : r.error}`);
      }
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'resolve') {
    const result = resolveRound(battleId);
    if (result.ok) {
      console.log(`Resolved! (${result.steps.length} steps)`);
      const status = getBattleStatus(battleId);
      if (status) printStatus(status);
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'resign') {
    const playerId = args[2];
    if (!playerId) { console.error('playerId required.'); process.exit(1); }
    const result = resignPlayer(battleId, playerId);
    if (result.ok) {
      console.log('Player resigned.');
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'auto') {
    // Run N rounds automatically: generate all turns, resolve, repeat
    const maxRounds = parseInt(getFlag('rounds', '10'), 10);
    const status = getBattleStatus(battleId);
    if (!status) { console.error('Battle not found.'); process.exit(1); }

    // Start if still in setup
    if (status.phase === 'setup') {
      const startResult = startBattle(battleId);
      if (!startResult.ok) { console.error('Start error:', startResult.error); process.exit(1); }
      console.log('Battle started.');
    }

    for (let i = 0; i < maxRounds; i++) {
      const current = getBattleStatus(battleId);
      if (!current || current.gameOver) {
        console.log(current?.gameOver ? `Game over at round ${current.round}! Winner: ${current.winner}` : 'Battle ended.');
        break;
      }

      console.log(`--- Round ${current.round} ---`);
      const genResult = await generateAllTurns(battleId);
      if (!genResult.ok) { console.error('Turn generation error:', genResult.error); break; }
      for (const r of genResult.results) {
        console.log(`  ${r.name}: ${r.ok ? `${r.plan.length} actions` : r.error}`);
      }

      const resResult = resolveRound(battleId);
      if (!resResult.ok) { console.error('Resolution error:', resResult.error); break; }
      console.log(`  Resolved (${resResult.steps.length} steps)`);
    }

    const finalStatus = getBattleStatus(battleId);
    if (finalStatus) printStatus(finalStatus);
    return;
  }

  console.error(`Unknown command: ${command}. Run with "help" for usage.`);
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
