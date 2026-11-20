#!/usr/bin/env bash
# Build VibeMic Console (desktop-gpui) as a signed macOS app and DMG for one architecture.
# The engine resources (Parakeet runtime and the native helper) must already be staged
# for the same architecture by script/prepare_desktop.mjs.
set -euo pipefail

usage() { echo 'Usage: script/package_console_macos.sh <arm64|x64> <signing identity SHA-1 or -> <output.dmg>'; }
fail() { echo "$*" >&2; exit 1; }

[[ $# -eq 3 ]] || { usage >&2; exit 2; }
arch=$1
identity=$2
output=$3
case "$arch" in
  arm64) target=aarch64-apple-darwin; expected=arm64 ;;
  x64) target=x86_64-apple-darwin; expected=x86_64 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $(uname -s) == Darwin ]] || fail 'Packaging DMGs requires macOS.'

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
export PATH="$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
export SDKROOT="${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}"
export MACOSX_DEPLOYMENT_TARGET=13.3

version=$(node -p 'require("./desktop/package.json").version')
crate_version=$(sed -n 's/^version = "\(.*\)"$/\1/p' desktop-gpui/Cargo.toml | head -n 1)
[[ "$crate_version" == "$version" ]] || fail "desktop-gpui/Cargo.toml is $crate_version, expected $version."
engine="$root/build/desktop-resources/engine"
[[ -x "$engine/nemo/bin/nemo-speech" && -x "$engine/vibemic-desktop-draft" ]] \
  || fail 'Stage the engine with script/prepare_desktop.mjs first.'
[[ $(lipo -archs "$engine/nemo/bin/nemo-speech") == "$expected" ]] || fail "The staged engine is not $expected."

rustup target add "$target" >/dev/null
cargo build --release --locked --manifest-path desktop-gpui/Cargo.toml --target "$target"
binary="desktop-gpui/target/$target/release/vibemic-gpui"
[[ $(lipo -archs "$binary") == "$expected" ]] || fail "Unexpected architecture in $binary."

work=$(mktemp -d "$root/build/console-package.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
app="$work/dmg/VibeMic Console.app"
contents="$app/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources/vibemic"
cp "$binary" "$contents/MacOS/vibemic-gpui"
cp desktop/src-tauri/icons/icon.icns "$contents/Resources/icon.icns"
ditto "$engine" "$contents/Resources/vibemic/engine"
cat > "$contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>ru</string>
    <key>CFBundleDisplayName</key><string>VibeMic Console</string>
    <key>CFBundleExecutable</key><string>vibemic-gpui</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundleIdentifier</key><string>dev.vibemic.console</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>VibeMic Console</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$version</string>
    <key>CFBundleVersion</key><string>$version</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
    <key>LSMinimumSystemVersion</key><string>13.3</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>VibeMic Console records push-to-talk dictation from the selected microphone.</string>
</dict>
</plist>
EOF
plutil -lint "$contents/Info.plist" >/dev/null

# Sign from the inside out. Ad-hoc builds (identity "-") skip the hardened runtime and
# the timestamp, which need a Developer ID.
sign=(/usr/bin/codesign --force --sign "$identity")
if [[ "$identity" != - ]]; then sign+=(--options runtime --timestamp); fi
resources="$contents/Resources/vibemic/engine"
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then "${sign[@]}" "$file"; fi
done < <(find "$resources" -type f -print0)
"${sign[@]}" --entitlements desktop/assets/entitlements.mac.plist "$app"
/usr/bin/codesign --verify --deep --strict "$app"

ln -s /Applications "$work/dmg/Applications"
rm -f -- "$output"
hdiutil create -quiet -volname 'VibeMic Console' -srcfolder "$work/dmg" -fs HFS+ -format UDZO "$output"
if [[ "$identity" != - ]]; then
  /usr/bin/codesign --force --sign "$identity" --timestamp "$output"
fi
hdiutil verify -quiet "$output"
printf 'Built %s\n' "$output"
