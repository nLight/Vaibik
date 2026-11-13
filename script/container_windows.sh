#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends cmake python3 make g++ curl wget file ca-certificates unzip \
  nsis llvm clang lld g++-mingw-w64-x86-64-posix >/tmp/vibemic-apt.log
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
. "$HOME/.cargo/env"
cargo install cargo-xwin --locked
rustup target add x86_64-pc-windows-msvc
work=/tmp/vibemic-work
mkdir -p "$work/desktop" "$work/script"
cp -R /source/desktop/{ui,assets,src-tauri,package.json,package-lock.json,vite.config.js} "$work/desktop/"
cp /source/script/prepare_desktop.mjs "$work/script/"
cp -R /source/host/windows "$work/windows-helper"
for image in tx rx tx-s140v7 rx-s140v7 tx-probe tx-probe-s140v7 tx-v2-battery tx-v2-battery-s140v7; do
  destination="$work/build/promicro-$image/zephyr"
  mkdir -p "$destination"
  cp "/source/build/promicro-$image/zephyr/zephyr.uf2" "$destination/"
done
cd "$work"
url=https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.3.0/nemo-speech-0.3.0-windows-x86_64-cpu.zip
curl -fsSL "$url" -o nemo-win.zip
printf '%s\n' '4ed9740e361e4653f56c3dce7d1e81883a1c8b831c1bd7d01567fff1130b5b05  nemo-win.zip' | sha256sum -c
mkdir -p build/nemo-win
unzip -q nemo-win.zip -d build/nemo-win
cat > toolchain.cmake <<'CMAKE'
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc-posix)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++-posix)
set(CMAKE_EXE_LINKER_FLAGS_INIT "-static -static-libgcc -static-libstdc++")
CMAKE
cmake -S windows-helper -B build/helper-win -DCMAKE_TOOLCHAIN_FILE="$work/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release
cmake --build build/helper-win
npm --prefix desktop ci
VIBEMIC_NEMO_RUNTIME="$work/build/nemo-win/nemo-speech-0.3.0-windows-x86_64-cpu" \
  VIBEMIC_DRAFT_HELPER="$work/build/helper-win/vibemic-desktop-draft.exe" \
  node script/prepare_desktop.mjs
npm --prefix desktop run dist -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
cp "$work"/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe /output/