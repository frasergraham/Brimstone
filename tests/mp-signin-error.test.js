// Tests for the multiplayer sign-in error visibility fix.
//
// The onError handler in _createMpClient must call _onlineError() AFTER
// _showOnlineScreen()/_showAsyncScreen(). Errors now display in the auth
// dialog (#auth-error), so the ordering concern is simpler, but we still
// verify that the handler calls the screen-show function before _onlineError.
//
// NOTE: these are deliberately source-level checks. src/main.js is the 8.6k-line
// client entry script with top-level DOM side effects — it cannot be imported
// under node:test without a full browser environment, so the call-ordering
// invariant (which guards a real regression: _initMpStep() wiping the error
// display right after it was shown) is asserted against the handler's source.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainJs = readFileSync(resolve(__dirname, '..', 'src', 'main.js'), 'utf8');

describe('multiplayer onError handler ordering', () => {
  test('_onlineError is called after the screen show functions in the onError handler', () => {
    // The onError handler calls _showOnlineScreen() or _showAsyncScreen() which
    // internally call _initMpStep()/_initAsyncStep(), then calls _onlineError(msg, raw).
    // Extract the onError handler body (allowing nested braces)
    const onErrorStart = mainJs.search(/onError\(msg(?:,\s*raw)?\)\s*\{/);
    assert.ok(onErrorStart !== -1, 'onError handler must exist');
    const afterStart = mainJs.slice(onErrorStart, onErrorStart + 1200);

    // _showOnlineScreen() must appear before _onlineError(msg, ...) in the handler
    const showIdx = afterStart.indexOf('_showOnlineScreen()');
    const errIdx  = afterStart.search(/_onlineError\(msg/);
    assert.ok(showIdx !== -1, 'onError handler must call _showOnlineScreen()');
    assert.ok(errIdx  !== -1, 'onError handler must call _onlineError(msg)');
    assert.ok(
      showIdx < errIdx,
      '_onlineError(msg) must be called AFTER _showOnlineScreen() in the onError handler, ' +
      'otherwise the init step resets the error display to none'
    );
  });

  test('_onlineError targets the auth dialog error element', () => {
    // _onlineError should show errors in the auth dialog (#auth-error)
    assert.ok(
      mainJs.includes("document.getElementById('auth-error')"),
      '_onlineError should target the auth-error element in the auth dialog'
    );
  });
});
