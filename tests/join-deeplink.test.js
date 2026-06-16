// Tests for the /join deep-link flow: AASA config and the server redirect
// route (server/join-route.js, mounted at GET /join in server.js).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

import { handleJoinRedirect } from '../server/join-route.js';

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

// ── /join redirect handler (behavioral) ─────────────────────────────────────

/** Drive the real handler with fake Express req/res objects. */
function run(query) {
  const res = {
    statusCode: 200,
    redirectedTo: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    send(body)   { this.body = body; return this; },
    redirect(loc) { this.statusCode = 302; this.redirectedTo = loc; return this; },
  };
  handleJoinRedirect({ query }, res);
  return res;
}

describe('/join redirect handler', () => {
  test('redirects /join?code=ABCDEF to /#join=ABCDEF', () => {
    const res = run({ code: 'ABCDEF' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.redirectedTo, '/#join=ABCDEF');
  });

  test('redirects /join?code=XYZ&slot=2 to /#join=XYZ&slot=2', () => {
    const res = run({ code: 'XYZ', slot: '2' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.redirectedTo, '/#join=XYZ&slot=2');
  });

  test('slot=0 is preserved (falsy but valid seat index)', () => {
    const res = run({ code: 'XYZ', slot: '0' });
    assert.equal(res.redirectedTo, '/#join=XYZ&slot=0');
  });

  test('returns 400 when code is missing', () => {
    const res = run({});
    assert.equal(res.statusCode, 400);
    assert.equal(res.redirectedTo, null);
  });

  test('returns 400 when code is empty or whitespace', () => {
    assert.equal(run({ code: '' }).statusCode, 400);
    assert.equal(run({ code: '   ' }).statusCode, 400);
  });

  test('empty slot is omitted from the hash', () => {
    const res = run({ code: 'ABC', slot: '' });
    assert.equal(res.redirectedTo, '/#join=ABC');
  });

  test('special characters in code are URL-encoded', () => {
    const res = run({ code: 'A B&C' });
    assert.equal(res.redirectedTo, '/#join=A%20B%26C');
  });

  test('redirect hash matches the client deep-link contract (#join=CODE[&slot=N])', () => {
    // The client parses location.hash with /^#join=([^&]+)(?:&slot=(\d+))?$/
    // (see _checkGameDeepLink in src/main.js) — verify the handler's output
    // round-trips through that contract, including encoded codes.
    const CLIENT_JOIN_RE = /^#join=([^&]+)(?:&slot=(\d+))?$/;

    const plain = run({ code: 'ABCDEF' }).redirectedTo.slice(1); // strip leading '/'
    let m = plain.match(CLIENT_JOIN_RE);
    assert.ok(m, 'plain code must match the client regex');
    assert.equal(decodeURIComponent(m[1]), 'ABCDEF');
    assert.equal(m[2], undefined);

    const withSlot = run({ code: 'AB CD', slot: '2' }).redirectedTo.slice(1);
    m = withSlot.match(CLIENT_JOIN_RE);
    assert.ok(m, 'encoded code + slot must match the client regex');
    assert.equal(decodeURIComponent(m[1]), 'AB CD');
    assert.equal(m[2], '2');
  });
});
