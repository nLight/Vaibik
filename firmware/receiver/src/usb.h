#ifndef VIBEMIC_USB_H
#define VIBEMIC_USB_H

#include "playout.h"

enum vm_end_reason {
	VM_END_NONE,
	VM_END_RELEASED,
	VM_END_RADIO_TIMEOUT,
	VM_END_HOST_TIMEOUT,
	VM_END_USB_STOPPED,
	VM_END_SUPERSEDED,
};

struct vm_link_stats {
	enum vm_end_reason reason;
	uint32_t concealed_samples;
	uint32_t usb_errors;
	uint8_t weakest_rssi; /* RSSISAMPLE magnitude in -dBm, or zero if unavailable. */
};

int vm_usb_init(void);
int vm_usb_key(bool down, const struct vm_link_stats *stats);
bool vm_usb_key_sent(void);
bool vm_usb_stream_ready(uint32_t *since);
uint32_t vm_usb_frame_errors(void);

/* Called by the USB stack for each 1 ms frame while the microphone is open. */
void vm_usb_render(int16_t pcm[VM_USB_FRAME_SAMPLES]);

#endif
