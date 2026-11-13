#!/usr/bin/env bash
set -euo pipefail

usage() { echo 'Usage: script/package_macos.sh [--signed|--distribution] [arm64|x64|both]'; }
fail() { echo "$*" >&2; exit 1; }

distribution=false
signed=false
case "${1:-}" in
  --help|-h) usage; exit ;;
  --signed) signed=true; shift ;;
  --distribution) signed=true; distribution=true; shift ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }
case "${1:-both}" in
  both) architectures=(arm64 x64) ;;
  arm64|x64) architectures=("$1") ;;
  *) usage >&2; exit 2 ;;
esac
[[ $(uname -s) == Darwin ]] || fail 'Packaging DMGs requires macOS.'

identity=-
if "$distribution"; then
  if [[ -n "${VIBEMIC_MAC_NOTARY_KEY:-}" ]]; then
    [[ -n "${VIBEMIC_MAC_NOTARY_KEY_ID:-}" && -n "${VIBEMIC_MAC_NOTARY_ISSUER:-}" ]] \
      || fail 'Set VIBEMIC_MAC_NOTARY_KEY_ID and VIBEMIC_MAC_NOTARY_ISSUER alongside VIBEMIC_MAC_NOTARY_KEY.'
    [[ -f "$VIBEMIC_MAC_NOTARY_KEY" ]] || fail 'VIBEMIC_MAC_NOTARY_KEY must point to a notarytool .p8 key.'
    notary_args=(--key "$VIBEMIC_MAC_NOTARY_KEY" --key-id "$VIBEMIC_MAC_NOTARY_KEY_ID" --issuer "$VIBEMIC_MAC_NOTARY_ISSUER")
  else
    profile=${VIBEMIC_MAC_NOTARY_PROFILE:-}
    [[ -n "$profile" ]] || fail 'Set VIBEMIC_MAC_NOTARY_PROFILE or the VIBEMIC_MAC_NOTARY_KEY triple.'
    notary_args=(--keychain-profile "$profile")
    if [[ -n "${VIBEMIC_MAC_NOTARY_KEYCHAIN:-}" ]]; then
      notary_args+=(--keychain "$VIBEMIC_MAC_NOTARY_KEYCHAIN")
    fi
  fi
fi
if "$signed"; then
  requested=$(printf '%s' "${VIBEMIC_MAC_SIGNING_SHA1:-}" | tr '[:lower:]' '[:upper:]')
  identity=$(/usr/bin/security find-identity -v -p codesigning | awk -v requested="$requested" '
    /"Developer ID Application:/ && (!length(requested) || $2 == requested) {print $2}
  ')
  [[ -n "$identity" ]] || fail 'No matching Developer ID Application identity in the keychain.'
  [[ "$identity" =~ ^[[:xdigit:]]{40}$ ]] || fail 'Select one valid Developer ID Application identity with VIBEMIC_MAC_SIGNING_SHA1.'
fi

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
export PATH="$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
command -v cargo >/dev/null || fail 'Install a stable Rust toolchain with rustup.'
if [[ ! -d desktop/node_modules/@tauri-apps/cli ]]; then npm --prefix desktop ci; fi
destination="$root/build/source-release/macos"
if "$distribution"; then destination+="-distribution"
elif "$signed"; then destination+="-signed"; fi
mkdir -p "$destination"
stage=$(mktemp -d "$root/build/macos-package.XXXXXX")
mount=$(mktemp -d /private/tmp/vibemic-dmg.XXXXXX)
mounted=false
cleanup() {
  if "$mounted"; then
    hdiutil detach "$mount" -quiet || { echo "Detach $mount before removing $stage." >&2; return; }
  fi
  rmdir "$mount"
  rm -rf -- "$stage"
}
trap cleanup EXIT

verify_signer() {
  if ! "$signed"; then return; fi
  local prefix="$stage/signing-certificate-"
  /usr/bin/codesign -d --extract-certificates="$prefix" "$1"
  local actual
  actual=$(shasum -a 1 "${prefix}0" | awk '{print toupper($1)}')
  [[ "$actual" == "$identity" ]] || fail "Unexpected signing identity in $1."
}

version=$(node -p 'require("./desktop/package.json").version')
for arch in "${architectures[@]}"; do
  case "$arch" in
    arm64) target=aarch64-apple-darwin; expected=arm64 ;;
    x64) target=x86_64-apple-darwin; expected=x86_64 ;;
  esac
  rustup target add "$target" >/dev/null
  env -u VIBEMIC_NEMO_RUNTIME -u VIBEMIC_DRAFT_HELPER -u VIBEMIC_RESOURCES \
    VIBEMIC_MAC_ARCH="$arch" node script/prepare_desktop.mjs
  if "$signed"; then
    export APPLE_SIGNING_IDENTITY="$identity"
  else
    export APPLE_SIGNING_IDENTITY=-
  fi
  # Tauri stages resources in release/VibeMic without clearing removed files.
  rm -rf "desktop/src-tauri/target/$target/release/VibeMic"
  # CI=true skips the Finder AppleScript, matching GitHub Actions runners.
  env -u CSC_LINK -u CSC_NAME -u CSC_KEY_PASSWORD CI=true \
    npm --prefix desktop run dist -- --target "$target" --bundles dmg
  unset APPLE_SIGNING_IDENTITY

  built=$(find "desktop/src-tauri/target/$target/release/bundle/dmg" -name '*.dmg' -type f)
  [[ -n "$built" && "$built" != *$'\n'* ]] || fail "Expected one DMG for $arch."
  dmg="$stage/VibeMic-$version-$arch.dmg"
  mv -f -- "$built" "$dmg"
  hdiutil verify "$dmg"
  hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount" "$dmg"
  mounted=true
  app="$mount/VibeMic.app"
  contents="$app/Contents"
  packed="$contents/Resources/vibemic"
  /usr/bin/codesign --verify --deep --strict "$app"
  verify_signer "$app"
  [[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$contents/Info.plist") == "$version" ]] \
    || fail "Unexpected version in $app."
  executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$contents/Info.plist")
  for binary in "$contents/MacOS/$executable" "$packed/engine/nemo/bin/nemo-speech" \
      "$packed/engine/vibemic-desktop-draft"; do
    [[ $(lipo -archs "$binary") == "$expected" ]] || fail "Unexpected architecture in $binary."
    /usr/bin/codesign --verify --strict "$binary"
    verify_signer "$binary"
  done
  for binary in "$packed/engine/nemo/lib/"*.dylib; do
    [[ -L "$binary" ]] && continue
    [[ $(lipo -archs "$binary") == "$expected" ]] || fail "Unexpected architecture in $binary."
    /usr/bin/codesign --verify --strict "$binary"
    verify_signer "$binary"
  done
  for uf2 in "$root/build/desktop-resources/firmware/"*.uf2; do cmp "$uf2" "$packed/firmware/${uf2##*/}"; done
  hdiutil detach "$mount" -quiet
  mounted=false

  if "$signed"; then
    /usr/bin/codesign --verify --strict "$dmg"
    verify_signer "$dmg"
  fi
  if "$distribution"; then
    receipt="$stage/notary-$arch.json"
    submit_status=0
    xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait --timeout 30m --output-format json > "$receipt" || submit_status=$?
    status=$(/usr/bin/plutil -extract status raw -o - "$receipt" 2>/dev/null || true)
    if [[ "$submit_status" != 0 || "$status" != Accepted ]]; then
      cat "$receipt" >&2
      if [[ "$status" == Invalid || "$status" == Rejected ]]; then
        if submission_id=$(/usr/bin/plutil -extract id raw -o - "$receipt" 2>/dev/null); then
          xcrun notarytool log "$submission_id" "${notary_args[@]}" >&2 || true
        fi
      fi
      fail 'The notarization request failed.'
    fi
    cat "$receipt"
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
    /usr/bin/codesign --verify --strict "$dmg"
    spctl --assess --verbose=2 --type open --context context:primary-signature "$dmg"
  fi
  mv -f -- "$dmg" "$destination/"
  printf 'Verified %s/%s\n' "$destination" "${dmg##*/}"
done
