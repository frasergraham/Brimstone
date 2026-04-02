// Preload script — runs in renderer context before the page loads.
// Exposes a minimal electronAPI to the game via contextBridge and injects
// server globals so the existing client code connects to the configured
// remote server for multiplayer.

const { contextBridge, ipcRenderer } = require('electron');

// ── Expose API to renderer ──────────────────────────────────────────────────

contextBridge.exposeInMainWorld('electronAPI', {
  // Server URL config
  getServerUrl:  ()    => ipcRenderer.invoke('get-server-url'),
  setServerUrl:  (url) => ipcRenderer.invoke('set-server-url', url),

  // App version
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Auto-update
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_e, ver) => cb(ver)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, ver) => cb(ver)),
  restartAndUpdate:   ()   => ipcRenderer.send('restart-and-update'),
});

// ── Inject server globals ───────────────────────────────────────────────────
// The game client reads window.BRIMSTONE_SERVER (REST base URL) and
// window.BRIMSTONE_WS (WebSocket URL) — see src/main.js.  We inject these
// before the page scripts run so multiplayer targets the configured server.

async function injectServerConfig() {
  const serverUrl = await ipcRenderer.invoke('get-server-url');
  if (!serverUrl) return; // no server configured — offline only

  // REST base URL: "https://brimstone.up.railway.app"
  window.BRIMSTONE_SERVER = serverUrl;

  // WebSocket URL: derive from HTTP URL
  try {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    window.BRIMSTONE_WS = url.href.replace(/\/$/, '');
  } catch {
    // If the URL is malformed, leave WS unset — client will fall back
    console.warn('Invalid server URL for WebSocket derivation:', serverUrl);
  }
}

// Run before page scripts execute
injectServerConfig();
