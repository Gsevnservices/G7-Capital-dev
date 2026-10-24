#!/usr/bin/env node
/**
 * news-sample.mjs — Test Google News RSS feeds + Haiku picker for 3 sample firms.
 *
 * Usage:
 *   node scripts/news-sample.mjs
 *
 * If .env.local contains ANTHROPIC_API_KEY=sk-..., step 2 runs the real
 * Haiku picker and prints the final news layout + cost. Otherwise stops
 * after printing feed candidates.
 */

import { readFileSync } from 'fs';

/* ── Load API key from .env.local (if present) ── */
var ANTHROPIC_API_KEY = '';
try {
  var envText = readFileSync('.env.local', 'utf8');
  var m = envText.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)/m);
  if (m) ANTHROPIC_API_KEY = m[1].trim();
} catch (e) { /* no .env.local — that's fine */ }

/* ── Constants copied from the worker (no imports — runs standalone) ── */
var INDUSTRIES = {
  interior_design: {
    label: 'Interior design & architecture',
    feeds: ['plywood price India', 'modular kitchen India', 'home furnishing India',
            'housing sales India', 'building materials prices India']
  },
  health_wellness: {
    label: 'Health & wellness',
    feeds: ['fitness industry India', 'healthcare India', 'medical regulation India',
            'gym wellness India', 'health insurance India']
  },
  professional: {
    label: 'Professional services',
    feeds: ['income tax India', 'GST compliance India', 'legal regulation India',
            'consulting India', 'chartered accountant India']
  }
};

var FEED_CATS = {
  india_policy: { label: 'India — politics & policy',
    feeds: ['GST India', 'RBI policy India', 'India government business policy'], days: 2 },
  india_markets: { label: 'Indian stock market',
    feeds: ['Sensex Nifty'], days: 2 },
  city: { label: 'Your city', feeds: [], days: 7 }
};

var _guideTitleRe = /\bguide\b|\bhow to\b|\bexplained\b|\bwhat is\b|\beverything you need\b|\bchecklist\b|\brates list\b|\btips\b|\bbest \d/i;
var _civicRe = /\b(water supply|water cut|traffic|power cut|load.?shedding|crime|robbery|murder|theft|politics|political|weather|rain|flood|heat.?wave|cold.?wave|storm|cyclone)\b/i;

/* ── RSS fetch (same logic as worker) ── */
async function fetchNewsFeed(query, days) {
  var url = 'https://news.google.com/rss/search?q=' +
    encodeURIComponent(query + ' when:' + days + 'd') +
    '&hl=en-IN&gl=IN&ceid=IN:en';
  var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; G7Scout/1.0)' } });
  if (!r.ok) throw new Error('Google News RSS ' + r.status + ' for "' + query + '"');
  var xml = await r.text();
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
    _t = _t.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    _l = _l.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    _s = _s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    var _dashIdx = _t.lastIndexOf(' - ');
    if (_dashIdx > 20) {
      if (!_s) _s = _t.slice(_dashIdx + 3).trim();
      _t = _t.slice(0, _dashIdx).trim();
    }
    if (!_t || !_l) continue;
    if (_guideTitleRe.test(_t)) continue;
    var _norm = _t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(_norm)) continue;
    seen.add(_norm);
    items.push({ title: _t.slice(0, 150), link: _l, pubDate: _d ? new Date(_d).toISOString() : '', source: _s.slice(0, 80) });
  }
  return items;
}

/* ── Dedupe (same as worker) ── */
var _stopWords = new Set([
  'the','a','an','in','on','at','of','for','to','is','are','was','were','and','or',
  'but','by','with','from','that','this','its','has','had','it','as','be','not','no',
  'will','can','may','up','out','new','says','said','over','after','into','about',
  'than','been','would','could','should','also','just','more','most','very','all',
  'any','each','how','if','set','per','get','top','cut','now','yet','two','see'
]);
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
        var keepI = String(items[i].whatHappened || '').length >= String(items[j].whatHappened || '').length;
        dominated.add(keepI ? j : i);
      }
    }
  }
  return items.filter(function(_, idx) { return !dominated.has(idx); });
}

/* ── Fetch & merge feeds for an industry ── */
async function fetchIndustryFeeds(industryKey) {
  var def = INDUSTRIES[industryKey];
  var all = [];
  for (var fi = 0; fi < def.feeds.length; fi++) {
    try {
      var items = await fetchNewsFeed(def.feeds[fi], 7);
      all = all.concat(items);
    } catch (e) {
      console.log('  ⚠ Feed error: ' + def.feeds[fi] + ' — ' + e.message);
    }
  }
  var seen = new Set();
  var merged = [];
  var now = Date.now();
  all.forEach(function(it) {
    var norm = it.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(norm)) return;
    seen.add(norm);
    if (it.pubDate) {
      var age = now - new Date(it.pubDate).getTime();
      if (age > 7 * 86400000) return;
    }
    merged.push(it);
  });
  merged.sort(function(a, b) { return (b.pubDate || '').localeCompare(a.pubDate || ''); });
  var cleaned = merged.slice(0, 30).map(function(it) {
    return { headline: it.title, sourceUrl: it.link, sourceTitle: it.source, pubDate: it.pubDate };
  });
  cleaned = dedupeItems(cleaned);
  return cleaned.slice(0, 15);
}

/* ── Fetch category feeds ── */
async function fetchCategoryFeeds(cat, city) {
  var def = FEED_CATS[cat];
  if (!def) return [];
  var feedQueries = [];
  if (cat === 'city') {
    if (!city) return [];
    feedQueries = [city + ' development', city + ' real estate'];
  } else {
    feedQueries = def.feeds || [];
  }
  var all = [];
  for (var fi = 0; fi < feedQueries.length; fi++) {
    try {
      var items = await fetchNewsFeed(feedQueries[fi], def.days);
      all = all.concat(items);
    } catch (e) {
      console.log('  ⚠ Feed error: ' + feedQueries[fi] + ' — ' + e.message);
    }
  }
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
  merged.sort(function(a, b) { return (b.pubDate || '').localeCompare(a.pubDate || ''); });
  var cleaned = merged.slice(0, 20).map(function(it) {
    return { headline: it.title, sourceUrl: it.link, sourceTitle: it.source, pubDate: it.pubDate };
  });
  cleaned = dedupeItems(cleaned);
  return cleaned.slice(0, 10);
}

/* ── Print feed results ── */
function printFeed(label, items) {
  console.log('  ' + label + ': ' + items.length + ' candidates');
  items.slice(0, 5).forEach(function(it, i) {
    var age = it.pubDate ? timeSince(it.pubDate) : 'undated';
    console.log('    ' + (i + 1) + '. [' + age + '] ' + it.headline);
    console.log('       (' + (it.sourceTitle || 'unknown source') + ')');
  });
  if (items.length > 5) console.log('    ... and ' + (items.length - 5) + ' more');
}

function timeSince(iso) {
  var ms = Date.now() - new Date(iso).getTime();
  var h = Math.round(ms / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return h + 'h ago';
  var d = Math.round(h / 24);
  return d + 'd ago';
}

/* ── Haiku picker (standalone version — no KV, calls Anthropic directly) ── */
async function runPicker(context, industryCandidates, categoryCandidates) {
  var numbered = [];
  var indexMap = {};
  industryCandidates.forEach(function(it) {
    var idx = numbered.length;
    numbered.push({ idx: idx, headline: it.headline, source: it.sourceTitle || '' });
    indexMap[idx] = { source: 'industry', item: it };
  });
  Object.keys(categoryCandidates).forEach(function(cat) {
    (categoryCandidates[cat] || []).forEach(function(it) {
      var idx = numbered.length;
      numbered.push({ idx: idx, headline: it.headline, source: it.sourceTitle || '', category: cat });
      indexMap[idx] = { source: cat, item: it };
    });
  });
  if (!numbered.length) return { industry: [], also: [], markets: null };

  var system =
    'You pick the most useful news for one Indian small business.\n\n' +
    'RULES:\n' +
    '- Pick 3\u20134 items for "industry" (items 0\u2013' + (industryCandidates.length - 1) + ' are industry news).\n' +
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

  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
      system: system,
      messages: [{ role: 'user', content: 'BUSINESS:\n' + context.slice(0, 2500) +
        '\n\nCANDIDATES:\n' + JSON.stringify(numbered) }]
    })
  });

  var costInfo = { inputTokens: 0, outputTokens: 0 };
  var picks = { industry: [], also: [], markets: null };
  if (r.ok) {
    var d = await r.json();
    costInfo.inputTokens = (d.usage && d.usage.input_tokens) || 0;
    costInfo.outputTokens = (d.usage && d.usage.output_tokens) || 0;
    var t = (d.content || []).filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('');
    try {
      var a = t.indexOf('{'), z = t.lastIndexOf('}');
      if (a !== -1 && z > a) picks = JSON.parse(t.slice(a, z + 1));
    } catch (e) {
      console.log('  ⚠ JSON parse failed: ' + t.slice(0, 200));
    }
  } else {
    var errText = await r.text();
    throw new Error('Haiku picker ' + r.status + ': ' + errText.slice(0, 300));
  }

  /* Resolve picks to items. */
  var NO_EFFECT = 'No direct effect on your business.';
  function resolve(arr, maxCount) {
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function(p) {
      if (out.length >= maxCount) return;
      var idx = (typeof p === 'object' && p !== null) ? p.idx : p;
      if (typeof idx !== 'number' || !indexMap[idx]) return;
      var it = Object.assign({}, indexMap[idx].item);
      if (p.why) it.why = String(p.why);
      if (p.whatToDo) it.whatToDo = String(p.whatToDo);
      if (p.impact) it.impact = String(p.impact);
      if (p.why && p.why !== NO_EFFECT) it.whyItMatters = p.why;
      out.push(it);
    });
    return out;
  }

  var industryPicked = resolve(picks.industry, 4);
  var alsoPicked = resolve(picks.also, 3);
  /* Fallback: fill industry if <2. */
  if (industryPicked.length < 2 && industryCandidates.length > 0) {
    var pickedUrls = new Set(industryPicked.map(function(it){ return it.sourceUrl; }));
    for (var fi = 0; fi < industryCandidates.length && industryPicked.length < 2; fi++) {
      if (!pickedUrls.has(industryCandidates[fi].sourceUrl)) {
        industryPicked.push(Object.assign({}, industryCandidates[fi]));
      }
    }
  }
  /* Civic filter for also. */
  alsoPicked = alsoPicked.filter(function(it) { return !_civicRe.test(it.headline || ''); });

  /* Markets line. */
  var marketsItem = null;
  if (picks.markets && typeof picks.markets.idx === 'number' && indexMap[picks.markets.idx]) {
    marketsItem = Object.assign({}, indexMap[picks.markets.idx].item, { _marketLine: true });
  }

  return { industry: industryPicked, also: alsoPicked, markets: marketsItem, cost: costInfo };
}

/* ── Print final news layout (mimics email) ── */
function printNewsLayout(label, result) {
  var NO_EFFECT = 'No direct effect on your business.';
  console.log('');
  if (result.industry.length) {
    console.log('  ┌── YOUR INDUSTRY ──');
    result.industry.forEach(function(it) {
      console.log('  │ • ' + it.headline);
      var why = it.why || it.whyItMatters || '';
      if (why && why !== NO_EFFECT) console.log('  │   For you: ' + why);
      if (it.whatToDo) console.log('  │   Do this: ' + it.whatToDo);
      if (it.impact) console.log('  │   [' + it.impact + ']');
      console.log('  │   (' + (it.sourceTitle || '?') + ')');
    });
    console.log('  └──');
  }
  var alsoItems = (result.also || []).slice();
  /* Add markets line if present and not a dupe. */
  if (result.markets) {
    var mNorm = result.markets.headline.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(function(w){ return w.length > 3; });
    var isDupe = alsoItems.some(function(it) {
      var ah = (it.headline || '').toLowerCase();
      var shared = mNorm.filter(function(w){ return ah.indexOf(w) !== -1; }).length;
      return shared >= 3;
    });
    if (!isDupe) alsoItems.push(result.markets);
  }
  if (alsoItems.length) {
    console.log('  ┌── ALSO WORTH KNOWING ──');
    alsoItems.forEach(function(it) {
      console.log('  │ • ' + it.headline);
      if (it._marketLine) {
        console.log('  │   (' + (it.sourceTitle || '?') + ') [markets]');
      } else {
        var why = it.why || it.whyItMatters || '';
        if (why && why !== NO_EFFECT) console.log('  │   For you: ' + why);
        if (it.whatToDo) console.log('  │   Do this: ' + it.whatToDo);
        if (it.impact) console.log('  │   [' + it.impact + ']');
        console.log('  │   (' + (it.sourceTitle || '?') + ')');
      }
    });
    console.log('  └──');
  }
  if (result.cost) {
    var inCost = result.cost.inputTokens * 0.80 / 1000000;
    var outCost = result.cost.outputTokens * 4.00 / 1000000;
    console.log('  Cost: ' + result.cost.inputTokens + ' in / ' + result.cost.outputTokens + ' out → $' + (inCost + outCost).toFixed(5));
  }
}

/* ── 3 SAMPLE FIRMS ── */
var FIRMS = [
  {
    name: 'Sharma Interiors',
    industry: 'interior_design',
    city: 'Lucknow',
    prefs: ['india_policy', 'city'],
    context: 'BUSINESS: Sharma Interiors | Interior Design | Gomti Nagar, Lucknow\nSELLS: modular kitchens, wardrobes, false ceilings, complete interior fit-outs\nBEST EXISTING CUSTOMERS: new homeowners in Lucknow, builders doing sample flats\nCOMPETITORS: Livspace, local carpenters, HomeLane'
  },
  {
    name: 'FitZone Gym',
    industry: 'health_wellness',
    city: 'Bengaluru',
    prefs: ['india_policy', 'india_markets', 'city'],
    context: 'BUSINESS: FitZone Gym | Gym / Fitness Centre | Indiranagar, Bengaluru\nSELLS: gym memberships, personal training, group classes, nutrition plans\nBEST EXISTING CUSTOMERS: IT professionals aged 25-40 in Indiranagar\nCOMPETITORS: Cult.fit, Gold\'s Gym, local gyms'
  },
  {
    name: 'Gupta & Associates',
    industry: 'professional',
    city: 'Bareilly',
    prefs: ['india_policy', 'india_markets'],
    context: 'BUSINESS: Gupta & Associates | CA / Accounting Firm | Bareilly\nSELLS: tax filing, GST return filing, audit, company registration, financial planning\nBEST EXISTING CUSTOMERS: small manufacturers, retail shop owners, salaried professionals\nCOMPETITORS: other local CAs, ClearTax, Zoho Books'
  }
];

/* ── MAIN ── */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' G7 Scout — News Sample Test (' + new Date().toISOString().slice(0, 10) + ')');
  console.log('═══════════════════════════════════════════════════════════');

  for (var fi = 0; fi < FIRMS.length; fi++) {
    var firm = FIRMS[fi];
    console.log('\n━━━ ' + (fi + 1) + '. ' + firm.name + ' (' + firm.industry + ', ' + firm.city + ') ━━━');

    /* Step 1: Fetch feeds. */
    console.log('\n  ── Industry feeds: ' + INDUSTRIES[firm.industry].label + ' ──');
    var industryItems = await fetchIndustryFeeds(firm.industry);
    printFeed('Industry', industryItems);

    var catFeeds = {};
    for (var ci = 0; ci < firm.prefs.length; ci++) {
      var cat = firm.prefs[ci];
      var catLabel = (FEED_CATS[cat] && FEED_CATS[cat].label) || cat;
      console.log('\n  ── Category: ' + catLabel + ' ──');
      var catItems = await fetchCategoryFeeds(cat, firm.city);
      if (catItems.length) {
        catFeeds[cat] = catItems;
        printFeed(catLabel, catItems);
      } else {
        console.log('  ' + catLabel + ': 0 candidates');
      }
    }

    /* Step 2: Picker (if API key available). */
    if (!ANTHROPIC_API_KEY) continue;

    console.log('\n  ── Haiku picker ──');
    try {
      var result = await runPicker(firm.context, industryItems, catFeeds);
      printNewsLayout(firm.name, result);
    } catch (e) {
      console.log('  ✗ Picker error: ' + e.message);
    }
  }

  if (!ANTHROPIC_API_KEY) {
    console.log('\n\n⚠ No ANTHROPIC_API_KEY in .env.local — skipped Haiku picker (step 2).');
    console.log('  Create .env.local with ANTHROPIC_API_KEY=sk-... to run the full test.');
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Done.');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(function(e) {
  console.error('Fatal: ' + e.message);
  process.exit(1);
});
