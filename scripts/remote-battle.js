#!/usr/bin/env node
// CLI for managing admin-controlled AI players in existing battle rooms.
//
// Usage:
//   node scripts/remote-battle.js rooms                              # list active battle rooms
//   node scripts/remote-battle.js status <roomId>                    # show room detail
//   node scripts/remote-battle.js add <roomId> --faction hero [--type ai] [--personality balanced]
//   node scripts/remote-battle.js add <roomId> --faction witch --type llm --endpoint https://...
//   node scripts/remote-battle.js take-turn <roomId> <playerId>      # generate + submit plan for one player
//   node scripts/remote-battle.js take-all <roomId>                  # generate plans for all remote AIs
//   node scripts/remote-battle.js resign <roomId> <playerId>         # remove a remote AI from the battle
//   node scripts/remote-battle.js personalities                      # list available AI personalities

import {
  getPersonalities,
  listBattleRooms,
  addPlayer,
  takeTurn,
  takeAllTurns,
  resignPlayer,
  getRoomRemoteStatus,
} from '../server/remote-battle.js';

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name, defaultVal = null) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}

function printStatus(b) {
  console.log(`\n  Room: ${b.roomId.slice(0, 8)}`);
  console.log(`  Round: ${b.round}  |  Phase: ${b.phase}  |  Game Phase: ${b.gamePhase || '-'}`);
  console.log(`  Players: ${b.heroCount}H / ${b.witchCount}W (max ${b.maxPerSide} per side)`);
  if (b.gameOver) {
    console.log(`  GAME OVER — Winner: ${b.winner} (${b.winReason})`);
  }
  if (b.nodeScore) {
    console.log(`  Score — Hero: ${b.nodeScore.hero}  Witch: ${b.nodeScore.witch}`);
  }
  console.log(`\n  All Players:`);
  for (const r of b.allPlayers) {
    const ctrl = r.adminControlled ? '* ' : '  ';
    const typeTag = r.adminControlled ? (r.type === 'llm' ? 'remote-llm' : 'remote-ai') : (r.isAI ? 'auto-ai' : 'human');
    const sub = r.submitted ? 'submitted' : 'pending';
    const leader = r.leader?.alive ? `HP ${r.leader.hp}/${r.leader.maxHp}` : 'dead';
    console.log(`  ${ctrl}${r.faction.padEnd(5)} ${r.name.padEnd(20)} ${typeTag.padEnd(12)} ${(r.personality || '-').padEnd(12)} ${leader.padEnd(12)} ${r.entityCount} units  [${sub}]`);
  }
  console.log(`\n  (* = admin-controlled)`);
  if (b.log.length > 0) {
    console.log(`\n  Recent log:`);
    for (const l of b.log.slice(-10)) console.log(`    ${l}`);
  }
  console.log('');
}

async function main() {
  if (!command || command === 'help') {
    console.log(`
Usage:
  node scripts/remote-battle.js rooms                                # list active battle rooms
  node scripts/remote-battle.js status <roomId>                      # show room detail + all players
  node scripts/remote-battle.js add <roomId> --faction hero [--type ai] [--personality balanced]
  node scripts/remote-battle.js add <roomId> --faction witch --type llm --endpoint https://...
  node scripts/remote-battle.js take-turn <roomId> <playerId>        # generate + submit one player's turn
  node scripts/remote-battle.js take-all <roomId>                    # generate turns for all remote AIs
  node scripts/remote-battle.js resign <roomId> <playerId>           # remove a remote AI from the battle
  node scripts/remote-battle.js personalities                        # list available AI personalities
`);
    return;
  }

  if (command === 'personalities') {
    console.log('Hero personalities:', getPersonalities('hero').join(', '));
    console.log('Witch personalities:', getPersonalities('witch').join(', '));
    return;
  }

  if (command === 'rooms') {
    const rooms = listBattleRooms();
    if (rooms.length === 0) { console.log('No active battle rooms.'); return; }
    console.log(`\n${'Room'.padEnd(10)} ${'Round'.padEnd(6)} ${'Phase'.padEnd(12)} ${'Heroes'.padEnd(8)} ${'Witches'.padEnd(8)} ${'Remote AIs'}`);
    for (const r of rooms) {
      console.log(`${r.roomId.slice(0, 8).padEnd(10)} ${String(r.round).padEnd(6)} ${r.phase.padEnd(12)} ${`${r.heroCount}/${r.maxPerSide}`.padEnd(8)} ${`${r.witchCount}/${r.maxPerSide}`.padEnd(8)} ${r.remoteAIs}`);
    }
    console.log('');
    return;
  }

  const roomId = args[1];
  if (!roomId) {
    console.error('Error: roomId required. Use "rooms" to see active battle rooms.');
    process.exit(1);
  }

  if (command === 'status') {
    const status = getRoomRemoteStatus(roomId);
    if (!status) { console.error('Battle room not found.'); process.exit(1); }
    printStatus(status);
    return;
  }

  if (command === 'add') {
    const faction = getFlag('faction');
    if (!faction) { console.error('--faction required (hero or witch)'); process.exit(1); }
    const result = addPlayer(roomId, {
      faction,
      type:        getFlag('type', 'ai'),
      personality: getFlag('personality', 'balanced'),
      name:        getFlag('name'),
      llmEndpoint: getFlag('endpoint'),
      llmPrompt:   getFlag('prompt'),
    });
    if (result.ok) {
      console.log(`Added remote ${result.type || 'ai'} ${faction}: ${result.name} (${result.playerId})`);
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'take-turn') {
    const playerId = args[2];
    if (!playerId) { console.error('playerId required.'); process.exit(1); }
    const result = await takeTurn(roomId, playerId);
    if (result.ok) {
      console.log(`Generated ${result.plan.length} actions.`);
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'take-all') {
    const result = await takeAllTurns(roomId);
    if (result.ok) {
      if (result.results.length === 0) {
        console.log('No remote AI players need turns.');
      } else {
        for (const r of result.results) {
          console.log(`  ${r.name}: ${r.ok ? `${r.plan.length} actions` : r.error}`);
        }
      }
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  if (command === 'resign') {
    const playerId = args[2];
    if (!playerId) { console.error('playerId required.'); process.exit(1); }
    const result = resignPlayer(roomId, playerId);
    if (result.ok) {
      console.log('Player resigned from battle.');
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${command}. Run with "help" for usage.`);
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
