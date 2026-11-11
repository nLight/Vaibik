#include "battery.h"

#include <hal/nrf_power.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#if defined(CONFIG_VIBEMIC_BATTERY_VDDH) || defined(CONFIG_VIBEMIC_BATTERY_DIVIDER)
#include <zephyr/dt-bindings/adc/nrf-saadc.h>
#include <zephyr/drivers/adc.h>
#endif

static atomic_t voltage;

#if defined(CONFIG_VIBEMIC_BATTERY_VDDH) || defined(CONFIG_VIBEMIC_BATTERY_DIVIDER)
static const struct device *const adc = DEVICE_DT_GET(DT_NODELABEL(adc));
static void sample(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(measurement, sample);

static void sample(struct k_work *work)
{
	ARG_UNUSED(work);
	int16_t raw;
	struct adc_sequence sequence = {
		.channels = BIT(0), .buffer = &raw, .buffer_size = sizeof(raw),
		.resolution = 12, .oversampling = 4,
	};
	int32_t mv = 0;
	if (adc_read(adc, &sequence) == 0) {
		mv = raw;
		if (adc_raw_to_millivolts(adc_ref_internal(adc), ADC_GAIN_1_6, 12, &mv) == 0) {
#if defined(CONFIG_VIBEMIC_BATTERY_VDDH)
			mv *= 5;
#else
			mv = (mv * 2806 + 1000) / 2000;
#endif
		} else {
			mv = 0;
		}
	}
	atomic_set(&voltage, mv >= 2800 && mv <= 4350 ? mv : 0);
	k_work_reschedule(&measurement, K_SECONDS(5));
}
#endif

void vm_battery_start(void)
{
#if defined(CONFIG_VIBEMIC_BATTERY_VDDH) || defined(CONFIG_VIBEMIC_BATTERY_DIVIDER)
	const struct adc_channel_cfg channel = {
		.gain = ADC_GAIN_1_6, .reference = ADC_REF_INTERNAL,
		.acquisition_time = ADC_ACQ_TIME(ADC_ACQ_TIME_MICROSECONDS, 40),
		.channel_id = 0,
#if defined(CONFIG_VIBEMIC_BATTERY_VDDH)
		.input_positive = NRF_SAADC_VDDHDIV5,
#else
		.input_positive = NRF_SAADC_AIN2,
#endif
	};
	if (device_is_ready(adc) && adc_channel_setup(adc, &channel) == 0) {
		k_work_reschedule(&measurement, K_NO_WAIT);
	}
#endif
}

struct vm_battery vm_battery_read(void)
{
	uint16_t mv = (uint16_t)atomic_get(&voltage);
	bool usb = nrf_power_usbregstatus_vbusdet_get(NRF_POWER);

	return (struct vm_battery){ .millivolts = mv,
		.flags = (mv ? VM_BATTERY_VALID : 0) | (usb ? VM_BATTERY_USB_POWER : 0) };
}
