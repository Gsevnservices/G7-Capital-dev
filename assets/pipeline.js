// ═══════════════════════════════════════════════════════════════
// G7 SCOUT — PIPELINE DATA LAYER
// File: assets/pipeline.js
//
// Manages the named-contact pipeline stored in localStorage.
// Load this file BEFORE any Scout page that needs pipeline data.
//
// Storage key: 'scout_pipeline'
// Shape: { people: [...], anonymousContacts: [...] }
//
// People statuses: found | contacted | replied | trial_booked | joined |
//                  gone_quiet | not_interested
//
// 'found'     — added by Customer Finder; user has NOT sent a message yet.
//               Skipped by chase rules. Transitions to 'contacted' when the
//               user sends a first message.
//
// Optional fields added for Customer Finder (absent on older entries):
//   address  — street address from Google Places (string, may be '')
//   website  — business website from Google Places (string, may be '')
//   source   — 'manual' (hand-added) or 'places' (found via Customer Finder)
// All code that reads person objects must tolerate these being undefined.
// ═══════════════════════════════════════════════════════════════

'use strict';

/* ---------- Firm-scoped storage keys ---------- */
/* All Scout data is namespaced by the logged-in firm so multiple accounts
   on one browser never share state. Reads the firm fresh each call. */
function scoutKey(base) {
  var firm = '';
  try { firm = localStorage.getItem('g7_session_firm') || ''; } catch (e) {}
  firm = String(firm).replace(/[^a-zA-Z0-9]/g, '') || 'default';
  return base + '_' + firm;
}

/* ---------- Pipeline store (Scout) ---------- */

/* Returns the firm-scoped localStorage key for the pipeline store. */
function pipelineKey() { return scoutKey('scout_pipeline'); }

/* Read the whole pipeline. Never throws — returns an empty store on any failure. */
function pipelineLoad() {
  try {
    var raw = localStorage.getItem(pipelineKey());
    if (!raw) return { people: [], anonymousContacts: [] };
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return { people: [], anonymousContacts: [] };
    if (!Array.isArray(p.people)) p.people = [];
    if (!Array.isArray(p.anonymousContacts)) p.anonymousContacts = [];
    return p;
  } catch (e) {
    console.error('pipelineLoad failed:', e);
    return { people: [], anonymousContacts: [] };
  }
}

/* Timer for debounced server sync after pipeline writes. */
var _pipelineSyncTimer = null;
/* Tracks whether a sync has fired since the last period of inactivity.
   Leading-edge fire: first write after a quiet period syncs immediately
   so a user who adds a business and immediately switches to WhatsApp
   cannot lose data to a suspended tab. Subsequent writes in the same
   burst are coalesced into one trailing sync 2 s later. */
var _pipelineSyncFired = false;

/* Write the whole pipeline. Returns true on success.
   After a successful write, triggers a server sync via saveScoutStateToServer()
   (defined in scout.js, loaded before pipeline.js on every Scout page).
   Sync is fire-and-forget — a network failure never breaks the local save. */
function pipelineSave(store) {
  try {
    if (!store || !Array.isArray(store.people)) return false;
    localStorage.setItem(pipelineKey(), JSON.stringify(store));

    /* Server sync — leading-edge + trailing-edge debounce.
       First write after a quiet period fires immediately (leading edge).
       Further writes within 2 s are coalesced into one trailing sync.
       Guard: saveScoutStateToServer only exists when scout.js is loaded. */
    if (typeof saveScoutStateToServer === 'function') {
      clearTimeout(_pipelineSyncTimer);
      if (!_pipelineSyncFired) {
        /* Leading edge — fire now */
        _pipelineSyncFired = true;
        try { saveScoutStateToServer(); } catch (_se) {}
      }
      /* Trailing edge — coalesce remaining burst writes */
      _pipelineSyncTimer = setTimeout(function() {
        _pipelineSyncFired = false;
        try { saveScoutStateToServer(); } catch (_se) {}
      }, 2000);
    }

    return true;
  } catch (e) {
    console.error('pipelineSave failed:', e);
    return false;
  }
}

/* Add a named person. Returns the new person object, or an existing one
   on duplicate.

   Dedupe rules (checked in order):
   1. Strict: same normalised name AND same non-empty phone → exact
      duplicate. Return existing immediately — no mutations, no history
      event. Prevents double-adds when Customer Finder returns the same
      business across two searches.
   2. Soft: same normalised name, phone not matched → treat as a
      re-message of a known contact. Update lastContactedAt and push a
      history event (existing behaviour kept for the outreach flow).

   New optional fields populated from opts (absent on older entries —
   all readers must tolerate undefined):
     address  (string)  — street address, default ''
     website  (string)  — business website URL, default ''
     source   (string)  — 'manual' | 'places', default 'manual'
*/
function pipelineAddPerson(name, opts) {
  opts = opts || {};
  var store = pipelineLoad();
  var clean = String(name || '').trim();
  if (!clean) return null;
  var cleanPhone = String(opts.phone || '').replace(/[^0-9]/g, '');

  /* ── Strict dedupe: same name + same non-empty phone ── */
  if (cleanPhone) {
    for (var j = 0; j < store.people.length; j++) {
      var p = store.people[j];
      if (p.name &&
          p.name.toLowerCase() === clean.toLowerCase() &&
          p.phone === cleanPhone) {
        /* Exact duplicate — return existing record unchanged */
        return p;
      }
    }
  }

  /* ── Soft dedupe: same name only (re-message flow) ── */
  var existing = null;
  for (var i = 0; i < store.people.length; i++) {
    if (store.people[i].name && store.people[i].name.toLowerCase() === clean.toLowerCase()) {
      existing = store.people[i];
      break;
    }
  }
  var now = new Date().toISOString();
  if (existing) {
    existing.lastContactedAt = now;
    if (opts.messageId && existing.messagesSent.indexOf(opts.messageId) === -1) {
      existing.messagesSent.push(opts.messageId);
    }
    existing.history.push({ week: opts.week || 0, event: 'contacted', at: now });
    pipelineSave(store);
    return existing;
  }

  /* ── New person ── */
  /* opts.status overrides the initial status. Customer Finder passes 'found'
     so that a business added from a Places search is not treated as contacted
     until the user actually sends a first message. Default: 'contacted'. */
  var initialStatus = opts.status || 'contacted';
  var person = {
    id: 'p_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    name: clean,
    phone: cleanPhone,
    icp: opts.icp || '',
    status: initialStatus,
    addedWeek: opts.week || 0,
    lastContactedAt: now,
    lastStatusAt: now,
    messagesSent: opts.messageId ? [opts.messageId] : [],
    note: opts.note || '',
    address: opts.address || '',        /* from Customer Finder — '' when hand-added */
    website: opts.website || '',        /* from Customer Finder — '' when hand-added */
    source: opts.source || 'manual',   /* 'places' when added from Customer Finder */
    history: [{ week: opts.week || 0, event: initialStatus, at: now }]
  };
  store.people.push(person);
  pipelineSave(store);
  return person;
}

/* Record a contact where the user skipped naming the person. */
function pipelineAddAnonymous(icp, week) {
  var store = pipelineLoad();
  var found = null;
  for (var i = 0; i < store.anonymousContacts.length; i++) {
    if (store.anonymousContacts[i].week === week && store.anonymousContacts[i].icp === icp) {
      found = store.anonymousContacts[i];
      break;
    }
  }
  if (found) { found.count += 1; }
  else { store.anonymousContacts.push({ week: week || 0, icp: icp || '', count: 1 }); }
  pipelineSave(store);
  return true;
}

/* Update a person's status.
   Valid: found, contacted, replied, trial_booked, joined, gone_quiet, not_interested
   'found' → 'contacted' is the normal transition when a Customer Finder
   business receives its first message. */
function pipelineSetStatus(personId, status, week, note) {
  var VALID = ['found','contacted','replied','trial_booked','joined','gone_quiet','not_interested'];
  if (VALID.indexOf(status) === -1) return false;
  var store = pipelineLoad();
  for (var i = 0; i < store.people.length; i++) {
    if (store.people[i].id === personId) {
      var now = new Date().toISOString();
      store.people[i].status = status;
      store.people[i].lastStatusAt = now;
      if (note) store.people[i].note = note;
      store.people[i].history.push({ week: week || 0, event: status, at: now });
      return pipelineSave(store);
    }
  }
  return false;
}

/* Aggregate counts per ICP for a given week — used to replace manual number entry. */
function pipelineWeekStats(week) {
  var store = pipelineLoad();
  var stats = {};
  function bucket(icp) {
    if (!stats[icp]) stats[icp] = { contacted: 0, replied: 0, trial_booked: 0, joined: 0 };
    return stats[icp];
  }
  store.people.forEach(function(p) {
    p.history.forEach(function(h) {
      if (h.week !== week) return;
      var b = bucket(p.icp || 'Unknown');
      if (h.event === 'contacted')    b.contacted++;
      if (h.event === 'replied')      b.replied++;
      if (h.event === 'trial_booked') b.trial_booked++;
      if (h.event === 'joined')       b.joined++;
    });
  });
  store.anonymousContacts.forEach(function(a) {
    if (a.week === week) bucket(a.icp || 'Unknown').contacted += a.count;
  });
  return stats;
}

/* ---------- Chase rules ---------- */

/* Days between two ISO timestamps */
function pipelineDaysSince(iso) {
  if (!iso) return 999;
  var then = new Date(iso).getTime();
  if (isNaN(then)) return 999;
  return Math.floor((Date.now() - then) / 86400000);
}

/* Returns people who need action today, each with a reason and a suggested message.
   Rules:
     contacted, no reply 3+ days   -> follow up
     contacted, no reply 7+ days   -> final follow up
     replied, no trial 5+ days     -> stall breaker
     trial_booked, 1+ days past    -> did they show
     any status, 14+ days silent   -> gone quiet, win-back
   joined, not_interested, and found are never chased.
   'found' is excluded because the user has never sent a message — the
   business is a lead, not an open conversation. */
function pipelineDue() {
  var store = pipelineLoad();
  var out = [];
  store.people.forEach(function(p) {
    if (p.status === 'joined' || p.status === 'not_interested') return;
    var d = pipelineDaysSince(p.lastStatusAt || p.lastContactedAt);
    var first = (p.name || '').split(' ')[0] || 'there';
    var item = null;

    if (p.status === 'contacted' && d >= 14) {
      item = { reason: 'No response in ' + d + ' days', urgency: 3,
               msg: 'Hi ' + first + ' — last try from my side. Agar kabhi zaroorat ho toh bata dena. Hum yahaan hain.' };
    } else if (p.status === 'contacted' && d >= 7) {
      item = { reason: 'No reply for ' + d + ' days — final follow-up', urgency: 2,
               msg: 'Hi ' + first + ' — ek baar aur pooch raha hoon. Aapke liye koi din suit karta hai baat karne ke liye?' };
    } else if (p.status === 'contacted' && d >= 3) {
      item = { reason: 'No reply for ' + d + ' days', urgency: 1,
               msg: 'Hi ' + first + ' — pichle message ka follow-up. Koi din suit karta hai baat karne ke liye?' };
    } else if (p.status === 'replied' && d >= 5) {
      item = { reason: 'Replied ' + d + ' days ago but has not booked', urgency: 3,
               msg: 'Hi ' + first + ' — aapne interest dikhaya tha. Is week ek slot rakh doon? Bas din bata dijiye.' };
    } else if (p.status === 'trial_booked' && d >= 1) {
      item = { reason: 'Trial was ' + d + ' day(s) ago — did they show?', urgency: 3,
               msg: 'Hi ' + first + ' — kaisa raha? Koi baat ho toh bata dena.' };
    } else if (p.status === 'gone_quiet' && d >= 14) {
      item = { reason: 'Quiet for ' + d + ' days', urgency: 1,
               msg: 'Hi ' + first + ' — kaafi time ho gaya. Jab ready ho, bata dena.' };
    } else if (p.status === 'found' && d >= 1) {
      item = { reason: 'Found ' + d + ' day(s) ago — never messaged', urgency: 2,
               msg: 'Hi ' + first + ' — main [your business] se hoon. Aapke liye ek baat thi, 2 min baat kar sakte hain?' };
    }

    if (item) {
      item.person = p;
      out.push(item);
    }
  });
  out.sort(function(a, b) { return b.urgency - a.urgency; });
  return out;
}

/* Everyone, sorted: found first (freshest leads), then active, then closed.
   found: -1  — top of list; just discovered, awaiting first message
   replied: 0, trial_booked: 1, contacted: 2, gone_quiet: 3
   joined: 4, not_interested: 5 */
function pipelineAll() {
  var order = { found: -1, replied: 0, trial_booked: 1, contacted: 2, gone_quiet: 3, joined: 4, not_interested: 5 };
  var store = pipelineLoad();
  return store.people.slice().sort(function(a, b) {
    return (order[a.status] || 9) - (order[b.status] || 9);
  });
}

/* Normalise a raw phone string for use in a wa.me URL.
   Google Places returns Indian numbers in domestic format ("093727 58713").
   wa.me requires the international number with no leading +, e.g. "919372758713".

   Rules applied in order:
   1. Strip everything except digits.
   2. If already 12 digits starting with 91  → already international, return as-is.
   3. If starts with 0 (Indian trunk prefix)  → strip the 0.
   4. If now 10 digits                        → prepend 91 (Indian mobile).
   5. Otherwise                               → return as-is (non-Indian or landline).

   Numbers with other country codes (e.g. 447911…) fall through step 3 (no leading 0)
   and step 4 (not 10 digits) and are returned unchanged — wa.me handles them correctly.
   Stored phone values are never modified; normalise only at link-build time. */
function waPhone(raw) {
  var d = String(raw || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.indexOf('91') === 0 && d.length === 12) return d;  // already 91XXXXXXXXXX
  if (d.indexOf('0') === 0) d = d.slice(1);                 // strip trunk prefix
  if (d.length === 10) return '91' + d;                     // bare Indian mobile
  return d;                                                  // leave anything else alone
}
