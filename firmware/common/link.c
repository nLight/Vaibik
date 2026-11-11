#include "link.h"
#include "protocol.h"

#include <zephyr/sys/util.h>

BUILD_ASSERT(VM_AUDIO_BYTES <= CONFIG_ESB_MAX_PAYLOAD_LENGTH);

#define PAIR_TAG "VIBEMICRF01"
/* One aligned UF2 payload slot. The desktop flasher replaces only the four
 * address bytes. Volatile reads keep the provisioned value in the image.
 */
static const uint8_t pair_profile[] __aligned(16) = PAIR_TAG "\x61\x9b\x46\xd2";
BUILD_ASSERT(sizeof(pair_profile) == 16);

int vm_radio_init(enum esb_mode mode, esb_event_handler handler)
{
	const volatile uint8_t *stored_base = pair_profile + sizeof(PAIR_TAG) - 1;
	uint8_t base[4];
	const uint8_t prefixes[] = {0x35};
	struct esb_config config = ESB_DEFAULT_CONFIG;
	int err;

	for (unsigned i = 0; i < ARRAY_SIZE(base); i++) {
		base[i] = stored_base[i];
	}
	config.mode = mode;
	config.event_handler = handler;
	if (mode == ESB_MODE_PTX) {
		config.tx_output_power = 8;
	}
	config.retransmit_count = 2;
	config.retransmit_delay = 900;
	err = esb_init(&config);
	if (err == 0) {
		err = esb_set_base_address_0(base);
	}
	if (err == 0) {
		err = esb_set_prefixes(prefixes, ARRAY_SIZE(prefixes));
	}
	if (err == 0) {
		err = esb_enable_pipes(BIT(0));
	}
	return err;
}
