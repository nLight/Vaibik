import { test } from 'node:test';
import assert from 'node:assert/strict';

test('battery estimates remain bounded and never infer charge from USB voltage', async () => {
    const { batteryPercent, decodeBattery } = await import('../ui/src/battery.mjs');
    assert.equal(batteryPercent(4200), 100);
    assert.equal(batteryPercent(3850), 50);
    assert.equal(batteryPercent(3300), 0);
    assert.equal(batteryPercent(5000), null);
    for (let mv = 2801; mv <= 4350; mv++) assert.ok(batteryPercent(mv) >= batteryPercent(mv - 1));
    const report = new DataView(new Uint8Array([1, 4, 1, 0, 0, 0, 0, 0]).buffer);
    report.setUint16(4, 3850, true);
    assert.deepEqual(decodeBattery(report), { millivolts: 3850, usbPower: false, percent: 50 });
    report.setUint8(2, 3);
    assert.deepEqual(decodeBattery(report), { millivolts: 3850, usbPower: true, percent: null });
    report.setUint8(2, 0);
    assert.equal(decodeBattery(report), null); // Unmeasured reports must have zero voltage.
    report.setUint16(4, 0, true);
    assert.deepEqual(decodeBattery(report), { millivolts: null, usbPower: false, percent: null });
    report.setUint8(6, 1);
    assert.equal(decodeBattery(report), null);
});