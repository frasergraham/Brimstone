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

describe('main menu — flattened layout on the welcome card', () => {
  const mode = cardBlock(html, 'setup-step-mode');

  test('Active Games section is present at the top of the card', () => {
    assert.ok(mode.includes('id="mm-games-section"'), 'Active Games section present');
    // Active Games appears before the mode buttons.
    assert.ok(
      mode.indexOf('id="mm-games-section"') < mode.indexOf('id="btn-ng-campaign"'),
      'Active Games sits above the mode buttons',
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

  test('Replays section is present below the mode buttons', () => {
    assert.ok(mode.includes('id="mm-replays-list"'), 'replays list present on main card');
    assert.ok(
      mode.indexOf('id="btn-ng-online"') < mode.indexOf('id="mm-replays-list"'),
      'Replays sits below the mode buttons',
    );
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
