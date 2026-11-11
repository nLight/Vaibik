#include "link.h"
#include "session.h"
#include "usb.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(vibemic_rx, LOG_LEVEL_INF);

K_SEM_DEFINE(rx_ready, 0, 1);

static void on_radio(const struct esb_evt *event)
{
	if (event->evt_id == ESB_EVENT_RX_RECEIVED) {
		k_sem_give(&rx_ready);
	}
}

int main(void)
{
	int err = vm_usb_init();

	if (err != 0) {
		LOG_ERR("USB initialization: %d", err);
		return err;
	}
	if (IS_ENABLED(CONFIG_VIBEMIC_TEST_TONE)) {
		return 0;
	}

	err = vm_radio_init(ESB_MODE_PRX, on_radio);
	if (err == 0) {
		err = esb_start_rx();
	}
	if (err != 0) {
		LOG_ERR("RX initialization: %d", err);
		return err;
	}

	for (;;) {
		struct esb_payload packet;

		k_sem_take(&rx_ready, K_MSEC(5));
		for (unsigned i = 0; i < CONFIG_ESB_RX_FIFO_SIZE; i++) {
			if (esb_read_rx_payload(&packet) != 0) {
				break;
			}
			if (packet.pipe == 0) {
				vm_session_accept(packet.data, packet.length, (uint8_t)packet.rssi,
						  k_uptime_get_32());
			}
		}
		vm_session_tick(k_uptime_get_32());
	}
}
