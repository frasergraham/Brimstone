// Electron main process for Caleb's Hollow desktop app.
// Serves local game files via a custom protocol and connects to a
// configurable remote server for multiplayer.

import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import electronUpdater   from 'electron-updater';
const { autoUpdater } = electronUpdater;
import Store             from 'electron-store';
import { join, extname } from 'path';
import { pathToFileURL } from 'url';

// ── Register custom scheme as privileged (must happen before app 'ready') ────
protocol.registerSchemesAsPrivileged([{
  scheme: 'calebshollow',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

// ── Config store ─────────────────────────────────────────────────────────────

const SERVERS = {
  dev:  'https://brimstone-dev.up.railway.app',
  prod: 'https://calebshollow.com',
};

// --env=dev overrides the default server URL for this session.
const envArg = process.argv.find(a => a.startsWith('--env='));
const envServer = envArg ? SERVERS[envArg.split('=')[1]] : null;

const store = new Store({
  defaults: {
    serverUrl: 'https://calebshollow.com',
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.webm': 'video/webm',
};

function mimeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** Resolve the root directory where game files live. */
function gameRoot() {
  // In a packaged app, app.getAppPath() points inside the .asar archive.
  // During development it points to the repo root.
  return app.getAppPath();
}

// ── Custom protocol ──────────────────────────────────────────────────────────
// Serves local files as `calebshollow://./path` so ES modules load without CORS
// issues that would occur with file:// URLs.

function registerProtocol() {
  protocol.handle('calebshollow', (request) => {
    // Strip scheme: "calebshollow://./index.html" → "./index.html"
    const url = new URL(request.url);
    // pathname comes as "/./index.html" or "/src/main.js"
    let relative = decodeURIComponent(url.pathname);
    // Remove leading slash on Windows
    if (process.platform === 'win32' && relative.startsWith('/')) {
      relative = relative.slice(1);
    }
    // Remove leading "./" if present
    if (relative.startsWith('./')) relative = relative.slice(2);

    const filePath = join(gameRoot(), relative);
    return net.fetch(pathToFileURL(filePath).href);
  });
}

// ── Window ───────────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Caleb's Hollow",
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,  // needed for preload ESM
    },
  });

  mainWindow.loadURL('calebshollow://./index.html');

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

function setupIPC() {
  ipcMain.handle('get-server-url', () => envServer || store.get('serverUrl'));

  ipcMain.handle('set-server-url', (_event, url) => {
    store.set('serverUrl', url || '');
  });

  ipcMain.handle('get-version', () => app.getVersion());

  ipcMain.on('restart-and-update', () => {
    autoUpdater.quitAndInstall();
  });
}

// ── Auto-updater ─────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update-downloaded', info.version);
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err.message);
  });

  // Check once on startup, then periodically
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000); // every 4 hours
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerProtocol();
  setupIPC();
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    // macOS: re-create window when dock icon clicked and no windows open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On macOS, apps typically stay active until Cmd+Q
  if (process.platform !== 'darwin') app.quit();
});
