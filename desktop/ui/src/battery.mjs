// Approximate 1-cell LiPo state of charge at rest. USB voltage cannot establish SOC.
const curve = [[3300, 0], [3500, 5], [3600, 10], [3700, 20], [3750, 30],
    [3800, 40], [3850, 50], [3900, 60], [3950, 70], [4000, 80], [4100, 90], [4200, 100]];

export function batteryPercent(millivolts) {
    if (!Number.isInteger(millivolts) || millivolts < 2800 || millivolts > 4350) return null;
    if (millivolts <= curve[0][0]) return 0;
    for (let i = 1; i < curve.length; i++) {
        const [high, percent] = curve[i];
        const [low, previous] = curve[i - 1];
        if (millivolts <= high) return Math.round(previous + (millivolts - low) * (percent - previous) / (high - low));
    }
    return 100;
}

export function decodeBattery(data) {
    if (data.byteLength !== 8 || data.getUint8(0) !== 1 || data.getUint8(1) !== 4 ||
        data.getUint8(2) > 3 || data.getUint8(3) !== 0 || data.getUint16(6, true) !== 0) return null;
    const flags = data.getUint8(2);
    const millivolts = data.getUint16(4, true);
    if (flags & 1 ? batteryPercent(millivolts) === null : millivolts !== 0) return null;
    const usbPower = Boolean(flags & 2);
    return { millivolts: flags & 1 ? millivolts : null, usbPower,
        percent: flags & 1 && !usbPower ? batteryPercent(millivolts) : null };
}
