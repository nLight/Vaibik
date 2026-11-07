#!/bin/sh
set -eu
if [ "$(uname -s)" = Darwin ] && [ -z "${SDKROOT:-}" ]; then
    SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
    export SDKROOT
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -pedantic -I"$root/firmware/common" \
    "$root/tests/host.c" "$root/firmware/common/protocol.c" \
    "$root/firmware/common/playout.c" -o "$scratch/host-test"
"$scratch/host-test"
