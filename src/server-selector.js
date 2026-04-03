/**
 * Server selector dropdown — dev-mode only.
 *
 * Shows a small dropdown in the top-right corner of the setup screen that lets
 * developers switch between Railway environments (prod, dev, PR branches) or
 * enter a custom server URL.  The dropdown is populated from:
 *   1. /api/environments (Railway branch auto-discovery, if available).
 *   2. A "Custom…" option that reveals a text input.
 *
 * Activation: called from main.js after /api/config resolves.  Shows when the
 * server returns devMode:true, or when local isDevMode is true.
 */

import { isDevMode } from './platform.js';

const CUSTOM_VALUE = '__custom__';
const THIS_SERVER  = '';

/**
 * Initialise the server selector UI.
 * @param {boolean} serverDevMode - devMode flag from the server's /api/config
 */
export function initServerSelector(serverDevMode = false) {
  if (!serverDevMode && !isDevMode) return;

  const setupScreen = document.getElementById('setup-screen');
  if (!setupScreen) return;

  const storedUrl   = localStorage.getItem('brimstone_server_url');
  const isCustomUrl = !!storedUrl; // any stored override means user chose something

  // ── Build DOM ─────────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.id = 'server-selector';

  const label = document.createElement('span');
  label.textContent = 'Server';
  wrap.appendChild(label);

  const select = document.createElement('select');

  // "(this server)" = clear the override, use same-origin / default
  _addOption(select, THIS_SERVER, _thisServerLabel(), !isCustomUrl);

  // Custom option + input
  const customOpt = _addOption(select, CUSTOM_VALUE, 'Custom\u2026', false);

  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://\u2026';
  input.style.display = 'none';

  // If user has a stored override that we don't know about yet, show as custom
  if (isCustomUrl) {
    customOpt.selected = true;
    input.value = storedUrl;
    input.style.display = '';
  }

  wrap.appendChild(select);
  wrap.appendChild(input);
  setupScreen.appendChild(wrap);

  // ── Fetch Railway environments ────────────────────────────────────────────
  _fetchEnvironments(select, input, storedUrl);

  // ── Event handlers ────────────────────────────────────────────────────────
  select.addEventListener('change', () => {
    const val = select.value;
    if (val === CUSTOM_VALUE) {
      input.style.display = '';
      input.focus();
      return;
    }
    input.style.display = 'none';
    _switchServer(val || null); // null/empty = clear override
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _switchServer(input.value.trim() || null);
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) _switchServer(input.value.trim());
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _thisServerLabel() {
  try {
    return location.hostname === 'localhost'
      ? `localhost:${location.port}`
      : location.hostname;
  } catch { return '(this server)'; }
}

function _addOption(select, value, text, selected) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  if (selected) opt.selected = true;
  select.appendChild(opt);
  return opt;
}

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

async function _fetchEnvironments(select, input, storedUrl) {
  const server = window.BRIMSTONE_SERVER || '';
  try {
    const res = await fetch(`${server}/api/environments`);
    if (!res.ok) return;
    const envs = await res.json();
    if (!Array.isArray(envs) || envs.length === 0) return;

    // Insert Railway envs between "(this server)" and "Custom…"
    const customOpt = select.querySelector(`option[value="${CUSTOM_VALUE}"]`);
    let matchedStored = false;

    for (const env of envs) {
      const opt = _addOption(select, env.url, env.label, false);
      select.insertBefore(opt, customOpt);

      // If user's stored URL matches this Railway env, select it
      if (storedUrl && env.url === storedUrl) {
        opt.selected = true;
        input.style.display = 'none';
        matchedStored = true;
      }
    }

    // If the stored URL matched a Railway env, clear the Custom input state
    if (matchedStored) {
      input.value = '';
    }
  } catch { /* /api/environments not available — just this-server + custom */ }
}
