#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# verify-leads.sh — Quick smoke test for the Customer Finder
# pipeline against the dev worker.
#
# Usage:
#   ./scripts/verify-leads.sh <session_token>
#
# The session_token is the value of g7_session_token from
# localStorage in the browser (copy it from DevTools).
# ─────────────────────────────────────────────────────────────
set -euo pipefail

DEV="https://g7-proxy-dev.gsevnservices.workers.dev"
TOKEN="${1:-}"

if [ -z "$TOKEN" ]; then
  echo "Usage: $0 <session_token>"
  echo "  Copy g7_session_token from browser DevTools → Application → Local Storage"
  exit 1
fi

AUTH="Authorization: Bearer $TOKEN"
OK=0
FAIL=0

pass() { OK=$((OK+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo ""
echo "═══════════════════════════════════════"
echo "  Customer Finder — Verify (dev)"
echo "═══════════════════════════════════════"
echo ""

# ── 1. Lead profile exists ──
echo "1. Lead profile"
PROFILE=$(curl -s -H "$AUTH" "$DEV/scout/lead-profile")
if echo "$PROFILE" | grep -q '"groups"'; then
  GROUPS=$(echo "$PROFILE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('groups',[])))" 2>/dev/null || echo "?")
  AREAS=$(echo "$PROFILE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('areas',[])))" 2>/dev/null || echo "?")
  CONFIRMED=$(echo "$PROFILE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('confirmedAt','none'))" 2>/dev/null || echo "?")
  pass "Profile exists — $GROUPS groups, $AREAS areas, confirmedAt=$CONFIRMED"
else
  fail "No lead profile found"
  echo "     Response: ${PROFILE:0:200}"
fi

# ── 2. Today's leads ──
echo ""
echo "2. Today's leads"
TODAY=$(curl -s -H "$AUTH" "$DEV/scout/leads/today")
if echo "$TODAY" | grep -q '"noProfile"'; then
  fail "noProfile=true — need to run analysis first"
elif echo "$TODAY" | grep -q '"generating"'; then
  pass "Leads are being generated (generating=true)"
elif echo "$TODAY" | grep -q '"leads"'; then
  COUNT=$(echo "$TODAY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('leads',[])))" 2>/dev/null || echo "?")
  REMINDERS=$(echo "$TODAY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('reminders',[])))" 2>/dev/null || echo "?")
  pass "Today: $COUNT leads, $REMINDERS reminders"
else
  fail "Unexpected response"
  echo "     Response: ${TODAY:0:200}"
fi

# ── 3. Plan endpoint ──
echo ""
echo "3. Plan / usage"
PLAN=$(curl -s -H "$AUTH" "$DEV/scout/plan")
if echo "$PLAN" | grep -q '"features"'; then
  LEADS_USED=$(echo "$PLAN" | python3 -c "import sys,json; f=json.load(sys.stdin)['features']; print(f['leads']['used'],'of',f['leads']['limit'])" 2>/dev/null || echo "?")
  GS_USED=$(echo "$PLAN" | python3 -c "import sys,json; f=json.load(sys.stdin)['features']; print(f['groupsearch']['used'],'of',f['groupsearch']['limit'])" 2>/dev/null || echo "?")
  pass "Leads today: $LEADS_USED — Group search: $GS_USED"
else
  fail "Could not load plan"
  echo "     Response: ${PLAN:0:200}"
fi

# ── 4. Validate area ──
echo ""
echo "4. Area validation"
VA=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"area":"Koramangala"}' "$DEV/scout/leads/validate-area")
if echo "$VA" | grep -q '"valid":true'; then
  SUGG=$(echo "$VA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(', '.join(d.get('suggestions',[])))" 2>/dev/null || echo "?")
  pass "Koramangala is valid — suggestions: $SUGG"
elif echo "$VA" | grep -q '"valid":false'; then
  REASON=$(echo "$VA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','?'))" 2>/dev/null || echo "?")
  pass "Koramangala not valid (reason: $REASON) — validation working"
else
  fail "Area validation unexpected response"
  echo "     Response: ${VA:0:200}"
fi

# ── 5. Old findBusinesses route returns 410 ──
echo ""
echo "5. Old route removed"
OLD=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$DEV/places/search?q=test")
if [ "$OLD" = "410" ]; then
  pass "GET /places/search returns 410 Gone"
elif [ "$OLD" = "401" ]; then
  pass "GET /places/search returns 401 (auth checked before 410, still fine)"
else
  fail "GET /places/search returned $OLD (expected 410)"
fi

# ── 6. Group search endpoint exists ──
echo ""
echo "6. Group search endpoint"
GS=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"group":"_test_nonexistent_"}' "$DEV/scout/leads/group-search")
if echo "$GS" | grep -q '"error"'; then
  pass "Group search endpoint responds (expected error for fake group)"
elif echo "$GS" | grep -q 'limit_reached'; then
  pass "Group search responds with limit_reached"
else
  fail "Group search unexpected response"
  echo "     Response: ${GS:0:200}"
fi

# ── Summary ──
echo ""
echo "═══════════════════════════════════════"
echo "  Results: $OK passed, $FAIL failed"
echo "═══════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then exit 1; fi
