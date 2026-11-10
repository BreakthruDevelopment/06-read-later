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

for path in /dashboard /admin /inbox /archive /favorites /search /tags /settings /save; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out library pages redirect"

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

# Bundled fixture: stored with its text, no network fetch; the summarize job finishes it. See src/lib/links/fixtures.ts.
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

# The bundled article goes through the summarize job with the recorded demo answer (AI_PROVIDER=demo): no network, no key.
ready=""
for _ in $(seq 1 30); do
  got=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/links/$id") || fail "reading the link failed"
  if echo "$got" | grep -q '"status":"ready"'; then ready="$got"; break; fi
  sleep 1
done
[ -n "$ready" ] || fail "link never reached ready (summarize job did not run): $got"
echo "$ready" | grep -q '"summary":{"mode":"demo"' || fail "ready link has no demo summary: $ready"
pass "summarize job ran offline and the link is ready with a summary"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_B" -H "origin: $BASE_URL" "$BASE_URL/api/links/$id/summary")
[ "$code" = "404" ] || fail "user B regenerating A's summary should be 404, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "origin: $BASE_URL" "$BASE_URL/api/links/$id/summary")
[ "$code" = "401" ] || fail "anonymous regenerate should be 401, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/links/$id/summary")
[ "$code" = "202" ] || fail "owner regenerate should be 202, got $code"
pass "regenerate: owner 202, other user 404, anonymous 401"

for path in /inbox /archive /favorites /tags /search /settings; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" "$BASE_URL$path")
  [ "$code" = "200" ] || fail "signed-in $path should be 200, got $code"
done
pass "signed-in library pages render"

inbox=$(curl -fsS -b "$JAR_A" "$BASE_URL/inbox") || fail "inbox did not render"
echo "$inbox" | grep -q 'name="url"' || fail "inbox is missing the save box"
echo "$inbox" | grep -q "How Postgres indexes speed up queries" || fail "inbox did not render the saved article"
pass "inbox renders the saved article"

reader=$(curl -fsS -b "$JAR_A" "$BASE_URL/links/$id") || fail "reader did not render"
echo "$reader" | grep -q "A Postgres index lets the database" || fail "reader did not render the article text"
echo "$reader" | grep -F -q 'max-w-[68ch]' || fail "reader is missing the 68ch measure"
echo "$reader" | grep -F -q 'text-[18px]' || fail "reader is missing the 18px type"
echo "$reader" | grep -q 'rel="noopener noreferrer nofollow"' || fail "original link is missing rel"
echo "$reader" | grep -q "Couldn't extract readable text" && fail "a stored article rendered the empty-text message"
pass "reader renders the article text"

save_page=$(curl -fsS -b "$JAR_A" --get --data-urlencode "url=$DEMO_URL" "$BASE_URL/save") || fail "save page did not render"
echo "$save_page" | grep -q "Nothing is saved until you press Save" || fail "save page can be read as already saving"
echo "$save_page" | grep -q "$DEMO_URL" || fail "save page did not show the URL"
list=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/links") || fail "list failed after opening /save"
count=$(printf '%s' "$list" | grep -o "$id" | wc -l | tr -d ' ')
[ "$count" = "1" ] || fail "opening /save changed the library ($count copies of $id)"
pass "save page shows the URL and does not store it"

settings=$(curl -fsS -b "$JAR_A" "$BASE_URL/settings") || fail "settings did not render"
echo "$settings" | grep -q "encodeURIComponent" || fail "settings is missing the bookmarklet"
echo "$settings" | grep -q "Safari" || fail "settings is missing the iOS steps"
echo "$settings" | grep -q "Chrome" || fail "settings is missing the Android steps"
pass "settings explains the bookmarklet"

patched=$(curl -s -w '\n%{http_code}' -X PATCH -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"tags":["smoke-tag"]}' "$BASE_URL/api/links/$id") || fail "patch tags failed"
code=$(echo "$patched" | tail -n 1)
body=$(echo "$patched" | sed '$d')
[ "$code" = "200" ] || fail "patch tags should be 200, got $code ($body)"
echo "$body" | grep -q 'smoke-tag' || fail "patched link is missing the tag: $body"
pass "owner patched tags"

tagged=$(curl -fsS -b "$JAR_A" "$BASE_URL/tags/smoke-tag") || fail "tag page did not render"
echo "$tagged" | grep -q "How Postgres indexes speed up queries" || fail "tag page did not render the article"
pass "tag page renders the article"

found=$(curl -fsS -b "$JAR_A" --get --data-urlencode "q=database" "$BASE_URL/api/links") || fail "search failed"
echo "$found" | grep -q "$id" || fail "search did not find the demo article by body text: $found"
none=$(curl -fsS -b "$JAR_A" --get --data-urlencode "q=zzqxnomatch" "$BASE_URL/api/links") || fail "search failed"
echo "$none" | grep -q "$id" && fail "search for a missing word returned the article: $none"
pass "search finds a demo article"

search_page=$(curl -fsS -b "$JAR_A" --get --data-urlencode "q=indexes" "$BASE_URL/search") || fail "search page did not render"
echo "$search_page" | grep -q "How Postgres indexes speed up queries" || fail "search page did not render the article"
pass "search page renders the article"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/links/$id")
[ "$code" = "204" ] || fail "owner delete should be 204, got $code"
pass "owner deleted their link"

echo "SMOKE PASS"
