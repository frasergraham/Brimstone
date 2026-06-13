#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Tutorial voiceover generator
// ─────────────────────────────────────────────────────────────────────────────
// Generates one narration clip per tutorial/hint step via a TTS API and writes
// them to assets/voice/<scriptKey>/<stepId>.mp3, plus a manifest
// (assets/voice/manifest.json) recording the sha256 of each step's narration
// text. Re-runs only regenerate steps whose text changed (hash mismatch), so
// narration can't silently drift from the on-screen text — a unit test
// (tests/tutorial.test.js) fails when a manifest entry goes stale.
//
// Providers (pick via env):
//   ELEVENLABS_API_KEY  → ElevenLabs text-to-speech (default voice: onwK4e9ZLuTAKqWW03F9,
//                         override with ELEVENLABS_VOICE_ID)
//   OPENAI_API_KEY      → OpenAI TTS (model gpt-4o-mini-tts, voice "onyx")
//
// Usage:
//   node scripts/generate-voiceover.mjs            # generate changed clips
//   node scripts/generate-voiceover.mjs --dry-run  # list what would generate
//   node scripts/generate-voiceover.mjs --force    # regenerate everything
//
// MissionConductor plays the clips per step (see _playVoice); a missing clip
// is always a silent no-op, so partial generation is safe.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TUTORIAL_STEPS } from '../src/tutorial/tutorial-config.js';
import { HINT_SCRIPTS } from '../src/campaign/hint-scripts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOICE_DIR = path.join(ROOT, 'assets', 'voice');
const MANIFEST_PATH = path.join(VOICE_DIR, 'manifest.json');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE   = process.argv.includes('--force');

// One consistent narrator across every clip: weary colonial storyteller.
const STYLE_HINT =
  'Read slowly and gravely, like a weary colonial-era storyteller by ' +
  'candlelight. Plain delivery, no theatrics.';

/** All scripts that ship narration, keyed the way the conductor resolves them. */
function collectScripts() {
  const scripts = { tutorial: TUTORIAL_STEPS };
  for (const [key, { steps }] of Object.entries(HINT_SCRIPTS)) scripts[key] = steps;
  return scripts;
}

/** Turn a step's on-screen text into speakable narration. */
export function narrationText(step) {
  const clean = (s) => s
    .replace(/[⚔✦🌅🌇☀🌙📋🛡🔒•→·]/gu, ' ')   // icons & bullets
    .replace(/\s+/g, ' ')
    .trim();
  return `${clean(step.title)}. ${clean(step.body)}`;
}

export function textHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return {};
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

// ── TTS providers ─────────────────────────────────────────────────────────────

async function ttsElevenLabs(text) {
  const voice = process.env.ELEVENLABS_VOICE_ID || 'onwK4e9ZLuTAKqWW03F9';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.6, similarity_boost: 0.8 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ttsOpenAI(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'onyx',
      input: text,
      instructions: STYLE_HINT,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function pickProvider() {
  if (process.env.ELEVENLABS_API_KEY) return { name: 'elevenlabs', tts: ttsElevenLabs };
  if (process.env.OPENAI_API_KEY)     return { name: 'openai',     tts: ttsOpenAI };
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const scripts = collectScripts();
  const manifest = await loadManifest();

  // Work list: every step whose narration hash differs from the manifest.
  const work = [];
  for (const [key, steps] of Object.entries(scripts)) {
    for (const step of steps) {
      const text = narrationText(step);
      const hash = textHash(text);
      const id = `${key}/${step.id}`;
      const clipPath = path.join(VOICE_DIR, key, `${step.id}.mp3`);
      if (!FORCE && manifest[id] === hash && existsSync(clipPath)) continue;
      work.push({ id, key, step, text, hash, clipPath });
    }
  }

  if (work.length === 0) {
    console.log('All narration clips are up to date.');
    return;
  }
  console.log(`${work.length} clip(s) to generate:`);
  for (const w of work) console.log(`  ${w.id}`);
  if (DRY_RUN) return;

  const provider = pickProvider();
  if (!provider) {
    console.error('\nNo TTS provider configured — set ELEVENLABS_API_KEY or OPENAI_API_KEY.');
    process.exitCode = 1;
    return;
  }
  console.log(`Using provider: ${provider.name}`);

  for (const w of work) {
    process.stdout.write(`  generating ${w.id} … `);
    const audio = await provider.tts(w.text);
    await mkdir(path.dirname(w.clipPath), { recursive: true });
    await writeFile(w.clipPath, audio);
    manifest[w.id] = w.hash;
    // Persist the manifest after every clip so an interrupted run resumes cleanly.
    await mkdir(VOICE_DIR, { recursive: true });
    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`ok (${(audio.length / 1024).toFixed(0)} KB)`);
  }
  console.log('Done.');
}

// Allow `import { narrationText, textHash }` from tests without running.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
