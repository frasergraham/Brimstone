// UI test: the Ledger rail hides the online-only destinations (Play Online +
// Account) on the server-less static (itch.io) build, and shows the full set on
// every other build.
//
// railDestinations(onlineAvailable) is a pure helper exported from ledger.js —
// it takes the online flag explicitly so we never touch a real window. ledger.js
// still imports a chain of UI modules, so a minimal global document/window stub
// is installed BEFORE importing it (mirrors node-count-dropdown.test.js).

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

before(() => {
  globalThis.document = {
    createElement: () => ({
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {}, addEventListener() {}, appendChild() {}, replaceChildren() {},
      querySelectorAll() { return []; },
    }),
    addEventListener() {},
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };
  globalThis.window = { innerHeight: 800, addEventListener() {} };
});

let railDestinations;
before(async () => {
  ({ railDestinations } = await import('../../src/menu/ledger.js'));
});

const ids = (dests) => dests.map((d) => d.id);

describe('railDestinations — static (itch.io) build gating', () => {
  test('static build (online unavailable) OMITS Play Online + Account', () => {
    const dests = ids(railDestinations(false /* onlineAvailable */));
    assert.ok(!dests.includes('others'),  'Play Online must be hidden on the static build');
    assert.ok(!dests.includes('account'), 'Account must be hidden on the static build');
  });

  test('static build KEEPS the offline-playable destinations', () => {
    const dests = ids(railDestinations(false));
    for (const id of ['continue', 'campaign', 'skirmish', 'replays']) {
      assert.ok(dests.includes(id), `${id} must stay available on the static build`);
    }
  });

  test('normal build (online available) INCLUDES Play Online + Account', () => {
    const dests = ids(railDestinations(true /* onlineAvailable */));
    assert.ok(dests.includes('others'),  'Play Online must show on web/Electron/Capacitor');
    assert.ok(dests.includes('account'), 'Account must show on web/Electron/Capacitor');
  });

  test('normal build shows every destination (nothing dropped)', () => {
    // The full set: any future destination is shown by default unless it is an
    // online-only entry on the static build.
    const full = ids(railDestinations(true));
    assert.deepEqual(full, ['continue', 'campaign', 'skirmish', 'others', 'replays', 'account']);
  });
});
