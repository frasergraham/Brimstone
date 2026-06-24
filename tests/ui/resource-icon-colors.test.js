// Tests for the resource-icon colorization helpers in src/icons.js.
// These wrap resource glyphs in `.res-icon--<id>` spans so each resource is
// tinted by type (wood brown, herbs green, …) wherever it renders.
// Pure string helpers — no DOM required.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ICON,
  RESOURCE_ICON_COLOR,
  isResourceId,
  coloredResourceIcon,
  coloredResourceLabel,
  tintResourceGlyphs,
  resourceColorForGlyph,
  splitColoredFloaterSegments,
} from '../../src/icons.js';

describe('RESOURCE_ICON_COLOR', () => {
  test('covers all six resource types with distinct thematic hexes', () => {
    for (const id of ['wood', 'metal', 'food', 'silver', 'scripture', 'herbs']) {
      assert.match(RESOURCE_ICON_COLOR[id], /^#[0-9a-f]{6}$/i, `${id} has a hex color`);
    }
    // herbs and its `herb` alias share a color (ICON name vs ResourceType id).
    assert.equal(RESOURCE_ICON_COLOR.herb, RESOURCE_ICON_COLOR.herbs);
  });
});

describe('isResourceId', () => {
  test('true for the six resources, false for non-resources', () => {
    assert.equal(isResourceId('wood'), true);
    assert.equal(isResourceId('herbs'), true);
    assert.equal(isResourceId('horse'), false);
    assert.equal(isResourceId('sword'), false);
    assert.equal(isResourceId(undefined), false);
  });
});

describe('coloredResourceIcon', () => {
  test('wraps a known resource glyph in the typed span', () => {
    const html = coloredResourceIcon('wood');
    assert.equal(html, `<span class="res-icon res-icon--wood">${ICON.wood}</span>`);
  });

  test('maps the `herbs` resource id to the `herb` glyph', () => {
    const html = coloredResourceIcon('herbs');
    assert.equal(html, `<span class="res-icon res-icon--herbs">${ICON.herb}</span>`);
  });

  test('honors an explicit glyph override but keeps the typed class', () => {
    const html = coloredResourceIcon('metal', ICON.metal);
    assert.equal(html, `<span class="res-icon res-icon--metal">${ICON.metal}</span>`);
  });

  test('returns the bare glyph (no span) for an unknown id with a supplied glyph', () => {
    assert.equal(coloredResourceIcon('horse', ICON.horse), ICON.horse);
  });

  test('returns empty string when there is no glyph at all', () => {
    assert.equal(coloredResourceIcon('nonsense'), '');
  });
});

describe('coloredResourceLabel', () => {
  test('tints only the leading glyph and leaves trailing text uncolored', () => {
    const label = `${ICON.herb} Herbs`; // mirrors RESOURCE_LABEL values
    assert.equal(
      coloredResourceLabel(label),
      `<span class="res-icon res-icon--herbs">${ICON.herb}</span> Herbs`,
    );
  });

  test('passes through a label that does not start with a resource glyph', () => {
    const label = `${ICON.horse} Horse`;
    assert.equal(coloredResourceLabel(label), label);
    assert.equal(coloredResourceLabel('plain text'), 'plain text');
  });

  test('is safe on empty / non-string input', () => {
    assert.equal(coloredResourceLabel(''), '');
    assert.equal(coloredResourceLabel(undefined), undefined);
  });
});

describe('tintResourceGlyphs', () => {
  test('tints a resource glyph anywhere in the string', () => {
    const verb = `Use ${ICON.herb} Herbs`; // glyph sits mid-string
    assert.equal(
      tintResourceGlyphs(verb),
      `Use <span class="res-icon res-icon--herbs">${ICON.herb}</span> Herbs`,
    );
  });

  test('tints multiple glyphs in one pass', () => {
    const s = `${ICON.wood}${ICON.metal}`;
    assert.equal(
      tintResourceGlyphs(s),
      `<span class="res-icon res-icon--wood">${ICON.wood}</span>`
        + `<span class="res-icon res-icon--metal">${ICON.metal}</span>`,
    );
  });

  test('leaves a string with no resource glyphs untouched', () => {
    assert.equal(tintResourceGlyphs('Move'), 'Move');
  });
});

// Canvas-side helpers: the in-game loot floaters are painted on a 2D canvas
// (no HTML spans), so they read the tint hex directly per glyph.
describe('resourceColorForGlyph', () => {
  test('returns the resource hex for each resource glyph', () => {
    assert.equal(resourceColorForGlyph(ICON.wood), RESOURCE_ICON_COLOR.wood);
    assert.equal(resourceColorForGlyph(ICON.herb), RESOURCE_ICON_COLOR.herbs);
    assert.equal(resourceColorForGlyph(ICON.silver), RESOURCE_ICON_COLOR.silver);
  });

  test('returns null for a non-resource glyph or plain char', () => {
    assert.equal(resourceColorForGlyph(ICON.sword), null);
    assert.equal(resourceColorForGlyph('+'), null);
    assert.equal(resourceColorForGlyph(' '), null);
    assert.equal(resourceColorForGlyph(''), null);
  });
});

describe('splitColoredFloaterSegments', () => {
  test('tints just the glyph in a "+ Label" floater, label stays ambient', () => {
    const text = `+${ICON.wood} Wood`;
    const segs = splitColoredFloaterSegments(text);
    assert.deepEqual(segs, [
      { text: '+', color: null },
      { text: ICON.wood, color: RESOURCE_ICON_COLOR.wood },
      { text: ' Wood', color: null },
    ]);
  });

  test('a count + glyph floater tints only the glyph', () => {
    const text = `+2 ${ICON.herb}`;
    const segs = splitColoredFloaterSegments(text);
    assert.deepEqual(segs, [
      { text: '+2 ', color: null },
      { text: ICON.herb, color: RESOURCE_ICON_COLOR.herbs },
    ]);
  });

  test('concatenating segment text reproduces the input verbatim', () => {
    const text = `+${ICON.metal} Metal`;
    const joined = splitColoredFloaterSegments(text).map((s) => s.text).join('');
    assert.equal(joined, text);
  });

  test('a non-resource floater is one ambient segment (no tint)', () => {
    const text = `+${ICON.sword} Musket`;
    const segs = splitColoredFloaterSegments(text);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].color, null);
    assert.equal(segs[0].text, text);
  });

  test('coalesces a run of same-color glyphs into one segment', () => {
    const text = `${ICON.wood}${ICON.wood}`;
    const segs = splitColoredFloaterSegments(text);
    assert.deepEqual(segs, [{ text: `${ICON.wood}${ICON.wood}`, color: RESOURCE_ICON_COLOR.wood }]);
  });

  test('is safe on empty / non-string input', () => {
    assert.deepEqual(splitColoredFloaterSegments(''), []);
    assert.deepEqual(splitColoredFloaterSegments(undefined), []);
  });
});
