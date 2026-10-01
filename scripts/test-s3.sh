#!/usr/bin/env bash
# End-to-end test of file sharing against the reference Garage backend.
#
# Starts Garage (deploy/garage), runs copasrv with a short TTL and exercises
# put / get / history / limits / expiry / orphan cleanup through copacli and
# curl. Uses its own key prefix (copa-e2e/) and asserts it is empty at the end.
#
# Requires: docker, cargo, curl, openssl, sha256sum.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${COPA_TEST_PORT:-18765}"
TTL=15
TMP="$(mktemp -d)"
SRV_PID=""
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; [ -f "$TMP/srv.log" ] && tail -20 "$TMP/srv.log" >&2; exit 1; }
stop_srv() { if [ -n "$SRV_PID" ]; then kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true; fi; SRV_PID=""; }
trap 'stop_srv; rm -rf "$TMP"' EXIT

echo "== backend"
./deploy/garage/init.sh >"$TMP/init.log" 2>&1 || { cat "$TMP/init.log" >&2; exit 1; }
pass "garage is up and bootstrapped"
cargo build --quiet --bin copasrv --bin copacli
SRV="$ROOT/target/debug/copasrv"; CLI="$ROOT/target/debug/copacli"

garage() { (cd deploy/garage && docker compose exec -T -e RUST_LOG=warn garage /garage "$@"); }
bucket=$(sed -n 's/^bucket *= *"\(.*\)"/\1/p' deploy/garage/storage.toml)
objects() { garage bucket info "$bucket" | sed -n 's/^Objects: *//p' | tr -d '[:space:]'; }
wait_objects() { # <expected> <timeout-secs>
  for _ in $(seq 1 "$2"); do [ "$(objects)" = "$1" ] && return 0; sleep 1; done; return 1
}

TOKEN=$("$SRV" --generate-token)
{
  echo "[server]"; echo "port = $PORT"
  cat deploy/garage/storage.toml
  echo 'key_prefix = "copa-e2e/"'
  echo "[server.namespaces.default]"
  echo "rw_token = \"$TOKEN\""
  echo "item_ttl_secs = $TTL"
  echo "max_file_size = 1048576"
} > "$TMP/config.toml"
printf '[server]\nport = %s\n[server.namespaces.default]\nrw_token = "%s"\n' "$PORT" "$TOKEN" > "$TMP/nostorage.toml"

export COPA_CONFIG="$TMP/config.toml" COPA_SERVER="http://127.0.0.1:$PORT" COPA_TOKEN="$TOKEN"
unset COPA_REMOTE COPA_NAMESPACE || true
AUTH=(-H "Authorization: Bearer $TOKEN")
api() { curl -sS "${AUTH[@]}" "$@"; }
json() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {"d": d}))' "$1"; }

start_srv() { # <config>
  "$SRV" --config "$1" 2>>"$TMP/srv.log" &
  SRV_PID=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0; sleep 0.1; done
  fail "copasrv did not start"
}
# request an upload of <size> bytes named <name>; prints the grant JSON
grant() { api -X POST -d "{\"name\":\"$1\",\"size\":$2}" "$COPA_SERVER/api/files"; }
# PUT <file> using a grant JSON on stdin; prints the HTTP status
put_with_grant() {
  local g url; g=$(cat); url=$(echo "$g" | json 'd["upload_url"]')
  curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary "@$1" \
    -H "Content-Type: $(echo "$g" | json 'd["headers"]["Content-Type"]')" \
    -H "Content-Disposition: $(echo "$g" | json 'd["headers"]["Content-Disposition"]')" "$url"
}

head -c 300000 /dev/urandom > "$TMP/report.bin"
head -c 1000 /dev/urandom > "$TMP/small.bin"
head -c 2000000 /dev/urandom > "$TMP/big.bin"

echo "== orphans from a previous run are purged at startup"
start_srv "$TMP/config.toml"
sleep 2            # let the startup reconcile clear anything a failed earlier run left behind
BASE=$(objects)    # objects of other prefixes in this bucket are not ours to count
[ "$(grant leftover.bin 1000 | put_with_grant "$TMP/small.bin")" = 200 ] || fail "direct PUT failed"
wait_objects $((BASE + 1)) 10 || fail "object did not appear in the bucket"
stop_srv   # the upload was never completed and the index is lost
start_srv "$TMP/config.toml"
wait_objects "$BASE" 15 || fail "orphan was not removed at startup (objects=$(objects), baseline=$BASE)"
pass "abandoned object removed by startup reconcile"

echo "== capabilities"
caps=$(api "$COPA_SERVER/api/capabilities")
[ "$(echo "$caps" | json 'd["files"]')" = True ] || fail "files not reported: $caps"
[ "$(echo "$caps" | json 'd["max_file_size"]')" = 1048576 ] || fail "max_file_size: $caps"
pass "files enabled, limits reported"

echo "== put / history / get"
ID=$("$CLI" put "$TMP/report.bin" 2>"$TMP/put.err") || { cat "$TMP/put.err" >&2; fail "copacli put failed"; }
[ ${#ID} = 32 ] || fail "put did not print an id: '$ID'"
pass "put printed id"
"$CLI" history 2>/dev/null | grep -q "^$ID  file .*report.bin" || fail "history does not list the file"
"$CLI" history --json | json 'd[0]["kind"]' | grep -q file || fail "history --json"
pass "history lists the file"
mkdir "$TMP/out"
"$CLI" get -o "$TMP/out" 2>/dev/null || fail "copacli get failed"
[ "$(sha256sum < "$TMP/out/report.bin")" = "$(sha256sum < "$TMP/report.bin")" ] || fail "downloaded file differs"
pass "get (newest file) is byte-identical"
if "$CLI" get "$ID" -o "$TMP/out" 2>"$TMP/get.err"; then fail "get overwrote an existing file"; fi
grep -q "already exists" "$TMP/get.err" || fail "no overwrite message"
"$CLI" get "$ID" -o "$TMP/out" --force 2>/dev/null || fail "get --force failed"
[ -z "$(find "$TMP/out" -name '*.part')" ] || fail "partial file left behind"
"$CLI" get "$ID" -o - 2>/dev/null | cmp -s - "$TMP/report.bin" || fail "get -o - differs"
pass "overwrite protection, --force and stdout"

echo "== served safely"
dl=$(api "$COPA_SERVER/api/files/$ID"); URL=$(echo "$dl" | json 'd["download_url"]')
hdrs=$(curl -s -D - -o /dev/null "$URL")
echo "$hdrs" | grep -qi '^content-disposition: attachment' || fail "no attachment disposition"
echo "$hdrs" | grep -qi '^content-type: application/octet-stream' || fail "not served as octet-stream"
[ "$(curl -s -o /dev/null -w '%{http_code}' "${URL%%\?*}")" = 403 ] || fail "unsigned object request was not denied"
pass "attachment + octet-stream, unsigned access denied"

echo "== limits"
if "$CLI" put "$TMP/big.bin" >/dev/null 2>"$TMP/big.err"; then fail "oversized put succeeded"; fi
grep -q "too large" "$TMP/big.err" || fail "no 'too large' message: $(cat "$TMP/big.err")"
pass "oversized file rejected by copasrv"
g=$(grant short.bin 100); gid=$(echo "$g" | json 'd["id"]')
code=$(echo "$g" | put_with_grant "$TMP/small.bin")
[ "$code" = 403 ] || [ "$code" = 400 ] || fail "wrong-length PUT was accepted by the store ($code)"
[ "$(api -o /dev/null -w '%{http_code}' -X POST "$COPA_SERVER/api/files/$gid/complete")" = 409 ] || fail "complete after bad upload"
pass "wrong-length body rejected by the store, complete returns 409"
g=$(grant never.bin 100); gid=$(echo "$g" | json 'd["id"]')
[ "$(api -o /dev/null -w '%{http_code}' -X POST "$COPA_SERVER/api/files/$gid/complete")" = 409 ] || fail "complete without upload"
pass "complete without upload returns 409"

echo "== text history and old clients"
"$CLI" paste "older text" 2>/dev/null; sleep 0.1; "$CLI" paste "newer text" 2>/dev/null
[ "$(curl -sS "${AUTH[@]}" "$COPA_SERVER/api/clipboard")" = "newer text" ] || fail "legacy GET"
[ "$("$CLI" copy -o - 2>/dev/null)" = "newer text" ] || fail "copy returned wrong text"
OLD=$("$CLI" history --json | json '[i["id"] for i in d if i.get("preview") == "older text"][0]')
[ "$("$CLI" copy --item "$OLD" -o - 2>/dev/null)" = "older text" ] || fail "copy --item"
if "$CLI" copy --item "$ID" -o - >/dev/null 2>"$TMP/item.err"; then fail "copy --item on a file succeeded"; fi
grep -q "copacli get" "$TMP/item.err" || fail "no hint to use get"
"$CLI" history rm "$OLD" 2>/dev/null || fail "history rm"
"$CLI" history --json | grep -q "$OLD" && fail "item still listed after rm"
pass "paste / copy / copy --item / history rm"
if command -v websocat >/dev/null 2>&1; then
  (timeout 3 websocat -n -U "ws://127.0.0.1:$PORT/ws?token=$TOKEN" > "$TMP/ws.out" 2>/dev/null </dev/null || true) & ws1=$!
  (timeout 3 websocat -n -U "ws://127.0.0.1:$PORT/ws/events?token=$TOKEN" > "$TMP/ev.out" 2>/dev/null </dev/null || true) & ws2=$!
  sleep 0.7; "$CLI" paste "live text" 2>/dev/null; "$CLI" put "$TMP/small.bin" >/dev/null 2>&1; wait "$ws1" "$ws2"
  grep -q "live text" "$TMP/ws.out" || fail "/ws did not deliver the text"
  grep -q "small.bin" "$TMP/ws.out" && fail "/ws leaked a file event"
  grep '"item_added"' "$TMP/ev.out" | grep -q '"name":"small.bin"' || fail "/ws/events did not announce the file"
  pass "/ws carries text only, /ws/events announces the file"
fi

echo "== expiry removes items and objects (TTL ${TTL}s + reaper tick, up to ~60s)"
for _ in $(seq 1 75); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$(api "$COPA_SERVER/api/files/$ID" | json 'd.get("download_url", "http://127.0.0.1:1/")' 2>/dev/null)")" != 200 ] && break
  sleep 1
done
[ "$(api -o /dev/null -w '%{http_code}' "$COPA_SERVER/api/files/$ID")" = 404 ] || fail "expired file still served"
wait_objects "$BASE" 75 || fail "objects remain after expiry (objects=$(objects), baseline=$BASE)"
[ "$(api "$COPA_SERVER/api/history")" = "[]" ] || fail "history not empty after expiry"
[ -z "$(curl -sS "${AUTH[@]}" "$COPA_SERVER/api/clipboard")" ] || fail "clipboard not empty after expiry"
pass "items expired, bucket back to baseline ($BASE objects)"

echo "== logs"
if grep -E "X-Amz-Signature|$TOKEN|report\.bin|small\.bin" "$TMP/srv.log"; then fail "server log leaks a URL, token or file name"; fi
pass "no URLs, tokens or file names in the server log"

echo "== server without storage"
stop_srv; start_srv "$TMP/nostorage.toml"
[ "$(api "$COPA_SERVER/api/capabilities" | json 'd["files"]')" = False ] || fail "files reported without storage"
if "$CLI" put "$TMP/small.bin" >/dev/null 2>"$TMP/nos.err"; then fail "put succeeded without storage"; fi
grep -q "does not support files" "$TMP/nos.err" || fail "unclear message: $(cat "$TMP/nos.err")"
"$CLI" paste "still works" 2>/dev/null && [ "$("$CLI" copy -o - 2>/dev/null)" = "still works" ] || fail "text broken without storage"
pass "put fails clearly, text unaffected"

echo
echo "all end-to-end checks passed"
