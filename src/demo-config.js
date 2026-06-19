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
