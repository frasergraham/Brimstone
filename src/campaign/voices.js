// Voice registry — the single source of truth for WHICH voice and WHICH
// voice-description prompt narrates each speaker.
//
// `description` IS the prompt handed to the TTS provider (OpenAI's
// `instructions`). It is also folded into the voiceover manifest hash by
// scripts/generate-voiceover.mjs, so editing a voice — its base timbre OR its
// description — regenerates exactly the clips that use it. Narration therefore
// can never silently drift from the voice it was authored for.
//
// OpenAI TTS picks a base timbre via `openaiVoice` (alloy/ash/ballad/coral/
// echo/fable/onyx/nova/sage/shimmer) and shapes delivery via `description`.
// ElevenLabs picks a cast voice via `elevenVoiceId` (the ids below are the
// stable premade-library voices — change them to your own cast as desired).
//
// Pure data + lookup helpers — no DOM, no fetch. Runs in the browser
// (conversation playback), node tests, and the headless generator.

export const DEFAULT_ELEVEN_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // Daniel (deep British)

export const VOICES = Object.freeze({
  // Tutorial / hint narration — one consistent storyteller across every step.
  narrator: {
    openaiVoice: 'onyx',
    elevenVoiceId: 'onwK4e9ZLuTAKqWW03F9', // Daniel — deep British news/narration
    description:
      'A weary colonial-era storyteller by candlelight. Read slowly and gravely, '
      + 'plain delivery, no theatrics.',
  },
  // The player's paladin.
  hero: {
    openaiVoice: 'echo',
    elevenVoiceId: 'pNInz6obpgDQGcFmaJgB', // Adam — deep, resolute male
    description:
      'A steadfast colonial paladin, male. Low, resolute and measured, with quiet '
      + 'authority and weariness beneath the resolve. No theatrics.',
  },
  // John O’Connor, the village innkeeper (npc:innkeeper_john).
  innkeeper: {
    openaiVoice: 'ballad',
    elevenVoiceId: 'pqHfZKP75CvOlQylNhV4', // Bill — older male, weathered narration
    description:
      'A frightened middle-aged village innkeeper, male. Hushed and urgent, breath '
      + 'catching, glancing over his shoulder.',
  },
  // The witch antagonist.
  witch: {
    openaiVoice: 'shimmer',
    elevenVoiceId: 'z9fAnlkpzviPz146aGWa', // Glinda — witch character voice
    description:
      'A cold, sibilant witch, female. Silk over malice — unhurried, amused, '
      + 'faintly mocking.',
  },
  // Fallback for any role without its own cast voice.
  default: {
    openaiVoice: 'sage',
    elevenVoiceId: 'TX3LPaxmHKxFdv7VOQHJ', // Liam — neutral male
    description:
      'A plain colonial New England villager. Grounded and natural, neither '
      + 'dramatic nor flat.',
  },
});

/** Voice key narrating tutorial/hint steps (those carry no per-speaker role). */
export const NARRATOR_VOICE_KEY = 'narrator';

/** Fallback voice key for a conversation role with no cast voice of its own. */
export const DEFAULT_VOICE_KEY = 'default';

/**
 * Resolve a conversation role to a voice KEY. A role maps to a same-named voice
 * when one exists (hero, innkeeper, witch, …), else the default voice. Voice
 * assignment is by role name rather than the mission's binding target — role
 * names are already character-semantic and keep the generator independent of
 * mission JSON. Give a role its own voice by adding an entry to VOICES.
 */
export function voiceKeyForRole(role) {
  return (role && Object.prototype.hasOwnProperty.call(VOICES, role) && role !== 'default')
    ? role
    : DEFAULT_VOICE_KEY;
}

/** Resolve a conversation role to its voice DEFINITION. */
export function voiceForRole(role) {
  return VOICES[voiceKeyForRole(role)];
}
