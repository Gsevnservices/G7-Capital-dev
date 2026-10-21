// ─────────────────────────────────────────────────────────────────────────────
// G7 Capital — Cloudflare Worker
// Multi-user auth + per-firm KV storage + Anthropic API proxy
//
// KV namespace: G7_WORKSPACE → bound as G7_KV
//
// Environment variables required:
//   ANTHROPIC_API_KEY  — Anthropic API key (set in Cloudflare dashboard)
//   ADMIN_PASSWORD     — Password for /admin/* routes (set in Cloudflare dashboard)
//
// KV key schema:
//   auth:users:{FIRMCODE}                        → { firmName, passwordHash, createdAt, tier, plan }
//   auth:sessions:{token}                        → { firmCode, firmName, createdAt, expiresAt }
//   firms:{FIRMCODE}:config                      → firm configuration object
//   firms:{FIRMCODE}:kb                          → firm knowledge base text
//   firms:{FIRMCODE}:deals                       → array of screened deals
//   firms:{FIRMCODE}:calibrations                → array of partner corrections
//   places:cache:{queryHash}                     → cached Google Places results (30-day TTL)
//   scout:limit:{FIRMCODE}:places                → free lifetime places counter (string int)
//   scout:limit:{FIRMCODE}:places:{YYYY-MM}      → paid monthly places counter (string int)
//   scout:inbound:link:{CODE}                    → { firmCode, source, waNumber, message, createdAt }
//   scout:inbound:{FIRMCODE}:links               → { bio: CODE, google: CODE, status: CODE }
//   scout:inbound:{FIRMCODE}:{SOURCE}:clicks     → click count (string int); SOURCE ∈ bio|google|status
//
// Route map:
//   POST /api/message            — Anthropic proxy (session-protected)
//   POST /auth/login             — Login with firmCode + password
//   POST /auth/logout            — Invalidate session token
//   GET  /auth/validate          — Check if session token is still valid
//   POST /data/save              — Save firm data to KV (session-protected)
//   GET  /data/load              — Load firm data from KV (session-protected)
//   POST /admin/create-firm      — Create a new firm account (admin-protected)
//   GET  /admin/list-firms       — List all firm accounts (admin-protected)
//   POST /admin/reset-password   — Reset a firm's password (admin-protected)
//   GET  /admin/firm-usage       — Get deal usage count for a firm (admin-protected)
//   POST /admin/reset-usage      — Reset deal usage counter for a firm (admin-protected)
//   POST /email/send-founder-questions — Send Alex questions to founder via email
//   GET  /places/search              — Google Places proxy (session-protected, cached)
//   POST /inbound/create             — Create inbound short links bio/google/status (session-protected, idempotent)
//   GET  /inbound/stats              — Get link codes + click counts (session-protected)
//   GET  /i/{CODE}                   — Public inbound redirect: logs click, 302 → wa.me (no CORS applied)
//
// Health check:
//   GET /                        → { status: 'G7 Proxy is running' }
//
// REQUIRED DNS RECORDS (gsevnservices.com) — needed for Mailchannels email delivery:
//   TXT @               : v=spf1 include:_spf.google.com include:relay.mailchannels.net ~all
//   TXT _mailchannels   : v=mc1 cfid=gsevnservices.workers.dev
// Without these records Mailchannels will reject sends (domain lockdown enforcement).
// ─────────────────────────────────────────────────────────────────────────────

// The Anthropic endpoint this worker proxies to
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// ─────────────────────────────────────────────────────────────────────────────
// TRUSTED NEWS DOMAINS — used by the business news search (searchBusinessNews).
// Edit this list when adding or removing sources.
// Shared-news categories (NEWS_CATS) keep their own domain lists.
// ─────────────────────────────────────────────────────────────────────────────
const TRUSTED_NEWS_DOMAINS = [
  'economictimes.indiatimes.com','livemint.com','business-standard.com',
  'thehindubusinessline.com','financialexpress.com','moneycontrol.com',
  'ndtvprofit.com','timesofindia.indiatimes.com','hindustantimes.com',
  'indianexpress.com','thehindu.com','deccanherald.com',
  'amarujala.com','jagran.com','bhaskar.com','livehindustan.com',
  'pib.gov.in','rbi.org.in','constructionworld.in',
  'realty.economictimes.indiatimes.com'
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: CORS HEADERS
// All responses must include these so GitHub Pages (a different origin)
// can read the response. The wildcard '*' is safe here because every
// sensitive route is protected by session token or admin password.
// ─────────────────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: JSON RESPONSE
// Wraps a JSON body with status code and CORS headers.
// ─────────────────────────────────────────────────────────────────────────────
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: PER-CALL COST ACCUMULATOR
// Reset before each firm in the cron loop; each API call records its usage.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// COST TABLE & PER-REQUEST ACCUMULATOR
// Prices per million tokens (USD).
// ⚠️  CHECK THESE against https://docs.anthropic.com/en/docs/about-claude/pricing
//     whenever Anthropic updates their pricing page.
// web_search is per-search-request ($0.01 each).
// ─────────────────────────────────────────────────────────────────────────────
const COST_TABLE = {
  'claude-sonnet-5-5':          { input: 2.00, output: 10.00, search: 0.01 },
  'claude-haiku-5-5':           { input: 0.10, output:  0.50, search: 0.01 },
  'claude-haiku-4-5-20251001':  { input: 1.00, output:  5.00, search: 0.01 }
};

/* Factory for a per-request cost accumulator. Create one at the start of
   each request or cron firm-run; pass it explicitly through every function
   that calls Anthropic; flush it once at the end. */
function newCostAccum() {
  return { calls: 0, usd: 0, web_search_requests: 0, input_tokens: 0, output_tokens: 0 };
}

/* Record one Anthropic call's usage into the given accumulator. */
function recordCost(cost, model, data) {
  if (!data || !cost) return;
  cost.calls++;
  var u = data.usage || {};
  var inp = u.input_tokens || 0;
  var out = u.output_tokens || 0;
  var srch = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  cost.input_tokens += inp;
  cost.output_tokens += out;
  cost.web_search_requests += srch;
  var t = COST_TABLE[model] || COST_TABLE['claude-sonnet-5-5'];
  cost.usd += (inp / 1e6) * t.input + (out / 1e6) * t.output + srch * t.search;
}

/* Flush accumulated cost to KV. firmCode = the firm that triggered the
   request, or "SHARED" for shared-news generation. Returns total USD added. */
async function flushCost(env, day, firmCode, cost) {
  if (!cost || cost.usd <= 0) return 0;
  var amt = cost.usd;
  var firmKey = 'cost:' + day + ':' + firmCode;
  var totalKey = 'cost:' + day + ':total';
  var prev = parseFloat(await env.G7_KV.get(firmKey) || '0');
  var prevTotal = parseFloat(await env.G7_KV.get(totalKey) || '0');
  await Promise.all([
    kvPut(env, firmKey, String(prev + amt), { expirationTtl: 259200 }),
    kvPut(env, totalKey, String(prevTotal + amt), { expirationTtl: 259200 })
  ]);
  return amt;
}

/* ── Per-feature daily limits (IST day) ──
   KV key: feat:{day}:{firmCode}:{feature}  (string int, 24h TTL)
   Returns { ok, used, limit, feature } */
var FEAT_LIMITS = {
  ask:      { paid: 10, free: 3 },   /* Ask Scout = /scout/briefing */
  finder:   { paid: 5,  free: 2 },
  /* news + move are once-a-day via cron/cache — no counter needed.
     analyse + checkin keep their existing monthly gates. */
};
async function featureGate(env, day, firmCode, feature) {
  var def = FEAT_LIMITS[feature];
  if (!def) return { ok: true, used: 0, limit: 999, feature: feature };
  var user = await env.G7_KV.get('auth:users:' + firmCode, 'json');
  var plan = (user && user.plan) ? user.plan : 'free';
  var limit = def[plan] || def.free;
  var key = 'feat:' + day + ':' + firmCode + ':' + feature;
  var used = parseInt(await env.G7_KV.get(key) || '0', 10);
  if (used >= limit) return { ok: false, used: used, limit: limit, feature: feature };
  return { ok: true, used: used, limit: limit, feature: feature, counterKey: key };
}
async function featureIncrement(env, gate) {
  if (gate && gate.counterKey) {
    await kvPut(env, gate.counterKey, String((gate.used || 0) + 1), { expirationTtl: 86400 });
  }
}

/* Firm money backstop — only firm-level, no global day cap.
   Analysis is exempt (opts.exemptFirm). */
async function budgetCheck(env, day, firmCode, opts) {
  if (opts && opts.exemptFirm) return { ok: true, firmSpent: 0 };
  var user = await env.G7_KV.get('auth:users:' + firmCode, 'json');
  var plan = (user && user.plan) ? user.plan : 'free';
  var firmCap = plan === 'free'
    ? parseFloat(env.COST_CAP_FIRM_FREE || '0.20')
    : parseFloat(env.COST_CAP_FIRM || '0.50');
  var firmSpent = parseFloat(await env.G7_KV.get('cost:' + day + ':' + firmCode) || '0');
  if (firmSpent >= firmCap) {
    return { ok: false, reason: 'firm', firmSpent: firmSpent, cap: firmCap };
  }
  return { ok: true, firmSpent: firmSpent, cap: firmCap };
}

/* Shared-news cost cap — checked before generating shared categories in cron. */
async function sharedBudgetCheck(env, day) {
  var cap = parseFloat(env.COST_CAP_SHARED || '0.30');
  var spent = parseFloat(await env.G7_KV.get('cost:' + day + ':SHARED') || '0');
  if (spent >= cap) return { ok: false, spent: spent, cap: cap };
  return { ok: true, spent: spent };
}

/* Send budget/limit email — ONE per firm per IST day.
   capType is the firm code or "SHARED". */
async function sendBudgetEmail(env, day, firmCode, spent, cap) {
  var alertKey = 'cost:alert:' + day + ':' + firmCode;
  if (await env.G7_KV.get(alertKey)) return;
  await kvPut(env, alertKey, '1', { expirationTtl: 172800 });
  var subj = 'Scout daily budget reached (' + firmCode + ': $' + spent.toFixed(4) + ' of $' + cap.toFixed(2) + ')';
  var text = subj + '.\n\nGeneration paused until midnight IST.\n' +
    'Day: ' + day + '\nFirm: ' + firmCode + '\nSpent: $' + spent.toFixed(4) + '\nCap: $' + cap.toFixed(2);
  try { await sendEmail(env, (env.ADMIN_EMAIL || 'contact@gsevnservices.in'), subj, text, '<p>' + text.replace(/\n/g, '<br>') + '</p>'); } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: HASH PASSWORD
// SHA-256 hashes a plain-text password and returns a hex string.
// Used during firm creation and login verification.
// ─────────────────────────────────────────────────────────────────────────────
/* Password hashing — PBKDF2-SHA256, 100k iterations, 16-byte random salt.
   Stored as "pbkdf2$<iterations>$<saltHex>$<hashHex>".
   Single-round SHA-256 was used previously and is effectively reversible;
   verifyPassword below still accepts those hashes so existing accounts
   keep working, and upgrades them on next successful login. */
const PBKDF2_ITERATIONS = 100000;

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key, 256
  );
  const toHex = function(buf) {
    return Array.from(new Uint8Array(buf)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  };
  return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + toHex(salt) + '$' + toHex(bits);
}

/* Legacy SHA-256, kept only so old hashes can still be verified. */
async function legacyHash(password) {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
}

/* Returns { ok, needsUpgrade }. needsUpgrade is true when the stored hash
   was the old format and should be rewritten after a successful login. */
async function verifyPassword(password, stored) {
  if (!stored) return { ok: false, needsUpgrade: false };
  if (stored.indexOf('pbkdf2$') !== 0) {
    const legacy = await legacyHash(password);
    return { ok: legacy === stored, needsUpgrade: legacy === stored };
  }
  const parts = stored.split('$');
  if (parts.length !== 4) return { ok: false, needsUpgrade: false };
  const iterations = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(function(h){ return parseInt(h, 16); }));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
    key, 256
  );
  const hex = Array.from(new Uint8Array(bits)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  /* Constant-time comparison — a plain === leaks timing information. */
  if (hex.length !== parts[3].length) return { ok: false, needsUpgrade: false };
  var diff = 0;
  for (var i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts[3].charCodeAt(i);
  return { ok: diff === 0, needsUpgrade: false };
}

/* Sends an email through Resend. Returns true on success. Never throws —
   a failed send must not change the response the caller sees. */
async function sendEmail(env, to, subject, text, html, headers) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const payload = {
      from: 'G7 Capital <no-reply@mail.gsevnservices.in>',
      to: [to],
      subject: subject,
      text: text,
      html: html
    };
    if (headers) payload.headers = headers;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    return r.ok;
  } catch (e) { return false; }
}

/* ── ANALYSIS FAILURE RECORDER ──
   Saves a failure record to KV list (max 20, 30-day TTL), sends one
   alert email per firm per day. Never throws — fire-and-forget only. */
async function recordAnalysisFailure(env, record) {
  try {
    /* Append to KV list — prepend newest, keep last 20 */
    var list = await env.G7_KV.get('scout:analysis-failures', 'json') || [];
    list.unshift(record);
    if (list.length > 20) list = list.slice(0, 20);
    await kvPut(env, 'scout:analysis-failures', JSON.stringify(list),
      { expirationTtl: 30 * 86400 });

    /* Rate-limit email: one per firm per calendar day */
    var today = new Date().toISOString().slice(0, 10);
    var dedupKey = 'scout:fail-alert:' + record.firm + ':' + today;
    var already = await env.G7_KV.get(dedupKey);
    if (already || !env.ADMIN_EMAIL) return;

    await kvPut(env, dedupKey, '1', { expirationTtl: 86400 });

    var stageLabel = record.stage === 'incomplete' ? 'Stream incomplete (truncated or dropped)' :
                     record.stage === 'parse'      ? 'JSON parse failed on result page' :
                     record.stage === 'render'     ? 'Section render errors on result page' :
                     record.stage || 'unknown';
    var body = [
      'Firm: ' + record.firm,
      'Business: ' + (record.businessName || '—'),
      'Type: ' + (record.businessType || '—'),
      'City: ' + (record.city || '—'),
      'Stage: ' + stageLabel,
      'Stop reason: ' + (record.stopReason || '—'),
      record.output_tokens ? 'Output tokens: ' + record.output_tokens : null,
      record.chars ? 'Characters received: ' + record.chars : null,
      record.parseError ? 'Parse error: ' + record.parseError : null,
      record.failedSections && record.failedSections.length ? 'Failed sections: ' + record.failedSections.join(', ') : null,
      'Time (IST): ' + record.time,
      '',
      'What to do: Ask the owner to tap "Re-run my analysis" on the result page, or reset their usage counter in the admin panel and have them re-submit.'
    ].filter(Boolean).join('\n');

    await sendEmail(env, env.ADMIN_EMAIL,
      'Scout analysis failed — ' + record.firm,
      body,
      '<pre style="font-family:monospace;font-size:13px">' + body.replace(/</g, '&lt;') + '</pre>'
    );
  } catch (e) {
    console.error('recordAnalysisFailure error:', e && e.message);
  }
}

/* ── KV PUT HELPER ──
   Wraps every KV write. On 429 / limit errors, sends one admin alert
   per UTC day via Resend (in-memory flag — no KV dependency).
   Accepts possible duplicate across isolate restarts. */
var _kvAlertSentDate = null;

async function kvPut(env, key, value, opts) {
  try {
    await env.G7_KV.put(key, value, opts || undefined);
  } catch (e) {
    var msg = String((e && e.message) || e);
    if (/429|limit|exceeded|quota/i.test(msg)) {
      var utcDay = new Date().toISOString().slice(0, 10);
      if (_kvAlertSentDate !== utcDay && env.ADMIN_EMAIL) {
        _kvAlertSentDate = utcDay;
        sendEmail(env, env.ADMIN_EMAIL,
          'Cloudflare KV daily write limit hit',
          'Cloudflare KV daily write limit hit — logins and saves are failing until 00:00 UTC. Upgrade to Workers Paid to restore immediately.',
          '<p>Cloudflare KV daily write limit hit &mdash; logins and saves are failing until 00:00 UTC.</p><p>Upgrade to Workers Paid to restore immediately.</p>'
        ).catch(function() {});
      }
    }
    throw e;
  }
}

/* Returns true when an error is a confirmed credit/billing problem (not
   transient overload). Only these trigger the admin alert email. */
function isBillingError(e) {
  var msg = String((e && e.message) || e);
  return /anthropic 403|credit balance|billing|insufficient/i.test(msg);
}

/* Send one admin alert per IST day when Anthropic credits are exhausted.
   Uses KV flag alert:credit:{day} so it fires at most once. Reads
   env.ADMIN_EMAIL — if not set, logs a warning and skips. */
async function sendCreditAlert(env, day) {
  if (!env.ADMIN_EMAIL) { console.log(JSON.stringify({ creditAlert: 'skipped', reason: 'ADMIN_EMAIL not set' })); return; }
  var flagKey = 'alert:credit:' + day;
  if (await env.G7_KV.get(flagKey)) return;
  await kvPut(env,flagKey, '1', { expirationTtl: 172800 });
  await sendEmail(env, env.ADMIN_EMAIL,
    'Anthropic credit exhausted — Scout running on fallback',
    'Scout couldn\'t generate today\'s news (' + day + '): Anthropic returned a billing/credit error.\n\nFirms with recent news are seeing it with a \'From ' + day + '\' note; firms without see \'No news yet\'. Top up to resume.',
    '<p>Scout couldn\'t generate today\'s news (' + day + '): Anthropic returned a billing/credit error.</p><p>Firms with recent news are seeing it with a \u201cFrom ' + day + '\u201d note; firms without see \u201cNo news yet\u201d. Top up to resume.</p>');
}

/* Try market:last:{firm}, then yesterday's and day-before's daily cache.
   Returns the best available result or null. */
async function lastMarketBrief(env, firmCode, today) {
  var last = await env.G7_KV.get('market:last:' + firmCode, 'json');
  if (last && last.items && last.items.length) return last;
  for (var d = 1; d <= 2; d++) {
    var prev = new Date(new Date(today + 'T12:00:00+05:30').getTime() - d * 86400000).toISOString().slice(0, 10);
    var old = await env.G7_KV.get('market:' + firmCode + ':' + prev, 'json');
    if (old && old.items && old.items.length) return old;
  }
  return null;
}

/* Try news:last:{cat}, then yesterday's and day-before's daily cache.
   Returns the best available result or null. */
async function lastSharedNews(env, cat, citySlug) {
  var lastKey = 'news:last:' + cat + (cat === 'city' ? ':' + citySlug : '');
  var last = await env.G7_KV.get(lastKey, 'json');
  if (last && last.items && last.items.length) return last;
  var ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  var today = ist.toISOString().slice(0, 10);
  for (var d = 1; d <= 2; d++) {
    var prev = new Date(new Date(today + 'T12:00:00+05:30').getTime() - d * 86400000).toISOString().slice(0, 10);
    var cacheKey = 'news:' + cat + (cat === 'city' ? ':' + citySlug : '') + ':' + prev;
    var old = await env.G7_KV.get(cacheKey, 'json');
    if (old && old.items && old.items.length) return old;
  }
  return null;
}

/* Where reset links may point. Built from the request's Origin, but only
   ever one of these — never a caller-supplied host, which would let an
   attacker email a user a link to a site they control. */
function resetBaseUrl(request) {
  const origin = request.headers.get('Origin') || '';
  if (origin === 'https://gsevnservices.github.io') {
    return 'https://gsevnservices.github.io/G7-Capital-dev';
  }
  return 'https://gsevnservices.in';
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: GENERATE INBOUND LINK CODE
// Produces a 6-character lowercase base36 code (0-9, a-z).
// Uses crypto.getRandomValues for unpredictability — not sequential, not the
// firm code. Gives ~2.2 billion possible values; collision is astronomically rare.
// ─────────────────────────────────────────────────────────────────────────────
function genInboundCode() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += chars[b % 36];
  return code;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: VALIDATE SESSION
// Reads the Authorization: Bearer {token} header, looks up the session
// in KV, checks expiry, and returns the session object if valid.
// Returns null if the token is missing, invalid, or expired.
// ─────────────────────────────────────────────────────────────────────────────
async function validateSession(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7); // strip 'Bearer '
  const session = await env.G7_KV.get('auth:sessions:' + token, 'json');
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    // Token has expired — clean it up and reject
    await env.G7_KV.delete('auth:sessions:' + token);
    return null;
  }
  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS — used by generateMarketBrief and generateSharedNews.
// ─────────────────────────────────────────────────────────────────────────────

/* Sentence-boundary trimmer for prose fields. */
function clip(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  var cut = s.slice(0, n);
  var stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > n * 0.5) return cut.slice(0, stop + 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:\s—-]+$/, '') + '\u2026';
}

/* Strip citation markup that leaks from web_search into model text:
   <cite ...>, </cite>, (cite index=...>, index="N-N" fragments. */
var _citeRe = /<\/?cite[^>]*>|\(cite\s+index=[^>]*>|index="\d+(?:-\d+)?"/gi;
function stripCite(s) {
  if (!s) return s;
  return String(s).replace(_citeRe, '').replace(/\s{2,}/g, ' ').trim();
}

/* Clean all text fields in a news item object. */
function cleanNewsItem(it) {
  if (!it) return it;
  if (it.headline) it.headline = stripCite(it.headline);
  if (it.whatHappened) it.whatHappened = stripCite(it.whatHappened);
  if (it.whyItMatters) it.whyItMatters = stripCite(it.whyItMatters);
  if (it.whatToDo) it.whatToDo = stripCite(it.whatToDo);
  if (it.why) it.why = stripCite(it.why);
  return it;
}

/* Clip to the first sentence, max ~200 chars.
   A sentence ends at . ! or ? followed by a space+uppercase/quote or end of string.
   Never split inside numbers (22,888.95) or abbreviations (U.S., Rs., Mr., etc.). */
var _abbrRe = /^(?:U\.S|Rs|Mr|Mrs|Ms|Dr|No|vs|e\.g|i\.e|Jr|Sr|St|Ltd|Inc|govt|approx|dept|est|Feb|Jan|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i;
function clipOneSentence(s) {
  s = String(s || '').trim();
  /* Walk the string looking for . ! ? that genuinely end a sentence. */
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    /* End of string — this terminates the sentence. */
    if (i === s.length - 1) return s.length <= 200 ? s : clip(s, 200);
    var after = s[i + 1] || '';
    /* Must be followed by space then uppercase or quote to be a sentence end. */
    if (after !== ' ') continue;
    var afterSpace = s[i + 2] || '';
    if (!/[A-Z"'\u201C\u2018]/.test(afterSpace)) continue;
    /* Check if the period is inside a number: digit before and digit after the dot. */
    if (ch === '.' && i > 0 && /\d/.test(s[i - 1]) && /\d/.test(afterSpace)) continue;
    /* Check if the period follows a common abbreviation. */
    if (ch === '.') {
      var wordStart = i - 1;
      while (wordStart > 0 && /[A-Za-z.]/.test(s[wordStart - 1])) wordStart--;
      var word = s.slice(wordStart, i);
      if (_abbrRe.test(word)) continue;
    }
    /* Found a real sentence boundary. */
    var sent = s.slice(0, i + 1).trim();
    return sent.length <= 200 ? sent : clip(sent, 200);
  }
  /* No sentence boundary found — return whole string, capped. */
  return s.length <= 200 ? s : clip(s, 200);
}

/* Evergreen/guide gate: drop titles that are guides, explainers, rate tables,
   checklists etc. — unless page_age is within 3 days (the guide was just published
   and may contain new info). Returns { pass:bool, reason?:string }. */
var _evergreenRe = /\bguide\b|\bhow to\b|\bexplained\b|\bwhat is\b|\beverything you need\b|\bchecklist\b|\brates list\b/i;
function evergreenCheck(title, pageAge) {
  if (!_evergreenRe.test(title || '')) return { pass: true };
  /* Allow very recently published guides — they may contain new info. */
  var age = checkPageAge(pageAge, 3);
  if (age.dated && age.recent) return { pass: true };
  return { pass: false, reason: 'evergreen/guide title: ' + String(title).slice(0, 100) };
}

/* A home page, section page or listing page cannot be the source of a
   specific fact — only an article can. */
function isHomePage(u) {
  try {
    var url = new URL(u);
    var p = url.pathname.replace(/\/+$/, '');
    if (p === '' || /^\/(index|home|default)(\.[a-z]+)?$/i.test(p)) return true;
    if (/allrelease|archive|latest-news|\/tag\/|\/topic\/|\/category\//i.test(p)) return true;
    var segs = p.split('/').filter(Boolean);
    var last = segs[segs.length - 1] || '';
    /* Any query parameter that looks like an article id means this is content,
       not a section page. Broad match: ?id=, ?p=, ?story=, ?prid=, etc. */
    var hasId = /[?&](p|prid|id|nid|sid|storyid|newsid|articleid|story|postid)=/i.test(url.search);
    if (hasId) return false;
    /* One short word with no digits ("/economy", "/markets") is a section
       page — but only when there's no query string at all. */
    if (segs.length === 1 && last.length < 20 && !/\d/.test(last) && !url.search) return true;
    return false;
  } catch (e) { return true; }
}

/* Listing/quote/portal gate: drop URLs from classified portals, quote/ticker
   pages, and similar non-article pages. Allow only when path is clearly an
   article (/news/, /article/, or a dated slug like /2025/ or /2026-04-...). */
var _portalDomainSet = new Set([
  'magicbricks.com','99acres.com','housing.com','nobroker.in','commonfloor.com',
  'makaan.com','squareyards.com','justdial.com','indiamart.com','sulekha.com'
]);
var _quotePathRe = /\/(quote|quotes|stocks|markets\/data)(\/|$)/i;
var _articlePathRe = /\/(news|article|story|stories)\//i;
var _datedSlugRe = /\/20\d{2}[\/-]/;
function _registrableDomain(hostname) {
  /* Strip subdomains: "www.housing.com" → "housing.com", "m.justdial.com" → "justdial.com".
     Handles two-part TLDs like .co.in by checking if the set contains the result. */
  var parts = hostname.toLowerCase().split('.');
  for (var i = 0; i < parts.length - 1; i++) {
    var candidate = parts.slice(i).join('.');
    if (_portalDomainSet.has(candidate)) return candidate;
  }
  return parts.slice(-2).join('.');
}
function isListingOrQuote(u) {
  try {
    var url = new URL(u);
    if (_portalDomainSet.has(_registrableDomain(url.hostname))) {
      /* Allow if the path is clearly an article. */
      if (_articlePathRe.test(url.pathname) || _datedSlugRe.test(url.pathname)) return false;
      return true;
    }
    if (_quotePathRe.test(url.pathname)) return true;
    return false;
  } catch (e) { return false; }
}

/* Recency gate from page_age string (e.g. "3 days ago", "2 weeks ago",
   "5 hours ago", "2025-10-12"). Returns { recent: bool, dated: bool }. */
function checkPageAge(pageAge, maxDays) {
  if (!pageAge) return { recent: true, dated: false }; /* undated — keep */
  var s = String(pageAge).toLowerCase().trim();
  /* Try ISO date first. */
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    var age = (Date.now() + 5.5 * 3600 * 1000) - d.getTime();
    return { recent: age >= 0 && age <= maxDays * 86400 * 1000, dated: true };
  }
  /* Parse relative: "X unit(s) ago" */
  var m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/);
  if (!m) return { recent: true, dated: false }; /* unparseable — keep */
  var n = parseInt(m[1], 10);
  var unit = m[2];
  var days = 0;
  if (unit === 'second' || unit === 'minute' || unit === 'hour') days = n < 24 ? 0 : 1;
  else if (unit === 'day') days = n;
  else if (unit === 'week') days = n * 7;
  else if (unit === 'month') days = n * 30;
  else if (unit === 'year') days = n * 365;
  return { recent: days <= maxDays, dated: true };
}

/* Same-topic dedupe: if two items share ≥3 meaningful headline words,
   keep the one with longer whatHappened (proxy for clarity/detail). */
function dedupeItems(items) {
  var dominated = new Set();
  for (var i = 0; i < items.length; i++) {
    if (dominated.has(i)) continue;
    var wordsI = String(items[i].headline || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/)
      .filter(function(w) { return w.length > 1 && !_stopWords.has(w); });
    for (var j = i + 1; j < items.length; j++) {
      if (dominated.has(j)) continue;
      var wordsJ = String(items[j].headline || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/)
        .filter(function(w) { return w.length > 1 && !_stopWords.has(w); });
      var setJ = new Set(wordsJ);
      var shared = wordsI.filter(function(w) { return setJ.has(w); }).length;
      if (shared >= 3) {
        var lenI = (items[i].whatHappened || '').length;
        var lenJ = (items[j].whatHappened || '').length;
        dominated.add(lenI >= lenJ ? j : i);
      }
    }
  }
  return items.filter(function(_, idx) { return !dominated.has(idx); });
}

// ─────────────────────────────────────────────────────────────────────────────
// WATCHLIST + TWO-STEP BUSINESS NEWS
// ─────────────────────────────────────────────────────────────────────────────

/* Fast non-crypto hash for change detection. */
function shortHash(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) & 0xffffffff;
  }
  return (h >>> 0).toString(36);
}

/* Extract the stable lines from the context that drive watchlist content.
   The context string (built by scoutContext in index.html) contains:
     BUSINESS: name | type | location   ← stable
     SELLS: what they sell              ← stable
     TYPICAL SALE: avg transaction      ← semi-stable, not relevant
     REVENUE MODEL: ...                 ← semi-stable
     CURRENT CUSTOMERS: count           ← changes at check-in
     12-MONTH TARGET: ...               ← changes at check-in
     BEST EXISTING CUSTOMERS: ...       ← stable
     BEST MONTHS / WORST MONTHS         ← stable
     LOCAL EVENTS: ...                  ← stable
     WHAT HAS WORKED / FAILED           ← stable
     COMPETITORS: ...                   ← stable
     CUSTOMER GROUPS: ...               ← stable (from analysis)
     SCOUT ASSESSMENT: ...              ← changes every analysis
     PREFERRED LANGUAGE: ...            ← irrelevant to watchlist
   We hash only the lines that would change what the watchlist should contain. */
var _watchlistKeys = ['BUSINESS:','SELLS:','BEST EXISTING CUSTOMERS:','BEST MONTHS:',
  'WORST MONTHS:','LOCAL EVENTS:','WHAT HAS WORKED:','WHAT HAS FAILED:',
  'COMPETITORS:','CUSTOMER GROUPS:'];
function watchlistHash(context) {
  var lines = String(context || '').split('\n');
  var stable = lines.filter(function(l) {
    for (var i = 0; i < _watchlistKeys.length; i++) {
      if (l.indexOf(_watchlistKeys[i]) === 0) return true;
    }
    return false;
  });
  return shortHash(stable.join('\n'));
}

/* Build a per-firm watchlist from the business context.
   Small Haiku call — extracts materials, triggers, localities, etc. */
async function buildWatchlist(env, firmCode, context, cost) {
  var hash = watchlistHash(context);
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-5-5', max_tokens: 1000, thinking: { type: 'disabled' },
      system: 'Extract a watchlist from this business description. Return ONLY JSON:\n' +
        '{"materials":[],"triggers":[],"localities":[],"regulations":[],"competitors":[],"groups":[]}\n' +
        'Each array: 2–6 short items.\n' +
        'materials = inputs the business buys (raw materials, goods, supplies).\n' +
        'triggers = events/situations that make customers need this business.\n' +
        'localities = specific areas, landmarks, neighbourhoods mentioned.\n' +
        'regulations = licences, rules, taxes that apply to this trade.\n' +
        'competitors = any competitor names mentioned.\n' +
        'groups = the named customer segments/types.\n' +
        'If a category has nothing, return an empty array.',
      messages: [{ role: 'user', content: context }]
    })
  });
  if (!r.ok) throw new Error('watchlist ' + r.status);
  var data = await r.json();
  recordCost(cost, 'claude-haiku-5-5', data);
  var text = (data.content || []).filter(function(b){ return b.type === 'text'; })
    .map(function(b){ return b.text; }).join('');
  var wl = { materials: [], triggers: [], localities: [], regulations: [], competitors: [], groups: [] };
  try {
    var a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a !== -1 && z > a) wl = JSON.parse(text.slice(a, z + 1));
  } catch (e) {}
  var keys = ['materials','triggers','localities','regulations','competitors','groups'];
  keys.forEach(function(k) { if (!Array.isArray(wl[k])) wl[k] = []; wl[k] = wl[k].slice(0, 6); });
  /* Locality sanity: localities should come from the firm's own context.
     Extract city from BUSINESS: line (format: "Name | Type | Area, City").
     Drop any locality that is itself a *different* well-known city name
     (the model sometimes hallucinates nearby cities). Keep neighbourhood
     names — they don't need to contain the city name. If nothing remains,
     fall back to the city itself. */
  var _bizLine = String(context || '').split('\n').filter(function(l){ return l.indexOf('BUSINESS:') === 0; })[0] || '';
  var _bizCity = '';
  var _bizParts = _bizLine.replace('BUSINESS:', '').split('|');
  if (_bizParts.length >= 3) {
    var _locPart = _bizParts[_bizParts.length - 1].trim();
    var _comma = _locPart.lastIndexOf(',');
    if (_comma !== -1) _bizCity = _locPart.slice(_comma + 1).trim();
    else _bizCity = _locPart;
  }
  if (_bizCity && wl.localities.length) {
    var _cityLower = _bizCity.toLowerCase();
    var _contextLower = String(context || '').toLowerCase();
    var _droppedLocs = [];
    var _kept = wl.localities.filter(function(loc) {
      var ll = loc.toLowerCase();
      /* Always keep the city itself. */
      if (ll === _cityLower) return true;
      /* Keep if the locality text appears anywhere in the business context. */
      if (_contextLower.indexOf(ll) !== -1) return true;
      /* Otherwise it's a hallucinated location — drop. */
      _droppedLocs.push(loc);
      return false;
    });
    if (_droppedLocs.length) {
      console.log(JSON.stringify({ watchlistLocalityDrop: firmCode, city: _bizCity, dropped: _droppedLocs, kept: _kept }));
    }
    if (_kept.length === 0) _kept = [_bizCity];
    wl.localities = _kept;
  }
  wl.hash = hash;
  await kvPut(env, 'market:watch:' + firmCode, JSON.stringify(wl));
  return wl;
}

/* Read or lazily build the watchlist. Rebuilds only when the stable-input hash changes. */
async function getWatchlist(env, firmCode, context, cost) {
  var hash = watchlistHash(context);
  var cached = await env.G7_KV.get('market:watch:' + firmCode, 'json');
  if (cached && cached.hash === hash) return cached;
  return buildWatchlist(env, firmCode, context, cost);
}

/* Extract real metadata from an API response: URL→title from search results,
   URL→page_age, URL→[citedText] from citations. Never trust the model's JSON. */
function collectSearchMeta(data) {
  var titles = {};
  var cited = {};
  var seen = new Set();
  var pageAge = {};
  (data.content || []).forEach(function(b) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      b.content.forEach(function(res) {
        if (res && res.url) {
          seen.add(res.url);
          if (res.title) titles[res.url] = res.title;
          if (res.page_age) pageAge[res.url] = res.page_age;
        }
      });
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      b.citations.forEach(function(c) {
        if (c && c.url && c.cited_text) {
          if (!cited[c.url]) cited[c.url] = [];
          cited[c.url].push(c.cited_text);
        }
      });
    }
  });
  return { seen: seen, titles: titles, cited: cited, pageAge: pageAge };
}

/* Stopwords for headline matching — common English words with no meaning. */
var _stopWords = new Set([
  'the','a','an','in','on','at','of','for','to','is','are','was','were','and','or',
  'but','by','with','from','that','this','its','has','had','it','as','be','not','no',
  'will','can','may','up','out','new','says','said','over','after','into','about',
  'than','been','would','could','should','also','just','more','most','very','all',
  'any','each','how','if','set','per','get','top','cut','now','yet','two','see'
]);

/* Source-match gate: ≥2 meaningful headline words must appear in the API's
   source title or cited text for the item's URL.
   Non-Latin titles (Hindi etc.): compare against cited text only; if no
   cited text, pass when URL was returned by search and is on a trusted domain.
   Returns { pass:bool, reason:string }. */
var _hasLatinRe = /[a-z]/i;
function sourceMatchCheck(headline, url, meta) {
  var title = meta.titles[url] || '';
  var citedArr = meta.cited[url] || [];
  /* Non-Latin title: the word-overlap check can't work on Devanagari etc. */
  if (title && !_hasLatinRe.test(title)) {
    if (citedArr.length) {
      var citedCorpus = citedArr.join(' ').toLowerCase();
      var citedWords = String(headline || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/)
        .filter(function(w) { return w.length > 1 && !_stopWords.has(w); });
      var citedMatches = citedWords.filter(function(w) { return citedCorpus.indexOf(w) !== -1; });
      if (citedMatches.length >= 2) return { pass: true };
    }
    /* No cited text either — trust if URL was in search results and on a trusted domain. */
    if (meta.seen.has(url)) {
      try {
        var h = new URL(url).hostname.toLowerCase();
        for (var ti = 0; ti < TRUSTED_NEWS_DOMAINS.length; ti++) {
          if (h === TRUSTED_NEWS_DOMAINS[ti] || h.endsWith('.' + TRUSTED_NEWS_DOMAINS[ti])) return { pass: true, reason: 'non-Latin title, trusted domain' };
        }
      } catch (e) {}
    }
    return { pass: false, reason: 'non-Latin title, not on trusted domain' };
  }
  if (!title && !citedArr.length) return { pass: false, reason: 'no API title or citation for URL' };
  var corpus = (title + ' ' + citedArr.join(' ')).toLowerCase();
  var words = String(headline || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/)
    .filter(function(w) { return w.length > 1 && !_stopWords.has(w); });
  var matches = words.filter(function(w) { return corpus.indexOf(w) !== -1; });
  if (matches.length >= 2) return { pass: true };
  return { pass: false, reason: 'only ' + matches.length + ' headline word(s) matched: [' + matches.join(', ') + '] of [' + words.join(', ') + ']' };
}

/* Relevance gate: true if whyItMatters implies no direct effect. */
var _noEffectRe = /no direct effect|no immediate impact|does not affect|not directly|unlikely to affect|no specific impact|does not directly|no clear effect/i;
function failsRelevanceGate(whyItMatters) {
  return _noEffectRe.test(whyItMatters || '');
}

/* ── Step a: search for business news candidates (Haiku + web_search) ──
   ONE call with max_uses 3. Prompt lists three searches in order:
   (a) material/input prices, (b) demand/locality, (c) macro/regulation.
   Model returns up to 10 candidates; we vet using API data for headline
   and recency (page_age), not the model's claims. */

async function searchBusinessNews(env, day, context, city, watchlist, told, macroOnly, cost) {
  /* Build the three search instructions from the watchlist. */

  /* Current month label from the IST day parameter (e.g. "2026-10-20" → "October 2026"). */
  var _mNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var _dayDate = new Date(day + 'T12:00:00+05:30');
  var _monthLabel = _mNames[_dayDate.getMonth()] + ' ' + _dayDate.getFullYear();

  var searches = [];
  if (!macroOnly) {
    if (watchlist.materials && watchlist.materials.length) {
      searches.push('SEARCH 1 — MATERIAL/INPUT PRICES: ' +
        watchlist.materials.map(function(m){ return '"' + m + ' price hike ' + _monthLabel + '"'; }).join(', '));
    } else {
      searches.push('SEARCH 1 — MATERIAL/INPUT PRICES: price changes for inputs this business buys, ' + _monthLabel);
    }
    var demandParts = [];
    if (watchlist.localities && watchlist.localities.length)
      demandParts.push(watchlist.localities.map(function(l){ return '"' + l + (city ? ' ' + city : '') + ' new project ' + _monthLabel + '"'; }).join(', '));
    if (watchlist.triggers && watchlist.triggers.length)
      demandParts.push(watchlist.triggers.map(function(t){ return '"' + t + ' ' + _monthLabel + '"'; }).join(', '));
    if (watchlist.competitors && watchlist.competitors.length)
      demandParts.push('competitor news: ' + watchlist.competitors.map(function(c){ return '"' + c + '"'; }).join(', '));
    if (demandParts.length) {
      searches.push('SEARCH 2 — DEMAND/LOCALITY: ' + demandParts.join('. '));
    } else {
      searches.push('SEARCH 2 — DEMAND/LOCALITY: new projects, tenders, demand changes for this trade, ' + _monthLabel);
    }
  }
  var macroParts = [];
  if (watchlist.regulations && watchlist.regulations.length)
    macroParts.push(watchlist.regulations.map(function(r){ return '"' + r + ' ' + _monthLabel + '"'; }).join(', '));
  macroParts.push('"GST ' + _monthLabel + '"', '"RBI repo rate ' + _monthLabel + '"');
  searches.push('SEARCH 3 — MACRO/REGULATION: ' + macroParts.join(', '));

  var system =
    'You are a news researcher for one Indian small business. Today is ' + day + ' (India).\n' +
    'You MUST run ALL ' + searches.length + ' searches below, IN ORDER. Every search is mandatory.\n' +
    searches.join('\n') + '\n\n' +
    (macroOnly ? 'THIS RUN: local news was empty. Search MACRO only — national economy, ' +
      'policy and prices for this trade.\n\n' : '') +
    'NOT NEWS: something that already existed. A competitor simply having a shop, or ' +
    'a yearly festival, is not a change.\n\n' +
    'RULES:\n' +
    '- Return EVERY result relevant to this business — up to 10 candidates, at least 2 per search when available.\n' +
    '- Every item must come from a page you actually found with web search.\n' +
    '- Never invent a development, competitor, date or number.\n' +
    '- sourceUrl must be the article page, not a home page or listing.\n' +
    '- "search" must be the number (1, 2 or 3) of the search that found it.\n\n' +
    'Reply with ONLY this JSON:\n' +
    '{"candidates":[{"sourceUrl":"exact URL","whatHappened":"one sentence, under 30 words",' +
    '"search":1|2|3}]}';

  var tool = { type: 'web_search_20250305', name: 'web_search', max_uses: macroOnly ? 1 : 3,
               allowed_domains: TRUSTED_NEWS_DOMAINS };
  if (city) tool.user_location = { type: 'approximate', city: city, country: 'IN', timezone: 'Asia/Kolkata' };

  var _userMsg = 'THE BUSINESS:\n' + context +
    (told ? '\n\nALREADY TOLD — do not repeat:\n' + told : '');
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-5-5', max_tokens: 6000, thinking: { type: 'disabled' },
      system: system, tools: [tool],
      messages: [{ role: 'user', content: _userMsg }]
    })
  });
  if (!r.ok) throw new Error('search step ' + r.status + ': ' + (await r.text()).slice(0, 300));
  var data = await r.json();
  recordCost(cost, 'claude-haiku-5-5', data);
  var meta = collectSearchMeta(data);

  /* If allowed_domains produced zero search results, retry once without domain restriction.
     All existing vetting gates still apply to these results. */
  if (meta.seen.size === 0 && tool.allowed_domains) {
    var toolOpen = { type: 'web_search_20250305', name: 'web_search', max_uses: macroOnly ? 1 : 3 };
    if (city) toolOpen.user_location = { type: 'approximate', city: city, country: 'IN', timezone: 'Asia/Kolkata' };
    var r2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5', max_tokens: 6000, thinking: { type: 'disabled' },
        system: system, tools: [toolOpen],
        messages: [{ role: 'user', content: _userMsg }]
      })
    });
    if (r2.ok) {
      data = await r2.json();
      recordCost(cost, 'claude-haiku-5-5', data);
      meta = collectSearchMeta(data);
      console.log(JSON.stringify({ domainRetry: true, firm: context.slice(0, 60), resultsAfter: meta.seen.size }));
    }
  }

  var text = (data.content || []).filter(function(b){ return b.type === 'text'; })
    .map(function(b){ return b.text; }).join('');
  var parsed = { candidates: [] };
  try {
    var a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a !== -1 && z > a) parsed = JSON.parse(text.slice(a, z + 1));
  } catch (e) {}

  /* Build told-URL set from the formatted history string. */
  var toldUrls = new Set();
  if (told) told.split('\n').forEach(function(line) {
    var m = line.match(/\((https?:\/\/[^)]+)\)/);
    if (m) toldUrls.add(m[1]);
  });

  /* Per-search counters for logging. */
  var searchLabels = { 1: 'materials', 2: 'demand', 3: 'macro' };
  var catRaw = { materials: 0, demand: 0, macro: 0 };
  var catVetted = { materials: 0, demand: 0, macro: 0 };
  var drops = [];

  var raw = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  var vetted = raw.filter(function(c) {
    if (!c || !c.sourceUrl) return false;
    var catName = searchLabels[c.search] || 'macro';
    catRaw[catName] = (catRaw[catName] || 0) + 1;
    if (!meta.seen.has(c.sourceUrl)) { drops.push({ headline: meta.titles[c.sourceUrl] || c.sourceUrl, url: c.sourceUrl, reason: 'URL not in search results', cat: catName }); return false; }
    if (isHomePage(c.sourceUrl)) { drops.push({ headline: meta.titles[c.sourceUrl] || '?', url: c.sourceUrl, reason: 'home/section page', cat: catName }); return false; }
    if (isListingOrQuote(c.sourceUrl)) { drops.push({ headline: meta.titles[c.sourceUrl] || '?', url: c.sourceUrl, reason: 'listing/quote portal', cat: catName }); return false; }
    if (toldUrls.has(c.sourceUrl)) { drops.push({ headline: meta.titles[c.sourceUrl] || '?', url: c.sourceUrl, reason: 'already told', cat: catName }); return false; }
    /* Recency from API page_age — not the model's publishedDate. */
    var age = checkPageAge(meta.pageAge[c.sourceUrl], 10);
    if (age.dated && !age.recent) { drops.push({ headline: meta.titles[c.sourceUrl] || '?', url: c.sourceUrl, reason: 'older than 10 days (page_age: ' + meta.pageAge[c.sourceUrl] + ')', cat: catName }); return false; }
    /* Evergreen/guide gate: drop guides, explainers, rate tables unless very recent. */
    var evg = evergreenCheck(meta.titles[c.sourceUrl], meta.pageAge[c.sourceUrl]);
    if (!evg.pass) { drops.push({ headline: meta.titles[c.sourceUrl] || '?', url: c.sourceUrl, reason: evg.reason, cat: catName }); return false; }
    catVetted[catName] = (catVetted[catName] || 0) + 1;
    return true;
  }).map(function(c) {
    var catName = searchLabels[c.search] || 'macro';
    var age = checkPageAge(meta.pageAge[c.sourceUrl], 10);
    /* Headline from API title, not model — trimmed and capped. */
    var apiTitle = stripCite(String(meta.titles[c.sourceUrl] || '').trim());
    return {
      headline: apiTitle.slice(0, 120) || stripCite(String(c.whatHappened || '')).slice(0, 120),
      whatHappened: clipOneSentence(stripCite(c.whatHappened)),
      sourceUrl: c.sourceUrl,
      scope: catName === 'macro' ? 'macro' : 'micro',
      dated: age.dated,
      _cat: catName
    };
  });

  /* Sort dated candidates first so Step b prefers them. */
  vetted.sort(function(a, b) { return (b.dated ? 1 : 0) - (a.dated ? 1 : 0); });

  var catLog = Object.keys(catRaw).map(function(k) { return { cat: k, raw: catRaw[k], vetted: catVetted[k] || 0 }; });

  return { candidates: vetted, meta: meta, usage: data.usage || {}, rawCount: raw.length, catLog: catLog, drops: drops, searches: searches };
}

/* ── Step b: pick and write final items (Sonnet, no tools) ── */
async function pickAndWriteNews(env, context, candidates, watchlist, cost) {
  if (!candidates.length) return { items: [], usage: {} };
  var groupList = (watchlist.groups || []).join(', ') || 'the customer groups described';

  var system =
    'You are Scout, the business news editor for one Indian small business.\n' +
    'From the CANDIDATES below, pick 3 to 4 items that matter most to this business.\n' +
    'You MUST return at least 2 items when there are 2 or more candidates. Never return fewer than 2.\n' +
    'For each item you keep:\n' +
    '- whyItMatters: ONE sentence, under 25 words. Name the concrete effect on the business. ' +
    'If there is no direct effect, do not include the item.\n' +
    '- whatToDo: ONE sentence, under 25 words. One action this week, tied to one of these ' +
    'customer groups by name: ' + groupList + '.\n' +
    '- urgency: today | this_week | watch\n' +
    '- scope: micro | macro\n' +
    '- headline: rewrite in under 10 words, plain English, using facts from the candidate\'s title and whatHappened. No clickbait.\n' +
    '- Copy sourceUrl EXACTLY from the candidate. Never change a URL.\n\n' +
    'RULES:\n' +
    '- Only events that changed recently: announced, launched, raised, cut, approved, opened, closed. No guides, explainers, "how to", rate tables.\n' +
    '- Prefer candidates marked dated:true (confirmed recent). Include an undated candidate only when it is clearly more important.\n' +
    '- Never invent facts beyond what the candidates state.\n' +
    '- Never write labels like "Customer 1" — use actual group names.\n' +
    '- Do not include any item where you cannot name a concrete effect.\n\n' +
    'Reply with ONLY this JSON:\n' +
    '{"items":[{"headline":"","whatHappened":"","whyItMatters":"","whatToDo":"",' +
    '"urgency":"","scope":"","sourceUrl":""}]}';

  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5-5', max_tokens: 3000,
      thinking: { type: 'between_tools' },
      system: system,
      messages: [{ role: 'user', content: 'BUSINESS:\n' + String(context).slice(0, 2500) +
        '\n\nCANDIDATES:\n' + JSON.stringify(candidates) }]
    })
  });
  if (!r.ok) throw new Error('pick step ' + r.status + ': ' + (await r.text()).slice(0, 300));
  var data = await r.json();
  recordCost(cost, 'claude-sonnet-5-5', data);

  var text = (data.content || []).filter(function(b){ return b.type === 'text'; })
    .map(function(b){ return b.text; }).join('');
  var parsed = { items: [] };
  try {
    var a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a !== -1 && z > a) parsed = JSON.parse(text.slice(a, z + 1));
  } catch (e) {}

  /* URL must be exactly one of the candidates — drop fabricated URLs. */
  var candidateUrls = new Set(candidates.map(function(c){ return c.sourceUrl; }));
  var items = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter(function(it) {
      return it && it.headline && it.sourceUrl && candidateUrls.has(it.sourceUrl);
    })
    .slice(0, 4)
    .map(function(it) {
      return cleanNewsItem({
        headline: String(it.headline).slice(0, 120),
        whatHappened: clipOneSentence(it.whatHappened),
        whyItMatters: clip(it.whyItMatters, 400),
        whatToDo: clip(it.whatToDo, 400),
        urgency: ['today','this_week','watch'].indexOf(it.urgency) !== -1 ? it.urgency : 'watch',
        scope: it.scope === 'micro' ? 'micro' : 'macro',
        sourceUrl: it.sourceUrl
      });
    });

  /* Minimum-2 backfill: if model returned fewer than 2 but candidates had ≥2,
     fill from candidates not already picked. Use the candidate's whatHappened
     as a plain whyItMatters. */
  if (items.length < 2 && candidates.length >= 2) {
    var pickedUrls = new Set(items.map(function(it){ return it.sourceUrl; }));
    var backfill = candidates.filter(function(c){ return !pickedUrls.has(c.sourceUrl); });
    for (var bi = 0; bi < backfill.length && items.length < 2; bi++) {
      var bf = backfill[bi];
      items.push(cleanNewsItem({
        headline: String(bf.headline || '').slice(0, 120),
        whatHappened: clipOneSentence(bf.whatHappened),
        whyItMatters: clipOneSentence(bf.whatHappened),
        whatToDo: '',
        urgency: 'watch',
        scope: bf.scope || 'macro',
        sourceUrl: bf.sourceUrl
      }));
    }
  }

  return { items: items, usage: data.usage || {} };
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKET BRIEF GENERATOR — two-step: search (Haiku) → pick-and-write (Sonnet).
// ─────────────────────────────────────────────────────────────────────────────
async function generateMarketBrief(env, firmCode, day, context, city, macroOnly, _retried, cost) {
  /* History — what Scout already told this owner in the last two weeks. */
  const histKey = 'market:history:' + firmCode;
  const history = (await env.G7_KV.get(histKey, 'json')) || [];
  const told = history.map(function(h){ return '- ' + h.headline + ' (' + h.sourceUrl + ')'; }).join('\n');

  /* Watchlist — drives search queries. Rebuilt only when context changes. */
  var watchlist = { materials: [], triggers: [], localities: [], regulations: [], competitors: [], groups: [] };
  try { watchlist = await getWatchlist(env, firmCode, context, cost); } catch (e) {
    console.log(JSON.stringify({ watchlistError: firmCode, error: String(e && e.message || e).slice(0, 300) }));
  }

  /* Step a: search for candidates (Haiku + web_search, up to 3 searches). */
  var search = await searchBusinessNews(env, day, context, city, watchlist, told, macroOnly, cost);
  var drops = (search.drops || []).slice();

  /* Retry macro-only when model returned nothing parseable (first call only). */
  if (search.candidates.length === 0 && search.rawCount === 0 && !macroOnly && !_retried) {
    return generateMarketBrief(env, firmCode, day, context, city, true, true, cost);
  }

  /* Step b: pick and write (Sonnet, no tools). */
  var pick = await pickAndWriteNews(env, context, search.candidates, watchlist, cost);
  var afterPick = pick.items.length;

  /* ── Quality gates ── */
  var afterRelevance = pick.items.filter(function(it) {
    if (failsRelevanceGate(it.whyItMatters)) {
      drops.push({ headline: it.headline, reason: 'relevance: ' + it.whyItMatters });
      return false;
    }
    return true;
  });
  var afterSourceMatch = afterRelevance.filter(function(it) {
    var check = sourceMatchCheck(it.headline, it.sourceUrl, search.meta);
    if (!check.pass) {
      drops.push({ headline: it.headline, reason: 'source-match: ' + check.reason });
      return false;
    }
    return true;
  });
  var items = dedupeItems(afterSourceMatch);
  if (items.length < afterSourceMatch.length) {
    var deduped = afterSourceMatch.filter(function(it) { return items.indexOf(it) === -1; });
    deduped.forEach(function(it) { drops.push({ headline: it.headline, reason: 'dedupe: duplicate topic' }); });
  }

  /* ── A1: Retry once with macro search if < 2 items survived gates ── */
  if (items.length < 2 && !_retried && !macroOnly) {
    var retry = await searchBusinessNews(env, day, context, city, watchlist, told, true, cost);
    console.log(JSON.stringify({ retried: true, firm: firmCode, retryRaw: retry.rawCount, retryCandidates: retry.candidates.length, itemsBefore: items.length }));
    drops = drops.concat(retry.drops || []);
    /* Merge new candidates with existing survivors, re-run Step b. */
    var combined = items.concat(retry.candidates);
    if (combined.length > items.length) {
      var pick2 = await pickAndWriteNews(env, context, combined, watchlist, cost);
      /* Re-apply gates on the new pick. */
      var merged2 = pick2.items.filter(function(it) {
        if (failsRelevanceGate(it.whyItMatters)) { drops.push({ headline: it.headline, reason: 'retry-relevance' }); return false; }
        var cm = sourceMatchCheck(it.headline, it.sourceUrl, search.meta);
        /* Also check retry meta for new URLs. */
        if (!cm.pass) cm = sourceMatchCheck(it.headline, it.sourceUrl, retry.meta);
        if (!cm.pass) { drops.push({ headline: it.headline, reason: 'retry-source-match' }); return false; }
        return true;
      });
      items = dedupeItems(merged2);
      afterPick = pick2.items.length;
      /* Merge search metadata. */
      Object.keys(retry.meta.titles).forEach(function(k) { if (!search.meta.titles[k]) search.meta.titles[k] = retry.meta.titles[k]; });
    }
  }

  /* At most one undated item in "Your business" — dated items are more trustworthy. */
  var _undatedCount = 0;
  items = items.filter(function(it) {
    var age = checkPageAge(search.meta.pageAge[it.sourceUrl], 10);
    if (!age.dated) {
      _undatedCount++;
      if (_undatedCount > 1) {
        drops.push({ headline: it.headline, reason: 'undated: only 1 undated item allowed' });
        return false;
      }
    }
    return true;
  });

  /* Populate sourceTitle from API metadata — never from model claims. */
  items.forEach(function(it) {
    it.sourceTitle = String(search.meta.titles[it.sourceUrl] || '').slice(0, 160);
  });

  /* Log per firm. */
  var _newsLog = {
    newsLog: firmCode, day: day, macroOnly: !!macroOnly, retried: !!_retried,
    watchlistHit: !!(watchlist && watchlist.hash),
    watchlist: {
      materials: (watchlist && watchlist.materials) || [],
      triggers: (watchlist && watchlist.triggers) || [],
      localities: (watchlist && watchlist.localities) || [],
      regulations: (watchlist && watchlist.regulations) || [],
      competitors: (watchlist && watchlist.competitors) || [],
      groups: (watchlist && watchlist.groups) || []
    },
    queryStrings: search.searches || [],
    searches: (search.usage.server_tool_use && search.usage.server_tool_use.web_search_requests) || 0,
    step1Tokens: { input: search.usage.input_tokens || 0, output: search.usage.output_tokens || 0 },
    step2Tokens: { input: pick.usage.input_tokens || 0, output: pick.usage.output_tokens || 0 },
    candidatesRaw: search.rawCount,
    candidatesVetted: search.candidates.length,
    catLog: search.catLog || [],
    afterPick: afterPick,
    afterRelevance: afterRelevance.length,
    afterSourceMatch: afterSourceMatch.length,
    afterDedupe: items.length,
    drops: drops
  };
  try { console.log(JSON.stringify(_newsLog)); } catch (e) {}

  /* ── NEVER EMPTY: if 0 items survived, pull last-good day's items ── */
  var _fromDay = '';
  if (items.length === 0) {
    var _lastGood = await lastMarketBrief(env, firmCode, day);
    if (_lastGood && _lastGood.items && _lastGood.items.length) {
      var _lgDate = _lastGood.date || '';
      var _wd = '';
      try { _wd = new Date(_lgDate + 'T12:00:00+05:30').toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' }); } catch (e) {}
      items = _lastGood.items.slice(0, 3).map(function(it) {
        return Object.assign({}, it, { _fromDay: _wd || _lgDate });
      });
      _fromDay = _wd || _lgDate;
      _newsLog.neverEmpty = { fromDate: _lgDate, fromDay: _wd, itemCount: items.length };
    }
    if (items.length === 0) {
      items = [{ headline: 'No new changes for your trade today.', _placeholder: true }];
      _newsLog.neverEmpty = { placeholder: true };
    }
  }

  const result = {
    items: items,
    date: day,
    dropped: afterPick - items.length
  };
  if (_fromDay) result.fromDay = _fromDay;
  result.generatedAt = new Date().toISOString();
  const cacheKey = 'market:' + firmCode + ':' + day;
  await kvPut(env,cacheKey, JSON.stringify(result), { expirationTtl: 172800 });

  /* Persist as last-known-good for fallback when generation fails.
     Don't overwrite with fallback items or placeholders. */
  if (items.length > 0 && !_fromDay && !items[0]._placeholder) {
    await kvPut(env,'market:last:' + firmCode, JSON.stringify(result));
  }

  /* Append today's items to history, keep last 15.
     Don't re-add last-good items — they're already in history. */
  if (!_fromDay && !items[0]._placeholder) {
    const nextHist = history.concat(items.map(function(it){
      return { headline: it.headline, sourceUrl: it.sourceUrl, date: day };
    })).slice(-15);
    await kvPut(env,histKey, JSON.stringify(nextHist));
  }

  /* _log is ephemeral — never persisted to KV or sent to clients.
     Attached after KV writes so callers (admin regen) can read it. */
  result._log = _newsLog;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// MORNING EMAIL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/* Firm names are stored with the product appended ("Agarwal Plywood — Scout").
   That suffix is an admin label, never something a customer should read. */
function displayName(user, fallback) {
  return String((user && user.firmName) || fallback || '')
    .replace(/\s*[—–-]\s*(Scout|Alex)\s*$/i, '').trim() || fallback || '';
}

function emailPrefs(user) {
  const legacy = !!(user && user.briefEmail);
  return {
    actions: user && typeof user.emailActions === 'boolean' ? user.emailActions : legacy,
    news:    user && typeof user.emailNews    === 'boolean' ? user.emailNews    : legacy
  };
}

/* Escape anything from the web before it goes into email HTML. */
function escEmail(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* Creates a permanent unsubscribe token for a firm, or returns its
   existing one. Stored both ways so the link never changes. */
async function unsubToken(env, firmCode) {
  const existing = await env.G7_KV.get('unsub:firm:' + firmCode);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const t = Array.from(bytes).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  await kvPut(env,'unsub:firm:' + firmCode, t);
  await kvPut(env,'unsub:' + t, firmCode);
  return t;
}

/* Sends one firm its morning brief, at most once per IST day.
   Skips silently when: not opted in, no email, nothing to say, or
   already sent today. Returns a short status string for the admin route. */
/* Reads one firm's synced Scout state. Handles bare or firm-suffixed keys
   and string or object values, so it survives either save format. */
async function loadScoutState(env, firmCode) {
  const blob = await env.G7_KV.get('firms:' + firmCode + ':scout_state', 'json');
  if (!blob) return null;
  function pick(name) {
    var v = blob[name];
    if (v === undefined) v = blob[name + '_' + firmCode];
    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } }
    return v === undefined ? null : v;
  }
  return { pick: pick };
}

/* PORT of pipelineDue from assets/pipeline.js — same statuses, same day
   thresholds, same urgency, same messages. Takes the pipeline store and
   current time as parameters instead of reading localStorage. */
function daysSince(iso, now) {
  if (!iso) return 999;
  var then = new Date(iso).getTime();
  if (isNaN(then)) return 999;
  return Math.floor((now - then) / 86400000);
}

/* Stage labels for the worker email — mirrors STAGE_LABELS from scout.js. */
var W_STAGE_LABELS = {
  trade:    { found: 'New lead', contacted: 'Messaged', replied: 'Enquiry', trial_booked: 'Quote sent', joined: 'Work won' },
  retail:   { found: 'New lead', contacted: 'Messaged', replied: 'Interested', trial_booked: 'Visit / Order', joined: 'Customer' },
  food:     { found: 'New lead', contacted: 'Messaged', replied: 'Interested', trial_booked: 'Visit / Order', joined: 'Customer' },
  personal: { found: 'New lead', contacted: 'Messaged', replied: 'Interested', trial_booked: 'Trial booked', joined: 'Member' },
  pro:      { found: 'New lead', contacted: 'Messaged', replied: 'Enquiry', trial_booked: 'Consultation booked', joined: 'Client' },
  _all:     { gone_quiet: 'Gone quiet', not_interested: 'Not interested' }
};
function wStageLabel(stage, bucket) {
  var b = bucket || 'retail';
  if (W_STAGE_LABELS[b] && W_STAGE_LABELS[b][stage]) return W_STAGE_LABELS[b][stage];
  if (W_STAGE_LABELS._all[stage]) return W_STAGE_LABELS._all[stage];
  return stage;
}

/* Business-word regex — mirrors pipeline.js _bizWordRe */
var _wBizWordRe = /\b(enterprises|traders|architects|associates|interiors|pvt|ltd|llp|group|solutions|services|studio|builders)\b|& co\b|co\./i;

function wInferKind(p) {
  if (p.kind === 'business' || p.kind === 'person') return p.kind;
  if (p.source === 'places') return 'business';
  var name = String(p.name || '');
  var words = name.trim().split(/\s+/);
  if (words.length >= 3) return 'business';
  if (_wBizWordRe.test(name)) return 'business';
  return 'person';
}

function wDisplayName(p) {
  var kind = wInferKind(p);
  var full = String(p.name || '').trim() || 'there';
  if (kind === 'business') return { first: full, full: full, kind: 'business' };
  var firstWord = full.split(' ')[0] || full;
  return { first: firstWord, full: full, kind: 'person' };
}

function wGreeting(p) {
  var dn = wDisplayName(p);
  if (dn.kind === 'business') return 'Namaste ' + dn.full + ' team';
  return 'Namaste ' + dn.first + ' ji';
}

function pipelineDueFromStore(store, now, bizName, bucket, reviewSkip) {
  if (!store || !Array.isArray(store.people)) return [];
  var bk = bucket || 'retail';
  var out = [];
  store.people.forEach(function(p) {
    /* Review ask: joined, not yet asked. Shows day 0–7, then stops.
       Skipped entirely if user has set scout_review_skip. */
    if (p.status === 'joined') {
      if (!reviewSkip && !p.reviewAskedAt && p.wonAt) {
        var dw = daysSince(p.wonAt, now);
        if (dw <= 7) {
          var dn = wDisplayName(p);
          out.push({
            person: p, urgency: dw === 0 ? 2 : 1, isReview: true,
            reason: 'Ask ' + dn.first + ' for a Google review',
            msg: ''
          });
        }
      }
      return;
    }
    if (p.status === 'not_interested') return;
    var d = daysSince(p.lastStatusAt || p.lastContactedAt, now);
    var dn = wDisplayName(p);
    var greet = wGreeting(p);
    var item = null;

    if (p.status === 'contacted' && d >= 14) {
      item = { reason: 'No response in ' + d + ' days', urgency: 3,
               msg: greet + ' \u2014 last try from my side. Agar kabhi zaroorat ho toh bata dena. Hum yahaan hain.' };
    } else if (p.status === 'contacted' && d >= 7) {
      item = { reason: 'No reply for ' + d + ' days \u2014 final follow-up', urgency: 2,
               msg: greet + ' \u2014 ek baar aur pooch raha hoon. Aapke liye koi din suit karta hai baat karne ke liye?' };
    } else if (p.status === 'contacted' && d >= 3) {
      item = { reason: 'No reply for ' + d + ' days', urgency: 1,
               msg: greet + ' \u2014 pichle message ka follow-up. Koi din suit karta hai baat karne ke liye?' };
    } else if (p.status === 'replied' && d >= 5) {
      item = { reason: 'Replied ' + d + ' days ago but has not booked', urgency: 3,
               msg: greet + ' \u2014 aapne interest dikhaya tha. Is week ek slot rakh doon? Bas din bata dijiye.' };
    } else if (p.status === 'trial_booked' && bk === 'trade') {
      /* Trade: quote follow-ups at 3, 7, 15 days */
      if (d >= 15) {
        item = { reason: 'Quote sent ' + d + ' days ago', urgency: 2,
                 msg: greet + ', quote bheje kuch din ho gaye. Abhi bhi interest ho toh bataiye, koi jaldi nahi.' };
      } else if (d >= 7) {
        item = { reason: 'Quote sent ' + d + ' days ago', urgency: 2,
                 msg: greet + ', pichle hafte ka quote \u2014 kuch badalna ho toh bataiye.' };
      } else if (d >= 3) {
        item = { reason: 'Quote sent ' + d + ' days ago', urgency: 1,
                 msg: greet + ', quote dekh liya? Koi sawaal ho toh bataiye, hum samjha denge.' };
      }
    } else if (p.status === 'trial_booked' && d >= 1) {
      item = { reason: wStageLabel('trial_booked', bk) + ' was ' + d + ' day(s) ago \u2014 did they show?', urgency: 3,
               msg: greet + ' \u2014 kaisa raha? Koi baat ho toh bata dena.' };
    } else if (p.status === 'gone_quiet' && d >= 14) {
      item = { reason: 'Quiet for ' + d + ' days', urgency: 1,
               msg: greet + ' \u2014 kaafi time ho gaya. Jab ready ho, bata dena.' };
    } else if (p.status === 'found' && d >= 1) {
      item = { reason: 'Found ' + d + ' day(s) ago \u2014 never messaged', urgency: 2,
               msg: greet + ' \u2014 ' + (bizName ? 'main ' + bizName + ' se hoon. ' : '') + 'Aapke liye ek baat thi, 2 min baat kar sakte hain?' };
    }

    if (item) {
      item.person = p;
      out.push(item);
    }
  });
  out.sort(function(a, b) { return b.urgency - a.urgency; });
  return out;
}

/* Normalise a raw phone string for wa.me — port of waPhone from pipeline.js */
function waPhone(raw) {
  var d = String(raw || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.indexOf('91') === 0 && d.length === 12) return d;
  if (d.indexOf('0') === 0) d = d.slice(1);
  if (d.length === 10) return '91' + d;
  return d;
}

/* Daily tap snapshot. Running totals are all KV holds; storing today's
   totals lets tomorrow show the change. */
async function tapReport(env, firmCode, day) {
  const sources = ['bio', 'google', 'status'];
  const now = {};
  for (const s of sources) {
    now[s] = parseInt((await env.G7_KV.get('scout:inbound:' + firmCode + ':' + s + ':clicks')) || '0', 10);
  }
  const y = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const prev = await env.G7_KV.get('scout:inbound:' + firmCode + ':snap:' + y, 'json');
  await kvPut(env,'scout:inbound:' + firmCode + ':snap:' + day, JSON.stringify(now), { expirationTtl: 4 * 86400 });
  return { now: now, prev: prev };
}

/* ── Shared email helpers ── */
function emailHeading(title) { return '<tr><td style="padding:22px 28px 6px"><div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#B8862B">' + escEmail(title) + '</div></td></tr>'; }
function emailRow(html) { return '<tr><td style="padding:6px 28px;font-size:14px;color:#111;line-height:1.6">' + html + '</td></tr>'; }
function emailGreyRow(text) { return '<tr><td style="padding:6px 28px;font-size:13px;color:#888;line-height:1.6">' + escEmail(text) + '</td></tr>'; }
function emailQuote(text) { return '<div style="border-left:3px solid #e6e2d8;padding:8px 14px;margin:6px 0;font-size:13px;color:#555;line-height:1.6">' + escEmail(text) + '</div>'; }
function emailSafeUrl(u) { return /^https:\/\//i.test(u || '') ? u : ''; }
function tapWord(n) { return n === 1 ? '1 tap' : n + ' taps'; }

function emailShell(opts) {
  var appUrl = 'https://gsevnservices.in/login.html?product=scout';
  var html =
    '<div style="background:#f6f4ef;padding:24px 12px">' +
    '<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;font-family:Arial,sans-serif" cellpadding="0" cellspacing="0">' +
    '<tr><td style="padding:28px 28px 4px">' +
    '<div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#B8862B">' + escEmail(opts.headerLabel || 'Scout') + '</div>' +
    (opts.greeting || '') +
    '</td></tr>' +
    opts.htmlParts.join('') +
    '<tr><td style="padding:20px 28px 28px">' +
    '<a href="' + appUrl + '" style="display:inline-block;background:#C9A84C;color:#080808;padding:12px 22px;text-decoration:none;font-size:13px;letter-spacing:.08em">Open Scout</a>' +
    '</td></tr></table>' +
    '<div style="max-width:560px;margin:14px auto 0;font-family:Arial,sans-serif;font-size:11px;color:#999;text-align:center;line-height:1.6">' +
    escEmail(opts.footerLine) + ' ' +
    '<a href="' + opts.unsubUrl + '" style="color:#999">Stop these emails</a></div></div>';
  var text = (opts.textGreeting || '') +
    opts.textParts.join('\n\n') +
    '\n\nOpen Scout: ' + appUrl + '\n\nStop these emails: ' + opts.unsubUrl;
  return { html: html, text: text };
}

/* Actions email: today's step, follow-ups, WhatsApp sends, link taps. */
async function sendActionsEmail(env, firmCode, day, move) {
  const sentKey = 'actions:emailed:' + firmCode + ':' + day;
  if (await env.G7_KV.get(sentKey)) return 'already_sent';
  const user = await env.G7_KV.get('auth:users:' + firmCode, 'json');
  if (!emailPrefs(user).actions) return 'not_opted_in';
  if (!user || !user.recoveryEmail) return 'no_email';

  const st = await loadScoutState(env, firmCode);
  const pend = st ? (st.pick('scout_pending_result') || {}) : {};
  let analysis = {};
  try {
    analysis = typeof pend.scoutOutput === 'string'
      ? JSON.parse(pend.scoutOutput.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim())
      : (pend.scoutOutput || {});
  } catch (e) {}
  const hasAnalysis = analysis && analysis.tab3;
  if (!hasAnalysis) return 'nothing_to_send';

  const weekNum = parseInt((st && st.pick('scout_week_number')) || '1', 10) || 1;
  const weekday = new Date(day + 'T06:00:00+05:30').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Kolkata' });
  const name = displayName(user, firmCode);
  const token = await unsubToken(env, firmCode);
  const unsubUrl = 'https://g7-proxy.gsevnservices.workers.dev/unsub?t=' + token + '&type=actions';

  /* Resolve messageToUse against tab2.messages */
  function resolveMessage(raw) {
    if (!raw) return '';
    if (!/^The /i.test(raw) && raw.indexOf('message written for') === -1) return raw;
    var msgs = (analysis && analysis.tab2 && Array.isArray(analysis.tab2.messages)) ? analysis.tab2.messages : [];
    if (!msgs.length) return '';
    var words = raw.toLowerCase().split(/\s+/);
    var best = null; var bestScore = -1;
    for (var mi = 0; mi < msgs.length; mi++) {
      var m = msgs[mi];
      var icp = ((m.icp || '') + ' ' + (m.type || '')).toLowerCase();
      var score = 0;
      for (var wi = 0; wi < words.length; wi++) {
        if (words[wi].length > 2 && icp.indexOf(words[wi]) !== -1) score++;
      }
      if (m.type === 'primary') score += 0.5;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    if (best && bestScore > 0) return best.versionA || best.text || '';
    return '';
  }

  var htmlParts = [];
  var textParts = [];
  var subjectParts = [];

  /* ── SCOUT'S MOVE TODAY ── */
  if (move && move.headline) {
    htmlParts.push(emailHeading('Scout\u2019s move today'));
    htmlParts.push(emailRow('<strong>' + escEmail(move.headline) + '</strong>'));
    if (move.reason) htmlParts.push(emailRow('<span style="font-size:12px;color:#888">Why: ' + escEmail(move.reason) + '</span>'));
    if (move.sourceUrl) htmlParts.push(emailRow('<a href="' + escEmail(emailSafeUrl(move.sourceUrl)) + '" style="font-size:12px;color:#888">' + escEmail(move.sourceTitle || 'Source') + '</a>'));
    htmlParts.push(emailRow(escEmail(move.action || '')));
    if (move.message) {
      htmlParts.push(emailRow(emailQuote(move.message)));
      var waUrl = emailSafeUrl('https://wa.me/?text=' + encodeURIComponent(move.message));
      htmlParts.push(emailRow('<a href="' + escEmail(waUrl) + '" style="color:#B8862B;text-decoration:none;font-weight:600">Share on WhatsApp</a>'));
    }
    htmlParts.push(emailGreyRow('A suggestion from Scout \u2014 you know your business best.'));

    textParts.push('SCOUT\'S MOVE TODAY');
    textParts.push('  ' + move.headline);
    if (move.reason) textParts.push('  Why: ' + move.reason);
    if (move.sourceUrl) textParts.push('  Source: ' + (move.sourceTitle || move.sourceUrl));
    textParts.push('  ' + (move.action || ''));
    if (move.message) {
      textParts.push('  > ' + move.message);
      textParts.push('  Share on WhatsApp: https://wa.me/?text=' + encodeURIComponent(move.message));
    }
    textParts.push('  A suggestion from Scout — you know your business best.');
  }

  /* ── TODAY'S STEP ── */
  var tab3 = (analysis && analysis.tab3) || {};
  var days = Array.isArray(tab3.days) ? tab3.days : [];
  var todayStep = null;
  for (var di = 0; di < days.length; di++) {
    if (days[di].day && days[di].day.toLowerCase() === weekday.toLowerCase()) { todayStep = days[di]; break; }
  }
  if (todayStep) {
    htmlParts.push(emailHeading('Today\u2019s step'));
    var stepHtml = '<strong>' + escEmail(todayStep.action || '') + '</strong>';
    if (todayStep.timeRequired) stepHtml += ' \u00b7 ' + escEmail(todayStep.timeRequired);
    if (todayStep.target) stepHtml += ' \u00b7 Target: ' + escEmail(todayStep.target);
    htmlParts.push(emailRow(stepHtml));
    var resolvedMsg = resolveMessage(todayStep.messageToUse);
    if (resolvedMsg) htmlParts.push(emailRow(emailQuote(resolvedMsg)));
    textParts.push('TODAY\'S STEP\n' + (todayStep.action || '') +
      (todayStep.timeRequired ? ' · ' + todayStep.timeRequired : '') +
      (todayStep.target ? ' · Target: ' + todayStep.target : '') +
      (resolvedMsg ? '\n> ' + resolvedMsg : ''));
  }

  /* ── FOLLOW UP TODAY ── */
  var pipeline = st ? st.pick('scout_pipeline') : null;
  var bizName = (pend && pend.businessData && pend.businessData.businessName) || '';
  var _bucket = (st ? st.pick('scout_bucket') : null) || 'retail';
  var _rsRaw = st ? st.pick('scout_review_skip') : null;
  var _reviewSkip = _rsRaw === true || _rsRaw === 'true';
  var due = pipelineDueFromStore(pipeline, Date.now(), bizName, _bucket, _reviewSkip);
  if (due.length > 0) {
    htmlParts.push(emailHeading('Follow up today'));
    var show = due.slice(0, 5);
    show.forEach(function(d) {
      var p = d.person || {};
      var pName = escEmail(p.name || 'Someone');
      var pReason = escEmail(d.reason || '');
      var ph = waPhone(p.phone);
      var waUrl = ph ? emailSafeUrl('https://wa.me/' + ph + '?text=' + encodeURIComponent(d.msg || '')) : '';
      var line = '<strong>' + pName + '</strong> \u2014 ' + pReason;
      if (waUrl) line += ' <a href="' + escEmail(waUrl) + '" style="color:#B8862B;text-decoration:none;font-weight:600">\u00a0WhatsApp</a>';
      htmlParts.push(emailRow(line));
    });
    if (due.length > 5) htmlParts.push(emailGreyRow('+' + (due.length - 5) + ' more in your pipeline'));
    subjectParts.push(due.length + ' follow-up' + (due.length === 1 ? '' : 's'));

    textParts.push('FOLLOW UP TODAY');
    show.forEach(function(d) {
      var p = d.person || {};
      var ph = waPhone(p.phone);
      textParts.push('  ' + (p.name || 'Someone') + ' — ' + (d.reason || '') +
        (ph ? '\n  WhatsApp: https://wa.me/' + ph + '?text=' + encodeURIComponent(d.msg || '') : ''));
    });
    if (due.length > 5) textParts.push('  +' + (due.length - 5) + ' more in your pipeline');
  }

  /* ── SEND ON WHATSAPP TODAY ── */
  var waCal = (tab3 && tab3.whatsappCalendar) || {};
  var calWeek = ((weekNum - 1) % 4) + 1;
  var weekKey = 'week' + calWeek;
  var waEntries = Array.isArray(waCal[weekKey]) ? waCal[weekKey] : [];
  var todayWa = waEntries.filter(function(e) { return e.day && e.day.toLowerCase() === weekday.toLowerCase(); });
  if (todayWa.length > 0) {
    htmlParts.push(emailHeading('Send on WhatsApp today'));
    todayWa.forEach(function(e) {
      var sendLabel = escEmail(e.listName || e.sendTo || '');
      var timeLabel = escEmail(e.time || '');
      htmlParts.push(emailRow((timeLabel ? timeLabel + ' \u00b7 ' : '') + 'Send to <strong>' + sendLabel + '</strong>'));
      if (e.message) {
        htmlParts.push(emailRow(emailQuote(e.message)));
        var calWaUrl = emailSafeUrl('https://wa.me/?text=' + encodeURIComponent(e.message));
        htmlParts.push(emailRow('<a href="' + escEmail(calWaUrl) + '" style="color:#B8862B;text-decoration:none;font-weight:600">Send on WhatsApp</a>'));
      }
      if (e.purpose) htmlParts.push(emailRow('<span style="font-size:12px;color:#888">' + escEmail(e.purpose) + '</span>'));
    });
    subjectParts.push(todayWa.length + ' WhatsApp send' + (todayWa.length === 1 ? '' : 's'));

    textParts.push('SEND ON WHATSAPP TODAY');
    todayWa.forEach(function(e) {
      textParts.push('  ' + (e.time || '') + ' · Send to ' + (e.listName || e.sendTo || '') +
        (e.message ? '\n  > ' + e.message +
          '\n  Send: https://wa.me/?text=' + encodeURIComponent(e.message) : '') +
        (e.purpose ? '\n  ' + e.purpose : ''));
    });
  }

  /* ── YOUR LINKS ── */
  var links = await env.G7_KV.get('scout:inbound:' + firmCode + ':links', 'json');
  if (links) {
    var taps = await tapReport(env, firmCode, day);
    var totalNow = (taps.now.bio || 0) + (taps.now.google || 0) + (taps.now.status || 0);
    if (totalNow > 0) {
      htmlParts.push(emailHeading('Your links'));
      ['bio', 'google', 'status'].forEach(function(s) {
        if (!taps.now[s] && !links[s]) return;
        var line = escEmail(s.charAt(0).toUpperCase() + s.slice(1)) + ': <strong>' + tapWord(taps.now[s] || 0) + '</strong>';
        if (taps.prev && typeof taps.prev[s] === 'number') {
          var change = (taps.now[s] || 0) - taps.prev[s];
          if (change > 0) line += ' <span style="color:#2a7a2a">(+' + change + ' since yesterday)</span>';
        }
        htmlParts.push(emailRow(line));
      });
      textParts.push('YOUR LINKS');
      ['bio', 'google', 'status'].forEach(function(s) {
        if (!taps.now[s] && !links[s]) return;
        var line = '  ' + s.charAt(0).toUpperCase() + s.slice(1) + ': ' + tapWord(taps.now[s] || 0);
        if (taps.prev && typeof taps.prev[s] === 'number') {
          var change = (taps.now[s] || 0) - taps.prev[s];
          if (change > 0) line += ' (+' + change + ' since yesterday)';
        }
        textParts.push(line);
      });
    } else {
      htmlParts.push(emailHeading('Your links'));
      htmlParts.push(emailGreyRow('No taps yet \u2014 share your bio link today.'));
      textParts.push('YOUR LINKS\n  No taps yet — share your bio link today.');
    }
  }

  /* ── Subject ── */
  var subject;
  if (move && move.headline) {
    var moveTail = weekday + ' with Scout \u00b7 ' + move.headline;
    if (moveTail.length > 70) {
      var cut = moveTail.slice(0, 70);
      var ls = cut.lastIndexOf(' ');
      if (ls > 30) cut = cut.slice(0, ls);
      moveTail = cut + '\u2026';
    }
    subject = moveTail;
  } else if (subjectParts.length > 0) {
    subject = weekday + ' with Scout \u00b7 ' + subjectParts.join(', ');
  } else {
    subject = weekday + ' with Scout';
  }

  var shell = emailShell({
    headerLabel: 'Scout',
    greeting: '<div style="font-size:20px;color:#111;margin-top:8px">Good morning, ' + escEmail(name) + '.</div>' +
              '<div style="font-size:13px;color:#888;margin-top:4px">Week ' + weekNum + ' of 12.</div>',
    textGreeting: 'Good morning, ' + name + '.\nWeek ' + weekNum + ' of 12.\n\n',
    htmlParts: htmlParts,
    textParts: textParts,
    footerLine: 'You get this because you switched on Scout\u2019s daily actions.',
    unsubUrl: unsubUrl
  });

  var ok = await sendEmail(env, user.recoveryEmail, subject, shell.text, shell.html, {
    'List-Unsubscribe': '<' + unsubUrl + '>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  });
  if (ok) await kvPut(env,sentKey, '1', { expirationTtl: 172800 });
  return ok ? 'sent' : 'send_failed';
}

/* Shared news email renderer — single data path for both the real morning
   email and the admin test-email. Matches the shape of GET /scout/news
   (i.e. buildDailyNews output) exactly, including _placeholder, _fromDay
   and _marketLine items. news.html on the frontend uses scoutNewsFlatItems
   for the same shape, so email and web can never drift.
   Returns { htmlParts:[], textParts:[], firstHeadline:'' }. */
function renderNewsBody(news) {
  var htmlParts = [];
  var textParts = [];
  var firstHeadline = '';
  var noEffect = 'No direct effect on your business.';

  var bizItems = (news && news.business && Array.isArray(news.business.items)) ? news.business.items : [];
  var sections = (news && Array.isArray(news.sections)) ? news.sections : [];

  /* Stale notice */
  if (news && news.stale && news.staleDate) {
    try {
      var wd = new Date(news.staleDate + 'T12:00:00+05:30').toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
      htmlParts.push(emailGreyRow('From ' + wd + ' \u2014 today\u2019s update is on its way.'));
      textParts.push('From ' + wd + ' \u2014 today\u2019s update is on its way.');
    } catch (e) {}
  }

  /* ── YOUR BUSINESS ── */
  if (bizItems.length > 0) {
    htmlParts.push(emailHeading('Your business'));
    textParts.push('YOUR BUSINESS');
    bizItems.forEach(function(it) {
      /* Placeholder item */
      if (it._placeholder) {
        htmlParts.push(emailGreyRow(it.headline || ''));
        textParts.push('  ' + (it.headline || ''));
        return;
      }
      if (!firstHeadline) firstHeadline = it.headline || '';
      var url = emailSafeUrl(it.sourceUrl || '');
      var h = '';
      if (it._fromDay) h += '<div style="font-size:11px;color:#999;margin-bottom:2px">From ' + escEmail(it._fromDay) + '</div>';
      h += '<div style="font-weight:600">' + escEmail(it.headline || '') + '</div>';
      if (it._marketLine) {
        /* Markets today — compact: headline + source only */
      } else {
        var why = (it.why || it.whyItMatters || '').trim();
        if (why && why !== noEffect) h += '<div style="font-size:13px;color:#555;margin-top:4px">' + escEmail(why) + '</div>';
        if (it.whatToDo) h += '<div style="margin-top:4px"><span style="color:#B8862B;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-right:6px">Do this</span>' + escEmail(it.whatToDo) + '</div>';
      }
      if (url) h += '<div style="margin-top:4px"><a href="' + escEmail(url) + '" style="font-size:12px;color:#888">' + escEmail(it.sourceTitle || 'Source') + '</a></div>';
      htmlParts.push(emailRow(h));
      var t = (it._fromDay ? '  (From ' + it._fromDay + ') ' : '  ') + (it.headline || '');
      if (!it._marketLine) {
        var twhy = (it.why || it.whyItMatters || '').trim();
        if (twhy && twhy !== noEffect) t += '\n  ' + twhy;
        if (it.whatToDo) t += '\n  Do this: ' + it.whatToDo;
      }
      if (it.sourceUrl) t += '\n  Source: ' + it.sourceUrl;
      textParts.push(t);
    });
  }

  /* ── ALSO WORTH KNOWING (sections) ── */
  sections.forEach(function(sec) {
    var items = (sec.items && sec.items.length) ? sec.items : [];
    if (!items.length) return;
    htmlParts.push(emailHeading(sec.label || 'News'));
    textParts.push(String(sec.label || 'NEWS').toUpperCase());
    items.forEach(function(it) {
      if (!firstHeadline) firstHeadline = it.headline || '';
      var url = emailSafeUrl(it.sourceUrl || '');
      var h = '<div style="font-weight:600">' + escEmail(it.headline || '') + '</div>';
      if (it._marketLine) {
        /* Markets today — compact: headline + source only */
      } else {
        if (it.whatHappened) h += '<div style="font-size:13px;color:#888;margin-top:4px">' + escEmail(it.whatHappened) + '</div>';
        var why = (it.why || '').trim();
        if (why && why !== noEffect) {
          h += '<div style="margin-top:4px"><span style="color:#B8862B;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-right:6px">For you</span>' + escEmail(why) + '</div>';
        }
      }
      if (url) h += '<div style="margin-top:4px"><a href="' + escEmail(url) + '" style="font-size:12px;color:#888">' + escEmail(it.sourceTitle || 'Source') + '</a></div>';
      htmlParts.push(emailRow(h));
      var t = '  ' + (it.headline || '');
      if (!it._marketLine) {
        if (it.whatHappened) t += '\n  ' + it.whatHappened;
        var twhy = (it.why || '').trim();
        if (twhy && twhy !== noEffect) t += '\n  For you: ' + twhy;
      }
      if (it.sourceUrl) t += '\n  Source: ' + it.sourceUrl;
      textParts.push(t);
    });
  });

  return { htmlParts: htmlParts, textParts: textParts, firstHeadline: firstHeadline };
}

/* Extract the business's display name from the context BUSINESS: line,
   falling back to displayName(user) or firmCode. Never returns a raw code. */
function newsGreetingName(user, context, firmCode) {
  /* Try BUSINESS: line first — "Sharma Interiors | Interior Design | Lucknow" */
  if (context) {
    var bizLine = String(context).split('\n').filter(function(l){ return l.indexOf('BUSINESS:') === 0; })[0];
    if (bizLine) {
      var name = bizLine.replace('BUSINESS:', '').split('|')[0].trim();
      if (name) return name;
    }
  }
  /* Fall back to user.firmName (stripped of " — Scout"). */
  var dn = displayName(user, '');
  return dn || firmCode || 'there';
}

/* News email: assembles today's news from cache and sends it.
   No news param — calls assembleNews internally so it can never drift
   from GET /scout/news or the test-email path. */
async function sendNewsEmail(env, firmCode, day) {
  const sentKey = 'market:emailed:' + firmCode + ':' + day;
  if (await env.G7_KV.get(sentKey)) return 'already_sent';
  const user = await env.G7_KV.get('auth:users:' + firmCode, 'json');
  if (!emailPrefs(user).news) return 'not_opted_in';
  if (!user || !user.recoveryEmail) return 'no_email';

  /* Build news from cache (cacheOnly — never generate from the email path). */
  var saved = await env.G7_KV.get('market:ctx:' + firmCode, 'json');
  var effectivePrefs;
  try { effectivePrefs = await resolveNewsPrefs(env, firmCode, user.newsPrefs); } catch (e) { effectivePrefs = user.newsPrefs || []; }
  var news = await assembleNews(env, firmCode, day, {
    context: (saved && saved.context) || '',
    city: (saved && saved.city) || '',
    prefs: effectivePrefs,
    cacheOnly: true
  });
  if (!news) return 'nothing_to_send';

  var body = renderNewsBody(news);
  if (!body.htmlParts.length) return 'nothing_to_send';

  /* Greeting uses the business name, never the firm code. */
  const name = newsGreetingName(user, saved && saved.context, firmCode);
  const token = await unsubToken(env, firmCode);
  const unsubUrl = 'https://g7-proxy.gsevnservices.workers.dev/unsub?t=' + token + '&type=news';

  var subjectTail = String(body.firstHeadline).slice(0, 60);
  if (subjectTail.length < body.firstHeadline.length) {
    var lastSpace = subjectTail.lastIndexOf(' ');
    if (lastSpace > 20) subjectTail = subjectTail.slice(0, lastSpace);
    subjectTail += '\u2026';
  }
  var subject = subjectTail ? 'Your news today \u00b7 ' + subjectTail : 'Your news today';

  var shell = emailShell({
    headerLabel: 'Scout \u00b7 Your news today',
    greeting: '<div style="font-size:20px;color:#111;margin-top:8px">Good morning, ' + escEmail(name) + '.</div>',
    textGreeting: 'Good morning, ' + name + '.\n\n',
    htmlParts: body.htmlParts,
    textParts: body.textParts,
    footerLine: 'You get this because you switched on Scout\u2019s news email.',
    unsubUrl: unsubUrl
  });

  var ok = await sendEmail(env, user.recoveryEmail, subject, shell.text, shell.html, {
    'List-Unsubscribe': '<' + unsubUrl + '>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  });
  if (ok) await kvPut(env,sentKey, '1', { expirationTtl: 172800 });
  return ok ? 'sent' : 'send_failed';
}

/* Admin test email: renders today's cached news via assembleNews and sends
   to ADMIN_EMAIL only. No generation (cacheOnly), no sent-flag. */
async function sendTestNewsEmail(env, firmCode) {
  if (!env.ADMIN_EMAIL) return { error: 'ADMIN_EMAIL not set' };
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const day = ist.toISOString().slice(0, 10);

  const user = await env.G7_KV.get('auth:users:' + firmCode, 'json') || {};
  var saved = await env.G7_KV.get('market:ctx:' + firmCode, 'json');
  var effectivePrefs;
  try { effectivePrefs = await resolveNewsPrefs(env, firmCode, user.newsPrefs); } catch (e) { effectivePrefs = user.newsPrefs || []; }

  var news = await assembleNews(env, firmCode, day, {
    context: (saved && saved.context) || '',
    city: (saved && saved.city) || '',
    prefs: effectivePrefs,
    cacheOnly: true
  });
  if (!news) return { error: 'no cached news for ' + firmCode };

  var body = renderNewsBody(news);
  var name = newsGreetingName(user, saved && saved.context, firmCode);
  var shell = emailShell({
    headerLabel: 'Scout \u00b7 TEST NEWS EMAIL',
    greeting: '<div style="font-size:20px;color:#111;margin-top:8px">Good morning, ' + escEmail(name) + '.</div>' +
              '<div style="font-size:11px;color:#B8862B;margin-top:4px">[TEST — sent to admin only]</div>',
    textGreeting: 'Good morning, ' + name + '.\n[TEST — sent to admin only]\n\n',
    htmlParts: body.htmlParts,
    textParts: body.textParts,
    footerLine: 'Test email — sent to admin only.',
    unsubUrl: '#'
  });
  var subject = '[TEST] ' + firmCode + ' news email';
  var ok = await sendEmail(env, env.ADMIN_EMAIL, subject, shell.text, shell.html);
  var bizCount = (news.business && news.business.items) ? news.business.items.length : 0;
  var alsoCount = (news.sections || []).reduce(function(n,s){ return n + (s.items||[]).length; }, 0);
  return ok ? { sent: true, to: env.ADMIN_EMAIL, items: bizCount + '+' + alsoCount } : { error: 'send_failed' };
}

/* The whole morning job for one firm: news → move → actions email → news email. */
async function runMorningForFirm(env, firmCode, day) {
  const saved = await env.G7_KV.get('market:ctx:' + firmCode, 'json');
  if (!saved || !saved.context) return 'no_context';
  const user = await env.G7_KV.get('auth:users:' + firmCode, 'json') || {};

  /* Per-firm flags: cronPaused and isTest skip all generation */
  if (user.cronPaused) return 'paused';
  if (user.isTest) return 'test';

  /* Skip firms with nothing to deliver: both emails off AND not recently
     active on the dashboard. "Recently" = lastSeen within last 3 days. */
  const ep = emailPrefs(user);
  if (!ep.actions && !ep.news) {
    var lastSeenRaw = await env.G7_KV.get('scout:lastSeen:' + firmCode);
    var seenDaysAgo = lastSeenRaw ? Math.floor((Date.now() - new Date(lastSeenRaw).getTime()) / 86400000) : 999;
    if (seenDaysAgo > 3) return 'skipped_no_email';
  }

  /* Budget guard — skip generation if firm cost cap exceeded. */
  var _bc = await budgetCheck(env, day, firmCode);
  if (!_bc.ok) {
    console.log(JSON.stringify({ budgetSkip: firmCode, firmSpent: _bc.firmSpent }));
    await sendBudgetEmail(env, day, firmCode, _bc.firmSpent, _bc.cap);
    return { status: 'budget_exceeded', cost: { firmSpent: _bc.firmSpent } };
  }

  var cost = newCostAccum();
  var news = null, move = null, a = 'error', n = 'error';
  var effectiveNewsPrefs;
  try { effectiveNewsPrefs = await resolveNewsPrefs(env, firmCode, user.newsPrefs); } catch (e) { effectiveNewsPrefs = user.newsPrefs || []; }
  try { news = await buildDailyNews(env, firmCode, day, saved.context, saved.city || '', effectiveNewsPrefs, cost); } catch (e) { console.log(JSON.stringify({ newsError: firmCode, error: String(e && e.message || e).slice(0, 300) })); }
  const st = await loadScoutState(env, firmCode);
  try { move = await generateScoutMove(env, firmCode, day, saved.context, news, st, false, cost); } catch (e) { console.log(JSON.stringify({ moveError: firmCode, error: String(e && e.message || e).slice(0, 300) })); }
  try { a = await sendActionsEmail(env, firmCode, day, move); } catch (e) { console.log(JSON.stringify({ actionsEmailError: firmCode, error: String(e && e.message || e).slice(0, 300) })); }
  if (news) { try { n = await sendNewsEmail(env, firmCode, day); } catch (e) { console.log(JSON.stringify({ newsEmailError: firmCode, error: String(e && e.message || e).slice(0, 300) })); } } else { n = 'no_news'; }

  /* Flush cost to KV after the full firm run. */
  var costUsd = 0;
  try { costUsd = await flushCost(env, day, firmCode, cost); } catch (e) {}
  return { status: 'actions:' + a + ' news:' + n + ' move:' + (move ? 'ok' : 'none'), cost: Object.assign({}, cost), costUsd: costUsd };
}

/* ═══════════════════════════════════════════
   LEAD FINDER — real businesses from the open web, not a maps API.
   One API call: web search finds candidate pages, web fetch reads them.
   Integrity gate: a phone number is kept only if its digits appear in
   text Scout actually read — a fetched page or a cited search passage.
   A business with no verifiable phone is kept with phone empty, never
   with a guessed one.
═══════════════════════════════════════════ */
async function findBusinesses(env, query, cap, cost) {
  const want = Math.max(1, Math.min(cap || 10, 15));
  const system =
    'You find real businesses in India for a small-business owner to contact. ' +
    'Search the web, then fetch the most useful pages to read full listings.\n\n' +
    'BEST SOURCES, in order: the businesses\' own websites (contact pages), ' +
    'official registries and association member lists, then directories such as ' +
    'IndiaMART, Sulekha, TradeIndia and JustDial.\n\n' +
    'RULES:\n' +
    '- Only businesses that actually appear on pages you read. Never invent one.\n' +
    '- phone must be copied exactly as printed on the page. If no number is printed, ' +
    'leave phone empty. Never guess, complete or reformat a number from memory.\n' +
    '- Prefer mobile numbers. Skip numbers labelled as toll-free.\n' +
    '- Every business must match the request\'s trade and city.\n' +
    '- Return up to ' + want + ' businesses. Fewer real ones beat more doubtful ones.\n\n' +
    'First, for each business, write one short sentence stating its name, ' +
    'area and phone number exactly as the source shows it, citing that ' +
    'source. Then, on a new line, output this JSON and nothing after it:\n' +
    '{"businesses":[{"name":"","address":"area and city","phone":"exactly as printed",' +
    '"website":"","sourceUrl":"the page you read it on"}]}';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 6000,
      thinking: { type: 'disabled' },
      system: system,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 2,
          user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' } },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2, max_content_tokens: 3000 }
      ],
      messages: [{ role: 'user', content: 'Find: ' + query }]
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('finder ' + r.status + ': ' + t.slice(0, 400));
  }
  const data = await r.json();
  recordCost(cost, 'claude-haiku-5-5', data);

  /* Everything Scout actually read: fetched page text and cited passages. */
  let corpus = '';
  const readUrls = new Set();
  (data.content || []).forEach(function(b) {
    if (b.type === 'web_fetch_tool_result' && b.content && b.content.type === 'web_fetch_result') {
      if (b.content.url) readUrls.add(b.content.url);
      const src = b.content.content && b.content.content.source;
      if (src && typeof src.data === 'string' && src.type !== 'base64') corpus += ' ' + src.data;
    }
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      b.content.forEach(function(x){ if (x && x.url) readUrls.add(x.url); });
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      b.citations.forEach(function(c){ if (c && c.cited_text) corpus += ' ' + c.cited_text; });
    }
  });
  const corpusDigits = corpus.replace(/\D/g, '');

  /* The answer is split across several text blocks wherever the model
     cites a source. Join them all, then take the outermost JSON object. */
  const text = (data.content || []).filter(function(b){ return b.type === 'text'; })
    .map(function(b){ return b.text; }).join('');
  let parsed = { businesses: [] };
  try {
    const a = text.indexOf('{"businesses"'), z = text.lastIndexOf('}');
    if (a !== -1 && z > a) parsed = JSON.parse(text.slice(a, z + 1));
  } catch (e) {}

  /* Last 10 digits must appear in what was read. Indian numbers are written
     with +91, 0, spaces and dashes in every combination; the last ten
     digits are the stable part. */
  function verifiedPhone(p) {
    const d = String(p || '').replace(/\D/g, '');
    if (d.length < 8) return '';
    const tail = d.slice(-10);
    return corpusDigits.indexOf(tail) !== -1 ? String(p).trim() : '';
  }

  const seen = new Set();
  const out = [];
  (Array.isArray(parsed.businesses) ? parsed.businesses : []).forEach(function(b) {
    if (!b || !b.name) return;
    if (b.sourceUrl && !readUrls.has(b.sourceUrl)) return;
    const key = String(b.name).toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return;
    seen.add(key);
    const website = /^https?:\/\//i.test(b.website || '') ? b.website : '';
    out.push({
      name: String(b.name).slice(0, 120),
      address: String(b.address || '').slice(0, 200),
      phone: verifiedPhone(b.phone),
      website: website
    });
  });

  /* Verified phones first — those are the leads he can actually message. */
  out.sort(function(a, b){ return (b.phone ? 1 : 0) - (a.phone ? 1 : 0); });

  /* One log line per search — visible in Cloudflare Workers Logs. Tells us
     where leads are lost: not found, phone not proposed, or phone not
     verifiable. Also logs token usage and tool call counts for cost tracking. */
  try {
    const proposed = Array.isArray(parsed.businesses) ? parsed.businesses : [];
    var _u = data.usage || {};
    var _wsr = (_u.server_tool_use && _u.server_tool_use.web_search_requests) || 0;
    var _wfr = (data.content || []).filter(function(b){ return b.type === 'web_fetch_tool_result'; }).length;
    console.log(JSON.stringify({
      finder: query,
      input_tokens: _u.input_tokens || 0,
      output_tokens: _u.output_tokens || 0,
      web_searches: _wsr,
      web_fetches: _wfr,
      proposed: proposed.length,
      proposedWithPhone: proposed.filter(function(b){ return b && b.phone; }).length,
      kept: out.length,
      keptWithPhone: out.filter(function(b){ return b.phone; }).length,
      fetchedPages: (data.content || []).filter(function(b){ return b.type === 'web_fetch_tool_result' && b.content && b.content.type === 'web_fetch_result'; }).length,
      fetchErrors: (data.content || []).filter(function(b){ return b.type === 'web_fetch_tool_result' && b.content && b.content.type === 'web_fetch_tool_error'; }).length,
      citations: (data.content || []).reduce(function(n, b){ return n + (Array.isArray(b.citations) ? b.citations.length : 0); }, 0),
      corpusChars: corpus.length
    }));
  } catch (e) {}

  return out.slice(0, want);
}

// ─────────────────────────────────────────────────────────────────────────────
// NEWS CATEGORIES — optional feeds shared across firms.
// ─────────────────────────────────────────────────────────────────────────────

const NEWS_CATS = {
  india_policy: {
    label: 'India \u2014 politics & policy',
    ask: 'The most important Indian government, policy, regulatory and political ' +
         'decisions of the last 48 hours that affect businesses. Report what was ' +
         'decided or announced. Neutral and factual \u2014 no opinion, no party framing.',
    domains: ['pib.gov.in','rbi.org.in','sebi.gov.in','finmin.gov.in','business-standard.com',
              'thehindubusinessline.com','financialexpress.com','ndtv.com','ndtvprofit.com',
              'indiatoday.in','theprint.in','deccanherald.com','news18.com']
  },
  india_markets: {
    label: 'Indian stock market',
    ask: 'How Indian markets moved in the last trading session: Nifty 50 and Sensex ' +
         'levels and percentage change, the sectors that led and lagged, and the main ' +
         'reason. Exact figures from the source. Facts only \u2014 never advice or tips.',
    domains: ['nseindia.com','bseindia.com','sebi.gov.in','business-standard.com',
              'thehindubusinessline.com','financialexpress.com','ndtvprofit.com','cnbctv18.com',
              'zeebiz.com','businesstoday.in']
  },
  global: {
    label: 'Global markets & world',
    ask: 'The most important global economic and market news of the last 48 hours: ' +
         'US markets and the Fed, oil, the dollar, major world events that move ' +
         'business. Exact figures from the source. Facts only \u2014 never advice.',
    domains: ['cnbc.com','aljazeera.com','theguardian.com','dw.com','france24.com','npr.org',
              'cnn.com','marketwatch.com','finance.yahoo.com']
  },
  city: {
    label: 'Your city',
    ask: 'The most important news from the last 48 hours in the city named below that ' +
         'affects local life and business: civic decisions, infrastructure, traffic and ' +
         'road work, weather disruption, local events. Only this city.',
    domains: ['amarujala.com','livehindustan.com','patrika.com','ndtv.com','indiatoday.in',
              'news18.com','deccanherald.com','timesnownews.com']
  }
};

/* Facts only, generated once per day per category and shared by every firm
   that chose it (city news once per city). No personal relevance here —
   that is added per firm by personaliseNews. */
async function generateSharedNews(env, cat, day, city, cost) {
  const def = NEWS_CATS[cat];
  if (!def) return { items: [] };
  const citySlug = (city || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  if (cat === 'city' && !citySlug) return { items: [] };
  const cacheKey = 'news:' + cat + (cat === 'city' ? ':' + citySlug : '') + ':' + day;
  const cached = await env.G7_KV.get(cacheKey, 'json');
  if (cached) return cached;

  const system =
    'You are a careful news editor for Indian small-business owners. Today is ' + day + ' (India).\n' +
    def.ask + (cat === 'city' ? '\nCITY: ' + city : '') + '\n\n' +
    'RULES:\n' +
    '- Only events that changed recently: announced, launched, raised, cut, approved, opened, closed.\n' +
    '- No guides, explainers, "how to", "what is", rate tables, checklists.\n' +
    '- Only from pages you actually found. Never invent a fact, figure or date.\n' +
    '- Copy every number exactly as the source states it.\n' +
    '- Nothing older than 48 hours.\n' +
    '- Return 2 to 4 items, most important first.\n' +
    '- sourceUrl must be the article that states the fact, never a home page.\n\n' +
    'Reply with ONLY this JSON:\n' +
    '{"items":[{"headline":"under 12 words","whatHappened":"one sentence, under 30 words",' +
    '"sourceTitle":"","sourceUrl":""}]}';

  /* Publishers that block AI crawlers make the whole request fail. Remember
     each rejected domain for 30 days and retry without it, so a publisher
     changing its policy never breaks a category. */
  const blockedRaw = await env.G7_KV.get('news:blocked-domains', 'json');
  const blocked = new Set(Array.isArray(blockedRaw) ? blockedRaw : []);

  async function ask(domains) {
    const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 };
    if (domains.length) tool.allowed_domains = domains;
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5', max_tokens: 6000, thinking: { type: 'disabled' },
        system: system, tools: [tool],
        messages: [{ role: 'user', content: 'Today\'s ' + def.label + ' news.' }]
      })
    });
  }

  let domains = def.domains.filter(function(d){ return !blocked.has(d); });
  let r = await ask(domains);
  if (r.status === 400) {
    const errText = await r.text();
    const m = errText.match(/not accessible to our user agent: \[([^\]]*)\]/);
    if (!m) throw new Error('shared ' + cat + ' 400: ' + errText.slice(0, 300));
    const rejected = m[1].split(',').map(function(s){ return s.replace(/['"\s]/g, ''); }).filter(Boolean);
    rejected.forEach(function(d){ blocked.add(d); });
    await kvPut(env,'news:blocked-domains', JSON.stringify(Array.from(blocked)), { expirationTtl: 30 * 86400 });
    domains = domains.filter(function(d){ return !blocked.has(d); });
    console.log(JSON.stringify({ newsDomainsBlocked: rejected, category: cat, remaining: domains }));
    /* With fewer than two trusted outlets left, the category is not
       trustworthy enough to show. Return nothing rather than search the
       open web under a "trusted news" label. */
    if (domains.length < 2) return { category: cat, label: def.label, items: [], date: day };
    r = await ask(domains);
  }
  if (!r.ok) throw new Error('shared ' + cat + ' ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const data = await r.json();
  recordCost(cost, 'claude-haiku-5-5', data);

  /* Collect real API metadata: URLs, titles, cited text. */
  const sharedMeta = collectSearchMeta(data);

  /* Join text blocks, parse outermost JSON. */
  const text = (data.content || []).filter(function(b){ return b.type === 'text'; })
    .map(function(b){ return b.text; }).join('');
  let parsed = { items: [] };
  try {
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a !== -1 && z > a) parsed = JSON.parse(text.slice(a, z + 1));
  } catch (e) {}

  /* Integrity gate: URL was returned by web_search, not a home page,
     not a listing/quote portal, not an evergreen guide. */
  var sharedDrops = [];
  const afterIntegrity = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter(function(it) {
      if (!it || !it.headline || !it.sourceUrl) return false;
      if (!sharedMeta.seen.has(it.sourceUrl)) { sharedDrops.push({ headline: it.headline, reason: 'URL not in search results' }); return false; }
      if (isHomePage(it.sourceUrl)) { sharedDrops.push({ headline: it.headline, url: it.sourceUrl, reason: 'home/section page' }); return false; }
      if (isListingOrQuote(it.sourceUrl)) { sharedDrops.push({ headline: it.headline, url: it.sourceUrl, reason: 'listing/quote portal' }); return false; }
      var evg = evergreenCheck(sharedMeta.titles[it.sourceUrl] || it.headline, sharedMeta.pageAge[it.sourceUrl]);
      if (!evg.pass) { sharedDrops.push({ headline: it.headline, url: it.sourceUrl, reason: evg.reason }); return false; }
      return true;
    })
    .slice(0, 6);

  /* Source-match gate: ≥2 meaningful headline words in API title/cited text. */
  const afterSourceMatch = afterIntegrity
    .filter(function(it) {
      var check = sourceMatchCheck(it.headline, it.sourceUrl, sharedMeta);
      if (!check.pass) {
        sharedDrops.push({ headline: it.headline, reason: 'source-match: ' + check.reason });
        return false;
      }
      return true;
    })
    .slice(0, 4)
    .map(function(it) {
      return cleanNewsItem({
        headline: String(it.headline).slice(0, 120),
        whatHappened: clipOneSentence(it.whatHappened),
        sourceTitle: stripCite(String(sharedMeta.titles[it.sourceUrl] || '')).slice(0, 160),
        sourceUrl: it.sourceUrl
      });
    });

  /* Same-topic dedupe within the section. */
  const kept = dedupeItems(afterSourceMatch);
  if (kept.length < afterSourceMatch.length) {
    afterSourceMatch.filter(function(it) { return kept.indexOf(it) === -1; })
      .forEach(function(it) { sharedDrops.push({ headline: it.headline, reason: 'dedupe: duplicate topic' }); });
  }

  if (sharedDrops.length) {
    try { console.log(JSON.stringify({ sharedNewsLog: cat, day: day, candidates: (parsed.items || []).length, kept: kept.length, drops: sharedDrops })); } catch(e){}
  }

  const result = { category: cat, label: def.label, items: kept, date: day };
  await kvPut(env,cacheKey, JSON.stringify(result), { expirationTtl: 172800 });

  /* Persist as last-known-good for fallback when generation fails. */
  if (kept.length > 0) {
    var lastKey = 'news:last:' + cat + (cat === 'city' ? ':' + citySlug : '');
    await kvPut(env,lastKey, JSON.stringify(result));
  }

  return result;
}

/* Per firm, no search: tag every item with why, impact, group, horizon.
   Cheap model — the facts are already verified. */
async function personaliseNews(env, firmCode, day, context, sections, cost) {
  const key = 'news:sig:' + firmCode + ':' + day;
  const cached = await env.G7_KV.get(key, 'json');
  if (cached) return cached;
  const flat = [];
  sections.forEach(function(s, si) {
    (s.items || []).forEach(function(it, ii) {
      flat.push({ id: si + '.' + ii, headline: it.headline, whatHappened: it.whatHappened || it.whyItMatters || '' });
    });
  });
  if (!flat.length) return {};
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-5-5', max_tokens: 2000, thinking: { type: 'disabled' },
      system: 'For each news item, judge what it means for the business described.\n' +
        'Return for each id an object:\n' +
        '  why: ONE sentence under 25 words on the concrete effect on this business, ' +
        'or exactly "No direct effect on your business."\n' +
        '  impact: one of demand_up, demand_down, cost_up, cost_down, lead_source, ' +
        'competitor, regulation, timing, none\n' +
        '  group: the name of the business\'s customer group most affected, copied ' +
        'exactly from the business description, or ""\n' +
        '  horizon: now (this week), weeks, or months\n\n' +
        'STRICT RULES:\n' +
        '- Say "No direct effect on your business." whenever the link would be a stretch. ' +
        'Never invent an effect from unrelated news (politics, celebrity, sport).\n' +
        '- Give an effect ONLY when the news changes this business\'s costs, demand, customers, rules or competitors.\n' +
        '- Local civic issues (water supply, traffic, power cuts, crime, local politics, weather) ' +
        'are "No direct effect on your business." unless they directly change this trade\'s costs, ' +
        'demand, rules or site work for a named customer group in the same week.\n' +
        '- Never invent facts beyond the item. Never give investment or loan advice.\n' +
        'Reply with ONLY JSON: {"<id>":{"why":"","impact":"","group":"","horizon":""}, ...}',
      messages: [{ role: 'user', content: 'BUSINESS:\n' + String(context).slice(0, 2500) +
        '\n\nITEMS:\n' + JSON.stringify(flat) }]
    })
  });
  let out = {};
  if (r.ok) {
    try {
      const d = await r.json();
      recordCost(cost, 'claude-haiku-5-5', d);
      const t = (d.content || []).filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('');
      const a = t.indexOf('{'), z = t.lastIndexOf('}');
      if (a !== -1 && z > a) out = JSON.parse(t.slice(a, z + 1));
    } catch (e) {}
  }
  /* Strip citation markup from every why field. */
  Object.keys(out).forEach(function(k) {
    if (out[k] && out[k].why) out[k].why = stripCite(out[k].why);
  });
  await kvPut(env,key, JSON.stringify(out), { expirationTtl: 172800 });
  return out;
}

/* Resolve effective news prefs. undefined (never chosen) → smart defaults
   by business type bucket. [] (explicitly saved empty) → respected as-is.
   Returns an array of NEWS_CATS keys. */
const NEWS_PRO_TYPES = [
  'Training / Corporate Learning','Digital Marketing Agency','CA / Accounting Firm',
  'Legal Firm / Lawyer','IT Services / Software Company','SaaS / Software Product',
  'Consulting / Advisory Firm','B2B Services','Recruitment / Staffing Firm'
];
async function resolveNewsPrefs(env, firmCode, rawPrefs) {
  if (Array.isArray(rawPrefs)) return rawPrefs;
  /* Never chosen — pick defaults from business type. */
  const st = await loadScoutState(env, firmCode);
  const pend = st ? (st.pick('scout_pending_result') || {}) : {};
  const btype = String((pend.businessData && pend.businessData.businessType) || '');
  /* Exact bucket match (matches onboard.html BT_BUCKET). */
  if (btype && NEWS_PRO_TYPES.indexOf(btype) !== -1) return ['india_policy','india_markets','city'];
  if (btype) return ['india_policy','city']; /* retail, food, personal, trade, Other */
  /* Fallback: keyword heuristic for older accounts without businessType. */
  var typed = String((pend.businessData && pend.businessData.businessTypeInput) || '').toLowerCase();
  var proKw = ['consultant','consulting','agency','lawyer','advocate','ca ','chartered',
    'legal','it services','software','saas','digital','marketing agency'];
  var isPro = proKw.some(function(k){ return typed.indexOf(k) !== -1; });
  return isPro ? ['india_policy','india_markets','city'] : ['india_policy','city'];
}

/* ── assembleNews ──
   Reads cached business brief + shared sections + personalisation tags from KV.
   Builds the final news object (same shape as GET /scout/news returns).
   opts:
     context  — business context string (needed for personaliseNews)
     city     — firm's city
     prefs    — array of NEWS_CATS keys
     cost     — cost accumulator (personaliseNews may make an API call on miss)
     cacheOnly — when true, return null if no business cache exists (never generate)
   All three consumers — GET /scout/news, sendNewsEmail, sendTestNewsEmail —
   call this so they can never drift. */
async function assembleNews(env, firmCode, day, opts) {
  var context = opts.context || '';
  var city = opts.city || '';
  var prefs = opts.prefs || [];
  var cost = opts.cost || newCostAccum();
  var cacheOnly = !!opts.cacheOnly;

  /* ── Business brief ── */
  var business = await env.G7_KV.get('market:' + firmCode + ':' + day, 'json');
  var stale = false;
  if (!business) {
    var last = await lastMarketBrief(env, firmCode, day);
    if (last) { business = last; stale = true; }
    else if (cacheOnly) return null;
  }

  /* ── Shared sections from cache ── */
  var chosen = (Array.isArray(prefs) ? prefs : []).filter(function(c){ return NEWS_CATS[c]; });
  var sections = [];
  var errors = [];
  var citySlug = (city || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  for (var ci = 0; ci < chosen.length; ci++) {
    var c = chosen[ci];
    var cacheKey = 'news:' + c + (c === 'city' ? ':' + citySlug : '') + ':' + day;
    var sec = await env.G7_KV.get(cacheKey, 'json');
    if (!sec) sec = await lastSharedNews(env, c, citySlug);
    if (sec && sec.items && sec.items.length) sections.push(sec);
    else errors.push({ category: c, error: 'no cache' });
  }

  /* Clean citation markup from cached items. */
  if (business && business.items) business.items.forEach(cleanNewsItem);
  sections.forEach(function(s) { if (s.items) s.items.forEach(cleanNewsItem); });

  /* ── Personalisation tags (cached or generated) ── */
  var all = [{ category: 'business', items: (business && business.items) || [] }].concat(sections);
  var sig;
  if (cacheOnly) {
    sig = await env.G7_KV.get('news:sig:' + firmCode + ':' + day, 'json') || {};
  } else {
    sig = await personaliseNews(env, firmCode, day, context, all, cost);
  }
  (all[0].items || []).forEach(function(it, ii) {
    var v = sig['0.' + ii];
    if (typeof v === 'string') v = { why: v, impact: 'none', group: '', horizon: '' };
    if (v) { it.impact = v.impact || 'none'; it.group = v.group || ''; it.horizon = v.horizon || ''; }
  });
  sections.forEach(function(s, si) {
    s.items = (s.items || []).map(function(it, ii) {
      var v = sig[(si + 1) + '.' + ii];
      if (typeof v === 'string') v = { why: v, impact: 'none', group: '', horizon: '' };
      if (v) return Object.assign({}, it, { why: v.why || '', impact: v.impact || 'none', group: v.group || '', horizon: v.horizon || '' });
      return Object.assign({}, it, { why: '' });
    });
  });

  /* ── "Also worth knowing" merge ── */
  var NO_EFFECT = 'No direct effect on your business.';
  var _impactRank = { demand_up:5, demand_down:5, cost_up:4, cost_down:4, regulation:4,
                      competitor:3, timing:3, lead_source:2, none:0 };
  var alsoPool = [];
  sections.forEach(function(s) {
    (s.items || []).forEach(function(it) {
      if (it.impact && it.impact !== 'none' && it.why && it.why.trim() !== NO_EFFECT) {
        alsoPool.push(it);
      }
    });
  });
  alsoPool.sort(function(a, b) {
    return (_impactRank[b.impact] || 0) - (_impactRank[a.impact] || 0);
  });
  var alsoSection = [];
  if (alsoPool.length > 0) {
    alsoSection = [{ category: 'also', label: 'Also worth knowing', items: alsoPool.slice(0, 3) }];
  }

  /* ── Markets today compact lines ── */
  var _marketCats = ['india_markets', 'global'];
  var _marketItems = [];
  _marketCats.forEach(function(mc) {
    if (chosen.indexOf(mc) === -1) return;
    var sec = sections.filter(function(s) { return s.category === mc; })[0];
    if (!sec || !sec.items || !sec.items.length) return;
    _marketItems.push(Object.assign({}, sec.items[0], { _marketLine: true }));
  });
  if (_marketItems.length) {
    if (!alsoSection.length) alsoSection = [{ category: 'also', label: 'Also worth knowing', items: [] }];
    alsoSection[0].items = alsoSection[0].items.concat(_marketItems);
  }

  /* ── Final object ── */
  var bizLog = (business && business._log) || null;
  if (business) delete business._log;
  var out = { business: business, sections: alsoSection, errors: errors, generatedAt: (business && business.generatedAt) || new Date().toISOString() };
  if (stale) { out.stale = true; out.staleDate = (business && business.date) || ''; }
  out._log = bizLog;
  return out;
}

/* Everything a firm reads today: generate business brief + shared categories
   into their caches, then assemble the final object via assembleNews.
   Used by cron, admin regen-news, GET /scout/news, GET /scout/move. */
async function buildDailyNews(env, firmCode, day, context, city, prefs, cost) {
  /* ── Generate business brief ── */
  var stale = false;
  var _genError = null;
  let business = await env.G7_KV.get('market:' + firmCode + ':' + day, 'json');
  if (!business) {
    try {
      business = await generateMarketBrief(env, firmCode, day, context, city, false, false, cost);
    } catch (e) {
      var bizErr = String((e && e.message) || e).slice(0, 300);
      console.log(JSON.stringify({ newsFallback: firmCode, reason: bizErr }));
      if (isBillingError(e)) await sendCreditAlert(env, day);
      /* Tag the error so admin regen can surface it. */
      var _s = 'search';
      if (/watchlist/i.test(bizErr)) _s = 'watchlist';
      else if (/pick|write|sonnet/i.test(bizErr)) _s = 'pick';
      _genError = { stage: _s, reason: bizErr };
    }
  }

  /* ── Generate shared sections ── */
  var chosen = (Array.isArray(prefs) ? prefs : []).filter(function(c){ return NEWS_CATS[c]; });
  var citySlug = (city || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  for (var ci = 0; ci < chosen.length; ci++) {
    var c = chosen[ci];
    var cacheKey = 'news:' + c + (c === 'city' ? ':' + citySlug : '') + ':' + day;
    var cached = await env.G7_KV.get(cacheKey, 'json');
    if (!cached) {
      try {
        await generateSharedNews(env, c, day, city, cost);
      } catch (e) {
        var errMsg = String((e && e.message) || e).slice(0, 300);
        console.log(JSON.stringify({ newsFallback: c, reason: errMsg }));
        if (isBillingError(e)) await sendCreditAlert(env, day);
      }
    }
  }

  /* ── Assemble from caches ── */
  var result = await assembleNews(env, firmCode, day, { context: context, city: city, prefs: prefs, cost: cost });
  if (_genError && result) result._genError = _genError;
  return result;
}

/* One decision per firm per day: the single most useful thing to do today,
   built from news signals, the pipeline, the plan and past moves. No web
   search — every fact it uses was already verified upstream. */
async function generateScoutMove(env, firmCode, day, context, news, st, force, cost) {
  const cacheKey = 'move:' + firmCode + ':' + day;
  if (!force) {
    const cached = await env.G7_KV.get(cacheKey, 'json');
    if (cached) return cached;
  }

  /* Signals: business items plus section items with a real effect. Numbered. */
  const signals = [];
  ((news && news.business && news.business.items) || []).forEach(function(it) {
    signals.push({ i: signals.length, headline: it.headline, what: it.whatHappened, why: it.whyItMatters,
                   impact: it.impact || 'none', group: it.group || '', horizon: it.horizon || '',
                   sourceTitle: it.sourceTitle || '', sourceUrl: it.sourceUrl || '' });
  });
  ((news && news.sections) || []).forEach(function(s) {
    (s.items || []).forEach(function(it) {
      if (it.impact && it.impact !== 'none') {
        signals.push({ i: signals.length, headline: it.headline, what: it.whatHappened, why: it.why,
                       impact: it.impact, group: it.group || '', horizon: it.horizon || '',
                       sourceTitle: it.sourceTitle || '', sourceUrl: it.sourceUrl || '' });
      }
    });
  });

  /* Pipeline summary — counts and the people due, never phone numbers. */
  const pend = st ? (st.pick('scout_pending_result') || {}) : {};
  const bizName = (pend.businessData && pend.businessData.businessName) || '';
  const pipeline = st ? st.pick('scout_pipeline') : null;
  const people = (pipeline && Array.isArray(pipeline.people)) ? pipeline.people : [];
  const counts = {};
  people.forEach(function(p){ counts[p.status] = (counts[p.status] || 0) + 1; });
  const _bkt = (st ? st.pick('scout_bucket') : null) || 'retail';
  const _rsRaw2 = st ? st.pick('scout_review_skip') : null;
  const _rskip = _rsRaw2 === true || _rsRaw2 === 'true';
  const due = pipelineDueFromStore(pipeline, Date.now(), bizName, _bkt, _rskip).slice(0, 5)
    .map(function(d){ return { name: (d.person && d.person.name) || '', status: d.person && d.person.status, reason: d.reason }; });

  /* Today's plan step and the customer group names. */
  let analysis = {};
  try {
    analysis = typeof pend.scoutOutput === 'string'
      ? JSON.parse(pend.scoutOutput.replace(/^```json\s*/i,'').replace(/```\s*$/,'').trim())
      : (pend.scoutOutput || {});
  } catch (e) {}
  const weekday = new Date(day + 'T06:00:00+05:30').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Kolkata' });
  const days = (analysis.tab3 && Array.isArray(analysis.tab3.days)) ? analysis.tab3.days : [];
  const step = days.filter(function(d){ return d.day && d.day.toLowerCase() === weekday.toLowerCase(); })[0] || null;
  const groups = (analysis.tab1 && Array.isArray(analysis.tab1.icps)) ? analysis.tab1.icps.map(function(g){ return g.name; }) : [];

  /* Resolve message language. */
  const user = await env.G7_KV.get('auth:users:' + firmCode, 'json') || {};
  var msgLang = user.messageLanguage || '';
  if (!msgLang) {
    msgLang = (pend.businessData && pend.businessData.language) || 'Hinglish';
    if (/regional/i.test(msgLang)) msgLang = 'Hinglish';
  }

  /* Recent moves, so it does not repeat itself. */
  const history = (await env.G7_KV.get('move:history:' + firmCode, 'json')) || [];
  const recent = history.slice(-7).map(function(h){ return { date: h.date, headline: h.headline, status: h.status || 'suggested' }; });

  const system =
    'You are Scout, the business-development employee for one Indian small business. ' +
    'Today is ' + weekday + ', ' + day + '. Decide the ONE most useful move the owner ' +
    'should make today to win customers or protect margins.\n\n' +
    'HOW TO DECIDE:\n' +
    '- Prefer signal 0 (the top business news item) when it has a clear group effect — ' +
    'it is the most relevant to this firm. Otherwise pick another signal with horizon ' +
    '"now" and a clear effect on a named customer group. A strong signal can change ' +
    'WHICH group to target this week, WHAT to say, or HOW to price and quote.\n' +
    '- If no signal is strong, base the move on the pipeline (who is due) or the plan step.\n' +
    '- The move adjusts the plan; it never contradicts it without saying why.\n' +
    '- Do not repeat any recent move unless something new justifies it.\n\n' +
    'RULES:\n' +
    '- Exactly one move. Concrete, doable today, in under an hour where possible.\n' +
    '- reason must name what it is based on: a specific news headline, or a pipeline fact.\n' +
    '- Never invent numbers, names or facts not given to you.\n' +
    '- Never give investment, stock or loan advice.\n' +
    '- message: a WhatsApp message the owner sends to customers or partners. ' +
    'Write it in ' + msgLang + '. Hinglish = Hindi words in Roman script mixed with English. ' +
    'Under 60 words, warm and specific, never mentioning news websites, never spammy.\n' +
    '- If the move needs no message, return message as "".\n' +
    '- Write headline and action directly to the owner, as instructions: ' +
    '"Call the tender desk today", never "The owner should…".\n' +
    '- group must be copied exactly from CUSTOMER GROUPS, or "" if the move ' +
    'is not about one of them.\n\n' +
    'Reply with ONLY this JSON:\n' +
    '{"headline":"under 12 words","reason":"one sentence","action":"one or two sentences",' +
    '"group":"customer group name or \\"\\"","message":"","basedOn":"news | pipeline | plan",' +
    '"signal": "<the i of the news signal the move is based on, or -1>",' +
    '"confidence":"high | medium | low"}';

  const userMsg =
    'BUSINESS:\n' + String(context).slice(0, 2500) +
    '\n\nCUSTOMER GROUPS: ' + JSON.stringify(groups) +
    '\n\nNEWS SIGNALS:\n' + JSON.stringify(signals) +
    '\n\nPIPELINE: counts ' + JSON.stringify(counts) + '; due today ' + JSON.stringify(due) +
    '\n\nTODAY\'S PLAN STEP: ' + (step ? JSON.stringify({ action: step.action, target: step.target }) : 'none') +
    '\n\nRECENT MOVES: ' + JSON.stringify(recent);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 6000, thinking: { type: 'between_tools' },
                           system: system, messages: [{ role: 'user', content: userMsg }] })
  });
  if (!r.ok) throw new Error('move ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const d = await r.json();
  recordCost(cost, 'claude-sonnet-5-5', d);
  const t = (d.content || []).filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('');
  let mv = null;
  try {
    const a = t.indexOf('{'), z = t.lastIndexOf('}');
    if (a !== -1 && z > a) mv = JSON.parse(t.slice(a, z + 1));
  } catch (e) {}
  if (!mv || !mv.headline || !mv.action) throw new Error('move: unparseable');

  const sigIdx = typeof mv.signal === 'number' ? mv.signal : parseInt(mv.signal, 10);
  const sig = (!isNaN(sigIdx) && signals[sigIdx]) ? signals[sigIdx] : null;
  var mvBasedOn = ['news','pipeline','plan'].indexOf(mv.basedOn) !== -1 ? mv.basedOn : 'plan';
  if (mvBasedOn === 'news' && !sig) mvBasedOn = 'plan';
  var mvGroup = String(mv.group || '').slice(0, 120);
  if (mvGroup && groups.indexOf(mvGroup) === -1) mvGroup = '';

  const move = {
    date: day,
    headline: String(mv.headline).slice(0, 120),
    reason: clip(mv.reason, 300),
    action: clip(mv.action, 400),
    group: mvGroup,
    message: String(mv.message || '').slice(0, 600),
    basedOn: mvBasedOn,
    sourceTitle: sig ? String(sig.sourceTitle || sig.headline || '').slice(0, 160) : '',
    sourceUrl: sig && /^https:\/\//i.test(sig.sourceUrl || '') ? sig.sourceUrl : '',
    confidence: ['high','medium','low'].indexOf(mv.confidence) !== -1 ? mv.confidence : 'medium',
    status: 'suggested'
  };
  await kvPut(env,cacheKey, JSON.stringify(move), { expirationTtl: 172800 });
  const nextHist = history.concat([{ date: day, headline: move.headline, basedOn: move.basedOn, status: 'suggested' }]).slice(-30);
  await kvPut(env,'move:history:' + firmCode, JSON.stringify(nextHist));
  return move;
}

// ─────────────────────────────────────────────────────────────────────────────
// NAMED EXPORTS — used by scripts/news-test.mjs to test the news pipeline
// without deploying to Cloudflare. Not used by the Worker runtime.
// ─────────────────────────────────────────────────────────────────────────────
export {
  newCostAccum, recordCost, flushCost, kvPut,
  buildWatchlist, getWatchlist, searchBusinessNews, pickAndWriteNews,
  generateMarketBrief, buildDailyNews, assembleNews, generateSharedNews, personaliseNews,
  resolveNewsPrefs, collectSearchMeta, cleanNewsItem, stripCite, clip,
  clipOneSentence, dedupeItems, sourceMatchCheck, failsRelevanceGate,
  checkPageAge, evergreenCheck, isHomePage, isListingOrQuote, lastMarketBrief,
  lastSharedNews, shortHash, watchlistHash, isBillingError,
  renderNewsBody, newsGreetingName, displayName,
  TRUSTED_NEWS_DOMAINS, COST_TABLE, NEWS_CATS
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {

    // Normalise pathname — strip trailing slash so /auth/login and
    // /auth/login/ both match
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // ── CORS preflight ────────────────────────────────────────────────────────
    // Browser sends OPTIONS before every cross-origin request.
    // Must respond 204 with CORS headers or the real request will be blocked.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    // GET / returns a simple alive signal. Useful for verifying the worker
    // is deployed and reachable without needing auth.
    if (request.method === 'GET' && path === '/') {
      return jsonResponse({ status: 'G7 Proxy is running' });
    }

    // =========================================================================
    // ROUTE 1 — POST /api/message
    // Anthropic API proxy. Adds API key server-side so it is never
    // exposed to the browser. Session token required.
    // =========================================================================
    if (request.method === 'POST' && path === '/api/message') {

      // Validate session before proxying — reject unauthenticated requests
      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized — valid session token required' }, 401);
      }

      // Parse and validate the request body
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      // ── Deal usage limit ──────────────────────────────────────────────────────
      // Only check and increment on the FIRST call of a deal submission
      // (messages.length === 1). Subsequent tool_use continuation calls
      // have more messages and are part of the same deal — do not count them.
      const DEAL_LIMIT = 50;
      const isFirstCall = Array.isArray(body.messages) && body.messages.length === 1;

      if (isFirstCall) {
        const usageKey = 'usage:' + session.firmCode + ':deals';
        const currentUsage = await env.G7_KV.get(usageKey, 'json') || { count: 0 };

        if (currentUsage.count >= DEAL_LIMIT) {
          return jsonResponse({
            error:   'deal_limit_reached',
            message: 'Your firm has reached the ' + DEAL_LIMIT + ' deal limit for the ' +
                     'beta period. Contact your G7 Capital administrator to increase your limit.',
            count:   currentUsage.count,
            limit:   DEAL_LIMIT
          }, 429);
        }
      }

      // WEB SEARCH ENFORCEMENT
      // Currently disabled on frontend — callAlexDirect() sends no tools array.
      // This enforcement remains in place in case search is re-enabled in future.
      // Max searches when re-enabled: 3
      // To re-enable on frontend: change callAlexDirect to callAlexWithSearch
      // in workspace/submit.html submit handler.
      if (body.tools && Array.isArray(body.tools)) {
        body.tools = body.tools.map(tool => {
          if (tool.type === 'web_search_20250305' || tool.name === 'web_search') {
            // Respect the frontend's dynamic max_uses (1–3), hard cap at 3
            return { ...tool, max_uses: Math.min(tool.max_uses || 3, 3) };
          }
          return tool;
        });
      }

      // Forward to Anthropic — API key added here server-side,
      // never visible to the browser
      let anthropicResponse;
      try {
        anthropicResponse = await fetch(ANTHROPIC_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'prompt-caching-2024-07-31'
          },
          body: JSON.stringify(body)
        });
      } catch {
        return jsonResponse({ error: 'Failed to reach Anthropic API' }, 502);
      }

      // Increment deal counter before streaming — anthropicResponse.ok and
      // anthropicResponse.status are available immediately without reading the body.
      // KV write is fire-and-forget so it does not delay the response.
      if (isFirstCall && anthropicResponse.ok) {
        const usageKey = 'usage:' + session.firmCode + ':deals';
        const currentUsage = await env.G7_KV.get(usageKey, 'json') || { count: 0 };
        kvPut(env,usageKey, JSON.stringify({
          count:    currentUsage.count + 1,
          lastUsed: Date.now(),
          firmCode: session.firmCode
        })); // intentionally not awaited — best-effort, does not block response
      }

      // Stream Anthropic's response body directly to the browser.
      // Replaces the previous await anthropicResponse.text() buffering approach,
      // which caused Cloudflare's 30-second wall-clock timeout at max_tokens=6000.
      // Streaming forwards bytes as they arrive — no timeout risk regardless of output length.
      return new Response(anthropicResponse.body, {
        status: anthropicResponse.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // =========================================================================
    // ROUTE 2 — POST /auth/login
    // Validates firmCode + password, creates a 7-day session token in KV,
    // returns the token to the client for use in subsequent requests.
    // =========================================================================
    if (request.method === 'POST' && path === '/auth/login') {

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { firmCode, password } = body;
      if (!firmCode || !password) {
        return jsonResponse({ error: 'firmCode and password are required' }, 400);
      }

      // Normalize firmCode to uppercase so G7CAP and g7cap both work
      const normalizedCode = firmCode.toUpperCase().trim();

      // Look up the firm in KV
      const user = await env.G7_KV.get('auth:users:' + normalizedCode, 'json');
      if (!user) {
        // Return same error message as wrong password — prevents user enumeration
        return jsonResponse({ error: 'Invalid credentials' }, 401);
      }

      // Verify the submitted password against stored hash (PBKDF2 or legacy SHA-256)
      const check = await verifyPassword(password, user.passwordHash);
      if (!check.ok) {
        return jsonResponse({ error: 'Invalid credentials' }, 401);
      }

      /* Old-format hash verified — rewrite it as PBKDF2 now. */
      if (check.needsUpgrade) {
        try {
          const upgraded = await hashPassword(password);
          await kvPut(env,'auth:users:' + normalizedCode, JSON.stringify(
            Object.assign({}, user, { passwordHash: upgraded, hashUpgradedAt: Date.now() })
          ));
        } catch (e) { /* non-blocking — login proceeds either way */ }
      }

      // Generate a session token — two UUIDs joined for extra length
      const token = crypto.randomUUID() + '-' + crypto.randomUUID();

      // Store session in KV with 7-day TTL
      // expiresAt is checked on each request; Cloudflare also auto-deletes
      // the key after expirationTtl seconds as a backup cleanup mechanism
      await kvPut(env,
        'auth:sessions:' + token,
        JSON.stringify({
          firmCode: normalizedCode,
          firmName: user.firmName,
          createdAt: Date.now(),
          expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days in ms
        }),
        { expirationTtl: 604800 } // 7 days in seconds — Cloudflare TTL
      );

      return jsonResponse({
        token,
        firmCode: normalizedCode,
        firmName: user.firmName,
        mustChangePassword: !user.passwordSetByUser
      });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /auth/change-password
    // Session-protected. The user replaces an admin-set password with
    // their own, and optionally records a recovery email.
    // Body: { currentPassword, newPassword, recoveryEmail? }
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/auth/change-password') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'Your session has expired. Please sign in again.' }, 401);

      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Invalid request.' }, 400); }

      const currentPassword = body.currentPassword || '';
      const newPassword     = body.newPassword || '';
      const recoveryEmail   = (body.recoveryEmail || '').trim().toLowerCase();

      if (newPassword.length < 8) {
        return jsonResponse({ error: 'Your new password must be at least 8 characters.' }, 400);
      }
      if (newPassword === currentPassword) {
        return jsonResponse({ error: 'Choose a password different from the one you were given.' }, 400);
      }
      if (recoveryEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail)) {
        return jsonResponse({ error: 'That email address does not look right.' }, 400);
      }

      const key = 'auth:users:' + session.firmCode;
      const user = await env.G7_KV.get(key, 'json');
      if (!user) return jsonResponse({ error: 'Account not found.' }, 404);

      const check = await verifyPassword(currentPassword, user.passwordHash);
      if (!check.ok) return jsonResponse({ error: 'Your current password is not correct.' }, 401);

      const updated = Object.assign({}, user, {
        passwordHash: await hashPassword(newPassword),
        passwordSetByUser: true,
        passwordChangedAt: Date.now()
      });
      if (recoveryEmail) updated.recoveryEmail = recoveryEmail;

      await kvPut(env,key, JSON.stringify(updated));
      return jsonResponse({ success: true });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /auth/forgot-password
    // Body: { firmCode }
    // Always returns the same response, whether or not the firm exists
    // or has a recovery email — anything else confirms which codes exist.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/auth/forgot-password') {
      const generic = jsonResponse({ success: true });
      let body;
      try { body = await request.json(); } catch { return generic; }
      const code = (body.firmCode || '').toUpperCase().trim();
      if (!code) return generic;

      /* Three requests per firm per hour. Stops inbox flooding and quota burn. */
      const rlKey = 'auth:reset-rl:' + code;
      const rlCount = parseInt((await env.G7_KV.get(rlKey)) || '0', 10);
      if (rlCount >= 3) return generic;
      await kvPut(env,rlKey, String(rlCount + 1), { expirationTtl: 3600 });

      const user = await env.G7_KV.get('auth:users:' + code, 'json');
      if (!user || !user.recoveryEmail) return generic;

      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Array.from(tokenBytes).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
      await kvPut(env,'auth:reset:' + token,
        JSON.stringify({ firmCode: code, createdAt: Date.now() }),
        { expirationTtl: 1800 });

      const link = resetBaseUrl(request) + '/reset-password.html#t=' + token;
      const name = displayName(user, code);
      const text =
        'Hi ' + name + ',\n\n' +
        'Someone asked to reset the password for your G7 account (' + code + ').\n\n' +
        'Reset it here — this link works once and expires in 30 minutes:\n' + link + '\n\n' +
        'If this was not you, ignore this email. Your password has not changed.\n\n' +
        '— G7 Capital';
      const html =
        '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#222;line-height:1.6">' +
        '<p>Hi ' + name.replace(/</g,'&lt;') + ',</p>' +
        '<p>Someone asked to reset the password for your G7 account (<b>' + code + '</b>).</p>' +
        '<p><a href="' + link + '" style="display:inline-block;background:#C9A84C;color:#080808;padding:12px 22px;text-decoration:none;letter-spacing:.08em">Reset my password</a></p>' +
        '<p style="font-size:13px;color:#666">This link works once and expires in 30 minutes. If this was not you, ignore this email — your password has not changed.</p>' +
        '<p style="font-size:13px;color:#666">— G7 Capital</p></div>';

      await sendEmail(env, user.recoveryEmail, 'Reset your G7 password', text, html);
      return generic;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /auth/reset-password
    // Body: { token, newPassword }
    // One-time: the token is deleted the moment it is used.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/auth/reset-password') {
      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Invalid request.' }, 400); }

      const token = (body.token || '').trim();
      const newPassword = body.newPassword || '';
      if (!token) return jsonResponse({ error: 'This reset link is not valid.' }, 400);
      if (newPassword.length < 8) {
        return jsonResponse({ error: 'Your new password must be at least 8 characters.' }, 400);
      }

      const rec = await env.G7_KV.get('auth:reset:' + token, 'json');
      if (!rec) {
        return jsonResponse({ error: 'This link has expired or has already been used. Request a new one.' }, 400);
      }

      /* Burn the token before anything else, so it cannot be replayed. */
      await env.G7_KV.delete('auth:reset:' + token);

      const key = 'auth:users:' + rec.firmCode;
      const user = await env.G7_KV.get(key, 'json');
      if (!user) return jsonResponse({ error: 'Account not found.' }, 404);

      await kvPut(env,key, JSON.stringify(Object.assign({}, user, {
        passwordHash: await hashPassword(newPassword),
        passwordSetByUser: true,
        passwordChangedAt: Date.now()
      })));

      return jsonResponse({ success: true, firmCode: rec.firmCode, product: user.product || '' });
    }

    // =========================================================================
    // ROUTE 3 — POST /auth/logout
    // Deletes the session token from KV, invalidating it immediately.
    // =========================================================================
    if (request.method === 'POST' && path === '/auth/logout') {

      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return jsonResponse({ error: 'No session token provided' }, 400);
      }

      const token = authHeader.slice(7);

      // Delete the session — if it doesn't exist, that's fine (idempotent)
      await env.G7_KV.delete('auth:sessions:' + token);

      return jsonResponse({ success: true });
    }

    // =========================================================================
    // ROUTE 4 — GET /auth/validate
    // Checks whether a session token is still valid and returns firm identity.
    // Used by the frontend on page load to restore session state.
    // =========================================================================
    if (request.method === 'GET' && path === '/auth/validate') {

      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ valid: false }, 401);
      }

      return jsonResponse({
        valid: true,
        firmCode: session.firmCode,
        firmName: session.firmName
      });
    }

    // =========================================================================
    // ROUTE 5 — POST /data/save
    // Saves firm data to KV under the firm's own namespace.
    // Session required — firms can only write to their own keys.
    //
    // Valid types and resulting KV keys:
    //   'config'       → firms:{CODE}:config
    //   'kb'           → firms:{CODE}:kb
    //   'deals'        → firms:{CODE}:deals
    //   'calibrations' → firms:{CODE}:calibrations
    // =========================================================================
    if (request.method === 'POST' && path === '/data/save') {

      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized — valid session token required' }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { type, data } = body;

      // Validate type — only these four are accepted
      const validTypes = ['config', 'kb', 'deals', 'calibrations', 'scout_state'];
      if (!type || !validTypes.includes(type)) {
        return jsonResponse({
          error: 'Invalid type. Must be one of: config, kb, deals, calibrations'
        }, 400);
      }

      // Construct the KV key scoped to this firm
      const key = 'firms:' + session.firmCode + ':' + type;

      // Save to KV — no TTL on firm data, it persists until explicitly deleted
      await kvPut(env,key, JSON.stringify(data));

      return jsonResponse({ success: true });
    }

    // =========================================================================
    // ROUTE 6 — GET /data/load
    // Loads firm data from KV by type.
    // Session required — firms can only read their own keys.
    //
    // Query parameter: ?type=config (or kb, deals, calibrations)
    // Returns: { data: <value> } or { data: null } if not yet saved
    // =========================================================================
    if (request.method === 'GET' && path === '/data/load') {

      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized — valid session token required' }, 401);
      }

      const type = url.searchParams.get('type');

      // Validate type
      const validTypes = ['config', 'kb', 'deals', 'calibrations', 'scout_state'];
      if (!type || !validTypes.includes(type)) {
        return jsonResponse({
          error: 'Invalid type. Must be one of: config, kb, deals, calibrations'
        }, 400);
      }

      // Construct the KV key scoped to this firm
      const key = 'firms:' + session.firmCode + ':' + type;

      // Load from KV — returns null if the key does not exist yet
      const raw = await env.G7_KV.get(key, 'json');

      return jsonResponse({ data: raw || null });
    }

    // =========================================================================
    // ROUTE 7 — POST /admin/create-firm
    // Creates a new firm account in KV.
    // Protected by ADMIN_PASSWORD environment variable — not a session token.
    // =========================================================================
    if (request.method === 'POST' && path === '/admin/create-firm') {

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { adminPassword, firmCode, firmName, password, product: rawProduct, plan: rawPlan } = body;
      const product = (rawProduct === 'scout') ? 'scout' : 'alex';
      const plan = (rawPlan === 'paid') ? 'paid' : 'free';

      // Validate admin password against environment variable
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      // Validate required fields
      if (!firmCode || !firmName || !password) {
        return jsonResponse({ error: 'firmCode, firmName, and password are required' }, 400);
      }

      // Normalize firmCode to uppercase
      const normalizedCode = firmCode.toUpperCase().trim();

      // Hash the firm's login password for storage
      const passwordHash = await hashPassword(password);

      // Store the firm user record in KV
      await kvPut(env,
        'auth:users:' + normalizedCode,
        JSON.stringify({
          firmName,
          passwordHash,
          createdAt: Date.now(),
          product,
          plan,
          tier: product === 'scout' ? 'scout' : 'beta'
        })
      );

      // Initialise empty firm data stores so /data/load always returns
      // an array (never null) for these two high-frequency keys
      await kvPut(env,
        'firms:' + normalizedCode + ':deals',
        JSON.stringify([])
      );
      await kvPut(env,
        'firms:' + normalizedCode + ':calibrations',
        JSON.stringify([])
      );

      return jsonResponse({
        success: true,
        firmCode: normalizedCode,
        firmName
      });
    }

    // =========================================================================
    // ROUTE 8 — GET /admin/list-firms
    // Returns a list of all firm accounts in KV, enriched with cron/email/lastSeen data.
    // Protected by ?adminPassword=xxx query parameter.
    // =========================================================================
    if (request.method === 'GET' && path === '/admin/list-firms') {

      const adminPassword = url.searchParams.get('adminPassword');

      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      const list = await env.G7_KV.list({ prefix: 'auth:users:' });

      /* Load cron:last once — used to attach per-firm last-run info */
      const cronLast = await env.G7_KV.get('cron:last', 'json');
      const cronFirmMap = {};
      if (cronLast && Array.isArray(cronLast.firms)) {
        cronLast.firms.forEach(function(f) { cronFirmMap[f.firm] = f; });
      }

      /* Global pause state */
      const cronPausedGlobal = (await env.G7_KV.get('cron:paused')) === '1';

      const firms = await Promise.all(
        list.keys.map(async (key) => {
          const user = await env.G7_KV.get(key.name, 'json');
          const firmCode = key.name.replace('auth:users:', '');
          const ep = emailPrefs(user);
          const lastSeen = await env.G7_KV.get('scout:lastSeen:' + firmCode);
          const cronEntry = cronFirmMap[firmCode] || null;
          return {
            firmCode,
            firmName: user ? user.firmName : 'Unknown',
            createdAt: user ? user.createdAt : null,
            tier: user ? user.tier : null,
            plan: user ? user.plan : null,
            product: user ? user.product : null,
            cronPaused: !!(user && user.cronPaused),
            isTest: !!(user && user.isTest),
            emailActions: ep.actions,
            emailNews: ep.news,
            lastSeen: lastSeen || null,
            lastRun: cronEntry
          };
        })
      );

      return jsonResponse({ firms, cronPausedGlobal, cronLastDay: cronLast ? cronLast.day : null,
        cronLastState: cronLast ? cronLast.state : null,
        cronFinishedAt: cronLast ? cronLast.finishedAt : null });
    }

    // ── POST /admin/set-firm-flags ──────────────────────────────────────────
    // Updates cronPaused and/or isTest on a firm's user record.
    // Body: { adminPassword, firmCode, cronPaused?: bool, isTest?: bool }
    if (request.method === 'POST' && path === '/admin/set-firm-flags') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
      if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden' }, 403);
      }
      const firmCode = String(body.firmCode || '').toUpperCase().trim();
      if (!firmCode) return jsonResponse({ error: 'firmCode required' }, 400);
      const user = await env.G7_KV.get('auth:users:' + firmCode, 'json');
      if (!user) return jsonResponse({ error: 'Firm not found' }, 404);
      if (typeof body.cronPaused === 'boolean') user.cronPaused = body.cronPaused;
      if (typeof body.isTest === 'boolean') user.isTest = body.isTest;
      await kvPut(env, 'auth:users:' + firmCode, JSON.stringify(user));
      return jsonResponse({ success: true, firmCode, cronPaused: !!user.cronPaused, isTest: !!user.isTest });
    }

    // ── POST /admin/cron-pause ───────────────────────────────────────────────
    // Global kill switch for the 6am morning job.
    // Body: { adminPassword, paused: true|false }
    if (request.method === 'POST' && path === '/admin/cron-pause') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
      if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden' }, 403);
      }
      if (body.paused) {
        await kvPut(env, 'cron:paused', '1');
      } else {
        await env.G7_KV.delete('cron:paused');
      }
      return jsonResponse({ success: true, paused: !!body.paused });
    }

    // POST /admin/test-news-email — { adminPassword, firmCode }
    // Renders today's cached news as an email and sends to ADMIN_EMAIL only.
    // No generation — uses whatever is already in KV.
    if (request.method === 'POST' && path === '/admin/test-news-email') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Invalid admin password' }, 403);
      }
      const firmCode = String(body.firmCode || '').toUpperCase().trim();
      if (!firmCode) return jsonResponse({ error: 'firmCode required' }, 400);
      try {
        var result = await sendTestNewsEmail(env, firmCode);
        return jsonResponse(result);
      } catch (e) {
        return jsonResponse({ error: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // ── ROUTE 9 — POST /admin/reset-password ──────────────────────────────────
    if (request.method === 'POST' && path === '/admin/reset-password') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      const { adminPassword, firmCode, newPassword } = body;

      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      const normalizedCode = (firmCode || '').toUpperCase().trim();
      if (!normalizedCode) {
        return jsonResponse({ error: 'firmCode is required' }, 400);
      }
      if (!newPassword || newPassword.length < 6) {
        return jsonResponse({ error: 'newPassword must be at least 6 characters' }, 400);
      }

      const user = await env.G7_KV.get('auth:users:' + normalizedCode, 'json');
      if (!user) {
        return jsonResponse({ error: 'Firm not found: ' + normalizedCode }, 404);
      }

      const newHash = await hashPassword(newPassword);
      await kvPut(env,'auth:users:' + normalizedCode, JSON.stringify({
        ...user,
        passwordHash: newHash,
        passwordResetAt: Date.now(),
        passwordSetByUser: false
      }));

      return jsonResponse({ success: true, firmCode: normalizedCode });
    }

    // ── ROUTE 10 — GET /admin/firm-usage ──────────────────────────────────────
    // Returns the deal usage count for a specific firm.
    // Query params: firmCode, adminPassword
    if (request.method === 'GET' && path === '/admin/firm-usage') {
      const adminPassword = url.searchParams.get('adminPassword');
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      const firmCode = (url.searchParams.get('firmCode') || '').toUpperCase().trim();
      if (!firmCode) {
        return jsonResponse({ error: 'firmCode query parameter is required' }, 400);
      }

      const usageKey = 'usage:' + firmCode + ':deals';
      const usage = await env.G7_KV.get(usageKey, 'json') || { count: 0 };

      return jsonResponse({
        firmCode,
        count:    usage.count,
        limit:    50,
        lastUsed: usage.lastUsed || null
      });
    }

    // ── ROUTE 11 — POST /admin/reset-usage ────────────────────────────────────
    // Resets the deal usage counter for a specific firm to zero.
    // Body: { adminPassword, firmCode }
    if (request.method === 'POST' && path === '/admin/reset-usage') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      const { adminPassword, firmCode } = body;
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      const normalizedCode = (firmCode || '').toUpperCase().trim();
      if (!normalizedCode) {
        return jsonResponse({ error: 'firmCode is required' }, 400);
      }

      await env.G7_KV.delete('usage:' + normalizedCode + ':deals');

      return jsonResponse({ success: true, firmCode: normalizedCode });
    }

    // ── POST /admin/run-morning ──────────────────────────────────────────────
    // Runs the morning job for one firm now. For testing without waiting
    // for 06:00. Same code path as the scheduled job.
    // Body: { adminPassword, firmCode }
    if (request.method === 'POST' && path === '/admin/run-morning') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Invalid admin password' }, 403);
      }
      const firmCode = String(body.firmCode || '').toUpperCase().trim();
      if (!firmCode) return jsonResponse({ error: 'firmCode required' }, 400);
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = ist.toISOString().slice(0, 10);
      try {
        const result = await runMorningForFirm(env, firmCode, day);
        if (typeof result === 'string') return jsonResponse({ firmCode: firmCode, day: day, status: result });
        return jsonResponse({ firmCode: firmCode, day: day, status: result.status, cost: result.cost });
      } catch (e) {
        return jsonResponse({ error: 'run_failed', detail: String(e.message || '').slice(0, 300) }, 500);
      }
    }

    // POST /admin/regen-move — { adminPassword, firmCode }
    // Regenerates today's move for one firm, ignoring the cached one.
    // For tuning the move prompt without deleting KV keys by hand.
    if (request.method === 'POST' && path === '/admin/regen-move') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Invalid admin password' }, 403);
      }
      const firmCode = String(body.firmCode || '').toUpperCase().trim();
      if (!firmCode) return jsonResponse({ error: 'firmCode required' }, 400);
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = ist.toISOString().slice(0, 10);
      const saved = await env.G7_KV.get('market:ctx:' + firmCode, 'json');
      if (!saved || !saved.context) return jsonResponse({ error: 'no_context' }, 404);
      /* Admin regen — exempt from feature gates and budget guard. */
      var cost = newCostAccum();
      try {
        const user = await env.G7_KV.get('auth:users:' + firmCode, 'json') || {};
        const news = await buildDailyNews(env, firmCode, day, saved.context, saved.city || '', user.newsPrefs, cost);
        const st = await loadScoutState(env, firmCode);
        const move = await generateScoutMove(env, firmCode, day, saved.context, news, st, true, cost);
        ctx.waitUntil(flushCost(env, day, firmCode, cost));
        return jsonResponse({ move: move });
      } catch (e) {
        ctx.waitUntil(flushCost(env, day, firmCode, cost));
        return jsonResponse({ error: 'regen_failed', detail: String((e && e.message) || e).slice(0, 300) }, 500);
      }
    }

    // POST /admin/regen-news — { adminPassword, firmCode, shared?: bool }
    // Deletes today's business + personalisation cache and regenerates.
    // If shared:true, also deletes shared category caches for the day.
    // Returns the news result plus the newsLog summary.
    if (request.method === 'POST' && path === '/admin/regen-news') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Invalid admin password' }, 403);
      }
      const firmCode = String(body.firmCode || '').toUpperCase().trim();
      if (!firmCode) return jsonResponse({ error: 'firmCode required' }, 400);
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = ist.toISOString().slice(0, 10);
      const saved = await env.G7_KV.get('market:ctx:' + firmCode, 'json');
      if (!saved || !saved.context) return jsonResponse({ error: 'no_context' }, 404);
      try {
        /* Delete business brief cache + personalisation tags + watchlist (force rebuild). */
        await env.G7_KV.delete('market:' + firmCode + ':' + day);
        await env.G7_KV.delete('news:sig:' + firmCode + ':' + day);
        await env.G7_KV.delete('market:watch:' + firmCode);

        /* Optionally nuke shared category caches too. */
        if (body.shared) {
          var citySlug = (saved.city || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
          for (var catKey of Object.keys(NEWS_CATS)) {
            var sharedCacheKey = 'news:' + catKey + (catKey === 'city' ? ':' + citySlug : '') + ':' + day;
            await env.G7_KV.delete(sharedCacheKey);
          }
        }

        const user = await env.G7_KV.get('auth:users:' + firmCode, 'json') || {};
        const effectivePrefs = await resolveNewsPrefs(env, firmCode, user.newsPrefs);
        /* Admin regen — exempt from feature gates and budget guard. */
        var cost = newCostAccum();
        var news = null, _regenFallback = null;
        try {
          news = await buildDailyNews(env, firmCode, day, saved.context, saved.city || '', effectivePrefs, cost);
        } catch (e) {
          var _errMsg = String((e && e.message) || e).slice(0, 300);
          _regenFallback = { fallback: true, stage: 'assemble', reason: _errMsg };
        }

        /* Prefer the structured _genError from buildDailyNews over guessing. */
        if (news && news._genError && !_regenFallback) {
          _regenFallback = { fallback: true, stage: news._genError.stage, reason: news._genError.reason };
        }

        /* Detect soft failures: stale, placeholder, _fromDay (last-good fallback), or missing. */
        if (news && !_regenFallback) {
          var _bizItems = (news.business && news.business.items) || [];
          if (news.stale) {
            _regenFallback = { fallback: true, stage: 'search', reason: 'Generation failed; showing stale cache from ' + (news.staleDate || 'earlier') };
          } else if (_bizItems.length > 0 && _bizItems[0]._fromDay) {
            _regenFallback = { fallback: true, stage: 'search', reason: 'No fresh items; showing last-good from ' + _bizItems[0]._fromDay };
          } else if (_bizItems.length === 1 && _bizItems[0]._placeholder) {
            _regenFallback = { fallback: true, stage: 'search', reason: 'No items survived quality gates; showing placeholder' };
          } else if (!news.business) {
            _regenFallback = { fallback: true, stage: 'search', reason: 'No business brief generated' };
          }
        }

        /* Firm spend and cap for admin visibility. */
        var _bc = await budgetCheck(env, day, firmCode);
        var spendInfo = { firmSpent: _bc.firmSpent, firmCap: _bc.cap || 0 };

        var bizLog = (news && news._log) || null;
        if (news) { delete news._log; delete news._genError; }
        ctx.waitUntil(flushCost(env, day, firmCode, cost));
        var resp = { news: news, log: bizLog, cost: Object.assign({}, cost), spend: spendInfo };
        if (_regenFallback) resp.fallback = _regenFallback;
        return jsonResponse(resp);
      } catch (e) {
        ctx.waitUntil(flushCost(env, day, firmCode, cost));
        return jsonResponse({ error: 'regen_failed', detail: String((e && e.message) || e).slice(0, 500) }, 500);
      }
    }

    // POST /admin/cost-today — { adminPassword } → today's spend per firm and total
    if (request.method === 'POST' && path === '/admin/cost-today') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Invalid admin password' }, 403);
      }
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = ist.toISOString().slice(0, 10);
      var totalRaw = await env.G7_KV.get('cost:' + day + ':total');
      var firms = {};
      /* List all cost keys for today by iterating known firms. */
      let _cc;
      do {
        const _pg = await env.G7_KV.list({ prefix: 'cost:' + day + ':', cursor: _cc });
        for (const _k of _pg.keys) {
          var _parts = _k.name.split(':');
          if (_parts.length === 3 && _parts[2] !== 'total' && _parts[2] !== 'alert') {
            firms[_parts[2]] = parseFloat(await env.G7_KV.get(_k.name) || '0');
          }
        }
        _cc = _pg.list_complete ? undefined : _pg.cursor;
      } while (_cc);
      return jsonResponse({ day: day, total: parseFloat(totalRaw || '0'), firms: firms });
    }

    // POST /admin/cron-status — { adminPassword } → the last 06:00 report
    if (request.method === 'POST' && path === '/admin/cron-status') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Invalid admin password' }, 403);
      }
      const last = await env.G7_KV.get('cron:last', 'json');
      return jsonResponse(last || { none: true });
    }

    // ── ROUTE 12 — POST /email/send-founder-questions ────────────────────────
    // Sends Alex's founder outreach questions to the founder via Mailchannels.
    // Session-protected — requires valid g7_session_token.
    if (request.method === 'POST' && path === '/email/send-founder-questions') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      // Validate session — must pass the request object (not the token string)
      // so validateSession can read the Authorization: Bearer header correctly
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'Unauthorised — invalid or expired session' }, 401);

      // Validate required fields
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!body.founderEmail || !emailRegex.test(body.founderEmail)) {
        return jsonResponse({ error: 'founderEmail must be a valid email address' }, 400);
      }
      if (!body.emailBody || !body.emailBody.trim()) {
        return jsonResponse({ error: 'emailBody cannot be empty' }, 400);
      }
      if (!body.companyName || !body.companyName.trim()) {
        return jsonResponse({ error: 'companyName cannot be empty' }, 400);
      }

      const emailSubject = body.subject ||
        ('Following up on ' + body.companyName +
         ' — Questions from ' + (session.firmName || 'G7 Capital'));

      const emailPayload = {
        personalizations: [{
          to: [{
            email: body.founderEmail,
            name:  body.founderName || body.companyName + ' Team'
          }]
        }],
        from: {
          email: 'alex@gsevnservices.com',
          name:  'Alex — G7 Capital'
        },
        reply_to: {
          email: 'hello@gsevnservices.com',
          name:  session.firmName || 'G7 Capital'
        },
        subject: emailSubject,
        content: [{
          type:  'text/plain',
          value: body.emailBody
        }]
      };

      const sendResult = await fetch('https://api.mailchannels.net/tx/v1/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(emailPayload)
      });

      if (sendResult.status === 202 || sendResult.status === 200) {
        return jsonResponse({ success: true, message: 'Email sent to ' + body.founderEmail });
      } else {
        const errText = await sendResult.text().catch(() => '');
        return jsonResponse({ error: 'Email send failed', detail: sendResult.status, body: errText }, 500);
      }
    }

    // =========================================================================
    // ROUTE 13 — POST /scout/analyse
    // Scout initial business analysis. Session-protected.
    // Forwards to Anthropic with streaming response.
    // Separate from /api/message — does NOT touch Alex's deal counter.
    // =========================================================================
    if (request.method === 'POST' && path === '/scout/analyse') {
      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      // ---- Limit gate: free = 1 lifetime, paid = 3 per calendar month ----
      const userRecord = await env.G7_KV.get('auth:users:' + session.firmCode, 'json');
      const plan = userRecord && userRecord.plan ? userRecord.plan : 'free';
      const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
      let analysisCount = 0;
      let analysisCounterKey;
      if (plan === 'paid') {
        analysisCounterKey = 'scout:limit:' + session.firmCode + ':analyses:' + monthKey;
        const cntRaw = await env.G7_KV.get(analysisCounterKey);
        analysisCount = cntRaw ? parseInt(cntRaw, 10) : 0;
        if (analysisCount >= 3) {
          return jsonResponse({ error: 'limit_reached', limit: 'analysis' }, 403);
        }
      } else {
        analysisCounterKey = 'scout:limit:' + session.firmCode + ':analyses';
        const cntRaw = await env.G7_KV.get(analysisCounterKey);
        analysisCount = cntRaw ? parseInt(cntRaw, 10) : 0;
        if (analysisCount >= 1) {
          return jsonResponse({ error: 'limit_reached', limit: 'analysis' }, 403);
        }
      }
      // ---- end limit gate ----

      /* Analysis exempt from firm cost cap — existing monthly limit gate above is sufficient. */
      var cost = newCostAccum();

      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model:    'claude-sonnet-5-5',
          max_tokens: Math.min(body.max_tokens || 48000, 64000),
          thinking: { type: 'between_tools' },
          stream:   true,
          system:   body.system   || '',
          messages: body.messages || []
        })
      });

      if (!anthropicResponse.ok) {
        const errText = await anthropicResponse.text();
        return jsonResponse({ error: 'Anthropic error', detail: errText }, anthropicResponse.status);
      }

      // Increment the appropriate counter (monthly for paid, lifetime for free) only on success
      await kvPut(env,analysisCounterKey, String(analysisCount + 1));

      /* Pass through the SSE stream, collecting diagnostics:
         - input_tokens from message_start
         - content_block types from content_block_start
         - stop_reason + output_tokens from message_delta
         Logged as a single JSON line in flush() when the stream ends. */
      var _sseDecoder = new TextDecoder('utf-8');
      var _sseBuf = '';
      var _logData = { input_tokens: null, blocks: {}, stop_reason: null, output_tokens: null };
      function _parseSSEEvent(ev) {
        if (ev.type === 'message_start' && ev.message && ev.message.usage) {
          _logData.input_tokens = ev.message.usage.input_tokens || null;
        }
        if (ev.type === 'content_block_start' && ev.content_block) {
          var btype = ev.content_block.type || 'unknown';
          _logData.blocks[btype] = (_logData.blocks[btype] || 0) + 1;
        }
        if (ev.type === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) _logData.stop_reason = ev.delta.stop_reason;
          if (ev.usage && ev.usage.output_tokens) _logData.output_tokens = ev.usage.output_tokens;
        }
      }
      const { readable, writable } = new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          try {
            _sseBuf += _sseDecoder.decode(chunk, { stream: true });
            var parts = _sseBuf.split('\n');
            _sseBuf = parts.pop() || '';
            for (var li = 0; li < parts.length; li++) {
              var ln = parts[li].trim();
              if (!ln.startsWith('data: ') || ln === 'data: [DONE]') continue;
              _parseSSEEvent(JSON.parse(ln.slice(6)));
            }
          } catch (_) { /* logging only — never break the stream */ }
        },
        flush() {
          try {
            var ln = (_sseBuf + _sseDecoder.decode()).trim();
            _sseBuf = '';
            if (ln.startsWith('data: ') && ln !== 'data: [DONE]') {
              _parseSSEEvent(JSON.parse(ln.slice(6)));
            }
          } catch (_) {}
          console.log(JSON.stringify({
            route: '/scout/analyse',
            firm: session.firmCode,
            input_tokens: _logData.input_tokens,
            blocks: _logData.blocks,
            stop_reason: _logData.stop_reason,
            output_tokens: _logData.output_tokens
          }));

          /* Record cost from the stream's final usage. */
          recordCost(cost, 'claude-sonnet-5-5', { usage: { input_tokens: _logData.input_tokens || 0, output_tokens: _logData.output_tokens || 0 } });
          ctx.waitUntil(flushCost(env, new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10), session.firmCode, cost));

          /* Detect incomplete streams — alert admin */
          if (_logData.stop_reason !== 'end_turn') {
            var _istNow = new Date(Date.now() + 5.5 * 3600000);
            var _istStr = _istNow.toISOString().replace('T', ' ').slice(0, 19) + ' IST';
            ctx.waitUntil(recordAnalysisFailure(env, {
              firm: session.firmCode,
              businessName: '', businessType: '', city: '',
              stage: 'incomplete',
              stopReason: _logData.stop_reason || 'none',
              output_tokens: _logData.output_tokens || 0,
              time: _istStr,
              rawHead: ''
            }));
          }
        }
      });
      anthropicResponse.body.pipeTo(writable);

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        }
      });
    }

    // =========================================================================
    // ROUTE — POST /scout/analysis-failed
    // Client-side failure report. Session-protected. Fire-and-forget on client.
    // Records failure to KV list + sends admin alert email (max 1/firm/day).
    // =========================================================================
    if (request.method === 'POST' && path === '/scout/analysis-failed') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'Unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

      var _istNow = new Date(Date.now() + 5.5 * 3600000);
      var _istStr = _istNow.toISOString().replace('T', ' ').slice(0, 19) + ' IST';

      var record = {
        firm:           session.firmCode,
        businessName:   String(body.businessName || '').slice(0, 100),
        businessType:   String(body.businessType || '').slice(0, 50),
        city:           String(body.city || '').slice(0, 50),
        stage:          String(body.stage || 'unknown').slice(0, 20),
        stopReason:     String(body.stopReason || '').slice(0, 30),
        chars:          parseInt(body.chars, 10) || 0,
        parseError:     String(body.parseError || '').slice(0, 200),
        failedSections: Array.isArray(body.failedSections) ? body.failedSections.slice(0, 10) : [],
        rawHead:        String(body.rawHead || '').slice(0, 2000),
        time:           _istStr
      };

      ctx.waitUntil(recordAnalysisFailure(env, record));
      return jsonResponse({ ok: true });
    }

    // =========================================================================
    // ROUTE 13b — POST /scout/briefing
    // Lightweight non-streaming call for Jarvis voice briefings.
    // Session-protected. No rate limit — briefings are cheap and frequent.
    // Returns plain JSON { text } instead of SSE stream.
    // =========================================================================
    if (request.method === 'POST' && path === '/scout/briefing') {
      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      /* Feature gate + firm money backstop */
      var _istBrief = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      var _fgB = await featureGate(env, _istBrief, session.firmCode, 'ask');
      if (!_fgB.ok) {
        return jsonResponse({ error: "You\u2019ve used today\u2019s questions \u2014 back tomorrow.", budgetPaused: true }, 429);
      }
      var _bcB = await budgetCheck(env, _istBrief, session.firmCode);
      if (!_bcB.ok) {
        ctx.waitUntil(sendBudgetEmail(env, _istBrief, session.firmCode, _bcB.firmSpent, _bcB.cap));
        return jsonResponse({ error: "You\u2019ve used today\u2019s questions \u2014 back tomorrow.", budgetPaused: true }, 429);
      }
      await featureIncrement(env, _fgB);
      var cost = newCostAccum();

      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-sonnet-5-5',
          max_tokens: 6000,
          thinking:   { type: 'between_tools' },
          stream:     false,
          messages:   body.messages || []
        })
      });

      if (!anthropicResponse.ok) {
        const errText = await anthropicResponse.text();
        return jsonResponse({ error: 'Anthropic error', detail: errText }, anthropicResponse.status);
      }

      const result = await anthropicResponse.json();
      recordCost(cost, 'claude-sonnet-5-5', result);
      ctx.waitUntil(flushCost(env, new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10), session.firmCode, cost));
      const text = (result.content || []).filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('');

      return jsonResponse({ text: text });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /scout/market
    // Daily market brief: up to three things that changed in this
    // business's market, each with why it matters and what to do.
    // Body: { context, city }
    //   context — the compact business summary from scoutContext()
    //   city    — the business's city, for search location
    // Cached per firm per IST day. Every item must cite a URL that
    // web search actually returned; anything else is dropped.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/scout/market') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);

      /* Parse body BEFORE cache check so we can save the context for the
         morning scheduled job. */
      let body;
      try { body = await request.json(); }
      catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      const context = String(body.context || '').slice(0, 4000);
      const city = String(body.city || '').slice(0, 80);

      /* Save the latest context so the 06:00 IST cron can generate without
         a browser open. 7-day expiry: inactive firms drop out on their own. */
      if (context) {
        await kvPut(env,'market:ctx:' + session.firmCode,
          JSON.stringify({ context: context, city: city }),
          { expirationTtl: 7 * 86400 });
        /* Build/refresh watchlist in background — only calls Haiku when
           the context hash has changed (or watchlist is missing). */
        ctx.waitUntil(getWatchlist(env, session.firmCode, context, null).catch(function(){}));
      }

      /* IST date — the brief belongs to the owner's day, not UTC's. */
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = ist.toISOString().slice(0, 10);
      const cacheKey = 'market:' + session.firmCode + ':' + day;

      const cached = await env.G7_KV.get(cacheKey, 'json');
      if (cached) return jsonResponse(cached);

      if (!context) return jsonResponse({ items: [], date: day });

      /* Firm money backstop */
      var _bcM = await budgetCheck(env, day, session.firmCode);
      if (!_bcM.ok) {
        ctx.waitUntil(sendBudgetEmail(env, day, session.firmCode, _bcM.firmSpent, _bcM.cap));
        var _lbM = await lastMarketBrief(env, session.firmCode, day);
        if (_lbM) return jsonResponse(Object.assign({}, _lbM, { stale: true, staleDate: _lbM.date || '', budgetPaused: true }));
        return jsonResponse({ items: [], date: day, budgetPaused: true });
      }

      /* Concurrency lock — prevents duplicate generation if two tabs load
         at the same time. Auto-expires after 120 s as a safety net. */
      const lockKey = 'market:lock:' + session.firmCode + ':' + day;
      if (await env.G7_KV.get(lockKey)) return jsonResponse({ items: [], date: day, pending: true });
      await kvPut(env,lockKey, '1', { expirationTtl: 120 });

      /* Three generation attempts per firm per day. A failure writes no
         cache, so without this a broken call would retry on every load. */
      const attemptKey = 'market:attempts:' + session.firmCode + ':' + day;
      const attempts = parseInt((await env.G7_KV.get(attemptKey)) || '0', 10);
      if (attempts >= 3) {
        await env.G7_KV.delete(lockKey);
        /* All attempts exhausted — serve last known good if available. */
        var lastBrief = await lastMarketBrief(env, session.firmCode, day);
        if (lastBrief) {
          console.log(JSON.stringify({ newsFallback: session.firmCode, reason: 'attempts exhausted' }));
          return jsonResponse(Object.assign({}, lastBrief, { stale: true, staleDate: lastBrief.date || '' }));
        }
        return jsonResponse({ items: [], date: day, limited: true });
      }
      await kvPut(env,attemptKey, String(attempts + 1), { expirationTtl: 172800 });

      var cost = newCostAccum();
      try {
        const result = await generateMarketBrief(env, session.firmCode, day, context, city, false, false, cost);
        await env.G7_KV.delete(lockKey);
        ctx.waitUntil(flushCost(env, day, session.firmCode, cost));
        return jsonResponse(result);
      } catch (e) {
        await env.G7_KV.delete(lockKey);
        ctx.waitUntil(flushCost(env, day, session.firmCode, cost));
        console.log(JSON.stringify({ newsFallback: session.firmCode, reason: String(e.message || '').slice(0, 300) }));
        if (isBillingError(e)) await sendCreditAlert(env, day);
        /* Fall back to last known good, or yesterday/day-before cache. */
        var lastOnErr = await lastMarketBrief(env, session.firmCode, day);
        if (lastOnErr) {
          return jsonResponse(Object.assign({}, lastOnErr, { stale: true, staleDate: lastOnErr.date || '' }));
        }
        return jsonResponse({ error: 'market_failed', detail: String(e.message || '').slice(0, 500) }, 502);
      }
    }

    // =========================================================================
    // ROUTE 14 — POST /scout/checkin
    // Scout weekly check-in. Session-protected.
    // Multi-turn conversation — lower max_tokens than initial analysis.
    // Separate from /api/message — does NOT touch Alex's deal counter.
    // =========================================================================
    if (request.method === 'POST' && path === '/scout/checkin') {
      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      // ---- Limit gate: free = 0 (upgrade_required), paid = 8 per calendar month ----
      const userRecord = await env.G7_KV.get('auth:users:' + session.firmCode, 'json');
      const plan = userRecord && userRecord.plan ? userRecord.plan : 'free';
      const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
      let checkinCount = 0;
      let checkinCounterKey;
      if (plan === 'paid') {
        checkinCounterKey = 'scout:limit:' + session.firmCode + ':checkins:' + monthKey;
        const cntRaw = await env.G7_KV.get(checkinCounterKey);
        checkinCount = cntRaw ? parseInt(cntRaw, 10) : 0;
        if (checkinCount >= 8) {
          return jsonResponse({ error: 'limit_reached', limit: 'checkin' }, 403);
        }
      } else {
        // Free users cannot check in — check-ins are a paid-only feature
        return jsonResponse({ error: 'upgrade_required', limit: 'checkin' }, 403);
      }
      // ---- end limit gate ----

      /* Firm money backstop (check-in already has its own monthly limit gate above). */
      var _istCI = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      var _bcCI = await budgetCheck(env, _istCI, session.firmCode);
      if (!_bcCI.ok) {
        ctx.waitUntil(sendBudgetEmail(env, _istCI, session.firmCode, _bcCI.firmSpent, _bcCI.cap));
        return jsonResponse({ error: "You\u2019ve used today\u2019s check-ins \u2014 back tomorrow.", budgetPaused: true }, 429);
      }
      var cost = newCostAccum();

      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model:    'claude-sonnet-5-5',
          max_tokens: 8000,
          thinking: { type: 'between_tools' },
          stream:   true,
          system:   body.system   || '',
          messages: body.messages || []
        })
      });

      if (!anthropicResponse.ok) {
        const errText = await anthropicResponse.text();
        return jsonResponse({ error: 'Anthropic error', detail: errText }, anthropicResponse.status);
      }

      // Increment the appropriate counter (monthly for paid, lifetime for free) only on success
      await kvPut(env,checkinCounterKey, String(checkinCount + 1));

      /* Wrap stream to capture usage for cost tracking. */
      var _ciDec = new TextDecoder('utf-8');
      var _ciBuf = '';
      var _ciUsage = { input: 0, output: 0 };
      var _ciFlushCost = function() {
        recordCost(cost, 'claude-sonnet-5-5', { usage: { input_tokens: _ciUsage.input, output_tokens: _ciUsage.output } });
        ctx.waitUntil(flushCost(env, new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10), session.firmCode, cost));
      };
      const _ciStream = new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          try {
            _ciBuf += _ciDec.decode(chunk, { stream: true });
            var parts = _ciBuf.split('\n'); _ciBuf = parts.pop() || '';
            for (var li = 0; li < parts.length; li++) {
              var ln = parts[li].trim();
              if (!ln.startsWith('data: ') || ln === 'data: [DONE]') continue;
              var ev = JSON.parse(ln.slice(6));
              if (ev.type === 'message_start' && ev.message && ev.message.usage) _ciUsage.input = ev.message.usage.input_tokens || 0;
              if (ev.type === 'message_delta' && ev.usage) _ciUsage.output = ev.usage.output_tokens || 0;
            }
          } catch (_) {}
        },
        flush() { try { _ciFlushCost(); } catch (_) {} }
      });
      anthropicResponse.body.pipeTo(_ciStream.writable);

      return new Response(_ciStream.readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        }
      });
    }

    // =========================================================================
    // ROUTE 15 — POST /scout/track
    // Increments Scout usage counters in KV.
    // Called after every successful Scout analysis (fire-and-forget from client).
    // No session required — low-risk counter write only.
    // KV keys written:
    //   scout:usage:total          — lifetime total (string integer)
    //   scout:usage:date:{YYYY-MM-DD} — per-day count (string integer)
    //   scout:usage:bt:{type}      — per-business-type count (string integer)
    //   scout:usage:city:{city}    — per-city count (string integer)
    //   scout:usage:log            — JSON array of last 50 entries
    // =========================================================================
    if (request.method === 'POST' && path === '/scout/track') {
      let trackBody;
      try {
        trackBody = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const firmCode     = (trackBody.firmCode     || 'unknown').slice(0, 30);
      const businessType = (trackBody.businessType || '').slice(0, 50);
      const city         = (trackBody.city         || '').slice(0, 30);
      const today        = new Date().toISOString().split('T')[0];

      try {
        // Increment lifetime total
        const totalRaw = await env.G7_KV.get('scout:usage:total');
        const total    = totalRaw ? parseInt(totalRaw) + 1 : 1;
        await kvPut(env,'scout:usage:total', String(total));

        // Increment per-day counter
        const dateKey  = 'scout:usage:date:' + today;
        const dateRaw  = await env.G7_KV.get(dateKey);
        const dateCount = dateRaw ? parseInt(dateRaw) + 1 : 1;
        await kvPut(env,dateKey, String(dateCount));

        // Increment per-business-type counter (normalised key)
        if (businessType) {
          const btKey  = 'scout:usage:bt:' + businessType.replace(/\s+/g, '_').toLowerCase();
          const btRaw  = await env.G7_KV.get(btKey);
          const btCount = btRaw ? parseInt(btRaw) + 1 : 1;
          await kvPut(env,btKey, String(btCount));
        }

        // Increment per-city counter (normalised key)
        if (city) {
          const cityKey  = 'scout:usage:city:' + city.replace(/\s+/g, '_').toLowerCase();
          const cityRaw  = await env.G7_KV.get(cityKey);
          const cityCount = cityRaw ? parseInt(cityRaw) + 1 : 1;
          await kvPut(env,cityKey, String(cityCount));
        }

        // Prepend to log (keep last 50 entries)
        const logRaw = await env.G7_KV.get('scout:usage:log');
        let log = logRaw ? JSON.parse(logRaw) : [];
        log.unshift({
          date:         new Date().toISOString(),
          firmCode:     firmCode,
          businessType: businessType,
          city:         city
        });
        if (log.length > 50) log = log.slice(0, 50);
        await kvPut(env,'scout:usage:log', JSON.stringify(log));

        return jsonResponse({ success: true, total });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // =========================================================================
    // ROUTE 16 — GET /admin/scout-stats
    // Returns Scout usage statistics for the admin dashboard.
    // Query params: adminPassword (required)
    // Returns: { totalAnalyses, last7Days, recentLog }
    // =========================================================================
    if (request.method === 'GET' && path === '/admin/scout-stats') {
      const adminPwd = url.searchParams.get('adminPassword');
      if (!adminPwd || adminPwd !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      try {
        // Lifetime total
        const totalRaw = await env.G7_KV.get('scout:usage:total');
        const total    = totalRaw ? parseInt(totalRaw) : 0;

        // Last 7 days — one KV read per day (7 reads, run in parallel)
        const last7Days = await Promise.all(
          Array.from({ length: 7 }, (_, i) => {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            return env.G7_KV.get('scout:usage:date:' + dateStr)
              .then(v => ({ date: dateStr, count: v ? parseInt(v) : 0 }));
          })
        );

        // Recent log (last 20 shown in admin UI)
        const logRaw = await env.G7_KV.get('scout:usage:log');
        const log    = logRaw ? JSON.parse(logRaw) : [];

        return jsonResponse({
          totalAnalyses: total,
          last7Days,
          recentLog: log.slice(0, 20)
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // =========================================================================
    // ROUTE 17 — POST /admin/scout-reset
    // Resets Scout lifetime total and log to zero.
    // Does NOT reset per-day or per-type counters (those decay naturally).
    // Body: { adminPassword }
    // =========================================================================
    if (request.method === 'POST' && path === '/admin/scout-reset') {
      let resetBody;
      try {
        resetBody = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      if (!resetBody.adminPassword || resetBody.adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      await kvPut(env,'scout:usage:total', '0');
      await kvPut(env,'scout:usage:log',   '[]');

      return jsonResponse({ success: true });
    }

    // =========================================================================
    // ROUTE — POST /admin/set-plan
    // Updates the `plan` field on an existing account to 'paid' or 'free'.
    // All other fields (passwordHash, product, tier, createdAt, firmName) are preserved.
    // Protected by ADMIN_PASSWORD.
    // =========================================================================
    if (request.method === 'POST' && path === '/admin/set-plan') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { adminPassword, firmCode, plan: rawPlan } = body;

      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }
      if (!firmCode) {
        return jsonResponse({ error: 'firmCode is required' }, 400);
      }

      const normalizedCode = firmCode.toUpperCase().trim();
      const key = 'auth:users:' + normalizedCode;
      const record = await env.G7_KV.get(key, 'json');
      if (!record) {
        return jsonResponse({ error: 'Firm not found' }, 404);
      }

      const newPlan = (rawPlan === 'paid') ? 'paid' : 'free';
      record.plan = newPlan;
      await kvPut(env,key, JSON.stringify(record));

      return jsonResponse({ success: true, firmCode: normalizedCode, plan: newPlan });
    }

    // ── ROUTE — POST /admin/reset-scout-usage ─────────────────────────────────
    // Resets all Scout limit counters for a firm (free lifetime + current month paid).
    if (request.method === 'POST' && path === '/admin/reset-scout-usage') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      const { adminPassword, firmCode } = body;
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }
      const normalizedCode = (firmCode || '').toUpperCase().trim();
      if (!normalizedCode) {
        return jsonResponse({ error: 'firmCode is required' }, 400);
      }

      const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

      // Delete all Scout counter keys: free (lifetime) and paid (current month)
      await env.G7_KV.delete('scout:limit:' + normalizedCode + ':analyses');
      await env.G7_KV.delete('scout:limit:' + normalizedCode + ':checkins');
      await env.G7_KV.delete('scout:limit:' + normalizedCode + ':analyses:' + monthKey);
      await env.G7_KV.delete('scout:limit:' + normalizedCode + ':checkins:' + monthKey);

      return jsonResponse({ success: true, firmCode: normalizedCode });
    }

    // ── ROUTE — GET /admin/scout-usage ────────────────────────────────────────
    // Returns a Scout firm's current limit counters (free lifetime + paid monthly).
    if (request.method === 'GET' && path === '/admin/scout-usage') {
      const adminPassword = url.searchParams.get('adminPassword');
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }
      const firmCode = (url.searchParams.get('firmCode') || '').toUpperCase().trim();
      if (!firmCode) {
        return jsonResponse({ error: 'firmCode query parameter is required' }, 400);
      }

      const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

      const freeAnalysesRaw = await env.G7_KV.get('scout:limit:' + firmCode + ':analyses');
      const freeCheckinsRaw = await env.G7_KV.get('scout:limit:' + firmCode + ':checkins');
      const paidAnalysesRaw = await env.G7_KV.get('scout:limit:' + firmCode + ':analyses:' + monthKey);
      const paidCheckinsRaw = await env.G7_KV.get('scout:limit:' + firmCode + ':checkins:' + monthKey);

      return jsonResponse({
        firmCode,
        freeAnalyses: freeAnalysesRaw ? parseInt(freeAnalysesRaw, 10) : 0,
        freeCheckins: freeCheckinsRaw ? parseInt(freeCheckinsRaw, 10) : 0,
        paidAnalyses: paidAnalysesRaw ? parseInt(paidAnalysesRaw, 10) : 0,
        paidCheckins: paidCheckinsRaw ? parseInt(paidCheckinsRaw, 10) : 0,
        month: monthKey
      });
    }

    // ── ROUTE — GET /admin/analysis-failures ──────────────────────────────────
    // Returns the last 20 analysis failure records from KV.
    if (request.method === 'GET' && path === '/admin/analysis-failures') {
      const adminPassword = url.searchParams.get('adminPassword');
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }
      var list = await env.G7_KV.get('scout:analysis-failures', 'json') || [];
      return jsonResponse({ failures: list });
    }

    // =========================================================================
    // ROUTE — GET /places/search
    // Google Places (New) Text Search proxy. Session-protected, cached.
    //
    // Query params:
    //   q  — search string (required, max 200 chars)
    //
    // Rate limits (matching /scout/analyse pattern exactly):
    //   free: 'scout:limit:{firm}:places'            — 5 lifetime,  max 2 results
    //   paid: 'scout:limit:{firm}:places:{YYYY-MM}'  — 6/month,    max 50 results
    //
    // Cache: 'places:cache:{sha256(lower(trim(q)))}' — 30-day KV TTL
    //   Cache hit: return stored results, do NOT increment counter.
    //   Cache miss: call Google, store result, increment counter.
    //
    // Field mask (Text Search Basic SKU — lowest cost tier):
    //   places.displayName,places.formattedAddress,
    //   places.nationalPhoneNumber,places.websiteUri
    //   — No ratings, reviews, opening hours, or photos.
    //   — No Place Details follow-up calls.
    //
    // Response shape:
    //   { cacheHit, results: [{name,address,phone,website}],
    //     quota: { used, limit } }
    // =========================================================================
    if (request.method === 'GET' && path === '/places/search') {

      // 1. Auth
      const session = await validateSession(request, env);
      if (!session) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // 2. Validate query param
      const rawQ = url.searchParams.get('q') || '';
      const q = rawQ.trim();
      if (!q) {
        return jsonResponse({ error: 'q parameter is required' }, 400);
      }
      if (q.length > 200) {
        return jsonResponse({ error: 'q must be 200 characters or fewer' }, 400);
      }

      // 3. Read plan from user record
      const userRecord = await env.G7_KV.get('auth:users:' + session.firmCode, 'json');
      const plan = userRecord && userRecord.plan ? userRecord.plan : 'free';
      const todayKey = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

      // Determine daily limit and result cap based on plan
      const isPaid    = plan === 'paid';
      const cap       = isPaid ? 50 : 2;
      const hardLimit = isPaid ? 5 : 2;

      // Daily counter key
      const placesCounterKey = 'scout:limit:' + session.firmCode + ':places:' + todayKey;

      // 4. Read current count
      const cntRaw = await env.G7_KV.get(placesCounterKey);
      const placesCount = cntRaw ? parseInt(cntRaw, 10) : 0;

      // 5. Cache lookup — normalise query to lowercase for stable cache key
      const normalised = q.toLowerCase();
      const encoder = new TextEncoder();
      const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(normalised));
      const hashHex = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const cacheKey = 'places:cache:' + hashHex;

      const forceRefresh = url.searchParams.get('refresh') === '1';
      if (!forceRefresh) {
        const cached = await env.G7_KV.get(cacheKey, 'json');
        if (cached) {
          // Cache hit — handle both old format (plain array) and new format ({_cachedAt, results})
          var _list = Array.isArray(cached) ? cached : (cached.results || []);
          var _resp = {
            cacheHit: true,
            results:  _list.slice(0, cap),
            quota:    { used: placesCount, limit: hardLimit, period: 'day' }
          };
          if (cached._cachedAt) _resp.cachedAt = cached._cachedAt;
          return jsonResponse(_resp);
        }
      }

      // Cache miss — enforce daily rate limit
      if (placesCount >= hardLimit) {
        return jsonResponse({ error: 'limit_reached', limit: 'places' }, 403);
      }

      /* Firm money backstop (places already has its own daily limit gate above). */
      var _istPlaces = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      var _bcP = await budgetCheck(env, _istPlaces, session.firmCode);
      if (!_bcP.ok) {
        ctx.waitUntil(sendBudgetEmail(env, _istPlaces, session.firmCode, _bcP.firmSpent, _bcP.cap));
        return jsonResponse({ error: "You\u2019ve used today\u2019s customer searches \u2014 back tomorrow.", budgetPaused: true }, 429);
      }

      // 6. Call Claude web search to find businesses
      var cost = newCostAccum();
      let places;
      try {
        places = await findBusinesses(env, q, cap, cost);
      } catch (e) {
        ctx.waitUntil(flushCost(env, _istPlaces, session.firmCode, cost));
        return jsonResponse({ error: 'Business search failed' }, 502);
      }

      // 7. Store in cache — 14-day TTL with timestamp
      var _cacheObj = { _cachedAt: new Date().toISOString().slice(0, 10), results: places };
      kvPut(env, cacheKey, JSON.stringify(_cacheObj), { expirationTtl: 14 * 86400 });
      ctx.waitUntil(flushCost(env, _istPlaces, session.firmCode, cost));

      // 8. Increment daily counter (24h TTL so it auto-resets)
      await kvPut(env, placesCounterKey, String(placesCount + 1), { expirationTtl: 86400 });

      return jsonResponse({
        cacheHit: false,
        results:  places.slice(0, cap),
        quota:    { used: placesCount + 1, limit: hardLimit, period: 'day' }
      });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /scout/brief-email — current setting for the dashboard toggle.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/scout/brief-email') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      const ep = emailPrefs(user);
      return jsonResponse({ actions: ep.actions, news: ep.news, on: ep.actions || ep.news, hasEmail: !!user.recoveryEmail });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /scout/brief-email — { actions?, news?, on?, email? }
    // email is accepted ONLY when the account has no recovery email yet.
    // Changing an existing one needs the current password and is not done here.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/scout/brief-email') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      const key = 'auth:users:' + session.firmCode;
      const user = await env.G7_KV.get(key, 'json');
      if (!user) return jsonResponse({ error: 'Account not found.' }, 404);
      const email = String(body.email || '').trim().toLowerCase();
      if (!user.recoveryEmail) {
        if (!email) return jsonResponse({ error: 'Add an email address to get the morning brief.' }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ error: 'That email address does not look right.' }, 400);
        user.recoveryEmail = email;
      }
      if (typeof body.on === 'boolean' && typeof body.actions !== 'boolean' && typeof body.news !== 'boolean') {
        user.emailActions = body.on;
        user.emailNews = body.on;
      } else {
        if (typeof body.actions === 'boolean') user.emailActions = body.actions;
        if (typeof body.news === 'boolean') user.emailNews = body.news;
      }
      user.briefEmail = !!(user.emailActions || user.emailNews);
      await kvPut(env,key, JSON.stringify(user));
      const ep = emailPrefs(user);
      return jsonResponse({ actions: ep.actions, news: ep.news, on: ep.actions || ep.news, hasEmail: true });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /scout/recovery-email — returns current recovery email.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/scout/recovery-email') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      return jsonResponse({ email: user.recoveryEmail || '' });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /scout/recovery-email — { email, currentPassword? }
    // currentPassword is required when changing an existing email.
    // Not required when setting the first one.
    // Never touches email on/off toggles.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/scout/recovery-email') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      const key = 'auth:users:' + session.firmCode;
      const user = await env.G7_KV.get(key, 'json');
      if (!user) return jsonResponse({ error: 'Account not found.' }, 404);

      const newEmail = String(body.email || '').trim().toLowerCase();
      if (!newEmail) return jsonResponse({ error: 'Enter an email address.' }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return jsonResponse({ error: 'That email address does not look right.' }, 400);

      const oldEmail = user.recoveryEmail || '';

      /* Require password when changing an existing email */
      if (oldEmail) {
        const pw = String(body.currentPassword || '');
        if (!pw) return jsonResponse({ error: 'Enter your current password to change the email.' }, 400);
        const check = await verifyPassword(pw, user.passwordHash);
        if (!check.ok) return jsonResponse({ error: 'Password is incorrect.' }, 403);
      }

      user.recoveryEmail = newEmail;
      await kvPut(env, key, JSON.stringify(user));

      /* Send notice to the OLD address (fire-and-forget, never blocks) */
      if (oldEmail && oldEmail !== newEmail) {
        const masked = newEmail.replace(/^(..)[^@]*/, '$1***');
        const subj = 'Your G7 recovery email was changed';
        const txt = 'Your G7 recovery email was changed to ' + masked + '.\n\n' +
          'If this wasn\u2019t you, contact gsevnservices@gmail.com immediately.';
        const htm = '<p>Your G7 recovery email was changed to <strong>' + masked + '</strong>.</p>' +
          '<p>If this wasn\u2019t you, contact <a href="mailto:gsevnservices@gmail.com">gsevnservices@gmail.com</a> immediately.</p>';
        ctx.waitUntil(sendEmail(env, oldEmail, subj, txt, htm));
      }

      return jsonResponse({ email: newEmail });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /scout/news-prefs — current news category selections.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/scout/news-prefs') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      const effective = await resolveNewsPrefs(env, session.firmCode, user.newsPrefs);
      return jsonResponse({
        prefs: effective,
        options: Object.keys(NEWS_CATS).map(function(k) { return { key: k, label: NEWS_CATS[k].label }; })
      });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /scout/news-prefs — { prefs: [...] }
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/scout/news-prefs') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      const key = 'auth:users:' + session.firmCode;
      const user = await env.G7_KV.get(key, 'json');
      if (!user) return jsonResponse({ error: 'Account not found.' }, 404);
      const valid = (Array.isArray(body.prefs) ? body.prefs : []).filter(function(c){ return NEWS_CATS[c]; });
      user.newsPrefs = valid;
      await kvPut(env,key, JSON.stringify(user));
      return jsonResponse({ prefs: user.newsPrefs });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /scout/message-lang — current message language setting.
    // Falls back to onboarding's businessData.language if never saved.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/scout/message-lang') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      if (user.messageLanguage) return jsonResponse({ language: user.messageLanguage });
      /* Default from onboarding. */
      const st = await loadScoutState(env, session.firmCode);
      const pend = st ? (st.pick('scout_pending_result') || {}) : {};
      var lang = (pend.businessData && pend.businessData.language) || 'Hinglish';
      if (/regional/i.test(lang)) lang = 'Hinglish';
      return jsonResponse({ language: lang });
    }

    // ─────────────────────────────────────────────────────────────
    // POST /scout/message-lang — { language: "English"|"Hinglish"|"Hindi" }
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'POST' && path === '/scout/message-lang') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
      const allowed = ['English','Hinglish','Hindi'];
      var lang = String(body.language || '').trim();
      if (allowed.indexOf(lang) === -1) return jsonResponse({ error: 'Language must be English, Hinglish or Hindi.' }, 400);
      const key = 'auth:users:' + session.firmCode;
      const user = await env.G7_KV.get(key, 'json');
      if (!user) return jsonResponse({ error: 'Account not found.' }, 404);
      user.messageLanguage = lang;
      await kvPut(env,key, JSON.stringify(user));
      return jsonResponse({ language: user.messageLanguage });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /scout/news — full daily news for the dashboard.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/scout/news') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const today = ist.toISOString().slice(0, 10);

      /* Track lastSeen — max one KV write per firm per day */
      var _lsKey = 'scout:lastSeen:' + session.firmCode;
      var _lsRaw = await env.G7_KV.get(_lsKey);
      if (!_lsRaw || _lsRaw.slice(0, 10) !== today) {
        ctx.waitUntil(kvPut(env, _lsKey, today + 'T' + ist.toISOString().slice(11, 19) + '+05:30'));
      }
      const saved = await env.G7_KV.get('market:ctx:' + session.firmCode, 'json');
      if (!saved || !saved.context) {
        /* No context saved yet — still try fallback from previous days. */
        var lastBiz = await lastMarketBrief(env, session.firmCode, today);
        if (!lastBiz) return jsonResponse({ business: { items: [] }, sections: [] });
        var user0 = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
        var prefs0 = await resolveNewsPrefs(env, session.firmCode, user0.newsPrefs);
        var citySlug0 = '';
        var sections0 = [];
        var chosen0 = (Array.isArray(prefs0) ? prefs0 : []).filter(function(c){ return NEWS_CATS[c]; });
        for (var ci = 0; ci < chosen0.length; ci++) {
          var lc = await lastSharedNews(env, chosen0[ci], citySlug0);
          if (lc) sections0.push(lc);
        }
        return jsonResponse({ business: lastBiz, sections: sections0, stale: true, staleDate: lastBiz.date || '' });
      }
      const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      const effectivePrefs = await resolveNewsPrefs(env, session.firmCode, user.newsPrefs);
      /* Firm money backstop — serve cache/last-good when over cap. */
      var _bc1 = await budgetCheck(env, today, session.firmCode);
      if (!_bc1.ok) {
        ctx.waitUntil(sendBudgetEmail(env, today, session.firmCode, _bc1.firmSpent, _bc1.cap));
        var _cachedBiz = await env.G7_KV.get('market:' + session.firmCode + ':' + today, 'json')
                      || await lastMarketBrief(env, session.firmCode, today);
        if (_cachedBiz) return jsonResponse({ business: _cachedBiz, sections: [], budgetPaused: true });
        return jsonResponse({ business: { items: [] }, sections: [], budgetPaused: true });
      }
      var cost = newCostAccum();
      const news = await buildDailyNews(env, session.firmCode, today, saved.context, saved.city || '', effectivePrefs, cost);
      delete news._log;
      delete news._genError;
      ctx.waitUntil(flushCost(env, today, session.firmCode, cost));
      return jsonResponse(news);
    }

    // ─────────────────────────────────────────────────────────────
    // GET /scout/move — today's move for the dashboard.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/scout/move') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const today = ist.toISOString().slice(0, 10);
      const cached = await env.G7_KV.get('move:' + session.firmCode + ':' + today, 'json');
      if (cached) return jsonResponse({ move: cached });
      const saved = await env.G7_KV.get('market:ctx:' + session.firmCode, 'json');
      if (!saved || !saved.context) return jsonResponse({ move: null });
      /* Firm money backstop */
      var _bc2 = await budgetCheck(env, today, session.firmCode);
      if (!_bc2.ok) {
        ctx.waitUntil(sendBudgetEmail(env, today, session.firmCode, _bc2.firmSpent, _bc2.cap));
        return jsonResponse({ move: null, budgetPaused: true });
      }
      var cost = newCostAccum();
      try {
        const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
        const news = await buildDailyNews(env, session.firmCode, today, saved.context, saved.city || '', user.newsPrefs, cost);
        const st = await loadScoutState(env, session.firmCode);
        const move = await generateScoutMove(env, session.firmCode, today, saved.context, news, st, false, cost);
        ctx.waitUntil(flushCost(env, today, session.firmCode, cost));
        return jsonResponse({ move: move });
      } catch (e) {
        ctx.waitUntil(flushCost(env, today, session.firmCode, cost));
        return jsonResponse({ move: null });
      }
    }

    // ─────────────────────────────────────────────────────────────
    // GET /unsub?t=<token>&type=actions|news and POST /unsub (Gmail one-click) — no session.
    // ─────────────────────────────────────────────────────────────
    if ((request.method === 'GET' || request.method === 'POST') && path === '/unsub') {
      const t = url.searchParams.get('t') || '';
      const type = url.searchParams.get('type') || '';
      const firmCode = t ? await env.G7_KV.get('unsub:' + t) : null;
      var stoppedLabel = 'morning emails';
      if (firmCode) {
        const key = 'auth:users:' + firmCode;
        const user = await env.G7_KV.get(key, 'json');
        if (user) {
          if (type === 'actions') {
            user.emailActions = false;
            stoppedLabel = 'daily actions email';
          } else if (type === 'news') {
            user.emailNews = false;
            stoppedLabel = 'news email';
          } else {
            user.emailActions = false;
            user.emailNews = false;
          }
          user.briefEmail = !!(user.emailActions || user.emailNews);
          await kvPut(env,key, JSON.stringify(user));
        }
      }
      return new Response(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<div style="font-family:Arial,sans-serif;max-width:420px;margin:80px auto;padding:0 20px;color:#222;line-height:1.6">' +
        '<h2 style="font-weight:400">You\'re unsubscribed.</h2>' +
        '<p>Scout won\'t send your ' + stoppedLabel + ' any more. You can switch it back on from your dashboard.</p></div>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // =========================================================================
    // ROUTE A — POST /inbound/create
    // Creates three inbound short links for the firm: bio, google, status.
    // Each link is: https://g7-proxy.gsevnservices.workers.dev/i/{CODE}
    // Codes are opaque 6-char base36 strings — never the firmCode.
    // Session-protected.
    //
    // IDEMPOTENT: if the firm already has links, updates waNumber/message on
    // the existing three records and returns the original codes unchanged.
    // (Owner may have pasted the link in their bio — regenerating would break it.)
    //
    // Body: { waNumber, message }
    //   waNumber — digits only, wa.me format (e.g. "919876543210")
    //   message  — pre-filled WhatsApp text customers will send
    //
    // Returns: { links: { bio, google, status }, clicks: { bio, google, status } }
    // =========================================================================
    if (request.method === 'POST' && path === '/inbound/create') {
      // Outer try/catch ensures every code path — including unexpected KV throws —
      // returns a jsonResponse with CORS headers rather than a Cloudflare platform
      // error page that has no CORS headers and blocks the browser fetch.
      try {
        const session = await validateSession(request, env);
        if (!session) return jsonResponse({ error: 'Unauthorized' }, 401);

        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

        const { waNumber, message } = body;
        if (!waNumber || !message) {
          return jsonResponse({ error: 'waNumber and message are required' }, 400);
        }

        const firmCode = session.firmCode;
        const linksKey = 'scout:inbound:' + firmCode + ':links';
        const now      = new Date().toISOString();
        const sources  = ['bio', 'google', 'status'];

        // ── Idempotent path: firm already has links ──────────────────────────────
        const existing = await env.G7_KV.get(linksKey, 'json');
        if (existing) {
          // Update waNumber + message on each existing link record (in parallel)
          await Promise.all(sources.map(source => {
            const code = existing[source];
            if (!code) return;
            return kvPut(env,
              'scout:inbound:link:' + code,
              JSON.stringify({ firmCode, source, waNumber, message, createdAt: now })
            );
          }));

          // Fetch current click counts (in parallel)
          const clicks = {};
          await Promise.all(sources.map(async source => {
            const raw = await env.G7_KV.get('scout:inbound:' + firmCode + ':' + source + ':clicks');
            clicks[source] = raw ? parseInt(raw, 10) : 0;
          }));

          return jsonResponse({ links: existing, clicks });
        }

        // ── New firm: generate 3 codes, one per source ───────────────────────────
        const codes = {};
        for (const source of sources) {
          let code = genInboundCode();
          // Collision check — retry once if the code is already taken
          if (await env.G7_KV.get('scout:inbound:link:' + code)) {
            code = genInboundCode();
            // Second collision is astronomically unlikely; fail loudly if it happens
            if (await env.G7_KV.get('scout:inbound:link:' + code)) {
              return jsonResponse({ error: 'Code generation collision — please retry' }, 500);
            }
          }
          codes[source] = code;
        }

        // Write all link records + the index in parallel
        await Promise.all([
          ...sources.map(source =>
            kvPut(env,
              'scout:inbound:link:' + codes[source],
              JSON.stringify({ firmCode, source, waNumber, message, createdAt: now })
            )
          ),
          kvPut(env,linksKey, JSON.stringify(codes))
        ]);

        return jsonResponse({
          links:  codes,
          clicks: { bio: 0, google: 0, status: 0 }
        });
      } catch (e) {
        return jsonResponse({ error: 'Internal error', detail: e.message }, 500);
      }
    }

    // =========================================================================
    // ROUTE C — GET /inbound/stats
    // Returns the firm's link codes and current click counts.
    // Session-protected — firms can only read their own stats.
    // Returns: { links: { bio, google, status } | null,
    //            clicks: { bio, google, status } | null }
    // =========================================================================
    if (request.method === 'GET' && path === '/inbound/stats') {
      // Outer try/catch ensures every code path — including unexpected KV throws —
      // returns a jsonResponse with CORS headers rather than a Cloudflare platform
      // error page that has no CORS headers and blocks the browser fetch.
      try {
        const session = await validateSession(request, env);
        if (!session) return jsonResponse({ error: 'Unauthorized' }, 401);

        const firmCode = session.firmCode;
        const links    = await env.G7_KV.get('scout:inbound:' + firmCode + ':links', 'json');

        if (!links) {
          // Firm has not created links yet
          return jsonResponse({ links: null, clicks: null });
        }

        const sources = ['bio', 'google', 'status'];
        const clicks  = {};
        await Promise.all(sources.map(async source => {
          const raw = await env.G7_KV.get('scout:inbound:' + firmCode + ':' + source + ':clicks');
          clicks[source] = raw ? parseInt(raw, 10) : 0;
        }));

        return jsonResponse({ links, clicks });
      } catch (e) {
        return jsonResponse({ error: 'Internal error', detail: e.message }, 500);
      }
    }

    // =========================================================================
    // ROUTE B — GET /i/{CODE}
    // Public inbound link redirect. No session required — a real customer taps
    // this link on their phone.
    //
    // Flow:
    //   1. Look up scout:inbound:link:{CODE}
    //   2. If not found: return 404 as plain text (not JSON — a human may see it)
    //   3. Increment the per-source click counter (fire-and-forget)
    //   4. 302-redirect to https://wa.me/{waNumber}?text={encodedMessage}
    //
    // CORS: intentionally NOT applied. This is a browser navigation (not a JS
    // fetch from another origin), so CORS headers are irrelevant. The global
    // OPTIONS handler above is harmless but will never be triggered by a tap.
    // =========================================================================
    if (request.method === 'GET' && path.startsWith('/i/') && path.length > 3) {
      const code = path.slice(3); // strip '/i/' prefix

      const link = await env.G7_KV.get('scout:inbound:link:' + code, 'json');
      if (!link) {
        return new Response('Link not found.', {
          status:  404,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      // Increment click counter after the redirect is sent.
      // ctx.waitUntil() keeps the KV write alive after the 302 response is returned —
      // without it the Worker is terminated immediately on redirect and the write is lost.
      const clickKey = 'scout:inbound:' + link.firmCode + ':' + link.source + ':clicks';
      const clickRaw = await env.G7_KV.get(clickKey);
      const clicks   = clickRaw ? parseInt(clickRaw, 10) : 0;
      ctx.waitUntil(kvPut(env,clickKey, String(clicks + 1)));

      // Build wa.me URL and redirect
      const waUrl = 'https://wa.me/' + link.waNumber +
                    '?text=' + encodeURIComponent(link.message);

      return new Response(null, {
        status:  302,
        headers: { 'Location': waUrl }
      });
    }

    // ── Catch-all 404 ─────────────────────────────────────────────────────────
    return jsonResponse({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    const day = ist.toISOString().slice(0, 10);
    const report = { day: day, startedAt: new Date().toISOString(), firms: [] };

    /* Global kill switch — KV key cron:paused = "1" */
    if ((await env.G7_KV.get('cron:paused')) === '1') {
      report.state = 'paused';
      report.finishedAt = new Date().toISOString();
      console.log(JSON.stringify({ cron: report }));
      await kvPut(env,'cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
      return;
    }

    report.state = 'running';
    await kvPut(env,'cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });

    /* B6: Pre-generate shared categories only when at least one active firm
       needs them. Collect needed categories across all firms first. */
    var _neededCats = new Set();
    var _firmCities = {};
    let cursor0;
    do {
      const pg = await env.G7_KV.list({ prefix: 'market:ctx:', cursor: cursor0 });
      for (const k of pg.keys) {
        var fc0 = k.name.slice('market:ctx:'.length);
        var u0 = await env.G7_KV.get('auth:users:' + fc0, 'json') || {};
        if (u0.cronPaused || u0.isTest) continue;
        var ep0 = emailPrefs(u0);
        var active0 = ep0.actions || ep0.news;
        if (!active0) {
          var ls0 = await env.G7_KV.get('scout:lastSeen:' + fc0);
          var ago0 = ls0 ? Math.floor((Date.now() - new Date(ls0).getTime()) / 86400000) : 999;
          if (ago0 > 3) continue;
        }
        var prefs0;
        try { prefs0 = await resolveNewsPrefs(env, fc0, u0.newsPrefs); } catch (e) { prefs0 = u0.newsPrefs || []; }
        var ctx0 = await env.G7_KV.get('market:ctx:' + fc0, 'json');
        var city0 = (ctx0 && ctx0.city) || '';
        _firmCities[fc0] = city0;
        (Array.isArray(prefs0) ? prefs0 : []).forEach(function(c) { if (NEWS_CATS[c]) _neededCats.add(c); });
      }
      cursor0 = pg.list_complete ? undefined : pg.cursor;
    } while (cursor0);
    /* Generate each needed shared category once (they cache in KV).
       City news: once per DISTINCT active city. Others: once total. */
    /* Shared-news cost cap. */
    var _sbc = await sharedBudgetCheck(env, day);
    if (!_sbc.ok) {
      console.log(JSON.stringify({ sharedBudgetSkip: true, spent: _sbc.spent, cap: _sbc.cap }));
    }
    var cost = newCostAccum();
    var _distinctCities = new Set();
    Object.values(_firmCities).forEach(function(c) { if (c) _distinctCities.add(c); });
    for (var _cat of _neededCats) {
      if (!_sbc.ok) break;
      if (_cat === 'city') {
        for (var _city of _distinctCities) {
          try { await generateSharedNews(env, _cat, day, _city, cost); } catch (e) {
            console.log(JSON.stringify({ sharedPregenError: _cat, city: _city, error: String(e && e.message || e).slice(0, 300) }));
          }
        }
      } else {
        try { await generateSharedNews(env, _cat, day, '', cost); } catch (e) {
          console.log(JSON.stringify({ sharedPregenError: _cat, error: String(e && e.message || e).slice(0, 300) }));
        }
      }
    }
    /* Flush shared-news cost under firm "SHARED". */
    try { await flushCost(env, day, 'SHARED', cost); } catch (e) {}

    let cursor;
    do {
      const page = await env.G7_KV.list({ prefix: 'market:ctx:', cursor: cursor });
      for (const k of page.keys) {
        const firmCode = k.name.slice('market:ctx:'.length);
        report.current = firmCode;
        await kvPut(env,'cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
        const t0 = Date.now();
        try {
          const result = await runMorningForFirm(env, firmCode, day);
          if (typeof result === 'string') {
            report.firms.push({ firm: firmCode, status: result, ms: Date.now() - t0 });
          } else {
            report.firms.push({ firm: firmCode, status: result.status, cost: result.cost, ms: Date.now() - t0 });
          }
          await kvPut(env,'cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
        } catch (e) {
          report.firms.push({ firm: firmCode, status: 'error',
            error: String((e && e.message) || e).slice(0, 300), ms: Date.now() - t0 });
          await kvPut(env,'cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    report.state = 'done';
    delete report.current;
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify({ cron: report }));
    await kvPut(env,'cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
  }
};
