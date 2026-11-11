#!/usr/bin/env bash
set -euo pipefail

# Set up the same Nordic and Zephyr versions used for the bench images.
scratch="${RUNNER_TEMP:?RUNNER_TEMP must be set}"
ncs="$scratch/ncs"
sdk="$scratch/zephyr-sdk-1.0.1"
sdk_release=https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v1.0.1
bundle=zephyr-sdk-1.0.1_linux-x86_64_minimal.tar.xz
toolchain=toolchain_gnu_linux-x86_64_arm-zephyr-eabi.tar.xz

download() {
  curl --fail --location --retry 3 --silent --show-error "$sdk_release/$1" -o "$scratch/$1"
  printf '%s  %s\n' "$2" "$scratch/$1" | sha256sum --check
}

download "$bundle" ca9bc0ff66fafca1dac9d592a36d953cf16d096a9d09b1c0357f021cf9f6a7eb
download "$toolchain" 21b85981cb5a1818d9bc53d82af80f208946ec038b982ff1907287572ed3a634
tar -xJf "$scratch/$bundle" -C "$scratch"
mkdir -p "$sdk/gnu"
tar -xJf "$scratch/$toolchain" -C "$sdk/gnu"

python3 -m venv "$scratch/ncs-python"
export PATH="$scratch/ncs-python/bin:$PATH"
python -m pip install 'west==1.4.0'
west init -m https://github.com/nrfconnect/sdk-nrf --mr v3.4.2 --clone-opt=--depth=1 "$ncs"
(
  cd "$ncs"
  # Resolve the modules through Nordic's manifest. The nRF52840 build
  # uses these modules, so the runner need not clone the full SDK.
  west config -- manifest.project-filter '-.*,+zephyr,+nrfxlib,+hal_nordic,+cmsis_6,+picolibc'
  west update --narrow --fetch-opt=--depth=1
  python -m pip install -r zephyr/scripts/requirements-base.txt -r nrf/scripts/requirements.txt
)

ZEPHYR_SDK_INSTALL_DIR="$sdk" ZEPHYR_TOOLCHAIN_VARIANT=zephyr \
  VIBEMIC_NCS_WORKSPACE="$ncs" ./script/build_firmware.sh
