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
