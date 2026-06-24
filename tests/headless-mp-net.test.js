// Smoke test — run 1 game through the full network stack and verify success.
//
// ⚠ HEAVYWEIGHT INTEGRATION TEST. Each case spawns a *real* Express+WebSocket
// server (scripts/headless-mp-net.js) on a random port and drives a full
// game through the live socket stack. The game logic itself is sub-second
// (a 1v1 completes in ~1s standalone), but server startup + port binding +
// the rest of the suite (and any concurrent merge processes) contending for
// CPU can stretch the *wall-clock* well past a tight cap. A 90s execFile
// timeout intermittently tripped under concurrent CI/merge load — killing the
// child mid-game and surfacing a spurious non-zero exit code. This is a
// timeout/load artifact, NOT an RNG or logic bug. The script's OWN internal
// budget is GAME_TIMEOUT_MS = 300s per game, so the wrapper here is given
// comparable headroom (180s) — generous enough to absorb a saturated machine
// while still bounded well under the script's hard cap.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT    = join(__dirname, '..', 'scripts', 'headless-mp-net.js');

function run(args, timeoutMs = 180_000) {
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
    // Same heavyweight-integration headroom as the 1v1 case above (the
    // disconnect/reconnect flow adds extra socket round-trips + sleeps).
    const { code, stdout, stderr } = await run(['0', '1'], 180_000);
    assert.equal(code, 0, `Expected exit code 0, got ${code}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    assert.match(stdout, /reconnected/, 'Output should show reconnection');
    assert.match(stdout, /0 errors/, 'Should have 0 errors');
  });
});
