#!/usr/bin/env bash
set -euo pipefail
mode=${1:-}
if [[ $# -gt 1 || ( -n "$mode" && "$mode" != --mic-probe ) ]]; then
  echo 'Usage: script/build_firmware.sh [--mic-probe]' >&2
  exit 2
fi
repo="$(cd "$(dirname "$0")/.." && pwd)"
workspace="${VIBEMIC_NCS_WORKSPACE:-$(west topdir 2>/dev/null || true)}"
if [[ ! -d "$workspace/nrf" || ! -d "$workspace/zephyr" ]]; then
  echo "Set VIBEMIC_NCS_WORKSPACE to your nRF Connect SDK v3.4.2 workspace." >&2
  exit 1
fi
cd "$workspace"
board=promicro_nrf52840/nrf52840/uf2
s140v7="$repo/firmware/common/promicro-s140v7.overlay"
build() {
  local target="$1" role="$2"
  shift 2
  west build --no-sysbuild -p auto -b "$board" \
    -d "$repo/build/$target" "$repo/firmware/$role" "$@"
}

build_probe() {
  config="$repo/firmware/transmitter/mic-probe.conf"
  overlay="$repo/firmware/transmitter/mic-probe.overlay"
  build promicro-tx-probe transmitter -- -DCONF_FILE="$config" -DEXTRA_DTC_OVERLAY_FILE="$overlay"
  build promicro-tx-probe-s140v7 transmitter -- -DCONF_FILE="$config" -DEXTRA_DTC_OVERLAY_FILE="$overlay;$s140v7"
  output="$repo/build/pdm-probe"
  mkdir -p "$output"
  cp "$repo/build/promicro-tx-probe/zephyr/zephyr.uf2" "$output/VibeMic-PDM-Probe-S140v6.uf2"
  cp "$repo/build/promicro-tx-probe-s140v7/zephyr/zephyr.uf2" "$output/VibeMic-PDM-Probe-S140v7.uf2"
}

if [[ "$mode" == --mic-probe ]]; then build_probe; exit; fi

for role in transmitter receiver; do
  if [[ "$role" == transmitter ]]; then short=tx; else short=rx; fi
  build "promicro-$short" "$role"
  build "promicro-$short-s140v7" "$role" -- -DEXTRA_DTC_OVERLAY_FILE="$s140v7"
done
build_probe
