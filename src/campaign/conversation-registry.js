// Loader + participant binding for campaign conversations.
//
// Conversation content lives in ./conversations/*.md (see conversation-parser.js
// for the format). Missions reference a conversation by file id and bind its
// role slots to live entities at trigger time via a `bindings` map:
//
//   "bindings": { "hero": "hero", "innkeeper": "npc:innkeeper_john" }
//
// Binding value grammar:
//   "hero"            → state.hero
//   "npc:<npcId>"     → scripted NPC placed by the mission's `npcs[]`
//   "survivor:<Name>" → living hero survivor by roster name

import { parseConversationMD } from './conversation-parser.js';
import { validateScriptedActions } from './scripted-actions.js';

// No DOM ⇒ node (tests, headless scripts). Webviews use fetch — same pattern
// as campaign-registry.js mission loading.
const _isNode = typeof window === 'undefined';

// Binding-grammar keywords. BIND_HERO happens to share its spelling with the
// faction id, but it's a grammar token meaning "the state.hero leader", not a
// faction check (see tests/faction-string-checks.test.js).
const BIND_HERO = 'hero';
const BIND_NPC_PREFIX = 'npc:';
const BIND_SURVIVOR_PREFIX = 'survivor:';

const _cache = new Map();

/**
 * Load + parse a conversation markdown file by file id (no extension).
 * Cached; prefetch at mission init so playback never awaits the network.
 */
export async function loadConversation(fileId) {
  if (_cache.has(fileId)) return _cache.get(fileId);
  const url = new URL(`./conversations/${fileId}.md`, import.meta.url);
  let text;
  if (_isNode) {
    const { readFileSync } = await import('node:fs');
    text = readFileSync(url, 'utf8');
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`conversation-registry: ${url} → HTTP ${res.status}`);
    text = await res.text();
  }
  const convo = parseConversationMD(text);
  _cache.set(fileId, convo);
  return convo;
}

/** Test/editor hook — drop cached parses so file edits are picked up. */
export function clearConversationCache() {
  _cache.clear();
}

/**
 * Resolve a conversation's role slots to live entities.
 * @returns {Map<string, Entity>|null} null when any role can't be resolved —
 *   the caller should log and skip the conversation rather than crash.
 */
export function bindParticipants(convo, bindings, state) {
  const map = new Map();
  for (const role of convo.roles) {
    const spec = bindings?.[role];
    let entity = null;
    if (spec === BIND_HERO) {
      entity = state.hero;
    } else if (typeof spec === 'string' && spec.startsWith(BIND_NPC_PREFIX)) {
      const npcId = spec.slice(BIND_NPC_PREFIX.length);
      entity = state.entities.find(e => e.isNpc && e.npcId === npcId && e.alive !== false) ?? null;
    } else if (typeof spec === 'string' && spec.startsWith(BIND_SURVIVOR_PREFIX)) {
      const name = spec.slice(BIND_SURVIVOR_PREFIX.length);
      entity = state.entities.find(
        e => e.type === 'survivor' && !e.isNpc && e.name === name && e.alive !== false,
      ) ?? null;
    }
    if (!entity) return null;
    map.set(role, entity);
  }
  return map;
}

/**
 * Shape-check a mission JSON `conversations[]` entry (pure — used by
 * json-mission.js validation and the Mission Editor save gate). Does NOT load
 * the markdown file; file existence is a runtime concern.
 */
export function validateConversationDef(convDef, { ext = null, npcIds = null } = {}) {
  if (typeof convDef.id !== 'string' || convDef.id === '') {
    throw new Error('conversation def needs a string id');
  }
  if (typeof convDef.file !== 'string' || convDef.file === '') {
    throw new Error(`conversation "${convDef.id}": needs a markdown file id`);
  }
  if (convDef.bindings != null && typeof convDef.bindings !== 'object') {
    throw new Error(`conversation "${convDef.id}": bindings must be an object`);
  }
  const ids = npcIds ? new Set(npcIds) : null;
  for (const [role, spec] of Object.entries(convDef.bindings ?? {})) {
    const ok = spec === BIND_HERO
      || (typeof spec === 'string' && spec.startsWith(BIND_NPC_PREFIX))
      || (typeof spec === 'string' && spec.startsWith(BIND_SURVIVOR_PREFIX));
    if (!ok) throw new Error(`conversation "${convDef.id}": bad binding for role "${role}": "${spec}"`);
    if (ids && typeof spec === 'string' && spec.startsWith(BIND_NPC_PREFIX)
        && !ids.has(spec.slice(BIND_NPC_PREFIX.length))) {
      throw new Error(`conversation "${convDef.id}": binding "${spec}" references unknown npc`);
    }
  }
  if (convDef.onComplete != null) {
    validateScriptedActions(convDef.onComplete, { ext, npcIds });
  }
}
