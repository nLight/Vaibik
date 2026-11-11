#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends cmake g++ make python3 pkg-config libarchive-tools \
  libasound2 libgbm1 libgtk-3-0 libnss3 libxss1 xvfb xauth >/tmp/vibemic-apt.log
work=/tmp/vibemic-work
mkdir -p "$work/desktop" "$work/script"
cp -R /source/desktop/{src,ui,assets,package.json,package-lock.json} "$work/desktop/"
cp /source/script/{prepare_desktop.mjs,review_desktop.cjs} "$work/script/"
for image in tx rx tx-s140v7 rx-s140v7 tx-probe tx-probe-s140v7 tx-v2-battery tx-v2-battery-s140v7; do
  destination="$work/build/promicro-$image/zephyr"
  mkdir -p "$destination"
  cp "/source/build/promicro-$image/zephyr/zephyr.uf2" "$destination/"
done
cd "$work"
npm --prefix desktop ci
node desktop/node_modules/electron/install.js
node script/prepare_desktop.mjs
npm --prefix desktop run dist -- --linux deb
cp "$work"/build/desktop-dist/*.deb /output/
npm --prefix desktop run dist -- --linux AppImage \
  --prepackaged "$work/build/desktop-dist/linux-unpacked" -c.toolsets.appimage=1.0.3
cp "$work"/build/desktop-dist/*.AppImage /output/
if [[ "${VIBEMIC_UI_REVIEW:-}" == 1 ]]; then
  VIBEMIC_REVIEW_DIRECTORY=/output/ui-review-linux xvfb-run -a \
    npm --prefix desktop start -- --fixture --no-sandbox --disable-gpu
fi
