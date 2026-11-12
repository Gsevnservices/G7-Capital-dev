# G7 Capital — Claude Code Project Brief
**Read this file at the start of every session before touching any code.**
**Last updated: 4 April 2026**

---

## 1. WHO I AM AND HOW I WORK

I am Pallav — the solo founder of G7 Capital. I have zero coding background. I use Claude as my development partner to build everything. This means:

- Always give me ONE complete file — never fragments or snippets
- If updating an existing file, give me the full updated file
- Tell me the exact filename and whether to create or update
- Never use terminal commands beyond what is absolutely necessary — and if you must, explain each one in plain English
- Add comments inside every code file explaining what each section does
- Test your code mentally before writing it — it must work first try
- Always make everything fully mobile responsive
- If you are unsure about anything, ask me before writing code

---

## 2. WHAT I AM BUILDING — COMPLETE PRODUCT VISION

**G7 Capital** is an AI-native investment ecosystem. The full platform has these pillars:

**PILLAR 1 — G7 WORKSPACE (Currently Building)**
Named AI employees for PE/VC/IB firms. Each employee has persistent memory, a defined role, and structured output format. Firms interact with AI employees via chat and receive structured professional reports.

Active employees for prototype:
- **Alex** — Deal Analyst (screens deals, writes first-pass notes, morning digest)
- **Maya** — DD Associate (full due diligence, investment memos) — PIPELINE
- **David** — Research Analyst (sector reports, market sizing) — PIPELINE
- **Sofia** — Compliance Officer (reviews all outputs, background only, not user-facing)

Descoped for now: James (Portfolio Monitor), Priya (LP Relations), Marcus (IB Analyst)

**PILLAR 2 — G7 CAPITAL OS** — merged into G7 Workspace. The employees ARE the product. Modules are their built-in capabilities.

**PILLAR 3 — G7 COMMUNITY** — in pipeline, not building yet

**DISCARDED:** G7 Apply, G7 Network

**THE CORE DIFFERENTIATOR vs generic AI tools:**
1. Persistent memory — Alex remembers every deal the firm has ever seen
2. Firm configuration — firm uploads thesis, past deals, format preferences. All outputs match firm standards.
3. Structured workflow — not a chat interface. Runs on cadences. Morning digest. Consistent output format. Always.

**COMPETITIVE CONTEXT:**
Main competitor is F2 (f2.ai) — YC-backed, $10M raised Sept 2025.
F2 = document intelligence tool (turns data rooms into structured analysis).
G7 = replaces the analyst team end-to-end. F2 is a faster scalpel. G7 is a surgical team.

---

## 3. TECH STACK — EXACTLY WHAT WE USE

```
Frontend:      HTML + CSS + Vanilla JavaScript (no frameworks)
Hosting:       GitHub Pages via Hostinger (auto-deploys from GitHub Desktop)
Code editor:   VS Code
AI Engine:     Anthropic Claude API — model: claude-sonnet-4-20250514
Storage:       localStorage (browser) — no database for prototype
Forms:         Formspree endpoint: https://formspree.io/f/xzdjwjqy
PDF parsing:   PDF.js (CDN — no install needed)
Fonts:         Google Fonts (Cormorant Garamond + Tenor Sans)
```

**NO:** No Node.js server. No Express. No React. No database. No backend.
Everything runs client-side. API calls go directly from the browser to Anthropic.

**Live URL:** https://gsevnservices.github.io/G7-Capital
**GitHub repo:** github.com/Gsevnservices/G7-Capital
**Contact email:** contact@gsevnservices.in

---

## 4. DESIGN SYSTEM — DO NOT DEVIATE FROM THIS

### Colours
```
Background primary:    #080808  (pure near-black)
Background cards:      #0F0F0F  (dark charcoal)
Background sections:   #161616  (slightly lighter)
Background hover:      #1E1E1E  (subtle lift)
Gold primary:          #C9A84C  (antique gold)
Gold hover/light:      #E2C97E  (lighter gold)
Gold muted:            #A8873A  (darker gold)
White primary:         #FAFAF8  (warm white)
White secondary:       #F0EFE9  (off white)
Grey body text:        #8A8880  (warm mid-grey)
Grey subtle:           #5A5855  (dark grey)
Border gold tint:      rgba(201,168,76,0.15)
Border white tint:     rgba(250,250,248,0.08)
```

### Fonts
```html
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Tenor+Sans&display=swap" rel="stylesheet">
```
- Headlines: Cormorant Garamond weight 300
- Italic emphasis: Cormorant Garamond italic
- Labels/nav/tags/captions: Tenor Sans, ALL CAPS, letter-spacing 0.15-0.25em
- Body text: Tenor Sans, normal case, 13-15px, line-height 1.9

### Style Rules
- Background: Pure black #080808 always
- Grain texture overlay on every page (CSS SVG filter, opacity 0.4)
- Custom gold cursor with trailing ring on desktop
- Generous white space — never cramped
- Thin gold horizontal lines as section dividers
- Section numbers: `01 — Section Name` (gold, Tenor Sans)
- Gold is NEVER used as background for large areas
- No bright colours — black, white, gold ONLY

### Animations
- Page load: staggered fade-up on hero elements (0.2s delays)
- Scroll: elements fade up using IntersectionObserver
- Hover on cards: translateY(-4px) + border brightens
- Loading states: horizontal gold progress bar animation

### Navigation (same on every page)
- Background: rgba(8,8,8,0.92) with backdrop-filter blur 24px
- Height: 80px, fixed top, z-index: 999
- Left: "G7 Capital" — Cormorant Garamond weight 300, letter-spacing 0.25em, "7" in gold
- Right: "Sign In" (grey) + "Request Access" (gold bg, black text)
- Mobile: hamburger → full-screen black overlay, z-index: 998

### Language Rules
- Never "sign up" — always "apply for access"
- Never "users" — always "members" or "firms"
- Never "AI tool" — always "AI employees" or "your AI team"
- Never "chatbot" — Alex is an analyst, not a chatbot

---

## 5. CURRENT BUILD STATUS

### Completed Pages

| File | Status |
|------|--------|
| `index.html` | ✅ LIVE — Homepage with workspace nav link |
| `for-firms.html` | ✅ LIVE — For PE/VC/IB firms page |
| `workspace/onboard.html` | ✅ LIVE — 5-step firm setup |
| `workspace/submit.html` | ✅ LIVE — Deal submission (text + PDF, stores dealContent) |
| `workspace/result.html` | ✅ LIVE — Alex screening note (score ring, all sections, red flags, CQ flow) |
| `workspace/history.html` | ✅ LIVE — Searchable deal history |
| `workspace/index.html` | ✅ LIVE — Workspace dashboard |

### Completed Features

- [x] Alex Master Prompt v1 (`assets/alex-master-v1.js`) — 663.0 KB, ~151,369 tokens: system prompt + 25 calibration rules + 100 training examples + 6 advanced analytical frameworks + Component 7: 8 sector intelligence libraries + Component 8: Red Flag Library (100 flags, 8 categories)
- [x] Core JS engine (`assets/workspace.js`) — `callAlex()`, `callAlexRaw()`, `saveDeal()`, `loadDealById()`, `loadAllDeals()`, `updateDealDecision()`, `updateDealOutput()`, `addCalibration()`, `loadFirmConfig()`, `isOnboarded()`, `exportNoteAsPDF()`, `clearWorkspace()`, `parseAlexScore()`, `formatDate()`, `requireOnboarding()`, `G7_PROXY_URL` constant
- [x] Cloudflare Worker proxy (`cloudflare-worker.js`) — deployed at `g7-proxy.gsevnservices.workers.dev`. Fixes CORS, routes browser calls to Anthropic API, API key stored as Cloudflare env variable
- [x] Result page — all 10 sections rendered
- [x] Score ring with count-up animation and empty state (`?` when no score)
- [x] Red flag severity badges — HIGH/MEDIUM/LOW with correct colours
- [x] Narrative Drift Check table
- [x] Thesis Dependency Chain
- [x] Alex's Note in gold italic
- [x] Calibration loop — partner corrections update firm KB for all future Alex calls automatically
- [x] Clarifying Questions Flow — when Alex needs more info, shows Q&A interface, sends answers back, renders complete note
- [x] Deal history with search and filters
- [x] Export note as PDF
- [x] Mobile responsive across all pages

### Live URLs

```
Homepage:         https://gsevnservices.github.io/G7-Capital
Workspace:        https://gsevnservices.github.io/G7-Capital/workspace/onboard.html
Cloudflare proxy: https://g7-proxy.gsevnservices.workers.dev
```

### localStorage Keys (canonical — do not rename)

```
g7_api_key              — Anthropic API key (entered during onboarding)
g7_firm_config          — JSON object: firm configuration details
g7_firm_knowledge_base  — Full firm KB text injected into every Alex call
g7_onboarded            — 'true' once firm has completed onboarding
g7_deal_history         — JSON array of all screened deals with outputs
g7_calibration_log      — JSON array of partner corrections to Alex
g7_pending_result       — Temp: last Alex output, read by result.html on load
g7_view_deal_id         — Temp: dealId set by history.html before navigating to result.html
```

### Known Issues to Avoid (learned from previous builds)

- Grain overlay: use `body::before` with z-index:1000 (fixed — do NOT use `body::after`)
- Hero animations: use `both` keyword not `forwards` in animation-fill-mode
- Reveal sections: use inline styles via JS, not class toggling
- Cursor: starts at left:-100px top:-100px, appears on first mousemove
- Mobile cursor: hide at max-width:480px not 768px
- Nav z-index: 999. Mobile menu: 998
- `splitIntoSections()` uses 4-state machine — do not simplify or it breaks dual-divider format
- `g7_pending_result` must include `dealContent` field (added in Session 2) for CQ flow to work
- Cloudflare Worker CORS only allows `gsevnservices.github.io` and `localhost:8080`
- **Secrets:** Never echo, print, or test token/password/key variables — not even "set / not set" checks. Never read session tokens from KV or put them in commands. For dev testing, use only admin routes with `ADMIN_PASSWORD` sourced silently from `.env.local`.
- **Session keys:** Never list KV session keys (e.g. `wrangler kv key list` with prefix `auth:sessions`). Test sessions must only come from `POST /admin/test-session` with the admin password.
- **devlocal branch:** Never delete or recreate it. It carries dev-only commits (CNAME removal, .gitignore CNAME rule) that must not reach main. Always push to dev with: `git checkout devlocal && git merge main && git push dev devlocal:main --force && git checkout main`
- **Image files:** Never open, Read, or view image files (png/jpg), including screenshots in `~/Desktop/g7_shots`. Only save them and list file names and sizes. Opening images drops the API connection.

---

## 6. ALEX — THE AI EMPLOYEE

### What Alex Is
Alex is a Deal Analyst AI employee. He is not a chatbot. He screens investment deals to institutional PE/VC standard and produces structured screening notes in a consistent professional format.

### The Three Training Files
Alex's brain lives in three files that have been combined into one master document:

**File: `assets/alex-master-v1.js`** (✅ BUILT)

This JS file exports a constant `ALEX_MASTER_PROMPT` containing:
1. System Prompt — Alex's identity, framework, 6-stage screening methodology, output format, scoring system, sector metrics library
2. Calibration System — 25 rules encoding experienced VC partner judgment (overrides generic analysis)
3. Training Library — 30 worked deals: 10 YES, 10 PASS, 10 WRONG CALLS with outcomes and lessons

The source text file is: `alex_master_v1.txt` (in project root — 453KB, ~100,000 tokens (updated April 2026 with 6 advanced frameworks))

### How the API Call Works
Every Alex API call has three parts assembled in this order:
```
SYSTEM PROMPT = ALEX_MASTER_PROMPT + '\n\n' + FIRM_KNOWLEDGE_BASE
USER MESSAGE  = Structured deal submission
```

`FIRM_KNOWLEDGE_BASE` is loaded from localStorage where it was saved during firm onboarding.

### The API Call Code Pattern
```javascript
async function callAlex(dealSubmission) {
  const systemPrompt = ALEX_MASTER_PROMPT + '\n\n' +
                       localStorage.getItem('g7_firm_knowledge_base');

  const userMessage = `
Please screen the following deal and produce a complete
G7 Workspace Deal Screening Note in your standard format.

COMPANY: ${dealSubmission.companyName}
SOURCE: ${dealSubmission.source}
SPECIFIC FOCUS: ${dealSubmission.partnerFocus || 'Standard full screening'}

DEAL MATERIALS:
${dealSubmission.content}
  `;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': localStorage.getItem('g7_api_key'),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-iab': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}
```

### localStorage Keys Used
```
g7_api_key              — Anthropic API key (entered by firm on first use)
g7_firm_knowledge_base  — Full firm KB text injected into every Alex call
g7_firm_config          — JSON object with firm configuration details
g7_deal_history         — JSON array of all deals screened with outputs
g7_calibration_log      — JSON array of partner corrections to Alex
g7_onboarded            — Boolean: has firm completed onboarding
```

---

## 7. FIRM KNOWLEDGE BASE — WHAT IT CONTAINS

When a firm completes onboarding, this text block is assembled and saved to localStorage as `g7_firm_knowledge_base`:

```
═══════════════════════════════════════════════════
FIRM KNOWLEDGE BASE — [FIRM NAME]
Injected into every Alex session
═══════════════════════════════════════════════════

FIRM NAME:            [firm name]
FIRM TYPE:            [PE / VC / IB / Merchant Bank]
FUND SIZE:            [amount]
STAGE FOCUS:          [stages]
SECTOR FOCUS:         [sectors]
GEOGRAPHY:            [regions]
TICKET SIZE:          [min] — [max]
RETURN TARGET:        [IRR or MOIC target]

INVESTMENT THESIS:
[Partner's own words]

HARD PASS CRITERIA:
[What firm will never invest in]

RECENT DEAL HISTORY:
[Up to 10 past deals with verdict and reason]

FIRM-SPECIFIC CALIBRATION NOTES:
[Partner corrections to Alex accumulated over time]

ACTIVE PIPELINE:
[Deals currently in process]
═══════════════════════════════════════════════════
```

---

## 8. BUILD SEQUENCE — ALL STEPS IN ORDER

### PHASE 1 — ALEX PROTOTYPE ✅ COMPLETE — 29 March 2026

**STEP 1 — Convert Alex Master to JS constant**
File: `assets/alex-master-v1.js`
Task: Create a JS file that exports `ALEX_MASTER_PROMPT` as a constant
containing the full text of `alex_master_v1.txt`
Status: ✅ COMPLETE — 29 March 2026

**STEP 2 — Firm Onboarding Page**
File: `workspace/onboard.html`
Task: Form page where firm enters their configuration.
Saves to localStorage on submit. Redirects to workspace dashboard.
Fields: firm name, type, stage, sector, geography, ticket size,
return target, investment thesis, hard pass criteria, recent deals
Status: ✅ COMPLETE — 29 March 2026

**STEP 3 — Deal Submission Interface**
File: `workspace/submit.html`
Task: Two input methods — text description OR PDF upload.
Additional fields: company name, deal source, partner focus notes.
On submit: calls Alex API, redirects to result page with output.
Status: ✅ COMPLETE — 29 March 2026

**STEP 4 — API Call Function and Shared JS**
File: `assets/workspace.js`
Task: Core JS file with callAlex(), saveDeal(), loadHistory(),
addCalibration(), and all shared localStorage helpers.
Status: ✅ COMPLETE — 29 March 2026

**STEP 5 — Result Display Page**
File: `workspace/result.html`
Task: Renders Alex's screening note beautifully in G7 design system.
Shows: status badge, G7 score ring, all sections, risk flags,
Narrative Drift Check, Thesis Dependency Chain, Alex's Note.
Two action buttons: Partner Agrees / Partner Disagrees.
Disagree flow: small form, saves to calibration log.
Status: ✅ COMPLETE — 29 March 2026 (parsing engine audited and fixed — 34/34 checks pass)

**STEP 6 — Deal History Page**
File: `workspace/history.html`
Task: Searchable table of all deals. Filter by status/score/date.
Shows calibration log. Links to full notes.
Status: ✅ COMPLETE — 29 March 2026

**STEP 7 — Workspace Dashboard**
File: `workspace/index.html`
Task: Main workspace hub. Shows firm name, quick stats, recent deals,
action buttons. Entry point for returning firms.
Status: ✅ COMPLETE — 29 March 2026

### PHASE 2 — PIPELINE (After Phase 1 is tested)

- Maya system prompt and DD memo interface
- David research request interface
- Stripe payment integration
- Proper multi-firm onboarding flow
- Connect workspace to for-firms.html marketing page

### PHASE 3 — PIPELINE (Later)

- workspace.html full page on main site
- how-it-works.html
- pricing.html
- community.html

---

## 9. CURRENT SESSION — WHAT TO BUILD TODAY

**Phase 1 build is complete as of 4 April 2026.**
All 7 workspace pages live and working.
Alex successfully screening deals end to end.
Clarifying questions flow built and deployed.

**Next session tasks (in priority order):**

1. Test clarifying questions flow with Paddle deal
2. Test full scored note with Causal deal
3. Fix any rendering issues found during testing
4. Prepare Christian demo
   - One real deal from his merchant bank pipeline
   - Side-by-side comparison vs raw Claude
   - Demo script written
5. Begin Phase 2 planning
   - Maya DD Associate system prompt
   - David Research Analyst system prompt
   - Stripe payment integration
   - Multi-firm authentication

---

## 10. PIPELINE FEATURES — PHASE 2

**1. Maya — DD Associate**
Full due diligence memo interface.
System prompt to be written before build.

**2. David — Research Analyst**
Sector research request interface.
System prompt to be written before build.

**3. Prompt caching**
Reduce API cost from ~$0.20 to ~$0.02 per call.
One-line change in workspace.js — high ROI, low effort.

**4. Stripe payment integration**
Firms pay before accessing workspace.

**5. Multi-firm authentication**
Email/password login replacing localStorage.

**6. Morning digest email**
Alex sends daily briefing by email.

**7. workspace.html on main marketing site**
Full page explaining the product.

**8. how-it-works.html**

**9. pricing.html**

---

## 11. IMPORTANT CONTEXT — THE BUSINESS SITUATION

This prototype exists for one primary purpose right now:
**To show Christian (senior IB partner, BofA + Credit Suisse background,
building a merchant bank) that Alex does something ChatGPT cannot.**

Christian's feedback: "It's generic — I can do this with ChatGPT."
The prototype must answer this objection by demonstration, not explanation.

The demo plan:
1. Open workspace. Show firm configuration loaded.
2. Submit a real deal Christian knows from his pipeline.
3. Show Alex's output. Point out: firm thesis applied, deal history referenced,
   consistent format, Single Point of Failure identified.
4. Open raw Claude in another tab. Ask the same question.
5. The difference is obvious. That is the product.

This context should inform every design and UX decision.
The product must feel like an institutional tool, not a startup demo.
It must feel like something a firm would trust with real deal flow.

---

## 12. HOW TO UPDATE THIS FILE

At the end of every build session, update Section 8 (Build Sequence)
to reflect what was completed and what the current status is.
Update Section 9 (Current Session) to reflect the next task.

This file is the single source of truth for the build.
If it is up to date, every new Claude Code session starts with
full context and zero ramp-up time.

---

## 13. BUILD LOG

### SESSION 1 — 29 March 2026
Built: alex-master-v1.js, onboard.html, workspace.js,
submit.html, result.html, history.html, index.html
Bugs found and fixed: 1 (result.html section parser — replaced 2-state machine with 4-state machine)
Status: Phase 1 complete, pushed to GitHub

### SESSION 2 — 3–4 April 2026
Built: Cloudflare Worker proxy (cloudflare-worker.js) — fixed CORS
Built: Clarifying questions flow (result.html + workspace.js)
Fixed: Cloudflare env variable name (ANTHROPIC_API_KEY)
Fixed: Score ring empty state (shows ? when no score data)
Fixed: Red flag severity badges (HIGH/MEDIUM/LOW now correct)
Fixed: onboard.html security note text (updated for proxy architecture)
Fixed: result.html section parser (4-state machine — 34/34 checks pass)
Added: workspace nav link to homepage (index.html)
Added: callAlexRaw(), updateDealOutput() to workspace.js
Added: dealContent field to g7_pending_result (submit.html)
Tested: Paddle deal screened successfully on live URL
Status: Phase 1 complete — ready for Christian demo

### SESSION 3 — 5 April 2026
Built: 6 advanced analytical frameworks
  Framework 1 — Business Model Decomposition and Unit Economics
                Inference Engine (3,740 words)
  Framework 2 — Founder Archetype Recognition System (6,250 words)
  Framework 3 — Market Timing Matrix (3,319 words)
  Framework 4 — Competitive Moat Durability Assessment (4,012 words)
  Framework 5 — Cohort Decay Pattern Library (4,396 words)
  Framework 6 — Probability-Weighted Return Model (2,706 words)
Total new content: 24,423 words
Integrated: All 6 frameworks appended to alex_master_v1.txt as Component 5
Rebuilt: assets/alex-master-v1.js (453KB, ~100,000 tokens)
Verified: 11/11 integration checks passed
          Context window usage: ~107K of 200K
Status: Ready for live testing

### SESSION 4 — 8 April 2026
Built: 70 new training examples across 7 batch files
  20 YES deals (Batch 2A: 011–020, Batch 2B: 021–030)
    Wise, Monzo, Checkout.com, Tractable, Multiverse, Darktrace,
    Veeva, Snowflake, Datadog, HashiCorp, Rippling, Deel, Vinted,
    GoCardless, Deliveroo, Plaid, Stripe, Revolut, Recursion, Wayve
  20 PASS deals (Batch 3A: 011–020, Batch 3B: 021–030)
    20 new failure patterns beyond the original 10
  20 WRONG CALLS (Batch 4A: 011–020, Batch 4B: 021–030)
    10 missed wins + 10 failed investments
  10 INFLECTION POINT deals (Batch 5: 001–010)
    Genuine ambiguity — one deciding factor resolves each
Total new content: 69,117 words across full batch files
Integrated: Component 6 appended to alex_master_v1.txt
  (condensed pattern summary — signals and lessons only)
  Full batch files retained on disk for human reference
Rebuilt: assets/alex-master-v1.js (520KB)
Token count: ~116,895 tokens system prompt
             ~124,895 typical call total
             ~69,105 tokens headroom (worst case)
Alex now has: 100 worked examples total (30 YES / 30 PASS /
              30 WRONG CALLS / 10 INFLECTION POINTS)
Status: Ready — push to GitHub pending

### SESSION 5 — 9 April 2026
Built: 8 sector intelligence libraries
  Library 1 — B2B SaaS (5,756 words)
  Library 2 — Fintech (8,172 words)
  Library 3 — Healthtech (9,250 words)
  Library 4 — Marketplace (9,198 words)
  Library 5 — Deep Tech (11,170 words)
  Library 6 — Consumer (10,802 words)
  Library 7 — Climate (10,713 words)
  Library 8 — Enterprise (10,706 words)
Total sector content: 75,767 words across 8 full library files
Integrated: Component 7 condensed summaries into alex_master_v1.txt
  (5,043 words / ~8,944 tokens — full files retained on disk)
Rebuilt: assets/alex-master-v1.js (559.7 KB)
Token count: ~125,975 tokens system prompt
             ~133,975 typical call total (with user message)
             ~59,025 tokens headroom to 185K budget
Status: Week 3 complete — ready for testing

### SESSION 6 — 11 April 2026
Built: Red Flag Library — 8 categories, 100 flags total
  Category 1 — Financial (15 flags, F01–F15, 6,976 words)
  Category 2 — Team (15 flags, T01–T15, 8,034 words)
  Category 3 — Market (10 flags, M01–M10, 5,655 words)
  Category 4 — Product (10 flags, P01–P10, 5,914 words)
  Category 5 — Traction (15 flags, TR01–TR15, 8,523 words)
  Category 6 — Governance (10 flags, G01–G10, 6,030 words)
  Category 7 — Deal Structure (10 flags, DS01–DS10, 6,389 words)
  Category 8 — Founder Behaviour (15 flags, FB01–FB15, 9,462 words)
Total: 100 flags / 57,983 words across 8 full library files
Note: Flag count is 100 (not 95 — recount confirmed during integration)
Integrated: Component 8 condensed into alex_master_v1.txt
  (alex_redflag_condensed.txt — 15,404 words / ~25,244 tokens)
  Full flag category files retained on disk for reference
Rebuilt: assets/alex-master-v1.js (663.0 KB)
Token count: ~151,369 tokens system prompt
             ~159,369 typical call total (with user message)
             ~33,631 tokens headroom to 185K budget
Status: Week 4 complete — Red Flag Library integrated

---

*G7 Capital — Private Equity. Powered by Intelligence.*
*Built by Pallav, solo founder, Gsevn Services*
