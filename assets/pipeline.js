// ═══════════════════════════════════════════════════════════════
// G7 SCOUT — PIPELINE DATA LAYER
// File: assets/pipeline.js   v25
//
// Manages the named-contact pipeline. Customers live in D1 on
// the server; localStorage holds a cache for instant rendering.
//
// Load this file AFTER scout.js and BEFORE any Scout page that
// needs pipeline data.
//
// Storage key: 'scout_pipeline' (localStorage cache — also synced
//   in scout_state KV blob for prod safety; skipped from delta
//   saves when D1 is active via scout_d1_on flag).
//
// Shape: { people: [...] }
// Anonymous contacts live in separate key: 'scout_pipeline_anon'
//
// People statuses (= D1 "stage" column):
//   found | contacted | replied | trial_booked | joined |
//   gone_quiet | not_interested
//
// 'found'     — added by Customer Finder; user has NOT sent a
//               message yet. Skipped by chase rules.
//
// Optional fields (absent on older entries — readers tolerate undefined):
//   address  — street address (string, may be '')
//   website  — business website (string, may be '')
//   source   — 'manual' (hand-added) or 'places' (Customer Finder)
// ═══════════════════════════════════════════════════════════════

'use strict';

/* ---------- Firm-scoped storage keys ---------- */
/* scoutKey() is defined in scout.js which is always loaded before
   pipeline.js. No redefinition needed here. */

/* ---------- Pipeline store (Scout) ---------- */

function pipelineKey() { return scoutKey('scout_pipeline'); }
function pipelineAnonKey() { return scoutKey('scout_pipeline_anon'); }

/* Read the whole pipeline from localStorage. Never throws. */
function pipelineLoad() {
  try {
    var raw = localStorage.getItem(pipelineKey());
    if (!raw) return { people: [] };
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return { people: [] };
    if (!Array.isArray(p.people)) p.people = [];
    // Migrate: strip anonymousContacts from main store (moved to separate key)
    if (Array.isArray(p.anonymousContacts) && p.anonymousContacts.length > 0) {
      _migrateAnonContacts(p.anonymousContacts);
      delete p.anonymousContacts;
      try { localStorage.setItem(pipelineKey(), JSON.stringify(p)); } catch (e) {}
    }
    return p;
  } catch (e) {
    console.error('pipelineLoad failed:', e);
    return { people: [] };
  }
}

/* ── Anonymous contacts — separate key, synced via scout_state ── */

function _migrateAnonContacts(arr) {
  try {
    var existing = _loadAnon();
    for (var i = 0; i < arr.length; i++) existing.push(arr[i]);
    localStorage.setItem(pipelineAnonKey(), JSON.stringify(existing));
  } catch (e) {}
}

function _loadAnon() {
  try {
    var raw = localStorage.getItem(pipelineAnonKey());
    if (!raw) return [];
    var a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

function _saveAnon(arr) {
  try { localStorage.setItem(pipelineAnonKey(), JSON.stringify(arr)); } catch (e) {}
}

/* ── Per-person hash-based dirty tracking (like scout.js delta saves) ── */
var _pipelineHashes = {};   // id → djb2 hash after last successful sync
var _pipelineDirty = {};    // id → true for customers that need syncing
var _pipelineDeleteQueue = {};  // id → true for customers pending server delete
var _pipelineSaveTimer = null;
var _pipelineSyncCursor = '';   // server's synced_at from last load

// Persist dirty/delete queues to localStorage so they survive page close
function _persistDirtyState() {
  try {
    var dk = scoutKey('_pipeline_dirty');
    var dqk = scoutKey('_pipeline_delq');
    var dirtyIds = Object.keys(_pipelineDirty);
    var delIds = Object.keys(_pipelineDeleteQueue);
    if (dirtyIds.length > 0) localStorage.setItem(dk, JSON.stringify(dirtyIds));
    else localStorage.removeItem(dk);
    if (delIds.length > 0) localStorage.setItem(dqk, JSON.stringify(delIds));
    else localStorage.removeItem(dqk);
  } catch (e) {}
}

// Restore dirty/delete queues from localStorage on page load
function _restoreDirtyState() {
  try {
    var dk = scoutKey('_pipeline_dirty');
    var dqk = scoutKey('_pipeline_delq');
    var raw = localStorage.getItem(dk);
    if (raw) { var arr = JSON.parse(raw); for (var i = 0; i < arr.length; i++) _pipelineDirty[arr[i]] = true; }
    var rawDel = localStorage.getItem(dqk);
    if (rawDel) { var arr2 = JSON.parse(rawDel); for (var j = 0; j < arr2.length; j++) _pipelineDeleteQueue[arr2[j]] = true; }
  } catch (e) {}
}

// Restore on load; if there are pending items, schedule a sync
_restoreDirtyState();
if (Object.keys(_pipelineDirty).length > 0 || Object.keys(_pipelineDeleteQueue).length > 0) {
  pipelineScheduleSync();
}

// djb2 hash — same as _scoutHash in scout.js
function _pipelineHash(s) {
  if (s == null) return 0;
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}

// Compute hash for a person object (stable: sort keys)
function _personHash(p) {
  if (!p) return 0;
  try {
    var keys = Object.keys(p).sort();
    var obj = {};
    for (var i = 0; i < keys.length; i++) obj[keys[i]] = p[keys[i]];
    return _pipelineHash(JSON.stringify(obj));
  } catch (e) { return 0; }
}

// Detect which people changed since last hash snapshot
function _detectDirtyPeople(store) {
  if (!store || !Array.isArray(store.people)) return;
  for (var i = 0; i < store.people.length; i++) {
    var p = store.people[i];
    if (!p || !p.id) continue;
    var h = _personHash(p);
    if (h !== _pipelineHashes[p.id]) {
      _pipelineDirty[p.id] = true;
    }
  }
}

// Snapshot hashes for all people after successful sync
function _snapshotPipelineHashes(store) {
  if (!store || !Array.isArray(store.people)) return;
  _pipelineHashes = {};
  for (var i = 0; i < store.people.length; i++) {
    var p = store.people[i];
    if (p && p.id) _pipelineHashes[p.id] = _personHash(p);
  }
}

/* Write the whole pipeline to localStorage. Auto-detects dirty people. */
function pipelineSave(store, changedIds) {
  try {
    if (!store || !Array.isArray(store.people)) return false;
    localStorage.setItem(pipelineKey(), JSON.stringify(store));

    // If caller passes explicit changedIds, mark those dirty
    if (Array.isArray(changedIds) && changedIds.length > 0) {
      for (var i = 0; i < changedIds.length; i++) _pipelineDirty[changedIds[i]] = true;
    } else {
      // Auto-detect via hash comparison
      _detectDirtyPeople(store);
    }

    // Schedule D1 sync if anything is dirty
    if (Object.keys(_pipelineDirty).length > 0 || Object.keys(_pipelineDeleteQueue).length > 0) {
      _persistDirtyState();
      pipelineScheduleSync();
    }
    return true;
  } catch (e) {
    console.error('pipelineSave failed:', e);
    return false;
  }
}

/* 4s trailing debounce for D1 sync, with page-hide flush */
function pipelineScheduleSync() {
  clearTimeout(_pipelineSaveTimer);
  _pipelineSaveTimer = setTimeout(function() {
    _pipelineSyncToServer();
  }, 4000);
}

/* Flush pending sync immediately (page hide / close).
   Clears only the IDs that were actually sent, not all dirty. */
function _pipelineFlushSync() {
  clearTimeout(_pipelineSaveTimer);
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return;

    // Send upserts
    var rows = _buildDirtyRows();
    var sentIds = Object.keys(_pipelineDirty);

    // Send deletes
    var deleteIds = Object.keys(_pipelineDeleteQueue);

    if (rows.length === 0 && deleteIds.length === 0) return;

    if (rows.length > 0) {
      var body = JSON.stringify({ customers: rows });
      var useKeepalive = body.length < 63000;
      fetch(G7_WORKER_URL + '/scout/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: body,
        keepalive: useKeepalive
      }).then(function(r) {
        if (r && r.ok) {
          // Clear only the IDs we actually sent
          for (var i = 0; i < sentIds.length; i++) delete _pipelineDirty[sentIds[i]];
          // Snapshot hashes for sent people
          var store = pipelineLoad();
          for (var j = 0; j < store.people.length; j++) {
            var p = store.people[j];
            if (p && sentIds.indexOf(p.id) !== -1) _pipelineHashes[p.id] = _personHash(p);
          }
        }
      }).catch(function() {});
    }

    if (deleteIds.length > 0) {
      var delBody = JSON.stringify({ ids: deleteIds });
      var delKeepalive = delBody.length < 63000;
      fetch(G7_WORKER_URL + '/scout/customers/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: delBody,
        keepalive: delKeepalive
      }).then(function(r) {
        if (r && r.ok) {
          for (var i = 0; i < deleteIds.length; i++) delete _pipelineDeleteQueue[deleteIds[i]];
        }
      }).catch(function() {});
    }
  } catch (e) {}
}

// Wire up page-hide flush
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') _pipelineFlushSync();
  });
  window.addEventListener('pagehide', function() { _pipelineFlushSync(); });
}

/* Build rows for dirty customers from the localStorage store */
function _buildDirtyRows() {
  var store = pipelineLoad();
  var dirtyIds = Object.keys(_pipelineDirty);
  if (dirtyIds.length === 0) return [];
  var rows = [];
  for (var i = 0; i < store.people.length; i++) {
    var p = store.people[i];
    if (!_pipelineDirty[p.id]) continue;
    rows.push(_personToRow(p));
  }
  return rows;
}

/* Convert a pipeline person object to a D1 row shape */
function _personToRow(p) {
  var TOP_COLS = { id:1, name:1, phone:1, kind:1, status:1, source:1, value:1,
                   next_action_at:1, created_at:1, updated_at:1, deleted_at:1 };
  var data = {};
  for (var k in p) { if (p.hasOwnProperty(k) && !TOP_COLS[k]) data[k] = p[k]; }
  return {
    id: p.id,
    name: p.name || '',
    phone: p.phone || '',
    kind: p.kind || '',
    stage: p.status || 'contacted',
    source: p.source || 'manual',
    value: p.value || 0,
    next_action_at: p.next_action_at || null,
    data: JSON.stringify(data),
    // updatedAt is bumped on every local change; used for conflict resolution
    updated_at: p.updatedAt || new Date().toISOString()
  };
}

/* Async sync dirty customers to the server.
   Only clears the IDs that were actually sent (not all dirty). */
async function _pipelineSyncToServer() {
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return;

    // Capture the dirty IDs we're about to send
    var sentIds = Object.keys(_pipelineDirty);
    var rows = _buildDirtyRows();
    var deleteIds = Object.keys(_pipelineDeleteQueue);

    // Send upserts
    if (rows.length > 0) {
      var res = await fetch(G7_WORKER_URL + '/scout/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ customers: rows })
      });
      if (res.ok) {
        // Clear only the IDs we sent
        for (var i = 0; i < sentIds.length; i++) delete _pipelineDirty[sentIds[i]];
        // Update hashes for synced people
        var store = pipelineLoad();
        for (var j = 0; j < store.people.length; j++) {
          var p = store.people[j];
          if (p && sentIds.indexOf(p.id) !== -1) _pipelineHashes[p.id] = _personHash(p);
        }
      }
    }

    // Send deletes
    if (deleteIds.length > 0) {
      var delRes = await fetch(G7_WORKER_URL + '/scout/customers/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ ids: deleteIds })
      });
      if (delRes.ok) {
        for (var d = 0; d < deleteIds.length; d++) delete _pipelineDeleteQueue[deleteIds[d]];
      }
    }

    // Persist updated dirty state
    _persistDirtyState();

    // If there are still dirty items (added while we were syncing), reschedule
    if (Object.keys(_pipelineDirty).length > 0 || Object.keys(_pipelineDeleteQueue).length > 0) {
      pipelineScheduleSync();
    }
  } catch (e) {
    console.warn('Pipeline sync failed (non-blocking):', e);
  }
}

/* ── Server load: fetch from D1 API, merge into localStorage ── */

async function pipelineLoadFromServer() {
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return false;
    var url = G7_WORKER_URL + '/scout/customers';
    if (_pipelineSyncCursor) url += '?since=' + encodeURIComponent(_pipelineSyncCursor);
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.status === 501) return false;  // D1 not available (prod)
    if (!res.ok) return false;
    var json = await res.json();
    var serverRows = json.customers || [];
    var serverTime = json.serverTime || '';

    // D1 is available — set flag so delta saves skip scout_pipeline
    try { localStorage.setItem(scoutKey('scout_d1_on'), '1'); } catch (e) {}

    if (serverRows.length === 0 && _pipelineSyncCursor) return true;  // no changes

    var store = pipelineLoad();

    if (_pipelineSyncCursor) {
      // Incremental: merge server rows into local, keeping unsynced local changes
      var byId = {};
      for (var i = 0; i < store.people.length; i++) {
        byId[store.people[i].id] = i;
      }
      for (var j = 0; j < serverRows.length; j++) {
        var row = serverRows[j];
        var person = _rowToPerson(row);
        if (row.deleted_at) {
          // Remove from local store unless locally dirty (unsynced change)
          if (byId[row.id] !== undefined && !_pipelineDirty[row.id]) {
            store.people.splice(byId[row.id], 1);
            // Rebuild index after splice
            byId = {};
            for (var r = 0; r < store.people.length; r++) byId[store.people[r].id] = r;
          }
        } else if (byId[row.id] !== undefined) {
          // Update existing — but only if not locally dirty
          if (!_pipelineDirty[row.id]) {
            store.people[byId[row.id]] = person;
          }
        } else {
          // New from server
          store.people.push(person);
          byId[person.id] = store.people.length - 1;
        }
      }
    } else {
      // Full load: replace local list, but keep any unsynced local changes
      var dirtyPeople = {};
      for (var d = 0; d < store.people.length; d++) {
        if (_pipelineDirty[store.people[d].id]) {
          dirtyPeople[store.people[d].id] = store.people[d];
        }
      }
      // Build new list from server
      var newPeople = [];
      var seenIds = {};
      for (var s = 0; s < serverRows.length; s++) {
        var sRow = serverRows[s];
        if (sRow.deleted_at) continue;  // skip deleted
        var sPerson = _rowToPerson(sRow);
        // Skip people pending local deletion
        if (_pipelineDeleteQueue[sPerson.id]) continue;
        // If locally dirty, keep local version
        if (dirtyPeople[sPerson.id]) {
          newPeople.push(dirtyPeople[sPerson.id]);
        } else {
          newPeople.push(sPerson);
        }
        seenIds[sPerson.id] = true;
      }
      // Add any dirty people not on server yet
      for (var dk in dirtyPeople) {
        if (!seenIds[dk]) newPeople.push(dirtyPeople[dk]);
      }
      store.people = newPeople;
    }

    localStorage.setItem(pipelineKey(), JSON.stringify(store));
    // Use server time for cursor (not browser clock)
    if (serverTime) _pipelineSyncCursor = serverTime;
    // Snapshot hashes for non-dirty people
    _snapshotPipelineHashes(store);
    return true;
  } catch (e) {
    console.warn('pipelineLoadFromServer failed (non-blocking):', e);
    return false;
  }
}

/* Convert a D1 row back to a pipeline person object.
   The data JSON column is the source of truth for non-top-level fields
   like lastStatusAt, lastContactedAt, history, etc. We do NOT overwrite
   them from D1 columns — those columns are for queries only. */
function _rowToPerson(row) {
  var person = {};
  try { person = JSON.parse(row.data || '{}'); } catch (e) {}
  person.id = row.id;
  person.name = row.name || '';
  person.phone = row.phone || '';
  person.kind = row.kind || '';
  person.status = row.stage || 'contacted';
  person.source = row.source || 'manual';
  person.value = row.value || 0;
  person.next_action_at = row.next_action_at || null;
  // lastStatusAt and lastContactedAt live in data JSON — do NOT overwrite from columns
  if (!person.history) person.history = [];
  if (!Array.isArray(person.messagesSent)) person.messagesSent = [];
  return person;
}

/* Clear all pipeline in-memory and localStorage state (called on logout) */
function pipelineClearState() {
  _pipelineHashes = {};
  _pipelineDirty = {};
  _pipelineDeleteQueue = {};
  _pipelineSyncCursor = '';
  clearTimeout(_pipelineSaveTimer);
  _persistDirtyState();  // clears persisted dirty/delete keys
}

/* ---------- CRUD helpers (same API as before) ---------- */

/* Add a named person. Returns the new person object, or an existing one
   on duplicate.
   Dedupe rules:
   1. Strict: same normalised name AND same non-empty phone → exact dup
   2. Soft: same normalised name, phone not matched → re-message */
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
      if (p.name && p.name.toLowerCase() === clean.toLowerCase() && p.phone === cleanPhone) {
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
    existing.updatedAt = now;
    if (opts.messageId && existing.messagesSent.indexOf(opts.messageId) === -1) {
      existing.messagesSent.push(opts.messageId);
    }
    existing.history.push({ week: opts.week || 0, event: 'contacted', at: now });
    pipelineSave(store, [existing.id]);
    return existing;
  }

  /* ── New person ── */
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
    updatedAt: now,
    messagesSent: opts.messageId ? [opts.messageId] : [],
    note: opts.note || '',
    address: opts.address || '',
    website: opts.website || '',
    source: opts.source || 'manual',
    kind: opts.kind || '',
    history: [{ week: opts.week || 0, event: initialStatus, at: now }]
  };
  store.people.push(person);
  pipelineSave(store, [person.id]);
  return person;
}

/* Record a contact where the user skipped naming the person.
   Stored in separate key scout_pipeline_anon, synced via scout_state. */
function pipelineAddAnonymous(icp, week) {
  var arr = _loadAnon();
  var found = null;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].week === week && arr[i].icp === icp) {
      found = arr[i];
      break;
    }
  }
  if (found) { found.count += 1; }
  else { arr.push({ week: week || 0, icp: icp || '', count: 1 }); }
  _saveAnon(arr);
  return true;
}

/* Update a person's status. */
function pipelineSetStatus(personId, status, week, note) {
  var VALID = ['found','contacted','replied','trial_booked','joined','gone_quiet','not_interested'];
  if (VALID.indexOf(status) === -1) return false;
  var store = pipelineLoad();
  for (var i = 0; i < store.people.length; i++) {
    if (store.people[i].id === personId) {
      var now = new Date().toISOString();
      store.people[i].status = status;
      store.people[i].lastStatusAt = now;
      store.people[i].updatedAt = now;
      if (status === 'joined') store.people[i].wonAt = now;
      if (note) store.people[i].note = note;
      store.people[i].history.push({ week: week || 0, event: status, at: now });
      return pipelineSave(store, [personId]);
    }
  }
  return false;
}

/* Aggregate counts per ICP for a given week. */
function pipelineWeekStats(week) {
  var store = pipelineLoad();
  var anonArr = _loadAnon();
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
  anonArr.forEach(function(a) {
    if (a.week === week) bucket(a.icp || 'Unknown').contacted += a.count;
  });
  return stats;
}

/* ---------- Business vs person detection ---------- */
var _bizWordRe = /\b(enterprises|traders|architects|associates|interiors|pvt|ltd|llp|group|solutions|services|studio|builders)\b|& co\b|co\./i;

function pipelineInferKind(person) {
  if (person.kind === 'business' || person.kind === 'person') return person.kind;
  if (person.source === 'places') return 'business';
  var name = String(person.name || '');
  var words = name.trim().split(/\s+/);
  if (words.length >= 3) return 'business';
  if (_bizWordRe.test(name)) return 'business';
  return 'person';
}

function pipelineDisplayName(person) {
  var kind = pipelineInferKind(person);
  var full = String(person.name || '').trim() || 'there';
  if (kind === 'business') return { first: full, full: full, kind: 'business' };
  var firstWord = full.split(' ')[0] || full;
  return { first: firstWord, full: full, kind: 'person' };
}

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

var _cachedMsgLang = null;
function pipelineMsgLang() {
  if (_cachedMsgLang) return _cachedMsgLang;
  try {
    var raw = localStorage.getItem(scoutKey('scout_pending_result'));
    if (raw) {
      var d = JSON.parse(raw);
      var lang = (d && d.businessData && d.businessData.language) || 'Hinglish';
      if (/^Regional/i.test(lang)) lang = 'Hinglish';
      if (/hindi/i.test(lang) && !/hinglish/i.test(lang)) _cachedMsgLang = 'Hindi';
      else if (/english/i.test(lang)) _cachedMsgLang = 'English';
      else _cachedMsgLang = 'Hinglish';
      return _cachedMsgLang;
    }
  } catch (e) {}
  return 'Hinglish';
}

function pipelineFetchMsgLang() {
  try {
    var token = localStorage.getItem('g7_session_token') || '';
    if (!token) return;
    fetch(G7_WORKER_URL + '/scout/message-lang', {
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

function pipelineDaysSince(iso) {
  if (!iso) return 999;
  var then = new Date(iso).getTime();
  if (isNaN(then)) return 999;
  return Math.floor((Date.now() - then) / 86400000);
}

function pipelineBusinessName() {
  try {
    var raw = localStorage.getItem(scoutKey('scout_pending_result'));
    if (!raw) return '';
    var d = JSON.parse(raw);
    return (d && d.businessData && d.businessData.businessName) || '';
  } catch (e) { return ''; }
}

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

function pipelineAll() {
  var order = { found: -1, replied: 0, trial_booked: 1, contacted: 2, gone_quiet: 3, joined: 4, not_interested: 5 };
  var store = pipelineLoad();
  return store.people.slice().sort(function(a, b) {
    return (order[a.status] || 9) - (order[b.status] || 9);
  });
}

function waPhone(raw) {
  var d = String(raw || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.indexOf('91') === 0 && d.length === 12) return d;
  if (d.indexOf('0') === 0) d = d.slice(1);
  if (d.length === 10) return '91' + d;
  return d;
}

/* Soft delete a customer: remove from localStorage, queue server deletion with retry */
function pipelineDeletePerson(personId) {
  var store = pipelineLoad();
  var found = false;
  store.people = store.people.filter(function(p) {
    if (p.id === personId) { found = true; return false; }
    return true;
  });
  if (!found) return false;
  localStorage.setItem(pipelineKey(), JSON.stringify(store));
  // Remove from dirty (no point syncing a deleted person) and queue delete
  delete _pipelineDirty[personId];
  delete _pipelineHashes[personId];
  _pipelineDeleteQueue[personId] = true;
  _persistDirtyState();
  // Schedule sync so deletes get sent with retry logic
  pipelineScheduleSync();
  return true;
}
