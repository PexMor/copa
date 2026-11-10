#!/usr/bin/env bash
# Start dex, run the token issuer in upstream mode against it, perform a real login, clean up.
#   ./dev/run-dex-demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ISSUER_PORT=${ISSUER_PORT:-8090}
cleanup() {
  [[ -n "${ISSUER_PID:-}" ]] && kill "$ISSUER_PID" 2>/dev/null || true
  docker compose -f dev/docker-compose.yml down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -f dev/docker-compose.yml up -d
echo -n "waiting for dex"
for _ in $(seq 1 60); do
  curl -fs http://127.0.0.1:5556/dex/.well-known/openid-configuration >/dev/null && break
  echo -n "."; sleep 1
done
echo

TOKEN_ISSUER_UPSTREAM_CLIENT_SECRET=dev-only-secret \
  uv run token-issuer --ephemeral --port "$ISSUER_PORT" \
    --upstream-issuer http://127.0.0.1:5556/dex --upstream-client-id token-issuer \
    --upstream-scopes "openid email profile" --upstream-map-file dev/upstream-map.json &
ISSUER_PID=$!
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$ISSUER_PORT/healthz" >/dev/null && break; sleep 0.5; done

uv run python dev/dex_login_check.py --issuer "http://127.0.0.1:$ISSUER_PORT"
