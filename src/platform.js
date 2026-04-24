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

/** Safe localStorage.getItem — returns null in Node / when localStorage is broken. */
function _lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** True when running inside a Capacitor native shell. */
export const isNativeMobile = typeof window !== 'undefined' && !!window.Capacitor;

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
    const stored = _lsGet('brimstone_server_url');
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

  // ── Electron — ensure preload async IPC has resolved ─────────────────────
  if (window.electronAPI?.getServerUrl && !window.BRIMSTONE_SERVER) {
    try {
      const url = await window.electronAPI.getServerUrl();
      _applyServerUrl(url || FALLBACK_SERVER);
    } catch { /* ignore */ }
  }

  // ── Web (browser) — honour localStorage override ─────────────────────────
  if (!isNativeMobile && !window.electronAPI && !window.BRIMSTONE_SERVER) {
    const stored = _lsGet('brimstone_server_url');
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
  (typeof localStorage !== 'undefined' && _lsGet('brimstone_dev_mode') === '1') ||
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

      // Join link: /join?code=XXX&slot=Y
      if (parsed.pathname === '/join' && parsed.searchParams.has('code')) {
        const code = parsed.searchParams.get('code');
        const slot = parsed.searchParams.get('slot');
        let hash = `#join=${code}`;
        if (slot != null) hash += `&slot=${slot}`;
        window.location.hash = hash;
        return;
      }
    } catch (e) {
      console.warn('[platform] Universal link error:', e);
    }
  });
}

if (isNativeMobile) _wireUniversalLinks();

// ── Game Center authentication ──────────────────────────────────────────────

/** Cached Game Center credentials (or null). */
let _gameCenterCredentials = null;

/**
 * Attempt Game Center authentication via the native plugin.
 * Returns { playerId, displayName, alias } on success, null otherwise.
 * Results are cached — subsequent calls return the cached value without
 * re-triggering the native sign-in UI.
 */
export async function tryGameCenterAuth() {
  if (!isNativeMobile) return null;
  if (_gameCenterCredentials) return _gameCenterCredentials;

  try {
    const GameCenter = window.Capacitor?.Plugins?.GameCenterPlugin;
    if (!GameCenter) return null;
    const result = await GameCenter.authenticate();
    if (result?.playerId) {
      _gameCenterCredentials = result;
      return result;
    }
  } catch (e) {
    console.warn('[platform] Game Center auth failed:', e);
  }
  return null;
}

/**
 * Load the authenticated player's Game Center friends who also have the game.
 * Returns [{ gamePlayerID, displayName, alias }] or [] on failure / non-iOS.
 */
export async function loadGameCenterFriends() {
  if (!isNativeMobile) return [];
  try {
    const GameCenter = window.Capacitor?.Plugins?.GameCenterPlugin;
    if (!GameCenter) return [];
    const result = await GameCenter.loadFriends();
    return result?.friends ?? [];
  } catch (e) {
    console.warn('[platform] Failed to load GC friends:', e);
    return [];
  }
}

/**
 * Open the native iOS share sheet with the given text and URL.
 * Returns true if the share sheet was presented, false otherwise.
 */
export async function shareInvite(text, url) {
  if (!isNativeMobile) return false;
  try {
    const GameCenter = window.Capacitor?.Plugins?.GameCenterPlugin;
    if (!GameCenter?.shareInvite) return false;
    await GameCenter.shareInvite({ text, url });
    return true;
  } catch (e) {
    console.warn('[platform] Share failed:', e);
    return false;
  }
}

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
let _apnsToken = null; // cached APNS device token

/**
 * Request push notification permission, register with APNS, and set up
 * listeners. Call once on launch. The token is cached in _apnsToken and
 * Preferences so refreshPushToken() can re-send it after account changes.
 */
export async function registerPushNotifications() {
  const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
  if (!PushNotifications || _pushRegistered) return;

  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;

    // Listen for registration success — fires once with the APNS token
    PushNotifications.addListener('registration', async ({ value: token }) => {
      _apnsToken = token;
      const Preferences = window.Capacitor?.Plugins?.Preferences;

      // If the token changed (e.g. sandbox → production), delete the old one
      if (Preferences) {
        const { value: prev } = await Preferences.get({ key: 'brimstone_push_token' });
        if (prev && prev !== token) {
          const session = JSON.parse(_lsGet('brimstone_session') || 'null');
          if (session?.token) {
            try {
              await fetch(`${(window.BRIMSTONE_SERVER || '')}/api/device-token`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', 'x-token': session.token },
                body: JSON.stringify({ deviceToken: prev }),
              });
            } catch { /* best effort */ }
          }
        }
        await Preferences.set({ key: 'brimstone_push_token', value: token });
      }

      // Send the token to the server under the current session
      _sendPushToken(token);
    });

    PushNotifications.addListener('registrationError', (err) => {
      console.warn('[Push] Registration failed:', err);
    });

    // Handle notification tap — deep-link to the game or lobby
    PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const joinCode = notification?.data?.joinCode;
      if (joinCode) {
        // Friend invite → join lobby
        window.location.hash = `join=${joinCode}`;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } else {
        const roomId = notification?.data?.roomId;
        if (roomId) {
          window.location.hash = `game=${roomId}`;
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
      }
    });

    await PushNotifications.register();
    _pushRegistered = true;
  } catch (err) {
    console.warn('[Push] Setup error:', err);
  }
}

/** Send the APNS token to the server under the current session. */
async function _sendPushToken(token) {
  if (!token) return;
  const session = JSON.parse(_lsGet('brimstone_session') || 'null');
  if (!session?.token) return;
  const server = window.BRIMSTONE_SERVER || '';
  try {
    await fetch(`${server}/api/device-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-token': session.token },
      body: JSON.stringify({ deviceToken: token, platform: 'ios' }),
    });
  } catch { /* offline — will retry next auth */ }
}

/**
 * Re-send the device token to the server under the current session.
 * Call after every successful auth to ensure the token is linked to the
 * correct player account (e.g. after Game Center login creates a new account).
 * Retries briefly if the APNS token hasn't arrived yet.
 */
export async function refreshPushToken() {
  // Use in-memory cached token first, fall back to Preferences
  let token = _apnsToken;
  if (!token) {
    const Preferences = window.Capacitor?.Plugins?.Preferences;
    if (Preferences) {
      const stored = await Preferences.get({ key: 'brimstone_push_token' });
      token = stored?.value;
    }
  }
  if (token) {
    _sendPushToken(token);
    return;
  }
  // APNS token may not have arrived yet — retry a few times
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (_apnsToken) { _sendPushToken(_apnsToken); return; }
  }
  console.warn('[Push] refreshPushToken: no APNS token available after retries');
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

    const session = JSON.parse(_lsGet('brimstone_session') || 'null');
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
if (isNativeMobile && _lsGet('brimstone_session')) {
  registerPushNotifications();
}
