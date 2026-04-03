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

const FALLBACK_SERVER = 'https://calebshollow.com';

/** True when running inside a Capacitor native shell. */
export const isNativeMobile = !!window.Capacitor;

// ── Server URL injection ────────────────────────────────────────────────────
// On native mobile, the server URL comes from (in priority order):
//   1. localStorage override (brimstone_server_url)
//   2. build-config.json written by cap-copy-web.js (--env=dev|prod)
//   3. FALLBACK_SERVER constant
//
// Mirrors the pattern in electron/preload.cjs — the rest of the client reads
// window.BRIMSTONE_SERVER (REST) and window.BRIMSTONE_WS (WebSocket).

/** Parsed build-config.json (if available). */
let _buildConfig = null;

function _applyServerUrl(serverUrl) {
  window.BRIMSTONE_SERVER = serverUrl;
  try {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    window.BRIMSTONE_WS = url.href.replace(/\/$/, '');
  } catch {
    console.warn('[platform] Invalid server URL for WebSocket derivation:', serverUrl);
  }
}

async function _initServerUrl() {
  // ── Native mobile (Capacitor) ────────────────────────────────────────────
  if (isNativeMobile && !window.BRIMSTONE_SERVER) {
    const stored = localStorage.getItem('brimstone_server_url');
    let serverUrl = stored;

    if (!serverUrl) {
      try {
        const res = await fetch('./build-config.json');
        if (res.ok) {
          _buildConfig = await res.json();
          serverUrl = _buildConfig.server;
        }
      } catch { /* file missing — use fallback */ }
    }

    _applyServerUrl(serverUrl || FALLBACK_SERVER);
    return;
  }

  // ── Web (browser) — honour localStorage override ─────────────────────────
  if (!isNativeMobile && !window.electronAPI && !window.BRIMSTONE_SERVER) {
    const stored = localStorage.getItem('brimstone_server_url');
    if (stored) _applyServerUrl(stored);
  }
}

// Must resolve before the rest of the app uses BRIMSTONE_SERVER
await _initServerUrl();

/**
 * Synchronous dev-mode check based on local signals (build config, localStorage,
 * Electron). The server-driven signal (`/api/config → devMode`) is handled
 * separately in main.js since it requires a network fetch.
 */
export const isDevMode =
  localStorage.getItem('brimstone_dev_mode') === '1' ||
  _buildConfig?.devMode === true ||
  !!window.electronAPI;

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

// ── Universal Links (iOS magic link sign-in) ────────────────────────────────

async function _wireUniversalLinks() {
  const App = window.Capacitor?.Plugins?.App;
  if (!App) return;

  App.addListener('appUrlOpen', async ({ url }) => {
    try {
      const parsed = new URL(url);

      // Magic link: /auth/verify?token=XXX
      if (parsed.pathname === '/auth/verify' && parsed.searchParams.has('token')) {
        // Hit the verify endpoint — follow the redirect to get the session token
        const server = window.BRIMSTONE_SERVER || '';
        const res = await fetch(`${server}/auth/verify?token=${parsed.searchParams.get('token')}`, {
          redirect: 'manual',
        });
        // The server redirects to /?email_token=SESSION — extract it
        const location = res.headers.get('location') || '';
        const redir = new URL(location, server);
        const emailToken = redir.searchParams.get('email_token');
        if (emailToken) {
          // Dispatch into the existing magic-link auth flow
          window.dispatchEvent(new CustomEvent('magic-link-token', { detail: emailToken }));
        }
        return;
      }

      // Invite link: /invite?code=XXX
      if (parsed.pathname === '/invite' && parsed.searchParams.has('code')) {
        window.location.hash = `#invite=${parsed.searchParams.get('code')}`;
        return;
      }
    } catch (e) {
      console.warn('[platform] Universal link error:', e);
    }
  });
}

if (isNativeMobile) _wireUniversalLinks();

// ── App background/foreground detection ─────────────────────────────────────
// Notifies the server so it can send push notifications to backgrounded players
// instead of assuming an open WebSocket means the player is paying attention.

let _onInactiveChange = null;

/** Register a callback for when the app goes inactive/active. */
export function onInactiveChange(cb) { _onInactiveChange = cb; }

function _fireInactive(inactive) {
  _onInactiveChange?.(inactive);
}

if (isNativeMobile) {
  const App = window.Capacitor?.Plugins?.App;
  if (App) {
    App.addListener('appStateChange', ({ isActive }) => _fireInactive(!isActive));
  }
} else {
  document.addEventListener('visibilitychange', () => _fireInactive(document.hidden));
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
      const Preferences = window.Capacitor?.Plugins?.Preferences;
      const session = JSON.parse(localStorage.getItem('brimstone_session') || 'null');
      if (!session?.token) return;
      const server = window.BRIMSTONE_SERVER || '';

      // If the token changed (e.g. sandbox → production), delete the old one first
      if (Preferences) {
        const { value: prev } = await Preferences.get({ key: 'brimstone_push_token' });
        if (prev && prev !== token) {
          try {
            await fetch(`${server}/api/device-token`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json', 'x-token': session.token },
              body: JSON.stringify({ deviceToken: prev }),
            });
          } catch { /* best effort */ }
        }
        await Preferences.set({ key: 'brimstone_push_token', value: token });
      }

      // Register the current token with the server
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
        window.location.hash = `game=${roomId}`;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
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

// Auto-register on launch if there's already a saved session
if (isNativeMobile && localStorage.getItem('brimstone_session')) {
  registerPushNotifications();
}
