// Tests for the multiplayer sign-in error visibility fix.
//
// The onError handler in _createMpClient must call _onlineError() AFTER
// _initMpStep(), because _initMpStep() resets the error element to
// display:none. If _onlineError runs first, the error is immediately hidden.

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
    // internally call _initMpStep()/_initAsyncStep(), then calls _onlineError(msg).
    // This ensures the error is displayed AFTER init resets display:none.
    // Extract the onError handler body (allowing nested braces)
    const onErrorStart = mainJs.indexOf('onError(msg) {');
    assert.ok(onErrorStart !== -1, 'onError handler must exist');
    const afterStart = mainJs.slice(onErrorStart, onErrorStart + 500);

    // _showOnlineScreen() must appear before _onlineError(msg) in the handler
    const showIdx = afterStart.indexOf('_showOnlineScreen()');
    const errIdx  = afterStart.indexOf('_onlineError(msg)');
    assert.ok(showIdx !== -1, 'onError handler must call _showOnlineScreen()');
    assert.ok(errIdx  !== -1, 'onError handler must call _onlineError(msg)');
    assert.ok(
      showIdx < errIdx,
      '_onlineError(msg) must be called AFTER _showOnlineScreen() in the onError handler, ' +
      'otherwise the init step resets the error display to none'
    );
  });

  test('_initMpStep resets mp-name-error to display:none', () => {
    // Verify the assumption: _initMpStep hides the error element
    assert.ok(
      mainJs.includes("document.getElementById('mp-name-error').style.display = 'none'"),
      '_initMpStep should reset the error element display to none'
    );
  });
});
