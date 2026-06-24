// Guard: the Capacitor (iOS/Android) web copy includes every stylesheet and
// entry script that index.html references, using Capacitor-safe relative paths.
//
// Why this exists: the mobile build is a thin file-copy (scripts/cap-copy-web.js)
// into a `www/` dir that the webview serves from capacitor://localhost/. Unlike
// the dev server (which serves the whole repo root) and the Electron build (which
// uses a `**/*` glob), the Capacitor copy is an EXPLICIT whitelist. When a new
// top-level stylesheet was linked from index.html (styles-ledger.css, the ledger
// menu redesign) but NOT added to that whitelist, it 404'd in the webview and the
// entire menu rendered as unstyled text. This test fails the build if any
// index.html <link rel="stylesheet"> / <script src> is missing from the copy, or
// if it uses a non-relative (absolute/scheme/protocol-relative) path that would
// break under capacitor://localhost/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const capScript = readFileSync(join(ROOT, 'scripts', 'cap-copy-web.js'), 'utf8');

// ── Parse what cap-copy-web.js copies ────────────────────────────────────────
// `dirs = [...]` (whole directories) and `files = [...]` (individual files).
function parseArray(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(m, `cap-copy-web.js: could not find "const ${name} = [ ... ]"`);
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}
const copiedDirs = parseArray(capScript, 'dirs');
const copiedFiles = parseArray(capScript, 'files');

// A reference is covered if it's listed verbatim in `files`, or it lives under
// one of the wholesale-copied `dirs` (e.g. assets/…, src/…).
function isCopied(ref) {
  if (copiedFiles.includes(ref)) return true;
  return copiedDirs.some((d) => ref === d || ref.startsWith(d + '/'));
}

// ── Extract every stylesheet + entry-script reference from index.html ─────────
function refs(re) {
  return [...html.matchAll(re)].map((m) => m[1]);
}
const styleHrefs = refs(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi)
  // also catch href-before-rel ordering
  .concat(refs(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']stylesheet["']/gi));
const scriptSrcs = refs(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi);

const allRefs = [...new Set([...styleHrefs, ...scriptSrcs])];

// Only audit local references — skip remote (http(s):) and data: URIs.
const isLocal = (ref) => !/^(?:[a-z]+:)?\/\//i.test(ref) && !ref.startsWith('data:');
const localRefs = allRefs.filter(isLocal);

test('index.html references at least one stylesheet (sanity)', () => {
  assert.ok(styleHrefs.length > 0, 'expected index.html to link a stylesheet');
});

test('every index.html asset path is Capacitor-safe (relative, no leading slash)', () => {
  for (const ref of localRefs) {
    assert.ok(
      !ref.startsWith('/'),
      `index.html references "${ref}" with a leading-slash absolute path — it ` +
        `resolves under an HTTP server but 404s under capacitor://localhost/. ` +
        `Use a relative path (e.g. "${ref.replace(/^\/+/, '')}").`,
    );
  }
});

test('every stylesheet + script index.html references is copied into the Capacitor www/', () => {
  for (const ref of localRefs) {
    assert.ok(
      isCopied(ref),
      `index.html references "${ref}" but scripts/cap-copy-web.js does not copy ` +
        `it into www/ (not in the files[] whitelist nor under a copied dir: ` +
        `${copiedDirs.join(', ')}). The iOS/Android webview will 404 on it. ` +
        `Add it to the files[] array in scripts/cap-copy-web.js.`,
    );
  }
});

test('styles-ledger.css (ledger menu) is in the Capacitor copy manifest (regression)', () => {
  // Specific regression guard for the original bug: the ledger stylesheet was
  // linked from index.html but absent from www/, so the menu rendered unstyled.
  assert.ok(
    html.includes('styles-ledger.css'),
    'index.html should link styles-ledger.css',
  );
  assert.ok(
    isCopied('styles-ledger.css'),
    'styles-ledger.css must be in the cap-copy-web.js files[] whitelist',
  );
});
