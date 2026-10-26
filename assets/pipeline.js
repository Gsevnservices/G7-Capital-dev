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

/* Write the whole pipeline. Returns true on success.
   After a successful write, schedules a debounced server sync via
   scoutScheduleSave() (defined in scout.js, loaded before pipeline.js).
   The 4 s debounce in scout.js coalesces rapid pipeline writes, and
   the page-hide flush ensures nothing is lost on tab close. */
function pipelineSave(store) {
  try {
    if (!store || !Array.isArray(store.people)) return false;
    localStorage.setItem(pipelineKey(), JSON.stringify(store));

    if (typeof scoutScheduleSave === 'function') {
      try { scoutScheduleSave(); } catch (_se) {}
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
    kind: opts.kind || '',             /* 'business' | 'person' | '' (inferred at read time) */
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
      if (status === 'joined') store.people[i].wonAt = now;
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

/* ---------- Business vs person detection ---------- */
/* Business-word regex: whole-word, case-insensitive.
   "Co" only matches "& Co" or "Co." to avoid false positives on Cooper, Coaching etc. */
var _bizWordRe = /\b(enterprises|traders|architects|associates|interiors|pvt|ltd|llp|group|solutions|services|studio|builders)\b|& co\b|co\./i;

/* Infer kind for a lead that has no explicit kind set. */
function pipelineInferKind(person) {
  if (person.kind === 'business' || person.kind === 'person') return person.kind;
  /* Customer Finder leads are always businesses */
  if (person.source === 'places') return 'business';
  var name = String(person.name || '');
  var words = name.trim().split(/\s+/);
  if (words.length >= 3) return 'business';
  if (_bizWordRe.test(name)) return 'business';
  return 'person';
}

/* Display-name helper: returns { first, full, kind } for use in messages and cards.
   Person: first = first word, full = full name.
   Business: first = full name (never split), full = full name. */
function pipelineDisplayName(person) {
  var kind = pipelineInferKind(person);
  var full = String(person.name || '').trim() || 'there';
  if (kind === 'business') return { first: full, full: full, kind: 'business' };
  var firstWord = full.split(' ')[0] || full;
  return { first: firstWord, full: full, kind: 'person' };
}

/* Greeting helper: language-aware greeting for messages.
   Person: "Namaste {first} ji" / "Hi {first}"
   Business: "Namaste {full} team" / "Hi {full} team" */
function pipelineGreeting(person, lang) {
  var dn = pipelineDisplayName(person);
  if (dn.kind === 'business') {
    if (lang === 'English') return 'Hi ' + dn.full + ' team';
    return 'Namaste ' + dn.full + ' team';
  }
  if (lang === 'English') return 'Hi ' + dn.first;
  return 'Namaste ' + dn.first + ' ji';
}

/* ---------- Follow-up message templates ---------- */
/* Templates for quote follow-ups (trade bucket) and review requests.
   {name} = contact first name, {business} = user's business name, {link} = Google review URL.
   If {link} is empty the ": {link}" part is dropped automatically by templateMsg(). */
var FOLLOW_UP_TEMPLATES = {
  quote_3: {
    English:  'Hi {name}, just checking \u2014 did you get a chance to look at the quote? Happy to explain anything.',
    Hinglish: 'Namaste {name} ji, quote dekh liya? Koi sawaal ho toh bataiye, hum samjha denge.',
    Hindi:    '\u0928\u092E\u0938\u094D\u0924\u0947 {name} \u091C\u0940, \u0915\u094D\u092F\u093E \u0906\u092A\u0928\u0947 quote \u0926\u0947\u0916 \u0932\u093F\u092F\u093E? \u0915\u094B\u0908 \u0938\u0935\u093E\u0932 \u0939\u094B \u0924\u094B \u092C\u0924\u093E\u0907\u090F, \u0939\u092E \u0938\u092E\u091D\u093E \u0926\u0947\u0902\u0917\u0947\u0964'
  },
  quote_7: {
    English:  'Hi {name}, following up on last week\'s quote. Would you like any changes?',
    Hinglish: 'Namaste {name} ji, pichle hafte ka quote \u2014 kuch badalna ho toh bataiye.',
    Hindi:    '\u0928\u092E\u0938\u094D\u0924\u0947 {name} \u091C\u0940, \u092A\u093F\u091B\u0932\u0947 \u0939\u092B\u093C\u094D\u0924\u0947 \u0915\u0947 quote \u0915\u0947 \u092C\u093E\u0930\u0947 \u092E\u0947\u0902 \u2014 \u0915\u0941\u091B \u092C\u0926\u0932\u0928\u093E \u0939\u094B \u0924\u094B \u092C\u0924\u093E\u0907\u090F\u0964'
  },
  quote_15: {
    English:  'Hi {name}, it\'s been a couple of weeks since our quote. Still interested? No rush at all.',
    Hinglish: 'Namaste {name} ji, quote bheje kuch din ho gaye. Abhi bhi interest ho toh bataiye, koi jaldi nahi.',
    Hindi:    '\u0928\u092E\u0938\u094D\u0924\u0947 {name} \u091C\u0940, quote \u092D\u0947\u091C\u0947 \u0915\u0941\u091B \u0926\u093F\u0928 \u0939\u094B \u0917\u090F\u0964 \u0905\u092D\u0940 \u092D\u0940 \u0930\u0941\u091A\u093F \u0939\u094B \u0924\u094B \u092C\u0924\u093E\u0907\u090F, \u0915\u094B\u0908 \u091C\u0932\u094D\u0926\u0940 \u0928\u0939\u0940\u0902\u0964'
  },
  review: {
    English:  'Hi {name}, thank you for choosing {business}! If you have a minute, a Google review would really help us: {link}',
    Hinglish: 'Namaste {name} ji, {business} chunne ke liye dhanyavaad! Ek minute ho toh Google review de dijiye, bahut madad hogi: {link}',
    Hindi:    '\u0928\u092E\u0938\u094D\u0924\u0947 {name} \u091C\u0940, {business} \u091A\u0941\u0928\u0928\u0947 \u0915\u0947 \u0932\u093F\u090F \u0927\u0928\u094D\u092F\u0935\u093E\u0926! \u090F\u0915 \u092E\u093F\u0928\u091F \u0939\u094B \u0924\u094B Google review \u0926\u0947 \u0926\u0940\u091C\u093F\u090F, \u092C\u0939\u0941\u0924 \u092E\u0926\u0926 \u0939\u094B\u0917\u0940: {link}'
  }
};

/* Fill a template. Drops ": {link}" when link is empty. */
function templateMsg(key, lang, vars) {
  var tpl = FOLLOW_UP_TEMPLATES[key];
  if (!tpl) return '';
  var msg = tpl[lang] || tpl.Hinglish || '';
  msg = msg.replace(/\{name\}/g, vars.name || 'there');
  msg = msg.replace(/\{business\}/g, vars.business || '');
  if (!vars.link) {
    msg = msg.replace(/[:\s]*\{link\}/g, '');
  } else {
    msg = msg.replace(/\{link\}/g, vars.link);
  }
  return msg;
}

/* Resolve the message language: try cached setting, fall back to onboarding language. */
var _cachedMsgLang = null;
function pipelineMsgLang() {
  if (_cachedMsgLang) return _cachedMsgLang;
  /* Try businessData.language from scout state */
  try {
    var raw = localStorage.getItem(scoutKey('scout_pending_result'));
    if (raw) {
      var d = JSON.parse(raw);
      var lang = (d && d.businessData && d.businessData.language) || 'Hinglish';
      if (/^Regional/i.test(lang)) lang = 'Hinglish';
      /* Normalise to template keys */
      if (/hindi/i.test(lang) && !/hinglish/i.test(lang)) _cachedMsgLang = 'Hindi';
      else if (/english/i.test(lang)) _cachedMsgLang = 'English';
      else _cachedMsgLang = 'Hinglish';
      return _cachedMsgLang;
    }
  } catch (e) {}
  return 'Hinglish';
}

/* Fetch message-lang from worker (fire-and-forget, updates cached value). */
function pipelineFetchMsgLang() {
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return;
    fetch(SCOUT_WORKER + '/scout/message-lang', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function(r) { return r.json(); }).then(function(j) {
      if (j && j.language) {
        var l = j.language;
        if (/^Regional/i.test(l)) l = 'Hinglish';
        if (/hindi/i.test(l) && !/hinglish/i.test(l)) _cachedMsgLang = 'Hindi';
        else if (/english/i.test(l)) _cachedMsgLang = 'English';
        else _cachedMsgLang = 'Hinglish';
      }
    }).catch(function() {});
  } catch (e) {}
}

/* ---------- Chase rules ---------- */

/* Days between two ISO timestamps */
function pipelineDaysSince(iso) {
  if (!iso) return 999;
  var then = new Date(iso).getTime();
  if (isNaN(then)) return 999;
  return Math.floor((Date.now() - then) / 86400000);
}

/* Read the user's own business name from scout_pending_result.businessData.
   Used to personalise first-contact messages for Customer Finder leads. */
function pipelineBusinessName() {
  try {
    var raw = localStorage.getItem(scoutKey('scout_pending_result'));
    if (!raw) return '';
    var d = JSON.parse(raw);
    return (d && d.businessData && d.businessData.businessName) || '';
  } catch (e) { return ''; }
}

/* Returns people who need action today, each with a reason and a suggested message.
   Rules (bucket-aware):
     contacted, no reply 3+ days   -> follow up
     contacted, no reply 7+ days   -> final follow up
     replied, no trial 5+ days     -> stall breaker
     trial_booked (trade):         -> quote follow-up at 3, 7, 15 days
     trial_booked (other buckets): -> 1+ day: did they show?
     joined + no reviewAskedAt, 2+ days since wonAt -> ask for Google review (once)
     any status, 14+ days silent   -> gone quiet, win-back
   joined (except review ask), not_interested, and found are never chased.
   'found' is excluded because the user has never sent a message — the
   business is a lead, not an open conversation. */
function pipelineDue() {
  var store = pipelineLoad();
  var out = [];
  var bucket = (typeof scoutBucket === 'function') ? scoutBucket() : 'retail';
  var lang = pipelineMsgLang();
  var bizName = pipelineBusinessName() || ((typeof displayName === 'function') ? displayName(localStorage.getItem('g7_session_name') || '') : '');
  var reviewLink = '';
  try { reviewLink = localStorage.getItem(scoutKey('scout_review_link')) || ''; } catch(e) {}
  var reviewSkip = false;
  try { reviewSkip = localStorage.getItem(scoutKey('scout_review_skip')) === 'true'; } catch(e) {}

  store.people.forEach(function(p) {
    /* Review ask: joined leads, not yet asked.
       Shows every day from wonAt day 0 through day 7, then stops.
       Skipped entirely if user has set scout_review_skip. */
    if (p.status === 'joined') {
      if (!reviewSkip && !p.reviewAskedAt && p.wonAt) {
        var dw = pipelineDaysSince(p.wonAt);
        if (dw <= 7) {
          var dn = pipelineDisplayName(p);
          var msg = templateMsg('review', lang, { name: dn.first, business: bizName, link: reviewLink });
          out.push({
            person: p, urgency: dw === 0 ? 2 : 1, isReview: true,
            reason: 'Ask ' + dn.first + ' for a Google review',
            msg: msg
          });
        }
      }
      return;
    }
    if (p.status === 'not_interested') return;

    var d = pipelineDaysSince(p.lastStatusAt || p.lastContactedAt);
    var dn = pipelineDisplayName(p);
    var greet = pipelineGreeting(p, lang);
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
    } else if (p.status === 'trial_booked' && bucket === 'trade') {
      /* Trade bucket: quote follow-ups at 3, 7, 15 days */
      if (d >= 15) {
        item = { reason: 'Quote sent ' + d + ' days ago', urgency: 2,
                 msg: templateMsg('quote_15', lang, { name: dn.first, business: bizName, link: '' }) };
      } else if (d >= 7) {
        item = { reason: 'Quote sent ' + d + ' days ago', urgency: 2,
                 msg: templateMsg('quote_7', lang, { name: dn.first, business: bizName, link: '' }) };
      } else if (d >= 3) {
        item = { reason: 'Quote sent ' + d + ' days ago', urgency: 1,
                 msg: templateMsg('quote_3', lang, { name: dn.first, business: bizName, link: '' }) };
      }
    } else if (p.status === 'trial_booked' && d >= 1) {
      item = { reason: stageLabel('trial_booked') + ' was ' + d + ' day(s) ago \u2014 did they show?', urgency: 3,
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
