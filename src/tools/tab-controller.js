// Lazy-init tab controller for the unified admin tools page (admin-tools.html).
//
// Each tab on the Caleb's Hollow Tools page (Assets / Lighting / Mission Editor)
// owns a heavy resource: Assets and Lighting each spin up a full Babylon scene
// + render loop. Booting all of them on page load would run three render loops
// at once. This controller defers each tab's one-time `init` until the FIRST
// time that tab is activated, and never re-runs it on subsequent switches.
//
// It is deliberately DOM-free so it can be unit-tested in Node — the HTML page
// supplies the actual show/hide + init callbacks.

/**
 * Create a tab controller.
 *
 * @param {string[]} tabs - ordered list of tab ids (e.g. ['assets','lighting','editor']).
 * @param {object} [hooks]
 * @param {(id:string)=>void} [hooks.onFirstActivate] - called once, the first
 *        time each tab becomes active. This is where a tab boots its renderer.
 * @param {(id:string)=>void} [hooks.onActivate] - called every time a tab
 *        becomes active (after onFirstActivate, if applicable). Use for show/hide.
 * @returns {{
 *   activate: (id:string)=>boolean,
 *   isInitialized: (id:string)=>boolean,
 *   readonly active: string|null,
 * }}
 */
export function createTabController(tabs, hooks = {}) {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw new Error('createTabController: tabs must be a non-empty array');
  }
  const { onFirstActivate, onActivate } = hooks;
  const initialized = new Set();
  let active = null;

  return {
    /**
     * Activate a tab. Returns true when this call triggered the tab's one-time
     * init (i.e. it was the first activation), false otherwise.
     */
    activate(id) {
      if (!tabs.includes(id)) {
        throw new Error(`createTabController: unknown tab "${id}"`);
      }
      const firstTime = !initialized.has(id);
      if (firstTime) {
        initialized.add(id);
        if (onFirstActivate) onFirstActivate(id);
      }
      active = id;
      if (onActivate) onActivate(id);
      return firstTime;
    },
    isInitialized(id) {
      return initialized.has(id);
    },
    get active() {
      return active;
    },
  };
}
