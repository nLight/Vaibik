#include "playout.h"
#include "protocol.h"

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
	for (unsigned i = 0; i < VM_PLAYOUT_BLOCKS; i++) {
		assert(vm_playout_push(&audio, i * VM_BLOCK_SAMPLES, pcm));
	}
	/* Preserve the beginning while the application starts. */
	assert(!vm_playout_push(&audio, VM_PLAYOUT_CAPACITY, pcm));
	assert(vm_playout_begin(&audio));
	for (unsigned i = 0; i < VM_BLOCK_MS; i++) {
		expect_frame(0);
	}
	assert(vm_playout_push(&audio, VM_PLAYOUT_CAPACITY, pcm));
	assert(!vm_playout_push(&audio, 0, pcm)); /* Too late. */
	vm_playout_reset(&audio, 0);
	expect_frame(0);
	assert(!vm_playout_begin(&audio));
}

int main(void)
{
	packet_roundtrip();
	replay_with_loss();
	startup_window_and_slot_reuse();
	puts("VibeMic protocol and playout checks passed");
}
