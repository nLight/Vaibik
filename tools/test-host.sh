#!/bin/sh
set -eu
if [ "$(uname -s)" = Darwin ] && [ -z "${SDKROOT:-}" ]; then
    SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
    export SDKROOT
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
flags="-std=c11 -Wall -Wextra -Werror -pedantic -I$root/firmware/common"
"${CC:-cc}" $flags -I"$root/firmware/transmitter/src" \
    "$root/tests/host.c" "$root/firmware/common/protocol.c" \
    "$root/firmware/common/playout.c" "$root/firmware/transmitter/src/dynamics.c" \
    -o "$scratch/host-test"
"$scratch/host-test"
"${CC:-cc}" $flags -I"$root/tests/zephyr-stub" \
    -DCONFIG_VIBEMIC_DIRECT_USB=0 -DCONFIG_VIBEMIC_TEST_TONE=0 \
    "$root/tests/session.c" "$root/firmware/common/session.c" \
    "$root/firmware/common/protocol.c" "$root/firmware/common/playout.c" \
    -o "$scratch/session-test"
"$scratch/session-test"
