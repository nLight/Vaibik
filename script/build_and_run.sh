#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-run}"
if [[ "$mode" == --bridge ]]; then
  shift
  exec "$root/script/build_legacy_bridge.sh" "$@"
fi
cd "$root"
if [[ ! -d desktop/node_modules/electron ]]; then npm --prefix desktop ci; fi
if [[ ! -f desktop/node_modules/electron/path.txt ]]; then node desktop/node_modules/electron/install.js; fi
if [[ "$mode" != --fixture ]]; then node script/prepare_desktop.mjs; fi
dist() {
  if [[ "$(uname -s)" == Darwin ]]; then
    exec npm --prefix desktop run dist -- -c.npmRebuild=false "$@"
  fi
  exec npm --prefix desktop run dist -- "$@"
}
case "$mode" in
  --fixture) exec npm --prefix desktop start -- --fixture ;;
  --build-only) dist --dir ;;
  --package) dist ;;
  --debug) exec npm --prefix desktop start -- --inspect=9229 ;;
  --logs|--telemetry) exec npm --prefix desktop start -- --enable-logging=stderr ;;
  --verify|run) exec npm --prefix desktop start ;;
  *) echo "Usage: $0 [--fixture|--build-only|--package|--debug|--logs|--bridge]" >&2; exit 2 ;;
esac
