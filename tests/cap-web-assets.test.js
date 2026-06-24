// Guard: the offline web builds (Capacitor iOS/Android + the itch.io zip)
// include every stylesheet, entry script, and CSS-referenced font/asset that
// index.html pulls in at runtime — using relative paths that resolve under a
// non-HTTP root.
//
// Why this exists: these builds are thin file-copies into a dir served from a
// non-HTTP origin (capacitor://localhost/ for mobile, a zip/file:// root for
// itch). Unlike the dev server (which serves the whole repo root) and the
// Electron build (which uses a `**/*` glob), both copies are EXPLICIT
// whitelists. When the ledger-menu redesign linked a second stylesheet
// (styles-ledger.css) — which itself @imports assets/fonts/ledger-fonts.css and
// references assets/bg.png — but the stylesheet/fonts were NOT added to the
// whitelist, they 404'd and the entire menu rendered as unstyled text. This
// happened on BOTH paths (iOS: scripts/cap-copy-web.js, then itch:
// scripts/build-itch.js — same bug class). These tests fail the build if any
// index.html ref (or anything its CSS transitively loads via @import /
// @font-face / url()) is missing from a copy, or uses a non-relative path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const capScript = readFileSync(join(ROOT, 'scripts', 'cap-copy-web.js'), 'utf8');
const itchScript = readFileSync(join(ROOT, 'scripts', 'build-itch.js'), 'utf8');

// ── Parse a `const NAME = [ ... ]` string-array out of a build script ─────────
function parseArray(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(m, `could not find "const ${name} = [ ... ]"`);
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

// cap-copy-web.js copies whole `dirs = [...]` + individual `files = [...]`.
const capDirs = parseArray(capScript, 'dirs');
const capFiles = parseArray(capScript, 'files');
// build-itch.js copies a single mixed `COPY = [...]` (dirs + files, resolved by
// statSync at runtime). Split it into the two buckets the same way the script
// does: an entry is a directory iff the on-disk path is a directory.
const itchCopy = parseArray(itchScript, 'COPY');
const isDir = (rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) && statSync(p).isDirectory();
};
const itchDirs = itchCopy.filter(isDir);
const itchFiles = itchCopy.filter((e) => !itchDirs.includes(e));

// A reference is covered if it's a verbatim file entry, or it lives under one of
// the wholesale-copied dirs (e.g. assets/…, assets/fonts/…, src/…).
function makeIsCopied(dirs, files) {
  return (ref) => {
    if (files.includes(ref)) return true;
    return dirs.some((d) => ref === d || ref.startsWith(d + '/'));
  };
}
const isCopiedCap = makeIsCopied(capDirs, capFiles);
const isCopiedItch = makeIsCopied(itchDirs, itchFiles);

// ── Direct index.html stylesheet + entry-script references ────────────────────
function htmlRefs(re) {
  return [...html.matchAll(re)].map((m) => m[1]);
}
const styleHrefs = htmlRefs(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi)
  // also catch href-before-rel ordering
  .concat(htmlRefs(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']stylesheet["']/gi));
const scriptSrcs = htmlRefs(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi);

// Only audit local references — skip remote (http(s):) and data: URIs.
const isLocal = (ref) => !/^(?:[a-z]+:)?\/\//i.test(ref) && !ref.startsWith('data:');

const directRefs = [...new Set([...styleHrefs, ...scriptSrcs])].filter(isLocal);

// ── Walk the CSS @import / @font-face / url() chain ───────────────────────────
// styles-ledger.css @imports assets/fonts/ledger-fonts.css and references
// assets/bg.png; ledger-fonts.css @font-faces a pile of woff2s; styles.css
// @font-faces assets/fonts/brimstone-icons.woff2. None of these appear in
// index.html directly, so a build whitelist that only mirrors index.html's
// <link>s still ships an unstyled menu (no fonts). Resolve them transitively.
function cssUrlRefs(css) {
  const out = [];
  // @import url('...') | @import '...'
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"')]+)["']/gi)) out.push(m[1]);
  // url(...) in src:/background: etc. — strip optional quotes.
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) out.push(m[1]);
  return out
    .map((r) => r.replace(/[?#].*$/, '')) // drop cache-busting query / fragment
    .filter(isLocal);
}

// Resolve every local asset index.html transitively references, by following CSS
// imports/urls relative to each stylesheet's own directory. Returns repo-root
// relative POSIX paths (matching the whitelist entry style).
function resolveAllRefs() {
  const resolved = new Set();
  const visitedCss = new Set();

  function visit(relPath /* repo-root relative, posix */) {
    if (resolved.has(relPath)) return;
    resolved.add(relPath);
    if (!relPath.endsWith('.css')) return;
    if (visitedCss.has(relPath)) return;
    visitedCss.add(relPath);
    const abs = join(ROOT, relPath);
    if (!existsSync(abs)) return; // missing-file case is asserted elsewhere
    const css = readFileSync(abs, 'utf8');
    const base = posix.dirname(relPath);
    for (const child of cssUrlRefs(css)) {
      // Resolve child relative to the importing CSS file's directory.
      const childRel = posix.normalize(posix.join(base === '.' ? '' : base, child));
      visit(childRel);
    }
  }

  for (const ref of directRefs) visit(posix.normalize(ref));
  return [...resolved];
}

const allRefs = resolveAllRefs();

// ── Shared assertions, parameterised per build target ─────────────────────────
function assertAllRelative(refs) {
  for (const ref of refs) {
    assert.ok(
      !ref.startsWith('/'),
      `"${ref}" uses a leading-slash absolute path — it resolves under an HTTP ` +
        `server but 404s under capacitor://localhost/ or a file:// / zip root. ` +
        `Use a relative path (e.g. "${ref.replace(/^\/+/, '')}").`,
    );
  }
}

function assertAllCopied(refs, isCopied, scriptName, arrayHint) {
  for (const ref of refs) {
    assert.ok(
      isCopied(ref),
      `index.html (or the CSS it loads) references "${ref}" but ` +
        `${scriptName} does not copy it. The webview / itch package will 404 on ` +
        `it and the menu renders unstyled. Add it to ${arrayHint} in ${scriptName}.`,
    );
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
test('index.html references at least one stylesheet (sanity)', () => {
  assert.ok(styleHrefs.length > 0, 'expected index.html to link a stylesheet');
});

test('the CSS chain resolves the ledger fonts (sanity — guards the walker itself)', () => {
  // If this set ever stops including the fonts, the walker silently stopped
  // catching the transitive refs and the copy guards below would pass vacuously.
  assert.ok(
    allRefs.includes('styles-ledger.css'),
    'expected styles-ledger.css among resolved refs',
  );
  assert.ok(
    allRefs.includes('assets/fonts/ledger-fonts.css'),
    'expected the @import of assets/fonts/ledger-fonts.css to be resolved',
  );
  assert.ok(
    allRefs.some((r) => /assets\/fonts\/.*\.woff2$/.test(r)),
    'expected at least one woff2 font among resolved refs',
  );
  assert.ok(
    allRefs.includes('assets/fonts/brimstone-icons.woff2'),
    'expected styles.css @font-face brimstone-icons.woff2 to be resolved',
  );
  assert.ok(
    allRefs.includes('assets/bg.png'),
    'expected styles-ledger.css url(assets/bg.png) to be resolved',
  );
});

test('every index.html / CSS asset path is relative (no leading slash)', () => {
  assertAllRelative(allRefs);
});

test('Capacitor copy (cap-copy-web.js) includes every index.html + CSS asset', () => {
  assertAllCopied(allRefs, isCopiedCap, 'scripts/cap-copy-web.js', 'the files[]/dirs[] arrays');
});

test('itch.io build (build-itch.js) includes every index.html + CSS asset', () => {
  assertAllCopied(allRefs, isCopiedItch, 'scripts/build-itch.js', 'the COPY[] array');
});

test('styles-ledger.css (ledger menu) is in BOTH copy manifests (regression)', () => {
  // Specific regression guard for the original bug class: the ledger stylesheet
  // was linked from index.html but absent from the copy, so the menu rendered
  // unstyled — first on iOS (cap-copy-web.js), then on itch (build-itch.js).
  assert.ok(html.includes('styles-ledger.css'), 'index.html should link styles-ledger.css');
  assert.ok(
    isCopiedCap('styles-ledger.css'),
    'styles-ledger.css must be in the cap-copy-web.js files[] whitelist',
  );
  assert.ok(
    isCopiedItch('styles-ledger.css'),
    'styles-ledger.css must be in the build-itch.js COPY[] whitelist',
  );
});

test('itch.io build injects the static-build marker (window.BRIMSTONE_ITCH = true)', () => {
  // The menu (src/menu/ledger.js via src/demo-config.js isStaticBuild) reads
  // window.BRIMSTONE_ITCH to hide the online-only rail entries (Play Online +
  // Account) — there's no server on the static host, so they'd only error on
  // click. build-itch.js must inject the flag into the built index.html, and it
  // must be valid JS (a `window.BRIMSTONE_ITCH = true` assignment in a <script>).
  const patchMatch = itchScript.match(/const ITCH_PATCH\s*=\s*`([\s\S]*?)`/);
  assert.ok(patchMatch, 'build-itch.js should define an ITCH_PATCH template injected into index.html');
  const patch = patchMatch[1];
  assert.match(patch, /<script>/, 'the patch must wrap the flag in a <script> tag');
  assert.match(
    patch,
    /window\.BRIMSTONE_ITCH\s*=\s*true\s*;?/,
    'build-itch.js must inject `window.BRIMSTONE_ITCH = true` so the menu hides the online-only entries',
  );
  // And it must actually be spliced into the head (not just defined).
  assert.match(
    itchScript,
    /replace\(\s*['"]<\/head>['"]\s*,\s*ITCH_PATCH/,
    'build-itch.js must splice ITCH_PATCH into index.html before </head>',
  );
});

// ── itch.io ships the 3D-renderer RUNTIME assets (not just the styled menu) ───
// The original CSS fix made the menu render, but the build shipped NONE of the
// runtime assets the 3D renderer fetches in-game (GLB models, terrain textures,
// the Babylon vendor bundle, char portraits, mission-map thumbnails, voice), so
// a game couldn't actually play. The robust fix copies `assets` wholesale; these
// guards pin that the key runtime trees are covered so the gap can't silently
// regress to a per-file allowlist that drifts again.
test('itch.io build ships every 3D-renderer runtime asset dir (game must play, not just menu)', () => {
  // Each of these is fetched by src/renderer-3d.js / UI at runtime. They live
  // under assets/, so the wholesale `assets` COPY entry covers them — but assert
  // explicitly so a future "trim the assets copy" change can't drop a runtime dir.
  const runtimeAssetDirs = [
    'assets/models',          // GLB rigs (paladin/mannequin/zombie), buildings, trees
    'assets/textures/terrain', // *-detail.jpg terrain splat tints the renderer loads
    'assets/vendor',          // Babylon core + glTF loaders (no CDN at runtime)
    'assets/voice',           // conversation/tutorial/mission narration MP3s + manifest
    'assets/mission-maps',    // campaign mission briefing thumbnails
    'assets/fonts',           // brimstone-icons + ledger fonts
  ];
  for (const dir of runtimeAssetDirs) {
    assert.ok(
      isCopiedItch(dir),
      `build-itch.js must ship ${dir} — the 3D renderer / UI fetches it at ` +
        `runtime; without it a game renders nothing (or 404s) and is unplayable. ` +
        `Keep the wholesale "assets" entry in COPY[].`,
    );
    assert.ok(
      existsSync(join(ROOT, dir)),
      `${dir} should exist on disk (test self-check)`,
    );
  }
  // Char portrait PNGs sit at the assets/ root (referenced by the ledger header
  // and the faction-select carousel in src/main.js).
  for (const portrait of ['assets/char-paladin.png', 'assets/char-witch.png']) {
    assert.ok(
      isCopiedItch(portrait),
      `build-itch.js must ship ${portrait} (covered by the wholesale assets copy)`,
    );
  }
});

test('Babylon vendor scripts use RELATIVE paths (resolve under the itch zip sub-path root)', () => {
  // src/renderer-3d.js loads Babylon core + loaders via <script> tags. A
  // leading-slash absolute path ("/assets/vendor/…") anchors to the ORIGIN root,
  // which 404s on itch's sub-path host (html.itch.zone/html/<id>/) — Babylon
  // never loads and the 3D renderer stays a black canvas. Pin them relative.
  const r3d = readFileSync(join(ROOT, 'src', 'renderer-3d.js'), 'utf8');
  assert.ok(
    !/['"`]\/assets\/vendor\/babylonjs\//.test(r3d),
    'src/renderer-3d.js must NOT load Babylon via a leading-slash "/assets/vendor/…" ' +
      'path — it 404s on the itch zip sub-path root. Use a relative "assets/vendor/…".',
  );
  assert.ok(
    /['"`]assets\/vendor\/babylonjs\/babylon\.js['"`]/.test(r3d),
    'expected the relative Babylon core path "assets/vendor/babylonjs/babylon.js"',
  );
});

// ── itch.io stub modules export everything the client imports ─────────────────
// build-itch.js replaces a few dev/native-only modules (platform.js,
// server-selector.js, notifications.js) with minimal stubs. If a stub omits an
// export the client imports, the ES-module load throws
// `does not provide an export named '…'` and the importing module — including
// the whole ledger menu — silently fails to render (a blank screen, same
// user-visible symptom as the missing-CSS bug). The server-selector stub
// drifted exactly this way: it exported initServerSelector while ledger.js
// imports mountServerSelector. These tests pin each stub to the real module's
// imported surface.

// Extract export names from a chunk of JS source (named function/const/let/var
// + `export { a, b }` lists). Good enough for these hand-written stubs.
function exportNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// Pull a `const NAME = \`...\`;` template-literal stub body out of build-itch.js.
function parseStub(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\`([\\s\\S]*?)\``));
  assert.ok(m, `build-itch.js: could not find stub "const ${name} = \\\`…\\\`"`);
  return m[1];
}

// Symbols the rest of src/ imports from a given module file.
function importedSymbols(moduleBasename) {
  // moduleBasename e.g. 'server-selector.js' — match any relative import of it.
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*${moduleBasename.replace('.', '\\.')}['"]`, 'g');
  const out = new Set();
  // Cheap repo-wide scan over the source tree the build ships (src/).
  const { execSync } = require('node:child_process');
  let hits = '';
  try {
    hits = execSync(`grep -rhoE "import \\{[^}]+\\} from '[^']*${moduleBasename}'" "${join(ROOT, 'src')}"`, { encoding: 'utf8' });
  } catch { /* no matches → empty */ }
  for (const m of hits.matchAll(/\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) out.add(name);
    }
  }
  return out;
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const STUBS = [
  { stubVar: 'selectorStub', module: 'server-selector.js' },
  { stubVar: 'platformStub', module: 'platform.js' },
];

for (const { stubVar, module } of STUBS) {
  test(`itch.io ${stubVar} exports every symbol the client imports from ${module}`, () => {
    const stubExports = exportNames(parseStub(itchScript, stubVar));
    const needed = importedSymbols(module);
    assert.ok(needed.size > 0, `expected some src/ import of ${module} (test self-check)`);
    for (const sym of needed) {
      assert.ok(
        stubExports.has(sym),
        `build-itch.js ${stubVar} (the itch stub for ${module}) does not export ` +
          `"${sym}", but src/ imports it. The ES-module load throws "does not ` +
          `provide an export named '${sym}'" and the menu renders blank. Add ` +
          `\`export ... ${sym}\` to ${stubVar}.`,
      );
    }
  });
}
