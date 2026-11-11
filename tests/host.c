#include "dynamics.h"
#include "playout.h"
#include "protocol.h"
#include "ptt_gesture.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static struct vm_playout audio;

static void expect_frame(int16_t sample)
{
	int16_t frame[VM_USB_FRAME_SAMPLES];

	memset(frame, 0x42, sizeof(frame));
	vm_playout_read(&audio, frame);
	for (unsigned i = 0; i < VM_USB_FRAME_SAMPLES; i++) {
		assert(frame[i] == sample);
	}
}

static void packet_roundtrip(void)
{
	uint8_t wire[VM_AUDIO_BYTES];
	int16_t pcm[VM_BLOCK_SAMPLES] = {INT16_MIN, INT16_MAX, -1};
	int16_t decoded[VM_BLOCK_SAMPLES];
	struct vm_header header;
	const uint8_t expected[] = {
		1, VM_AUDIO, 0, 0, 0, 0, 0x50, 0, 0x78, 0x56, 0x34, 0x12,
		0, 0x80, 0xff, 0x7f, 0xff, 0xff,
	};

	/* Sequence wraps at 65536, timestamp keeps increasing. */
	vm_encode(wire, VM_AUDIO, 0x12345678, 65536, pcm);
	assert(memcmp(wire, expected, sizeof(expected)) == 0);
	assert(vm_decode(wire, sizeof(wire), &header));
	assert(header.session == 0x12345678 && header.sequence == 0);
	assert(header.timestamp == 65536u * VM_BLOCK_SAMPLES);
	vm_decode_pcm(wire, decoded);
	assert(memcmp(pcm, decoded, sizeof(pcm)) == 0);

	assert(!vm_decode(wire, sizeof(wire) - 1u, &header));
	wire[2] ^= 1;
	assert(!vm_decode(wire, sizeof(wire), &header));
	wire[2] ^= 1;
	wire[0]++;
	assert(!vm_decode(wire, sizeof(wire), &header));
	vm_encode(wire, VM_PTT_DOWN, 123, 0, NULL);
	assert(vm_decode(wire, VM_HEADER_BYTES, &header) && header.flags == VM_PTT_DOWN);
	vm_encode(wire, VM_PTT_DOWN, 123, 1, NULL);
	assert(!vm_decode(wire, VM_HEADER_BYTES, &header));
	vm_encode(wire, VM_PTT_UP, 123, 1, NULL);
	assert(vm_decode(wire, VM_HEADER_BYTES, &header) && header.flags == VM_PTT_UP);
	assert(!vm_decode(wire, VM_HEADER_BYTES + 1u, &header));
	wire[1] = VM_AUDIO | VM_PTT_UP;
	assert(!vm_decode(wire, VM_HEADER_BYTES, &header));

	vm_encode(wire, VM_APPROVAL_ARM, 456, 0, NULL);
	assert(vm_decode(wire, VM_HEADER_BYTES, &header) && header.flags == VM_APPROVAL_ARM);
	assert(header.session == 456);
	vm_encode(wire, VM_APPROVAL_COMMIT, 456, 0, NULL);
	assert(vm_decode(wire, VM_HEADER_BYTES, &header) && header.flags == VM_APPROVAL_COMMIT);
	vm_encode(wire, VM_APPROVAL_COMMIT, 456, 1, NULL);
	assert(!vm_decode(wire, VM_HEADER_BYTES, &header));
}

static void approval_gesture(void)
{
	struct vm_ptt_gesture ptt = {0};

	assert(vm_ptt_step(&ptt, true, 10, true) == 0);
	assert(vm_ptt_step(&ptt, false, 14, true) == 0); /* Too short. */
	assert(vm_ptt_step(&ptt, true, 20, true) == 0);
	assert(vm_ptt_step(&ptt, false, 30, true) == VM_APPROVAL_ARM);
	assert(vm_ptt_step(&ptt, true, 45, true) == 0);
	assert(vm_ptt_step(&ptt, false, 55, true) == VM_APPROVAL_COMMIT);
	assert(vm_ptt_step(&ptt, false, 56, true) == 0);
	assert(vm_ptt_step(&ptt, true, 70, true) == 0);
	assert(vm_ptt_step(&ptt, false, 80, true) == VM_APPROVAL_ARM);
	assert(vm_ptt_step(&ptt, true, 151, true) == 0); /* Gap expired. */
	assert(vm_ptt_step(&ptt, false, 161, true) == VM_APPROVAL_ARM);
	assert(vm_ptt_step(&ptt, true, 165, true) == 0);
	assert(vm_ptt_step(&ptt, true, 189, true) == 0);
	assert(vm_ptt_step(&ptt, true, 190, true) == VM_PTT_DOWN);
	assert(vm_ptt_step(&ptt, true, 191, true) == 0);
	assert(vm_ptt_step(&ptt, false, 193, true) == VM_PTT_UP);
	assert(vm_ptt_step(&ptt, true, 197, true) == 0);
	assert(vm_ptt_step(&ptt, false, 209, true) == VM_APPROVAL_ARM);

	ptt = (struct vm_ptt_gesture){0};
	assert(vm_ptt_step(&ptt, true, UINT32_MAX - 7, true) == 0);
	assert(vm_ptt_step(&ptt, false, 1, true) == VM_APPROVAL_ARM);
	assert(vm_ptt_step(&ptt, true, 3, true) == 0);
	assert(vm_ptt_step(&ptt, false, 12, true) == VM_APPROVAL_COMMIT);

	ptt = (struct vm_ptt_gesture){0};
	assert(vm_ptt_step(&ptt, true, 10, false) == VM_PTT_DOWN);
	assert(vm_ptt_step(&ptt, false, 12, false) == VM_PTT_UP);
}

static void replay_with_loss(void)
{
	int16_t pcm[VM_BLOCK_SAMPLES];

	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		pcm[i] = 123;
	}
	vm_playout_reset(&audio, 0);
	expect_frame(0);
	assert(audio.cursor == 0);
	assert(vm_playout_push(&audio, 2u * VM_BLOCK_SAMPLES, pcm));
	assert(vm_playout_push(&audio, 0, pcm)); /* Out of order. */
	assert(!vm_playout_push(&audio, 0, pcm));
	assert(!vm_playout_begin(&audio)); /* 15 ms < 30 ms. */

	/* Short presses must drain even if there is less than 30 ms of PCM. */
	vm_playout_end(&audio, 4u * VM_BLOCK_SAMPLES);
	assert(vm_playout_begin(&audio));
	for (unsigned block = 0; block < 4; block++) {
		assert(!vm_playout_drained(&audio));
		for (unsigned frame = 0; frame < VM_BLOCK_MS; frame++) {
			expect_frame(block % 2 == 0 ? 123 : 0);
		}
	}
	assert(vm_playout_drained(&audio) && audio.concealed == 2u * VM_BLOCK_SAMPLES);
	expect_frame(0);
}

static void startup_window_and_slot_reuse(void)
{
	int16_t pcm[VM_BLOCK_SAMPLES] = {0};

	vm_playout_reset(&audio, 0);
	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		pcm[i] = -1200;
	}
	assert(vm_playout_push(&audio, 0, pcm));
	memset(pcm, 0, sizeof(pcm));
	for (unsigned i = 1; i < VM_PLAYOUT_BLOCKS; i++) {
		assert(vm_playout_push(&audio, i * VM_BLOCK_SAMPLES, pcm));
	}
	/* Preserve the beginning while the application starts. */
	assert(!vm_playout_push(&audio, VM_PLAYOUT_CAPACITY, pcm));
	assert(vm_playout_begin(&audio));
	for (unsigned i = 0; i < VM_BLOCK_MS; i++) {
		expect_frame(-1200);
	}
	assert(vm_playout_push(&audio, VM_PLAYOUT_CAPACITY, pcm));
	assert(!vm_playout_push(&audio, 0, pcm)); /* Too late. */
	vm_playout_reset(&audio, 0);
	expect_frame(0);
	assert(!vm_playout_begin(&audio));

	/* A delayed audio client gets the latest window after startup exceeds the buffer. */
	for (unsigned i = 0; i <= VM_PLAYOUT_BLOCKS; i++) {
		vm_playout_push_waiting(&audio, i * VM_BLOCK_SAMPLES, pcm);
	}
	assert(audio.cursor == VM_BLOCK_SAMPLES && audio.dropped == 1);
	assert(audio.head == VM_PLAYOUT_CAPACITY + VM_BLOCK_SAMPLES);
	assert(vm_playout_begin(&audio));
	expect_frame(0);
}

static void speech_dynamics(void)
{
	struct vm_dynamics dynamics;
	int16_t pcm[VM_BLOCK_SAMPLES] = {0};

	vm_dynamics_reset(&dynamics);
	vm_dynamics_process(&dynamics, pcm);
	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		assert(pcm[i] == 0);
		pcm[i] = 400;
	}
	vm_dynamics_process(&dynamics, pcm);
	assert(pcm[0] == 1600 && pcm[VM_BLOCK_SAMPLES - 1] == 1600);

	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		pcm[i] = 4000;
	}
	vm_dynamics_process(&dynamics, pcm);
	assert(pcm[VM_BLOCK_SAMPLES - 1] > 7000 && pcm[VM_BLOCK_SAMPLES - 1] < 7500);

	/* A sudden peak after silence must never be amplified past the ceiling. */
	vm_dynamics_reset(&dynamics);
	memset(pcm, 0, sizeof(pcm));
	pcm[0] = INT16_MAX;
	pcm[VM_BLOCK_SAMPLES - 1] = INT16_MIN;
	vm_dynamics_process(&dynamics, pcm);
	assert(pcm[0] > 25990 && pcm[0] <= 26028);
	assert(pcm[VM_BLOCK_SAMPLES - 1] < -25990 && pcm[VM_BLOCK_SAMPLES - 1] >= -26028);

	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		pcm[i] = 400;
	}
	vm_dynamics_process(&dynamics, pcm);
	assert(pcm[0] < pcm[VM_BLOCK_SAMPLES - 1] && pcm[VM_BLOCK_SAMPLES - 1] < 800);

	for (unsigned block = 0; block < 128; block++) {
		for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
			pcm[i] = 400;
		}
		vm_dynamics_process(&dynamics, pcm);
	}
	assert(pcm[VM_BLOCK_SAMPLES - 1] == 1600);
}

int main(void)
{
	uint8_t wire[VM_BATTERY_BYTES];
	struct vm_header header;
	struct vm_battery battery = { .millivolts = 3850, .flags = VM_BATTERY_VALID };
	struct vm_battery decoded;
	vm_encode_battery(wire, &battery);
	assert(vm_decode(wire, sizeof(wire), &header));
	assert(header.flags == VM_BATTERY_STATUS && header.timestamp == 0 && header.session == 0);
	vm_decode_battery(wire, &decoded);
	assert(decoded.millivolts == 3850 && decoded.flags == VM_BATTERY_VALID);
	assert(!vm_decode(wire, VM_HEADER_BYTES, &header));
	wire[14] = 0;
	assert(!vm_decode(wire, sizeof(wire), &header));
	wire[12] = wire[13] = 0;
	assert(vm_decode(wire, sizeof(wire), &header));
	wire[15] = 1;
	assert(!vm_decode(wire, sizeof(wire), &header));
	packet_roundtrip();
	approval_gesture();
	replay_with_loss();
	startup_window_and_slot_reuse();
	speech_dynamics();
	puts("VibeMic protocol, playout and dynamics checks passed");
}
