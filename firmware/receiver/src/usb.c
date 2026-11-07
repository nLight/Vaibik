#include "usb.h"

#include <errno.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/usb/class/hid.h>
#include <zephyr/usb/class/usbd_hid.h>
#include <zephyr/usb/class/usbd_uac2.h>
#include <zephyr/usb/usbd.h>

#define USB_RATE DT_PROP_BY_IDX(DT_NODELABEL(ptt_clock), sampling_frequencies, 0)
#define USB_FRAME_BYTES (2u * (USB_RATE / 1000u))
#define USB_SOF_TIMEOUT_MS 100u
#define F13_USAGE 0x68
#define KEY_USAGE_MAX 0x73
#define VIBEMIC_HID_PAGE 0xff31
#define VIBEMIC_HID_USAGE 0x01
#define VIBEMIC_HID_VERSION 1
#define VIBEMIC_USB_PID (IS_ENABLED(CONFIG_VIBEMIC_VENDOR_HID) ? 0x0003 : 0x0001)
#define MODIFIERS (HID_KBD_MODIFIER_LEFT_CTRL | HID_KBD_MODIFIER_LEFT_ALT | \
		   HID_KBD_MODIFIER_LEFT_UI)

BUILD_ASSERT(USB_RATE == VM_SAMPLE_RATE || USB_RATE == 3u * VM_SAMPLE_RATE);

/* Shared private test VID/PID: https://pid.codes/1209/0001/
 * Not unique; replace before distributing, manufacturing or selling a device.
 */
USBD_DEVICE_DEFINE(vibemic, DEVICE_DT_GET(DT_NODELABEL(zephyr_udc0)), 0x1209, VIBEMIC_USB_PID);
USBD_DESC_LANG_DEFINE(vibemic_lang);
USBD_DESC_MANUFACTURER_DEFINE(vibemic_mfr, "VibeMic");
USBD_DESC_PRODUCT_DEFINE(vibemic_name, "PTT Dictation Mic");
USBD_DESC_SERIAL_NUMBER_DEFINE(vibemic_serial);
USBD_CONFIGURATION_DEFINE(vibemic_fs, 0, 50, NULL); /* Bus powered, 100 mA. */

static const struct device *const keyboard = DEVICE_DT_GET(DT_NODELABEL(ptt_keyboard));
static const struct device *const mic = DEVICE_DT_GET(DT_NODELABEL(ptt_mic));

static const uint8_t ptt_descriptor[] = {
#if defined(CONFIG_VIBEMIC_VENDOR_HID)
	HID_USAGE_PAGE16(VIBEMIC_HID_PAGE),
	HID_USAGE(VIBEMIC_HID_USAGE),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
	HID_USAGE(VIBEMIC_HID_USAGE),
	HID_LOGICAL_MIN8(0), HID_LOGICAL_MAX16(255, 0),
	HID_REPORT_SIZE(8), HID_REPORT_COUNT(8), HID_INPUT(0x02),
	HID_END_COLLECTION,
#else
	/* The stock Zephyr keyboard descriptor stops at 0x65, below F13. */
	HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP),
	HID_USAGE(HID_USAGE_GEN_DESKTOP_KEYBOARD),
	HID_COLLECTION(HID_COLLECTION_APPLICATION),
	HID_USAGE_PAGE(HID_USAGE_GEN_DESKTOP_KEYPAD),
	HID_USAGE_MIN8(0xe0), HID_USAGE_MAX8(0xe7),
	HID_LOGICAL_MIN8(0), HID_LOGICAL_MAX8(1),
	HID_REPORT_SIZE(1), HID_REPORT_COUNT(8), HID_INPUT(0x02),
	HID_REPORT_SIZE(8), HID_REPORT_COUNT(1), HID_INPUT(0x03),
	HID_USAGE_MIN8(0), HID_USAGE_MAX8(KEY_USAGE_MAX),
	HID_LOGICAL_MIN8(0), HID_LOGICAL_MAX8(KEY_USAGE_MAX),
	HID_REPORT_SIZE(8), HID_REPORT_COUNT(6), HID_INPUT(0x00),
	HID_END_COLLECTION,
#endif
};

static uint8_t key_report[8] __aligned(4);
static atomic_t key_busy;
static atomic_t key_ready;
static atomic_t key_state;
static atomic_t stream_open;
static atomic_t stream_since;
static atomic_t last_sof;
static atomic_t suspended;
static atomic_t frame_errors;
static int16_t previous;
K_MEM_SLAB_DEFINE(usb_frames, USB_FRAME_BYTES, 4, 4);

static void hid_ready(const struct device *dev, const bool ready)
{
	ARG_UNUSED(dev);
	atomic_set(&key_ready, ready);
	if (!ready) {
		atomic_clear(&key_state);
	}
}

static void hid_done(const struct device *dev, const uint8_t *report)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(report);
	atomic_clear(&key_busy);
}

static void make_report(uint8_t *report, bool down, const struct vm_link_stats *stats)
{
	memset(report, 0, sizeof(key_report));
	if (IS_ENABLED(CONFIG_VIBEMIC_VENDOR_HID)) {
		report[0] = VIBEMIC_HID_VERSION;
		report[1] = down;
		if (!down && stats) {
			uint64_t silent_ms = DIV_ROUND_UP((uint64_t)stats->concealed_samples,
							VM_USB_FRAME_SAMPLES);

			report[2] = stats->reason;
			report[3] = stats->weakest_rssi;
			sys_put_le16(MIN(silent_ms, UINT16_MAX), &report[4]);
			sys_put_le16(MIN(stats->usb_errors, UINT16_MAX), &report[6]);
		}
	} else if (down) {
		report[0] = MODIFIERS;
		report[2] = F13_USAGE;
	}
}

static int hid_get(const struct device *dev, const uint8_t type, const uint8_t id,
		   const uint16_t len, uint8_t *const buf)
{
	ARG_UNUSED(dev);
	if (type != HID_REPORT_TYPE_INPUT || id != 0 || len < sizeof(key_report)) {
		return -ENOTSUP;
	}
	make_report(buf, atomic_get(&key_state), NULL);
	return sizeof(key_report);
}

static const struct hid_device_ops hid_ops = {
	.iface_ready = hid_ready,
	.get_report = hid_get,
	.input_report_done = hid_done,
};

int vm_usb_key(bool down, const struct vm_link_stats *stats)
{
	if (!atomic_get(&key_ready) || atomic_get(&suspended) ||
	    !atomic_cas(&key_busy, 0, 1)) {
		return -EAGAIN;
	}

	make_report(key_report, down, stats);
	int err = hid_device_submit_report(keyboard, sizeof(key_report), key_report);

	if (err != 0) {
		atomic_clear(&key_busy);
	} else {
		atomic_set(&key_state, down);
	}
	return err;
}

bool vm_usb_key_sent(void)
{
	return atomic_get(&key_ready) && !atomic_get(&suspended) && !atomic_get(&key_busy);
}

static void usb_message(struct usbd_context *ctx, const struct usbd_msg *message)
{
	ARG_UNUSED(ctx);
	if (message->type == USBD_MSG_SUSPEND) {
		atomic_set(&suspended, 1);
	} else if (message->type == USBD_MSG_RESUME || message->type == USBD_MSG_RESET) {
		atomic_clear(&suspended);
	}
}

bool vm_usb_stream_ready(uint32_t *since)
{
	bool open = atomic_get(&stream_open) && !atomic_get(&suspended);

	*since = (uint32_t)atomic_get(&stream_since);
	uint32_t last = (uint32_t)atomic_get(&last_sof);

	return open && k_uptime_get_32() - last < USB_SOF_TIMEOUT_MS;
}

uint32_t vm_usb_frame_errors(void)
{
	return (uint32_t)atomic_get(&frame_errors);
}

static void terminal_update(const struct device *dev, uint8_t terminal, bool enabled,
			    bool microframes, void *data)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(microframes);
	ARG_UNUSED(data);
	if (terminal == UAC2_ENTITY_ID(DT_NODELABEL(ptt_usb_out))) {
		previous = 0;
		uint32_t now = k_uptime_get_32();

		atomic_set(&stream_since, now);
		atomic_set(&last_sof, now);
		atomic_set(&stream_open, enabled);
	}
}

static void release_audio(const struct device *dev, uint8_t terminal, void *buffer, void *data)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(terminal);
	ARG_UNUSED(data);
	k_mem_slab_free(&usb_frames, buffer);
}

static void sof(const struct device *dev, void *data)
{
	int16_t pcm[VM_USB_FRAME_SAMPLES];
	void *buffer;
	uint8_t *bytes;

	ARG_UNUSED(data);
	if (!atomic_get(&stream_open)) {
		return;
	}
	atomic_set(&last_sof, k_uptime_get_32());
	if (k_mem_slab_alloc(&usb_frames, &buffer, K_NO_WAIT) != 0) {
		atomic_inc(&frame_errors);
		return;
	}
	bytes = buffer;
	vm_usb_render(pcm);
	for (unsigned i = 0; i < VM_USB_FRAME_SAMPLES; i++) {
#if USB_RATE == 48000
		/* Interpolate the radio PCM for hosts/apps that prefer 48 kHz. */
		int32_t delta = (int32_t)pcm[i] - previous;
		for (int step = 1; step <= 3; step++) {
			sys_put_le16((uint16_t)(previous + delta * step / 3), bytes);
			bytes += 2;
		}
		previous = pcm[i];
#else
		sys_put_le16((uint16_t)pcm[i], bytes);
		bytes += 2;
#endif
	}

	if (usbd_uac2_send(dev, UAC2_ENTITY_ID(DT_NODELABEL(ptt_usb_out)), buffer,
			  USB_FRAME_BYTES) != 0) {
		k_mem_slab_free(&usb_frames, buffer);
		atomic_inc(&frame_errors);
	}
}

static const struct uac2_ops audio_ops = {
	.sof_cb = sof,
	.terminal_update_cb = terminal_update,
	.buf_release_cb = release_audio,
};

int vm_usb_init(void)
{
	if (!device_is_ready(keyboard) || !device_is_ready(mic)) {
		return -ENODEV;
	}
	usbd_uac2_set_ops(mic, &audio_ops, NULL);

	int err = hid_device_register(keyboard, ptt_descriptor, sizeof(ptt_descriptor),
				      &hid_ops);

	if (err == 0) {
		err = usbd_add_descriptor(&vibemic, &vibemic_lang);
	}
	if (err == 0) {
		err = usbd_add_descriptor(&vibemic, &vibemic_mfr);
	}
	if (err == 0) {
		err = usbd_add_descriptor(&vibemic, &vibemic_name);
	}
	if (err == 0) {
		err = usbd_add_descriptor(&vibemic, &vibemic_serial);
	}
	if (err == 0) {
		err = usbd_add_configuration(&vibemic, USBD_SPEED_FS, &vibemic_fs);
	}
	if (err == 0) {
		err = usbd_register_all_classes(&vibemic, USBD_SPEED_FS, 1, NULL);
	}
	if (err == 0) {
		err = usbd_device_set_code_triple(&vibemic, USBD_SPEED_FS,
						  USB_BCC_MISCELLANEOUS, 0x02, 0x01);
	}
	if (err == 0) {
		err = usbd_msg_register_cb(&vibemic, usb_message);
	}
	if (err == 0) {
		err = usbd_init(&vibemic);
	}
	return err != 0 ? err : usbd_enable(&vibemic);
}
