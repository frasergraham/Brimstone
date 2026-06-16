// Voiceover expansion: the voice registry, the shared mute/play module, the
// generator's clip index (tutorial + hints + conversations), and the
// conversation clip-URL helper.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICES, voiceKeyForRole, voiceForRole, NARRATOR_VOICE_KEY, DEFAULT_VOICE_KEY,
} from '../src/campaign/voices.js';
import { conversationClipUrl } from '../src/conversation-player.js';

// localStorage shim (the voiceover module reads through to it).
const _store = {};
globalThis.localStorage = {
  getItem(k) { return _store[k] ?? null; },
  setItem(k, v) { _store[k] = String(v); },
  removeItem(k) { delete _store[k]; },
};
beforeEach(() => { for (const k of Object.keys(_store)) delete _store[k]; });

// ── Voice registry ────────────────────────────────────────────────────────────

describe('voices registry', () => {
  test('every voice carries a timbre + a tracked description prompt', () => {
    for (const [key, v] of Object.entries(VOICES)) {
      assert.ok(v.openaiVoice, `${key} needs an openaiVoice`);
      assert.ok(v.elevenVoiceId, `${key} needs an elevenVoiceId`);
      assert.ok(typeof v.description === 'string' && v.description.length > 10,
        `${key} needs a non-trivial description prompt`);
    }
  });

  test('narrator + default voices exist', () => {
    assert.ok(VOICES[NARRATOR_VOICE_KEY], 'narrator voice present');
    assert.ok(VOICES[DEFAULT_VOICE_KEY], 'default voice present');
  });

  test('voiceForRole maps named roles to same-named voices, else default', () => {
    assert.equal(voiceKeyForRole('hero'), 'hero');
    assert.equal(voiceKeyForRole('innkeeper'), 'innkeeper');
    assert.equal(voiceKeyForRole('witch'), 'witch');
    assert.equal(voiceKeyForRole('villager'), DEFAULT_VOICE_KEY); // no cast voice
    assert.equal(voiceKeyForRole(undefined), DEFAULT_VOICE_KEY);
    // Asking for the role literally named 'default' still resolves to default.
    assert.equal(voiceKeyForRole('default'), DEFAULT_VOICE_KEY);
    assert.equal(voiceForRole('hero'), VOICES.hero);
  });
});

// ── conversation clip URL ──────────────────────────────────────────────────────

describe('conversationClipUrl', () => {
  test('stable, namespaced under conv/', () => {
    assert.equal(conversationClipUrl('ch1m1-intro', 0), 'assets/voice/conv/ch1m1-intro/0.mp3');
    assert.equal(conversationClipUrl('ch1m1-intro', 4), 'assets/voice/conv/ch1m1-intro/4.mp3');
    assert.equal(conversationClipUrl('x', 2, 'base'), 'base/conv/x/2.mp3');
  });
});

// ── Shared mute + play module ───────────────────────────────────────────────────

describe('voiceover mute module', () => {
  test('defaults to unmuted; toggle persists; setVoiceMuted writes the flag', async () => {
    const { isVoiceMuted, toggleVoiceMuted, setVoiceMuted } = await import('../src/voiceover.js');
    assert.equal(isVoiceMuted(), false);
    assert.equal(toggleVoiceMuted(), true);
    assert.equal(isVoiceMuted(), true);
    assert.equal(_store['bs_voice_muted'], '1');
    setVoiceMuted(false);
    assert.equal(isVoiceMuted(), false);
    assert.equal(_store['bs_voice_muted'], '0');
  });

  test('migrates the legacy tutorial-only mute key when no new flag is set', async () => {
    const { isVoiceMuted } = await import('../src/voiceover.js');
    _store['bs_tutorial_voice_muted'] = '1';        // old key only
    assert.equal(isVoiceMuted(), true, 'legacy mute is honoured');
    _store['bs_voice_muted'] = '0';                  // new key wins once present
    assert.equal(isVoiceMuted(), false);
  });

  test('voiceMuteIconHtml is a monochrome inline SVG; muted variant differs', async () => {
    const { voiceMuteIconHtml } = await import('../src/voiceover.js');
    const on = voiceMuteIconHtml(false);
    const off = voiceMuteIconHtml(true);
    for (const html of [on, off]) {
      assert.match(html, /<svg/, 'inline SVG, not an emoji');
      assert.match(html, /fill="currentColor"/, 'monochrome — inherits text colour');
    }
    assert.notEqual(on, off, 'muted (slashed) glyph differs from unmuted');
  });

  test('playVoiceClip is a no-op without Audio (returns null) and honours mute', async () => {
    const { playVoiceClip, setVoiceMuted } = await import('../src/voiceover.js');
    assert.equal(typeof Audio, 'undefined', 'precondition: headless, no Audio');
    assert.equal(playVoiceClip('x.mp3'), null);     // no Audio → null
    setVoiceMuted(true);
    assert.equal(playVoiceClip('x.mp3'), null);     // muted → null
  });
});

// ── Clip availability (manifest-gated UI) ───────────────────────────────────────

describe('voice manifest availability', () => {
  test('default (manifest unloaded / empty) reports no audio', async () => {
    const { hasVoiceClip, hasConversationVoice, setVoiceManifestIds } = await import('../src/voiceover.js');
    setVoiceManifestIds([]);   // empty manifest = no audio shipped
    assert.equal(hasVoiceClip('conv/ch1m1-intro/0'), false);
    assert.equal(hasConversationVoice('ch1m1-intro'), false);
  });

  test('hasVoiceClip / hasConversationVoice reflect the generated ids', async () => {
    const { hasVoiceClip, hasConversationVoice, setVoiceManifestIds } = await import('../src/voiceover.js');
    setVoiceManifestIds(['conv/ch1m1-intro/0', 'conv/ch1m1-intro/1', 'tutorial/welcome']);
    assert.equal(hasVoiceClip('conv/ch1m1-intro/0'), true);
    assert.equal(hasVoiceClip('conv/ch1m1-intro/9'), false);
    assert.equal(hasConversationVoice('ch1m1-intro'), true);   // some lines have clips
    assert.equal(hasConversationVoice('ch9m9-finale'), false); // unknown conversation
    setVoiceManifestIds([]);   // reset for other tests
  });
});

// ── Generator clip index (pure, no API) ─────────────────────────────────────────

describe('generate-voiceover clip index', () => {
  test('covers tutorial + hint steps and every conversation line', async () => {
    const { buildClipIndex } = await import('../scripts/generate-voiceover.mjs');
    const index = buildClipIndex();
    // Tutorial steps use the narrator voice under the `tutorial/` namespace.
    const tut = [...index.keys()].filter(k => k.startsWith('tutorial/'));
    assert.ok(tut.length >= 20, `expected many tutorial clips, got ${tut.length}`);
    assert.equal(index.get(tut[0]).voiceKey, NARRATOR_VOICE_KEY);
    // Conversation lines are namespaced under conv/ with per-role voices.
    const conv = [...index.entries()].filter(([k]) => k.startsWith('conv/'));
    assert.ok(conv.length >= 1, 'at least one conversation line');
    assert.ok(conv.every(([, e]) => e.kind === 'conversation' && e.role),
      'conversation entries carry kind + role');
    // ch1m1-intro: Ishmael (hero) speaks first, innkeeper second.
    assert.equal(index.get('conv/ch1m1-intro/0')?.voiceKey, 'hero');
    assert.equal(index.get('conv/ch1m1-intro/1')?.voiceKey, 'innkeeper');
  });

  test('conversation clips use eleven_v3; steps stay on multilingual_v2', async () => {
    const { buildClipIndex } = await import('../scripts/generate-voiceover.mjs');
    const index = buildClipIndex();
    for (const [k, e] of index) {
      if (k.startsWith('conv/')) assert.equal(e.model, 'eleven_v3', `${k} should be v3`);
      else assert.equal(e.model, 'eleven_multilingual_v2', `${k} should be v2`);
    }
  });

  test('a tagged dialog line keeps its raw [audio tags] in the generated clip text', async () => {
    const { buildClipIndex } = await import('../scripts/generate-voiceover.mjs');
    const e0 = buildClipIndex().get('conv/ch1m1-intro/0');
    // Index text is the RAW (TTS) form — v3 consumes the tag; the on-screen
    // text (asserted tag-free in the parser tests) never carries it.
    assert.match(e0.text, /^\[[^\]]+\]/, 'first line still carries its leading audio tag for v3');
  });

  test('clipHash folds in the voice (description prompt + timbre) and the model', async () => {
    const { clipHash } = await import('../scripts/generate-voiceover.mjs');
    const text = 'The dead are in the streets.';
    assert.equal(clipHash(text, 'hero'), clipHash(text, 'hero'), 'deterministic');
    assert.notEqual(clipHash(text, 'hero'), clipHash(text, 'innkeeper'),
      'different voice → different hash');
    assert.notEqual(clipHash(text, 'hero'), clipHash('different line', 'hero'),
      'different text → different hash');
    // The legacy v2 default must hash identically whether the model is implicit
    // or named — that's what keeps existing narrator/step clips from regenerating.
    assert.equal(clipHash(text, 'hero'), clipHash(text, 'hero', 'eleven_multilingual_v2'),
      'v2 default is the implicit model');
    assert.notEqual(clipHash(text, 'hero'), clipHash(text, 'hero', 'eleven_v3'),
      'a model change → different hash');
  });
});
