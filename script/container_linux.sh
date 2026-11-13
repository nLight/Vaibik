#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends cmake g++ make python3 pkg-config libarchive-tools \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  libudev-dev libasound2-dev libssl-dev curl wget file ca-certificates >/tmp/vibemic-apt.log
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
. "$HOME/.cargo/env"
work=/tmp/vibemic-work
mkdir -p "$work/desktop" "$work/script"
cp -R /source/desktop/{ui,assets,src-tauri,package.json,package-lock.json,vite.config.js} "$work/desktop/"
cp /source/script/prepare_desktop.mjs "$work/script/"
for image in tx rx tx-s140v7 rx-s140v7 tx-probe tx-probe-s140v7 tx-v2-battery tx-v2-battery-s140v7; do
  destination="$work/build/promicro-$image/zephyr"
  mkdir -p "$destination"
  cp "/source/build/promicro-$image/zephyr/zephyr.uf2" "$destination/"
done
cd "$work"
npm --prefix desktop ci
node script/prepare_desktop.mjs
# linuxdeploy cannot mount FUSE inside the container.
export APPIMAGE_EXTRACT_AND_RUN=1
npm --prefix desktop run dist -- --bundles deb,appimage
cp "$work"/desktop/src-tauri/target/release/bundle/deb/*.deb /output/
cp "$work"/desktop/src-tauri/target/release/bundle/appimage/*.AppImage /output/