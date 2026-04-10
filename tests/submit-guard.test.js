import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SubmitGuard } from '../src/submit-guard.js';

function makeFakeEl(id) {
  const listeners = [];
  return {
    id,
    addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); },
    _listeners: listeners,
  };
}

describe('SubmitGuard', () => {
  test('first registration succeeds and calls addEventListener', () => {
    const guard = new SubmitGuard();
    const el = makeFakeEl('end-turn-btn');
    const handler = () => {};

    const result = guard.addEventListener(el, 'click', handler, { signal: null });

    assert.equal(result, true);
    assert.equal(el._listeners.length, 1);
    assert.equal(el._listeners[0].type, 'click');
    assert.equal(el._listeners[0].fn, handler);
  });

  test('duplicate registration on same element + event type is blocked', () => {
    const guard = new SubmitGuard();
    const el = makeFakeEl('plan-submit-btn');

    assert.equal(guard.addEventListener(el, 'click', () => {}, {}), true);
    assert.equal(guard.addEventListener(el, 'click', () => {}, {}), false);
    assert.equal(el._listeners.length, 1, 'only one listener should be registered');
  });

  test('different event types on same element both succeed', () => {
    const guard = new SubmitGuard();
    const el = makeFakeEl('end-turn-btn');

    assert.equal(guard.addEventListener(el, 'click', () => {}, {}), true);
    assert.equal(guard.addEventListener(el, 'touchend', () => {}, {}), true);
    assert.equal(el._listeners.length, 2);
  });

  test('same event type on different elements both succeed', () => {
    const guard = new SubmitGuard();
    const elA = makeFakeEl('end-turn-btn');
    const elB = makeFakeEl('plan-submit-btn');

    assert.equal(guard.addEventListener(elA, 'click', () => {}, {}), true);
    assert.equal(guard.addEventListener(elB, 'click', () => {}, {}), true);
    assert.equal(elA._listeners.length, 1);
    assert.equal(elB._listeners.length, 1);
  });

  test('reset() clears tracking and allows re-registration', () => {
    const guard = new SubmitGuard();
    const el = makeFakeEl('end-turn-btn');

    assert.equal(guard.addEventListener(el, 'click', () => {}, {}), true);
    guard.reset();
    assert.equal(guard.addEventListener(el, 'click', () => {}, {}), true);
    assert.equal(el._listeners.length, 2, 'both registrations should reach the element');
  });

  test('null element returns false without throwing', () => {
    const guard = new SubmitGuard();
    assert.equal(guard.addEventListener(null, 'click', () => {}, {}), false);
  });
});
