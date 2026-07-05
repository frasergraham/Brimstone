---
name: voiceover-regen
description: Regenerate narration/voiceover audio after changing voiced text — tutorial steps, hint scripts, or conversation lines — so clips and assets/voice/manifest.json don't go stale (a unit test fails on drift)
argument-hint: [--dry-run | --only <id-substring>]
---

# Voiceover Regeneration

Every tutorial/hint step and conversation line has a pre-generated TTS clip
in `assets/voice/`, tracked by content hash in `assets/voice/manifest.json`.
Editing voiced text — `src/tutorial/tutorial-config.js`,
`src/campaign/hint-scripts.js`, conversation `.md` files, or a voice
description in `src/campaign/voices.js` — makes the manifest stale, and
`tests/tutorial.test.js` fails on stale entries. This skill regenerates
exactly what changed.

## Workflow

1. **Dry run first** — see what would regenerate, no API key needed:
   ```bash
   node scripts/generate-voiceover.mjs --dry-run
   ```
   The list should match the text you edited. If unrelated clips appear,
   something upstream changed a hash input (e.g. a voice description in
   `voices.js` regenerates every clip using that voice — expected).

2. **Generate** — requires a TTS provider key in the environment:
   ```bash
   node scripts/generate-voiceover.mjs                    # changed clips only
   node scripts/generate-voiceover.mjs --only conv/ch1m1  # scope to matching ids
   node scripts/generate-voiceover.mjs --force            # everything (rare)
   ```
   - `ELEVENLABS_API_KEY` → ElevenLabs. Conversation lines use `eleven_v3`
     (interprets inline `[audio tags]` like `[whispers]`) which needs a
     **paid** plan — a free-plan key 402s. Narrator/hint steps stay on
     `eleven_multilingual_v2`.
   - `OPENAI_API_KEY` → OpenAI TTS fallback (`gpt-4o-mini-tts`).
   - **No key available (e.g. this remote environment):** stop after the dry
     run, commit the text change anyway (a missing clip is a silent no-op in
     game), and tell the user exactly which command to run locally — but note
     `tests/tutorial.test.js` will fail until they do, so the regen belongs in
     the same PR.

3. **Verify and commit** — clips + manifest are repo assets:
   ```bash
   node --test tests/tutorial.test.js
   git add assets/voice/ && git status --short assets/voice/
   ```
   Commit the regenerated `.mp3`s and `manifest.json` together with the text
   change.

## Notes

- Icons in voiced text are fine — `narrationText()` strips the
  `U+E000–E0FF` range before TTS; only *text* changes alter hashes.
- Clip layout: tutorial/hints → `assets/voice/<scriptKey>/<stepId>.mp3`;
  conversations → `assets/voice/conv/<convId>/<lineIdx>.mp3`.
- Partial generation is safe — missing clips never break the game, they just
  play silently.
