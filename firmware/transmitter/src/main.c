#include "capture.h"
#include "link.h"
#include "protocol.h"

#include <errno.h>
#include <string.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/random/random.h>
#include <zephyr/sys/atomic.h>

LOG_MODULE_REGISTER(vibemic_tx, LOG_LEVEL_INF);

#define PRE_ROLL_BLOCKS (120u / VM_BLOCK_MS)
#define TX_QUEUE_BLOCKS 40u
#define DEBOUNCE_BLOCKS 2u
#define UP_RESTARTS 2u
#define UP_RESTART_DELAY_MS 12u

static const struct gpio_dt_spec ptt = GPIO_DT_SPEC_GET(DT_NODELABEL(ptt_input), gpios);
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static int16_t pre_roll[PRE_ROLL_BLOCKS][VM_BLOCK_SAMPLES];

K_MSGQ_DEFINE(tx_queue, sizeof(struct esb_payload), TX_QUEUE_BLOCKS, 4);
K_SEM_DEFINE(tx_done, 0, 1);
static atomic_t tx_attempts;
static atomic_t tx_ok;

static void on_radio(const struct esb_evt *event)
{
	if (event->evt_id == ESB_EVENT_TX_SUCCESS || event->evt_id == ESB_EVENT_TX_FAILED) {
		atomic_set(&tx_attempts, event->tx_attempts);
		atomic_set(&tx_ok, event->evt_id == ESB_EVENT_TX_SUCCESS);
		k_sem_give(&tx_done);
	}
}

static bool send_packet(const struct esb_payload *packet, uint32_t *retries)
{
	int err = esb_write_payload(packet);
	unsigned restarts = packet->data[1] == VM_PTT_UP ? UP_RESTARTS : 0u;

	if (err != 0) {
		LOG_WRN("ESB write: %d", err);
		return false;
	}
	for (;;) {
		k_sem_take(&tx_done, K_FOREVER);
		uint32_t attempts = atomic_get(&tx_attempts);

		*retries += attempts > 0 ? attempts - 1u : 0u;
		if (atomic_get(&tx_ok)) {
			return true;
		}
		if (restarts == 0) {
			break;
		}
		restarts--;
		/* On TX_FAILED ESB retains the payload and PID. Spread the final
		 * edge across separate bursts without enqueuing another packet.
		 */
		k_sleep(K_MSEC(UP_RESTART_DELAY_MS));
		err = esb_start_tx();
		if (err != 0) {
			LOG_WRN("ESB restart: %d", err);
			break;
		}
		(*retries)++;
	}
	err = esb_flush_tx();
	if (err != 0) {
		LOG_WRN("ESB flush: %d", err);
	}
	return false;
}

static void radio_worker(void *a, void *b, void *c)
{
	struct esb_payload packet;
	uint32_t sent = 0, failed = 0, retries = 0;
	uint64_t ack_sum_us = 0;
	uint32_t ack_max_us = 0;

	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);
	for (;;) {
		k_msgq_get(&tx_queue, &packet, K_FOREVER);

		/* Only one item in the ESB FIFO. */
		uint32_t started = k_cycle_get_32();
		if (send_packet(&packet, &retries)) {
			uint32_t elapsed = k_cyc_to_us_ceil32(k_cycle_get_32() - started);

			sent++;
			ack_sum_us += elapsed;
			ack_max_us = MAX(ack_max_us, elapsed);
		} else {
			failed++;
		}
		if (packet.data[1] == VM_PTT_UP) {
			uint32_t ack_avg_us = sent ? ack_sum_us / sent : 0;

			LOG_INF("Session TX: %u ACK, %u failed, %u retries, ACK avg/max %u/%u us",
				sent, failed, retries, ack_avg_us, ack_max_us);
			sent = failed = retries = 0;
			ack_sum_us = ack_max_us = 0;
		}
	}
}

K_THREAD_STACK_DEFINE(radio_stack, 1536);
static struct k_thread radio_thread;

static bool enqueue(uint8_t flag, uint32_t session, uint32_t block, const int16_t *pcm)
{
	struct esb_payload packet = {
		.pipe = 0,
		.noack = false,
		.length = flag == VM_AUDIO ? VM_AUDIO_BYTES : VM_HEADER_BYTES,
	};

	/* Preserve room for both edges even when audio is backed up. */
	if (flag == VM_AUDIO && k_msgq_num_free_get(&tx_queue) <= 2u) {
		return false;
	}
	vm_encode(packet.data, flag, session, block, pcm);
	if (k_msgq_put(&tx_queue, &packet, K_NO_WAIT) != 0) {
		LOG_WRN("TX queue full; dropped PTT edge %u", flag);
		return false;
	}
	return true;
}

int main(void)
{
	int16_t pcm[VM_BLOCK_SAMPLES];
	uint32_t session = sys_rand32_get();
	uint32_t block = 0;
	uint32_t dropped = 0;
	unsigned write = 0, have = 0, debounce = 0;
	bool pressed = false;
	int err;

	if (!gpio_is_ready_dt(&ptt) || !gpio_is_ready_dt(&led)) {
		return -ENODEV;
	}
	err = gpio_pin_configure_dt(&ptt, GPIO_INPUT);
	if (err == 0) {
		err = gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	}
	if (err == 0) {
		err = vm_radio_init(ESB_MODE_PTX, on_radio);
	}
	if (err == 0) {
		err = vm_capture_start();
	}
	if (err != 0) {
		LOG_ERR("TX initialization failed: %d", err);
		return err;
	}

	k_thread_create(&radio_thread, radio_stack, K_THREAD_STACK_SIZEOF(radio_stack),
			radio_worker, NULL, NULL, NULL, 4, 0, K_NO_WAIT);

	for (;;) {
		err = vm_capture_read(pcm);
		if (err != 0) {
			/* Release on capture failure; RX watchdog covers a lost UP. */
			if (pressed) {
				enqueue(VM_PTT_UP, session, block, NULL);
				gpio_pin_set_dt(&led, 0);
			}
			vm_capture_stop();
			LOG_ERR("PDM stopped: %d; reset transmitter to retry", err);
			return err;
		}

		int level = gpio_pin_get_dt(&ptt);
		bool edge = false;

		if (level < 0 || (level != 0) == pressed) {
			debounce = 0;
		} else if (++debounce == DEBOUNCE_BLOCKS) {
			debounce = 0;
			edge = true;
		}

		if (edge && !pressed) {
			pressed = true;
			session++;
			block = 0;
			dropped = 0;
			enqueue(VM_PTT_DOWN, session, block, NULL);
			gpio_pin_set_dt(&led, 1);
			for (unsigned i = 0; i < have; i++) {
				unsigned index = (write + PRE_ROLL_BLOCKS - have + i) %
						 PRE_ROLL_BLOCKS;
				if (!enqueue(VM_AUDIO, session, block++, pre_roll[index])) {
					dropped++;
				}
			}
		}
		if (pressed) {
			if (!enqueue(VM_AUDIO, session, block++, pcm)) {
				dropped++;
			}
		}
		if (edge && pressed && level == 0) {
			/* The UP fence carries the exact end timestamp, even if audio was lost. */
			enqueue(VM_PTT_UP, session, block, NULL);
			pressed = false;
			gpio_pin_set_dt(&led, 0);
			if (dropped != 0) {
				LOG_WRN("TX queue dropped %u audio blocks", dropped);
			}
		}

		memcpy(pre_roll[write], pcm, sizeof(pcm));
		write = (write + 1u) % PRE_ROLL_BLOCKS;
		if (have < PRE_ROLL_BLOCKS) {
			have++;
		}
	}
}
