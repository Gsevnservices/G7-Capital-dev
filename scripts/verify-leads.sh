#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# verify-leads.sh — Smoke test for Customer Finder (dev worker).
#
# Logs in via POST /admin/test-session using ADMIN_PASSWORD from
# .env.local. Never prints secrets, tokens, or raw records.
#
# Usage:  ./scripts/verify-leads.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

DEV="https://g7-proxy-dev.gsevnservices.workers.dev"
FIRM="TEST18"
ENV_FILE=".env.local"
OK=0
FAIL=0

pass() { OK=$((OK+1)); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

echo ""
echo "======================================="
echo "  Customer Finder — Verify (dev)"
echo "======================================="
echo ""

# ── Read admin password silently ──
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Create it with ADMIN_PASSWORD=..."
  exit 1
fi
ADMIN_PW=$(grep -E '^ADMIN_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -z "$ADMIN_PW" ]; then
  echo "ERROR: ADMIN_PASSWORD not found in $ENV_FILE"
  exit 1
fi

# ── Get session token silently ──
echo "0. Login"
SESSION_RAW=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"adminPassword\":\"$ADMIN_PW\",\"firmCode\":\"$FIRM\"}" \
  "$DEV/admin/test-session")
TOKEN=$(echo "$SESSION_RAW" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
if [ -z "$TOKEN" ]; then
  echo "  FAIL  Could not get test session"
  exit 1
fi
pass "Got test session for $FIRM"
AUTH="Authorization: Bearer $TOKEN"

# ── 1. Today's leads ──
echo ""
echo "1. Today's leads (GET /scout/leads/today)"
TODAY=$(curl -s -H "$AUTH" "$DEV/scout/leads/today")
LEAD_COUNT=$(echo "$TODAY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('leads',[])))" 2>/dev/null || echo "0")
if echo "$TODAY" | grep -q '"leads"'; then
  pass "Today: $LEAD_COUNT leads"
else
  fail "Unexpected response: ${TODAY:0:120}"
fi

# ── 2. Lead dry run ──
echo ""
echo "2. Lead dry run (POST /admin/leads/dry-run)"
DRY=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"adminPassword\":\"$ADMIN_PW\",\"firmCode\":\"$FIRM\"}" \
  "$DEV/admin/leads/dry-run")
DRY_OK=$(echo "$DRY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok', d.get('result',{}).get('status','?')))" 2>/dev/null || echo "?")
DRY_STATUS=$(echo "$DRY" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',{}); print(r.get('status', d.get('status','?')))" 2>/dev/null || echo "?")
if [ "$DRY_OK" = "True" ] || [ "$DRY_STATUS" = "ok" ] || [ "$DRY_STATUS" = "already_generated" ]; then
  pass "Lead dry run: ok=$DRY_OK, status=$DRY_STATUS"
else
  fail "Lead dry run: ok=$DRY_OK, status=$DRY_STATUS"
fi

# ── 3. Morning email dry run ──
echo ""
echo "3. Morning email dry run (POST /admin/email/morning)"
ME=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"adminPassword\":\"$ADMIN_PW\",\"firmCode\":\"$FIRM\",\"dryRun\":true}" \
  "$DEV/admin/email/morning")
ME_STATUS=$(echo "$ME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
ME_LEADS=$(echo "$ME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('leadCount','?'))" 2>/dev/null || echo "?")
ME_SUBJ=$(echo "$ME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('subject','?')[:80])" 2>/dev/null || echo "?")
if [ "$ME_STATUS" = "dry_run" ] || [ "$ME_STATUS" = "nothing_to_send" ] || [ "$ME_STATUS" = "email_off" ]; then
  pass "Morning email: status=$ME_STATUS, leads=$ME_LEADS"
  echo "         Subject: $ME_SUBJ"
else
  fail "Morning email: status=$ME_STATUS"
fi

# ── 4. Weekly email dry run ──
echo ""
echo "4. Weekly email dry run (POST /admin/email/weekly)"
WE=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"adminPassword\":\"$ADMIN_PW\",\"firmCode\":\"$FIRM\",\"dryRun\":true}" \
  "$DEV/admin/email/weekly")
WE_STATUS=$(echo "$WE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
if [ "$WE_STATUS" = "dry_run" ] || [ "$WE_STATUS" = "nothing_to_report" ] || [ "$WE_STATUS" = "email_off" ]; then
  pass "Weekly email: status=$WE_STATUS"
  if [ "$WE_STATUS" = "dry_run" ]; then
    WE_SUBJ=$(echo "$WE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('subject','')[:80])" 2>/dev/null || echo "")
    echo "         Subject: $WE_SUBJ"
  fi
else
  fail "Weekly email: status=$WE_STATUS"
fi

# ── 5. /go redirect ──
echo ""
echo "5. Link redirect (GET /go/nonexistent)"
GO_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$DEV/go/nonexistent_test_code")
if [ "$GO_STATUS" = "404" ]; then
  pass "/go/nonexistent returns 404 as expected"
else
  fail "/go/nonexistent returned $GO_STATUS (expected 404)"
fi

# ── 6. Landing page /go/info ──
echo ""
echo "6. Landing page /go/info (TEST19 bio link)"
GI=$(curl -s "$DEV/go/info?g=px326g")
GI_BIZ=$(echo "$GI" | python3 -c "import sys,json; print(json.load(sys.stdin).get('businessName',''))" 2>/dev/null || echo "")
if [ -n "$GI_BIZ" ]; then
  pass "/go/info returned business: $GI_BIZ"
else
  fail "/go/info missing businessName"
fi

# ── 7. Landing page /go/join honeypot ──
echo ""
echo "7. Honeypot rejection (POST /go/join)"
HP=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"code":"px326g","name":"Bot","phone":"1234567890","hp":"http://spam"}' \
  "$DEV/go/join")
HP_URL=$(echo "$HP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('waUrl',''))" 2>/dev/null || echo "FAIL")
if [ "$HP_URL" = "" ]; then
  pass "Honeypot: fake success, no waUrl"
else
  fail "Honeypot: waUrl was returned (should be empty)"
fi

# ── Summary ──
echo ""
echo "======================================="
echo "  Results: $OK passed, $FAIL failed"
echo "======================================="
echo ""

# Clean up — token stays in shell variable only, never written to files
if [ "$FAIL" -gt 0 ]; then exit 1; fi
