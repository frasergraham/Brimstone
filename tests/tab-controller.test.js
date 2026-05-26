// Unit tests for the lazy-init tab controller used by admin-tools.html.
//
// The controller's whole reason for existing is to keep heavy Babylon scenes
// (Assets, Lighting) from all booting on page load — each tab inits only on its
// FIRST activation and never again. These tests pin that contract.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabController } from '../src/tools/tab-controller.js';

describe('createTabController', () => {
  test('first activation of a tab returns true and runs init once', () => {
    const inited = [];
    const ctl = createTabController(['assets', 'lighting', 'editor'], {
      onFirstActivate: (id) => inited.push(id),
    });

    assert.equal(ctl.activate('assets'), true, 'first activation reports first-time');
    assert.equal(ctl.activate('assets'), false, 'second activation is not first-time');
    assert.deepEqual(inited, ['assets'], 'init ran exactly once for the tab');
  });

  test('does NOT init other tabs until they are activated (lazy)', () => {
    const inited = [];
    const ctl = createTabController(['assets', 'lighting', 'editor'], {
      onFirstActivate: (id) => inited.push(id),
    });

    ctl.activate('assets');
    assert.equal(ctl.isInitialized('assets'), true);
    assert.equal(ctl.isInitialized('lighting'), false, 'lighting stays uninitialized');
    assert.equal(ctl.isInitialized('editor'), false, 'editor stays uninitialized');
    assert.deepEqual(inited, ['assets'], 'only the activated tab was initialized');
  });

  test('switching back to an already-inited tab does not re-init', () => {
    const inited = [];
    const ctl = createTabController(['assets', 'lighting', 'editor'], {
      onFirstActivate: (id) => inited.push(id),
    });

    ctl.activate('assets');
    ctl.activate('lighting');
    ctl.activate('assets'); // back to assets — must NOT re-init
    ctl.activate('lighting');

    assert.deepEqual(inited, ['assets', 'lighting'], 'each tab inited exactly once');
  });

  test('tracks the active tab', () => {
    const ctl = createTabController(['assets', 'lighting', 'editor']);
    assert.equal(ctl.active, null, 'no tab active initially');
    ctl.activate('lighting');
    assert.equal(ctl.active, 'lighting');
    ctl.activate('editor');
    assert.equal(ctl.active, 'editor');
  });

  test('onActivate fires on every activation; onFirstActivate only the first', () => {
    const first = [];
    const every = [];
    const ctl = createTabController(['assets', 'lighting', 'editor'], {
      onFirstActivate: (id) => first.push(id),
      onActivate: (id) => every.push(id),
    });

    ctl.activate('assets');
    ctl.activate('assets');
    ctl.activate('lighting');

    assert.deepEqual(first, ['assets', 'lighting']);
    assert.deepEqual(every, ['assets', 'assets', 'lighting']);
  });

  test('rejects unknown tabs and empty tab lists', () => {
    const ctl = createTabController(['assets']);
    assert.throws(() => ctl.activate('nope'), /unknown tab/);
    assert.throws(() => createTabController([]), /non-empty/);
  });
});
