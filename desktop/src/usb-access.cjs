'use strict';

const legacy = 'KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="0003", TAG+="uaccess"';

function usbRuleBody(contents) {
    return contents.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
}

function usbRuleStatus(expected, installed) {
    const body = usbRuleBody(installed);
    return body === usbRuleBody(expected) ? 'configured' : body === legacy ? 'outdated' : 'overridden';
}

const installUsbRule = `set -eu
[ ! -L "$2" ] || exit 1
if [ -e "$2" ]; then
  [ -f "$2" ] && [ "$(cat "$2")" = "$3" ] || exit 1
else
  [ -z "$3" ] || exit 1
fi
temporary=$(mktemp "$2.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
printf '%s\\n' "$1" > "$temporary"
chmod 0644 "$temporary"
mv -f "$temporary" "$2"
udevadm control --reload`;

module.exports = { usbRuleBody, usbRuleStatus, installUsbRule };
