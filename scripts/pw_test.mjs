import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const DEV = 'https://g7-proxy-dev.gsevnservices.workers.dev';
const LOCAL = 'http://localhost:8080';
const SHOT_DIR = path.join(process.env.HOME, 'Desktop', 'g7_shots');

// Load ADMIN_PASSWORD silently — never print it
const envLines = fs.readFileSync('.env.local', 'utf8').split('\n');
const env = {};
envLines.forEach(l => { const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) env[m[1]] = m[2]; });

// Create test session via admin route
const sessRes = await fetch(`${DEV}/admin/test-session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ adminPassword: env.ADMIN_PASSWORD, firmCode: 'TEST18' })
});
const sessData = await sessRes.json();
if (!sessData.token) { console.error('Session failed:', sessData.error); process.exit(1); }
console.log('Test session created');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push('PAGE_ERROR: ' + err.message));

const failedRequests = [];
page.on('response', resp => { if (resp.status() >= 400) failedRequests.push(resp.status() + ' ' + resp.url()); });

// Inject token: go to a page with scripts blocked, set localStorage, then proceed
await page.route('**/*.js', route => route.abort());
await page.goto(`${LOCAL}/scout/landing.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.evaluate((token) => { localStorage.setItem('g7_session_token', token); }, sessData.token);
await page.unroute('**/*.js');

fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── 1. Customers — Chase Today ──
console.log('\n1. Customers — pipeline.html (Chase Today)');
await page.goto(`${LOCAL}/scout/pipeline.html`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(SHOT_DIR, '01_chase_today.png') });
console.log('   01_chase_today.png saved');

// ── 2. Not contacted collapsed ──
console.log('\n2. Not contacted (collapsed)');
const ncBtn = page.locator('button.nc-toggle');
let hasNc = false;
try { await ncBtn.waitFor({ timeout: 3000 }); hasNc = true; } catch {}
if (hasNc) {
  await ncBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOT_DIR, '02_not_contacted_collapsed.png') });
  console.log('   02 collapsed saved');

  // ── 3. Not contacted expanded — click button, NOT the link ──
  console.log('\n3. Not contacted (expanded)');
  await ncBtn.click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOT_DIR, '03_not_contacted_expanded.png') });
  console.log('   03 expanded saved');
} else {
  console.log('   [!] nc-toggle button not found');
  await page.screenshot({ path: path.join(SHOT_DIR, '02_fallback.png') });
}

// ── 4. Google section with "Create one free" ──
console.log('\n4. Google section');
let googleFound = false;
try {
  const g = page.locator('text=/Create one free/i');
  await g.waitFor({ timeout: 3000 });
  await g.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  googleFound = true;
} catch {}
await page.screenshot({ path: path.join(SHOT_DIR, '04_google_section.png') });
console.log('   saved' + (googleFound ? ' (found "Create one free →")' : ' (text not found, viewport shot)'));

// ── 5. Today — lead card ──
console.log('\n5. Today lead cards');
await page.goto(`${LOCAL}/scout/today.html`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(SHOT_DIR, '05_today_lead_card.png') });
console.log('   05_today_lead_card.png saved');

// ── Report ──
console.log('\n--- Console Errors ---');
if (consoleErrors.length === 0) console.log('None');
else consoleErrors.forEach(e => console.log('  ' + e.slice(0, 300)));

console.log('\n--- Failed Requests (4xx/5xx) ---');
if (failedRequests.length === 0) console.log('None');
else failedRequests.forEach(r => console.log('  ' + r));

await browser.close();
console.log('\nDone.');
