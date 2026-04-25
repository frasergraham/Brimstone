import { test, describe } from 'node:test';
import assert from 'node:assert';

import { buildObjectivesHtml } from '../src/ui-render.js';

// Minimal node-objective fixtures — the function only reads .col/.row/.label/.color
// for rendering the node dots; the side-label tests below don't depend on them.
const objectives = [
  { col: 3, row: 3, label: 'Node A', hexes: [{ col: 3, row: 3 }] },
  { col: 7, row: 5, label: 'Node B', hexes: [{ col: 7, row: 5 }] },
];

describe('buildObjectivesHtml — side labels', () => {
  test('no players → falls back to default Hero / Witch labels', () => {
    const r = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 }, 'standard');
    assert.equal(r.heroLabelHtml,  '⚔ Hero');
    assert.equal(r.witchLabelHtml, 'Witch ✦');
  });

  test('1v1 with concrete factions → uses faction display names', () => {
    const players = [
      { name: 'A', faction: 'hero',  factionId: 'rogue',       color: '#aaa' },
      { name: 'B', faction: 'witch', factionId: 'necromancer', color: '#bbb' },
    ];
    const r = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 }, 'standard', players);
    assert.equal(r.heroLabelHtml,  '⚔ Rogue');
    assert.equal(r.witchLabelHtml, 'Necromancer ✦');
  });

  test('1v1 with default factions → Hero / Witch (singular)', () => {
    const players = [
      { name: 'A', faction: 'hero',  factionId: 'hero',  color: '#aaa' },
      { name: 'B', faction: 'witch', factionId: 'witch', color: '#bbb' },
    ];
    const r = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 }, 'standard', players);
    assert.equal(r.heroLabelHtml,  '⚔ Hero');
    assert.equal(r.witchLabelHtml, 'Witch ✦');
  });

  test('1v1 with unknown factionId → falls back to Hero / Witch', () => {
    const players = [
      { name: 'A', faction: 'hero',  factionId: 'no-such-faction', color: '#aaa' },
      { name: 'B', faction: 'witch', factionId: 'witch',           color: '#bbb' },
    ];
    const r = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 }, 'standard', players);
    assert.equal(r.heroLabelHtml,  '⚔ Hero');
    assert.equal(r.witchLabelHtml, 'Witch ✦');
  });

  test('NvN → renders one player-color glyph per player on each side', () => {
    const players = [
      { name: 'Alice',   faction: 'hero',  factionId: 'rogue',       color: '#ff0000' },
      { name: 'Bob',     faction: 'hero',  factionId: 'captain',     color: '#00ff00' },
      { name: 'Charlie', faction: 'witch', factionId: 'witch',       color: '#0000ff' },
      { name: 'Dave',    faction: 'witch', factionId: 'necromancer', color: '#ffff00' },
    ];
    const r = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 }, 'standard', players);

    // Hero side: 2 player icons with name tooltips and per-player colors
    const heroIcons = (r.heroLabelHtml.match(/score-bar-player-icon/g) || []).length;
    assert.equal(heroIcons, 2, 'should render 2 hero-side icons');
    assert.ok(r.heroLabelHtml.includes('color:#ff0000'), 'Alice color present');
    assert.ok(r.heroLabelHtml.includes('color:#00ff00'), 'Bob color present');
    assert.ok(r.heroLabelHtml.includes('title="Alice"'), 'Alice name tooltip');
    assert.ok(r.heroLabelHtml.includes('title="Bob"'),   'Bob name tooltip');
    assert.ok(r.heroLabelHtml.includes('⚔'), 'hero glyph used');
    // Should NOT contain the faction display name in NvN
    assert.ok(!r.heroLabelHtml.includes('Rogue'), 'no faction text label in NvN');

    // Witch side: 2 player icons
    const witchIcons = (r.witchLabelHtml.match(/score-bar-player-icon/g) || []).length;
    assert.equal(witchIcons, 2, 'should render 2 witch-side icons');
    assert.ok(r.witchLabelHtml.includes('title="Charlie"'));
    assert.ok(r.witchLabelHtml.includes('title="Dave"'));
    assert.ok(r.witchLabelHtml.includes('✦'), 'witch glyph used');
  });

  test('asymmetric 2v1 → hero side gets icons, witch side gets faction name', () => {
    const players = [
      { name: 'Alice', faction: 'hero',  factionId: 'rogue',       color: '#ff0000' },
      { name: 'Bob',   faction: 'hero',  factionId: 'captain',     color: '#00ff00' },
      { name: 'Char',  faction: 'witch', factionId: 'necromancer', color: '#0000ff' },
    ];
    const r = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 }, 'standard', players);
    assert.ok(r.heroLabelHtml.includes('score-bar-player-icon'),  'hero side: icons');
    assert.equal(r.witchLabelHtml, 'Necromancer ✦', 'witch side: faction name');
  });

  test('player names with HTML special chars are escaped', () => {
    const players = [
      { name: 'Alice', faction: 'hero', factionId: 'rogue',  color: '#aaa' },
      { name: 'Bob',   faction: 'hero', factionId: 'rogue',  color: '#bbb' },
      { name: '<x>"&', faction: 'witch', factionId: 'witch', color: '#ccc' },
      { name: 'Y',     faction: 'witch', factionId: 'witch', color: '#ddd' },
    ];
    const r = buildObjectivesHtml(objectives, [], { hero: 0, witch: 0 }, 'standard', players);
    assert.ok(!r.witchLabelHtml.includes('<x>'), 'raw < should be escaped');
    assert.ok(r.witchLabelHtml.includes('&lt;x&gt;'), 'angle brackets escaped');
    assert.ok(r.witchLabelHtml.includes('&quot;'), 'quote escaped');
    assert.ok(r.witchLabelHtml.includes('&amp;'),  'ampersand escaped');
  });
});
