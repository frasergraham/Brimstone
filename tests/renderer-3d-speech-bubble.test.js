// Tests for the conversation speech-bubble helpers in renderer-3d.js:
// wrapSpeechText (pure layout) and paintSpeechBubble (against a recording
// 2D-context stub, matching the other renderer-3d paint-helper tests).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wrapSpeechText, paintSpeechBubble,
  SPEECH_BUBBLE_WRAP_CHARS, SPEECH_BUBBLE_MAX_LINES,
} from '../src/renderer-3d.js';

function stubCtx() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, args]); };
  return {
    calls,
    texts: () => calls.filter(c => c[0] === 'fillText').map(c => c[1][0]),
    clearRect: rec('clearRect'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    arcTo: rec('arcTo'),
    closePath: rec('closePath'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillText: rec('fillText'),
  };
}

describe('wrapSpeechText', () => {
  test('wraps at the character budget on word boundaries', () => {
    const lines = wrapSpeechText('the quick brown fox jumps over the lazy dog', 15);
    assert.ok(lines.length > 1);
    for (const l of lines) assert.ok(l.length <= 15, `"${l}" exceeds budget`);
    assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog');
  });

  test('handles empty text and over-budget words', () => {
    assert.deepEqual(wrapSpeechText(''), []);
    assert.deepEqual(wrapSpeechText('   '), []);
    assert.deepEqual(wrapSpeechText('supercalifragilistic', 5), ['supercalifragilistic']);
  });

  test('default budget fits a typical dialog line in a few rows', () => {
    const lines = wrapSpeechText(
      "Thank the heavens — you're awake, ser. The dead are in the streets.",
      SPEECH_BUBBLE_WRAP_CHARS,
    );
    assert.ok(lines.length >= 2 && lines.length <= SPEECH_BUBBLE_MAX_LINES);
  });
});

describe('paintSpeechBubble', () => {
  test('paints panel, speaker name, and every body line', () => {
    const ctx = stubCtx();
    paintSpeechBubble(ctx, {
      width: 512, height: 200,
      name: "John O'Connor",
      lines: ['first line', 'second line'],
    });
    assert.ok(ctx.calls.some(c => c[0] === 'fill'), 'panel filled');
    assert.ok(ctx.calls.some(c => c[0] === 'stroke'), 'border stroked');
    assert.deepEqual(ctx.texts(), ["John O'Connor", 'first line', 'second line']);
  });

  test('skips the name row when unnamed', () => {
    const ctx = stubCtx();
    paintSpeechBubble(ctx, { width: 512, height: 120, lines: ['hi'] });
    assert.deepEqual(ctx.texts(), ['hi']);
  });
});
