// listConversationFiles powers the Mission Editor's conversation dropdown — it
// must surface EVERY *.md under src/campaign/conversations/ as its file id (no
// extension), so dropping a new conversation file in makes it selectable live.
// Runs against the real repo so it also guards the directory being moved.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listConversationFiles } from '../server/admin.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONV_DIR  = join(REPO_ROOT, 'src', 'campaign', 'conversations');

describe('listConversationFiles (real repo)', () => {
  const files = listConversationFiles(CONV_DIR);

  test('returns markdown file ids without the .md extension', () => {
    assert.ok(files.includes('ch1m1-intro'), 'missing ch1m1-intro');
    assert.ok(files.every(f => !/\.md$/i.test(f)), 'extension leaked into an id');
  });

  test('output is sorted with no dotfiles', () => {
    assert.deepEqual(files, [...files].sort(), 'output must be sorted');
    assert.ok(!files.some(f => f.startsWith('.')), 'dotfile leaked in');
  });
});

describe('listConversationFiles (synthetic dir)', () => {
  test('lists .md stems, skips dotfiles/dirs/non-md, sorts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conv-'));
    try {
      writeFileSync(join(dir, 'ch1m1-intro.md'), '');
      writeFileSync(join(dir, 'generic-rescue.MD'), '');   // case-insensitive ext
      writeFileSync(join(dir, 'notes.txt'), '');            // wrong extension
      writeFileSync(join(dir, '.DS_Store'), '');            // dotfile
      mkdirSync(join(dir, 'sub'));                          // directory ignored
      assert.deepEqual(listConversationFiles(dir), ['ch1m1-intro', 'generic-rescue']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing directory yields an empty list (no throw)', () => {
    assert.deepEqual(listConversationFiles(join(tmpdir(), 'definitely-not-here-xyz')), []);
  });
});
