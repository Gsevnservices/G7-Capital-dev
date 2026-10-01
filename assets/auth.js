// ═══════════════════════════════════════════════════════════════
// G7 WORKSPACE — AUTH AND DATA LAYER
// File: assets/auth.js
//
// Load this file BEFORE workspace.js in every workspace page:
//   <script src="../assets/auth.js"></script>
//   <script src="../assets/workspace.js"></script>
//
// This file handles:
//   1. Session management (token stored in localStorage)
//   2. Auth functions (login, logout, validate)
//   3. Data functions (save to KV, load from KV)
//   4. Sync functions (localStorage ↔ Cloudflare KV)
//
// localStorage keys managed here:
//   g7_session_token  — Bearer token from the Cloudflare Worker
//   g7_session_firm   — Firm code for the active session
//   g7_session_name   — Firm display name for the active session
// ═══════════════════════════════════════════════════════════════

'use strict';

// ─────────────────────────────────────────────────────────────
// WORKER BASE URL
// All API calls go through this Cloudflare Worker.
// ─────────────────────────────────────────────────────────────
const G7_WORKER = 'https://g7-proxy.gsevnservices.workers.dev';

/* ═══════════════════════════════════════════
   PASSWORD-CHANGE GUARD
   Runs on every page that loads auth.js. While an account still carries an
   administrator-set password, every page redirects to change-password.html.
   Paths are relative because dev is served from a subpath and prod from the
   domain root — an absolute path works on one and breaks on the other.
   This is a browser-side guard: it protects the user from forgetting, not
   the system from a determined user. The only account it could expose is
   their own.
═══════════════════════════════════════════ */
(function () {
  try {
    if (localStorage.getItem('g7_must_change') !== '1') return;
    if (!localStorage.getItem('g7_session_token')) return;
    var path = window.location.pathname;
    if (/change-password\.html$/.test(path) || /login\.html$/.test(path)) return;
    var nested = /\/(scout|workspace)\//.test(path);
    var here = nested ? path.split('/').slice(-2).join('/') : path.split('/').pop();
    if (!localStorage.getItem('g7_after_change')) {
      localStorage.setItem('g7_after_change', here || 'login.html');
    }
    window.location.replace((nested ? '../' : '') + 'change-password.html');
  } catch (e) {}
})();

/* Resolves a path relative to the site root, working both at the domain
   root (prod) and under a subpath like /G7-Capital-dev/ (dev). */
function g7SiteRoot() {
  var parts = window.location.pathname.split('/');
  /* Drop the filename; if the remaining first segment is a repo folder, keep it */
  parts.pop();
  var base = parts.join('/');
  /* Walk up out of scout/ alex/ workspace/ if we are inside one */
  base = base.replace(/\/(scout|alex|workspace)$/, '');
  return base.endsWith('/') ? base : base + '/';
}


// ═══════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// The session token is stored in localStorage and sent as a
// Bearer token with every authenticated request.
// ═══════════════════════════════════════════════════════════════

// Returns the current session token, or null if not logged in
function getToken() {
  return localStorage.getItem('g7_session_token');
}

// Stores a session token in localStorage
function setToken(token) {
  localStorage.setItem('g7_session_token', token);
}

// Removes all session data from localStorage (used on logout)
function clearToken() {
  localStorage.removeItem('g7_session_token');
  localStorage.removeItem('g7_session_firm');
  localStorage.removeItem('g7_session_name');
}

// Returns all three session fields as an object
function getSession() {
  return {
    token:    localStorage.getItem('g7_session_token'),
    firmCode: localStorage.getItem('g7_session_firm'),
    firmName: localStorage.getItem('g7_session_name')
  };
}


// ═══════════════════════════════════════════════════════════════
// AUTH FUNCTIONS
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// g7Login(firmCode, password)
//
// Calls POST /auth/login on the worker.
// On success: stores token + firm identity in localStorage.
// On failure: throws an error with the worker's error message.
//
// Returns: { token, firmCode, firmName }
// ─────────────────────────────────────────────────────────────
async function g7Login(firmCode, password) {
  const response = await fetch(G7_WORKER + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firmCode, password })
  });

  if (!response.ok) {
    /* The worker returns { error: "..." }. Throwing the raw body put the
       JSON on screen. Parse it, and fall back to a readable sentence for
       anything unexpected. */
    var msg = '';
    try {
      var errJson = await response.json();
      msg = (errJson && errJson.error) || '';
    } catch (e) {}
    if (response.status === 401) {
      msg = 'Wrong firm code or password. Check both and try again.';
    } else if (response.status === 400 && !msg) {
      msg = 'Please enter both your firm code and password.';
    } else if (!msg) {
      msg = 'Could not sign in just now. Please try again in a moment.';
    }
    throw new Error(msg);
  }

  const data = await response.json();

  // Store session identity in localStorage for UI display
  setToken(data.token);
  localStorage.setItem('g7_session_firm', data.firmCode);
  localStorage.setItem('g7_session_name', data.firmName);

  /* Password set by an administrator — the user must choose their own
     before using anything. Set or cleared on every login so a flag from a
     previous firm on this device never lingers. */
  if (data.mustChangePassword) {
    localStorage.setItem('g7_must_change', '1');
  } else {
    localStorage.removeItem('g7_must_change');
  }

  return data;
}


// ─────────────────────────────────────────────────────────────
// g7Logout()
//
// Calls POST /auth/logout to invalidate the token on the server,
// then clears localStorage and redirects to login.html.
// Network errors are silently ignored — local session always clears.
// ─────────────────────────────────────────────────────────────
async function g7Logout() {
  // Confirm before logging out — prevents accidental logouts
  var sessionName = localStorage.getItem('g7_session_name') || 'your workspace';
  if (!confirm('Sign out of ' + sessionName + '?')) return;

  const token = getToken();

  if (token) {
    try {
      await fetch(G7_WORKER + '/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      });
    } catch (e) {
      // Ignore network errors — we still clear the local session
    }
  }

  // Clear session tokens
  clearToken();
  // Clear ALL firm data so the next firm who logs in
  // on this device starts completely fresh
  localStorage.removeItem('g7_firm_config');
  localStorage.removeItem('g7_firm_knowledge_base');
  localStorage.removeItem('g7_deal_history');
  localStorage.removeItem('g7_calibration_log');
  localStorage.removeItem('g7_onboarded');
  localStorage.removeItem('g7_pending_result');
  localStorage.removeItem('g7_view_deal_id');
  localStorage.removeItem('g7_demo_mode');
  localStorage.removeItem('g7_session_name');
  // Redirect to Alex intro page
  window.location.href = g7SiteRoot() + 'alex/index.html';
}


// ─────────────────────────────────────────────────────────────
// g7ValidateSession()
//
// Calls GET /auth/validate to check if the stored token is
// still valid on the server side.
//
// Returns: true if valid, false if not (or no token)
// ─────────────────────────────────────────────────────────────
async function g7ValidateSession() {
  const token = getToken();
  if (!token) return false;

  try {
    const response = await fetch(G7_WORKER + '/auth/validate', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    return response.ok;
  } catch (e) {
    // Network error — treat as invalid to be safe
    return false;
  }
}


// ─────────────────────────────────────────────────────────────
// requireAuth()
//
// Call this at the top of every workspace page's script.
// Validates the session against the worker — if invalid,
// clears localStorage and redirects to login.html.
//
// Returns: true if valid (page can continue loading)
// Note: async — call with await, or the redirect may not fire
//       before the rest of the page script runs.
// ─────────────────────────────────────────────────────────────
async function requireAuth() {
  const valid = await g7ValidateSession();
  if (!valid) {
    clearToken();
    window.location.href = g7SiteRoot() + 'login.html';
    return false;
  }
  return true;
}


// ═══════════════════════════════════════════════════════════════
// DATA FUNCTIONS
// Save and load firm data to/from Cloudflare KV via the worker.
// All reads and writes are scoped to the authenticated firm —
// the worker uses the session token to determine which firm's
// KV namespace to use.
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// g7Save(type, data)
//
// Saves data to KV under the authenticated firm's namespace.
// type must be one of: 'config', 'kb', 'deals', 'calibrations'
//
// Returns: true on success
// Throws:  Error on failure
// ─────────────────────────────────────────────────────────────
async function g7Save(type, data) {
  const token = getToken();

  const response = await fetch(G7_WORKER + '/data/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ type, data })
  });

  if (!response.ok) {
    throw new Error('Save failed: ' + type);
  }

  return true;
}


// ─────────────────────────────────────────────────────────────
// g7Load(type)
//
// Loads data from KV for the authenticated firm.
// type must be one of: 'config', 'kb', 'deals', 'calibrations'
//
// Returns: the stored value, or null if nothing saved yet
// ─────────────────────────────────────────────────────────────
async function g7Load(type) {
  const token = getToken();

  const response = await fetch(G7_WORKER + '/data/load?type=' + type, {
    headers: { 'Authorization': 'Bearer ' + token }
  });

  if (!response.ok) return null;

  const result = await response.json();
  return result.data;
}


// ═══════════════════════════════════════════════════════════════
// SYNC FUNCTIONS
// Keep localStorage (fast, used by all workspace JS) and
// Cloudflare KV (persistent, cross-device) in sync.
//
// localStorage is always the live working copy.
// KV is the durable backup that survives browser clears and
// lets firms log in from different devices.
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// syncToKV()
//
// Pushes all current localStorage data up to KV.
// Called after onboarding and after calibrations.
// Non-fatal — if KV write fails, localStorage is still intact.
// ─────────────────────────────────────────────────────────────
async function syncToKV() {
  const config = localStorage.getItem('g7_firm_config');
  const kb     = localStorage.getItem('g7_firm_knowledge_base');
  const deals  = localStorage.getItem('g7_deal_history');
  const cals   = localStorage.getItem('g7_calibration_log');

  const promises = [];

  if (config) promises.push(g7Save('config', JSON.parse(config)));
  if (kb)     promises.push(g7Save('kb', kb));
  if (deals)  promises.push(g7Save('deals', JSON.parse(deals)));
  if (cals)   promises.push(g7Save('calibrations', JSON.parse(cals)));

  await Promise.all(promises);
}


// ─────────────────────────────────────────────────────────────
// syncFromKV()
//
// Pulls all firm data from KV into localStorage.
// Called after login so the workspace has the latest data
// regardless of which device the firm last used.
//
// Also sets g7_onboarded = 'true' if KV data exists,
// so existing workspace pages that check isOnboarded() work.
// ─────────────────────────────────────────────────────────────
async function syncFromKV() {
  // FIRST: Clear all existing firm data from localStorage.
  // This prevents data from a previously logged-in firm from
  // leaking through if the new firm has no KV data yet.
  localStorage.removeItem('g7_firm_config');
  localStorage.removeItem('g7_firm_knowledge_base');
  localStorage.removeItem('g7_deal_history');
  localStorage.removeItem('g7_calibration_log');
  localStorage.removeItem('g7_onboarded');
  localStorage.removeItem('g7_pending_result');
  localStorage.removeItem('g7_view_deal_id');

  // THEN: Load this firm's data from KV
  const [config, kb, deals, cals] = await Promise.all([
    g7Load('config'),
    g7Load('kb'),
    g7Load('deals'),
    g7Load('calibrations')
  ]);

  if (config) localStorage.setItem('g7_firm_config',         JSON.stringify(config));
  if (kb)     localStorage.setItem('g7_firm_knowledge_base', kb);
  if (deals)  localStorage.setItem('g7_deal_history',        JSON.stringify(deals));
  if (cals)   localStorage.setItem('g7_calibration_log',     JSON.stringify(cals));

  // Only mark as onboarded if they actually have config data in KV.
  // New firms will not have this — they must complete onboarding first.
  if (config) {
    localStorage.setItem('g7_onboarded', 'true');
  }

  // Keep the session firm name in sync with what the firm set during onboarding.
  // The login session gets firmName from the auth record (set by the admin),
  // but the firm's own config firmName is the authoritative display name.
  if (config && config.firmName) {
    localStorage.setItem('g7_session_name', config.firmName);
  }
}
