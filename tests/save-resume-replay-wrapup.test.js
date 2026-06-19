// Regression: the resume/reconnect replay of the just-resumed round must use the
// new turn-card wrap-up review — NOT the legacy `round-summary` modal.
//
// Bug: launching into a game from a save replayed the last turn, but that turn
// showed the OLD-style round-end summary (icon-less text modal) and dropped the
// per-turn cards. The live resolution paths (`_runLocalResolution`,
// online `onResolutionComplete`) were migrated to the wrap-up review
// (`_runEndOfRoundReview` → `ui.showReplayWrapUp`, keeping the timeline up via
// `_keepTimelineForReview`), but the RESUME paths — `_playReconnectReplay`
// (online reconnect) and `_asyncWatchLastTurn` (async) — were never migrated and
// still called `ui._showResolutionSummary(...)` directly with `gameOver: false`.
//
// `_runEndOfRoundReview` itself reserves the legacy `_showResolutionSummary`
// modal for game-over only, so routing the resume paths through it fixes both
// symptoms. This guard reads the two resume functions out of src/main.js and
// asserts they keep the timeline up and route the review through the shared
// helper instead of the legacy modal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MAIN = readFileSync(join(__dirname, '..', 'src', 'main.js'), 'utf8');

/** Slice out the body of a top-level `async function NAME(...) { … }` by brace
 *  matching from its opening brace. */
function functionBody(src, name) {
  const sig = `async function ${name}(`;
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `expected ${name} in src/main.js`);
  let i = src.indexOf('{', start);
  assert.notEqual(i, -1, `expected an opening brace for ${name}`);
  let depth = 0;
  const from = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  throw new Error(`unbalanced braces parsing ${name}`);
}

for (const fn of ['_playReconnectReplay', '_asyncWatchLastTurn']) {
  test(`${fn} routes the resumed round through the wrap-up review (not the legacy modal)`, () => {
    const body = functionBody(MAIN, fn);

    assert.match(body, /_runEndOfRoundReview\(/,
      `${fn} must route the end-of-round review through the shared _runEndOfRoundReview helper`);

    assert.match(body, /_keepTimelineForReview\s*=\s*!!/,
      `${fn} must keep the turn-card timeline up for the review (so the wrap-up card attaches)`);

    // The legacy round-summary modal is reserved for game-over (inside
    // _runEndOfRoundReview). The resume paths must not call it directly — that's
    // exactly the regression: a normal resumed round shown via the old modal.
    assert.ok(!/ui\._showResolutionSummary\(/.test(body),
      `${fn} must not call the legacy ui._showResolutionSummary modal directly`);
  });
}
