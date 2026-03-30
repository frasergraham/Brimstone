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
  test('_onlineError is called after _initMpStep in the onError handler', () => {
    // Extract the onError handler block — look for the setup-screen auth phase branch
    const onErrorMatch = mainJs.match(
      /onError\(msg\)\s*\{[^}]*showStep\('multiplayer'\);[^}]*_initMpStep\(\);[^}]*_onlineError\(msg\)/
    );
    assert.ok(
      onErrorMatch,
      '_onlineError(msg) must be called AFTER _initMpStep() in the onError handler, ' +
      'otherwise _initMpStep resets the error display to none'
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
