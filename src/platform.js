/**
 * Platform detection and native mobile bootstrap.
 *
 * When running inside Capacitor (iOS / Android), this module:
 *   1. Sets window.BRIMSTONE_SERVER / BRIMSTONE_WS to the production server
 *      so fetch() and WebSocket calls that use relative paths resolve correctly.
 *   2. Hides the splash screen once the DOM is interactive.
 *   3. Wires the Android hardware back-button to close overlays or confirm exit.
 *
 * On web / Electron this module is a no-op — all guards check for
 * window.Capacitor before importing any native plugins.
 */

const DEFAULT_SERVER = 'https://brimstone.run';

/** True when running inside a Capacitor native shell. */
export const isNativeMobile = !!window.Capacitor;

// ── Server URL injection ────────────────────────────────────────────────────
// Mirrors the pattern in electron/preload.cjs — the rest of the client reads
// window.BRIMSTONE_SERVER (REST) and window.BRIMSTONE_WS (WebSocket).

if (isNativeMobile && !window.BRIMSTONE_SERVER) {
  const stored = localStorage.getItem('brimstone_server_url');
  const serverUrl = stored || DEFAULT_SERVER;

  window.BRIMSTONE_SERVER = serverUrl;

  try {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    window.BRIMSTONE_WS = url.href.replace(/\/$/, '');
  } catch {
    console.warn('[platform] Invalid server URL for WebSocket derivation:', serverUrl);
  }
}

// ── Splash screen ───────────────────────────────────────────────────────────

async function _hideSplash() {
  try {
    const SplashScreen = window.Capacitor?.Plugins?.SplashScreen;
    if (SplashScreen) await SplashScreen.hide();
  } catch { /* plugin unavailable — ignore */ }
}

if (isNativeMobile) {
  // Hide once the first paint is likely done
  if (document.readyState === 'complete') {
    _hideSplash();
  } else {
    window.addEventListener('load', _hideSplash, { once: true });
  }
}

// ── Android back button ─────────────────────────────────────────────────────

async function _wireBackButton() {
  try {
    const App = window.Capacitor?.Plugins?.App;
    if (!App) return;
    App.addListener('backButton', ({ canGoBack }) => {
      // Close any open overlay / dialog first
      const overlays = [
        'chronicle-overlay', 'inventory-overlay', 'tile-zoom-overlay',
        'action-popup', 'settings-dialog',
      ];
      for (const id of overlays) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('hidden') && el.style.display !== 'none') {
          el.classList.add('hidden');
          return;
        }
      }
      // If on the game screen, ask before exiting
      const setup = document.getElementById('setup-screen');
      if (setup && setup.style.display !== 'none') {
        App.exitApp();
      } else if (!canGoBack) {
        // Prompt (native confirm is fine here)
        if (confirm('Leave the current game?')) App.exitApp();
      }
    });
  } catch { /* plugin unavailable */ }
}

if (isNativeMobile) _wireBackButton();
