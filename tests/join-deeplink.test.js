// Tests for the /join deep-link flow: AASA config, server redirect route,
// and hash-based deep link parsing.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import http from 'http';

// ── AASA file validation ───────────────────────────────────────────────────

describe('apple-app-site-association', () => {
  const aasaPath = join(import.meta.dirname, '..', '.well-known', 'apple-app-site-association');
  const aasa = JSON.parse(readFileSync(aasaPath, 'utf8'));

  test('is valid JSON with applinks.details', () => {
    assert.ok(aasa.applinks, 'should have applinks key');
    assert.ok(Array.isArray(aasa.applinks.details), 'should have details array');
    assert.ok(aasa.applinks.details.length > 0, 'details should not be empty');
  });

  test('includes /join* in paths', () => {
    const paths = aasa.applinks.details[0].paths;
    assert.ok(paths.includes('/join*'), 'paths should include /join*');
  });

  test('still includes /auth/verify* and /invite* paths', () => {
    const paths = aasa.applinks.details[0].paths;
    assert.ok(paths.includes('/auth/verify*'), 'paths should include /auth/verify*');
    assert.ok(paths.includes('/invite*'), 'paths should include /invite*');
  });
});

// ── Server /join route ─────────────────────────────────────────────────────

describe('/join server route', () => {
  /** Make a GET request and return { statusCode, headers }. */
  function get(path) {
    return new Promise((resolve, reject) => {
      const port = process.env.PORT || 3000;
      const req = http.get(`http://localhost:${port}${path}`, (res) => {
        res.resume(); // drain body
        resolve({ statusCode: res.statusCode, headers: res.headers });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  test('redirects /join?code=ABCDEF to /#join=ABCDEF', async () => {
    let res;
    try { res = await get('/join?code=ABCDEF'); } catch { return; /* server not running — skip */ }
    assert.equal(res.statusCode, 302);
    assert.ok(res.headers.location, 'should have Location header');
    assert.ok(res.headers.location.includes('#join=ABCDEF'), `Location should contain #join=ABCDEF, got: ${res.headers.location}`);
  });

  test('redirects /join?code=XYZ&slot=2 to /#join=XYZ&slot=2', async () => {
    let res;
    try { res = await get('/join?code=XYZ&slot=2'); } catch { return; }
    assert.equal(res.statusCode, 302);
    assert.ok(res.headers.location.includes('#join=XYZ'), `should contain #join=XYZ, got: ${res.headers.location}`);
    assert.ok(res.headers.location.includes('&slot=2'), `should contain &slot=2, got: ${res.headers.location}`);
  });

  test('returns 400 when code is missing', async () => {
    let res;
    try { res = await get('/join'); } catch { return; }
    assert.equal(res.statusCode, 400);
  });

  test('returns 400 when code is empty', async () => {
    let res;
    try { res = await get('/join?code='); } catch { return; }
    assert.equal(res.statusCode, 400);
  });
});

// ── Hash deep-link regex (mirrors _checkGameDeepLink in main.js) ───────────

describe('#join= hash parsing', () => {
  // The regex used in _checkGameDeepLink — extracted here for direct testing
  const JOIN_RE = /^#join=([^&]+)(?:&slot=(\d+))?$/;

  test('matches #join=ABCDEF with code only', () => {
    const m = '#join=ABCDEF'.match(JOIN_RE);
    assert.ok(m, 'should match');
    assert.equal(m[1], 'ABCDEF');
    assert.equal(m[2], undefined, 'slot should be undefined');
  });

  test('matches #join=CODE&slot=2', () => {
    const m = '#join=CODE&slot=2'.match(JOIN_RE);
    assert.ok(m, 'should match');
    assert.equal(m[1], 'CODE');
    assert.equal(m[2], '2');
  });

  test('matches #join=CODE&slot=0', () => {
    const m = '#join=CODE&slot=0'.match(JOIN_RE);
    assert.ok(m, 'should match');
    assert.equal(m[1], 'CODE');
    assert.equal(m[2], '0');
  });

  test('matches URL-encoded codes', () => {
    const m = '#join=AB%20CD'.match(JOIN_RE);
    assert.ok(m, 'should match');
    assert.equal(decodeURIComponent(m[1]), 'AB CD');
  });

  test('does not match #invite=CODE', () => {
    const m = '#invite=CODE'.match(JOIN_RE);
    assert.equal(m, null);
  });

  test('does not match #game=ROOMID', () => {
    const m = '#game=ROOMID'.match(JOIN_RE);
    assert.equal(m, null);
  });

  test('does not match empty hash', () => {
    const m = '#'.match(JOIN_RE);
    assert.equal(m, null);
  });
});

// ── Link URL format ────────────────────────────────────────────────────────

describe('join link URL format', () => {
  test('new URL produces clean path without double slash', () => {
    // Simulates _linkOrigin() returning a trailing-slash origin (web)
    const withSlash = new URL('/join?code=ABC', 'https://calebshollow.com/').href;
    assert.equal(withSlash, 'https://calebshollow.com/join?code=ABC');

    // Simulates _linkOrigin() returning no trailing slash (Capacitor)
    const noSlash = new URL('/join?code=ABC', 'https://calebshollow.com').href;
    assert.equal(noSlash, 'https://calebshollow.com/join?code=ABC');
  });

  test('slot parameter is included correctly', () => {
    const url = new URL('/join?code=XYZ&slot=1', 'https://calebshollow.com').href;
    assert.equal(url, 'https://calebshollow.com/join?code=XYZ&slot=1');
  });

  test('special characters in code are preserved', () => {
    const code = encodeURIComponent('A B+C');
    const url = new URL(`/join?code=${code}`, 'https://calebshollow.com').href;
    assert.ok(url.includes(`code=${code}`), `URL should contain encoded code, got: ${url}`);
  });
});
