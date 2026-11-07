#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends cmake python3 make g++ libarchive-tools xvfb xauth \
  libgl1 libx11-6 libfreetype6 libxcursor1 libxi6 libxrandr2 \
  g++-mingw-w64-x86-64-posix >/tmp/vibemic-apt.log
work=/tmp/vibemic-work
mkdir -p "$work/desktop" "$work/build/desktop-resources/engine" "$work/build/desktop-resources/firmware"
cp -R /source/desktop/{src,ui,assets,package.json,package-lock.json} "$work/desktop/"
cp -R /source/host/windows "$work/windows-helper"
for variant in '' -s140v7; do
  cp "/source/build/promicro-tx$variant/zephyr/zephyr.uf2" "$work/build/desktop-resources/firmware/promicro-transmitter$variant.uf2"
  cp "/source/build/promicro-rx$variant/zephyr/zephyr.uf2" "$work/build/desktop-resources/firmware/promicro-receiver$variant.uf2"
  cp "/source/build/promicro-tx-probe$variant/zephyr/zephyr.uf2" "$work/build/desktop-resources/firmware/promicro-mic-probe$variant.uf2"
done
cd "$work"
url=https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.5
curl -fsSL "$url" -o whisper.tar.gz
printf '%s\n' 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720  whisper.tar.gz' | sha256sum -c
tar xf whisper.tar.gz
# MinGW's Windows headers may omit the optional thread power-throttling API.
sed -i 's/#if _WIN32_WINNT >= 0x0602$/#if _WIN32_WINNT >= 0x0602 \&\& defined(THREAD_POWER_THROTTLING_CURRENT_VERSION)/' \
  whisper.cpp-1.9.5/ggml/src/ggml-cpu/ggml-cpu.c
cat > toolchain.cmake <<'CMAKE'
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc-posix)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++-posix)
set(CMAKE_EXE_LINKER_FLAGS_INIT "-static -static-libgcc -static-libstdc++")
CMAKE
cmake -S whisper.cpp-1.9.5 -B build/whisper-win -DCMAKE_TOOLCHAIN_FILE="$work/toolchain.cmake" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
cmake --build build/whisper-win --target whisper-cli --parallel 6
cp build/whisper-win/bin/whisper-cli.exe build/desktop-resources/engine/
cp whisper.cpp-1.9.5/LICENSE build/desktop-resources/engine/LICENSE.whisper.cpp
cmake -S windows-helper -B build/helper-win -DCMAKE_TOOLCHAIN_FILE="$work/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release
cmake --build build/helper-win
cp build/helper-win/vibemic-desktop-draft.exe build/desktop-resources/engine/
npm --prefix desktop ci
# Use the Windows N-API and ConPTY binaries shipped in the npm package.
rm -rf desktop/node_modules/node-pty/build
npm --prefix desktop run dist -- --win zip --x64 -c.npmRebuild=false -c.win.signAndEditExecutable=false
cp "$work"/build/desktop-dist/*.zip /output/
xvfb-run -a npm --prefix desktop run dist -- --win nsis --x64 -c.npmRebuild=false \
  -c.win.signAndEditExecutable=false -c.toolsets.wine=1.0.1 \
  --prepackaged "$work/build/desktop-dist/win-unpacked"
cp "$work"/build/desktop-dist/*.exe /output/
