#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="$root/host/macos"
output="$root/build/macos"
tool="$output/vibemic-bridge"
mkdir -p "$output"
staging="$(mktemp -d "$output/.build.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
export CLANG_MODULE_CACHE_PATH="$output/clang-cache"
xcrun --sdk macosx swiftc -swift-version 5 -O -module-cache-path "$output/swift-cache" \
  -target "$(uname -m)-apple-macosx12.0" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$source_dir/Info.plist" \
  "$source_dir/Support.swift" "$source_dir/Audio.swift" "$source_dir/Destination.swift" "$source_dir/main.swift" \
  -o "$staging/vibemic-bridge"
/usr/bin/codesign --force --sign - --identifier dev.vibemic.bridge "$staging/vibemic-bridge"
mv -f "$staging/vibemic-bridge" "$tool"

case "${1:-run}" in
  --build-only) printf '%s\n' "$tool" ;;
  --debug) lldb -- "$tool" ;;
  --verify) "$tool" --list-inputs ;;
  --logs|--telemetry|run) "$tool" ;;
  *) "$tool" "$@" ;;
esac
