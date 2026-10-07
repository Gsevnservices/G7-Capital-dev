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

/* A home page, section page or listing page cannot be the source of a
   specific fact — only an article can. */
function isHomePage(u) {
  try {
    var url = new URL(u);
    var p = url.pathname.replace(/\/+$/, '');
    if (p === '' || /^\/(index|home|default)(\.[a-z]+)?$/i.test(p)) return true;
    if (/allrelease|archive|latest-news|\/tag\/|\/topic\/|\/category\//i.test(u)) return true;
    var segs = p.split('/').filter(Boolean);
    var last = segs[segs.length - 1] || '';
    /* One short word with no digits ("/economy", "/markets") is a section
       page — unless the query carries an article id, as PIB's do. */
    var hasId = /[?&](prid|id|newsid|articleid)=/i.test(url.search);
    if (segs.length === 1 && last.length < 20 && !/\d/.test(last) && !hasId) return true;
    return false;
  } catch (e) { return true; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKET BRIEF GENERATOR — used by both the HTTP route and the scheduled job.
// ─────────────────────────────────────────────────────────────────────────────
async function generateMarketBrief(env, firmCode, day, context, city, macroOnly) {
  /* History — what Scout already told this owner in the last two weeks. */
  const histKey = 'market:history:' + firmCode;
  const history = (await env.G7_KV.get(histKey, 'json')) || [];
  const told = history.map(function(h){ return '- ' + h.headline + ' (' + h.sourceUrl + ')'; }).join('\n');

  var system =
    'You are Scout, the business-development employee for one Indian small business. ' +
    'Today is ' + day + ' (India). Find the news from the last 7 days that matters to ' +
    'THIS business, at two levels:\n' +
    'MICRO — its city and trade: local developments, competitors, demand in its area.\n' +
    'MACRO — the economy and policy that move its trade: interest rates, input and ' +
    'material prices, tax and rule changes, sector demand, government schemes.\n' +
    'There is always macro news affecting any Indian trade in a given week. Return ' +
    'between 2 and 4 items, at least one MACRO. Never return zero.\n\n' +
    'SEARCH FOR, in this order:\n' +
    '1. Local developments near the business: new offices, IT parks, residential projects, ' +
    'colleges, hospitals, malls, metro or road work — anything that brings or removes customers.\n' +
    '2. Competitors: openings, closures, price changes, offers, in this city and area.\n' +
    '3. Local events and festivals in the next 6 weeks that this trade can use.\n' +
    '4. Rule, licence or tax changes that specifically affect this trade.\n' +
    '5. Price moves in this trade\'s main inputs.\n\n' +
    'NOT NEWS: something that already existed. A competitor simply having ' +
    'a shop, or a festival that happens every year, is not a change. A festival ' +
    'counts only if it is within the next 3 weeks and you give its exact date.\n\n' +
    'RULES:\n' +
    '- Every item must come from a page you actually found with web search. Never invent ' +
    'a development, a competitor, a date or a number.\n' +
    '- whatToDo must be one concrete action this week, tied to one of the business\'s ' +
    'customer groups by name where possible.\n' +
    '- Never write labels like "Customer 1", "Customer 2" or "ICP 1". Use the ' +
    'customer group names given in the business context.\n' +
    '- sourceUrl must be the page that actually states the fact in whatHappened, ' +
    'not a general listing or directory page.\n' +
    '- Plain English. No jargon. Indian context.\n\n' +
    'After searching, reply with ONLY this JSON and nothing else:\n' +
    '{"items":[{"headline":"under 10 words","whatHappened":"one sentence, under 30 words",' +
    '"whyItMatters":"one sentence, under 30 words, specific to this business",' +
    '"whatToDo":"one sentence, under 30 words, one action this week",' +
    '"urgency":"today | this_week | watch",' +
    '"scope":"micro | macro",' +
    '"sourceTitle":"page title","sourceUrl":"exact URL from your search results"}]}';

  if (macroOnly) {
    system += '\nTHIS RUN: local news was empty. Search MACRO only — national economy, ' +
      'policy and prices for this trade. Return 2 to 3 items.';
  }

  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 4 };
  if (city) {
    tool.user_location = { type: 'approximate', city: city, country: 'IN', timezone: 'Asia/Kolkata' };
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: system,
      tools: [tool],
      messages: [{ role: 'user', content: 'THE BUSINESS:\n' + context +
        (told ? '\n\nALREADY TOLD THE OWNER IN THE LAST TWO WEEKS — do not repeat these, ' +
                'or anything on the same topic, unless something genuinely new has happened:\n' + told : '') }]
    })
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error('Anthropic ' + r.status + ': ' + errText.slice(0, 500));
  }
  const data = await r.json();

  /* Collect every URL web search actually returned. */
  const seen = new Set();
  (data.content || []).forEach(function(b) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      b.content.forEach(function(res) { if (res && res.url) seen.add(res.url); });
    }
  });

  /* The final answer can be split across several text blocks when the
     model cites sources. Join them, then take the outermost JSON object. */
  const text = (data.content || [])
    .filter(function(b){ return b.type === 'text'; })
    .map(function(b){ return b.text; }).join('');
  let parsed = { items: [] };
  try {
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a !== -1 && z > a) parsed = JSON.parse(text.slice(a, z + 1));
  } catch (e) {}

  /* Hard gate: drop items whose sourceUrl was already told in history. */
  const toldUrls = new Set(history.map(function(h){ return h.sourceUrl; }));

  /* Integrity gate: an item survives only if its source URL is one web
     search really returned, was not already told, and is not a home page. */
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter(function(it) {
      return it && it.headline && it.whatToDo && it.sourceUrl && seen.has(it.sourceUrl) && !toldUrls.has(it.sourceUrl) && !isHomePage(it.sourceUrl);
    })
    .slice(0, 4)
    .map(function(it) {
      return {
        headline: String(it.headline).slice(0, 120),
        whatHappened: clip(it.whatHappened, 400),
        whyItMatters: clip(it.whyItMatters, 400),
        whatToDo: clip(it.whatToDo, 400),
        urgency: ['today','this_week','watch'].indexOf(it.urgency) !== -1 ? it.urgency : 'watch',
        scope: it.scope === 'micro' ? 'micro' : 'macro',
        sourceTitle: String(it.sourceTitle || '').slice(0, 160),
        sourceUrl: it.sourceUrl
      };
    });

  /* If nothing survived and we haven't tried macro-only yet, retry. */
  if (items.length === 0 && !macroOnly) {
    return generateMarketBrief(env, firmCode, day, context, city, true);
  }

  const result = {
    items: items,
    date: day,
    dropped: (Array.isArray(parsed.items) ? parsed.items.length : 0) - items.length
  };
  const cacheKey = 'market:' + firmCode + ':' + day;
  await env.G7_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 172800 });

  /* Append today's items to history, keep last 15. */
  const nextHist = history.concat(items.map(function(it){
    return { headline: it.headline, sourceUrl: it.sourceUrl, date: day };
  })).slice(-15);
  await env.G7_KV.put(histKey, JSON.stringify(nextHist));

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
  await env.G7_KV.put('unsub:firm:' + firmCode, t);
  await env.G7_KV.put('unsub:' + t, firmCode);
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

function pipelineDueFromStore(store, now, bizName) {
  if (!store || !Array.isArray(store.people)) return [];
  var out = [];
  store.people.forEach(function(p) {
    if (p.status === 'joined' || p.status === 'not_interested') return;
    var d = daysSince(p.lastStatusAt || p.lastContactedAt, now);
    var first = (p.name || '').split(' ')[0] || 'there';
    var item = null;

    if (p.status === 'contacted' && d >= 14) {
      item = { reason: 'No response in ' + d + ' days', urgency: 3,
               msg: 'Hi ' + first + ' \u2014 last try from my side. Agar kabhi zaroorat ho toh bata dena. Hum yahaan hain.' };
    } else if (p.status === 'contacted' && d >= 7) {
      item = { reason: 'No reply for ' + d + ' days \u2014 final follow-up', urgency: 2,
               msg: 'Hi ' + first + ' \u2014 ek baar aur pooch raha hoon. Aapke liye koi din suit karta hai baat karne ke liye?' };
    } else if (p.status === 'contacted' && d >= 3) {
      item = { reason: 'No reply for ' + d + ' days', urgency: 1,
               msg: 'Hi ' + first + ' \u2014 pichle message ka follow-up. Koi din suit karta hai baat karne ke liye?' };
    } else if (p.status === 'replied' && d >= 5) {
      item = { reason: 'Replied ' + d + ' days ago but has not booked', urgency: 3,
               msg: 'Hi ' + first + ' \u2014 aapne interest dikhaya tha. Is week ek slot rakh doon? Bas din bata dijiye.' };
    } else if (p.status === 'trial_booked' && d >= 1) {
      item = { reason: 'Trial was ' + d + ' day(s) ago \u2014 did they show?', urgency: 3,
               msg: 'Hi ' + first + ' \u2014 kaisa raha? Koi baat ho toh bata dena.' };
    } else if (p.status === 'gone_quiet' && d >= 14) {
      item = { reason: 'Quiet for ' + d + ' days', urgency: 1,
               msg: 'Hi ' + first + ' \u2014 kaafi time ho gaya. Jab ready ho, bata dena.' };
    } else if (p.status === 'found' && d >= 1) {
      item = { reason: 'Found ' + d + ' day(s) ago \u2014 never messaged', urgency: 2,
               msg: 'Hi ' + (p.name || 'there') + ' \u2014 ' + (bizName ? 'main ' + bizName + ' se hoon. ' : '') + 'Aapke liye ek baat thi, 2 min baat kar sakte hain?' };
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
  await env.G7_KV.put('scout:inbound:' + firmCode + ':snap:' + day, JSON.stringify(now), { expirationTtl: 4 * 86400 });
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
async function sendActionsEmail(env, firmCode, day) {
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
  var due = pipelineDueFromStore(pipeline, Date.now(), bizName);
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
      if (e.message) htmlParts.push(emailRow(emailQuote(e.message)));
      if (e.purpose) htmlParts.push(emailRow('<span style="font-size:12px;color:#888">' + escEmail(e.purpose) + '</span>'));
    });
    subjectParts.push(todayWa.length + ' WhatsApp send' + (todayWa.length === 1 ? '' : 's'));

    textParts.push('SEND ON WHATSAPP TODAY');
    todayWa.forEach(function(e) {
      textParts.push('  ' + (e.time || '') + ' · Send to ' + (e.listName || e.sendTo || '') +
        (e.message ? '\n  > ' + e.message : '') +
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
  if (subjectParts.length > 0) {
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
  if (ok) await env.G7_KV.put(sentKey, '1', { expirationTtl: 172800 });
  return ok ? 'sent' : 'send_failed';
}

/* News email: business brief + category sections. */
async function sendNewsEmail(env, firmCode, day, news) {
  const sentKey = 'market:emailed:' + firmCode + ':' + day;
  if (await env.G7_KV.get(sentKey)) return 'already_sent';
  const user = await env.G7_KV.get('auth:users:' + firmCode, 'json');
  if (!emailPrefs(user).news) return 'not_opted_in';
  if (!user || !user.recoveryEmail) return 'no_email';

  const bizItems = (news && news.business && Array.isArray(news.business.items)) ? news.business.items : [];
  const newsSections = (news && Array.isArray(news.sections)) ? news.sections : [];
  var totalItems = bizItems.length;
  newsSections.forEach(function(s) { totalItems += (s.items ? s.items.length : 0); });
  if (!totalItems) return 'nothing_to_send';

  const name = displayName(user, firmCode);
  const token = await unsubToken(env, firmCode);
  const unsubUrl = 'https://g7-proxy.gsevnservices.workers.dev/unsub?t=' + token + '&type=news';

  var htmlParts = [];
  var textParts = [];

  /* ── YOUR BUSINESS ── */
  if (bizItems.length > 0) {
    htmlParts.push(emailHeading('Your business'));
    bizItems.forEach(function(it) {
      var url = emailSafeUrl(it.sourceUrl || '');
      var h = '<div style="font-weight:600">' + escEmail(it.headline || '') + '</div>';
      if (it.whyItMatters) h += '<div style="font-size:13px;color:#555;margin-top:4px">' + escEmail(it.whyItMatters) + '</div>';
      h += '<div style="margin-top:4px"><span style="color:#B8862B;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-right:6px">Do this</span>' + escEmail(it.whatToDo || '') + '</div>';
      if (url) h += '<div style="margin-top:4px"><a href="' + escEmail(url) + '" style="font-size:12px;color:#888">' + escEmail(it.sourceTitle || 'Source') + '</a></div>';
      htmlParts.push(emailRow(h));
    });
    textParts.push('YOUR BUSINESS');
    bizItems.forEach(function(it) {
      textParts.push('  ' + (it.headline || '') +
        (it.whyItMatters ? '\n  ' + it.whyItMatters : '') +
        '\n  Do this: ' + (it.whatToDo || '') +
        (it.sourceUrl ? '\n  Source: ' + it.sourceUrl : ''));
    });
  }

  /* ── NEWS SECTIONS (one per category) ── */
  newsSections.forEach(function(sec) {
    var items = (sec.items && sec.items.length) ? sec.items : [];
    if (!items.length) return;
    htmlParts.push(emailHeading(sec.label || 'News'));
    items.forEach(function(it) {
      var url = emailSafeUrl(it.sourceUrl || '');
      var h = '<div style="font-weight:600">' + escEmail(it.headline || '') + '</div>';
      if (it.whatHappened) h += '<div style="font-size:13px;color:#888;margin-top:4px">' + escEmail(it.whatHappened) + '</div>';
      var why = (it.why || '').trim();
      if (why && why !== 'No direct effect on your business.') {
        h += '<div style="margin-top:4px"><span style="color:#B8862B;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-right:6px">For you</span>' + escEmail(why) + '</div>';
      }
      if (url) h += '<div style="margin-top:4px"><a href="' + escEmail(url) + '" style="font-size:12px;color:#888">' + escEmail(it.sourceTitle || 'Source') + '</a></div>';
      htmlParts.push(emailRow(h));
    });
    textParts.push(String(sec.label || 'NEWS').toUpperCase());
    items.forEach(function(it) {
      var why = (it.why || '').trim();
      textParts.push('  ' + (it.headline || '') +
        (it.whatHappened ? '\n  ' + it.whatHappened : '') +
        (why && why !== 'No direct effect on your business.' ? '\n  For you: ' + why : '') +
        (it.sourceUrl ? '\n  Source: ' + it.sourceUrl : ''));
    });
  });

  /* ── Subject ── */
  var firstHeadline = '';
  if (bizItems.length > 0) {
    firstHeadline = bizItems[0].headline || '';
  } else {
    for (var si = 0; si < newsSections.length; si++) {
      if (newsSections[si].items && newsSections[si].items.length) {
        firstHeadline = newsSections[si].items[0].headline || '';
        break;
      }
    }
  }
  var subjectTail = String(firstHeadline).slice(0, 60);
  if (subjectTail.length < firstHeadline.length) {
    var lastSpace = subjectTail.lastIndexOf(' ');
    if (lastSpace > 20) subjectTail = subjectTail.slice(0, lastSpace);
    subjectTail += '\u2026';
  }
  var subject = subjectTail ? 'Your news today \u00b7 ' + subjectTail : 'Your news today';

  var shell = emailShell({
    headerLabel: 'Scout \u00b7 Your news today',
    greeting: '<div style="font-size:20px;color:#111;margin-top:8px">Good morning, ' + escEmail(name) + '.</div>',
    textGreeting: 'Good morning, ' + name + '.\n\n',
    htmlParts: htmlParts,
    textParts: textParts,
    footerLine: 'You get this because you switched on Scout\u2019s news email.',
    unsubUrl: unsubUrl
  });

  var ok = await sendEmail(env, user.recoveryEmail, subject, shell.text, shell.html, {
    'List-Unsubscribe': '<' + unsubUrl + '>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  });
  if (ok) await env.G7_KV.put(sentKey, '1', { expirationTtl: 172800 });
  return ok ? 'sent' : 'send_failed';
}

/* The whole morning job for one firm: actions email, then news email. */
async function runMorningForFirm(env, firmCode, day) {
  const saved = await env.G7_KV.get('market:ctx:' + firmCode, 'json');
  if (!saved || !saved.context) return 'no_context';
  var a = 'error', n = 'error';
  try { a = await sendActionsEmail(env, firmCode, day); } catch (e) { console.log(JSON.stringify({ actionsEmailError: firmCode, error: String(e && e.message || e).slice(0, 300) })); }
  const user = await env.G7_KV.get('auth:users:' + firmCode, 'json') || {};
  const news = await buildDailyNews(env, firmCode, day, saved.context, saved.city || '', user.newsPrefs);
  try { n = await sendNewsEmail(env, firmCode, day, news); } catch (e) { console.log(JSON.stringify({ newsEmailError: firmCode, error: String(e && e.message || e).slice(0, 300) })); }
  return 'actions:' + a + ' news:' + n;
}

/* ═══════════════════════════════════════════
   LEAD FINDER — real businesses from the open web, not a maps API.
   One API call: web search finds candidate pages, web fetch reads them.
   Integrity gate: a phone number is kept only if its digits appear in
   text Scout actually read — a fetched page or a cited search passage.
   A business with no verifiable phone is kept with phone empty, never
   with a guessed one.
═══════════════════════════════════════════ */
async function findBusinesses(env, query, cap) {
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
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: system,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5,
          user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' } },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 4, max_content_tokens: 6000 }
      ],
      messages: [{ role: 'user', content: 'Find: ' + query }]
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('finder ' + r.status + ': ' + t.slice(0, 400));
  }
  const data = await r.json();

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
     verifiable. */
  try {
    const proposed = Array.isArray(parsed.businesses) ? parsed.businesses : [];
    console.log(JSON.stringify({
      finder: query,
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
async function generateSharedNews(env, cat, day, city) {
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
    '- Only from pages you actually found. Never invent a fact, figure or date.\n' +
    '- Copy every number exactly as the source states it.\n' +
    '- Nothing older than 48 hours.\n' +
    '- Return 2 to 4 items, most important first.\n' +
    '- sourceUrl must be the article that states the fact, never a home page.\n\n' +
    'Reply with ONLY this JSON:\n' +
    '{"items":[{"headline":"under 12 words","whatHappened":"one or two sentences, under 45 words",' +
    '"sourceTitle":"","sourceUrl":""}]}';

  /* Publishers that block AI crawlers make the whole request fail. Remember
     each rejected domain for 30 days and retry without it, so a publisher
     changing its policy never breaks a category. */
  const blockedRaw = await env.G7_KV.get('news:blocked-domains', 'json');
  const blocked = new Set(Array.isArray(blockedRaw) ? blockedRaw : []);

  async function ask(domains) {
    const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
    if (domains.length) tool.allowed_domains = domains;
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1500, system: system,
        tools: [tool],
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
    await env.G7_KV.put('news:blocked-domains', JSON.stringify(Array.from(blocked)), { expirationTtl: 30 * 86400 });
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

  /* Collect URLs web search returned. */
  const seen = new Set();
  (data.content || []).forEach(function(b) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      b.content.forEach(function(res) { if (res && res.url) seen.add(res.url); });
    }
  });

  /* Join text blocks, parse outermost JSON. */
  const text = (data.content || []).filter(function(b){ return b.type === 'text'; })
    .map(function(b){ return b.text; }).join('');
  let parsed = { items: [] };
  try {
    const a = text.indexOf('{'), z = text.lastIndexOf('}');
    if (a !== -1 && z > a) parsed = JSON.parse(text.slice(a, z + 1));
  } catch (e) {}

  /* Integrity gate — same rules as generateMarketBrief. */
  const kept = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter(function(it) {
      return it && it.headline && it.sourceUrl && seen.has(it.sourceUrl) && !isHomePage(it.sourceUrl);
    })
    .slice(0, 4)
    .map(function(it) {
      return {
        headline: String(it.headline).slice(0, 120),
        whatHappened: clip(it.whatHappened, 400),
        sourceTitle: String(it.sourceTitle || '').slice(0, 160),
        sourceUrl: it.sourceUrl
      };
    });

  const result = { category: cat, label: def.label, items: kept, date: day };
  await env.G7_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 172800 });
  return result;
}

/* Per firm, no search: one short line per item on what it means for THIS
   business. Cheap model — the facts are already verified. */
async function personaliseNews(env, firmCode, day, context, sections) {
  const key = 'news:why:' + firmCode + ':' + day;
  const cached = await env.G7_KV.get(key, 'json');
  if (cached) return cached;
  const flat = [];
  sections.forEach(function(s, si) {
    (s.items || []).forEach(function(it, ii) {
      flat.push({ id: si + '.' + ii, headline: it.headline, whatHappened: it.whatHappened });
    });
  });
  if (!flat.length) return {};
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1200,
      system: 'For each news item, write ONE sentence (under 25 words) on what it ' +
        'concretely means for the business described. If it genuinely does not affect ' +
        'this business, write exactly "No direct effect on your business." Never ' +
        'invent facts beyond the item. Never give investment advice. Reply with ONLY ' +
        'JSON: {"<id>":"sentence", ...}',
      messages: [{ role: 'user', content: 'BUSINESS:\n' + String(context).slice(0, 2500) +
        '\n\nITEMS:\n' + JSON.stringify(flat) }]
    })
  });
  let out = {};
  if (r.ok) {
    try {
      const d = await r.json();
      const t = (d.content || []).filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('');
      const a = t.indexOf('{'), z = t.lastIndexOf('}');
      if (a !== -1 && z > a) out = JSON.parse(t.slice(a, z + 1));
    } catch (e) {}
  }
  await env.G7_KV.put(key, JSON.stringify(out), { expirationTtl: 172800 });
  return out;
}

/* Everything a firm reads today: business brief + chosen categories,
   each item carrying a `why` line. Used by the dashboard route and email. */
async function buildDailyNews(env, firmCode, day, context, city, prefs) {
  let business = await env.G7_KV.get('market:' + firmCode + ':' + day, 'json');
  if (!business) business = await generateMarketBrief(env, firmCode, day, context, city, false);
  const chosen = (Array.isArray(prefs) ? prefs : []).filter(function(c){ return NEWS_CATS[c]; });
  const sections = [];
  const errors = [];
  for (const c of chosen) {
    try {
      const s = await generateSharedNews(env, c, day, city);
      if (s && s.items && s.items.length) {
        sections.push(s);
      } else {
        errors.push({ category: c, error: 'no items after gates' });
      }
    } catch (e) {
      var errMsg = String((e && e.message) || e).slice(0, 300);
      errors.push({ category: c, error: errMsg });
      console.log(JSON.stringify({ newsCategoryFailed: c, error: errMsg }));
    }
  }
  const why = await personaliseNews(env, firmCode, day, context, sections);
  sections.forEach(function(s, si) {
    s.items = s.items.map(function(it, ii) {
      return Object.assign({}, it, { why: why[si + '.' + ii] || '' });
    });
  });
  /* Relevance first. In policy and city news, an item with no effect on
     this business is noise — drop it. In markets and global news he chose
     to follow the market itself, so keep them, relevant items first. */
  const CAP = { india_markets: 2, india_policy: 3, global: 3, city: 3 };
  const NO_EFFECT = 'No direct effect on your business.';
  sections.forEach(function(s) {
    let items = s.items.slice();
    if (s.category === 'india_policy' || s.category === 'city') {
      items = items.filter(function(it){ return it.why && it.why.trim() !== NO_EFFECT; });
    }
    items.sort(function(a, b){
      return ((b.why && b.why.trim() !== NO_EFFECT) ? 1 : 0) - ((a.why && a.why.trim() !== NO_EFFECT) ? 1 : 0);
    });
    s.items = items.slice(0, CAP[s.category] || 3);
  });
  /* A category emptied by the relevance filter is not shown. */
  for (let i = sections.length - 1; i >= 0; i--) {
    if (!sections[i].items.length) sections.splice(i, 1);
  }
  return { business: business, sections: sections, errors: errors };
}

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
        env.G7_KV.put(usageKey, JSON.stringify({
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
          await env.G7_KV.put('auth:users:' + normalizedCode, JSON.stringify(
            Object.assign({}, user, { passwordHash: upgraded, hashUpgradedAt: Date.now() })
          ));
        } catch (e) { /* non-blocking — login proceeds either way */ }
      }

      // Generate a session token — two UUIDs joined for extra length
      const token = crypto.randomUUID() + '-' + crypto.randomUUID();

      // Store session in KV with 7-day TTL
      // expiresAt is checked on each request; Cloudflare also auto-deletes
      // the key after expirationTtl seconds as a backup cleanup mechanism
      await env.G7_KV.put(
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

      await env.G7_KV.put(key, JSON.stringify(updated));
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
      await env.G7_KV.put(rlKey, String(rlCount + 1), { expirationTtl: 3600 });

      const user = await env.G7_KV.get('auth:users:' + code, 'json');
      if (!user || !user.recoveryEmail) return generic;

      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Array.from(tokenBytes).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
      await env.G7_KV.put('auth:reset:' + token,
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

      await env.G7_KV.put(key, JSON.stringify(Object.assign({}, user, {
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
      await env.G7_KV.put(key, JSON.stringify(data));

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
      await env.G7_KV.put(
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
      await env.G7_KV.put(
        'firms:' + normalizedCode + ':deals',
        JSON.stringify([])
      );
      await env.G7_KV.put(
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
    // Returns a list of all firm accounts in KV.
    // Protected by ?adminPassword=xxx query parameter.
    // =========================================================================
    if (request.method === 'GET' && path === '/admin/list-firms') {

      const adminPassword = url.searchParams.get('adminPassword');

      // Validate admin password
      if (!adminPassword || adminPassword !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'Forbidden — invalid admin password' }, 403);
      }

      // List all keys with the 'auth:users:' prefix to find all firm accounts
      const list = await env.G7_KV.list({ prefix: 'auth:users:' });

      // Fetch each firm's data to return a useful summary
      const firms = await Promise.all(
        list.keys.map(async (key) => {
          const user = await env.G7_KV.get(key.name, 'json');
          // Extract firmCode from the key name by stripping 'auth:users:' prefix
          const firmCode = key.name.replace('auth:users:', '');
          return {
            firmCode,
            firmName: user ? user.firmName : 'Unknown',
            createdAt: user ? user.createdAt : null,
            tier: user ? user.tier : null
          };
        })
      );

      return jsonResponse({ firms });
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
      await env.G7_KV.put('auth:users:' + normalizedCode, JSON.stringify({
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
        const status = await runMorningForFirm(env, firmCode, day);
        return jsonResponse({ firmCode: firmCode, day: day, status: status });
      } catch (e) {
        return jsonResponse({ error: 'run_failed', detail: String(e.message || '').slice(0, 300) }, 500);
      }
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

      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model:    'claude-sonnet-4-6',
          max_tokens: Math.min(body.max_tokens || 24000, 32000),
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
      await env.G7_KV.put(analysisCounterKey, String(analysisCount + 1));

      return new Response(anthropicResponse.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        }
      });
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

      // Daily briefing cap — 50 per firm per UTC day
      const BRIEFING_DAILY_LIMIT = 50;
      const briefingKey = 'usage:briefing:' + session.firmCode + ':' + new Date().toISOString().slice(0, 10);
      const briefingUsage = await env.G7_KV.get(briefingKey, 'json') || { count: 0 };

      if (briefingUsage.count >= BRIEFING_DAILY_LIMIT) {
        return jsonResponse({ error: 'Daily briefing limit reached' }, 429);
      }

      // Increment BEFORE the Anthropic call — a failed call still consumed
      // the attempt, and this prevents a retry loop draining the key.
      await env.G7_KV.put(briefingKey, JSON.stringify({
        count:    briefingUsage.count + 1,
        lastUsed: Date.now(),
        firmCode: session.firmCode
      }), { expirationTtl: 172800 });

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 400,
          stream:     false,
          messages:   body.messages || []
        })
      });

      if (!anthropicResponse.ok) {
        const errText = await anthropicResponse.text();
        return jsonResponse({ error: 'Anthropic error', detail: errText }, anthropicResponse.status);
      }

      const result = await anthropicResponse.json();
      const text = (result.content && result.content[0] && result.content[0].text) || '';

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
        await env.G7_KV.put('market:ctx:' + session.firmCode,
          JSON.stringify({ context: context, city: city }),
          { expirationTtl: 7 * 86400 });
      }

      /* IST date — the brief belongs to the owner's day, not UTC's. */
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const day = ist.toISOString().slice(0, 10);
      const cacheKey = 'market:' + session.firmCode + ':' + day;

      const cached = await env.G7_KV.get(cacheKey, 'json');
      if (cached) return jsonResponse(cached);

      if (!context) return jsonResponse({ items: [], date: day });

      /* Concurrency lock — prevents duplicate generation if two tabs load
         at the same time. Auto-expires after 120 s as a safety net. */
      const lockKey = 'market:lock:' + session.firmCode + ':' + day;
      if (await env.G7_KV.get(lockKey)) return jsonResponse({ items: [], date: day, pending: true });
      await env.G7_KV.put(lockKey, '1', { expirationTtl: 120 });

      /* Three generation attempts per firm per day. A failure writes no
         cache, so without this a broken call would retry on every load. */
      const attemptKey = 'market:attempts:' + session.firmCode + ':' + day;
      const attempts = parseInt((await env.G7_KV.get(attemptKey)) || '0', 10);
      if (attempts >= 3) {
        await env.G7_KV.delete(lockKey);
        return jsonResponse({ items: [], date: day, limited: true });
      }
      await env.G7_KV.put(attemptKey, String(attempts + 1), { expirationTtl: 172800 });

      try {
        const result = await generateMarketBrief(env, session.firmCode, day, context, city);
        await env.G7_KV.delete(lockKey);
        return jsonResponse(result);
      } catch (e) {
        await env.G7_KV.delete(lockKey);
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

      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model:    'claude-sonnet-4-6',
          max_tokens: 3000,
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
      await env.G7_KV.put(checkinCounterKey, String(checkinCount + 1));

      return new Response(anthropicResponse.body, {
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
        await env.G7_KV.put('scout:usage:total', String(total));

        // Increment per-day counter
        const dateKey  = 'scout:usage:date:' + today;
        const dateRaw  = await env.G7_KV.get(dateKey);
        const dateCount = dateRaw ? parseInt(dateRaw) + 1 : 1;
        await env.G7_KV.put(dateKey, String(dateCount));

        // Increment per-business-type counter (normalised key)
        if (businessType) {
          const btKey  = 'scout:usage:bt:' + businessType.replace(/\s+/g, '_').toLowerCase();
          const btRaw  = await env.G7_KV.get(btKey);
          const btCount = btRaw ? parseInt(btRaw) + 1 : 1;
          await env.G7_KV.put(btKey, String(btCount));
        }

        // Increment per-city counter (normalised key)
        if (city) {
          const cityKey  = 'scout:usage:city:' + city.replace(/\s+/g, '_').toLowerCase();
          const cityRaw  = await env.G7_KV.get(cityKey);
          const cityCount = cityRaw ? parseInt(cityRaw) + 1 : 1;
          await env.G7_KV.put(cityKey, String(cityCount));
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
        await env.G7_KV.put('scout:usage:log', JSON.stringify(log));

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

      await env.G7_KV.put('scout:usage:total', '0');
      await env.G7_KV.put('scout:usage:log',   '[]');

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
      await env.G7_KV.put(key, JSON.stringify(record));

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
      const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

      // Determine limit and result cap based on plan
      const isPaid   = plan === 'paid';
      const cap      = isPaid ? 50 : 2;
      const hardLimit = isPaid ? 6 : 5;

      // Counter key follows the exact same pattern as /scout/analyse
      const placesCounterKey = isPaid
        ? 'scout:limit:' + session.firmCode + ':places:' + monthKey
        : 'scout:limit:' + session.firmCode + ':places';

      // 4. Rate limit check (before cache — so limit applies even on cache hits
      //    only on live calls; cache hits skip this block below)
      const cntRaw = await env.G7_KV.get(placesCounterKey);
      const placesCount = cntRaw ? parseInt(cntRaw, 10) : 0;

      // 5. Cache lookup — normalise query to lowercase for stable cache key
      const normalised = q.toLowerCase();
      // SHA-256 hash of the normalised query, hex-encoded, for the cache key
      const encoder = new TextEncoder();
      const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(normalised));
      const hashHex = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const cacheKey = 'places:cache:' + hashHex;

      const cached = await env.G7_KV.get(cacheKey, 'json');
      if (cached) {
        // Cache hit — return stored results, no counter increment, no Google call
        return jsonResponse({
          cacheHit: true,
          results:  cached.slice(0, cap),
          quota:    { used: placesCount, limit: hardLimit }
        });
      }

      // Cache miss — enforce rate limit before calling Google
      if (placesCount >= hardLimit) {
        return jsonResponse({ error: 'limit_reached', limit: 'places' }, 403);
      }

      // 6. Call Claude web search to find businesses (replaces Google Places)
      let places;
      try {
        places = await findBusinesses(env, q, cap);
      } catch (e) {
        return jsonResponse({ error: 'Business search failed' }, 502);
      }

      // 8. Store in cache — 30-day TTL (2592000 seconds)
      // Fire-and-forget; does not block the response
      env.G7_KV.put(cacheKey, JSON.stringify(places), { expirationTtl: 2592000 });

      // 9. Increment counter only on a successful non-cached call
      await env.G7_KV.put(placesCounterKey, String(placesCount + 1));

      return jsonResponse({
        cacheHit: false,
        results:  places.slice(0, cap),
        quota:    { used: placesCount + 1, limit: hardLimit }
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
      await env.G7_KV.put(key, JSON.stringify(user));
      const ep = emailPrefs(user);
      return jsonResponse({ actions: ep.actions, news: ep.news, on: ep.actions || ep.news, hasEmail: true });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /scout/news-prefs — current news category selections.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/scout/news-prefs') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      return jsonResponse({
        prefs: user.newsPrefs || [],
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
      await env.G7_KV.put(key, JSON.stringify(user));
      return jsonResponse({ prefs: user.newsPrefs });
    }

    // ─────────────────────────────────────────────────────────────
    // GET /scout/news — full daily news for the dashboard.
    // ─────────────────────────────────────────────────────────────
    if (request.method === 'GET' && path === '/scout/news') {
      const session = await validateSession(request, env);
      if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
      const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
      const today = ist.toISOString().slice(0, 10);
      const saved = await env.G7_KV.get('market:ctx:' + session.firmCode, 'json');
      if (!saved || !saved.context) return jsonResponse({ business: { items: [] }, sections: [] });
      const user = await env.G7_KV.get('auth:users:' + session.firmCode, 'json') || {};
      const news = await buildDailyNews(env, session.firmCode, today, saved.context, saved.city || '', user.newsPrefs);
      return jsonResponse(news);
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
          await env.G7_KV.put(key, JSON.stringify(user));
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
            return env.G7_KV.put(
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
            env.G7_KV.put(
              'scout:inbound:link:' + codes[source],
              JSON.stringify({ firmCode, source, waNumber, message, createdAt: now })
            )
          ),
          env.G7_KV.put(linksKey, JSON.stringify(codes))
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
      ctx.waitUntil(env.G7_KV.put(clickKey, String(clicks + 1)));

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
    report.state = 'running';
    await env.G7_KV.put('cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
    let cursor;
    do {
      const page = await env.G7_KV.list({ prefix: 'market:ctx:', cursor: cursor });
      for (const k of page.keys) {
        const firmCode = k.name.slice('market:ctx:'.length);
        report.current = firmCode;
        await env.G7_KV.put('cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
        const t0 = Date.now();
        try {
          const status = await runMorningForFirm(env, firmCode, day);
          report.firms.push({ firm: firmCode, status: status, ms: Date.now() - t0 });
          await env.G7_KV.put('cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
        } catch (e) {
          report.firms.push({ firm: firmCode, status: 'error',
            error: String((e && e.message) || e).slice(0, 300), ms: Date.now() - t0 });
          await env.G7_KV.put('cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    report.state = 'done';
    delete report.current;
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify({ cron: report }));
    await env.G7_KV.put('cron:last', JSON.stringify(report), { expirationTtl: 7 * 86400 });
  }
};
