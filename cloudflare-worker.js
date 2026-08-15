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
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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

      // Hash the submitted password and compare to stored hash
      const submittedHash = await hashPassword(password);
      if (submittedHash !== user.passwordHash) {
        return jsonResponse({ error: 'Invalid credentials' }, 401);
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
        firmName: user.firmName
      });
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
        passwordResetAt: Date.now()
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

      // 6. Call Google Places API (New) — Text Search POST
      // Field mask requests ONLY the four Basic SKU fields:
      //   places.displayName, places.formattedAddress,
      //   places.nationalPhoneNumber, places.websiteUri
      // This keeps every call at the Text Search (Basic) SKU ($0.017/req).
      // Adding any field from Atmosphere or Preferred tiers doubles or triples cost.
      const PLACES_FIELD_MASK =
        'places.displayName,places.formattedAddress,' +
        'places.nationalPhoneNumber,places.websiteUri';

      let placesRaw;
      try {
        const placesResp = await fetch(
          'https://places.googleapis.com/v1/places:searchText',
          {
            method:  'POST',
            headers: {
              'Content-Type':     'application/json',
              'X-Goog-Api-Key':   env.GOOGLE_PLACES_KEY,
              'X-Goog-FieldMask': PLACES_FIELD_MASK
            },
            body: JSON.stringify({
              textQuery:   q,
              maxResultCount: Math.min(cap, 20) // API hard max is 20 per call
            })
          }
        );
        if (!placesResp.ok) {
          const errText = await placesResp.text();
          return jsonResponse(
            { error: 'Google Places error', detail: errText },
            placesResp.status
          );
        }
        placesRaw = await placesResp.json();
      } catch (e) {
        return jsonResponse({ error: 'Failed to reach Google Places API' }, 502);
      }

      // 7. Normalise results — strip everything Google returned except our four fields
      const places = (placesRaw.places || []).map(p => ({
        name:    (p.displayName    && p.displayName.text) ? p.displayName.text : '',
        address: p.formattedAddress            || '',
        phone:   p.nationalPhoneNumber         || '',
        website: p.websiteUri                  || ''
      }));

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
  }
};
