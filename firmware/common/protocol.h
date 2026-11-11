#ifndef VIBEMIC_PROTOCOL_H
#define VIBEMIC_PROTOCOL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VM_SAMPLE_RATE 16000u
#define VM_BLOCK_MS 5u
#define VM_BLOCK_SAMPLES (VM_SAMPLE_RATE * VM_BLOCK_MS / 1000u)
#define VM_PCM_BYTES (2u * VM_BLOCK_SAMPLES)
#define VM_HEADER_BYTES 12u
#define VM_AUDIO_BYTES (VM_HEADER_BYTES + VM_PCM_BYTES)
#define VM_BATTERY_BYTES (VM_HEADER_BYTES + 4u)
#define VM_PROTOCOL_VERSION 1u

enum vm_flag {
	VM_PTT_DOWN = 1u << 0,
	VM_PTT_UP = 1u << 1,
	VM_AUDIO = 1u << 2,
	VM_PAIRING = 1u << 3,        /* Reserved. */
	VM_BATTERY_STATUS = 1u << 4,
	VM_HEARTBEAT = 1u << 5,      /* Reserved; audio serves as keepalive. */
	VM_APPROVAL_ARM = 1u << 6,
	VM_APPROVAL_COMMIT = 1u << 7,
};

enum vm_battery_flag {
	VM_BATTERY_VALID = 1u << 0,
	VM_BATTERY_USB_POWER = 1u << 1, /* Power present; does not imply charging. */
};

struct vm_battery {
	uint16_t millivolts;
	uint8_t flags;
};

struct vm_header {
	uint8_t flags;
	uint16_t sequence;
	uint32_t timestamp; /* Sample index within the utterance, including pre-roll. */
	uint32_t session;
};

void vm_encode(uint8_t *out, uint8_t flags, uint32_t session, uint32_t block,
	       const int16_t *pcm);
bool vm_decode(const uint8_t *wire, size_t size, struct vm_header *header);
void vm_decode_pcm(const uint8_t *wire, int16_t *pcm);
void vm_encode_battery(uint8_t *wire, const struct vm_battery *battery);
void vm_decode_battery(const uint8_t *wire, struct vm_battery *battery);

#endif
