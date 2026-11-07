#include "capture.h"

#include <errno.h>
#include <string.h>
#include <zephyr/audio/dmic.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>

static const struct device *const mic = DEVICE_DT_GET(DT_NODELABEL(pdm0));
K_MEM_SLAB_DEFINE(pcm_slab, VM_PCM_BYTES, 8, 4);

int vm_capture_start(void)
{
	struct pcm_stream_cfg stream = {
		.pcm_rate = VM_SAMPLE_RATE,
		.pcm_width = 16,
		.block_size = VM_PCM_BYTES,
		.mem_slab = &pcm_slab,
	};
	struct dmic_cfg config = {
		.io = {
			.min_pdm_clk_freq = 1000000,
			.max_pdm_clk_freq = 3500000,
			.min_pdm_clk_dc = 40,
			.max_pdm_clk_dc = 60,
		},
		.streams = &stream,
		.channel = {
			.req_num_streams = 1,
			.req_num_chan = 1,
			.req_chan_map_lo = dmic_build_channel_map(0, 0, PDM_CHAN_LEFT),
		},
	};

	if (!device_is_ready(mic)) {
		return -ENODEV;
	}
	int err = dmic_configure(mic, &config);

	return err != 0 ? err : dmic_trigger(mic, DMIC_TRIGGER_START);
}

int vm_capture_read(int16_t *pcm)
{
	void *block;
	uint32_t size;
	int err = dmic_read(mic, 0, &block, &size, 50);

	if (err != 0) {
		return err;
	}
	if (size == VM_PCM_BYTES) {
		memcpy(pcm, block, size);
	}
	k_mem_slab_free(&pcm_slab, block);
	return size == VM_PCM_BYTES ? 0 : -EIO;
}

int vm_capture_stop(void)
{
	return dmic_trigger(mic, DMIC_TRIGGER_STOP);
}
