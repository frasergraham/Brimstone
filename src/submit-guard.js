/**
 * Tracks event listener registrations on submit-related elements
 * to prevent duplicate handlers and log all registration attempts.
 *
 * Usage:
 *   const guard = new SubmitGuard();
 *   guard.addEventListener(element, 'click', handler, options);
 *   guard.reset();  // call on destroy() to allow re-registration
 */
export class SubmitGuard {
  constructor() {
    /** @type {Map<EventTarget, Set<string>>} */
    this._registered = new Map();
  }

  /**
   * Register an event listener, blocking duplicates for the same element + event type.
   * @param {EventTarget|null} el   Target element
   * @param {string}           type Event type ('click', 'touchend', etc.)
   * @param {Function}         handler
   * @param {object}           [opts] addEventListener options
   * @returns {boolean} true if registered, false if blocked or el is null
   */
  addEventListener(el, type, handler, opts) {
    if (!el) return false;

    const id = el.id ?? '(unknown)';
    const types = this._registered.get(el);

    if (types?.has(type)) {
      console.warn(`[SubmitGuard] Blocked duplicate "${type}" handler on #${id}`);
      return false;
    }

    console.log(`[SubmitGuard] Registering "${type}" handler on #${id}`);

    if (!types) {
      this._registered.set(el, new Set([type]));
    } else {
      types.add(type);
    }

    el.addEventListener(type, handler, opts);
    return true;
  }

  /** Clear all tracking state. Call when the UI is destroyed so re-registration is allowed. */
  reset() {
    this._registered.clear();
  }
}
