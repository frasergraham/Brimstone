// UI: resource glyphs are tinted by type on the two surfaces the earlier
// resource-icon pass didn't cover — the replay TURN CARDS (built by
// _replayRowHtml from a buildStepDigest entry's `note`) and the ROUND SUMMARY
// wrap-up card's "Looted" pips (built by _buildWrapUpBody). Both render via
// innerHTML → DOM, so the HTML helper tintResourceGlyphs wraps each resource
// PUA glyph in a `.res-icon--<id>` span (wood brown, herbs green, …) while the
// surrounding label + non-resource glyphs (horse, weapon) stay ambient.
//
// Also a regression guard that the round-summary Found/Spent rows
// (_showResolutionSummary) keep their typed res-icon spans.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  installGlobalMocks,
  makeFakeRenderer,
  createElementsBag,
} from './setup.js';

const { fakeCanvas } = installGlobalMocks();

let UIController, GameState, ResEventType, ICON;

before(async () => {
  const [uiMod, gameMod, resMod, iconMod] = await Promise.all([
    import('../../src/ui.js'),
    import('../../src/game.js'),
    import('../../server/resolver.js'),
    import('../../src/icons.js'),
  ]);
  UIController = uiMod.UIController;
  GameState    = gameMod.GameState;
  ResEventType = resMod.ResEventType;
  ICON         = iconMod.ICON;
});

function makeUI() {
  const state    = new GameState(true, false);
  const renderer = makeFakeRenderer();
  const els      = createElementsBag();
  const ui = new UIController(fakeCanvas, state, renderer, null, () => {}, null, false, els);
  return { ui, state, els };
}

// A turn-card entry as buildStepDigest emits for an EXPLORE that found loot:
// the note text carries the loot label glyph(s) (mirrors lootDisplayLabel).
function lootEntry(noteText) {
  return {
    entityId:    9001,
    actor:       { entityId: 9001, type: 'survivor', title: null, name: 'Scout', color: '#888', glyph: '?' },
    target:      null,
    actionType:  'explore',
    label:       'EXPLORE',
    outcomeKind: null,
    targetDmg:   0, actorDmg: 0, killed: false,
    note:        { text: noteText, kind: 'gain loot' },
    discovered:  null,
    hexes:       [{ col: 0, row: 0 }],
    movePath:    null,
  };
}

describe('replay turn card — note text resource tint', () => {
  test('tints a found-resource glyph in the loot note, label stays ambient', () => {
    const { ui } = makeUI();
    // lootDisplayLabel('herbs') === ' Herbs'
    const html = ui._replayRowHtml(lootEntry(`${ICON.herb} Herbs`), 0);
    assert.match(
      html,
      new RegExp(`<span class="res-icon res-icon--herbs">${ICON.herb}</span> Herbs`),
      'herb glyph wrapped in a green-typed span',
    );
    // The word stays outside the span (ambient color): the span wraps ONLY the
    // glyph, so " Herbs" must NOT appear inside the res-icon span body.
    assert.ok(!html.includes(`res-icon--herbs">${ICON.herb} Herbs</span>`),
      'the trailing label text is not inside the res-icon span');
  });

  test('tints multiple resources in one joined note (e.g. "Wood · Metal")', () => {
    const { ui } = makeUI();
    const html = ui._replayRowHtml(lootEntry(`${ICON.wood} Wood · ${ICON.metal} Metal`), 0);
    assert.match(html, new RegExp(`<span class="res-icon res-icon--wood">${ICON.wood}</span>`));
    assert.match(html, new RegExp(`<span class="res-icon res-icon--metal">${ICON.metal}</span>`));
  });

  test('non-resource note (FOUND SURVIVOR) is left ambient — no res-icon span', () => {
    const { ui } = makeUI();
    const entry = lootEntry('FOUND SURVIVOR');
    entry.note.kind = 'gain';
    const html = ui._replayRowHtml(entry, 0);
    assert.ok(html.includes('FOUND SURVIVOR'), 'note text still rendered');
    assert.ok(!html.includes('res-icon'), 'no resource span on a non-resource note');
  });

  test('a horse/weapon loot glyph stays ambient (not a tintable resource)', () => {
    const { ui } = makeUI();
    // lootDisplayLabel('horse') === ' Horse (+1 move)'
    const html = ui._replayRowHtml(lootEntry(`${ICON.horse} Horse (+1 move)`), 0);
    assert.ok(html.includes(`${ICON.horse} Horse (+1 move)`), 'horse label rendered verbatim');
    assert.ok(!html.includes('res-icon'), 'horse glyph is not wrapped in a resource span');
  });
});

describe('round-summary wrap-up card — looted pips resource tint', () => {
  test('tints the leading resource glyph of each loot pip, label ambient', () => {
    const { ui } = makeUI();
    // loot floaters as collectTurnFinds yields them (the leading "+" is stripped
    // by _buildWrapUpBody before tally).
    const html = ui._buildWrapUpBody([], 0, [], [`+${ICON.wood} Wood`, `+${ICON.herb} Herbs`]);
    assert.match(html, new RegExp(`<span class="res-icon res-icon--wood">${ICON.wood}</span> Wood`));
    assert.match(html, new RegExp(`<span class="res-icon res-icon--herbs">${ICON.herb}</span> Herbs`));
  });

  test('tallies duplicate resource loot AND tints it (×2 pip)', () => {
    const { ui } = makeUI();
    const html = ui._buildWrapUpBody([], 0, [], [`+${ICON.metal} Metal`, `+${ICON.metal} Metal`]);
    assert.match(html, new RegExp(`<span class="res-icon res-icon--metal">${ICON.metal}</span> Metal`));
    assert.match(html, /×2/, 'duplicate resource still tallies a ×N count');
  });

  test('a looted horse/weapon pip is NOT tinted (ambient glyph)', () => {
    const { ui } = makeUI();
    const html = ui._buildWrapUpBody([], 0, [], [`+${ICON.horse} Horse`, `+${ICON.sword} Musket`]);
    assert.ok(html.includes(`${ICON.horse} Horse`), 'horse pip rendered');
    assert.ok(html.includes(`${ICON.sword} Musket`), 'weapon pip rendered');
    assert.ok(!html.includes('res-icon'), 'no resource span on horse/weapon pips');
  });
});

describe('round summary Found/Spent rows — regression: stay tinted', () => {
  function exploreLootStep() {
    return [{
      entitySnapshot: [{ id: 9001, displayName: 'Scout', type: 'survivor' }],
      heroEvents: [{
        type: ResEventType.ACTION_OK,
        faction: 'hero',
        action: { type: 'explore', entityId: 9001 },
        result: { success: true, lootItemIds: ['wood', 'herbs'], lootItems: [`+${ICON.wood}`, `+${ICON.herb}`] },
      }],
    }];
  }

  test('Found row wraps each resource glyph in a typed res-icon span', () => {
    const { ui, els } = makeUI();
    ui._showResolutionSummary(exploreLootStep(), 1,
      { humanFaction: 'hero', fogOfWar: 'none', isCampaign: false }).catch(() => {});
    const html = els['round-summary-events']._innerHTML;
    assert.match(html, /summary-resources found/, 'Found row present');
    assert.match(html, new RegExp(`<span class="res-icon res-icon--wood">${ICON.wood}</span> Wood`));
    assert.match(html, new RegExp(`<span class="res-icon res-icon--herbs">${ICON.herb}</span> Herbs`));
  });
});
