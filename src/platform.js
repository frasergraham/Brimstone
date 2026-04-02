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

// ── Push notifications ──────────────────────────────────────────────────────

let _pushRegistered = false;

/**
 * Request push notification permission, register with APNS, and send the
 * device token to the server. Call after the player has authenticated.
 */
export async function registerPushNotifications() {
  const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
  if (!PushNotifications || _pushRegistered) return;

  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;

    // Listen for registration success
    PushNotifications.addListener('registration', async ({ value: token }) => {
      // Store locally for unregister on logout
      const Preferences = window.Capacitor?.Plugins?.Preferences;
      if (Preferences) await Preferences.set({ key: 'brimstone_push_token', value: token });

      // Send to server
      const session = JSON.parse(localStorage.getItem('brimstone_session') || 'null');
      if (!session?.token) return;
      const server = window.BRIMSTONE_SERVER || '';
      try {
        await fetch(`${server}/api/device-token`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-token': session.token },
          body: JSON.stringify({ deviceToken: token, platform: 'ios' }),
        });
      } catch { /* offline — will retry next launch */ }
    });

    PushNotifications.addListener('registrationError', (err) => {
      console.warn('[Push] Registration failed:', err);
    });

    // Handle notification tap — deep-link to the game
    PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const roomId = notification?.data?.roomId;
      if (roomId) {
        window.location.hash = `async=${roomId}`;
      }
    });

    await PushNotifications.register();
    _pushRegistered = true;
  } catch (err) {
    console.warn('[Push] Setup error:', err);
  }
}

/**
 * Remove the device token from the server (call on logout).
 */
export async function unregisterPushToken() {
  const Preferences = window.Capacitor?.Plugins?.Preferences;
  if (!Preferences) return;

  try {
    const { value: token } = await Preferences.get({ key: 'brimstone_push_token' });
    if (!token) return;

    const session = JSON.parse(localStorage.getItem('brimstone_session') || 'null');
    if (!session?.token) return;
    const server = window.BRIMSTONE_SERVER || '';
    await fetch(`${server}/api/device-token`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-token': session.token },
      body: JSON.stringify({ deviceToken: token }),
    });

    await Preferences.remove({ key: 'brimstone_push_token' });
  } catch { /* best effort */ }
}
