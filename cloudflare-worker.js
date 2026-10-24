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

/* Shared fetch wrapper for all Anthropic API calls.
   If the response is 403 with "Request not allowed" (region block), waits 1 s
   and retries once. Logs the colo (from _anthropicColo, set by the fetch
   handler) or "cron" with the error. Throws a clear message on second failure. */
var _anthropicColo = 'cron';
async function anthropicFetch(url, init) {
  var r = await fetch(url, init);
  if (r.status === 403) {
    var body403 = await r.text();
    if (/request not allowed/i.test(body403)) {
      console.log(JSON.stringify({ anthropic403: true, colo: _anthropicColo, body: body403.slice(0, 200), retry: true }));
      await new Promise(function(ok) { setTimeout(ok, 1000); });
      r = await fetch(url, init);
      if (r.status === 403) {
        var body403b = await r.text();
        console.log(JSON.stringify({ anthropic403: true, colo: _anthropicColo, body: body403b.slice(0, 200), retry: false }));
        throw new Error('Anthropic blocked this request (' + _anthropicColo + ') \u2014 check Worker placement');
      }
    }
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRUSTED NEWS DOMAINS — used for source verification.
// Edit this list when adding or removing sources.
// NEWS_CATS defines user-facing preference keys; FEED_CATS maps them to RSS queries.
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

/* Portals and quote sites that pollute business search results.
   Used as blocked_domains on the web_search tool. */
const BLOCKED_SEARCH_DOMAINS = [
  'magicbricks.com','99acres.com','housing.com','nobroker.in',
  'commonfloor.com','makaan.com','squareyards.com',
  'justdial.com','indiamart.com','sulekha.com',
  'in.investing.com','tradingview.com'
];

/* ── INDUSTRIES ──
   11 industry verticals. Each firm maps to one via resolveIndustry().
   Industry news is fetched from Google News RSS once per day per industry
   and shared across all firms in that industry.
   feeds = array of Google News search queries (4–6 per industry). */
const INDUSTRIES = {
  interior_design: {
    label: 'Interior design & architecture',
    types: ['Interior Designer / Architect'],
    feeds: [
      'plywood price India', 'modular kitchen India',
      'home furnishing India', 'housing sales India',
      'building materials prices India'
    ]
  },
  real_estate: {
    label: 'Real estate & property',
    types: ['Real Estate / Property Broker'],
    feeds: [
      'real estate India', 'property registration India',
      'housing demand India', 'RERA India',
      'stamp duty India', 'home loan rates India'
    ]
  },
  food_service: {
    label: 'Food & hospitality',
    types: ['Restaurant / Dhaba / Cafe','Catering Business','Cloud Kitchen'],
    feeds: [
      'restaurant India', 'FSSAI regulation India',
      'food delivery India', 'food prices India',
      'Zomato Swiggy India'
    ]
  },
  retail: {
    label: 'Retail & wholesale',
    types: ['Grocery / Supermart','Wholesale / Distribution','Pharmacy / Medical Store',
            'Stationery / Gift Shop','Clothing / Apparel Store','Jewellery Store',
            'Furniture / Home Decor','Electronics / Appliance Store',
            'Hardware / Building Materials','Sweet Shop / Mithai Store',
            'D2C Brand / Online Store'],
    feeds: [
      'retail India', 'consumer spending India',
      'FMCG India', 'GST rate India',
      'ecommerce India retail'
    ]
  },
  health_wellness: {
    label: 'Health & wellness',
    types: ['Gym / Fitness Centre','Salon / Spa / Beauty Parlour',
            'Medical Clinic / Doctor','Ayurvedic Clinic / Wellness Centre',
            'Diagnostic Lab / Pathology'],
    feeds: [
      'fitness industry India', 'healthcare India',
      'medical regulation India', 'gym wellness India',
      'health insurance India'
    ]
  },
  education: {
    label: 'Education & coaching',
    types: ['Coaching Centre / Tuition','Driving School',
            'Training / Corporate Learning'],
    feeds: [
      'education India', 'coaching institute India',
      'NEP education policy', 'edtech India',
      'skill training India'
    ]
  },
  auto_repair: {
    label: 'Automotive & repair',
    types: ['Automobile Workshop / Garage','Mobile / Electronics Repair'],
    feeds: [
      'automobile India', 'auto spare parts India',
      'electric vehicle India', 'vehicle sales India',
      'auto repair aftermarket India'
    ]
  },
  services_trade: {
    label: 'Local services & trade',
    types: ['Courier / Logistics','Printing / Packaging','Event Management',
            'Photography / Videography','Travel Agency / Tour Operator',
            'Security Agency / Manpower Supply','Tailoring / Garment Stitching'],
    feeds: [
      'small business India', 'MSME India',
      'gig economy India', 'logistics India',
      'services sector India'
    ]
  },
  digital_agency: {
    label: 'Digital & marketing agencies',
    types: ['Digital Marketing Agency'],
    feeds: [
      'digital marketing India', 'social media advertising India',
      'Google Meta ad policy', 'digital agency India',
      'influencer marketing India'
    ]
  },
  professional: {
    label: 'Professional services',
    types: ['CA / Accounting Firm','Legal Firm / Lawyer',
            'Consulting / Advisory Firm','B2B Services',
            'Recruitment / Staffing Firm'],
    feeds: [
      'income tax India', 'GST compliance India',
      'legal regulation India', 'consulting India',
      'chartered accountant India'
    ]
  },
  tech: {
    label: 'IT & software',
    types: ['IT Services / Software Company','SaaS / Software Product'],
    feeds: [
      'IT services India', 'SaaS India',
      'technology policy India', 'software outsourcing India',
      'startup funding India'
    ]
  }
};

/* ── FEED CATEGORIES ──
   Shared feed queries for policy, markets, global, and city news.
   Each maps to a user pref key (india_policy, india_markets, global, city).
   days = max age in days for feed items. */
const FEED_CATS = {
  india_policy: {
    label: 'India \u2014 politics & policy',
    feeds: ['GST India', 'RBI policy India', 'India government business policy'],
    days: 2
  },
  india_markets: {
    label: 'Indian stock market',
    feeds: ['Sensex Nifty'],
    days: 2
  },
  global: {
    label: 'Global markets',
    feeds: ['Brent crude oil price', 'Dow Jones market'],
    days: 2
  },
  city: {
    label: 'Your city',
    /* feeds built dynamically: ["<City> development", "<City> real estate"] */
    feeds: [],
    days: 7
  }
};

/* Map a business type string (from onboard.html BT_BUCKET) to an INDUSTRIES key.
   1. Exact match on types array.
   2. Keyword match on type text + optional sells context.
   Returns null when no match (caller should fall back to 'services_trade'). */
var _INDUSTRY_KW = [
  { key: 'interior_design', re: /interior|modular|furniture|kitchen/i },
  { key: 'food_service',    re: /restaurant|cafe|food|catering|cloud kitchen|dhaba/i },
  { key: 'health_wellness', re: /gym|salon|spa|clinic|doctor|fitness|wellness|diagnostic|pathology/i },
  { key: 'education',       re: /coaching|tuition|school|training|driving school/i },
  { key: 'professional',    re: /\bCA\b|accountant|legal|lawyer|consult|advocate|chartered/i },
  { key: 'real_estate',     re: /property|real estate|broker|RERA/i },
  { key: 'auto_repair',     re: /garage|repair|auto|workshop|automobile/i },
  { key: 'tech',            re: /software|IT services|\bSaaS\b|tech company/i },
  { key: 'digital_agency',  re: /marketing agency|digital agency/i },
  { key: 'retail',          re: /shop|store|retail|wholesale|trader|pharmacy|jeweller|hardware/i }
];

function resolveIndustry(businessType, sells) {
  if (!businessType && !sells) return null;
  var bt = String(businessType || '').trim();
  /* 1. Exact match on types array. */
  if (bt) {
    for (var key in INDUSTRIES) {
      if (INDUSTRIES[key].types.indexOf(bt) !== -1) return key;
    }
  }
  /* 2. Keyword match on type text + sells context. */
  var haystack = bt + ' ' + String(sells || '');
  for (var ki = 0; ki < _INDUSTRY_KW.length; ki++) {
    if (_INDUSTRY_KW[ki].re.test(haystack)) return _INDUSTRY_KW[ki].key;
  }
  return null;
}

/* Resolve industry for a firm from its scout state.
   Cached in its own KV key scout:industry:{FIRM} (no TTL) so it's computed once.
   Uses loadScoutState + st.pick() like the rest of the worker. */
async function resolveIndustryForFirm(env, firmCode) {
  /* Check dedicated KV key first. */
  var cached = await env.G7_KV.get('scout:industry:' + firmCode);
  if (cached && INDUSTRIES[cached]) return cached;
  /* Resolve from businessType / businessTypeInput / sells. */
  var st = await loadScoutState(env, firmCode);
  if (!st) return 'services_trade';
  var pend = st.pick('scout_pending_result') || {};
  var bt = (pend.businessData && pend.businessData.businessType) || '';
  var bti = (pend.businessData && pend.businessData.businessTypeInput) || '';
  var sells = '';
  /* Extract SELLS: line from context if available. */
  var ctx = await env.G7_KV.get('market:ctx:' + firmCode, 'json');
  if (ctx && ctx.context) {
    var sellsLine = String(ctx.context).split('\n').filter(function(l){ return l.indexOf('SELLS:') === 0; })[0];
    if (sellsLine) sells = sellsLine.replace('SELLS:', '').trim();
  }
  var resolved = resolveIndustry(bt, sells) || resolveIndustry(bti, sells) || 'services_trade';
  console.log(JSON.stringify({ resolveIndustry: firmCode, type: bt || bti, sells: sells.slice(0, 80), key: resolved }));
  /* Persist in own KV key (no TTL — settings can change it later). */
  try { await kvPut(env, 'scout:industry:' + firmCode, resolved); } catch (e) {}
  return resolved;
}

/* Normalise a city string that may contain neighbourhood/state parts.
   "Gomti Nagar, Lucknow, Uttar Pradesh" → "Lucknow" (second-to-last when 3+ parts).
   "Gomti Nagar, Lucknow" → "Lucknow" (last part when 2 parts).
   "Lucknow" → "Lucknow" (no commas, return as-is). */
function normaliseCity(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var parts = s.split(',').map(function(p) { return p.trim(); }).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  if (parts.length === 2) return parts[parts.length - 1];
  return parts[0];
}

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
// SHARED HELPERS — used by news pipeline and email renderer.
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
  if (!pageAge) return { recent: true, dated: false, _days: 999 }; /* undated — keep */
  var s = String(pageAge).toLowerCase().trim();
  /* Try ISO date first. */
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    var age = (Date.now() + 5.5 * 3600 * 1000) - d.getTime();
    var _isoDays = Math.max(0, Math.floor(age / 86400000));
    return { recent: age >= 0 && age <= maxDays * 86400 * 1000, dated: true, _days: _isoDays };
  }
  /* Parse relative: "X unit(s) ago" */
  var m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)/);
  if (!m) return { recent: true, dated: false, _days: 999 }; /* unparseable — keep */
  var n = parseInt(m[1], 10);
  var unit = m[2];
  var days = 0;
  if (unit === 'second' || unit === 'minute' || unit === 'hour') days = n < 24 ? 0 : 1;
  else if (unit === 'day') days = n;
  else if (unit === 'week') days = n * 7;
  else if (unit === 'month') days = n * 30;
  else if (unit === 'year') days = n * 365;
  return { recent: days <= maxDays, dated: true, _days: days };
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
   email and the admin test-email. Matches the shape of assembleNews output
   exactly: { business: { items: [] }, sections: [...] }. _marketLine items
   get compact rendering (headline + source only). news.html on the frontend
   uses scoutNewsFlatItems for the same shape, so email and web never drift.
   Returns { htmlParts:[], textParts:[], firstHeadline:'' }. */
function renderNewsBody(news) {
  var htmlParts = [];
  var textParts = [];
  var firstHeadline = '';
  var noEffect = 'No direct effect on your business.';

  var sections = (news && Array.isArray(news.sections)) ? news.sections : [];

  /* Helper: render an industry-style item (headline + why + Do this + source). */
  function renderIndustryItem(it) {
    if (!firstHeadline) firstHeadline = it.headline || '';
    var url = emailSafeUrl(it.sourceUrl || '');
    var h = '<div style="font-weight:600">' + escEmail(it.headline || '') + '</div>';
    if (it._marketLine) {
      /* Markets today — compact: headline + source only */
    } else {
      if (it.whatHappened) h += '<div style="font-size:13px;color:#888;margin-top:4px">' + escEmail(it.whatHappened) + '</div>';
      var why = (it.why || it.whyItMatters || '').trim();
      if (why && why !== noEffect) h += '<div style="margin-top:4px"><span style="color:#B8862B;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-right:6px">For you</span>' + escEmail(why) + '</div>';
      if (it.whatToDo) h += '<div style="margin-top:4px"><span style="color:#B8862B;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-right:6px">Do this</span>' + escEmail(it.whatToDo) + '</div>';
    }
    if (url) h += '<div style="margin-top:4px"><a href="' + escEmail(url) + '" style="font-size:12px;color:#888">' + escEmail(it.sourceTitle || 'Source') + '</a></div>';
    htmlParts.push(emailRow(h));
    var t = '  ' + (it.headline || '');
    if (!it._marketLine) {
      if (it.whatHappened) t += '\n  ' + it.whatHappened;
      var twhy = (it.why || it.whyItMatters || '').trim();
      if (twhy && twhy !== noEffect) t += '\n  For you: ' + twhy;
      if (it.whatToDo) t += '\n  Do this: ' + it.whatToDo;
    }
    if (it.sourceUrl) t += '\n  Source: ' + it.sourceUrl;
    textParts.push(t);
  }

  /* ── SECTIONS ──
     Industry sections render with For you + Do this.
     Other sections render as "Also worth knowing" style (whatHappened + For you). */
  sections.forEach(function(sec) {
    var items = (sec.items && sec.items.length) ? sec.items : [];
    if (!items.length) return;
    if (sec.category === 'industry') {
      htmlParts.push(emailHeading('Your industry'));
      textParts.push('YOUR INDUSTRY');
      items.forEach(renderIndustryItem);
    } else {
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
          var why = (it.why || it.whyItMatters || '').trim();
          if (why && why !== noEffect) {
            h += '<div style="margin-top:4px"><span style="color:#B8862B;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-right:6px">For you</span>' + escEmail(why) + '</div>';
          }
        }
        if (url) h += '<div style="margin-top:4px"><a href="' + escEmail(url) + '" style="font-size:12px;color:#888">' + escEmail(it.sourceTitle || 'Source') + '</a></div>';
        htmlParts.push(emailRow(h));
        var t = '  ' + (it.headline || '');
        if (!it._marketLine) {
          if (it.whatHappened) t += '\n  ' + it.whatHappened;
          var twhy = (it.why || it.whyItMatters || '').trim();
          if (twhy && twhy !== noEffect) t += '\n  For you: ' + twhy;
        }
        if (it.sourceUrl) t += '\n  Source: ' + it.sourceUrl;
        textParts.push(t);
      });
    }
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
  var indCount = (news.sections || []).reduce(function(n,s){ return n + (s.category === 'industry' ? (s.items||[]).length : 0); }, 0);
  var alsoCount = (news.sections || []).reduce(function(n,s){ return n + (s.category !== 'industry' ? (s.items||[]).length : 0); }, 0);
  return ok ? { sent: true, to: env.ADMIN_EMAIL, items: indCount + '+' + alsoCount } : { error: 'send_failed' };
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

  const r = await anthropicFetch('https://api.anthropic.com/v1/messages', {
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
// NEWS PIPELINE — Google News RSS feeds → one Haiku picker call per firm.
// ─────────────────────────────────────────────────────────────────────────────

/* Keep NEWS_CATS as a reference for resolveNewsPrefs — maps user pref keys. */
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

/* Decode common HTML entities that appear in Google News RSS titles. */
function _decodeHtmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); });
}

/* ── Google News RSS feed fetcher ──
   Fetches https://news.google.com/rss/search?q=<query>+when:<days>d&hl=en-IN&gl=IN&ceid=IN:en
   Parses items: title (stripped of " - Source"), link, pubDate, source.
   Dedupes by normalised title. Drops guide/listing titles. */
var _guideTitleRe = /\bguide\b|\bhow to\b|\bexplained\b|\bwhat is\b|\beverything you need\b|\bchecklist\b|\brates list\b|\btips\b|\bbest \d/i;
async function fetchNewsFeed(query, days) {
  var url = 'https://news.google.com/rss/search?q=' +
    encodeURIComponent(query + ' when:' + days + 'd') +
    '&hl=en-IN&gl=IN&ceid=IN:en';
  var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; G7Scout/1.0)' } });
  if (!r.ok) throw new Error('Google News RSS ' + r.status + ' for "' + query + '"');
  var xml = await r.text();
  /* Parse <item> blocks from RSS XML. */
  var items = [];
  var seen = new Set();
  var _itemRe = /<item>([\s\S]*?)<\/item>/g;
  var match;
  while ((match = _itemRe.exec(xml)) !== null) {
    var block = match[1];
    var _t = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    var _l = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    var _d = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    var _s = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    /* Strip CDATA wrappers, then decode HTML entities. */
    _t = _t.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    _l = _l.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    _s = _s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    _t = _decodeHtmlEntities(_t);
    _s = _decodeHtmlEntities(_s);
    var _dashIdx = _t.lastIndexOf(' - ');
    if (_dashIdx > 20) {
      if (!_s) _s = _t.slice(_dashIdx + 3).trim();
      _t = _t.slice(0, _dashIdx).trim();
    }
    if (!_t || !_l) continue;
    /* Drop guide/listing titles. */
    if (_guideTitleRe.test(_t)) continue;
    /* Dedupe by normalised title (lowercase, stripped of punctuation). */
    var _norm = _t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(_norm)) continue;
    seen.add(_norm);
    items.push({
      title: _t.slice(0, 150),
      link: _l,
      pubDate: _d ? new Date(_d).toISOString() : '',
      source: _s.slice(0, 80)
    });
  }
  return items;
}

/* Fetch all feeds for an industry, merge, dedupe, drop stale (>7d).
   Cached in KV at news:industry:<KEY>:<day> with 48h TTL. */
async function fetchIndustryFeeds(env, industryKey, day) {
  var def = INDUSTRIES[industryKey];
  if (!def || !def.feeds || !def.feeds.length) return { category: 'industry', industry: industryKey, label: (def && def.label) || '', items: [], date: day };
  var cacheKey = 'news:industry:' + industryKey + ':' + day;
  var cached = await env.G7_KV.get(cacheKey, 'json');
  if (cached) return cached;

  var all = [];
  var errors = [];
  for (var fi = 0; fi < def.feeds.length; fi++) {
    try {
      var items = await fetchNewsFeed(def.feeds[fi], 7);
      all = all.concat(items);
    } catch (e) {
      errors.push({ query: def.feeds[fi], error: String(e && e.message || e).slice(0, 200) });
    }
  }

  /* Dedupe across all feeds by normalised title. */
  var seen = new Set();
  var merged = [];
  var now = Date.now();
  all.forEach(function(it) {
    var norm = it.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(norm)) return;
    seen.add(norm);
    /* Drop items older than 7 days. */
    if (it.pubDate) {
      var age = now - new Date(it.pubDate).getTime();
      if (age > 7 * 86400000) return;
    }
    merged.push(it);
  });

  /* Sort newest first. */
  merged.sort(function(a, b) {
    return (b.pubDate || '').localeCompare(a.pubDate || '');
  });

  /* Final dedupe by headline words (same as dedupeItems but on title field). */
  var cleaned = merged.slice(0, 30).map(function(it) {
    return { headline: it.title, sourceUrl: it.link, sourceTitle: it.source, pubDate: it.pubDate };
  });
  cleaned = dedupeItems(cleaned);

  var result = { category: 'industry', industry: industryKey, label: def.label, items: cleaned.slice(0, 15), date: day };
  if (errors.length) {
    console.log(JSON.stringify({ industryFeedErrors: industryKey, errors: errors }));
    result._feedErrors = errors;
  }
  await kvPut(env, cacheKey, JSON.stringify(result), { expirationTtl: 172800 });
  return result;
}

/* Fetch feeds for a shared category (policy, markets, global, city).
   Cached in KV at news:<cat>[:<citySlug>]:<day> with 48h TTL. */
async function fetchCategoryFeeds(env, cat, day, city) {
  var def = FEED_CATS[cat];
  if (!def) return { category: cat, label: cat, items: [], date: day };
  var citySlug = (city || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  var cacheKey = 'news:' + cat + (cat === 'city' ? ':' + citySlug : '') + ':' + day;
  var cached = await env.G7_KV.get(cacheKey, 'json');
  if (cached) return cached;

  /* Build feed queries. City uses dynamic queries. */
  var feedQueries = [];
  if (cat === 'city') {
    var normCity = normaliseCity(city);
    if (!normCity) return { category: cat, label: 'Your city', items: [], date: day };
    feedQueries = [normCity + ' development', normCity + ' real estate', normCity + ' business'];
  } else {
    feedQueries = def.feeds || [];
  }

  var all = [];
  var errors = [];
  for (var fi = 0; fi < feedQueries.length; fi++) {
    try {
      var items = await fetchNewsFeed(feedQueries[fi], def.days);
      all = all.concat(items);
    } catch (e) {
      errors.push({ query: feedQueries[fi], error: String(e && e.message || e).slice(0, 200) });
    }
  }

  /* Dedupe, drop stale. */
  var seen = new Set();
  var merged = [];
  var now = Date.now();
  all.forEach(function(it) {
    var norm = it.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(norm)) return;
    seen.add(norm);
    if (it.pubDate) {
      var age = now - new Date(it.pubDate).getTime();
      if (age > def.days * 86400000) return;
    }
    merged.push(it);
  });

  merged.sort(function(a, b) {
    return (b.pubDate || '').localeCompare(a.pubDate || '');
  });

  var cleaned = merged.slice(0, 20).map(function(it) {
    return { headline: it.title, sourceUrl: it.link, sourceTitle: it.source, pubDate: it.pubDate };
  });
  cleaned = dedupeItems(cleaned);

  var result = { category: cat, label: def.label || cat, items: cleaned.slice(0, 10), date: day };
  if (errors.length) result._feedErrors = errors;
  await kvPut(env, cacheKey, JSON.stringify(result), { expirationTtl: 172800 });
  return result;
}

/* Civic topics — never show in "Also worth knowing". */
var _civicRe = /\b(water supply|water cut|traffic|power cut|load.?shedding|crime|robbery|murder|theft|politics|political|weather|rain|flood|heat.?wave|cold.?wave|storm|cyclone)\b/i;

/* ── NEWS PICKER ──
   One Haiku call per firm: receives numbered candidate titles + context,
   returns indexes + For you / Do this for each picked item. */
async function pickNewsForFirm(env, firmCode, day, context, industryCandidates, categoryCandidates, cost) {
  var cacheKey = 'news:firm:' + firmCode + ':' + day;
  var cached = await env.G7_KV.get(cacheKey, 'json');
  if (cached) return cached;

  /* Number all candidates so the model picks by index. */
  var numbered = [];
  var indexMap = {}; /* index → { source: 'industry'|cat, item } */

  industryCandidates.forEach(function(it, i) {
    var idx = numbered.length;
    numbered.push({ idx: idx, headline: it.headline, source: it.sourceTitle || '' });
    indexMap[idx] = { source: 'industry', item: it };
  });

  var catItems = {};
  Object.keys(categoryCandidates).forEach(function(cat) {
    catItems[cat] = [];
    (categoryCandidates[cat] || []).forEach(function(it) {
      var idx = numbered.length;
      numbered.push({ idx: idx, headline: it.headline, source: it.sourceTitle || '', category: cat });
      indexMap[idx] = { source: cat, item: it };
      catItems[cat].push(idx);
    });
  });

  if (!numbered.length) {
    var empty = { industry: [], also: [], markets: null, generatedAt: new Date().toISOString() };
    await kvPut(env, cacheKey, JSON.stringify(empty), { expirationTtl: 172800 });
    return empty;
  }

  var system =
    'You pick the most useful news for one Indian small business.\n\n' +
    'RULES:\n' +
    (industryCandidates.length > 0 ? '- Pick 3–4 items for "industry" (items 0–' + (industryCandidates.length - 1) + ' are industry news).\n' : '- No industry candidates available — leave "industry" empty.\n') +
    '- Pick up to 3 items for "also" from the remaining categories (policy, city). ' +
    'Skip civic topics (water, traffic, power cuts, crime, weather, local politics) unless they directly affect this trade.\n' +
    '- For each pick: why (one sentence, under 25 words, concrete effect on this business, ' +
    'or exactly "No direct effect on your business.") and whatToDo (one concrete action under 15 words, or "").\n' +
    '- impact: one of demand_up, demand_down, cost_up, cost_down, lead_source, ' +
    'competitor, regulation, timing, none.\n' +
    '- impact "competitor" ONLY when the company in the news operates in the same city/region.\n' +
    '- You may ONLY choose from the given indexes. Copy them exactly.\n' +
    '- If a markets or global item exists, pick the single best one as "markets" (compact line, no why/whatToDo).\n\n' +
    'Reply with ONLY this JSON:\n' +
    '{"industry":[{"idx":N,"why":"","whatToDo":"","impact":""},...],\n' +
    ' "also":[{"idx":N,"why":"","whatToDo":"","impact":""},...],\n' +
    ' "markets":{"idx":N} or null}';

  var r = await anthropicFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-5-5', max_tokens: 2000, thinking: { type: 'disabled' },
      system: system,
      messages: [{ role: 'user', content: 'BUSINESS:\n' + String(context).slice(0, 2500) +
        '\n\nCANDIDATES:\n' + JSON.stringify(numbered) }]
    })
  });

  var picks = { industry: [], also: [], markets: null };
  if (r.ok) {
    var d = await r.json();
    recordCost(cost, 'claude-haiku-5-5', d);
    var t = (d.content || []).filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('');
    try {
      var a = t.indexOf('{'), z = t.lastIndexOf('}');
      if (a !== -1 && z > a) picks = JSON.parse(t.slice(a, z + 1));
    } catch (e) {}
  } else {
    var errText = await r.text();
    throw new Error('Haiku picker ' + r.status + ': ' + errText.slice(0, 300));
  }

  /* Resolve indexes to real items. Drop any invalid index. */
  var NO_EFFECT = 'No direct effect on your business.';
  function resolvePickedItems(arr, maxCount) {
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function(p) {
      if (out.length >= maxCount) return;
      var idx = (typeof p === 'object' && p !== null) ? p.idx : p;
      if (typeof idx !== 'number' || !indexMap[idx]) return;
      var src = indexMap[idx];
      var it = Object.assign({}, src.item);
      if (p.why) it.why = String(p.why);
      if (p.whatToDo) it.whatToDo = String(p.whatToDo);
      if (p.impact) it.impact = String(p.impact);
      if (p.why && p.why !== NO_EFFECT) it.whyItMatters = p.why;
      out.push(it);
    });
    return out;
  }

  var industryPicked = resolvePickedItems(picks.industry, 4);
  var alsoPicked = resolvePickedItems(picks.also, 3);

  /* Fallback: if fewer than 2 industry items picked but candidates exist,
     take the newest remaining ones without For you / Do this. */
  if (industryPicked.length < 2 && industryCandidates.length > 0) {
    var pickedUrls = new Set(industryPicked.map(function(it){ return it.sourceUrl; }));
    for (var fi = 0; fi < industryCandidates.length && industryPicked.length < 2; fi++) {
      if (!pickedUrls.has(industryCandidates[fi].sourceUrl)) {
        industryPicked.push(Object.assign({}, industryCandidates[fi]));
      }
    }
  }

  /* Filter civic items from also. */
  alsoPicked = alsoPicked.filter(function(it) { return !_civicRe.test(it.headline || ''); });

  /* Markets line. */
  var marketsItem = null;
  if (picks.markets && typeof picks.markets.idx === 'number' && indexMap[picks.markets.idx]) {
    marketsItem = Object.assign({}, indexMap[picks.markets.idx].item, { _marketLine: true });
  }

  var result = {
    industry: industryPicked,
    also: alsoPicked,
    markets: marketsItem,
    generatedAt: new Date().toISOString()
  };
  await kvPut(env, cacheKey, JSON.stringify(result), { expirationTtl: 172800 });
  return result;
}

/* Professional business types that get india_markets in their default prefs. */
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
   Reads cached feeds + picker result from KV. Builds the final news object.
   Section order: Your industry → Also worth knowing → (no "Your area" section)
   opts:
     context   — business context string (needed for picker)
     city      — firm's city
     prefs     — array of NEWS_CATS keys (india_policy, india_markets, global, city)
     cost      — cost accumulator
     cacheOnly — when true, return null if nothing cached (never generate)
     industry  — INDUSTRIES key for this firm (from resolveIndustryForFirm)
   All three consumers — GET /scout/news, sendNewsEmail, sendTestNewsEmail —
   call this so they can never drift. */
async function assembleNews(env, firmCode, day, opts) {
  var context = opts.context || '';
  var city = opts.city || '';
  var prefs = opts.prefs || [];
  var cost = opts.cost || null;
  var cacheOnly = opts.cacheOnly || false;
  var industry = opts.industry || 'services_trade';
  var errors = [];

  /* ── 1. Industry feed from cache ── */
  var industrySec = await env.G7_KV.get('news:industry:' + industry + ':' + day, 'json');
  if (!industrySec && !cacheOnly) {
    try { industrySec = await fetchIndustryFeeds(env, industry, day); } catch (e) {
      errors.push({ stage: 'industry', error: String(e && e.message || e).slice(0, 200) });
    }
  }

  /* ── 2. Category feeds from cache ── */
  var chosen = (Array.isArray(prefs) ? prefs : []).filter(function(c){ return FEED_CATS[c]; });
  var catFeeds = {};
  for (var ci = 0; ci < chosen.length; ci++) {
    var c = chosen[ci];
    var citySlug = (city || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
    var catKey = 'news:' + c + (c === 'city' ? ':' + citySlug : '') + ':' + day;
    var sec = await env.G7_KV.get(catKey, 'json');
    if (!sec && !cacheOnly) {
      try { sec = await fetchCategoryFeeds(env, c, day, city); } catch (e) {
        errors.push({ stage: c, error: String(e && e.message || e).slice(0, 200) });
      }
    }
    if (sec && sec.items && sec.items.length) catFeeds[c] = sec.items;
  }

  /* ── 3. Picker: one Haiku call per firm ── */
  var industryCandidates = (industrySec && industrySec.items) || [];
  var pickerResult;
  if (cacheOnly) {
    pickerResult = await env.G7_KV.get('news:firm:' + firmCode + ':' + day, 'json');
    if (!pickerResult && !industryCandidates.length && !Object.keys(catFeeds).length) return null;
    if (!pickerResult) pickerResult = { industry: [], also: [], markets: null };
  } else {
    pickerResult = await pickNewsForFirm(env, firmCode, day, context, industryCandidates, catFeeds, cost);
  }

  /* ── 4. Build output sections ── */
  var NO_EFFECT = 'No direct effect on your business.';

  /* 4a. Industry section */
  var finalSections = [];
  if (pickerResult.industry && pickerResult.industry.length > 0) {
    var indLabel = (INDUSTRIES[industry] && INDUSTRIES[industry].label) || 'Your industry';
    finalSections.push({ category: 'industry', label: indLabel, items: pickerResult.industry });
  }

  /* 4b. Also worth knowing */
  var alsoItems = (pickerResult.also || []).filter(function(it) {
    /* Drop civic topics. */
    if (_civicRe.test(it.headline || '')) return false;
    return true;
  });

  /* 4c. Markets / global compact line */
  if (pickerResult.markets) {
    /* Check if market headline is a dupe of an also item. */
    var mHeadline = (pickerResult.markets.headline || '').toLowerCase();
    var _mWords = mHeadline.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(function(w){ return w.length > 3; });
    var isDupe = alsoItems.some(function(it) {
      var ah = (it.headline || '').toLowerCase();
      var shared = _mWords.filter(function(w){ return ah.indexOf(w) !== -1; }).length;
      return shared >= 3;
    });
    if (!isDupe) alsoItems.push(pickerResult.markets);
  }

  if (alsoItems.length > 0) {
    finalSections.push({ category: 'also', label: 'Also worth knowing', items: alsoItems });
  }

  /* ── 5. Final object (same shape as before — business is always empty now) ── */
  var out = {
    business: { items: [] },
    sections: finalSections,
    errors: errors,
    industry: industry,
    generatedAt: pickerResult.generatedAt || new Date().toISOString()
  };
  return out;
}

/* Everything a firm reads today: fetch industry + category feeds (shared),
   then pick per firm. Used by cron, admin regen-news, GET /scout/news. */
async function buildDailyNews(env, firmCode, day, context, city, prefs, cost) {
  var _genError = null;

  /* ── 1. Industry feeds (shared, cached by industry key) ── */
  var industry = await resolveIndustryForFirm(env, firmCode);
  try {
    await fetchIndustryFeeds(env, industry, day);
  } catch (e) {
    var indErr = String((e && e.message) || e).slice(0, 300);
    console.log(JSON.stringify({ industryFeedFallback: firmCode, industry: industry, reason: indErr }));
    _genError = { stage: 'industry_feed', reason: indErr };
  }

  /* ── 2. Category feeds (shared, cached) ── */
  var chosen = (Array.isArray(prefs) ? prefs : []).filter(function(c){ return FEED_CATS[c]; });
  for (var ci = 0; ci < chosen.length; ci++) {
    var c = chosen[ci];
    try {
      await fetchCategoryFeeds(env, c, day, city);
    } catch (e) {
      var catErr = String((e && e.message) || e).slice(0, 300);
      console.log(JSON.stringify({ catFeedFallback: c, reason: catErr }));
      if (!_genError) _genError = { stage: c + '_feed', reason: catErr };
    }
  }

  /* ── 3. Assemble from caches + run picker ── */
  var result = await assembleNews(env, firmCode, day, { context: context, city: city, prefs: prefs, cost: cost, industry: industry });
  if (result) {
    if (_genError) result._genError = _genError;
  }
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

  /* Signals: section items (industry first, then also-worth-knowing).
     Industry items carry whyItMatters + whatToDo from the Haiku picker. */
  const signals = [];
  ((news && news.sections) || []).forEach(function(s) {
    (s.items || []).forEach(function(it) {
      if (it.impact && it.impact !== 'none') {
        signals.push({ i: signals.length, headline: it.headline,
                       what: it.whatHappened || '', why: it.whyItMatters || it.why || '',
                       whatToDo: it.whatToDo || '',
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

  const r = await anthropicFetch('https://api.anthropic.com/v1/messages', {
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
  buildDailyNews, assembleNews, pickNewsForFirm,
  fetchNewsFeed, fetchIndustryFeeds, fetchCategoryFeeds,
  resolveIndustry, resolveIndustryForFirm,
  resolveNewsPrefs, cleanNewsItem, stripCite, clip,
  clipOneSentence, dedupeItems, sourceMatchCheck,
  checkPageAge, evergreenCheck, isHomePage, isListingOrQuote,
  shortHash, isBillingError,
  renderNewsBody, newsGreetingName, displayName, normaliseCity,
  TRUSTED_NEWS_DOMAINS, BLOCKED_SEARCH_DOMAINS, COST_TABLE, NEWS_CATS, INDUSTRIES, FEED_CATS
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {

    // Set colo for Anthropic 403 logging (cron handler sets it to 'cron').
    _anthropicColo = (request.cf && request.cf.colo) || 'unknown';

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
        anthropicResponse = await anthropicFetch(ANTHROPIC_ENDPOINT, {
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
        var effectivePrefs; try { effectivePrefs = await resolveNewsPrefs(env, firmCode, user.newsPrefs); } catch (e2) { effectivePrefs = user.newsPrefs || []; }
        const news = await buildDailyNews(env, firmCode, day, saved.context, saved.city || '', effectivePrefs, cost);
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
    // Deletes today's per-firm picker + industry feed caches and regenerates.
    // If shared:true, also deletes shared category caches for the day.
    // Returns the news result plus cost info.
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
        /* Delete caches: per-firm picker + industry feeds. */
        await env.G7_KV.delete('news:firm:' + firmCode + ':' + day);
        /* Clear industry: delete cached resolution so it re-resolves fresh,
           then resolve and delete the industry news cache for this day. */
        await env.G7_KV.delete('scout:industry:' + firmCode);
        var _regenIndustry = 'services_trade';
        try { _regenIndustry = await resolveIndustryForFirm(env, firmCode); } catch(e){}
        await env.G7_KV.delete('news:industry:' + _regenIndustry + ':' + day);

        /* Optionally nuke shared category caches too. */
        if (body.shared) {
          var citySlug = (saved.city || '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
          for (var catKey of Object.keys(FEED_CATS)) {
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

        /* _genError is already captured above; no additional soft-failure detection needed. */

        var bizLog = (news && news._log) || null;
        if (news) { delete news._log; delete news._genError; }

        /* Flush this run's cost first, then read spend so it includes this run. */
        await flushCost(env, day, firmCode, cost);
        var _bc = await budgetCheck(env, day, firmCode);
        var spendInfo = { firmSpent: _bc.firmSpent, firmCap: _bc.cap || 0 };

        /* Count items per section for the admin popup. */
        var _indItems = 0, _alsoItems = 0;
        if (news && news.sections) {
          news.sections.forEach(function(s) {
            if (s.category === 'industry' && s.items) _indItems += s.items.length;
            if (s.category === 'also' && s.items) _alsoItems += s.items.length;
          });
        }

        var resp = { news: news, log: bizLog, cost: Object.assign({}, cost), spend: spendInfo,
                     industry: _regenIndustry, industryItems: _indItems,
                     alsoItems: _alsoItems };
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

      const anthropicResponse = await anthropicFetch('https://api.anthropic.com/v1/messages', {
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

      const anthropicResponse = await anthropicFetch('https://api.anthropic.com/v1/messages', {
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
    // Daily news: industry + category news from Google News RSS,
    // picked per firm by a single Haiku call.
    // Body: { context, city }
    // Cached per firm per IST day.
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
      }

      /* IST date — the brief belongs to the owner's day, not UTC's. */
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = ist.toISOString().slice(0, 10);

      /* Try cache-only assembly first (cron pre-fetches feeds + picker runs). */
      var user2 = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      var prefs2 = await resolveNewsPrefs(env, session.firmCode, user2.newsPrefs);
      var ind2 = 'services_trade';
      try { ind2 = await resolveIndustryForFirm(env, session.firmCode); } catch(e){}
      var cached2 = await assembleNews(env, session.firmCode, day, { context: context, city: city, prefs: prefs2, cacheOnly: true, industry: ind2 });
      if (cached2) return jsonResponse(cached2);

      if (!context) return jsonResponse({ business: { items: [] }, sections: [], date: day });

      /* Firm money backstop */
      var _bcM = await budgetCheck(env, day, session.firmCode);
      if (!_bcM.ok) {
        ctx.waitUntil(sendBudgetEmail(env, day, session.firmCode, _bcM.firmSpent, _bcM.cap));
        return jsonResponse({ business: { items: [] }, sections: [], date: day, budgetPaused: true });
      }

      /* Concurrency lock — prevents duplicate generation if two tabs load
         at the same time. Auto-expires after 120 s as a safety net. */
      const lockKey = 'market:lock:' + session.firmCode + ':' + day;
      if (await env.G7_KV.get(lockKey)) return jsonResponse({ business: { items: [] }, sections: [], date: day, pending: true });
      await kvPut(env,lockKey, '1', { expirationTtl: 120 });

      /* Three generation attempts per firm per day. */
      const attemptKey = 'market:attempts:' + session.firmCode + ':' + day;
      const attempts = parseInt((await env.G7_KV.get(attemptKey)) || '0', 10);
      if (attempts >= 3) {
        await env.G7_KV.delete(lockKey);
        return jsonResponse({ business: { items: [] }, sections: [], date: day, limited: true });
      }
      await kvPut(env,attemptKey, String(attempts + 1), { expirationTtl: 172800 });

      var cost = newCostAccum();
      try {
        const result = await buildDailyNews(env, session.firmCode, day, context, city, prefs2, cost);
        await env.G7_KV.delete(lockKey);
        ctx.waitUntil(flushCost(env, day, session.firmCode, cost));
        return jsonResponse(result || { business: { items: [] }, sections: [] });
      } catch (e) {
        await env.G7_KV.delete(lockKey);
        ctx.waitUntil(flushCost(env, day, session.firmCode, cost));
        console.log(JSON.stringify({ newsFallback: session.firmCode, reason: String(e.message || '').slice(0, 300) }));
        if (isBillingError(e)) await sendCreditAlert(env, day);
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

      const anthropicResponse = await anthropicFetch('https://api.anthropic.com/v1/messages', {
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
        /* No context saved — try cache-only assembly from previous cron run. */
        var user0 = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
        var prefs0 = await resolveNewsPrefs(env, session.firmCode, user0.newsPrefs);
        var ind0 = 'services_trade';
        try { ind0 = await resolveIndustryForFirm(env, session.firmCode); } catch(e){}
        var cached0 = await assembleNews(env, session.firmCode, today, { prefs: prefs0, cacheOnly: true, industry: ind0 });
        if (cached0) return jsonResponse(cached0);
        return jsonResponse({ business: { items: [] }, sections: [] });
      }
      const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      const effectivePrefs = await resolveNewsPrefs(env, session.firmCode, user.newsPrefs);
      /* Firm money backstop — serve cache when over cap. */
      var _bc1 = await budgetCheck(env, today, session.firmCode);
      if (!_bc1.ok) {
        ctx.waitUntil(sendBudgetEmail(env, today, session.firmCode, _bc1.firmSpent, _bc1.cap));
        var ind1 = 'services_trade';
        try { ind1 = await resolveIndustryForFirm(env, session.firmCode); } catch(e){}
        var cached1 = await assembleNews(env, session.firmCode, today, { city: saved.city || '', prefs: effectivePrefs, cacheOnly: true, industry: ind1 });
        if (cached1) return jsonResponse(Object.assign({}, cached1, { budgetPaused: true }));
        return jsonResponse({ business: { items: [] }, sections: [], budgetPaused: true });
      }
      var cost = newCostAccum();
      const news = await buildDailyNews(env, session.firmCode, today, saved.context, saved.city || '', effectivePrefs, cost);
      if (news) { delete news._log; delete news._genError; }
      ctx.waitUntil(flushCost(env, today, session.firmCode, cost));
      return jsonResponse(news || { business: { items: [] }, sections: [] });
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
        var effectivePrefs; try { effectivePrefs = await resolveNewsPrefs(env, session.firmCode, user.newsPrefs); } catch (e2) { effectivePrefs = user.newsPrefs || []; }
        const news = await buildDailyNews(env, session.firmCode, today, saved.context, saved.city || '', effectivePrefs, cost);
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
    _anthropicColo = 'cron';
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

    /* B6: Pre-generate shared categories + industry news.
       Scan active firms to collect needed categories and industries. */
    var _neededCats = new Set();
    var _neededIndustries = new Set();
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
        (Array.isArray(prefs0) ? prefs0 : []).forEach(function(c) { if (FEED_CATS[c]) _neededCats.add(c); });
        /* Collect needed industries for this firm. */
        try {
          var ind0 = await resolveIndustryForFirm(env, fc0);
          _neededIndustries.add(ind0);
        } catch (e) { _neededIndustries.add('services_trade'); }
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

    /* Pre-fetch industry RSS feeds (one per distinct industry). */
    for (var _ind of _neededIndustries) {
      if (!_sbc.ok) break;
      try { await fetchIndustryFeeds(env, _ind, day); } catch (e) {
        console.log(JSON.stringify({ industryPregenError: _ind, error: String(e && e.message || e).slice(0, 300) }));
      }
    }

    var _distinctCities = new Set();
    Object.values(_firmCities).forEach(function(c) { if (c) _distinctCities.add(c); });
    for (var _cat of _neededCats) {
      if (!_sbc.ok) break;
      if (_cat === 'city') {
        for (var _city of _distinctCities) {
          try { await fetchCategoryFeeds(env, _cat, day, _city); } catch (e) {
            console.log(JSON.stringify({ sharedPregenError: _cat, city: _city, error: String(e && e.message || e).slice(0, 300) }));
          }
        }
      } else {
        try { await fetchCategoryFeeds(env, _cat, day, ''); } catch (e) {
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
