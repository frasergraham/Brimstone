// UI: the per-turn round summary renders campaign "+N XP" lines.
//
// _showResolutionSummary() builds its events HTML synchronously inside the
// returned Promise's executor (the Promise only settles on a Next/Replay
// click), so we can call it without awaiting and read the committed innerHTML.
//
// Covers:
//   - campaign turn with an XP_AWARDED event → a "✨ <unit> +N XP" line, with a
//     level-up annotation + the .leveled style when the unit crossed a level.
//   - the same step in a NON-campaign game → no XP line (the isCampaign gate).

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';
import { ICON } from '../../src/icons.js';

const { fakeCanvas } = installGlobalMocks();

let UIController, GameState, ResEventType;

before(async () => {
  const [uiMod, gameMod, resMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
    import('../../server/resolver.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
  ResEventType = resMod.ResEventType;
});

function makeUI() {
  const state    = new GameState(true, false);
  const renderer = makeFakeRenderer();
  const els      = createElementsBag();
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return { ui, state, els };
}

// One turn where unit 9001 killed something and crossed level 2 → 3.
function xpSteps() {
  return [{
    entitySnapshot: [{ id: 9001, displayName: 'Goodwife Tam', title: 'Tinker' }],
    heroEvents: [
      { type: ResEventType.XP_AWARDED, faction: 'hero', unitId: 9001, amount: 35, reason: 'combat' },
      { type: ResEventType.XP_AWARDED, faction: 'hero', unitId: 9001, amount: 50, reason: 'kill',
        leveledUp: true, fromLevel: 2, newLevel: 3 },
    ],
  }];
}

describe('round summary — campaign XP lines', () => {
  test('renders one aggregated "+N XP" line attributed to the unit, with level-up', () => {
    const { ui, els } = makeUI();
    ui._showResolutionSummary(xpSteps(), 1,
      { humanFaction: 'hero', fogOfWar: 'none', isCampaign: true }).catch(() => {});

    const html = els['round-summary-events']._innerHTML;
    assert.match(html, /class="summary-xp leveled"/, 'level-up line uses the leveled style');
    // Two events (35 + 50) summed into a single line for the unit.
    assert.match(html, new RegExp(`${ICON.sparkle} Tinker \\+85 XP \\(Lv 2 → 3\\)`));
    assert.equal((html.match(/summary-xp/g) || []).length, 1, 'exactly one XP line for the unit');
  });

  test('non-campaign game shows NO XP line (gate respected)', () => {
    const { ui, els } = makeUI();
    ui._showResolutionSummary(xpSteps(), 1,
      { humanFaction: 'hero', fogOfWar: 'none', isCampaign: false }).catch(() => {});

    const html = els['round-summary-events']._innerHTML;
    assert.ok(!html.includes('summary-xp'), 'no XP line markup outside campaign');
    assert.ok(!html.includes('XP'), 'no XP text outside campaign');
  });
});
