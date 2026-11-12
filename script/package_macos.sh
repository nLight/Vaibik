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
  profile=${VIBEMIC_MAC_NOTARY_PROFILE:-}
  [[ -n "$profile" ]] || fail 'Set VIBEMIC_MAC_NOTARY_PROFILE to a notarytool keychain profile.'
  notary_args=(--keychain-profile "$profile")
  if [[ -n "${VIBEMIC_MAC_NOTARY_KEYCHAIN:-}" ]]; then
    notary_args+=(--keychain "$VIBEMIC_MAC_NOTARY_KEYCHAIN")
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
if [[ ! -x desktop/node_modules/.bin/electron-builder ]]; then npm --prefix desktop ci; fi
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
  output="$stage/$arch"
  resources="$stage/resources-$arch"
  config="$stage/electron-builder.json"
  env -u VIBEMIC_NEMO_RUNTIME -u VIBEMIC_DRAFT_HELPER \
    VIBEMIC_MAC_ARCH="$arch" VIBEMIC_RESOURCES="$resources" node script/prepare_desktop.mjs
  node - "$config" "$output" "$resources" "$identity" <<'JS'
const fs = require('node:fs');
const { build } = require('./desktop/package.json');
const [config, output, resources, identity] = process.argv.slice(2);
build.directories.output = output;
build.extraResources[0].from = resources;
build.npmRebuild = false;
Object.assign(build.mac, { identity, notarize: false, forceCodeSigning: true });
build.dmg = { artifactName: 'VibeMic-${version}-${arch}.dmg', sign: identity !== '-' };
fs.writeFileSync(config, JSON.stringify(build));
JS
  env -u CSC_LINK -u CSC_NAME -u CSC_KEY_PASSWORD \
    npm --prefix desktop run dist -- --mac dmg "--$arch" --config "$config"

  dmg="$output/VibeMic-$version-$arch.dmg"
  hdiutil verify "$dmg"
  hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount" "$dmg"
  mounted=true
  app="$mount/VibeMic.app"
  contents="$app/Contents"
  packed="$contents/Resources/vibemic"
  pty="$contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-$arch"
  expected="$arch"
  if [[ "$arch" == x64 ]]; then expected=x86_64; fi
  /usr/bin/codesign --verify --deep --strict "$app"
  verify_signer "$app"
  [[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$contents/Info.plist") == "$version" ]] \
    || fail "Unexpected version in $app."
  for binary in "$contents/MacOS/VibeMic" "$packed/engine/nemo/bin/nemo-speech" \
      "$packed/engine/vibemic-desktop-draft" "$pty/spawn-helper" "$pty/pty.node"; do
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
  for uf2 in "$resources"/firmware/*.uf2; do cmp "$uf2" "$packed/firmware/${uf2##*/}"; done
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
