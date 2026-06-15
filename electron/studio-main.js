// Caleb's Studio — a standalone macOS desktop wrapper around the admin tools
// (Assets | Lighting | Mission Editor | Combat). Unlike electron/main.js (the
// shipping game client), Studio is a developer tool: it points at a working
// copy of the Brimstone repository and serves its files directly off disk via
// the calebshollow:// protocol, then exposes a filesystem bridge (window.studioAPI,
// see studio-preload.cjs) so the tools can READ assets and WRITE mission JSON
// straight back into the repo — no Node server, no browser download dance.
//
// It is a separate binary from the game (own appId / product name / config
// store) and is built mac-only, signed but not notarized (see
// electron-builder.studio.yml).

import { app, BrowserWindow, ipcMain, protocol, net, dialog, Menu, shell } from 'electron';
import Store from 'electron-store';
import { join, extname, resolve, relative, isAbsolute, sep } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, promises as fs, watch as fsWatch } from 'fs';

// ── Custom scheme (privileged so ES modules load without file:// CORS pain) ──
protocol.registerSchemesAsPrivileged([{
  scheme: 'calebshollow',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

// ── Config store (distinct name so it never collides with the game client) ───
const store = new Store({ name: 'calebs-studio', defaults: { repoRoot: '' } });

// ── MIME map (mirrors electron/main.js) ──────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'video/webm',
};
function mimeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── Repo root ────────────────────────────────────────────────────────────────
// All file serving and the studioAPI bridge are rooted here. A directory is a
// valid Brimstone checkout if it has admin-tools.html and the missions folder.

let repoRoot = '';

function looksLikeRepo(dir) {
  return !!dir
    && existsSync(join(dir, 'admin-tools.html'))
    && existsSync(join(dir, 'src', 'campaign', 'missions'));
}

/** Resolve a repo-relative path to an absolute path, confined inside repoRoot.
 *  Throws on traversal outside the root so the bridge can't read/write arbitrary
 *  files. Accepts "/src/x" and "src/x" and "./src/x" alike. */
function resolveInRepo(rel) {
  if (!repoRoot) throw new Error('No repository selected.');
  let r = String(rel || '').replace(/^calebshollow:\/\/\.?/i, '');
  if (r.startsWith('/')) r = r.slice(1);
  const abs = resolve(repoRoot, r);
  const within = abs === repoRoot || abs.startsWith(repoRoot + sep);
  if (!within) throw new Error(`Path escapes repository: ${rel}`);
  return abs;
}

/** Ask the user to pick a repo folder. Returns the chosen valid root, or '' if
 *  they cancelled. Re-prompts once on an invalid pick. */
async function promptForRepo(parent) {
  for (;;) {
    const { canceled, filePaths } = await dialog.showOpenDialog(parent ?? null, {
      title: 'Select your Brimstone repository',
      message: 'Choose the root folder of a Brimstone checkout (contains admin-tools.html).',
      properties: ['openDirectory'],
      buttonLabel: 'Use This Repository',
    });
    if (canceled || !filePaths?.length) return '';
    const dir = filePaths[0];
    if (looksLikeRepo(dir)) return dir;
    const { response } = await dialog.showMessageBox(parent ?? null, {
      type: 'error',
      title: 'Not a Brimstone repository',
      message: `"${dir}" doesn't look like a Brimstone checkout.`,
      detail: 'Expected to find admin-tools.html and src/campaign/missions/ inside it.',
      buttons: ['Choose Another…', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) return '';
  }
}

/** Establish repoRoot at startup: stored value → cwd (dev) → folder picker. */
async function resolveRepoRoot() {
  const stored = store.get('repoRoot');
  if (looksLikeRepo(stored)) { repoRoot = stored; return; }

  // Running unpackaged from a checkout: default to the cwd / app path so the
  // common `npm run studio:dev` case needs no picking.
  if (!app.isPackaged) {
    for (const cand of [process.cwd(), app.getAppPath()]) {
      if (looksLikeRepo(cand)) { repoRoot = cand; store.set('repoRoot', cand); return; }
    }
  }

  const picked = await promptForRepo();
  if (!picked) { app.quit(); return; }
  repoRoot = picked;
  store.set('repoRoot', picked);
}

// ── Custom protocol: serve repo files as calebshollow://./path ───────────────
function registerProtocol() {
  protocol.handle('calebshollow', async (request) => {
    const url = new URL(request.url);
    let relPath = decodeURIComponent(url.pathname); // "/admin-tools.html" or "/src/x.js"
    if (relPath.startsWith('./')) relPath = relPath.slice(2);
    try {
      const filePath = resolveInRepo(relPath);
      return await net.fetch(pathToFileURL(filePath).href);
    } catch (err) {
      return new Response(`Not found: ${err.message}`, { status: 404 });
    }
  });
}

// ── Window ───────────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "Caleb's Studio",
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(import.meta.dirname, 'studio-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for preload + local fs bridge
    },
  });
  mainWindow.loadURL('calebshollow://./admin-tools.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App menu (native — gives copy/paste + a way to switch repos) ─────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Choose Repository…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const picked = await promptForRepo(mainWindow);
            if (!picked) return;
            repoRoot = picked;
            store.set('repoRoot', picked);
            mainWindow?.reload();
          },
        },
        {
          label: 'Reveal Repository in Finder',
          click: () => { if (repoRoot) shell.openPath(repoRoot); },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC: filesystem bridge (all paths confined to repoRoot) ──────────────────
function setupIPC() {
  ipcMain.handle('studio:get-repo-root', () => repoRoot);

  ipcMain.handle('studio:choose-repo-root', async () => {
    const picked = await promptForRepo(mainWindow);
    if (!picked) return repoRoot;
    repoRoot = picked;
    store.set('repoRoot', picked);
    mainWindow?.reload();
    return repoRoot;
  });

  ipcMain.handle('studio:read-file', async (_e, rel) => {
    try {
      const text = await fs.readFile(resolveInRepo(rel), 'utf8');
      return { ok: true, text };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('studio:write-file', async (_e, rel, text) => {
    try {
      const abs = resolveInRepo(rel);
      await fs.mkdir(join(abs, '..'), { recursive: true });
      await fs.writeFile(abs, String(text), 'utf8');
      return { ok: true, path: relative(repoRoot, abs) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('studio:list-dir', async (_e, rel) => {
    try {
      const entries = await fs.readdir(resolveInRepo(rel), { withFileTypes: true });
      return { ok: true, entries: entries.map(d => ({ name: d.name, dir: d.isDirectory() })) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('studio:exists', (_e, rel) => {
    try { return existsSync(resolveInRepo(rel)); } catch { return false; }
  });
}

// ── Dev live-reload ──────────────────────────────────────────────────────────
// Studio serves the tool files off the live repo checkout, so the window always
// loads the latest code — a plain reload is all it takes to see a JS/CSS/HTML
// edit. In DEV ONLY (unpackaged `npm run studio:dev`), watch the tool source and
// auto-reload on save so iteration is hands-free. Disabled in the packaged app
// (app.isPackaged), and ignores mission-JSON writes + node_modules/.git churn so
// saving a mission from the editor doesn't reload out from under you.
function setupDevWatch() {
  if (app.isPackaged || !repoRoot) return;
  const watchers = [];
  let timer = null;
  const reload = () => { clearTimeout(timer); timer = setTimeout(() => mainWindow?.webContents.reloadIgnoringCache(), 150); };
  const isCode = (f) => /\.(m?js|css|html)$/i.test(f || '');
  const skip = (full) => /[\\/](node_modules|\.git|missions)[\\/]/.test(full);
  const watch = (dir, recursive) => {
    if (!existsSync(dir)) return;
    try {
      watchers.push(fsWatch(dir, { recursive }, (_evt, filename) => {
        if (filename && (!isCode(filename) || skip(join(dir, filename)))) return;
        console.log('[studio] dev reload ←', filename ?? dir);
        reload();
      }));
    } catch (err) { console.warn('[studio] watch failed:', dir, err.message); }
  };
  watch(join(repoRoot, 'src'), true);   // tools + mission-logic + campaign code
  watch(repoRoot, false);               // root admin-tools.html / styles.css / index.html
  app.on('before-quit', () => { for (const w of watchers) { try { w.close(); } catch { /* noop */ } } });
  console.log('[studio] dev live-reload watching src/ + root (edit a tool file → window reloads)');
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await resolveRepoRoot();
  if (!repoRoot) return; // user cancelled the picker → quitting
  registerProtocol();
  setupIPC();
  buildMenu();
  createWindow();
  setupDevWatch();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
