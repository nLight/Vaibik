#ifndef VIBEMIC_PLAYOUT_H
#define VIBEMIC_PLAYOUT_H

#include "protocol.h"

#define VM_USB_FRAME_SAMPLES (VM_SAMPLE_RATE / 1000u)
#define VM_JITTER_SAMPLES (30u * VM_USB_FRAME_SAMPLES)
#define VM_PLAYOUT_BLOCKS 128u
#define VM_PLAYOUT_CAPACITY (VM_PLAYOUT_BLOCKS * VM_BLOCK_SAMPLES)

struct vm_playout_slot {
	uint32_t timestamp;
	bool valid;
	int16_t pcm[VM_BLOCK_SAMPLES];
};

/* Caller serializes radio insertion and USB consumption. */
struct vm_playout {
	struct vm_playout_slot slots[VM_PLAYOUT_BLOCKS];
	uint32_t cursor;
	uint32_t head;
	uint32_t end;
	uint32_t target_depth;
	uint32_t concealed;
	uint32_t dropped;
	uint8_t frames;
	bool started;
	bool ending;
};

void vm_playout_reset(struct vm_playout *p, uint32_t start);
bool vm_playout_push(struct vm_playout *p, uint32_t timestamp, const int16_t *pcm);
void vm_playout_end(struct vm_playout *p, uint32_t timestamp);
bool vm_playout_begin(struct vm_playout *p);
bool vm_playout_drained(const struct vm_playout *p);
void vm_playout_read(struct vm_playout *p, int16_t pcm[VM_USB_FRAME_SAMPLES]);

#endif
