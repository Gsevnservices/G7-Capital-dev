// ═══════════════════════════════════════════════════════════════
// G7 WORKSPACE — SHARED JAVASCRIPT ENGINE
// File: assets/workspace.js
//
// This file is the core engine for the entire G7 Workspace.
// It must be loaded by every workspace HTML page via:
//   <script src="../assets/workspace.js"></script>
//
// Load order in every workspace page:
//   1. alex-master-v1.js   (defines ALEX_MASTER_PROMPT constant)
//   2. workspace.js        (this file — uses ALEX_MASTER_PROMPT)
//
// localStorage keys used across the workspace:
//   g7_api_key              — Anthropic API key
//   g7_firm_knowledge_base  — Full firm KB text, injected into every Alex call
//   g7_firm_config          — JSON object with firm configuration details
//   g7_deal_history         — JSON array of all screened deals
//   g7_calibration_log      — JSON array of partner corrections to Alex
//   g7_onboarded            — 'true' once firm has completed onboarding
//   g7_pending_result       — Temp storage for last Alex output, read by result.html
// ═══════════════════════════════════════════════════════════════

'use strict';

// ─────────────────────────────────────────────────────────────
// PROXY URL — the Cloudflare Worker that forwards requests to Anthropic.
// The API key lives in Cloudflare as an environment variable.
// Replace this URL if you redeploy the worker under a different name.
// ─────────────────────────────────────────────────────────────
var G7_PROXY_URL = G7_WORKER_URL + '/api/message';


// ─────────────────────────────────────────────────────────────
// 1. callAlex(dealSubmission)
//
// The core API call. Assembles the full system prompt and user
// message, calls the Anthropic API, and returns Alex's response.
//
// dealSubmission is an object with:
//   companyName  (string, required)
//   source       (string, required) — how the deal came in
//   partnerFocus (string, optional) — specific instructions from partner
//   content      (string, required) — the full deal text or extracted PDF text
//
// Returns: Alex's full text response (string)
// Throws:  Error with a user-readable message if something goes wrong
// ─────────────────────────────────────────────────────────────
async function callAlex(dealSubmission) {

  // The Cloudflare Worker adds the API key server-side — no key needed in the browser.
  // Get the firm knowledge base from localStorage
  var firmKB = localStorage.getItem('g7_firm_knowledge_base') || '';
  if (!firmKB || firmKB.trim() === '') {
    throw new Error('No firm configuration found. Please complete onboarding before screening a deal.');
  }
  // Cap KB at 6,000 chars to protect token budget (Sequoia-scale KBs can be very large)
  if (firmKB.length > 6000) {
    firmKB = firmKB.substring(0, 6000) + '\n[KB truncated to fit token budget]';
  }

  // 1c. Assemble the full system prompt:
  //     Alex's master prompt + the firm's knowledge base
  //     The firm KB is appended so it overrides generic defaults
  var systemPrompt = ALEX_MASTER_PROMPT + '\n\n' + firmKB;

  // 1d. Build the structured user message
  //     This is the deal submission in the format Alex expects
  var userMessage = [
    'Please screen the following deal and produce a complete',
    'G7 Workspace Deal Screening Note in your standard format.',
    '',
    'COMPANY:        ' + dealSubmission.companyName,
    'SOURCE:         ' + dealSubmission.source,
    'SPECIFIC FOCUS: ' + (dealSubmission.partnerFocus || 'Standard full screening — no specific focus requested'),
    '',
    'SCREENING DATE: ' + new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    '',
    'DEAL MATERIALS:',
    '───────────────────────────────────────────────',
    dealSubmission.content,
    '───────────────────────────────────────────────'
  ].join('\n');

  // 1e. Make the API call via the Cloudflare Worker proxy.
  //     The worker adds the API key server-side — we do not send it from the browser.
  var response;
  try {
    response = await fetch(G7_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (localStorage.getItem('g7_session_token') || '')
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
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
    // Network-level failure (no internet, worker unreachable, etc.)
    throw new Error('Could not reach the G7 proxy. Please check your internet connection and try again.');
  }

  // 1f. Check response status before parsing — non-200 bodies may not be JSON
  if (!response.ok) {
    var errBody = await response.text();
    throw new Error('API error ' + response.status + ': ' + errBody);
  }

  // 1g. Parse the response JSON
  var data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error('Received an unexpected response from the API. Please try again.');
  }

  // 1h. Handle API-level errors (wrong key, quota exceeded, etc.)
  if (data.error) {
    var msg = data.error.message || 'Unknown API error';
    // Surface common errors in plain English
    if (data.error.type === 'authentication_error') {
      throw new Error('Invalid API key. Please check your Anthropic API key in Settings.');
    }
    if (data.error.type === 'rate_limit_error') {
      throw new Error('Rate limit reached. Please wait a moment and try again.');
    }
    if (data.error.type === 'overloaded_error') {
      throw new Error('Anthropic\'s servers are busy. Please try again in a moment.');
    }
    throw new Error('API error: ' + msg);
  }

  // 1h. Extract the text response
  if (!data.content || !data.content[0] || !data.content[0].text) {
    throw new Error('Alex returned an empty response. Please try again.');
  }

  return data.content[0].text;
}


// ─────────────────────────────────────────────────────────────
// 2. saveDeal(companyName, source, dealContent, alexOutput)
//
// Saves a completed screening to the deal history in localStorage.
// Called immediately after a successful callAlex() response.
//
// Returns: the deal id (timestamp string) for use in redirects
// ─────────────────────────────────────────────────────────────
function saveDeal(companyName, source, dealContent, alexOutput) {

  // Build the deal object
  var dealId = Date.now().toString();
  var deal = {
    id:                dealId,
    companyName:       companyName,
    source:            source,
    dealContent:       dealContent,       // original submission text
    alexOutput:        alexOutput,         // Alex's full raw text response
    dateScreened:      new Date().toISOString(),
    partnerDecision:   null,              // null until partner acts (agreed / overridden)
    calibrationAdded:  false             // true once partner disagrees and adds a correction
  };

  // Load existing history, append new deal, save back
  var history = loadAllDeals();
  history.unshift(deal); // newest deal goes to the front of the array
  localStorage.setItem('g7_deal_history', JSON.stringify(history));

  // Persist deals to KV immediately so they survive logout/login
  // Fire-and-forget: a KV write failure must not break deal submission
  if (typeof g7Save === 'function') {
    g7Save('deals', history).catch(function() {});
  }

  return dealId;
}


// ─────────────────────────────────────────────────────────────
// 3. loadDealById(id)
//
// Retrieves a single deal from the history by its id.
// Used by result.html to load the deal being viewed.
//
// Returns: the deal object, or null if not found
// ─────────────────────────────────────────────────────────────
function loadDealById(id) {
  var history = loadAllDeals();
  for (var i = 0; i < history.length; i++) {
    if (history[i].id === id) {
      return history[i];
    }
  }
  return null;
}


// ─────────────────────────────────────────────────────────────
// 4. loadAllDeals()
//
// Returns the full deal history array from localStorage.
// Always returns an array — empty array if nothing exists yet.
// ─────────────────────────────────────────────────────────────
function loadAllDeals() {
  var raw = localStorage.getItem('g7_deal_history');
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}


// ─────────────────────────────────────────────────────────────
// 5. updateDealDecision(id, decision)
//
// Records whether the partner agreed with or overrode Alex's verdict.
// Called from result.html when the partner clicks Agree or Disagree.
//
// decision: 'agreed' or 'overridden'
// ─────────────────────────────────────────────────────────────
function updateDealDecision(id, decision) {
  var history = loadAllDeals();
  for (var i = 0; i < history.length; i++) {
    if (history[i].id === id) {
      history[i].partnerDecision = decision;
      break;
    }
  }
  localStorage.setItem('g7_deal_history', JSON.stringify(history));
}


// ─────────────────────────────────────────────────────────────
// 5b. updateDealOutput(id, newAlexOutput, clarifyingQuestions, clarifyingAnswers)
//
// Replaces a deal's alexOutput with the final complete screening note,
// and stores the clarifying Q&A for the record.
// Called from result.html after a successful CQ second-pass API call.
// ─────────────────────────────────────────────────────────────
function updateDealOutput(id, newAlexOutput, clarifyingQuestions, clarifyingAnswers) {
  var history = loadAllDeals();
  for (var i = 0; i < history.length; i++) {
    if (history[i].id === id) {
      history[i].alexOutput            = newAlexOutput;
      history[i].clarifyingQuestions   = clarifyingQuestions || null;
      history[i].clarifyingAnswers     = clarifyingAnswers   || null;
      break;
    }
  }
  localStorage.setItem('g7_deal_history', JSON.stringify(history));
}


// ─────────────────────────────────────────────────────────────
// 5c. callAlexRaw(userMessage)
//
// Makes an API call with a pre-assembled user message string.
// Used by the clarifying questions flow in result.html when sending
// the firm's answers back to Alex for the second-pass screening note.
// Uses the same system prompt (Alex Master + Firm KB) as callAlex().
//
// Returns: Alex's full text response (string)
// Throws:  Error with a user-readable message if something goes wrong
// ─────────────────────────────────────────────────────────────
async function callAlexRaw(userMessage) {

  var firmKB = localStorage.getItem('g7_firm_knowledge_base') || '';
  if (!firmKB || firmKB.trim() === '') {
    throw new Error('No firm configuration found. Please complete onboarding before screening a deal.');
  }
  if (firmKB.length > 6000) {
    firmKB = firmKB.substring(0, 6000) + '\n[KB truncated to fit token budget]';
  }

  var systemPrompt = ALEX_MASTER_PROMPT + '\n\n' + firmKB;

  var response;
  try {
    response = await fetch(G7_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (localStorage.getItem('g7_session_token') || '')
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 6000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages:   [{ role: 'user', content: userMessage }]
      })
    });
  } catch (networkError) {
    throw new Error('Could not reach the G7 proxy. Please check your internet connection and try again.');
  }

  if (!response.ok) {
    var errBody = await response.text();
    throw new Error('API error ' + response.status + ': ' + errBody);
  }

  var data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error('Received an unexpected response from the API. Please try again.');
  }

  if (data.error) {
    var msg = data.error.message || 'Unknown API error';
    if (data.error.type === 'authentication_error') throw new Error('Invalid API key. Please check your Anthropic API key in Settings.');
    if (data.error.type === 'rate_limit_error')     throw new Error('Rate limit reached. Please wait a moment and try again.');
    throw new Error('API error: ' + msg);
  }

  if (!data.content || !data.content[0] || !data.content[0].text) {
    throw new Error('Alex returned an empty response. Please try again.');
  }

  return data.content[0].text;
}


// ─────────────────────────────────────────────────────────────
// 5d. callAlexWithImages(dealSubmission, imageArray)
//
// Vision-enabled API call for PDF pitch decks.
// Sends the deal text AND base64 JPEG slide images to Alex.
// Alex reads both the extracted text and the rendered slides.
//
// dealSubmission — same object as callAlex():
//   companyName, source, partnerFocus, content
// imageArray     — array of base64 JPEG strings, one per rendered slide
//
// Returns: Alex's full text response (string)
// Throws:  Error with a user-readable message if something goes wrong
// ─────────────────────────────────────────────────────────────
async function callAlexWithImages(dealSubmission, imageArray) {

  var firmKB = localStorage.getItem('g7_firm_knowledge_base') || '';
  if (!firmKB || firmKB.trim() === '') {
    throw new Error('No firm configuration found. Please complete onboarding before screening a deal.');
  }
  if (firmKB.length > 6000) {
    firmKB = firmKB.substring(0, 6000) + '\n[KB truncated to fit token budget]';
  }

  var systemPrompt = ALEX_MASTER_PROMPT + '\n\n' + firmKB;

  // Build the text part of the user message
  var textPart = [
    'Please screen the following deal and produce a complete',
    'G7 Workspace Deal Screening Note in your standard format.',
    '',
    'COMPANY:        ' + dealSubmission.companyName,
    'SOURCE:         ' + dealSubmission.source,
    'SPECIFIC FOCUS: ' + (dealSubmission.partnerFocus || 'Standard full screening — no specific focus requested'),
    '',
    'DEAL MATERIALS:',
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    dealSubmission.content,
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    '',
    'VISUAL MATERIALS:',
    imageArray.length + ' pitch deck slide' + (imageArray.length === 1 ? '' : 's') +
      ' are attached as images below.',
    'Please read both the extracted text above and the visual slides.'
  ].join('\n');

  // Build multi-part content array:
  // First the text block, then one image block per slide
  var contentArray = [
    { type: 'text', text: textPart }
  ];

  imageArray.forEach(function(base64Data) {
    contentArray.push({
      type: 'image',
      source: {
        type:       'base64',
        media_type: 'image/jpeg',
        data:       base64Data
      }
    });
  });

  var response;
  try {
    response = await fetch(G7_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (localStorage.getItem('g7_session_token') || '')
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 4000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages:   [{ role: 'user', content: contentArray }]
      })
    });
  } catch (networkError) {
    throw new Error('Could not reach the G7 proxy. Please check your internet connection and try again.');
  }

  if (!response.ok) {
    var errBody = await response.text();
    throw new Error('API error ' + response.status + ': ' + errBody);
  }

  var data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error('Received an unexpected response from the API. Please try again.');
  }

  if (data.error) {
    var msg = data.error.message || 'Unknown API error';
    if (data.error.type === 'authentication_error') {
      throw new Error('Invalid API key. Please check your Anthropic API key in Settings.');
    }
    if (data.error.type === 'rate_limit_error') {
      throw new Error('Rate limit reached. Please wait a moment and try again.');
    }
    if (data.error.type === 'overloaded_error') {
      throw new Error('Anthropic\'s servers are busy. Please try again in a moment.');
    }
    throw new Error('API error: ' + msg);
  }

  if (!data.content || !data.content[0] || !data.content[0].text) {
    throw new Error('Alex returned an empty response. Please try again.');
  }

  return data.content[0].text;
}


// ─────────────────────────────────────────────────────────────
// HELPER: buildContentArray(dealSubmission, imageArray)
//
// Builds the multi-part content array for the Anthropic messages API.
// Always returns an array — single text block for text submissions,
// text + image blocks for PDF submissions.
//
// dealSubmission — object: companyName, source, partnerFocus, content
// imageArray     — array of base64 JPEG strings, or [] for text-only
// ─────────────────────────────────────────────────────────────
function buildContentArray(dealSubmission, imageArray) {

  // Hard cap on deal content — safety net in case caller did not trim
  var MAX_DEAL_CHARS = 6000;
  if (dealSubmission.content && dealSubmission.content.length > MAX_DEAL_CHARS) {
    dealSubmission.content = dealSubmission.content.substring(0, MAX_DEAL_CHARS) +
      '\n\n[Content trimmed to ' + MAX_DEAL_CHARS +
      ' characters to stay within analysis limits. Key information above is complete.]';
  }

  var isPdf = imageArray && imageArray.length > 0;

  // Analysis instruction prepended to every deal submission.
  // Web search disabled — Alex uses submitted materials + training only.
  var analysisInstruction = [
    'NOTE: Analyse this deal using the submitted materials only. Apply all frameworks, sector intelligence,',
    'and red flag libraries from your training. Where data is missing, apply Framework 1 inference rules',
    'and state confidence level.',
    '',
    '─────────────────────────────────────────────────────────────',
    ''
  ].join('\n');

  // Founder email line — included whether provided or not
  var emailLine = dealSubmission.founderEmail
    ? 'FOUNDER CONTACT EMAIL: ' + dealSubmission.founderEmail
    : 'FOUNDER CONTACT EMAIL: Not provided — extract from submission content if present. ' +
      'Look for email addresses in the pitch text and include the best contact email in your ' +
      'analysis under "FOUNDER EMAIL IDENTIFIED: [email]"';

  // Main deal text block
  var dealText = analysisInstruction + [
    'Please screen the following deal and produce a complete',
    'G7 Workspace Deal Screening Note in your standard format.',
    '',
    'COMPANY:        ' + dealSubmission.companyName,
    'SOURCE:         ' + dealSubmission.source,
    'SPECIFIC FOCUS: ' + (dealSubmission.partnerFocus || 'Standard full screening — no specific focus requested'),
    emailLine,
    '',
    'SCREENING DATE: ' + new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    '',
    'DEAL MATERIALS:',
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    dealSubmission.content,
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'
  ].join('\n');

  // For PDF submissions, add a note about the attached slides
  if (isPdf) {
    dealText += '\n\nVISUAL MATERIALS:\n' +
      imageArray.length + ' pitch deck slide' + (imageArray.length === 1 ? '' : 's') +
      ' are attached as images below.\n' +
      'Please read both the extracted text above and the visual slides.';
  }

  // Start with the text block
  var contentArray = [
    { type: 'text', text: dealText }
  ];

  // Append one image block per slide (PDF path only)
  if (isPdf) {
    imageArray.forEach(function(base64Data) {
      contentArray.push({
        type: 'image',
        source: {
          type:       'base64',
          media_type: 'image/jpeg',
          data:       base64Data
        }
      });
    });
  }

  return contentArray;
}


// ─────────────────────────────────────────────────────────────
// 5e. callAlexDirect(dealSubmission, imageArray)
//
// Direct API call — no web search tools.
// Alex analyses the deal using submitted materials + training only.
// This is the active function called by the submit handler.
//
// dealSubmission — object: companyName, source, partnerFocus, content
// imageArray     — array of base64 JPEG strings, or [] for text-only
// ─────────────────────────────────────────────────────────────
async function callAlexDirect(dealSubmission, imageArray) {

  console.log('[G7 DEBUG] callAlexDirect called');
  console.log('[G7 DEBUG] session token present:', !!localStorage.getItem('g7_session_token'));
  console.log('[G7 DEBUG] firm KB length:', (localStorage.getItem('g7_firm_knowledge_base') || '').length);

  var firmKB = localStorage.getItem('g7_firm_knowledge_base') || '';
  if (firmKB.length > 6000) {
    firmKB = firmKB.substring(0, 6000) + '\n[KB truncated to fit token budget]';
  }
  var systemPrompt = ALEX_MASTER_PROMPT + '\n\n' + firmKB;

  var contentArray = buildContentArray(dealSubmission, imageArray);

  // PROMPT CACHING ENABLED
  // First call (cache write):  ~163K tokens × $3.75/1M = $0.61 input + $0.06 output = ~$0.67
  // Cache hit (within 5 min):  ~163K tokens × $0.30/1M = $0.05 input + $0.06 output = ~$0.11
  // Average across typical use: ~$0.15 per deal
  // vs uncached: $0.56 per deal
  // Saving: ~73% on average
  var response = await fetch(G7_PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (localStorage.getItem('g7_session_token') || '')
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
      messages: [{
        role: 'user',
        content: contentArray
      }]
    })
  });

  if (!response.ok) {
    var errBody = await response.text();
    console.error('[G7 DEBUG] Worker response status:', response.status);
    console.error('[G7 DEBUG] Worker response body:', errBody);
    throw new Error('API error ' + response.status + ': ' + errBody);
  }

  var data = await response.json();

  var textBlock = data.content && data.content.find(function(b) {
    return b.type === 'text';
  });
  if (!textBlock) {
    throw new Error('No text in response');
  }
  return textBlock.text;
}


// ─────────────────────────────────────────────────────────────
// WEB SEARCH — DISABLED
// Infrastructure preserved for future re-enabling.
// To re-enable: change callAlexDirect to callAlexWithSearch
// in the submit handler in workspace/submit.html.
// ─────────────────────────────────────────────────────────────

// 5f. callAlexWithSearch(dealSubmission, imageArray)
//
// Web search-enabled API call with multi-turn tool loop.
// NOT currently called — preserved for future use.
//
// Alex runs up to 2 web searches per deal (enforced server-side).
//
// Loop pattern:
//   1. Send request with web_search tool enabled
//   2. If stop_reason === 'tool_use': acknowledge the tool call,
//      append to history, continue loop
//   3. If stop_reason === 'end_turn': extract final text, done
//
// Anthropic executes the search internally and injects results
// into the next context — the tool_result only needs the id.
//
// dealSubmission — object: companyName, source, partnerFocus, content
// imageArray     — array of base64 JPEG strings, or [] for text-only
//
// Returns: Alex's final text response (string)
// Throws:  Error with a user-readable message if something goes wrong
// ─────────────────────────────────────────────────────────────
async function callAlexWithSearch(dealSubmission, imageArray) {

  var firmKB = localStorage.getItem('g7_firm_knowledge_base') || '';
  if (!firmKB || firmKB.trim() === '') {
    throw new Error('No firm configuration found. Please complete onboarding before screening a deal.');
  }
  if (firmKB.length > 6000) {
    firmKB = firmKB.substring(0, 6000) + '\n[KB truncated to fit token budget]';
  }

  var systemPrompt = ALEX_MASTER_PROMPT + '\n\n' + firmKB;

  // Build the initial user message
  var contentArray = buildContentArray(dealSubmission, imageArray);

  // Dynamic search limit based on estimated token usage.
  // System prompt is ~163K tokens; each search adds ~3K tokens.
  // Cap searches when content is already large to avoid 200K limit.
  var contentLength    = JSON.stringify(contentArray).length;
  var estimatedTokens  = 163000 + Math.ceil(contentLength / 4);
  var maxSearches      = estimatedTokens > 170000 ? 1
                       : estimatedTokens > 165000 ? 2
                       : 3;

  // Conversation history — grows with each tool turn
  var messages = [{
    role:    'user',
    content: contentArray
  }];

  var finalText     = '';
  var maxIterations = maxSearches + 2; // headroom for non-search turns
  var iterations    = 0;

  while (iterations < maxIterations) {
    iterations++;

    var response;
    try {
      response = await fetch(G7_PROXY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (localStorage.getItem('g7_session_token') || '')
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 4000,
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' }
            }
          ],
          tools: [{
            type:     'web_search_20250305',
            name:     'web_search',
            max_uses: maxSearches
          }],
          messages: messages
        })
      });
    } catch (networkError) {
      throw new Error('Could not reach the G7 proxy. Please check your internet connection and try again.');
    }

    if (!response.ok) {
      var errBody = await response.text();
      throw new Error('API error ' + response.status + ': ' + errBody);
    }

    var data;
    try {
      data = await response.json();
    } catch (parseError) {
      throw new Error('Received an unexpected response from the API. Please try again.');
    }

    // Handle API-level errors
    if (data.error) {
      // Deal limit reached — worker returns { error: 'deal_limit_reached', message: '...' }
      if (data.error === 'deal_limit_reached') {
        throw new Error('deal_limit_reached: ' + data.message);
      }
      var msg = (data.error && data.error.message) || ('API error ' + response.status);
      if (data.error && data.error.type === 'authentication_error') {
        throw new Error('Invalid API key. Please check your Anthropic API key in Settings.');
      }
      if (data.error && data.error.type === 'rate_limit_error') {
        throw new Error('Rate limit reached. Please wait a moment and try again.');
      }
      if (data.error && data.error.type === 'overloaded_error') {
        throw new Error('Anthropic\'s servers are busy. Please try again in a moment.');
      }
      throw new Error('API error: ' + msg);
    }

    // ── end_turn: Alex has finished writing the note ──────────────
    if (data.stop_reason === 'end_turn') {
      finalText = data.content
        .filter(function(block) { return block.type === 'text'; })
        .map(function(block)    { return block.text; })
        .join('\n');
      break;
    }

    // ── tool_use: Alex wants to run one or more web searches ──────
    if (data.stop_reason === 'tool_use') {

      // Append Alex's turn (contains the tool_use blocks) to history
      messages.push({
        role:    'assistant',
        content: data.content
      });

      // Build tool_result for each tool_use block.
      // Anthropic processes the actual search internally and injects
      // results into the next context — we only need to return the id.
      var toolResults = data.content
        .filter(function(block) { return block.type === 'tool_use'; })
        .map(function(block) {
          return {
            type:        'tool_result',
            tool_use_id: block.id,
            content:     ''
          };
        });

      messages.push({
        role:    'user',
        content: toolResults
      });

      continue;
    }

    // ── Unexpected stop_reason: extract whatever text is available ──
    finalText = data.content
      .filter(function(block) { return block.type === 'text'; })
      .map(function(block)    { return block.text; })
      .join('\n');
    break;
  }

  if (!finalText) {
    throw new Error('Alex did not produce a response after ' + iterations + ' iterations. Please try again.');
  }

  return finalText;
}


// ─────────────────────────────────────────────────────────────
// 6. addCalibration(dealId, alexAssessment, partnerDecision,
//                  reasonForDisagreement, learningRule)
//
// This is Alex's memory system. When a partner disagrees with Alex,
// their correction is:
//   a) Saved to the calibration log (g7_calibration_log)
//   b) Appended to the firm knowledge base (g7_firm_knowledge_base)
//      so that the NEXT API call automatically includes this learning
//
// This is how Alex gets smarter — correction by correction.
//
// Returns: the calibration entry object
// ─────────────────────────────────────────────────────────────
function addCalibration(dealId, alexAssessment, partnerDecision, reasonForDisagreement, learningRule) {

  // Load existing calibration log
  var log = loadCalibrationLog();

  // Build calibration number (sequential, starting at 1)
  var calibNumber = log.length + 1;
  var now = new Date();
  var dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Build the calibration entry object
  var entry = {
    id:                   Date.now().toString(),
    dealId:               dealId,
    calibrationNumber:    calibNumber,
    date:                 now.toISOString(),
    alexAssessment:       alexAssessment,
    partnerDecision:      partnerDecision,
    reasonForDisagreement: reasonForDisagreement,
    learningRule:         learningRule
  };

  // Append to calibration log and save
  log.push(entry);
  localStorage.setItem('g7_calibration_log', JSON.stringify(log));

  // Get the deal's company name for the KB entry
  var deal = loadDealById(dealId);
  var companyName = deal ? deal.companyName : 'Unknown Company';

  // Build the text block to append to the firm knowledge base
  // This is the correction Alex will read at the start of every future session
  var calibrationText = [
    '',
    '───────────────────────────────────────────────',
    'FIRM-SPECIFIC CALIBRATION #' + calibNumber,
    'DATE:               ' + dateStr,
    'DEAL:               ' + companyName,
    'ALEX\'S ASSESSMENT:  ' + alexAssessment,
    'PARTNER DECISION:   ' + partnerDecision,
    'REASON:             ' + reasonForDisagreement,
    'LEARNING:           ' + learningRule,
    '───────────────────────────────────────────────'
  ].join('\n');

  // Append this correction to the live firm knowledge base
  // The next API call will include it automatically
  var currentKB = localStorage.getItem('g7_firm_knowledge_base') || '';

  // Find the FIRM-SPECIFIC CALIBRATION NOTES section and append there
  // If the section exists, insert after it; otherwise append at end
  var calibrationHeader = 'FIRM-SPECIFIC CALIBRATION NOTES:';
  if (currentKB.indexOf(calibrationHeader) !== -1) {
    // Insert directly after the calibration section header line
    var insertPoint = currentKB.indexOf(calibrationHeader) + calibrationHeader.length;
    currentKB = currentKB.slice(0, insertPoint) + calibrationText + currentKB.slice(insertPoint);
  } else {
    // Fallback: just append to the end of the KB
    currentKB = currentKB + calibrationText;
  }

  localStorage.setItem('g7_firm_knowledge_base', currentKB);

  // Mark the deal as having a calibration added
  updateDealDecision(dealId, 'overridden');
  var history = loadAllDeals();
  for (var i = 0; i < history.length; i++) {
    if (history[i].id === dealId) {
      history[i].calibrationAdded = true;
      break;
    }
  }
  localStorage.setItem('g7_deal_history', JSON.stringify(history));

  return entry;
}


// ─────────────────────────────────────────────────────────────
// Helper: loadCalibrationLog()
// Returns the full calibration log array from localStorage.
// ─────────────────────────────────────────────────────────────
function loadCalibrationLog() {
  var raw = localStorage.getItem('g7_calibration_log');
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}


// ─────────────────────────────────────────────────────────────
// 7. loadFirmConfig()
//
// Returns the firm configuration object from localStorage.
// Used by the dashboard and other pages to display firm info.
//
// Returns: parsed JSON object, or null if not onboarded
// ─────────────────────────────────────────────────────────────
function loadFirmConfig() {
  var raw = localStorage.getItem('g7_firm_config');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
// 8. isOnboarded()
//
// Returns true if the firm has completed onboarding.
// Every workspace page must check this on load and redirect
// to onboard.html if it returns false.
// ─────────────────────────────────────────────────────────────
function isOnboarded() {
  return localStorage.getItem('g7_onboarded') === 'true';
}


// ─────────────────────────────────────────────────────────────
// 9. exportNoteAsPDF(dealId)
//
// Opens Alex's screening note in a new browser window
// formatted for printing, then triggers the print dialog.
//
// The print window uses a clean professional layout:
// white background, black text, no navigation, no UI chrome.
// This produces a PDF when the user saves from the print dialog.
// ─────────────────────────────────────────────────────────────
function exportNoteAsPDF(dealId) {
  var deal = loadDealById(dealId);
  if (!deal) {
    alert('Deal not found. Cannot export.');
    return;
  }

  // Format the date for the header
  var screenedDate = new Date(deal.dateScreened);
  var formattedDate = screenedDate.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  // Convert Alex's plain text output to basic HTML for printing
  // Preserve line breaks and section formatting
  var noteHtml = deal.alexOutput
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Bold text between ── or === markers (section headers)
    .replace(/^(━+.+━*)$/gm, '<div class="section-rule">$1</div>')
    .replace(/^(═+.+═*)$/gm, '<div class="section-rule">$1</div>')
    // Line breaks to <br>
    .replace(/\n/g, '<br>');

  // Build the complete printable HTML document
  var printHTML = '<!DOCTYPE html><html><head>' +
    '<meta charset="UTF-8">' +
    '<title>G7 Workspace — ' + deal.companyName + ' — Screening Note</title>' +
    '<style>' +
    // Reset
    '*{margin:0;padding:0;box-sizing:border-box}' +
    // Page setup
    '@page{margin:20mm 18mm;size:A4}' +
    'body{font-family:"Georgia",serif;font-size:11pt;color:#1a1a1a;' +
      'background:#fff;line-height:1.7;max-width:720px;margin:0 auto;padding:20px}' +
    // Print header
    '.print-header{border-bottom:2px solid #1a1a1a;padding-bottom:16px;margin-bottom:28px}' +
    '.print-firm{font-family:"Arial",sans-serif;font-size:9pt;letter-spacing:.15em;' +
      'text-transform:uppercase;color:#666;margin-bottom:6px}' +
    '.print-title{font-size:22pt;font-weight:400;line-height:1.15;margin-bottom:8px}' +
    '.print-meta{font-family:"Arial",sans-serif;font-size:9pt;color:#888;' +
      'display:flex;gap:32px;flex-wrap:wrap}' +
    // Note body
    '.note-body{font-size:10.5pt;line-height:1.75;white-space:pre-wrap;' +
      'font-family:"Courier New",monospace}' +
    '.section-rule{color:#444;font-weight:600}' +
    // Print footer
    '.print-footer{margin-top:40px;padding-top:16px;border-top:1px solid #ccc;' +
      'font-family:"Arial",sans-serif;font-size:8pt;color:#aaa;' +
      'display:flex;justify-content:space-between}' +
    // Hide on screen, show on print
    '@media screen{body{padding:40px;max-width:800px}}' +
    '</style>' +
    '</head><body>' +
    // Header block
    '<div class="print-header">' +
      '<div class="print-firm">G7 Workspace — Deal Screening Note</div>' +
      '<div class="print-title">' + deal.companyName + '</div>' +
      '<div class="print-meta">' +
        '<span>Screened: ' + formattedDate + '</span>' +
        '<span>Source: ' + deal.source + '</span>' +
        (deal.partnerDecision ? '<span>Partner: ' + deal.partnerDecision + '</span>' : '') +
      '</div>' +
    '</div>' +
    // Note body
    '<div class="note-body">' + noteHtml + '</div>' +
    // Footer
    '<div class="print-footer">' +
      '<span>G7 Capital — Confidential</span>' +
      '<span>Generated by Alex — G7 Workspace</span>' +
    '</div>' +
    // Auto-trigger print dialog once the window is loaded
    '<script>window.onload = function(){ window.print(); }<\/script>' +
    '</body></html>';

  // Open in new window and write the document
  var printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) {
    alert('Could not open print window. Please allow pop-ups for this site.');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(printHTML);
  printWindow.document.close();
}


// ─────────────────────────────────────────────────────────────
// 10. clearWorkspace()
//
// Clears all G7 Workspace data from localStorage.
// Used for reset or logout functionality.
// Requires explicit confirmation before executing.
// ─────────────────────────────────────────────────────────────
function clearWorkspace() {
  var confirmed = confirm(
    'This will clear all workspace data including your firm configuration, ' +
    'deal history, and calibration log.\n\n' +
    'This cannot be undone.\n\n' +
    'Are you sure?'
  );
  if (!confirmed) return false;

  // Remove all G7-specific keys from localStorage
  var keysToRemove = [
    'g7_api_key',
    'g7_firm_knowledge_base',
    'g7_firm_config',
    'g7_deal_history',
    'g7_calibration_log',
    'g7_onboarded',
    'g7_pending_result'
  ];

  keysToRemove.forEach(function(key) {
    localStorage.removeItem(key);
  });

  return true;
}


// ─────────────────────────────────────────────────────────────
// UTILITY: parseAlexScore(alexOutput)
//
// Extracts the G7 Score and verdict from Alex's raw text output.
// Used by result.html and history.html to display scores in lists.
//
// Returns an object:
//   { score: number|null, verdict: string|null, status: string|null }
//
// Alex's output contains a G7 SCORE section — this function
// finds the total score and interpretation.
// ─────────────────────────────────────────────────────────────
function parseAlexScore(alexOutput) {
  if (!alexOutput) return { score: null, verdict: null, status: null };

  var result = { score: null, verdict: null, status: null };

  // Look for score patterns like "G7 SCORE: 72/100" or "TOTAL: 72"
  // or "72 / 100" in various formats Alex might use
  var scorePatterns = [
    /G7\s*SCORE[:\s]+(\d{1,3})\s*\/\s*100/i,
    /TOTAL\s*SCORE[:\s]+(\d{1,3})/i,
    /SCORE[:\s]+(\d{1,3})\s*\/\s*100/i,
    /(\d{1,3})\s*\/\s*100/
  ];
  for (var i = 0; i < scorePatterns.length; i++) {
    var match = alexOutput.match(scorePatterns[i]);
    if (match) {
      var num = parseInt(match[1], 10);
      if (num >= 0 && num <= 100) {
        result.score = num;
        break;
      }
    }
  }

  // Derive verdict and status badge from score
  if (result.score !== null) {
    if (result.score >= 85) {
      result.verdict = 'Exceptional';
      result.status  = 'PRIORITY REVIEW';
    } else if (result.score >= 70) {
      result.verdict = 'Strong';
      result.status  = 'RECOMMEND MEETING';
    } else if (result.score >= 55) {
      result.verdict = 'Promising';
      result.status  = 'WARRANTS REVIEW';
    } else if (result.score >= 40) {
      result.verdict = 'Borderline';
      result.status  = 'CONDITIONAL PASS';
    } else if (result.score >= 25) {
      result.verdict = 'Weak';
      result.status  = 'PASS';
    } else {
      result.verdict = 'Clear Pass';
      result.status  = 'PASS';
    }
  }

  // Also look for explicit RECOMMEND / PASS / PROCEED text
  if (alexOutput.match(/\bRECOMMEND\s*PROCEED\b/i)) result.status = 'PROCEED';
  if (alexOutput.match(/\bRECOMMEND\s*PASS\b/i))    result.status = 'PASS';
  if (alexOutput.match(/\bIMMEDIATE\s*PASS\b/i))     result.status = 'PASS';

  return result;
}


// ─────────────────────────────────────────────────────────────
// UTILITY: formatDate(isoString)
//
// Converts an ISO date string to a readable format.
// e.g. "2026-03-29T14:22:00.000Z" → "29 March 2026"
// ─────────────────────────────────────────────────────────────
function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch (e) {
    return isoString;
  }
}


// ─────────────────────────────────────────────────────────────
// GUARD: requireOnboarding()
//
// Call this at the top of every workspace page's script.
// If the firm is not onboarded, redirects to onboard.html
// and stops execution.
//
// Usage at top of any workspace page script:
//   requireOnboarding();
// ─────────────────────────────────────────────────────────────
function requireOnboarding() {
  if (!isOnboarded()) {
    window.location.href = 'onboard.html';
    // Throw to stop any further JS execution on this page
    throw new Error('Redirecting to onboarding.');
  }
}
