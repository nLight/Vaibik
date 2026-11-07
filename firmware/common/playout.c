#include "playout.h"

#include <string.h>

#define VM_DRIFT_DEADBAND (20u * VM_USB_FRAME_SAMPLES)

static struct vm_playout_slot *slot_for(struct vm_playout *p, uint32_t timestamp)
{
	return &p->slots[timestamp / VM_BLOCK_SAMPLES % VM_PLAYOUT_BLOCKS];
}

static uint32_t depth(const struct vm_playout *p)
{
	return p->head > p->cursor ? p->head - p->cursor : 0;
}

void vm_playout_reset(struct vm_playout *p, uint32_t start)
{
	for (unsigned i = 0; i < VM_PLAYOUT_BLOCKS; i++) {
		p->slots[i].valid = false;
	}
	p->cursor = start;
	p->head = start;
	p->end = 0;
	p->target_depth = 0;
	p->concealed = 0;
	p->dropped = 0;
	p->frames = 0;
	p->started = false;
	p->ending = false;
}

bool vm_playout_push(struct vm_playout *p, uint32_t timestamp, const int16_t *pcm)
{
	uint32_t end = timestamp + VM_BLOCK_SAMPLES;
	struct vm_playout_slot *slot = slot_for(p, timestamp);

	if (p->ending || end <= p->cursor ||
	    (timestamp >= p->cursor && timestamp - p->cursor >= VM_PLAYOUT_CAPACITY) ||
	    (slot->valid && slot->timestamp >= p->cursor - p->cursor % VM_BLOCK_SAMPLES)) {
		p->dropped++;
		return false;
	}
	memcpy(slot->pcm, pcm, sizeof(slot->pcm));
	slot->timestamp = timestamp;
	slot->valid = true;
	if (end > p->head) {
		p->head = end;
	}
	return true;
}

void vm_playout_end(struct vm_playout *p, uint32_t timestamp)
{
	/* Limit concealment to at most one buffer if a broken sender jumps ahead. */
	p->end = timestamp > p->cursor && timestamp - p->cursor > VM_PLAYOUT_CAPACITY
		 ? p->head : timestamp;
	p->ending = true;
}

bool vm_playout_begin(struct vm_playout *p)
{
	if (!p->ending && depth(p) < VM_JITTER_SAMPLES) {
		return false;
	}
	p->target_depth = depth(p);
	p->started = true;
	return true;
}

bool vm_playout_drained(const struct vm_playout *p)
{
	return p->ending && p->cursor >= p->end;
}

static int16_t next_sample(struct vm_playout *p)
{
	if (vm_playout_drained(p)) {
		return 0;
	}

	uint32_t timestamp = p->cursor++;
	struct vm_playout_slot *slot = slot_for(p, timestamp);
	unsigned offset = timestamp % VM_BLOCK_SAMPLES;

	if (slot->valid && slot->timestamp == timestamp - offset) {
		return slot->pcm[offset];
	}
	p->concealed++;
	return 0;
}

void vm_playout_read(struct vm_playout *p, int16_t pcm[VM_USB_FRAME_SAMPLES])
{
	if (!p->started) {
		memset(pcm, 0, VM_USB_FRAME_SAMPLES * sizeof(*pcm));
		return;
	}

	/* USB is clocked by SOF; the transmitter has an independent crystal.
	 * Occasionally blend across one dropped/duplicated sample if depth drifts.
	 */
	int slip = 0;
	if (!p->ending && (++p->frames % 32u == 0)) {
		uint32_t queued = depth(p);
		if (queued > p->target_depth + VM_DRIFT_DEADBAND) {
			slip = 1;
		} else if (queued >= VM_JITTER_SAMPLES &&
			   queued + VM_DRIFT_DEADBAND < p->target_depth) {
			slip = -1;
		}
	}
	for (unsigned i = 0; i < VM_USB_FRAME_SAMPLES; i++) {
		if (i == VM_USB_FRAME_SAMPLES / 2u && slip < 0) {
			pcm[i] = pcm[i - 1u];
		} else {
			pcm[i] = next_sample(p);
			if (i == VM_USB_FRAME_SAMPLES / 2u && slip > 0) {
				pcm[i] = (int16_t)(((int32_t)pcm[i] + next_sample(p)) / 2);
			}
		}
	}
}
