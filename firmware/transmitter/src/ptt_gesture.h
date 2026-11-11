#ifndef VIBEMIC_PTT_GESTURE_H
#define VIBEMIC_PTT_GESTURE_H

#include "protocol.h"

#define VM_MIN_TAP_BLOCKS (25u / VM_BLOCK_MS)
#define VM_HOLD_BLOCKS (125u / VM_BLOCK_MS)
#define VM_TAP_GAP_BLOCKS (350u / VM_BLOCK_MS)

struct vm_ptt_gesture {
	uint32_t pressed_at, tapped_at;
	bool pressed, recording, armed;
};

/* Time is measured in captured audio blocks, after GPIO debounce. */
static inline enum vm_flag vm_ptt_step(struct vm_ptt_gesture *ptt, bool pressed,
				       uint32_t now, bool gestures)
{
	if (pressed && !ptt->pressed) {
		ptt->pressed_at = now;
		ptt->armed = ptt->armed && now - ptt->tapped_at <= VM_TAP_GAP_BLOCKS;
	}
	bool was_pressed = ptt->pressed;
	ptt->pressed = pressed;
	uint32_t held = now - ptt->pressed_at;

	if (pressed && !ptt->recording && (!gestures || held >= VM_HOLD_BLOCKS)) {
		ptt->armed = false;
		ptt->recording = true;
		return VM_PTT_DOWN;
	}
	if (pressed || !was_pressed) {
		return 0;
	}
	if (ptt->recording) {
		ptt->recording = false;
		return VM_PTT_UP;
	}
	if (held < VM_MIN_TAP_BLOCKS) {
		ptt->armed = false;
		return 0;
	}
	if (ptt->armed) {
		ptt->armed = false;
		return VM_APPROVAL_COMMIT;
	}
	ptt->tapped_at = now;
	ptt->armed = true;
	return VM_APPROVAL_ARM;
}

#endif
