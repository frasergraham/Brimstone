// Tests for the conversation markdown parser (src/campaign/conversation-parser.js).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseConversationMD, ConversationParseError } from '../src/campaign/conversation-parser.js';

const GOOD = `---
id: test-convo
title: A Test Conversation
roles: hero, innkeeper
---

# stage direction: played before round 1

innkeeper: Thank the heavens — you're awake, ser. The dead are in the
  streets.

hero: How many, John?

innkeeper: More than I could count.
`;

describe('parseConversationMD', () => {
  test('parses frontmatter and dialog lines', () => {
    const c = parseConversationMD(GOOD);
    assert.equal(c.id, 'test-convo');
    assert.equal(c.title, 'A Test Conversation');
    assert.deepEqual(c.roles, ['hero', 'innkeeper']);
    assert.equal(c.lines.length, 3);
    assert.deepEqual(c.lines[1], { role: 'hero', text: 'How many, John?' });
  });

  test('joins continuation lines into the previous speech', () => {
    const c = parseConversationMD(GOOD);
    assert.equal(
      c.lines[0].text,
      "Thank the heavens — you're awake, ser. The dead are in the streets.",
    );
  });

  test('ignores blank lines and # comments in body and frontmatter', () => {
    const c = parseConversationMD(`---
# a comment
id: x
roles: a
---
# body comment
a: hi
`);
    assert.equal(c.lines.length, 1);
  });

  test('title defaults to id when omitted', () => {
    const c = parseConversationMD('---\nid: x\nroles: a\n---\na: hi\n');
    assert.equal(c.title, 'x');
  });

  test('rejects missing frontmatter', () => {
    assert.throws(() => parseConversationMD('hero: hi\n'), ConversationParseError);
  });

  test('rejects unterminated frontmatter', () => {
    assert.throws(() => parseConversationMD('---\nid: x\nroles: a\n'), ConversationParseError);
  });

  test('rejects missing id and missing roles', () => {
    assert.throws(() => parseConversationMD('---\nroles: a\n---\na: hi\n'), /declare an id/);
    assert.throws(() => parseConversationMD('---\nid: x\n---\nx: hi\n'), /declare roles/);
  });

  test('rejects dialog line for an undeclared role', () => {
    assert.throws(
      () => parseConversationMD('---\nid: x\nroles: a\n---\nb: who am I?\n'),
      /undeclared role "b"/,
    );
  });

  test('rejects empty body and text before any speaker', () => {
    assert.throws(() => parseConversationMD('---\nid: x\nroles: a\n---\n'), /no dialog lines/);
    assert.throws(
      () => parseConversationMD('---\nid: x\nroles: a\n---\njust prose\n'),
      /before any speaker/,
    );
  });
});
