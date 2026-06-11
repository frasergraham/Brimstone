// Tests for conversation story triggers: processStoryTriggers conversation
// pass-through, per-attempt dedup (state._firedConversations) vs persistent
// flag dedup, and the shared storyTriggerMatches helper used by the mid-replay
// interleaver (src/campaign/missions.js).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { processStoryTriggers, storyTriggerMatches } from '../src/campaign/missions.js';

const mkState = (over = {}) => ({
  round: 1,
  hero: { col: 2, row: 7 },
  _firedConversations: new Set(),
  ...over,
});

describe('processStoryTriggers — conversations', () => {
  test('passes the conversation id through on fired events', () => {
    const fired = processStoryTriggers(
      mkState(),
      [{ type: 'round', round: 1, conversation: 'intro' }],
      {},
    );
    assert.equal(fired.length, 1);
    assert.equal(fired[0].conversation, 'intro');
    assert.equal(fired[0].title, undefined);
  });

  test('conversation without flag dedupes per mission attempt, not via storyFlags', () => {
    const storyFlags = {};
    const state = mkState();
    const triggers = [{ type: 'round', round: 1, conversation: 'intro' }];
    assert.equal(processStoryTriggers(state, triggers, storyFlags).length, 1);
    // Same attempt: deduped via state._firedConversations.
    assert.equal(processStoryTriggers(state, triggers, storyFlags).length, 0);
    assert.deepEqual(storyFlags, {});
    // New attempt (fresh state): fires again — intro replays on retry.
    assert.equal(processStoryTriggers(mkState(), triggers, storyFlags).length, 1);
  });

  test('conversation WITH a flag opts into persistent storyFlags dedup', () => {
    const storyFlags = {};
    const triggers = [{ type: 'round', round: 1, conversation: 'intro', flag: 'intro_done' }];
    assert.equal(processStoryTriggers(mkState(), triggers, storyFlags).length, 1);
    assert.equal(storyFlags.intro_done, true);
    assert.equal(processStoryTriggers(mkState(), triggers, storyFlags).length, 0);
  });

  test('text triggers behave as before (flag dedup, fire each eval without flag)', () => {
    const storyFlags = {};
    const flagged = [{ type: 'round', round: 1, title: 'T', text: 'x', flag: 'f' }];
    assert.equal(processStoryTriggers(mkState(), flagged, storyFlags).length, 1);
    assert.equal(processStoryTriggers(mkState(), flagged, storyFlags).length, 0);
    const unflagged = [{ type: 'round', round: 1, title: 'T', text: 'x' }];
    assert.equal(processStoryTriggers(mkState(), unflagged, {}).length, 1);
    assert.equal(processStoryTriggers(mkState(), unflagged, {}).length, 1);
  });

  test('only:"conversation" filters out text triggers (mid-replay probe)', () => {
    const fired = processStoryTriggers(
      mkState(),
      [
        { type: 'round', round: 1, title: 'T', text: 'x' },
        { type: 'round', round: 1, conversation: 'intro' },
      ],
      {},
      { only: 'conversation' },
    );
    assert.equal(fired.length, 1);
    assert.equal(fired[0].conversation, 'intro');
  });

  test('handles a state without _firedConversations (lazy init)', () => {
    const state = mkState({ _firedConversations: undefined });
    const triggers = [{ type: 'round', round: 1, conversation: 'intro' }];
    assert.equal(processStoryTriggers(state, triggers, {}).length, 1);
    assert.equal(processStoryTriggers(state, triggers, {}).length, 0);
  });
});

describe('storyTriggerMatches', () => {
  test('round, area, and condition gating', () => {
    const state = mkState();
    assert.equal(storyTriggerMatches(state, { type: 'round', round: 1 }), true);
    assert.equal(storyTriggerMatches(state, { type: 'round', round: 2 }), false);
    assert.equal(
      storyTriggerMatches(state, { type: 'area', hexes: [{ col: 2, row: 7 }] }),
      true,
    );
    assert.equal(
      storyTriggerMatches(state, { type: 'area', hexes: [{ col: 0, row: 0 }] }),
      false,
    );
    assert.equal(
      storyTriggerMatches(state, { type: 'round', round: 1, condition: () => false }),
      false,
    );
  });
});
