#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-run}"
if [[ "$mode" == --bridge ]]; then
  shift
  exec "$root/script/build_legacy_bridge.sh" "$@"
fi
cd "$root"
export PATH="$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
case "$mode" in
  --fixture) exec npm --prefix desktop run start -- -- --fixture ;;
  --build-only) exec npm --prefix desktop run dist -- --no-bundle ;;
  --package)
    node script/prepare_desktop.mjs
    exec npm --prefix desktop run dist
    ;;
  --verify|run) exec npm --prefix desktop run start ;;
  *) echo "Usage: $0 [--fixture|--build-only|--package|--bridge]" >&2; exit 2 ;;
esac
