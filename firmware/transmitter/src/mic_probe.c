#include "capture.h"

#include <errno.h>
#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/kernel.h>

#define PROBE_SECONDS 3u
#define PROBE_BLOCKS (PROBE_SECONDS * 1000u / VM_BLOCK_MS)

static const struct device *const port = DEVICE_DT_GET(DT_NODELABEL(board_cdc_acm_uart));
static int16_t clip[PROBE_BLOCKS][VM_BLOCK_SAMPLES];

static void send_tag(const char tag[4])
{
	for (unsigned i = 0; i < 4; i++) {
		uart_poll_out(port, tag[i]);
	}
}

static int record_clip(void)
{
	int err = vm_capture_start();

	if (err != 0) {
		return err;
	}
	for (unsigned i = 0; i < PROBE_BLOCKS && err == 0; i++) {
		err = vm_capture_read(clip[i]);
	}
	int stop_err = vm_capture_stop();

	return err != 0 ? err : stop_err;
}

int main(void)
{
	if (!device_is_ready(port)) {
		return -ENODEV;
	}
	for (;;) {
		uint32_t dtr = 0;
		unsigned char command;

		if (uart_line_ctrl_get(port, UART_LINE_CTRL_DTR, &dtr) == 0 && dtr &&
		    uart_poll_in(port, &command) == 0 && command == 'R') {
			if (record_clip() != 0) {
				send_tag("VERR");
				continue;
			}
			send_tag("VMIC");
			for (unsigned i = 0; i < PROBE_BLOCKS; i++) {
				for (unsigned j = 0; j < VM_BLOCK_SAMPLES; j++) {
					uint16_t sample = (uint16_t)clip[i][j];

					uart_poll_out(port, (uint8_t)sample);
					uart_poll_out(port, (uint8_t)(sample >> 8));
				}
			}
		} else {
			k_sleep(K_MSEC(10));
		}
	}
}
