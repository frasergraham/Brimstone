// Centralized faction color theme — single source of truth for faction-level colors.
//
// Terrain colors remain in tiles.js (TILE_COLOR, BUILDING_COLOR).
// Node colors remain in map.js (NODE_COLORS).
// Entity-type colors remain in entities.js (ENTITY_COLOR).
//
// This module defines faction-level display properties that the renderer,
// UI, and other modules should use instead of hardcoded color strings.

/**
 * Per-faction display properties.
 * Keyed by faction ID ('hero', 'witch', etc.).
 */
export const FACTION_THEME = Object.freeze({
  hero: {
    /** Primary color for outlines, highlights, UI accents */
    primary:   '#d4a72c',
    /** Color for node control indicators and hex highlights */
    highlight: '#4488ff',
    /** Semi-transparent node hex fill when this faction controls */
    nodeFill:  'rgba(50,120,220,0.18)',
    /** Per-player multiplayer slot colors (up to 10 players per side) */
    playerColors: [
      '#d4a72c', '#f07020', '#e8d040', '#8b6018', '#ff9944',
      '#c8e020', '#e09060', '#ffcc00', '#b87830', '#f0a868',
    ],
  },
  witch: {
    primary:   '#9b59b6',
    highlight: '#cc3333',
    nodeFill:  'rgba(180,0,80,0.18)',
    playerColors: [
      '#9b59b6', '#d980fa', '#6c3483', '#e040a0', '#8844cc',
      '#a040c0', '#cc60d0', '#b050e0', '#d060b0', '#aa30c8',
    ],
  },
});

/** Default node fill for neutral (uncontrolled) nodes. */
export const NEUTRAL_NODE_FILL = 'rgba(100,100,100,0.1)';

/**
 * Look up a faction's theme. Returns the faction entry or a neutral fallback.
 * @param {string} factionId
 * @returns {{ primary: string, highlight: string, nodeFill: string, playerColors: string[] }}
 */
export function getFactionTheme(factionId) {
  return FACTION_THEME[factionId] ?? { primary: '#888', highlight: '#888', nodeFill: NEUTRAL_NODE_FILL, playerColors: ['#888'] };
}
