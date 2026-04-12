// Smoke test — run 1 game through the full network stack and verify success.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT    = join(__dirname, '..', 'scripts', 'headless-mp-net.js');

function run(args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [SCRIPT, ...args], {
      timeout: timeoutMs,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

describe('headless-mp-net', () => {
  test('1v1 game completes successfully', async () => {
    const { code, stdout, stderr } = await run(['1', '1', '--no-disconnect']);
    assert.equal(code, 0, `Expected exit code 0, got ${code}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    assert.match(stdout, /completed/i, 'Output should mention completed');
    assert.match(stdout, /0 errors/, 'Should have 0 errors');
  });

  test('disconnect test completes successfully', async () => {
    const { code, stdout, stderr } = await run(['0', '1'], 120_000);
    assert.equal(code, 0, `Expected exit code 0, got ${code}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    assert.match(stdout, /reconnected/, 'Output should show reconnection');
    assert.match(stdout, /0 errors/, 'Should have 0 errors');
  });
});
