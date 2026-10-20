#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/news-test.mjs — News pipeline integration test
// Runs against the REAL Anthropic API with a fake in-memory KV.
// Usage: ANTHROPIC_API_KEY=sk-... node scripts/news-test.mjs
// ─────────────────────────────────────────────────────────────────────────────

import {
  newCostAccum, buildDailyNews, getWatchlist,
  TRUSTED_NEWS_DOMAINS, COST_TABLE, NEWS_CATS
} from '../cloudflare-worker.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

const MAX_RUNS = 5;
const SPEND_CAP = 1.50;  // USD total across all runs

// IST today
const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
const DAY = ist.toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// FAKE KV — in-memory Map that mimics env.G7_KV
// ─────────────────────────────────────────────────────────────────────────────
function createFakeKV() {
  const store = new Map();
  return {
    async get(key, fmt) {
      const v = store.get(key);
      if (v === undefined) return null;
      if (fmt === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value, _opts) { store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
    async delete(key) { store.delete(key); },
    async list(opts) {
      const prefix = (opts && opts.prefix) || '';
      const keys = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys, list_complete: true };
    },
    _store: store
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FAKE ENV
// ─────────────────────────────────────────────────────────────────────────────
function createEnv() {
  return {
    ANTHROPIC_API_KEY: API_KEY,
    G7_KV: createFakeKV(),
    COST_CAP_FIRM: '5.00',       // high caps so tests don't hit them
    COST_CAP_FIRM_FREE: '5.00',
    COST_CAP_SHARED: '5.00',
    ADMIN_EMAIL: null,
    RESEND_API_KEY: null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST FIRMS
// ─────────────────────────────────────────────────────────────────────────────
const FIRMS = [
  {
    code: 'SHARMA01',
    city: 'Lucknow',
    prefs: ['india_policy', 'city'],
    context: [
      'BUSINESS: Sharma Interiors | Modular Kitchen & Interior Design | Gomti Nagar, Lucknow',
      'SELLS: Modular kitchens, wardrobes, false ceilings, TV units, office interiors. B2C residential + B2B commercial fit-outs.',
      'TYPICAL SALE: ₹2.5 lakh residential, ₹8 lakh commercial',
      'REVENUE MODEL: Project-based — material + labour + design fee',
      'CURRENT CUSTOMERS: 40 completed projects this year',
      'BEST EXISTING CUSTOMERS: NRI families renovating Lucknow homes, new flat buyers in Gomti Nagar, dentist & salon owners fitting out clinics',
      'BEST MONTHS: October–March (post-monsoon, wedding season, Diwali)',
      'WORST MONTHS: July–August (monsoon slows construction)',
      'LOCAL EVENTS: Lucknow Development Authority new housing schemes, Gomti Nagar Extension launches, IT City Lucknow hiring wave',
      'WHAT HAS WORKED: Google Ads for "modular kitchen Lucknow", referrals from architects, Instagram reels of completed kitchens',
      'WHAT HAS FAILED: Newspaper ads, cold calling builders',
      'COMPETITORS: Livspace Lucknow, HomeLane, local carpenters',
      'CUSTOMER GROUPS: New flat buyers, NRI renovators, clinic/salon owners, small office fit-outs'
    ].join('\n')
  },
  {
    code: 'GYMFIT01',
    city: 'Bengaluru',
    prefs: ['india_policy', 'city'],
    context: [
      'BUSINESS: Iron Republic Gym | Fitness Centre | Indiranagar, Bengaluru',
      'SELLS: Monthly/annual gym memberships, personal training sessions, group fitness classes (Zumba, yoga, HIIT), diet consulting.',
      'TYPICAL SALE: ₹3,000/month membership, ₹15,000/month with PT',
      'REVENUE MODEL: Recurring memberships + personal training packages',
      'CURRENT CUSTOMERS: 280 active members',
      'BEST EXISTING CUSTOMERS: IT professionals 25–40 in Indiranagar/Domlur/Koramangala, young couples, startup founders who want premium experience',
      'BEST MONTHS: January (New Year resolutions), June (summer body), September–October (post-monsoon)',
      'WORST MONTHS: April–May (summer travel), December (holidays)',
      'LOCAL EVENTS: Bengaluru Marathon, corporate wellness drives by tech companies, new residential towers in Indiranagar',
      'WHAT HAS WORKED: Instagram transformation reels, Google Maps reviews, referral discounts, corporate tie-ups with nearby IT parks',
      'WHAT HAS FAILED: Flyers, newspaper classifieds, Groupon-style discount apps',
      'COMPETITORS: Cult.fit Indiranagar, Gold\'s Gym Domlur, F45 Koramangala, neighbourhood CrossFit boxes',
      'CUSTOMER GROUPS: IT professionals, young couples, startup founders, women-only morning batch'
    ].join('\n')
  },
  {
    code: 'CAFIRM01',
    city: 'Bareilly',
    prefs: ['india_policy', 'india_markets'],
    context: [
      'BUSINESS: Agarwal & Associates | Chartered Accountant Firm | Civil Lines, Bareilly',
      'SELLS: GST filing, income tax returns, audit & assurance, company incorporation, bookkeeping, TDS compliance, MSME registration.',
      'TYPICAL SALE: ₹5,000 ITR filing, ₹25,000/year GST retainer, ₹1,50,000 statutory audit',
      'REVENUE MODEL: Retainer fees (monthly/annual) + one-time project fees',
      'CURRENT CUSTOMERS: 120 business clients + 300 individual ITR clients',
      'BEST EXISTING CUSTOMERS: Small manufacturers in Bareilly (textile, furniture), retail shop owners in CBD, salaried professionals, NRIs needing India tax compliance',
      'BEST MONTHS: July–September (ITR season), March (year-end compliance rush), January (advance tax)',
      'WORST MONTHS: April–May (post-filing lull)',
      'LOCAL EVENTS: MSME cluster growth in Bareilly (furniture/zari work), UP government ease-of-business drives, GST rate revision announcements',
      'WHAT HAS WORKED: Referrals from existing clients, WhatsApp broadcasts during filing deadlines, Google search ads for "CA in Bareilly"',
      'WHAT HAS FAILED: Social media reels, local newspaper ads, attending trade fairs',
      'COMPETITORS: H&R Block online, ClearTax, local CA firms (3–4 established ones in Civil Lines)',
      'CUSTOMER GROUPS: Small manufacturers, retail shop owners, salaried professionals, NRI tax filers'
    ].join('\n')
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// PASS CHECKS
// ─────────────────────────────────────────────────────────────────────────────
const TRUSTED_SET = new Set(TRUSTED_NEWS_DOMAINS);

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function isTrustedDomain(url) {
  const h = hostname(url).toLowerCase();
  for (const d of TRUSTED_SET) {
    if (h === d || h.endsWith('.' + d)) return true;
  }
  return false;
}

const _citeRe = /<\/?cite[^>]*>|\(cite\s+index=[^>]*>|index="\d+(?:-\d+)?"/gi;
function hasCitationMarkup(text) {
  return _citeRe.test(text || '');
}

function runChecks(firm, news, log, cost) {
  const fails = [];
  const items = (news.business && news.business.items) || [];
  const businessItems = items.filter(i => !i._placeholder && !i._fromDay);

  // Check 1: ≥2 business items
  if (businessItems.length < 2) {
    fails.push(`ITEMS: only ${businessItems.length} business items (need ≥2)`);
  }

  for (const it of businessItems) {
    const tag = `"${(it.headline || '').slice(0, 50)}"`;

    // Check 2: URL from search + on trusted domain
    if (!it.sourceUrl) {
      fails.push(`URL_MISSING: ${tag} has no sourceUrl`);
    } else if (!isTrustedDomain(it.sourceUrl)) {
      fails.push(`DOMAIN: ${tag} → ${hostname(it.sourceUrl)} not in trusted list`);
    }

    // Check 3: not a listing/guide (heuristic — check title words)
    const title = (it.sourceTitle || it.headline || '').toLowerCase();
    if (/\bhow to\b|\bguide\b|\bexplained\b|\bchecklist\b/.test(title)) {
      fails.push(`GUIDE: ${tag} looks like a guide/explainer`);
    }

    // Check 4: citation markup
    const allText = [it.headline, it.whatHappened, it.whyItMatters, it.whatToDo, it.why].join(' ');
    _citeRe.lastIndex = 0;
    if (hasCitationMarkup(allText)) {
      fails.push(`CITATION: ${tag} contains citation markup`);
    }
  }

  // Check 5: no duplicate topics (≥3 shared meaningful words)
  const _stop = new Set(['the','a','an','in','on','at','of','for','to','is','are','and','or','by','with','from','that','this','has','it','as','be','not','will','can','may','up','new','said','over','after','into','about']);
  function headlineWords(h) {
    return (h || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(w => w.length > 1 && !_stop.has(w));
  }
  for (let i = 0; i < businessItems.length; i++) {
    for (let j = i + 1; j < businessItems.length; j++) {
      const wI = headlineWords(businessItems[i].headline);
      const setJ = new Set(headlineWords(businessItems[j].headline));
      const shared = wI.filter(w => setJ.has(w));
      if (shared.length >= 3) {
        fails.push(`DUPE: items ${i} and ${j} share ≥3 words: [${shared.join(', ')}]`);
      }
    }
  }

  // Check 6: cost per firm ≤ $0.08
  if (cost.usd > 0.08) {
    fails.push(`COST: $${cost.usd.toFixed(4)} exceeds $0.08 cap`);
  }

  // Check 7: locality/city in queries matches the firm
  if (log && log.queryStrings) {
    const cityLower = firm.city.toLowerCase();
    const queriesJoined = log.queryStrings.join(' ').toLowerCase();
    // At least one query should reference the city or a locality from the watchlist
    if (queriesJoined.indexOf(cityLower) === -1) {
      // Check if any watchlist locality is in the queries
      const locs = (log.watchlist && log.watchlist.localities) || [];
      const hasLoc = locs.some(l => queriesJoined.indexOf(l.toLowerCase()) !== -1);
      if (!hasLoc) {
        fails.push(`LOCALITY: neither "${firm.city}" nor any watchlist locality appears in query strings`);
      }
    }
  }

  return fails;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRINTER
// ─────────────────────────────────────────────────────────────────────────────
function printFirmResult(firm, news, log, cost, checks) {
  console.log('\n' + '═'.repeat(70));
  console.log(`FIRM: ${firm.code} — ${firm.context.split('\n')[0].replace('BUSINESS: ', '')}`);
  console.log('═'.repeat(70));

  // Watchlist
  if (log && log.watchlist) {
    console.log('\n── WATCHLIST ──');
    for (const k of ['materials','triggers','localities','regulations','competitors','groups']) {
      const arr = log.watchlist[k] || [];
      console.log(`  ${k}: ${arr.length ? arr.join(', ') : '(none)'}`);
    }
  }

  // Query strings
  if (log && log.queryStrings) {
    console.log('\n── QUERY STRINGS ──');
    log.queryStrings.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
  }

  // Candidates (from catLog)
  if (log && log.catLog) {
    console.log('\n── CANDIDATES ──');
    log.catLog.forEach(c => console.log(`  ${c.cat}: ${c.raw} raw → ${c.vetted} vetted`));
    console.log(`  Total: ${log.candidatesRaw || 0} raw → ${log.candidatesVetted || 0} vetted`);
  }

  // Drops
  if (log && log.drops && log.drops.length) {
    console.log('\n── DROPS ──');
    log.drops.forEach(d => console.log(`  ✗ ${(d.headline || d.url || '?').slice(0, 80)} — ${d.reason}`));
  }

  // Final items
  const items = (news.business && news.business.items) || [];
  console.log(`\n── FINAL ITEMS (${items.length}) ──`);
  items.forEach((it, i) => {
    if (it._placeholder) {
      console.log(`  ${i + 1}. [placeholder] ${it.headline}`);
      return;
    }
    console.log(`  ${i + 1}. ${it.headline}`);
    if (it.sourceUrl) console.log(`     URL: ${it.sourceUrl}`);
    if (it.sourceTitle) console.log(`     Title: ${it.sourceTitle.slice(0, 100)}`);
    if (it.whyItMatters) console.log(`     Why: ${it.whyItMatters}`);
    if (it.whatToDo) console.log(`     Do: ${it.whatToDo}`);
    if (it._fromDay) console.log(`     (from ${it._fromDay})`);
  });

  // Also worth knowing
  if (news.sections && news.sections.length) {
    news.sections.forEach(s => {
      console.log(`\n── ${(s.label || s.category || '').toUpperCase()} (${(s.items || []).length}) ──`);
      (s.items || []).forEach((it, i) => {
        console.log(`  ${i + 1}. ${it.headline}${it._marketLine ? ' [market]' : ''}`);
        if (it.sourceUrl) console.log(`     URL: ${it.sourceUrl}`);
        if (it.why) console.log(`     Why: ${it.why}`);
      });
    });
  }

  // Cost
  console.log(`\n── COST ──`);
  console.log(`  Calls: ${cost.calls}, USD: $${cost.usd.toFixed(4)}, Web searches: ${cost.web_search_requests}`);
  console.log(`  Input tokens: ${cost.input_tokens}, Output tokens: ${cost.output_tokens}`);

  // Checks
  console.log(`\n── CHECKS ──`);
  if (checks.length === 0) {
    console.log('  ✓ ALL PASSED');
  } else {
    checks.forEach(f => console.log(`  ✗ FAIL: ${f}`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  let totalSpend = 0;
  let run = 0;

  while (run < MAX_RUNS && totalSpend < SPEND_CAP) {
    run++;
    console.log(`\n${'▓'.repeat(70)}`);
    console.log(`RUN ${run} / ${MAX_RUNS}  (total spend so far: $${totalSpend.toFixed(4)})`);
    console.log('▓'.repeat(70));

    let allPassed = true;
    let runSpend = 0;

    for (const firm of FIRMS) {
      const env = createEnv();
      const cost = newCostAccum();

      try {
        // Seed the KV with a fake user record so budgetCheck doesn't block
        await env.G7_KV.put('auth:users:' + firm.code, JSON.stringify({ plan: 'paid' }));

        const news = await buildDailyNews(env, firm.code, DAY, firm.context, firm.city, firm.prefs, cost);
        const log = news._log || null;
        delete news._log;

        const checks = runChecks(firm, news, log, cost);
        printFirmResult(firm, news, log, cost, checks);

        if (checks.length > 0) allPassed = false;
        runSpend += cost.usd;
      } catch (e) {
        console.error(`\n✗ ${firm.code} CRASHED: ${e.message}`);
        allPassed = false;
        runSpend += cost.usd;
      }
    }

    totalSpend += runSpend;
    console.log(`\n── RUN ${run} SUMMARY ──`);
    console.log(`  Run cost: $${runSpend.toFixed(4)}, Total: $${totalSpend.toFixed(4)}`);

    if (allPassed) {
      console.log('\n✓ ALL FIRMS PASSED — stopping.');
      break;
    }
    if (run < MAX_RUNS && totalSpend < SPEND_CAP) {
      console.log(`\n✗ Some checks failed. Will re-run (${MAX_RUNS - run} left, $${(SPEND_CAP - totalSpend).toFixed(2)} budget left).`);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`FINISHED: ${run} run(s), $${totalSpend.toFixed(4)} total spend`);
  console.log('═'.repeat(70));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
