#!/usr/bin/env bash
# Run Garage + copasrv reachable from the local network, for trying file
# sharing by hand from other devices. Ctrl-C stops everything and puts Garage
# back on loopback.
#
#   scripts/verify-s3.sh [--host NAME] [--cert FILE --key FILE] [--port N] [--s3-port N] [--token T]
#   make verify-s3 [HOST=NAME] [CERT=FILE KEY=FILE] [PORT=N] [S3_PORT=N] [TOKEN=T]
#
#   --host   name or address other devices use to reach this machine
#            (default: the auto-detected LAN address). It must resolve to this
#            machine on every device that should connect.
#   --cert   TLS certificate (PEM, full chain) valid for --host
#   --key    its private key (PEM)
#
# Without a certificate everything is PLAIN HTTP: the token, the presigned
# URLs and the files are readable by anyone on the network — trusted networks
# only. copasrv listens on 0.0.0.0:8080 and Garage on 0.0.0.0:3900.
#
# With --cert/--key a Caddy container terminates TLS on 0.0.0.0 (default
# ports 8443 for copa, 3943 for S3) and copasrv and Garage stay on loopback.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${COPA_VERIFY_HOST:-}"; CERT="${COPA_VERIFY_CERT:-}"; KEY="${COPA_VERIFY_KEY:-}"
PORT="${COPA_VERIFY_PORT:-}"; S3_PUBLIC_PORT="${COPA_VERIFY_S3_PORT:-}"; TOKEN="${COPA_VERIFY_TOKEN:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --cert) CERT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --s3-port) S3_PUBLIC_PORT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
done
die() { echo "error: $1" >&2; exit 1; }

if [ -z "$HOST" ]; then
  HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  [ -n "$HOST" ] || die "could not detect the LAN address — pass --host"
fi
case "$HOST" in *[!A-Za-z0-9.:-]*|"") die "'$HOST' is not a valid host name or address" ;; esac

TLS=""
if [ -n "$CERT" ] || [ -n "$KEY" ]; then
  [ -n "$CERT" ] && [ -n "$KEY" ] || die "--cert and --key must be given together"
  [ -r "$CERT" ] || die "cannot read certificate '$CERT'"
  [ -r "$KEY" ] || die "cannot read key '$KEY'"
  CERT="$(realpath "$CERT")"; KEY="$(realpath "$KEY")"
  TLS=1
fi

# Garage's loopback port (from deploy/garage/.env if it exists)
S3_LOCAL_PORT="$(sed -n 's/^COPA_S3_PORT=//p' deploy/garage/.env 2>/dev/null | head -1)"; S3_LOCAL_PORT="${S3_LOCAL_PORT:-3900}"
if [ -n "$TLS" ]; then
  SCHEME=https
  PORT="${PORT:-8443}"; S3_PUBLIC_PORT="${S3_PUBLIC_PORT:-3943}"
  SRV_BIND=127.0.0.1; SRV_PORT="${COPA_VERIFY_INTERNAL_PORT:-18080}"; S3_BIND=127.0.0.1
else
  SCHEME=http
  PORT="${PORT:-8080}"
  [ -z "$S3_PUBLIC_PORT" ] || [ "$S3_PUBLIC_PORT" = "$S3_LOCAL_PORT" ] || export COPA_S3_PORT="$S3_PUBLIC_PORT"
  S3_PUBLIC_PORT="${S3_PUBLIC_PORT:-$S3_LOCAL_PORT}"; S3_LOCAL_PORT="$S3_PUBLIC_PORT"
  SRV_BIND=0.0.0.0; SRV_PORT="$PORT"; S3_BIND=0.0.0.0
fi
URL="$SCHEME://$HOST:$PORT"
S3_URL="$SCHEME://$HOST:$S3_PUBLIC_PORT"
CADDY_NAME="copa-verify-caddy"

# One run at a time: two would fight over Garage's bind address and CORS.
exec 9<"$0"
flock -n 9 || die "another verify-s3 is still running (or still shutting down)"

TMP="$(mktemp -d)"
SRV_PID=""
cleanup() {
  trap - EXIT INT TERM
  echo
  if [ -n "$SRV_PID" ]; then
    # delete this run's files from the bucket while the server can still do it
    curl -s -o /dev/null -m 5 -X DELETE -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$SRV_PORT/api/history" && sleep 1 || true
    kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true
  fi
  [ -z "$TLS" ] || docker rm -f "$CADDY_NAME" >/dev/null 2>&1 || true
  echo "→ restoring Garage defaults (loopback)"
  # .env values apply again: loopback bind, original port, public_url and CORS origins
  (unset COPA_S3_BIND COPA_S3_PORT COPA_S3_PUBLIC_URL COPA_CORS_ORIGINS; ./deploy/garage/init.sh >/dev/null 2>&1) \
    || echo "warning: could not restore Garage — run 'make s3-up' (or 'make s3-down')" >&2
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

echo "→ building"
cargo build --quiet --bin copasrv --bin copacli
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/public web/index.html -newer web/dist/index.html -print -quit)" ]; then
  (cd web && yarn install >/dev/null && yarn build >/dev/null) || die "web build failed (make build-web)"
fi
SRV="$ROOT/target/debug/copasrv"
TOKEN="${TOKEN:-$("$SRV" --generate-token)}"

echo "→ starting Garage on $S3_BIND:$S3_LOCAL_PORT"
export COPA_S3_BIND="$S3_BIND"
export COPA_S3_PUBLIC_URL="$S3_URL"
export COPA_CORS_ORIGINS="$URL"
./deploy/garage/init.sh >"$TMP/init.log" 2>&1 || { cat "$TMP/init.log" >&2; exit 1; }

{
  echo "[server]"
  echo "port = $SRV_PORT"
  echo "bind = \"$SRV_BIND\""
  cat deploy/garage/storage.toml
  # own prefix: this run's startup sweep must not touch a real instance's files
  echo 'key_prefix = "copa-verify/"'
  echo "[server.namespaces.default]"
  echo "rw_token = \"$TOKEN\""
} > "$TMP/config.toml"

if [ -n "$TLS" ]; then
  echo "→ starting TLS proxy (Caddy) on 0.0.0.0:$PORT and 0.0.0.0:$S3_PUBLIC_PORT"
  cat > "$TMP/Caddyfile" <<CADDY
{
	admin off
	auto_https off
}
https://$HOST:$PORT {
	tls /certs/cert.pem /certs/key.pem
	reverse_proxy 127.0.0.1:$SRV_PORT
}
https://$HOST:$S3_PUBLIC_PORT {
	tls /certs/cert.pem /certs/key.pem
	request_body {
		max_size 64MB
	}
	reverse_proxy 127.0.0.1:$S3_LOCAL_PORT {
		flush_interval -1
	}
}
CADDY
  docker rm -f "$CADDY_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$CADDY_NAME" --network host \
    -v "$TMP/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$CERT:/certs/cert.pem:ro" -v "$KEY:/certs/key.pem:ro" \
    caddy:2 >/dev/null || die "could not start the Caddy container"
  sleep 2
  [ "$(docker inspect -f '{{.State.Running}}' "$CADDY_NAME" 2>/dev/null)" = true ] \
    || { docker logs "$CADDY_NAME" 2>&1 | tail -5 >&2; die "Caddy exited — check the certificate, key and that ports $PORT/$S3_PUBLIC_PORT are free"; }
fi

cat <<MSG

  copa is running on your local network$([ -n "$TLS" ] && echo " over HTTPS" || echo " (plain http — trusted networks only)")

  Web app     $URL/#token=$TOKEN&url=$URL
  Token       $TOKEN
  S3 (files)  $S3_URL

  CLI, from any machine on the network:
    copacli put     --server $URL --token $TOKEN <file>
    copacli get     --server $URL --token $TOKEN
    copacli history --server $URL --token $TOKEN
    copacli paste   --server $URL --token $TOKEN "some text"

  Not reachable from another device? "$HOST" must resolve to this machine
  there, and TCP $PORT and $S3_PUBLIC_PORT must be allowed by this machine's firewall.
MSG
if [ -n "$TLS" ]; then cat <<MSG
  Devices must trust the certificate's issuer (for copacli with a private CA:
  SSL_CERT_FILE=/path/to/ca.pem), and it must be valid for "$HOST".
MSG
else cat <<MSG
  Over plain http browsers disable the Copy/Paste buttons and the QR camera;
  typing, Push/Pull, history and file upload/download work. Pass a certificate
  (CERT=… KEY=… HOST=…) to serve HTTPS instead.
MSG
fi
printf '\n  Ctrl-C to stop. History and files are discarded when it stops.\n\n'

"$SRV" --config "$TMP/config.toml" --static-dir web/dist &
SRV_PID=$!
wait "$SRV_PID"
