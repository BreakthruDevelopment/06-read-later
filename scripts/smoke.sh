#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users, saves one URL twice, and checks the other user cannot read it.
#   BASE_URL=https://app6.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; SAVE_1="$(mktemp)"; SAVE_2="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$SAVE_1" "$SAVE_2"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
echo "$health" | grep -q '"queue"' || fail "health missing queue: $health"
echo "$health" | grep -q '"queued"' || fail "health queue missing queued: $health"
echo "$health" | grep -q '"oldestSeconds"' || fail "health queue missing oldestSeconds: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/links")
[ "$code" = "401" ] || fail "anonymous list should be 401, got $code"
pass "anonymous access refused"

# Bundled fixture: stored ready, no network fetch. See src/lib/links/fixtures.ts.
DEMO_URL="https://example.com/read-later/postgres-indexes"
save() {
  local jar=$1 out=$2
  curl -s -o "$out" -w '%{http_code}' -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"url\":\"$DEMO_URL\"}" "$BASE_URL/api/links"
}

code=$(save "$JAR_A" "$SAVE_1")
[ "$code" = "202" ] || fail "first save should be 202, got $code ($(cat "$SAVE_1"))"
id=$(sed -E 's/.*"id":"([^"]+)".*/\1/' "$SAVE_1")
[ -n "$id" ] || fail "no link id in $(cat "$SAVE_1")"
code=$(save "$JAR_A" "$SAVE_2")
[ "$code" = "200" ] || fail "second save should be 200, got $code"
id2=$(sed -E 's/.*"id":"([^"]+)".*/\1/' "$SAVE_2")
[ "$id" = "$id2" ] || fail "saving twice created two links ($id vs $id2)"
pass "saving a URL twice returns one link"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_B" "$BASE_URL/api/links/$id")
[ "$code" = "404" ] || fail "user B reading A's link should be 404, got $code"
pass "user B gets 404 for A's link"

patched=$(curl -s -w '\n%{http_code}' -X PATCH -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"tags":["smoke-tag"]}' "$BASE_URL/api/links/$id") || fail "patch tags failed"
code=$(echo "$patched" | tail -n 1)
body=$(echo "$patched" | sed '$d')
[ "$code" = "200" ] || fail "patch tags should be 200, got $code ($body)"
echo "$body" | grep -q 'smoke-tag' || fail "patched link is missing the tag: $body"
pass "owner patched tags"

found=$(curl -fsS -b "$JAR_A" --get --data-urlencode "q=database" "$BASE_URL/api/links") || fail "search failed"
echo "$found" | grep -q "$id" || fail "search did not find the demo article by body text: $found"
none=$(curl -fsS -b "$JAR_A" --get --data-urlencode "q=zzqxnomatch" "$BASE_URL/api/links") || fail "search failed"
echo "$none" | grep -q "$id" && fail "search for a missing word returned the article: $none"
pass "search finds a demo article"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/links/$id")
[ "$code" = "204" ] || fail "owner delete should be 204, got $code"
pass "owner deleted their link"

echo "SMOKE PASS"
