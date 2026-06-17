// Source-assertion tests for the restructured main menu (worker-taro):
//   1. How-to-Play and Options cards/buttons are fully removed.
//   2. The four New-Game mode buttons are hoisted onto the main welcome card.
//   3. A Replays section lives inline on the main card (no separate screen).
//   4. The Electron server-settings panel is relocated into the Account card.
//   5. Routing for the kept mode buttons is preserved.
//
// These are pure string/structure assertions over index.html and src/main.js —
// no DOM or browser needed. The menu is a visual layout change; the presence /
// absence of buttons and the wiring are what's testable here.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const mainJs = readFileSync(join(root, 'src', 'main.js'), 'utf8');

/** Extract the markup of a setup-step card by id, up to the next setup card. */
function cardBlock(htmlSrc, id) {
  const start = htmlSrc.indexOf(`id="${id}"`);
  assert.ok(start !== -1, `card #${id} should exist`);
  // The next sibling card starts at the following `id="setup-step-` token.
  const next = htmlSrc.indexOf('id="setup-step-', start + 1);
  return htmlSrc.slice(start, next === -1 ? undefined : next);
}

describe('main menu — deleted cards and buttons', () => {
  test('How-to-Play card and button are gone', () => {
    assert.ok(!html.includes('id="setup-step-howtoplay"'), 'howtoplay card removed');
    assert.ok(!html.includes('id="btn-how-to-play"'), 'How to Play button removed');
    assert.ok(!html.includes('id="btn-play-tutorial"'), 'Play the Tutorial button removed');
    assert.ok(!html.includes('howtoplay-body'), 'howtoplay body markup removed');
  });

  test('Options card and button are gone', () => {
    assert.ok(!html.includes('id="setup-step-options"'), 'options card removed');
    assert.ok(!html.includes('id="btn-options"'), 'Options button removed');
    assert.ok(!html.includes('id="options-empty-msg"'), 'options empty message removed');
    assert.ok(!html.includes('id="options-speed-buttons"'), 'options speed buttons removed');
  });

  test('New Game submenu card and parent button are gone (flattened)', () => {
    assert.ok(!html.includes('id="setup-step-newgame"'), 'newgame submenu card removed');
    assert.ok(!html.includes('id="btn-new-game"'), 'New Game parent button removed');
    assert.ok(!html.includes('id="btn-newgame-back"'), 'newgame back button removed');
  });

  test('standalone Replays screen is gone (inlined into main card)', () => {
    assert.ok(!html.includes('id="setup-step-replays"'), 'separate replays screen removed');
    assert.ok(!html.includes('id="btn-replays-back"'), 'replays back button removed');
    assert.ok(!html.includes('id="btn-replays"'), 'Replays nav button removed');
  });
});

describe('main menu — two-column layout on the welcome card', () => {
  const mode = cardBlock(html, 'setup-step-mode');

  test('Active Games section is present in the active-games column', () => {
    assert.ok(mode.includes('id="mm-games-section"'), 'Active Games section present');
    // The active-games column (left) is rendered before the menus column, so
    // Active Games appears before the mode buttons in DOM order.
    assert.ok(
      mode.indexOf('id="mm-games-section"') < mode.indexOf('id="btn-ng-campaign"'),
      'Active Games sits in the column ahead of the mode buttons',
    );
  });

  test('all four mode buttons are present at top level, in order', () => {
    for (const id of ['btn-ng-campaign', 'btn-ng-vsai', 'btn-ng-battle', 'btn-ng-online']) {
      assert.ok(mode.includes(`id="${id}"`), `${id} present on main card`);
    }
    const order = ['btn-ng-campaign', 'btn-ng-vsai', 'btn-ng-battle', 'btn-ng-online']
      .map(id => mode.indexOf(`id="${id}"`));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'mode buttons keep submenu order');
  });

  test('Replays section lives in the active-games column, below Active Games', () => {
    assert.ok(mode.includes('id="mm-replays-list"'), 'replays list present on main card');
    // Replays is grouped with Active Games in the left column — it sits below
    // the active-games list and ahead of the (right-column) mode buttons.
    assert.ok(
      mode.indexOf('id="mm-games-section"') < mode.indexOf('id="mm-replays-section"'),
      'Replays sits below Active Games in the same column',
    );
    assert.ok(
      mode.indexOf('id="mm-replays-section"') < mode.indexOf('id="btn-ng-campaign"'),
      'the whole active-games column precedes the menus column',
    );
  });

  test('two columns wrap active games (left) and menus (right)', () => {
    assert.ok(mode.includes('class="mm-columns"'), 'columns container present');
    assert.ok(mode.includes('mm-col-games'), 'active-games column present');
    assert.ok(mode.includes('mm-col-menus'), 'menus column present');
    // mm-games-section + replays live inside the games column; mode buttons
    // live inside the menus column → games column markup precedes menus column.
    assert.ok(
      mode.indexOf('mm-col-games') < mode.indexOf('mm-col-menus'),
      'games column is rendered before the menus column',
    );
  });
});

describe('main menu — mobile column slide toggle', () => {
  const mode = cardBlock(html, 'setup-step-mode');

  test('toggle markup with left (games) / right (menus) arrows is present', () => {
    assert.ok(mode.includes('class="mm-col-toggle"'), 'toggle bar present');
    assert.match(mode, /class="mm-col-arrow"[^>]*data-col="games"/, 'left arrow → games');
    assert.match(mode, /data-col="menus"[^>]*>Menus/, 'right arrow → menus');
    assert.ok(mode.includes('mm-col-dot'), 'progress dots present');
  });

  test('title swaps between Caleb\'s Hollow (menus) and Active Games (games)', () => {
    assert.ok(mode.includes('mm-title-menus'), 'menus title span present');
    assert.ok(mode.includes('mm-title-games'), 'games title span present');
    assert.ok(mode.includes("CALEB'S HOLLOW"), 'menus title text preserved');
    assert.match(mode, /mm-title-games">ACTIVE GAMES/, 'games title text present');
  });

  test('card defaults to the menus column', () => {
    assert.match(html, /id="setup-step-mode"[^>]*class="[^"]*mm-show-menus/, 'defaults to menus view');
  });

  test('toggle handler is wired and drives the show-games / show-menus classes', () => {
    assert.match(mainJs, /function _setMmColumn\(col\)/, 'handler defined');
    assert.match(mainJs, /classList\.toggle\('mm-show-games'/, 'toggles games class');
    assert.match(mainJs, /classList\.toggle\('mm-show-menus'/, 'toggles menus class');
    assert.match(mainJs, /\.mm-col-arrow, \.mm-col-dot[\s\S]{0,120}?_setMmColumn\(/, 'arrows/dots wired to handler');
  });

  test('entering the mode screen resets to the menus column', () => {
    assert.match(mainJs, /step === 'mode'[\s\S]{0,200}?_setMmColumn\?\.\('menus'\)/, 'showStep resets to menus');
  });
});

describe('main menu — Electron server settings preserved', () => {
  test('server-settings panel is relocated into the Account card', () => {
    assert.ok(html.includes('id="electron-server-settings"'), 'panel still exists');
    const account = cardBlock(html, 'setup-step-account');
    assert.ok(account.includes('id="electron-server-settings"'), 'panel lives in Account card');
    assert.ok(account.includes('id="electron-server-url"'), 'server URL input preserved');
    assert.ok(account.includes('id="electron-update-section"'), 'version section preserved');
  });
});

describe('main menu — routing preserved for kept buttons', () => {
  const cases = [
    ['btn-ng-vsai', '_showSinglePlayerScreen'],
    ['btn-ng-battle', '_showBattleScreen'],
    ['btn-ng-online', '_showOnlineScreen'],
  ];
  for (const [btn, handler] of cases) {
    test(`${btn} still routes to ${handler}`, () => {
      const re = new RegExp(
        `getElementById\\('${btn}'\\)[\\s\\S]{0,80}?${handler}\\(`,
      );
      assert.match(mainJs, re);
    });
  }

  test('btn-ng-campaign skips the chapter picker → Chapter 1 slot picker', () => {
    // The chapter-select screen is no longer surfaced (only Ch1 ships); the
    // Campaign menu choice goes straight to Chapter 1's save-slot picker.
    const re = /getElementById\('btn-ng-campaign'\)[\s\S]{0,500}?_showCampaignSlotScreen\(ch1\)/;
    assert.match(mainJs, re);
    assert.match(mainJs, /getCampaignById\('calebs_hollow_prologue'\)/);
  });

  test('no listeners reference removed steps', () => {
    for (const step of ['newgame', 'replays', 'howtoplay', 'options']) {
      assert.ok(
        !mainJs.includes(`showStep('${step}')`),
        `showStep('${step}') should be gone`,
      );
    }
  });

  test('inline replays list is rendered when entering the mode screen', () => {
    assert.match(mainJs, /async function _renderReplaysList\(\)/);
    assert.match(mainJs, /_renderReplaysList\?\.\(\)/);
  });
});
