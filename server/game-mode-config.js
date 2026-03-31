// Game mode configuration via environment variables.
//
// Each mode can be set to 'enabled' (default), 'disabled' (greyed out), or 'hidden'.
//
// Environment variables:
//   BRIMSTONE_MODE_SINGLEPLAYER  — Single Player menu button
//   BRIMSTONE_MODE_MULTIPLAYER   — Multiplayer menu button
//   BRIMSTONE_MODE_TUTORIAL      — Tutorial menu button
//   BRIMSTONE_MODE_STORY         — Story Mode (under Single Player)
//   BRIMSTONE_MODE_QUICKPLAY     — Quick Play (under Single Player)
//   BRIMSTONE_MODE_LOCAL         — Local Pass & Play (under Multiplayer)

const VALID_STATES = ['enabled', 'disabled', 'hidden'];
const DEFAULT_STATE = 'enabled';

const MODE_ENV_KEYS = {
  singleplayer: 'BRIMSTONE_MODE_SINGLEPLAYER',
  multiplayer:  'BRIMSTONE_MODE_MULTIPLAYER',
  tutorial:     'BRIMSTONE_MODE_TUTORIAL',
  story:        'BRIMSTONE_MODE_STORY',
  quickplay:    'BRIMSTONE_MODE_QUICKPLAY',
  local:        'BRIMSTONE_MODE_LOCAL',
};

/**
 * Read a single mode state from environment, defaulting to 'enabled'.
 * Invalid values are treated as 'enabled'.
 */
function readModeState(envKey) {
  const raw = (process.env[envKey] || '').toLowerCase().trim();
  return VALID_STATES.includes(raw) ? raw : DEFAULT_STATE;
}

/**
 * Returns the full game-mode config object.
 * Each key maps to 'enabled', 'disabled', or 'hidden'.
 */
export function getGameModeConfig() {
  const config = {};
  for (const [mode, envKey] of Object.entries(MODE_ENV_KEYS)) {
    config[mode] = readModeState(envKey);
  }
  return config;
}

export { MODE_ENV_KEYS, VALID_STATES };
