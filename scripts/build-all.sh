#!/usr/bin/env bash
# Cross-build copasrv + copacli (static musl) and the frontend into ./bin/
#
#   scripts/build-all.sh [--skip-web] [x86_64|arm64|armhf ...]   (default: all)
#
# Output: bin/<arch>/{copasrv,copacli}  and  bin/frontend/  (the web app; the widget is in bin/frontend/widget/)
set -euo pipefail

cd "$(dirname "$0")/.."

declare -A TRIPLE=(
  [x86_64]=x86_64-unknown-linux-musl
  [arm64]=aarch64-unknown-linux-gnu        # musl fails: zig rejects --fix-cortex-a53-843419
  [armhf]=armv7-unknown-linux-musleabihf   # Raspberry Pi 3B+ (32-bit OS)
)
ALL=(x86_64 arm64 armhf)
SKIP_WEB=0
TARGETS=()

usage() { echo "usage: $0 [--skip-web] [${ALL[*]}]..."; }

for a in "$@"; do
  case "$a" in
    --skip-web) SKIP_WEB=1 ;;
    -h|--help) usage; exit 0 ;;
    x86_64|arm64|armhf) TARGETS+=("$a") ;;
    *) echo "error: unsupported target '$a'" >&2
       echo "supported targets: ${ALL[*]}" >&2; exit 2 ;;
  esac
done
[ ${#TARGETS[@]} -gt 0 ] || TARGETS=("${ALL[@]}")

# ── prerequisites (checked before anything is built) ─────────────────────────
missing=0
need() { # need <cmd> <fix>
  command -v "$1" >/dev/null 2>&1 || { echo "missing: $1  → $2" >&2; missing=1; }
}
need cargo "install rustup: https://rustup.rs"
need zig "install zig (e.g. https://ziglang.org/download/)"
need cargo-zigbuild "cargo install cargo-zigbuild"
[ "$SKIP_WEB" = 1 ] || need yarn "install yarn v4 (corepack enable) or use --skip-web"
if command -v rustup >/dev/null 2>&1; then
  installed=$(rustup target list --installed)
  for t in "${TARGETS[@]}"; do
    grep -qx "${TRIPLE[$t]}" <<<"$installed" || {
      echo "missing rust target: ${TRIPLE[$t]}  → rustup target add ${TRIPLE[$t]}" >&2; missing=1; }
  done
fi
[ "$missing" = 0 ] || exit 1

# ── frontend (arch independent, built once) ──────────────────────────────────
if [ "$SKIP_WEB" = 0 ]; then
  echo "==> frontend"
  (cd web && yarn install)
  (cd web && yarn build)
  [ -f web/dist/index.html ] || { echo "error: web/dist/index.html not produced" >&2; exit 1; }
  rm -rf bin/frontend && mkdir -p bin
  cp -r web/dist bin/frontend

  # the embeddable widget (web-widget/): served by copasrv at /widget/ with its demo pages and the
  # config schema, in the same relative layout the demos expect (../dist/…)
  echo "==> widget"
  (cd web-widget && yarn install && yarn build && yarn size)
  [ -f web-widget/dist/copa-widget.iife.js ] || { echo "error: web-widget/dist not produced" >&2; exit 1; }
  mkdir -p bin/frontend/widget/dist bin/frontend/widget/demo bin/frontend/widget/schema
  cp web-widget/dist/*.js bin/frontend/widget/dist/
  cp web-widget/demo/*.html bin/frontend/widget/demo/
  cp web-widget/schema/copa-widget.schema.json bin/frontend/widget/schema/
fi

# ── binaries ─────────────────────────────────────────────────────────────────
for t in "${TARGETS[@]}"; do
  tr=${TRIPLE[$t]}
  echo "==> $t ($tr)"
  rm -rf "bin/$t"   # never leave stale binaries looking fresh
  if [ "$t" = arm64 ]; then
    # glibc 2.31 floor via wrapper that also filters the unsupported linker flag
    W=$PWD/scripts/zig-cc-arm64.sh
    CC_aarch64_unknown_linux_gnu=$W AR_aarch64_unknown_linux_gnu="cargo-zigbuild zig ar" \
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=$W \
      cargo build --release --target "$tr" --bin copasrv --bin copacli
  else
    cargo zigbuild --release --target "$tr" --bin copasrv --bin copacli
  fi
  mkdir -p "bin/$t"
  for b in copasrv copacli; do
    install -m 755 "target/$tr/release/$b" "bin/$t/$b"
  done
done

echo "==> done"
ls -l bin/*/copasrv bin/*/copacli
