// Parser for campaign conversation markdown files (src/campaign/conversations/*.md).
//
// Format:
//   ---
//   id: ch1m1-intro
//   title: A Voice at the Inn Door
//   roles: hero, innkeeper
//   ---
//
//   # comment lines are ignored
//
//   innkeeper: Dialog text. Lines that don't start with a declared
//     "role:" prefix continue the previous line.
//
//   hero: Reply text.
//
// Roles are slots — actual entities are bound at trigger time by the mission
// JSON's `bindings` map (see conversation-registry.js). Pure string handling,
// no dependencies, so it runs in browser, node tests, and headless scripts.

export class ConversationParseError extends Error {
  constructor(message) {
    super(`conversation-parser: ${message}`);
    this.name = 'ConversationParseError';
  }
}

const FRONTMATTER_DELIM = /^---\s*$/;
const KEY_VALUE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

/**
 * Strip ElevenLabs-style inline audio-direction tags — `[cheerful]`, `[sighs]`,
 * `[slowly]`, … — from a line of dialog, leaving the spoken words. The tags
 * steer the v3 TTS generator (they're fed to it verbatim) but must never reach
 * the on-screen speech bubble, so the parser keeps the raw line as `ttsText`
 * and exposes this stripped form as the displayed `text`. Tidies the spacing a
 * removed tag leaves behind (doubled spaces, a space before punctuation).
 */
export function stripAudioTags(s) {
  return String(s ?? '')
    .replace(/\[[^\][]*\]/g, '')      // drop [tag] markers
    .replace(/\s+([,.;:!?])/g, '$1')  // un-orphan punctuation a leading tag left
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Parse a conversation markdown document.
 * @param {string} text — raw .md file contents.
 * @returns {{ id: string, title: string, roles: string[],
 *            lines: { role: string, text: string, ttsText?: string }[] }}
 *   `text` is the on-screen form (audio tags stripped); `ttsText` is present
 *   only when the line carried `[audio tags]`, holding the raw text for TTS.
 * @throws {ConversationParseError} on structural problems (missing frontmatter,
 *   missing id/roles, dialog line for an undeclared role, empty body).
 */
export function parseConversationMD(text) {
  if (typeof text !== 'string') throw new ConversationParseError('input must be a string');
  const rawLines = text.split(/\r?\n/);

  // ── Frontmatter ──
  let i = 0;
  while (i < rawLines.length && rawLines[i].trim() === '') i++;
  if (i >= rawLines.length || !FRONTMATTER_DELIM.test(rawLines[i])) {
    throw new ConversationParseError('missing frontmatter (file must start with ---)');
  }
  i++;
  const meta = {};
  let closed = false;
  for (; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (FRONTMATTER_DELIM.test(line)) { closed = true; i++; break; }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = line.match(KEY_VALUE);
    if (!m) throw new ConversationParseError(`bad frontmatter line: "${line.trim()}"`);
    meta[m[1]] = m[2].trim();
  }
  if (!closed) throw new ConversationParseError('unterminated frontmatter (missing closing ---)');
  if (!meta.id) throw new ConversationParseError('frontmatter must declare an id');
  if (!meta.roles) throw new ConversationParseError('frontmatter must declare roles');
  const roles = meta.roles.split(',').map(r => r.trim()).filter(Boolean);
  if (roles.length === 0) throw new ConversationParseError('roles list is empty');

  // ── Dialog body ──
  const roleSet = new Set(roles);
  const lines = [];
  for (; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = trimmed.match(KEY_VALUE);
    if (m && roleSet.has(m[1])) {
      lines.push({ role: m[1], text: m[2].trim() });
    } else if (m && !raw.startsWith(' ') && !raw.startsWith('\t')) {
      // Unindented "word:" prefix that isn't a declared role is almost
      // certainly a typo'd speaker — fail loudly rather than gluing the line
      // onto the previous speech.
      throw new ConversationParseError(`dialog line for undeclared role "${m[1]}"`);
    } else {
      if (lines.length === 0) {
        throw new ConversationParseError(`dialog text before any speaker line: "${trimmed}"`);
      }
      const prev = lines[lines.length - 1];
      prev.text = prev.text === '' ? trimmed : `${prev.text} ${trimmed}`;
    }
  }
  if (lines.length === 0) throw new ConversationParseError('conversation has no dialog lines');

  // Split each line's authored text into a displayed form (audio tags removed)
  // and, when the line actually carried tags, the raw form for the TTS
  // generator. Lines without tags keep their plain { role, text } shape.
  for (const line of lines) {
    const display = stripAudioTags(line.text);
    if (display !== line.text) {
      line.ttsText = line.text;   // raw, with [audio tags] — drives v3 generation
      line.text = display;        // spoken words only — shown on screen
    }
  }

  const empty = lines.find(l => l.text === '');
  if (empty) throw new ConversationParseError(`empty dialog line for role "${empty.role}"`);

  return { id: meta.id, title: meta.title ?? meta.id, roles, lines };
}
