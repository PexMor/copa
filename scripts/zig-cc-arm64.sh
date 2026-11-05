#!/bin/sh
# Linker wrapper for aarch64: zig's linker rejects rustc's default
# -Wl,--fix-cortex-a53-843419, so drop it and delegate to `zig cc`.
# The glibc floor (2.31 = Debian 11 / Raspberry Pi OS bullseye) is set here.
: "${ZIG_ARM64_TARGET:=aarch64-linux-gnu.2.31}"
for a; do
  shift
  case "$a" in *fix-cortex-a53-843419*) continue ;; esac
  set -- "$@" "$a"
done
exec cargo-zigbuild zig cc -- -g -fno-sanitize=all -target "$ZIG_ARM64_TARGET" "$@"
