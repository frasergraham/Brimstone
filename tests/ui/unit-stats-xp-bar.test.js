// Tests for the campaign XP bar in the Unit Stats Bar (per-unit HUD panel).
//
// The XP bar sits beneath the HP bar and shows campaign veterancy progress. It
// is gated on the same chokepoint awardXP() uses: state.isCampaign && a
// hero-owned (levelling) unit. Non-campaign games and witch / non-levelling
// units must render NO bar at all — not "0/0", not greyed, absent.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  installGlobalMocks,
  createElementsBag,
  makeFakeRenderer,
  makeFakeCanvas,
} from './setup.js';

const { fakeCanvas, _elements } = installGlobalMocks();

let UIController, GameState, xpProgress;

before(async () => {
  const [uiMod, gameMod, campMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
    import('../../src/campaign/campaign-ui.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
  xpProgress   = campMod.xpProgress;
});

function makeUI() {
  const state    = new GameState(true, false);
  state.fogOfWar = 'none';
  const renderer = makeFakeRenderer();
  const els      = createElementsBag();
  Object.assign(_elements, els);
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false);
  return { ui, state, els };
}

/** Render the unit stats bar with `entity` selected; return the bar innerHTML. */
function renderWith(ui, els, entity) {
  ui._selectedEntity = entity;
  ui._selectedTile   = null;
  ui._renderUnitStatsBar();
  return els['unit-stats-bar'].innerHTML;
}

describe('Unit Stats Bar — campaign XP bar', () => {
  test('campaign + hero unit → XP bar present with correct level/xp text', () => {
    const { ui, state, els } = makeUI();
    state.isCampaign = true;
    const hero = state.entities.find(e => e.owner === 'hero' && e.alive);
    assert.ok(hero, 'state should have a living hero-faction unit');

    // Put the hero partway into level 2: xpForLevel(2)=200, xpForLevel(3)=600.
    hero.level = 2;
    hero.xp    = 250;
    const { level, into, span, pct } = xpProgress(hero.level, hero.xp);
    assert.deepEqual({ level, into, span }, { level: 2, into: 50, span: 400 },
      'sanity: curve math matches the campaign formatter');

    const html = renderWith(ui, els, hero);
    assert.ok(html.includes('usb-xp-fill'),  'XP fill element should render');
    assert.ok(html.includes('usb-xp-wrap'),  'XP wrap should render');
    assert.ok(html.includes(`${into}/${span} XP`), 'XP numerator/denominator label present');
    assert.ok(html.includes(`width:${pct}%`), 'fill width reflects xp/xpForLevel');
    // Level label — `Lv <span ...>2</span>`
    assert.ok(/Lv\s*<span[^>]*>2<\/span>/.test(html), 'level label shows Lv 2');
  });

  test('campaign + survivor (hero-owned) → XP bar present too', () => {
    const { ui, state, els } = makeUI();
    state.isCampaign = true;
    const survivor = state.entities.find(e => e.owner === 'hero' && e.type === 'survivor' && e.alive)
      ?? state.entities.find(e => e.owner === 'hero' && e.alive);
    assert.ok(survivor, 'state should have a hero-owned unit');

    const html = renderWith(ui, els, survivor);
    assert.ok(html.includes('usb-xp-fill'), 'hero-owned units show the XP bar');
  });

  test('non-campaign game → XP bar ABSENT (gate)', () => {
    const { ui, state, els } = makeUI();
    state.isCampaign = false;
    const hero = state.entities.find(e => e.owner === 'hero' && e.alive);
    hero.level = 3;
    hero.xp    = 700;

    const html = renderWith(ui, els, hero);
    assert.ok(!html.includes('usb-xp-fill'), 'no XP bar outside campaign mode');
    assert.ok(!html.includes('usb-xp-wrap'), 'no XP wrap outside campaign mode');
    // HP bar must still render — we only suppress XP, not the whole panel.
    assert.ok(html.includes('usb-hp-fill'), 'HP bar still renders in non-campaign');
  });

  test('campaign + witch-side unit → XP bar ABSENT (non-levelling faction)', () => {
    const { ui, state, els } = makeUI();
    state.isCampaign = true;
    const witch = state.entities.find(e => e.owner === 'witch' && e.alive);
    assert.ok(witch, 'state should have a living witch-faction unit');

    const html = renderWith(ui, els, witch);
    assert.ok(!html.includes('usb-xp-fill'), 'witch-side units never show the XP bar');
    assert.ok(html.includes('usb-hp-fill'),  'HP bar still renders for witch units');
  });
});
