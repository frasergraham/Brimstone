/**
 * Server selector dropdown — dev-mode only.
 *
 * Shows a small dropdown in the top-right corner of the setup screen that lets
 * developers switch between Railway environments (prod, dev, PR branches) or
 * enter a custom server URL.  The dropdown is populated with:
 *   1. Hardcoded Production + Development entries.
 *   2. Railway branch deployments fetched from /api/environments (if available).
 *   3. A "Custom…" option that reveals a text input.
 *
 * Activation: called from main.js after /api/config resolves.  Shows when the
 * server returns devMode:true, or when local isDevMode is true.
 */

import { isDevMode } from './platform.js';

const KNOWN_SERVERS = [
  { label: 'Production',  url: 'https://brimstone.run' },
  { label: 'Development', url: 'https://brimstone-dev.up.railway.app' },
];

const CUSTOM_VALUE = '__custom__';

/**
 * Initialise the server selector UI.
 * @param {boolean} serverDevMode - devMode flag from the server's /api/config
 */
export function initServerSelector(serverDevMode = false) {
  if (!serverDevMode && !isDevMode) return;

  const setupScreen = document.getElementById('setup-screen');
  if (!setupScreen) return;

  // ── Build DOM ─────────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.id = 'server-selector';

  const label = document.createElement('span');
  label.textContent = 'Server';
  wrap.appendChild(label);

  const select = document.createElement('select');

  // Current server URL (from override or same-origin)
  const currentUrl = localStorage.getItem('brimstone_server_url')
    || window.BRIMSTONE_SERVER
    || '';

  // Populate hardcoded options
  for (const s of KNOWN_SERVERS) {
    const opt = document.createElement('option');
    opt.value = s.url;
    opt.textContent = s.label;
    if (currentUrl === s.url) opt.selected = true;
    select.appendChild(opt);
  }

  // "This server" option for same-origin (when no override is set)
  if (!currentUrl || (!KNOWN_SERVERS.some(s => s.url === currentUrl) && currentUrl === window.BRIMSTONE_SERVER)) {
    const thisOpt = document.createElement('option');
    thisOpt.value = '';
    thisOpt.textContent = '(this server)';
    if (!localStorage.getItem('brimstone_server_url')) thisOpt.selected = true;
    select.insertBefore(thisOpt, select.firstChild);
  }

  // Custom option
  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_VALUE;
  customOpt.textContent = 'Custom\u2026';
  select.appendChild(customOpt);

  // If current URL doesn't match any known server, select "Custom…" and show input
  const isCustomUrl = currentUrl
    && !KNOWN_SERVERS.some(s => s.url === currentUrl)
    && localStorage.getItem('brimstone_server_url');

  // Custom URL input (hidden by default)
  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://…';
  input.style.display = isCustomUrl ? '' : 'none';
  if (isCustomUrl) {
    input.value = currentUrl;
    customOpt.selected = true;
  }

  wrap.appendChild(select);
  wrap.appendChild(input);
  setupScreen.appendChild(wrap);

  // ── Fetch Railway environments ────────────────────────────────────────────
  _fetchEnvironments(select, currentUrl);

  // ── Event handlers ────────────────────────────────────────────────────────
  select.addEventListener('change', () => {
    const val = select.value;
    if (val === CUSTOM_VALUE) {
      input.style.display = '';
      input.focus();
      return;
    }
    input.style.display = 'none';
    _switchServer(val || null); // null = clear override (use same-origin)
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _switchServer(input.value.trim() || null);
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) _switchServer(input.value.trim());
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _switchServer(url) {
  if (url) {
    localStorage.setItem('brimstone_server_url', url);
  } else {
    localStorage.removeItem('brimstone_server_url');
  }

  // Clear session — auth tokens are server-specific
  localStorage.removeItem('brimstone_session');

  // Electron: keep electron-store in sync
  if (window.electronAPI?.setServerUrl) {
    window.electronAPI.setServerUrl(url || '');
  }

  location.reload();
}

async function _fetchEnvironments(select, currentUrl) {
  const server = window.BRIMSTONE_SERVER || '';
  try {
    const res = await fetch(`${server}/api/environments`);
    if (!res.ok) return;
    const envs = await res.json();
    if (!Array.isArray(envs) || envs.length === 0) return;

    // Insert Railway envs before the Custom option
    const customOpt = select.querySelector(`option[value="${CUSTOM_VALUE}"]`);
    for (const env of envs) {
      // Skip if it duplicates a known server
      if (KNOWN_SERVERS.some(s => s.url === env.url)) continue;

      const opt = document.createElement('option');
      opt.value = env.url;
      opt.textContent = env.label;
      if (currentUrl === env.url) opt.selected = true;
      select.insertBefore(opt, customOpt);
    }

    // If current URL now matches a Railway env, deselect Custom
    if (currentUrl && envs.some(e => e.url === currentUrl)) {
      const customInput = select.parentElement?.querySelector('input');
      if (customInput) customInput.style.display = 'none';
    }
  } catch { /* /api/environments not available — no Railway envs shown */ }
}
