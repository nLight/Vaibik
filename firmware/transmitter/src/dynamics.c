#include "dynamics.h"

#define GAIN_ONE 4096
#define MAKEUP_GAIN (4 * GAIN_ONE)
#define COMPRESSOR_THRESHOLD 823u /* -32 dBFS RMS */
#define PEAK_CEILING 26028u       /* -2 dBFS sample peak */
#define RELEASE_BLOCKS 16         /* About 80 ms at 5 ms per block. */

static uint32_t integer_sqrt(uint32_t value)
{
	uint32_t root = 0;
	uint32_t bit = 1u << 30;

	while (bit > value) {
		bit >>= 2;
	}
	while (bit != 0) {
		if (value >= root + bit) {
			value -= root + bit;
			root = (root >> 1) + bit;
		} else {
			root >>= 1;
		}
		bit >>= 2;
	}
	return root;
}

void vm_dynamics_reset(struct vm_dynamics *state)
{
	state->gain_q12 = MAKEUP_GAIN;
}

void vm_dynamics_process(struct vm_dynamics *state, int16_t pcm[VM_BLOCK_SAMPLES])
{
	uint64_t energy = 0;
	uint32_t peak = 0;

	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		int32_t sample = pcm[i];
		uint32_t magnitude = (uint32_t)(sample < 0 ? -sample : sample);

		energy += (uint32_t)(sample * sample);
		if (magnitude > peak) {
			peak = magnitude;
		}
	}

	uint32_t rms = integer_sqrt((uint32_t)(energy / VM_BLOCK_SAMPLES));
	int32_t target = MAKEUP_GAIN;

	if (rms > COMPRESSOR_THRESHOLD) {
		/* A 2:1 ratio halves the rise in output dB above the threshold. */
		uint64_t squared = (uint64_t)MAKEUP_GAIN * MAKEUP_GAIN * COMPRESSOR_THRESHOLD;

		target = (int32_t)integer_sqrt((uint32_t)(squared / rms));
	}

	int32_t start = state->gain_q12;
	if (peak != 0) {
		int32_t limit = (int32_t)(PEAK_CEILING * GAIN_ONE / peak);

		/* Both ends of the ramp must fit under the loudest sample in this block. */
		start = start < limit ? start : limit;
		target = target < limit ? target : limit;
	}

	int32_t end = target;
	if (target > start) {
		end = start + (target - start + RELEASE_BLOCKS - 1) / RELEASE_BLOCKS;
	}
	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		int32_t gain = start + (end - start) * (int32_t)(i + 1) / (int32_t)VM_BLOCK_SAMPLES;

		pcm[i] = (int16_t)((int32_t)pcm[i] * gain / GAIN_ONE);
	}
	state->gain_q12 = end;
}
