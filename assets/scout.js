'use strict';

// ─────────────────────────────────────────────────────────────
// assets/scout.js
// Scout API engine — G7 Capital
//
// This file powers all API calls for Scout, G7's business
// development AI employee for Indian SMEs.
//
// It is completely separate from workspace.js and Alex.
// Do not import or reference anything from workspace.js here.
//
// Functions:
//   callScout(businessContext)           — initial analysis call
//   callScoutCheckin(checkinData)        — weekly check-in call
//   saveScoutResult(rawOutput, weekNum)  — persist result to localStorage
//   getScoutHistory()                    — safe parse of history array
//   getScoutContext()                    — read onboarding context from pending result
//   extractScoutMetrics(text)            — pull 4 key metrics from Scout output
// ─────────────────────────────────────────────────────────────

// Cloudflare Worker base URL — Scout routes live here
const SCOUT_WORKER = 'https://g7-proxy.gsevnservices.workers.dev';


// ============================================================
// SERVER STATE SYNC — mirrors Scout's localStorage state to KV
// so a customer's data survives across devices / browser clears.
// One JSON blob saved under firms:{CODE}:scout_state via /data/save.
// ============================================================

// The complete set of Scout state keys to sync (session keys excluded —
// those are set by login, not part of Scout's per-account data).
var SCOUT_STATE_KEYS = [
  'scout_pending_result',
  'scout_history',
  'scout_week_number',
  'scout_streak',
  'scout_last_checkin_week',
  'scout_health_score',
  'scout_health_breakdown',
  'scout_weekly_insight',
  'scout_insight_week',
  'scout_last_targets',
  'scout_icp_names',
  'scout_first_customer_celebrated',
  'scout_week_checklist',
  'scout_referral_chain',
  'scout_pipeline',
  'scout_onboard_draft',
  'scout_daily_snapshot',
  'scout_pinned'
];

/* ═══════════════════════════════════════════
   SESSION EXPIRY PROTECTION
   A token can exist locally after it has expired server-side. Every save
   then fails with 401. Without protection, work done in that window is
   erased the next time a valid session loads the server copy over it.
   scout_unsynced marks a device that holds work the server has not seen.
   It is deliberately NOT in SCOUT_STATE_KEYS — it describes this device,
   and must never be synced or overwritten by a server load.
═══════════════════════════════════════════ */
var SCOUT_UNSYNCED_KEY = 'scout_unsynced';
var _scoutExpiring = false;
var _scoutLastSaveStatus = 0;

function scoutMarkUnsynced() {
  try { localStorage.setItem(scoutKey(SCOUT_UNSYNCED_KEY), '1'); } catch (e) {}
}
function scoutClearUnsynced() {
  try { localStorage.removeItem(scoutKey(SCOUT_UNSYNCED_KEY)); } catch (e) {}
}
function scoutIsUnsynced() {
  try { return localStorage.getItem(scoutKey(SCOUT_UNSYNCED_KEY)) === '1'; } catch (e) { return false; }
}

/* Session is dead server-side. Remove ONLY the token — never Scout data,
   never call handleLogout(). Local work must survive to be pushed after
   the user signs back in. */
function scoutSessionExpired() {
  if (_scoutExpiring) return;
  _scoutExpiring = true;
  scoutMarkUnsynced();
  try { localStorage.removeItem('g7_session_token'); } catch (e) {}
  window.location.href = '../login.html?product=scout&expired=1';
}

/* Single source of truth for sign-out cleanup. Iterates SCOUT_STATE_KEYS so
   it can never fall out of date again, and clears the unsynced flag so a
   later login cannot push an empty or partial blob over the server copy. */
function scoutClearLocalState() {
  for (var i = 0; i < SCOUT_STATE_KEYS.length; i++) {
    try { localStorage.removeItem(scoutKey(SCOUT_STATE_KEYS[i])); } catch (e) {}
  }
  scoutClearUnsynced();
}

/* DEPRECATED — intentionally disabled.
   This function previously copied raw unscoped keys into the current firm's
   scoped keys on every page load. That caused a cross-firm data leak:
   any new firm on a shared browser inherited the previous firm's full
   Scout analysis, history, and ICP data.

   Recovery for users who ran before scoping was added is now handled by:
     • repairOrphanedScoutResult() — targeted, gated, safe (scout.js)
     • loadScoutStateFromServer()  — authoritative server restore (scout.js)
     • raw key purge on login      — removes leftover raw keys so no future
                                      firm can inherit them (login.html)

   The function is kept as a no-op because all Scout pages still call it.
   Removing the calls from every page would risk a missed site. */
function migrateUnscopedScoutKeys() {
  /* no-op — migration disabled to prevent cross-firm data leaks */
  return false;
}

// Bundle all Scout state keys from localStorage into one object and
// POST to the server. Fire-and-forget: logs on failure, never throws.
async function saveScoutStateToServer() {
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return false;
    var blob = {};
    for (var i = 0; i < SCOUT_STATE_KEYS.length; i++) {
      var base = SCOUT_STATE_KEYS[i];
      var v = localStorage.getItem(scoutKey(base));
      if (v !== null) blob[base] = v;
    }
    if (Object.keys(blob).length === 0) return false;
    var res = await fetch(SCOUT_WORKER + '/data/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ type: 'scout_state', data: blob })
    });
    _scoutLastSaveStatus = res.status;
    if (res.status === 401) { scoutMarkUnsynced(); return false; }
    if (res.ok) { scoutClearUnsynced(); return true; }
    return false;
  } catch (e) {
    console.warn('Scout state save failed (non-blocking):', e);
    _scoutLastSaveStatus = 0;
    return false;
  }
}

// Load Scout state blob from the server and write each key into
// localStorage, seeding this device. Returns true if data was loaded,
// false if none / on error. Never throws.
// IMPORTANT: local state is only cleared AFTER we have confirmed real
// server data — a failed fetch must never destroy what is on this device.
async function loadScoutStateFromServer() {
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return false;

    /* Push before pull. If this device holds unsynced work, send it to the
       server before loading, so the server copy does not erase it. Only
       push a blob that contains the core analysis — never a fragment. */
    if (scoutIsUnsynced()) {
      if (localStorage.getItem(scoutKey('scout_pending_result')) !== null) {
        var pushed = await saveScoutStateToServer();
        if (!pushed) {
          /* 401 — session is dead; expire and send to login. Local work is
             preserved and the unsynced flag stays set for the next login.
             Anything else (network, 5xx) — keep local and stop. Do NOT fall
             through to the load: a successful load would overwrite work the
             server has not yet seen. */
          if (_scoutLastSaveStatus === 401) scoutSessionExpired();
          return false;
        }
      } else {
        scoutClearUnsynced();
      }
    }

    var res = await fetch(SCOUT_WORKER + '/data/load?type=scout_state', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.status === 401) { scoutSessionExpired(); return false; }
    if (!res.ok) return false;
    var json = await res.json();
    var blob = json && json.data ? json.data : null;
    if (!blob) return false;

    /* Only replace local state once we have real server data.
       A failed fetch must never destroy what is on this device. */
    for (var c = 0; c < SCOUT_STATE_KEYS.length; c++) {
      localStorage.removeItem(scoutKey(SCOUT_STATE_KEYS[c]));
    }
    for (var key in blob) {
      if (blob.hasOwnProperty(key) && blob[key] !== null && blob[key] !== undefined) {
        localStorage.setItem(scoutKey(key), blob[key]);
      }
    }
    return true;
  } catch (e) {
    console.warn('Scout state load failed (non-blocking):', e);
    return false;
  }
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 1 — callScout(businessContext)
//
// Sends the initial business onboarding data to Scout for analysis.
// Calls the /scout/analyse endpoint.
//
// businessContext — object built from onboard.html form fields:
//   businessName, city, state, businessType, productService,
//   avgTicket, monthlyRevenue, teamSize, yearsActive, topChallenge,
//   targetCustomer, currentChannels, weeklyContacts, conversionRate,
//   competitors, uniqueAdvantage, languages, seasonalNotes, situation
//
// Returns: Scout's raw text output (string)
// Throws:  Error with user-readable message
// ─────────────────────────────────────────────────────────────
async function callScout(businessContext) {

  // Validate session token is present
  var sessionToken = localStorage.getItem('g7_session_token') || '';

  // Build the system prompt: Scout master prompt + no firm KB needed
  // (Scout has its own full system prompt in SCOUT_SYSTEM_PROMPT)
  var systemPrompt = SCOUT_SYSTEM_PROMPT;

  // Build the user message from the business context object
  var userMessage = buildScoutOnboardMessage(businessContext);

  var response;
  try {
    response = await fetch(SCOUT_WORKER + '/scout/analyse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sessionToken
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 12000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          {
            role: 'user',
            content: userMessage
          }
        ]
      })
    });
  } catch (networkError) {
    throw new Error('Could not reach Scout. Please check your internet connection and try again.');
  }

  if (!response.ok) {
    var errBody = await response.text();
    if (response.status === 403) {
      var parsed = null;
      try { parsed = JSON.parse(errBody); } catch (e) {}
      if (parsed && parsed.error === 'limit_reached') {
        var limitErr = new Error('limit_reached');
        limitErr.code = 'limit_reached';
        limitErr.limit = parsed.limit || 'analysis';
        throw limitErr;
      }
    }
    throw new Error('Scout API error ' + response.status + ': ' + errBody);
  }

  // Worker returns text/event-stream (streaming SSE) — read via readSSEStream()
  var streamResult = await readSSEStream(response);
  if (!streamResult.text) {
    throw new Error('Scout returned an empty response. Please try again.');
  }
  return { text: streamResult.text, complete: streamResult.complete };
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 1B — callScoutRaw(userMessage)
//
// Sends a raw string message to the /scout/analyse endpoint.
// Used by the Referral Chain Builder in result.html, which
// builds its own prompt rather than using the onboarding form.
//
// userMessage — a pre-formatted string (user message content)
// Returns: Scout's raw text output (string)
// Throws:  Error with user-readable message
// ─────────────────────────────────────────────────────────────
async function callScoutRaw(userMessage) {

  var sessionToken = localStorage.getItem('g7_session_token') || '';
  var systemPrompt = SCOUT_SYSTEM_PROMPT;

  var response;
  try {
    response = await fetch(SCOUT_WORKER + '/scout/analyse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sessionToken
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [
          { role: 'user', content: userMessage }
        ]
      })
    });
  } catch (networkError) {
    throw new Error('Could not reach Scout. Please check your internet connection and try again.');
  }

  if (!response.ok) {
    var errBody = await response.text();
    throw new Error('Scout API error ' + response.status + ': ' + errBody);
  }

  var streamResult = await readSSEStream(response);
  if (!streamResult.text) {
    throw new Error('Scout returned an empty response. Please try again.');
  }
  return { text: streamResult.text, complete: streamResult.complete };
}


// ─────────────────────────────────────────────────────────────
// HELPER — buildScoutOnboardMessage(ctx)
//
// Formats the business context object into a structured prompt
// that matches Scout's Component 7 output format specification.
//
// ctx — the businessContext object from onboard.html
// Returns: formatted string (user message content)
// ─────────────────────────────────────────────────────────────
function buildScoutOnboardMessage(ctx) {
  return [
    'Please analyse this business and produce a complete Scout Analysis',
    'in your standard 4-tab format.',
    '',
    '══════════════════════════════════════════════════',
    'BUSINESS PROFILE',
    '══════════════════════════════════════════════════',
    '',
    'BUSINESS NAME:     ' + (ctx.businessName || 'Not provided'),
    'LOCATION:          ' + (ctx.city || '') + (ctx.state ? ', ' + ctx.state : ''),
    'BUSINESS TYPE:     ' + (ctx.businessType || 'Not provided'),
    'PRODUCT / SERVICE: ' + (ctx.productService || 'Not provided'),
    'AVERAGE TICKET:    ₹' + (ctx.avgTicket || 'Not provided'),
    'MONTHLY REVENUE:   ₹' + (ctx.monthlyRevenue || 'Not provided'),
    'TEAM SIZE:         ' + (ctx.teamSize || 'Not provided') + ' people',
    'YEARS ACTIVE:      ' + (ctx.yearsActive || 'Not provided'),
    'TOP CHALLENGE:     ' + (ctx.topChallenge || 'Not provided'),
    '',
    '── TARGET CUSTOMER ────────────────────────────',
    (ctx.targetCustomer || 'Not provided'),
    '',
    '── CURRENT SALES CHANNELS ─────────────────────',
    (ctx.currentChannels || 'Not provided'),
    '',
    '── WEEKLY SALES ACTIVITY ──────────────────────',
    'Contacts made per week: ' + (ctx.weeklyContacts || 'Not provided'),
    'Current conversion rate: ' + (ctx.conversionRate || 'Not provided'),
    '',
    '── COMPETITION ────────────────────────────────',
    (ctx.competitors || 'Not provided'),
    '',
    '── UNIQUE ADVANTAGE ───────────────────────────',
    (ctx.uniqueAdvantage || 'Not provided'),
    '',
    '── LANGUAGE & COMMUNICATION ───────────────────',
    'Languages used in sales: ' + (ctx.languages || 'Not provided'),
    '',
    '── SEASONAL PATTERNS ──────────────────────────',
    (ctx.seasonalNotes || 'None noted'),
    '',
    '── CURRENT SITUATION ──────────────────────────',
    (ctx.situation || 'Not provided'),
    '',
    '══════════════════════════════════════════════════',
    'ANALYSIS DATE: ' + new Date().toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric'
    }),
    '══════════════════════════════════════════════════',
    '',
    'REQUIRED OUTPUT:',
    'Produce all 4 tabs in sequence:',
    'TAB 1: WHO TO CALL — ICP profiles with contact lists',
    'TAB 2: WHAT TO SAY — Scripts and messaging for each ICP',
    'TAB 3: WHEN TO ACT — Weekly rhythm with day-by-day plan',
    'TAB 4: PIPELINE — Tracking targets and first 30-day milestones'
  ].join('\n');
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 2 — callScoutCheckin(checkinData)
//
// Sends weekly check-in results to Scout for updated guidance.
// Calls the /scout/checkin endpoint.
// Uses a multi-turn conversation: onboarding context → prior output → new data.
//
// checkinData — object with:
//   weekNumber     — current week number (integer)
//   onboardContext — original onboarding user message (string)
//   priorOutput    — Scout's output from previous week (string)
//   contacts       — object: { icp1: n, icp2: n, icp3: n }
//   responses      — object: { icp1: n, icp2: n, icp3: n }
//   customers      — object: { icp1: n, icp2: n, icp3: n }
//   revenue        — total new revenue this week (string, e.g. '45000')
//   wins           — what worked (string)
//   blocks         — what did not work (string)
//   nextFocus      — what the owner wants to focus on next week (string)
//
// Returns: Scout's raw text output (string)
// Throws:  Error with user-readable message
// ─────────────────────────────────────────────────────────────
async function callScoutCheckin(checkinData, onProgress) {

  var sessionToken = localStorage.getItem('g7_session_token') || '';
  var systemPrompt = SCOUT_SYSTEM_PROMPT;

  // Build multi-turn message array
  // Turn 1: original onboarding context (as user) — so Scout remembers the business
  // Turn 2: Scout's prior output (as assistant) — prior week's recommendations
  // Turn 3: this week's actual results + request for updated plan (as user)
  var messages = [];

  if (checkinData.onboardContext) {
    messages.push({
      role: 'user',
      content: checkinData.onboardContext
    });
  }

  if (checkinData.priorOutput) {
    messages.push({
      role: 'assistant',
      content: checkinData.priorOutput
    });
  }

  // Build the check-in user message
  var checkinMessage = buildCheckinMessage(checkinData);
  messages.push({
    role: 'user',
    content: checkinMessage
  });

  var response;
  try {
    response = await fetch(SCOUT_WORKER + '/scout/checkin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sessionToken
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: messages
      })
    });
  } catch (networkError) {
    throw new Error('Could not reach Scout. Please check your internet connection and try again.');
  }

  if (!response.ok) {
    var errBody = await response.text();
    if (response.status === 403) {
      var parsed = null;
      try { parsed = JSON.parse(errBody); } catch (e) {}
      if (parsed && parsed.error === 'upgrade_required') {
        var upgradeErr = new Error('upgrade_required');
        upgradeErr.code = 'upgrade_required';
        upgradeErr.limit = parsed.limit || 'checkin';
        throw upgradeErr;
      }
      if (parsed && parsed.error === 'limit_reached') {
        var limitErr = new Error('limit_reached');
        limitErr.code = 'limit_reached';
        limitErr.limit = parsed.limit || 'checkin';
        throw limitErr;
      }
    }
    throw new Error('Scout check-in error ' + response.status + ': ' + errBody);
  }

  // Worker returns text/event-stream (streaming SSE) — read via readSSEStream()
  var streamResult = await readSSEStream(response, onProgress);
  if (!streamResult.text) {
    throw new Error('Scout returned an empty response. Please try again.');
  }
  return { text: streamResult.text, complete: streamResult.complete };
}


// ─────────────────────────────────────────────────────────────
// HELPER — readSSEStream(response, onProgress)
//
// Reads an Anthropic SSE streaming response body and assembles
// the full text output. Called by callScout() and callScoutCheckin().
//
// The Anthropic SSE format looks like:
//   data: {"type":"message_start",...}
//   data: {"type":"content_block_start",...}
//   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
//   data: {"type":"message_stop"}
//
// response — the fetch() Response object (must be ok before calling)
// Returns:  { text: string, complete: boolean }
//             text     — the assembled output (may be partial if complete is false)
//             complete — true only if message_stop or [DONE] was received,
//                        meaning the model finished normally.
//                        false means the connection was cut before the model finished.
// Throws:   Error if the stream cannot be read
// ─────────────────────────────────────────────────────────────
async function readSSEStream(response, onProgress) {
  var reader  = response.body.getReader();
  var decoder = new TextDecoder('utf-8');
  var fullText = '';
  var buffer = '';
  var done = false;
  var receivedStopSignal = false; // set true only on message_stop or [DONE]

  while (!done) {
    var chunk = await reader.read();
    done = chunk.done;

    if (chunk.value) {
      // Append decoded bytes to the buffer (do NOT split per-chunk)
      buffer += decoder.decode(chunk.value, { stream: true });

      // Process only COMPLETE lines; keep the trailing partial line in the buffer
      var newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        var line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith('data: ')) continue;

        var jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') { receivedStopSignal = true; done = true; break; }

        var event;
        try {
          event = JSON.parse(jsonStr);
        } catch (e) {
          // A genuinely malformed complete line — skip
          continue;
        }

        if (
          event.type === 'content_block_delta' &&
          event.delta &&
          event.delta.type === 'text_delta' &&
          event.delta.text
        ) {
          fullText += event.delta.text;
          if (onProgress) onProgress(fullText.length);
        }

        if (event.type === 'message_stop') {
          receivedStopSignal = true;
          done = true;
          break;
        }
      }
    }
  }

  // Flush any final complete data line left in the buffer (no trailing newline)
  var tail = buffer.trim();
  if (tail.startsWith('data: ')) {
    var tailJson = tail.slice(6);
    try {
      var tailEvent = JSON.parse(tailJson);
      if (
        tailEvent.type === 'content_block_delta' &&
        tailEvent.delta &&
        tailEvent.delta.type === 'text_delta' &&
        tailEvent.delta.text
      ) {
        fullText += tailEvent.delta.text;
        if (onProgress) onProgress(fullText.length);
      }
      if (tailEvent.type === 'message_stop') { receivedStopSignal = true; }
    } catch (e) { /* ignore incomplete tail */ }
  }

  return { text: fullText, complete: receivedStopSignal };
}


// ─────────────────────────────────────────────────────────────
// HELPER — buildCheckinMessage(d)
//
// Formats the weekly check-in data into a structured prompt.
// d — checkinData object from callScoutCheckin
// Returns: formatted string (user message content)
// ─────────────────────────────────────────────────────────────
function buildCheckinMessage(d) {

  // Sum contacts, responses, customers across all 3 ICPs
  var totalContacts  = (parseInt(d.contacts.icp1)  || 0) + (parseInt(d.contacts.icp2)  || 0) + (parseInt(d.contacts.icp3)  || 0);
  var totalResponses = (parseInt(d.responses.icp1) || 0) + (parseInt(d.responses.icp2) || 0) + (parseInt(d.responses.icp3) || 0);
  var totalCustomers = (parseInt(d.customers.icp1) || 0) + (parseInt(d.customers.icp2) || 0) + (parseInt(d.customers.icp3) || 0);

  return [
    'WEEK ' + d.weekNumber + ' CHECK-IN REPORT',
    '══════════════════════════════════════════════════',
    '',
    '── ACTIVITY THIS WEEK ─────────────────────────',
    'Total contacts made: ' + totalContacts,
    '  ICP 1: ' + (d.contacts.icp1 || 0) + ' contacts',
    '  ICP 2: ' + (d.contacts.icp2 || 0) + ' contacts',
    '  ICP 3: ' + (d.contacts.icp3 || 0) + ' contacts',
    '',
    'Total responses: ' + totalResponses,
    '  ICP 1: ' + (d.responses.icp1 || 0) + ' responses',
    '  ICP 2: ' + (d.responses.icp2 || 0) + ' responses',
    '  ICP 3: ' + (d.responses.icp3 || 0) + ' responses',
    '',
    'New customers this week: ' + totalCustomers,
    '  ICP 1: ' + (d.customers.icp1 || 0) + ' new customers',
    '  ICP 2: ' + (d.customers.icp2 || 0) + ' new customers',
    '  ICP 3: ' + (d.customers.icp3 || 0) + ' new customers',
    '',
    'Revenue from new customers: ₹' + (d.revenue || '0'),
    '',
    '── WHAT WORKED ────────────────────────────────',
    (d.wins || 'Nothing noted as working particularly well.'),
    '',
    '── WHAT DID NOT WORK ──────────────────────────',
    (d.blocks || 'No specific blockers noted.'),
    '',
    '── OWNER FOCUS FOR NEXT WEEK ──────────────────',
    (d.nextFocus || 'Continue current approach.'),
    '',
    '══════════════════════════════════════════════════',
    'Based on this week\'s results, please provide:',
    '1. A brief performance assessment (what the numbers mean)',
    '2. An updated 4-tab Scout Analysis for the coming week',
    '   — adjust targets, messages, and timing based on what worked',
    'Use the same TAB 1 / TAB 2 / TAB 3 / TAB 4 format as before.'
  ].join('\n');
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 3 — saveScoutResult(rawOutput, weekNumber)
//
// Persists a Scout result to localStorage.
// Called after every successful callScout() or callScoutCheckin().
//
// rawOutput   — Scout's raw text response (string)
// weekNumber  — the week this result belongs to (integer)
//
// Updates these localStorage keys:
//   scout_pending_result  — the most recent result for result.html to display
//   scout_history         — append to history array (max 12 entries)
//   scout_week_number     — advance the week counter
// ─────────────────────────────────────────────────────────────
function saveScoutResult(rawOutput, weekNumber) {

  var metrics = extractScoutMetrics(rawOutput);
  var _economics = null;

  // Override metrics with JSON headline values if Scout output is valid JSON
  // (new architecture: TYPE 1 onboarding outputs pure JSON)
  try {
    var _cleaned = rawOutput
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '').trim();
    var _parsed = JSON.parse(_cleaned);
    if (_parsed && _parsed.headline) {
      var _hl = _parsed.headline;
      if (_hl.revenueVelocity)      metrics.revenueVelocity = _hl.revenueVelocity;
      if (_hl.acquisitionEfficiency) metrics.acquisitionEff  = _hl.acquisitionEfficiency;
      if (typeof _hl.momentumScore === 'number') metrics.momentumScore = _hl.momentumScore;
      if (_hl.momentumNote)          metrics.momentumNote    = _hl.momentumNote;
    }
    if (_parsed && _parsed.economics) _economics = _parsed.economics;
  } catch(e) { /* not JSON — keep regex-extracted metrics */ }

  // Build the result object
  var resultObj = {
    type:            'onboarding',
    weekNumber:      weekNumber,
    timestamp:       new Date().toISOString(),
    scoutOutput:     rawOutput,
    revenueVelocity: metrics.revenueVelocity,
    acquisitionEff:  metrics.acquisitionEff,
    momentumScore:   metrics.momentumScore,
    momentumNote:    metrics.momentumNote,
    economics:       _economics,
    totalContacts:   0,   // populated by checkin.html from user input
    totalResponses:  0,
    totalCustomers:  0
  };

  // Save as pending result (result.html reads this on load)
  localStorage.setItem(scoutKey('scout_pending_result'), JSON.stringify(resultObj));

  // Append to history (max 12 entries — oldest dropped first)
  var history = getScoutHistory();
  history.push(resultObj);
  if (history.length > 12) {
    history = history.slice(history.length - 12);
  }
  localStorage.setItem(scoutKey('scout_history'), JSON.stringify(history));

  // Advance the week counter and clear the scorecard checklist for the new week
  localStorage.setItem(scoutKey('scout_week_number'), String(weekNumber));
  localStorage.removeItem(scoutKey('scout_week_checklist'));

  // ── STREAK TRACKING ────────────────────────────────────────
  // Streak = consecutive weeks with a check-in.
  // Increments if last check-in was exactly one week before this one.
  // Resets to 1 if a week was skipped (streak broken).
  updateStreak(weekNumber);

  // ── WEEKLY INSIGHT EXTRACTION ───────────────────────────────
  // If Scout included a SCOUT INSIGHT section in the output,
  // extract and save it for display on result.html.
  extractAndSaveInsight(rawOutput, weekNumber);

  // ── BUSINESS HEALTH SCORE ────────────────────────────────────
  // Calculate and persist the 5-dimension health score
  // so index.html can display it on the dashboard.
  calculateHealthScore();

  // ── USAGE TRACKING ───────────────────────────────────────────
  // Fire-and-forget: increment Scout usage counters in KV.
  // Does not block — failure is silently swallowed.
  try {
    var _firmCode = localStorage.getItem('g7_session_firm') || 'unknown';
    var _pending  = {};
    try {
      _pending = JSON.parse(
        localStorage.getItem(scoutKey('scout_pending_result')) || '{}'
      );
    } catch(e) {}
    var _bizData = _pending.businessData || {};

    fetch(SCOUT_WORKER + '/scout/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firmCode:     _firmCode,
        businessType: _bizData.whatYouSell
          ? String(_bizData.whatYouSell).slice(0, 50)
          : (_bizData.businessType
              ? String(_bizData.businessType).slice(0, 50)
              : ''),
        city: _bizData.location
          ? String(_bizData.location).slice(0, 30)
          : (_bizData.city
              ? String(_bizData.city).slice(0, 30)
              : '')
      })
    }).catch(function() {}); // intentionally no await — fire and forget
  } catch(e) {}
}


// ─────────────────────────────────────────────────────────────
// HELPER — updateStreak(weekNumber)
//
// Called after every saveScoutResult().
// Compares this week's number against scout_last_checkin_week.
// If consecutive: increments scout_streak.
// If gap: resets scout_streak to 1.
// Updates scout_last_checkin_week to weekNumber.
// ─────────────────────────────────────────────────────────────
function updateStreak(weekNumber) {
  var lastCheckinWeek = parseInt(localStorage.getItem(scoutKey('scout_last_checkin_week')) || '0', 10);
  var currentStreak   = parseInt(localStorage.getItem(scoutKey('scout_streak')) || '0', 10);

  if (lastCheckinWeek > 0 && lastCheckinWeek === weekNumber - 1) {
    // Consecutive week — increment streak
    currentStreak = currentStreak + 1;
  } else {
    // First check-in, or missed a week — reset to 1
    currentStreak = 1;
  }

  localStorage.setItem(scoutKey('scout_streak'),            String(currentStreak));
  localStorage.setItem(scoutKey('scout_last_checkin_week'), String(weekNumber));
}


// ─────────────────────────────────────────────────────────────
// HELPER — extractAndSaveInsight(rawOutput, weekNumber)
//
// Extracts the SCOUT INSIGHT section from a check-in output.
// Saves to localStorage for result.html to display.
//
// Saves:
//   scout_weekly_insight — the insight text (string)
//   scout_insight_week   — the week this insight is for (string)
// ─────────────────────────────────────────────────────────────
function extractAndSaveInsight(rawOutput, weekNumber) {
  if (!rawOutput) return;

  var insightMatch = rawOutput.match(
    /SCOUT\s+INSIGHT[^:\n]*:\s*([\s\S]+?)(?=\n={3,}|\n━{3,}|\n[A-Z]{3,}[\s\S]{0,20}:|$)/i
  );

  if (insightMatch && insightMatch[1] && insightMatch[1].trim().length > 20) {
    /* Defensive: strip any fenced code block (e.g. an appended JSON patch)
       so raw JSON can never render in the Scout Insight card */
    var cleanInsight = insightMatch[1]
      .replace(/```[\s\S]*?```/g, '')   /* closed fences */
      .replace(/```[\s\S]*$/, '')       /* unclosed fence to end of string */
      .trim();
    if (cleanInsight.length > 20) {
      localStorage.setItem(scoutKey('scout_weekly_insight'), cleanInsight);
      localStorage.setItem(scoutKey('scout_insight_week'),   String(weekNumber));
    }
  }
}


/* ---------- Check-in patch: parse + apply (Task 3) ---------- */

/* Extracts a fenced JSON patch block from TYPE-2 output.
   Returns the parsed object, or null if absent/malformed.
   Never throws — a non-compliant generation must degrade silently. */
function parseCheckinPatch(rawOutput) {
  if (!rawOutput) return null;
  try {
    var m = rawOutput.match(/```json\s*([\s\S]*?)```/i);
    if (!m || !m[1]) return null;
    var patch = JSON.parse(m[1].trim());
    if (!patch || typeof patch !== 'object') return null;
    if (!Array.isArray(patch.changed)) return null;
    return patch;
  } catch (e) {
    console.warn('Check-in patch parse failed:', e);
    return null;
  }
}

/* Applies a patch to the stored TYPE-1 plan object.
   Mutates and returns a NEW object. Returns the original unchanged
   if the patch is null or nothing applies. Never throws. */
function applyCheckinPatch(plan, patch, weekNumber) {
  if (!plan || !patch || !Array.isArray(patch.changed)) return plan;
  var out;
  try { out = JSON.parse(JSON.stringify(plan)); } catch (e) { return plan; }

  try {
    var tab1 = out.tab1 || {};
    var tab2 = out.tab2 || {};
    var icps = Array.isArray(tab1.icps) ? tab1.icps : [];
    var msgs = Array.isArray(tab2.messages) ? tab2.messages : [];

    /* Guard: never retire unless this patch also adds at least one message */
    var hasAdd = patch.changed.some(function(c){ return c.type === 'message_add'; });

    patch.changed.forEach(function(c) {
      if (!c || !c.type) return;

      if (c.type === 'message_retire' && hasAdd) {
        var i = findIdx(msgs, c.target_icp, c.target_index);
        if (i > -1 && msgs.length > 1) {
          msgs[i].status        = 'retired';
          msgs[i].retiredWeek   = weekNumber;
          msgs[i].retiredReason = c.reason || '';
        }
      }

      if (c.type === 'message_add' && c.content) {
        msgs.push({
          icp: c.for_icp || '',
          type: 'primary',
          channel: c.channel || 'WhatsApp',
          language: c.language || '',
          versionA: c.content,
          followupDay3: c.followupDay3 || '',
          followupDay7: c.followupDay7 || '',
          status: 'active',
          addedWeek: weekNumber,
          addedReason: c.reason || ''
        });
      }

      if (c.type === 'icp_promote' || c.type === 'icp_demote') {
        var j = -1;
        for (var k = 0; k < icps.length; k++) {
          if (icps[k] && icps[k].name === c.target) { j = k; break; }
        }
        if (j > -1) {
          var item = icps.splice(j, 1)[0];
          item.rankChangedWeek = weekNumber;
          item.rankReason      = c.reason || '';
          if (c.type === 'icp_promote') icps.unshift(item);
          else icps.push(item);
        }
      }

      if (c.type === 'action_update' && Array.isArray(c.content)) {
        out.thisWeekActions = { week: weekNumber, actions: c.content };
      }
    });

    tab1.icps     = icps;
    tab2.messages = msgs;
    out.tab1      = tab1;
    out.tab2      = tab2;
    out.lastPatchSummary = patch.summary || '';
    out.lastPatchVerdict = patch.verdict || '';
    out.lastPatchedWeek  = weekNumber;
  } catch (e) {
    console.error('applyCheckinPatch failed:', e);
    return plan;
  }
  return out;

  /* Resolve a message by icp name first, falling back to index */
  function findIdx(arr, icpName, idx) {
    if (icpName) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].icp === icpName && arr[i].status !== 'retired') return i;
      }
    }
    if (typeof idx === 'number' && arr[idx]) return idx;
    return -1;
  }
}

/* Round-trips the stored scoutOutput STRING through applyCheckinPatch().
   scoutOutput is stored as a raw string (possibly fence-wrapped), so we must
   clean → parse → patch → stringify. Fail-safe: returns the ORIGINAL string
   unchanged if anything goes wrong. Never throws. */
function applyPatchToStoredPlan(rawPlanString, patch, weekNumber) {
  if (!rawPlanString || typeof rawPlanString !== 'string') return rawPlanString;
  if (!patch) return rawPlanString;
  try {
    /* Same cleaning pipeline parseAndRender() uses */
    var cleaned = rawPlanString
      .replace(/^```json\s*/im, '')
      .replace(/^```\s*/im, '')
      .replace(/```\s*$/im, '')
      .trim();
    var first = cleaned.indexOf('{');
    var last  = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return rawPlanString;
    cleaned = cleaned.slice(first, last + 1);

    var planObj = JSON.parse(cleaned);
    if (!planObj || !planObj.tab1) return rawPlanString;  /* not a TYPE-1 plan */

    var patched = applyCheckinPatch(planObj, patch, weekNumber);
    if (!patched || patched === planObj) return rawPlanString;  /* nothing applied */
    if (!patched.tab1 || !patched.tab2) return rawPlanString;   /* sanity guard */

    return JSON.stringify(patched);
  } catch (e) {
    console.error('applyPatchToStoredPlan failed, plan left unchanged:', e);
    return rawPlanString;
  }
}

// ─────────────────────────────────────────────────────────────
// FUNCTION 4 — getScoutHistory()
//
// Returns the scout_history array from localStorage.
// Safe — always returns an array even if storage is empty or corrupt.
// ─────────────────────────────────────────────────────────────
function getScoutHistory() {
  var raw = localStorage.getItem(scoutKey('scout_history'));
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// HELPER — isCheckinEntry(e)
//
// Returns true if e is a check-in history entry (written by checkin.html).
// Distinguishes check-ins from onboarding entries (written by saveScoutResult).
// A check-in entry always has revenueAdded (may be '0') or type === 'checkin'.
// ─────────────────────────────────────────────────────────────
function isCheckinEntry(e) {
  return !!e && (e.type === 'checkin' || Object.prototype.hasOwnProperty.call(e, 'revenueAdded'));
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 5 — getScoutContext()
//
// Reads the onboarding context from the pending result in localStorage.
// Used by checkin.html to assemble the multi-turn conversation.
//
// Returns: object { onboardContext, priorOutput, weekNumber }
//   onboardContext — the original user message sent to Scout (string or null)
//   priorOutput    — Scout's last output text (string or null)
//   weekNumber     — current week number (integer, defaults to 1)
// ─────────────────────────────────────────────────────────────
function getScoutContext() {
  var raw = localStorage.getItem(scoutKey('scout_pending_result'));
  if (!raw) {
    return { onboardContext: null, priorOutput: null, weekNumber: 1 };
  }

  var obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { onboardContext: null, priorOutput: null, weekNumber: 1 };
  }

  return {
    onboardContext: obj.onboardContext || null,
    priorOutput:    obj.scoutOutput    || null,
    weekNumber:     parseInt(obj.weekNumber) || 1
  };
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 6 — extractScoutMetrics(text)
//
// Parses 4 key metrics from Scout's raw output text.
// Used by result.html and history.html to display headline numbers.
//
// text — Scout's raw output string
//
// Returns: object with 4 fields:
//   revenueVelocity  — string: "₹45,000/month" or null
//   acquisitionEff   — string: "12 contacts" or null
//   momentumScore    — integer: 1–10 or null
//   momentumNote     — string: the momentum label/description or null
// ─────────────────────────────────────────────────────────────
function extractScoutMetrics(text) {
  if (!text) {
    return { revenueVelocity: null, acquisitionEff: null, momentumScore: null, momentumNote: null };
  }

  var revenueVelocity = null;
  var acquisitionEff  = null;
  var momentumScore   = null;
  var momentumNote    = null;

  // Strip separator lines before parsing (Scout uses ===, ━━━ etc.)
  var cleanText = text
    .replace(/^[=\-━═]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  // Revenue Velocity — Scout outputs heading then value on next line:
  //   REVENUE VELOCITY
  //   ₹45,000 added/month
  var rvPatterns = [
    /REVENUE\s+VELOCITY\s*\n\s*(₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?(?:[\/\s]*(?:added\/month|month|per month))?)/i,
    /REVENUE\s+VELOCITY[\s\S]{0,100}(₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?(?:\s*\/\s*month|\s*per\s*month|\s*added\/month))/i,
    /₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?\s*added\/month/i,
    /₹[\d,\.]+(?:\s*(?:lakh|crore|L|Cr))?(?:\s*\/\s*month|\s*per\s*month)/i
  ];
  for (var ri = 0; ri < rvPatterns.length; ri++) {
    var rvM = cleanText.match(rvPatterns[ri]);
    if (rvM) {
      revenueVelocity = (rvM[1] || rvM[0]).trim();
      if (!revenueVelocity.startsWith('₹')) revenueVelocity = '₹' + revenueVelocity;
      break;
    }
  }

  // Acquisition Efficiency — Scout outputs heading then value on next line:
  //   ACQUISITION EFFICIENCY
  //   12 contacts needed per new customer
  var aePatterns = [
    /ACQUISITION\s+EFFICIENCY\s*\n\s*(\d+)\s+contacts?/i,
    /ACQUISITION\s+EFFICIENCY[\s\S]{0,100}(\d+)\s+contacts?\s+(?:needed|per)/i,
    /(\d+)\s+contacts?\s+(?:needed|per)\s+(?:per\s*)?(?:new\s*)?customer/i,
    /ACQUISITION\s+EFFICIENCY[\s\S]{0,100}(\d+)\s+contacts/i,
    /(\d+)\s+contacts?\s+needed/i
  ];
  for (var ai = 0; ai < aePatterns.length; ai++) {
    var aeM = cleanText.match(aePatterns[ai]);
    if (aeM) { acquisitionEff = aeM[1] + ' contacts'; break; }
  }

  // Momentum Score — Scout outputs: SCOUT MOMENTUM: 45/100
  var msPatterns = [
    /SCOUT\s+MOMENTUM\s*[:\-]\s*(\d+)/i,
    /MOMENTUM\s*[:\-]\s*(\d+)\/100/i,
    /(\d+)\/100\s*(?:momentum|score)/i,
    /(?:scout\s+)?momentum(?:\s+score)?[:\s]+(\d{1,3})(?:\/(?:10|100))?/i
  ];
  for (var mi = 0; mi < msPatterns.length; mi++) {
    var msM = cleanText.match(msPatterns[mi]);
    if (msM) {
      var score = parseInt(msM[1], 10);
      if (score >= 0 && score <= 100) { momentumScore = score; break; }
    }
  }

  // Momentum Note — text after the score number
  var mnMatch = cleanText.match(/SCOUT\s+MOMENTUM[:\s]+\d+(?:\/100)?[:\s—\-]+([^\n]+)/i);
  if (mnMatch) {
    momentumNote = mnMatch[1].trim();
  }

  return {
    revenueVelocity: revenueVelocity,
    acquisitionEff:  acquisitionEff,
    momentumScore:   momentumScore,
    momentumNote:    momentumNote
  };
}


// ─────────────────────────────────────────────────────────────
// FUNCTION 7 — calculateHealthScore()
//
// Calculates a 5-dimension Business Health Score (0-100)
// from the most recent check-in data in scout_history.
// Called automatically at end of saveScoutResult().
//
// Saves:
//   scout_health_score     — total score (0-100) as string
//   scout_health_breakdown — object with per-dimension scores
//
// Dimensions (20 pts each):
//   1. Customer Acquisition  — conversion rate vs benchmark
//   2. Revenue Velocity      — revenue vs velocity target
//   3. Customer Retention    — week-over-week customer trend
//   4. Competitive Position  — momentum score band
//   5. Seasonal Preparedness — festival/seasonal activity
// ─────────────────────────────────────────────────────────────
function calculateHealthScore() {
  var history = getScoutHistory();
  if (!history || history.length === 0) return;

  /* Only use check-in entries — onboarding entries lack the fields needed */
  var checkins = history.filter(isCheckinEntry);
  if (checkins.length === 0) return;

  var lastEntry = checkins[checkins.length - 1];
  var prevEntry = checkins.length > 1 ? checkins[checkins.length - 2] : null;

  var breakdown = {};
  var total = 0;

  // ── DIMENSION 1: Customer Acquisition (20 pts) ──────────────
  var totalContacts = (parseInt(lastEntry.icp1_sent,    10) || 0) +
                      (parseInt(lastEntry.icp2_sent,    10) || 0) +
                      (parseInt(lastEntry.icp3_sent,    10) || 0);
  var totalConv     = (parseInt(lastEntry.icp1_conv,    10) || 0) +
                      (parseInt(lastEntry.icp2_conv,    10) || 0) +
                      (parseInt(lastEntry.icp3_conv,    10) || 0);
  var convRate      = totalContacts > 0 ? totalConv / totalContacts : 0;
  var benchmark     = 0.15; // Tier 3 default; Metro is 0.20

  var contactsTarget = 0;
  try {
    var tRaw = localStorage.getItem(scoutKey('scout_last_targets'));
    if (tRaw) contactsTarget = parseInt(JSON.parse(tRaw).contacts || 0, 10) || 0;
  } catch (e) {}

  var acqScore;
  if (totalContacts === 0) {
    acqScore = 0;
  } else if (convRate > benchmark) {
    acqScore = 20;
  } else if (Math.abs(convRate - benchmark) < 0.02) {
    acqScore = 15;
  } else if (contactsTarget > 0 && totalContacts >= contactsTarget) {
    acqScore = 10;
  } else {
    acqScore = 5;
  }
  breakdown.acquisition = { score: acqScore, label: 'Winning Customers' };
  total += acqScore;

  // ── DIMENSION 2: Revenue Velocity (20 pts) ──────────────────
  var revenueAdded   = parseFloat(lastEntry.revenueAdded) || 0;
  var velocityTarget = 0;
  if (lastEntry.scoutOutput) {
    var vtMatch = lastEntry.scoutOutput.match(/REVENUE\s+VELOCITY\s+TARGET\s*:\s*₹?([\d,]+)/i);
    if (vtMatch) velocityTarget = parseFloat(vtMatch[1].replace(/,/g, '')) || 0;
  }

  var revScore;
  if (revenueAdded === 0) {
    revScore = 0;
  } else if (velocityTarget <= 0 || revenueAdded >= velocityTarget) {
    revScore = 20;
  } else if (revenueAdded >= velocityTarget * 0.75) {
    revScore = 15;
  } else if (revenueAdded >= velocityTarget * 0.50) {
    revScore = 10;
  } else {
    revScore = 5;
  }
  breakdown.revenue = { score: revScore, label: 'Money Coming In' };
  total += revScore;

  // ── DIMENSION 3: Customer Retention (20 pts) ─────────────────
  var lastCust = parseInt(lastEntry.totalCustomers, 10) || 0;
  var prevCust = prevEntry !== null ? (parseInt(prevEntry.totalCustomers, 10) || 0) : -1;

  var retScore;
  if (prevCust === -1) {
    retScore = 15; // first check-in — no prior data, neutral
  } else if (lastCust > prevCust) {
    retScore = 20;
  } else if (lastCust === prevCust) {
    retScore = 15;
  } else if (prevCust > 0 && lastCust >= prevCust * 0.8) {
    retScore = 10;
  } else {
    retScore = 0;
  }
  breakdown.retention = { score: retScore, label: 'Keeping Customers' };
  total += retScore;

  // ── DIMENSION 4: Standing Out / Reply Rate (20 pts) ──────────
  var totalSent    = (parseInt(lastEntry.icp1_sent,     10) || 0) +
                     (parseInt(lastEntry.icp2_sent,     10) || 0) +
                     (parseInt(lastEntry.icp3_sent,     10) || 0);
  var totalReplies = (parseInt(lastEntry.icp1_replies,  10) || 0) +
                     (parseInt(lastEntry.icp2_replies,  10) || 0) +
                     (parseInt(lastEntry.icp3_replies,  10) || 0);
  var replyRate = totalSent > 0 ? totalReplies / totalSent : 0;
  var compScore;
  if (totalSent === 0)        { compScore = 0;  }
  else if (replyRate > 0.20)  { compScore = 20; }
  else if (replyRate >= 0.10) { compScore = 15; }
  else if (replyRate >= 0.05) { compScore = 10; }
  else if (replyRate > 0)     { compScore = 5;  }
  else                        { compScore = 0;  }
  breakdown.competitive = { score: compScore, label: 'People Replying' };
  total += compScore;

  // ── DIMENSION 5: Seasonal Preparedness (20 pts) ──────────────
  var seasonalScore = 10; // default: standard weekly activity
  if (totalContacts === 0 && revenueAdded === 0) {
    // No activity at all this week
    seasonalScore = 0;
  } else if (lastEntry.scoutOutput) {
    var seasonalRe = /festival|diwali|holi|eid|navratri|puja|christmas|campaign|seasonal|offer|mela|rakhi|onam|lohri|baisakhi/i;
    if (seasonalRe.test(lastEntry.scoutOutput)) {
      seasonalScore = 20;
    }
  }
  breakdown.seasonal = { score: seasonalScore, label: 'Ready For Festival Season' };
  total += seasonalScore;

  var finalScore = Math.min(total, 100);
  localStorage.setItem(scoutKey('scout_health_score'),     String(finalScore));
  localStorage.setItem(scoutKey('scout_health_breakdown'), JSON.stringify(breakdown));

  // ── PER-WEEK HEALTH SCORE ────────────────────────────────────
  // Write score and breakdown onto the last check-in entry in
  // scout_history so history.html can chart it per week.
  try {
    var hw = getScoutHistory();
    if (hw && hw.length > 0) {
      var lastCheckinIdx = -1;
      for (var hi = hw.length - 1; hi >= 0; hi--) {
        if (isCheckinEntry(hw[hi])) { lastCheckinIdx = hi; break; }
      }
      if (lastCheckinIdx !== -1) {
        hw[lastCheckinIdx].healthScore     = finalScore;
        hw[lastCheckinIdx].healthBreakdown = breakdown;
        localStorage.setItem(scoutKey('scout_history'), JSON.stringify(hw));
      }
    }
  } catch (e) {}

  return finalScore;
}


// ─────────────────────────────────────────────────────────────
// HELPER — purgeRawScoutKeys()
//
// Removes all 15 raw (unscoped) SCOUT_STATE_KEYS entries from
// localStorage. Called by repairOrphanedScoutResult() once the
// repair decision has been made and any needed server sync has
// succeeded — so the raw keys are either already rescued into
// the scoped namespace and persisted to the server, or the gates
// confirmed they do not belong to the current firm.
//
// This is the permanent backstop against cross-firm data leaks:
// after this runs, migrateUnscopedScoutKeys (now a no-op) and
// any future migration path cannot find anything to copy.
// ─────────────────────────────────────────────────────────────
function purgeRawScoutKeys() {
  var keys = [
    'scout_pending_result',
    'scout_history',
    'scout_week_number',
    'scout_streak',
    'scout_last_checkin_week',
    'scout_health_score',
    'scout_health_breakdown',
    'scout_weekly_insight',
    'scout_insight_week',
    'scout_last_targets',
    'scout_icp_names',
    'scout_first_customer_celebrated',
    'scout_week_checklist',
    'scout_referral_chain',
    'scout_pipeline'
  ];
  for (var i = 0; i < keys.length; i++) {
    localStorage.removeItem(keys[i]);
  }
}


// ─────────────────────────────────────────────────────────────
// HELPER — repairOrphanedScoutResult()
//
// Self-heal for users whose analysis ran before the scoping fix.
// Their server blob holds a stub object (scoped key, empty scoutOutput)
// while the real analysis sits in the unscoped raw key.
//
// MUST be called AFTER loadScoutStateFromServer() — if called before,
// the server load overwrites the repair.
//
// Repairs two things:
//   1. scout_pending_result — scoped stub has no/empty scoutOutput;
//      raw key has a complete one → merge raw into scoped.
//   2. scout_history — scoped array is empty but raw array has entries
//      → copy raw to scoped.
//
// After any repair, calls saveScoutStateToServer() to persist.
// No-ops silently if nothing needs fixing.
// ─────────────────────────────────────────────────────────────
async function repairOrphanedScoutResult() {
  try {
    var pendingRepaired = false;

    // ── 1. scout_pending_result ────────────────────────────────
    //
    // Safety gate: only repair when ALL of these are true:
    //   a) Scoped key EXISTS in localStorage (proof this firm has been here)
    //   b) Scoped object has onboardContext OR businessData (proof it belongs
    //      to the current firm — not a stale stub from a different firm)
    //   c) Scoped object has no/empty scoutOutput (the actual gap to fill)
    //   d) Raw unscoped key has a non-empty scoutOutput (data to restore)
    //
    // If the scoped key is MISSING ENTIRELY → skip. We have no proof
    // the current firm ever produced a result, so copying raw data would
    // be a cross-firm data leak. Log clearly and bail.
    //
    var scopedRaw = localStorage.getItem(scoutKey('scout_pending_result'));

    if (scopedRaw === null) {
      // Scoped key is completely absent — safe to do nothing.
      console.log('[repairOrphanedScoutResult] Scoped key missing entirely — skipped for safety (no proof this firm onboarded here).');
    } else {
      var scopedObj = null;
      try { scopedObj = JSON.parse(scopedRaw); } catch(e) {}

      // Gate b): must have onboardContext OR businessData as proof of firm identity
      var hasFirmProof = scopedObj && (scopedObj.onboardContext || scopedObj.businessData);

      if (!hasFirmProof) {
        console.log('[repairOrphanedScoutResult] Scoped key exists but has no firm identity markers — skipped for safety.');
      } else {
        // Gate c): only proceed if scoutOutput is genuinely missing
        var hasOutput = scopedObj.scoutOutput && scopedObj.scoutOutput.trim() !== '';

        if (!hasOutput) {
          // Gate d): read raw key and verify it has content
          var rawPending = localStorage.getItem('scout_pending_result');
          if (rawPending) {
            var rawObj = null;
            try { rawObj = JSON.parse(rawPending); } catch(e) {}
            if (rawObj && rawObj.scoutOutput && rawObj.scoutOutput.trim() !== '') {
              // Safe to repair: merge raw result into scoped stub,
              // preserving the firm's own onboardContext + businessData
              var merged = rawObj;
              if (scopedObj.onboardContext) merged.onboardContext = scopedObj.onboardContext;
              if (scopedObj.businessData)   merged.businessData   = scopedObj.businessData;
              localStorage.setItem(scoutKey('scout_pending_result'), JSON.stringify(merged));
              console.log('[repairOrphanedScoutResult] Repaired scout_pending_result — restored scoutOutput from unscoped key.');
              pendingRepaired = true;
            }
          }
        }
      }
    }

    // ── 2. scout_history ──────────────────────────────────────
    //
    // Only repair history if the pending_result repair above actually fired.
    // History repair in isolation (without a confirmed pending_result repair)
    // could pull another firm's history into the current scoped namespace.
    //
    if (pendingRepaired) {
      var scopedHistRaw = localStorage.getItem(scoutKey('scout_history'));
      var scopedHist = [];
      try { scopedHist = scopedHistRaw ? JSON.parse(scopedHistRaw) : []; } catch(e) {}

      if (!Array.isArray(scopedHist) || scopedHist.length === 0) {
        var rawHistRaw = localStorage.getItem('scout_history');
        if (rawHistRaw) {
          var rawHist = null;
          try { rawHist = JSON.parse(rawHistRaw); } catch(e) {}
          if (Array.isArray(rawHist) && rawHist.length > 0) {
            localStorage.setItem(scoutKey('scout_history'), JSON.stringify(rawHist));
            console.log('[repairOrphanedScoutResult] Repaired scout_history — copied ' + rawHist.length + ' entries from unscoped key.');
          }
        }
      }

      // ── Persist repair to server, then clean up all raw keys ─
      // Raw key removal only happens if server sync SUCCEEDS.
      // If sync fails, leave ALL raw keys intact so this repair
      // can retry on the next page load.
      try {
        await saveScoutStateToServer();
        purgeRawScoutKeys();
        console.log('[repairOrphanedScoutResult] Server sync succeeded — all raw unscoped Scout keys removed.');
      } catch(e) {
        console.warn('[repairOrphanedScoutResult] Server sync failed — raw keys left in place for retry:', e);
      }
    } else {
      // ── No repair fired. Purge raw keys ONLY if this firm
      //    demonstrably has its own complete scoped data.
      //
      // Condition: scoped scout_pending_result exists AND has a
      // non-empty scoutOutput. That proves the firm has a full
      // analysis in the scoped namespace and does not need the
      // raw keys as a fallback.
      //
      // Do NOT purge when:
      //   • scoped key is absent  — legacy user whose only copy
      //     is in the raw key; purging would destroy it permanently
      //   • scoped key has no scoutOutput — firm is mid-onboard
      //     or in the same gap state the repair targets; keep raw
      //     keys as the safety net
      //
      var canPurge = false;
      try {
        var _chk = scopedRaw ? JSON.parse(scopedRaw) : null;
        if (_chk && _chk.scoutOutput && _chk.scoutOutput.trim() !== '') {
          canPurge = true;
        }
      } catch(e) {}

      if (canPurge) {
        purgeRawScoutKeys();
        console.log('[repairOrphanedScoutResult] Firm has complete scoped data — raw unscoped Scout keys purged.');
      } else {
        console.log('[repairOrphanedScoutResult] Raw keys preserved — scoped data absent or incomplete; raw keys may be the only copy.');
      }
    }

  } catch(e) {
    // Never let repair logic crash the page
    console.warn('[repairOrphanedScoutResult] Unexpected error:', e);
  }
}


/* ═══════════════════════════════════════════
   SPEAKABLE — number and name formatting for text-to-speech.
   TTS reads "₹1,20,000" as "rupees one comma two zero comma zero zero zero".
   These convert to what a person would actually say.
   Indian numbering system: thousand, lakh, crore.
═══════════════════════════════════════════ */
var _SPK_ONES = ['zero','one','two','three','four','five','six','seven','eight',
  'nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen',
  'seventeen','eighteen','nineteen'];
var _SPK_TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy',
  'eighty','ninety'];

function _spkUnder100(n) {
  if (n < 20) return _SPK_ONES[n];
  var t = Math.floor(n / 10), r = n % 10;
  return _SPK_TENS[t] + (r ? '-' + _SPK_ONES[r] : '');
}

function _spkUnder1000(n) {
  if (n < 100) return _spkUnder100(n);
  var h = Math.floor(n / 100), r = n % 100;
  return _SPK_ONES[h] + ' hundred' + (r ? ' ' + _spkUnder100(r) : '');
}

/* speakable(42000)        -> "forty-two thousand"
   speakable(120000)       -> "one lakh twenty thousand"
   speakable(4500000)      -> "forty-five lakh"
   speakable(12500000)     -> "one crore twenty-five lakh"
   speakable(34)           -> "thirty-four"
   speakable(42500, true)  -> "about forty-two thousand"   (rounded)
   Non-numeric or NaN returns an empty string. */
function speakable(n, round) {
  n = Number(n);
  if (!isFinite(n)) return '';
  var neg = n < 0;
  n = Math.abs(Math.round(n));

  if (round) {
    if (n >= 10000000)  n = Math.round(n / 100000) * 100000;
    else if (n >= 100000) n = Math.round(n / 10000) * 10000;
    else if (n >= 10000)  n = Math.round(n / 1000) * 1000;
    else if (n >= 1000)   n = Math.round(n / 100) * 100;
  }

  if (n === 0) return 'zero';

  var parts = [];
  var crore = Math.floor(n / 10000000); n %= 10000000;
  var lakh  = Math.floor(n / 100000);   n %= 100000;
  var thou  = Math.floor(n / 1000);     n %= 1000;

  if (crore) parts.push(_spkUnder1000(crore) + ' crore');
  if (lakh)  parts.push(_spkUnder1000(lakh) + ' lakh');
  if (thou)  parts.push(_spkUnder1000(thou) + ' thousand');
  if (n)     parts.push(_spkUnder1000(n));

  var out = parts.join(' ');
  return (neg ? 'minus ' : '') + out;
}

/* speakableMoney(42000) -> "forty-two thousand rupees" */
function speakableMoney(n, round) {
  var s = speakable(n, round);
  return s ? s + ' rupees' : '';
}

/* speakableName("Smartried Software Technologies PVT LTD")
     -> "Smartried Software"
   Strips legal suffixes and trailing corporate filler so TTS does not
   spell out "P V T L T D". Never returns empty — falls back to the
   original string if stripping would remove everything. */
function speakableName(s) {
  if (!s) return '';
  var out = String(s);
  out = out.replace(/[.,]/g, ' ');
  out = out.replace(/\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|co|company|and co)\b/gi, ' ');
  out = out.replace(/\b(technologies|technology|solutions|services|enterprises|ventures|industries|systems|group|holdings)\b/gi, ' ');
  /* Cut at a separator if there is one — business names often carry a
     descriptive tail after a dash, pipe or bullet that adds nothing spoken. */
  var sep = out.split(/\s+[-–—|·]\s+/)[0];
  if (sep && sep.trim().length >= 3) out = sep;

  out = out.replace(/\s+/g, ' ').trim();
  var words = out.split(' ');
  if (words.length > 4) out = words.slice(0, 4).join(' ');

  /* Never end on punctuation — TTS reads a trailing dash aloud or pauses. */
  out = out.replace(/[\s\-–—|·,&]+$/, '').trim();

  return out || String(s).trim();
}


// ─────────────────────────────────────────────────────────────
// MODULE EXPORT (Node.js validation only)
// Not used in browser — Scout pages load this via <script> tag
// ─────────────────────────────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = { callScout, callScoutRaw, callScoutCheckin, saveScoutResult, getScoutHistory, getScoutContext, extractScoutMetrics, calculateHealthScore };
}
