#include "protocol.h"

static void put_le(uint8_t *dst, uint32_t value, unsigned bytes)
{
	for (unsigned i = 0; i < bytes; i++) {
		dst[i] = (uint8_t)(value >> (8u * i));
	}
}

static uint32_t get_le(const uint8_t *src, unsigned bytes)
{
	uint32_t value = 0;

	for (unsigned i = 0; i < bytes; i++) {
		value |= (uint32_t)src[i] << (8u * i);
	}
	return value;
}

void vm_encode(uint8_t *out, uint8_t flags, uint32_t session, uint32_t block,
	       const int16_t *pcm)
{
	out[0] = VM_PROTOCOL_VERSION;
	out[1] = flags;
	put_le(out + 2, (uint16_t)block, 2);
	put_le(out + 4, block * VM_BLOCK_SAMPLES, 4);
	put_le(out + 8, session, 4);
	if (flags == VM_AUDIO) {
		for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
			put_le(out + VM_HEADER_BYTES + 2u * i, (uint16_t)pcm[i], 2);
		}
	}
}

bool vm_decode(const uint8_t *wire, size_t size, struct vm_header *header)
{
	if (size < VM_HEADER_BYTES || wire[0] != VM_PROTOCOL_VERSION) {
		return false;
	}

	uint8_t flags = wire[1];
	uint32_t timestamp = get_le(wire + 4, 4);
	uint16_t sequence = (uint16_t)get_le(wire + 2, 2);

	switch (flags) {
	case VM_AUDIO:
		if (size != VM_AUDIO_BYTES || timestamp > UINT32_MAX - VM_BLOCK_SAMPLES) {
			return false;
		}
		break;
	case VM_PTT_DOWN:
		if (timestamp != 0) {
			return false;
		}
		/* fall through */
	case VM_PTT_UP:
		if (size != VM_HEADER_BYTES) {
			return false;
		}
		break;
	default:
		return false;
	}
	if (timestamp % VM_BLOCK_SAMPLES != 0 ||
	    sequence != (uint16_t)(timestamp / VM_BLOCK_SAMPLES)) {
		return false;
	}

	*header = (struct vm_header){
		.flags = flags,
		.sequence = sequence,
		.timestamp = timestamp,
		.session = get_le(wire + 8, 4),
	};
	return true;
}

void vm_decode_pcm(const uint8_t *wire, int16_t *pcm)
{
	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		uint32_t sample = get_le(wire + VM_HEADER_BYTES + 2u * i, 2);

		pcm[i] = (int16_t)(sample < 32768u ? (int32_t)sample : (int32_t)sample - 65536);
	}
}
