// Postgres backend aggregator. `./client.js` connects on first use (lazy) so
// that simply importing this module doesn't require DATABASE_URL unless an
// actual query is executed.
import { transaction, close } from './client.js';
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
};

export default db;
