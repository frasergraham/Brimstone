// SQLite backend aggregator. `./client.js` opens the shared handle at its own
// module-load time (reading DB_PATH from the environment) so the domain
// modules below can safely declare prepared statements at module scope.
import { prepare, exec, transaction, close } from './client.js';
import { players }           from './players.js';
import { identities }        from './identities.js';
import { magicTokens }       from './magic-tokens.js';
import { saves }             from './saves.js';
import { saveReplayRounds }  from './save-replay-rounds.js';
import { completedGames }    from './completed-games.js';
import { plans }             from './plans.js';
import { async_ }            from './async.js';
import { gameStats }         from './game-stats.js';
import { campaignStats }     from './campaign-stats.js';
import { campaignSaves }     from './campaign-saves.js';
import { deviceTokens }      from './device-tokens.js';
import { notifications }     from './notifications.js';
import { admin }             from './admin.js';

const db = {
  players,
  identities,
  magicTokens,
  saves,
  saveReplayRounds,
  completedGames,
  plans,
  async: async_,
  gameStats,
  campaignStats,
  campaignSaves,
  deviceTokens,
  notifications,
  admin,
  transaction,
  close,

  // ── Escape hatches ──────────────────────────────────────────────────────
  // Raw SQL access is NOT used by production server code — every consumer
  // goes through the domain namespaces above. These exist so legacy test
  // cleanup/fixture code (tests/*.test.js) can continue to work without a
  // mass rewrite. The Postgres backend deliberately does not expose them;
  // tests that use them only run against SQLite.
  prepare,
  exec,
};

export default db;
