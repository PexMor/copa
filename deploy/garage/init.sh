#!/usr/bin/env bash
# Start the reference Garage backend and bootstrap it for copa. Safe to re-run.
#
#   - state dir: $COPA_S3_DIR (default ~/.config/copa/s3-garage): .env, storage.toml, data/, meta/
#   - generates .env with a fresh RPC secret (first run only)
#   - assigns the single-node layout
#   - creates the bucket and an access key that can read/write that bucket only
#   - sets bucket CORS (browser uploads) and a lifecycle rule (expiry backstop)
#   - prints the [server.storage] block for ~/.config/copa/config.toml
#     and writes it to $COPA_S3_DIR/storage.toml
set -euo pipefail
cd "$(dirname "$0")"
umask 077
. ./state.sh
mkdir -p "$COPA_S3_DIR/data" "$COPA_S3_DIR/meta"

# One-time migration of files an older init.sh kept next to the script.
for f in .env storage.toml; do
  if [ -f "$f" ] && [ ! -f "$COPA_S3_DIR/$f" ]; then mv "$f" "$COPA_S3_DIR/$f"; echo "→ moved $f to $COPA_S3_DIR"; fi
done
if [ ! -f "$COPA_S3_DIR/.env" ]; then
  sed "s/^GARAGE_RPC_SECRET=.*/GARAGE_RPC_SECRET=$(openssl rand -hex 32)/" .env.example > "$COPA_S3_DIR/.env"
  echo "→ generated $COPA_S3_DIR/.env with a new RPC secret"
fi
# Values already set in the environment win over .env (used by scripts/verify-s3.sh).
overrides=$(for v in COPA_S3_BIND COPA_S3_PORT COPA_S3_PUBLIC_URL COPA_CORS_ORIGINS COPA_CORS_EXTRA; do
  [ -n "${!v+x}" ] && printf '%s=%q\n' "$v" "${!v}"; done || true)
set -a; . "$COPA_S3_DIR/.env"; eval "$overrides"; set +a

: "${COPA_BUCKET:=copa}" "${COPA_KEY_NAME:=copa}" "${COPA_S3_PORT:=3900}" "${GARAGE_CAPACITY:=10G}"
: "${COPA_S3_PUBLIC_URL:=http://127.0.0.1:${COPA_S3_PORT}}" "${COPA_LIFECYCLE_DAYS:=8}"
: "${COPA_CORS_ORIGINS:=http://127.0.0.1:8080 http://localhost:8080}"
# Extra allowed origins, added to COPA_CORS_ORIGINS (space or comma separated).
COPA_CORS_ORIGINS="$COPA_CORS_ORIGINS ${COPA_CORS_EXTRA:-}"
COPA_CORS_ORIGINS=$(printf '%s' "$COPA_CORS_ORIGINS" | tr ',' ' ' | xargs -n1 | awk '!s[$0]++' | paste -sd' ')
LOCAL_S3="http://127.0.0.1:${COPA_S3_PORT}"

garage() { docker compose exec -T -e RUST_LOG=warn garage /garage "$@"; }

docker compose up -d garage
printf '→ waiting for garage'
for _ in $(seq 1 60); do
  if garage status >/dev/null 2>&1; then break; fi
  printf '.'; sleep 1
done
echo
garage status >/dev/null || { echo "error: garage did not start (docker compose logs garage)" >&2; exit 1; }

# ── layout (single node) ──────────────────────────────────────────────────────
if garage status | grep -q "NO ROLE ASSIGNED"; then
  node_id=$(garage node id -q | cut -d@ -f1)
  garage layout assign -z dc1 -c "$GARAGE_CAPACITY" "$node_id" >/dev/null
  current=$(garage layout show | sed -n 's/.*apply --version \([0-9]*\).*/\1/p' | head -1)
  garage layout apply --version "${current:-1}" >/dev/null
  echo "→ layout assigned ($GARAGE_CAPACITY)"
fi

# ── bucket + bucket-scoped key ────────────────────────────────────────────────
garage bucket info "$COPA_BUCKET" >/dev/null 2>&1 || { garage bucket create "$COPA_BUCKET" >/dev/null; echo "→ bucket '$COPA_BUCKET' created"; }
garage key info "$COPA_KEY_NAME" >/dev/null 2>&1 || { garage key create "$COPA_KEY_NAME" >/dev/null; echo "→ key '$COPA_KEY_NAME' created"; }
# read + write on this one bucket; no owner right, no bucket creation
garage bucket allow --read --write "$COPA_BUCKET" --key "$COPA_KEY_NAME" >/dev/null
garage key deny --create-bucket "$COPA_KEY_NAME" >/dev/null 2>&1 || true

key_info=$(garage key info --show-secret "$COPA_KEY_NAME")
key_id=$(echo "$key_info" | sed -n 's/^Key ID: *//p' | tr -d '[:space:]')
key_secret=$(echo "$key_info" | sed -n 's/^Secret key: *//p' | tr -d '[:space:]')
[ -n "$key_id" ] && [ -n "$key_secret" ] || { echo "error: could not read key from garage" >&2; exit 1; }

# ── CORS + lifecycle (need the bucket owner right → short-lived setup key) ────
if command -v aws >/dev/null 2>&1; then
  s3api() { aws --endpoint-url "$LOCAL_S3" --region garage s3api "$@"; }
else
  s3api() {
    docker run --rm --network host -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_EC2_METADATA_DISABLED \
      amazon/aws-cli --endpoint-url "$LOCAL_S3" --region garage s3api "$@"
  }
fi

setup_key="${COPA_KEY_NAME}-setup"
garage key delete --yes "$setup_key" >/dev/null 2>&1 || true
setup_info=$(garage key create "$setup_key")
trap 'garage key delete --yes "$setup_key" >/dev/null 2>&1 || true' EXIT
garage bucket allow --read --write --owner "$COPA_BUCKET" --key "$setup_key" >/dev/null
export AWS_ACCESS_KEY_ID=$(echo "$setup_info" | sed -n 's/^Key ID: *//p' | tr -d '[:space:]')
export AWS_SECRET_ACCESS_KEY=$(echo "$setup_info" | sed -n 's/^Secret key: *//p' | tr -d '[:space:]')
export AWS_EC2_METADATA_DISABLED=true

# One rule per origin: Garage answers with the rule's whole AllowedOrigins list,
# and browsers only accept a single origin in Access-Control-Allow-Origin.
cors_rules=""
for origin in $COPA_CORS_ORIGINS; do
  cors_rules="${cors_rules:+$cors_rules,}{
    \"AllowedOrigins\": [\"$origin\"],
    \"AllowedMethods\": [\"GET\", \"PUT\", \"HEAD\"],
    \"AllowedHeaders\": [\"content-type\", \"content-disposition\"],
    \"ExposeHeaders\": [\"ETag\"],
    \"MaxAgeSeconds\": 3600
  }"
done
s3api put-bucket-cors --bucket "$COPA_BUCKET" --cors-configuration "{\"CORSRules\": [$cors_rules]}"
echo "→ CORS set for: $COPA_CORS_ORIGINS"

if s3api put-bucket-lifecycle-configuration --bucket "$COPA_BUCKET" --lifecycle-configuration "{
  \"Rules\": [{
    \"ID\": \"copa-expiry-backstop\", \"Status\": \"Enabled\",
    \"Filter\": {\"Prefix\": \"\"},
    \"Expiration\": {\"Days\": $COPA_LIFECYCLE_DAYS},
    \"AbortIncompleteMultipartUpload\": {\"DaysAfterInitiation\": 1}
  }]
}" 2>/dev/null; then
  echo "→ lifecycle backstop: objects expire after $COPA_LIFECYCLE_DAYS day(s)"
else
  echo "warning: could not set the lifecycle rule (copasrv still removes expired files itself)" >&2
fi

garage key delete --yes "$setup_key" >/dev/null
trap - EXIT

# ── optional HTTPS front on 0.0.0.0:$COPA_LAN_PORT (existing private-CA certificate) ──
: "${COPA_LAN_PORT:=3901}" "${COPA_LAN_HOST:=srv.lan}"
: "${COPA_LAN_CERT_DIR:=${COPA_LAN_CA_DIR:-$HOME/.config/srv_lan_ca}/hosts/$COPA_LAN_HOST}"
lan_chain=""
for f in bundle.pem bundle-2.pem cert.pem; do  # leaf + intermediate preferred; avoid bundles with the root
  [ -f "$COPA_LAN_CERT_DIR/$f" ] && { lan_chain=$f; break; }
done
if [ -n "$lan_chain" ] && [ -f "$COPA_LAN_CERT_DIR/key.pem" ]; then
  export COPA_LAN_PORT COPA_LAN_CERT_DIR COPA_LAN_CHAIN="$lan_chain"
  docker compose --profile lan up -d caddy-lan >/dev/null
  echo "→ https front on 0.0.0.0:$COPA_LAN_PORT (cert $COPA_LAN_CERT_DIR/$lan_chain)"
  lan_url="https://$COPA_LAN_HOST:$COPA_LAN_PORT"
  [ "$COPA_S3_PUBLIC_URL" = "$lan_url" ] || echo "  hint: set COPA_S3_PUBLIC_URL=$lan_url in $COPA_S3_DIR/.env so browsers use it (clients must trust the CA)"
else
  echo "→ no TLS cert in $COPA_LAN_CERT_DIR (need key.pem + bundle.pem|bundle-2.pem|cert.pem): https front skipped"
fi

# ── result ────────────────────────────────────────────────────────────────────
{
  echo "[server.storage]"
  echo "public_url        = \"$COPA_S3_PUBLIC_URL\""
  [ "$COPA_S3_PUBLIC_URL" = "$LOCAL_S3" ] || echo "endpoint          = \"$LOCAL_S3\""
  echo "region            = \"garage\""
  echo "bucket            = \"$COPA_BUCKET\""
  echo "access_key_id     = \"$key_id\""
  echo "secret_access_key = \"$key_secret\""
} > "$COPA_S3_DIR/storage.toml"

echo
echo "Garage is ready. Add this to ~/.config/copa/config.toml (also saved to $COPA_S3_DIR/storage.toml):"
echo
cat "$COPA_S3_DIR/storage.toml"
