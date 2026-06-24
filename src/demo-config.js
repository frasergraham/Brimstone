// ============================================================================
// Demo configuration — flip unfinished content OFF for demo / preview builds.
//
// A tiny, embedded, hand-edited config: keep the UI present but mark
// not-yet-shipped game modes and champions as "Coming Soon" (visible but
// disabled). Pure data + two predicate helpers — no DOM, no imports — so the
// menu (and a unit test) can ask "is this available?" in one place.
//
// To gate something for a demo, flip its flag to `false`:
//   modes.*    — a rail game-mode entry. `false` ⇒ rendered with a
//                "Coming Soon" badge, non-clickable.
//   factions.* — a champion id (matches src/factions.js ids). `false` ⇒ the
//                Skirmish + Online pickers show it disabled with "Coming Soon".
//
// Default ships everything ON except the two unimplemented champions
// (Captain, Necromancer) — the mechanism is wired so flipping a mode is a
// one-line change.
// ============================================================================

export const COMING_SOON_LABEL = 'Coming Soon';

export const DEMO_CONFIG = Object.freeze({
  // Game modes (true = available, false = coming soon). Keys mirror the
  // conceptual modes; the rail maps the ones it actually renders
  // (see MODE_BY_DESTINATION below).
  modes: Object.freeze({
    skirmish:  true,
    twoPlayer: true,
    aiVsAi:    true,
    online:    true,
    campaign:  true,
  }),
  // Champions/factions (true = available, false = coming soon). Ids match the
  // faction registry in src/factions.js. Captain & Necromancer aren't
  // implemented yet, so they ship disabled.
  factions: Object.freeze({
    captain:     false,
    necromancer: false,
  }),
});

// Rail destination id → demo mode key. The ledger rail uses destination ids
// ('skirmish'/'campaign'/'others'/…); this maps the gate-able ones onto the
// `modes` keys above. Destinations without an entry are never gated.
export const MODE_BY_DESTINATION = Object.freeze({
  skirmish: 'skirmish',
  campaign: 'campaign',
  others:   'online',     // "Play Online" rail entry
});

/**
 * Is a game mode available? Unknown keys default to available (true) so new
 * modes aren't accidentally hidden — gating is opt-out, not opt-in.
 * @param {string} modeKey  one of the `modes` keys (or a rail destination via MODE_BY_DESTINATION)
 */
export function isModeAvailable(modeKey) {
  if (!modeKey) return true;
  const key = MODE_BY_DESTINATION[modeKey] ?? modeKey;
  const v = DEMO_CONFIG.modes[key];
  return v === undefined ? true : v === true;
}

/**
 * Is a champion/faction available? Unknown ids default to available (true).
 * @param {string} factionId  a faction id (e.g. 'captain', 'necromancer')
 */
export function isFactionAvailable(factionId) {
  if (!factionId) return true;
  const v = DEMO_CONFIG.factions[factionId];
  return v === undefined ? true : v === true;
}

// Rail destinations that need a live game server (online play + the account /
// leaderboard identity). On the static itch.io build there is NO server, so
// these entries are hidden entirely rather than shown and erroring on click.
export const ONLINE_ONLY_DESTINATIONS = Object.freeze(['others', 'account']);

/**
 * Is this a server-less STATIC build (the itch.io zip)? scripts/build-itch.js
 * injects `window.BRIMSTONE_ITCH = true` into the built index.html; every other
 * build (dev server, Electron, Capacitor) leaves it unset. Pure read of the
 * passed-in flag so a unit test can drive it without a DOM.
 * @param {boolean} [flag]  defaults to window.BRIMSTONE_ITCH (undefined off-DOM)
 */
export function isStaticBuild(flag = (typeof window !== 'undefined' ? window.BRIMSTONE_ITCH : undefined)) {
  return flag === true;
}

/**
 * Is online play (and the account / leaderboard) available in this build? False
 * only on the static itch.io build, where there is no server to reach. Other
 * builds always return true — the dev / Electron / Capacitor cases where
 * BRIMSTONE_SERVER may be momentarily unset must NOT hide Online.
 * @param {boolean} [staticFlag]  defaults to isStaticBuild()
 */
export function isOnlineAvailable(staticFlag = isStaticBuild()) {
  return !staticFlag;
}
