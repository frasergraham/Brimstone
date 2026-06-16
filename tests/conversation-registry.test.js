// Tests for conversation loading + participant binding
// (src/campaign/conversation-registry.js). Loads the real ch1m1-intro.md via
// the node fs path so the shipped content stays parseable.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadConversation, clearConversationCache, bindParticipants, validateConversationDef,
} from '../src/campaign/conversation-registry.js';

function fakeState() {
  const hero = { id: 'e1', type: 'hero', alive: true, col: 2, row: 7 };
  return {
    hero,
    entities: [
      hero,
      { id: 'e2', type: 'survivor', isNpc: true, npcId: 'innkeeper_john', name: "John O'Connor", alive: true, col: 3, row: 6 },
      { id: 'e3', type: 'survivor', name: 'Mary Quinn', alive: true, col: 1, row: 7 },
    ],
  };
}

describe('loadConversation', () => {
  test('loads and parses the shipped ch1m1-intro.md', async () => {
    clearConversationCache();
    const convo = await loadConversation('ch1m1-intro');
    assert.equal(convo.id, 'ch1m1-intro');
    assert.deepEqual(convo.roles, ['hero', 'innkeeper']);
    assert.ok(convo.lines.length >= 4);
    assert.equal(convo.lines[0].role, 'hero');   // Ishmael opens the scene
  });

  test('caches parses', async () => {
    const a = await loadConversation('ch1m1-intro');
    const b = await loadConversation('ch1m1-intro');
    assert.equal(a, b);
  });
});

describe('bindParticipants', () => {
  const convo = { roles: ['hero', 'innkeeper'] };

  test('resolves hero and npc bindings', () => {
    const state = fakeState();
    const map = bindParticipants(convo, { hero: 'hero', innkeeper: 'npc:innkeeper_john' }, state);
    assert.equal(map.get('hero'), state.hero);
    assert.equal(map.get('innkeeper').npcId, 'innkeeper_john');
  });

  test('resolves survivor-by-name bindings', () => {
    const state = fakeState();
    const map = bindParticipants({ roles: ['a'] }, { a: 'survivor:Mary Quinn' }, state);
    assert.equal(map.get('a').name, 'Mary Quinn');
  });

  test('returns null when a role is unbound or the entity is missing/dead', () => {
    const state = fakeState();
    assert.equal(bindParticipants(convo, { hero: 'hero' }, state), null);
    assert.equal(bindParticipants(convo, { hero: 'hero', innkeeper: 'npc:nobody' }, state), null);
    state.entities[1].alive = false;
    assert.equal(
      bindParticipants(convo, { hero: 'hero', innkeeper: 'npc:innkeeper_john' }, state),
      null,
    );
  });

  test('binds a live entity wired straight in (logic-graph participant pin)', () => {
    const state = fakeState();
    const survivor = state.entities[2]; // Mary — as if supplied by an On Actor node
    const map = bindParticipants(
      { roles: ['hero', 'survivor'] },
      { hero: 'hero', survivor }, // grammar hero + a wired entity object
      state,
    );
    assert.equal(map.get('hero'), state.hero);
    assert.equal(map.get('survivor'), survivor);
  });

  test('a wired entity that is dead skips the conversation (null)', () => {
    const state = fakeState();
    const survivor = { id: 'eX', type: 'survivor', name: 'Ghost', alive: false };
    assert.equal(
      bindParticipants({ roles: ['hero', 'survivor'] }, { hero: 'hero', survivor }, state),
      null,
    );
  });
});

describe('validateConversationDef', () => {
  const good = {
    id: 'c1',
    file: 'ch1m1-intro',
    bindings: { hero: 'hero', innkeeper: 'npc:innkeeper_john' },
    onComplete: [{ action: 'despawn', npc: 'innkeeper_john' }],
  };

  test('accepts a well-formed def', () => {
    validateConversationDef(good, { npcIds: ['innkeeper_john'] });
  });

  test('rejects missing id/file, bad binding, unknown npc, bad onComplete', () => {
    assert.throws(() => validateConversationDef({ file: 'x' }), /string id/);
    assert.throws(() => validateConversationDef({ id: 'c' }), /markdown file id/);
    assert.throws(
      () => validateConversationDef({ ...good, bindings: { hero: 'wizard' } }),
      /bad binding/,
    );
    assert.throws(
      () => validateConversationDef(good, { npcIds: ['someone_else'] }),
      /unknown npc/,
    );
    assert.throws(
      () => validateConversationDef({ ...good, onComplete: [{ action: 'fly', npc: 'x' }] }),
      /unknown action/,
    );
  });
});
