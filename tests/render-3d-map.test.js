// Tests for scripts/render-3d-map.js — the headless 3D map screenshot CLI.
//
// We treat the CLI as a black box: spawn it as a child process, verify it
// exits 0, the output file exists with non-zero size, and two runs with the
// same seed produce byte-identical PNGs. The byte-identical check is the
// precondition for visual regression baselines.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH  = path.join(REPO_ROOT, 'scripts', 'render-3d-map.js');

const TIMEOUT_MS = 10_000;

// Each test uses a unique tmp dir so parallel test runs don't clobber files.
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-3d-map-test-'));
  return path.join(dir, name);
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd:      REPO_ROOT,
    encoding: 'utf8',
    timeout:  TIMEOUT_MS,
  });
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('scripts/render-3d-map.js', () => {
  test('produces a non-empty PNG for --seed 42 --size skirmish', () => {
    const out = tmpFile('test.png');
    const result = runCli(['--seed', '42', '--size', 'skirmish', '--out', out]);

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}\nstderr:\n${result.stderr}`);
    assert.ok(fs.existsSync(out), 'output PNG was not written');

    const stat = fs.statSync(out);
    assert.ok(stat.size > 0, 'output PNG is empty');

    // Sanity check: real PNG starts with the 8-byte PNG signature.
    const sig = fs.readFileSync(out).subarray(0, 8);
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(sig.equals(PNG_SIG), 'output is not a PNG (bad signature)');
  });

  test('two runs with the same seed produce byte-identical PNGs', () => {
    const out1 = tmpFile('a.png');
    const out2 = tmpFile('b.png');

    const r1 = runCli(['--seed', '42', '--size', 'skirmish', '--out', out1]);
    const r2 = runCli(['--seed', '42', '--size', 'skirmish', '--out', out2]);

    assert.strictEqual(r1.status, 0, `first run failed:\n${r1.stderr}`);
    assert.strictEqual(r2.status, 0, `second run failed:\n${r2.stderr}`);

    const h1 = sha256(out1);
    const h2 = sha256(out2);
    assert.strictEqual(h1, h2,
      `PNG hashes differ across runs (non-deterministic):\n  ${h1}\n  ${h2}`);
  });
});
