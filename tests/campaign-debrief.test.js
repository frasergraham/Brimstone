// Tests for the campaign post-mission debrief — the Victory/Defeat header
// selection (buildDebriefHeader) and the surviving-roster / fallen-memorial
// body builders the debrief overlay renders. The overlay DOM + Continue routing
// live in main.js (DOM-bound, exercised by the verifier-browser pass); the pure
// data here is what unit tests can guard against regression.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDebriefHeader, campaignPartyHTML, fallenSectionHTML,
} from '../src/campaign/campaign-ui.js';

describe('campaign debrief — header selection', () => {
  const mission = {
    victoryText: 'The golem crumbles. A survivor joins you.',
    defeatText: 'The dead overwhelm you. The Hollow falls.',
  };

  test('a WIN yields VICTORY + the mission victoryText', () => {
    const h = buildDebriefHeader(mission, true);
    assert.equal(h.title, 'VICTORY');
    assert.equal(h.text, mission.victoryText);
  });

  test('a LOSS yields DEFEAT + the mission defeatText', () => {
    const h = buildDebriefHeader(mission, false);
    assert.equal(h.title, 'DEFEAT');
    assert.equal(h.text, mission.defeatText);
  });

  test('missing victoryText/defeatText fall back to safe defaults', () => {
    assert.equal(buildDebriefHeader({}, true).text, 'Mission complete.');
    assert.equal(buildDebriefHeader({}, false).text, 'Mission failed.');
    // Null/undefined missionDef must not throw.
    assert.equal(buildDebriefHeader(null, true).title, 'VICTORY');
    assert.equal(buildDebriefHeader(undefined, false).title, 'DEFEAT');
  });
});

describe('campaign debrief — roster + fallen body', () => {
  const heroSnap = { hp: 8, maxHp: 12, attack: 3, defense: 2 };
  const survivors = [
    { name: 'Sarah', title: 'Farmer', hp: 5, maxHp: 6, attack: 2, defense: 1 },
    { name: 'John', title: 'Innkeeper', hp: 4, maxHp: 7, attack: 1, defense: 2 },
  ];

  test('surviving roster renders the hero card + each survivor', () => {
    const html = campaignPartyHTML(heroSnap, survivors);
    assert.match(html, /campaign-party/);
    assert.match(html, /Ishmael Charger/);   // the fixed campaign hero
    assert.match(html, /Sarah/);
    assert.match(html, /John/);
  });

  test('empty roster (all fell / none deployed) still renders the hero card', () => {
    const html = campaignPartyHTML(heroSnap, []);
    assert.match(html, /Ishmael Charger/);
    assert.doesNotMatch(html, /Sarah/);
  });

  test('fallen memorial lists this run casualties with where they fell', () => {
    const fallen = [{ name: 'Marcus', title: 'Blacksmith', level: 2, diedInMission: 'prologue' }];
    const resolve = (id) => (id === 'prologue' ? "Trouble at The Wanderer's Inn" : id);
    const html = fallenSectionHTML(fallen, resolve);
    assert.match(html, /Fallen/);
    assert.match(html, /Marcus/);
    assert.match(html, /Trouble at The Wanderer/);
  });

  test('no casualties → no memorial section (empty string)', () => {
    assert.equal(fallenSectionHTML([], (id) => id), '');
    assert.equal(fallenSectionHTML(undefined, (id) => id), '');
  });
});
