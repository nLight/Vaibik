#include "link.h"
#include "playout.h"
#include "protocol.h"
#include "usb.h"

#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>

LOG_MODULE_REGISTER(vibemic_rx, LOG_LEVEL_INF);

#define LINK_TIMEOUT_MS 250u
#define START_TIMEOUT_MS 500u
#define KEY_LEAD_MS 45u
#define STREAM_LEAD_MS 20u
#define KEY_TAIL_MS 35u
#define KEY_REARM_MS 15u

enum phase { IDLE, WAIT_FOR_HOST, PLAY, TAIL };
static enum phase phase;
static uint32_t session, opened_at, received_at, key_at, released_at, tail_at;
static uint32_t usb_errors_at_open;
static uint8_t weakest_rssi;
static struct vm_link_stats release_stats;
static enum vm_end_reason end_reason;
static bool have_session, key_down, key_confirmed, rearming;
static bool have_previous, have_skipped;
static uint32_t previous_session, skipped_session;
static struct vm_playout audio;
static struct k_spinlock audio_lock;

/* Radio input for one next press while the current PCM and HID release drain. */
static struct {
	uint32_t session, opened_at;
	unsigned count;
	bool sealed, expired;
	struct esb_payload packets[VM_PLAYOUT_BLOCKS + 2u];
} waiting;

K_SEM_DEFINE(rx_ready, 0, 1);

void vm_usb_render(int16_t pcm[VM_USB_FRAME_SAMPLES])
{
	if (IS_ENABLED(CONFIG_VIBEMIC_TEST_TONE)) {
		/* 16 samples = one cycle of a 1 kHz sine wave. */
		static const int16_t tone[] = {
			0, 784, 1448, 1892, 2048, 1892, 1448, 784,
			0, -784, -1448, -1892, -2048, -1892, -1448, -784,
		};
		BUILD_ASSERT(sizeof(tone) == VM_USB_FRAME_SAMPLES * sizeof(*pcm));
		memcpy(pcm, tone, sizeof(tone));
		return;
	}

	k_spinlock_key_t lock = k_spin_lock(&audio_lock);
	vm_playout_read(&audio, pcm);
	k_spin_unlock(&audio_lock, lock);
}

static void on_radio(const struct esb_evt *event)
{
	if (event->evt_id == ESB_EVENT_RX_RECEIVED) {
		k_sem_give(&rx_ready);
	}
}

static void close_session(enum vm_end_reason reason)
{
	static const char *const reason_text[] = {
		[VM_END_RELEASED] = "PTT up",
		[VM_END_RADIO_TIMEOUT] = "radio timeout",
		[VM_END_HOST_TIMEOUT] = "host did not open audio in time",
		[VM_END_USB_STOPPED] = "USB audio stopped",
		[VM_END_SUPERSEDED] = "superseded by new press",
	};
	k_spinlock_key_t lock = k_spin_lock(&audio_lock);
	uint32_t concealed = audio.concealed, dropped = audio.dropped;

	audio.started = false;
	k_spin_unlock(&audio_lock, lock);
	uint32_t usb_errors = vm_usb_frame_errors() - usb_errors_at_open;

	if (key_down) {
		release_stats = (struct vm_link_stats){
			.reason = reason,
			.concealed_samples = concealed,
			.usb_errors = usb_errors,
			.weakest_rssi = weakest_rssi,
		};
	}
	LOG_INF("Session RX: %s, %u silent samples, %u late/duplicate/full packets, "
		"%u USB submit errors", reason_text[reason], concealed, dropped, usb_errors);
	phase = IDLE;
}

static void end_audio(uint32_t timestamp, enum vm_end_reason reason)
{
	k_spinlock_key_t lock = k_spin_lock(&audio_lock);
	vm_playout_end(&audio, timestamp);
	k_spin_unlock(&audio_lock, lock);
	end_reason = reason;
}

static void defer_packet(const struct esb_payload *packet, const struct vm_header *header,
			 uint32_t now)
{
	if (waiting.count && waiting.session != header->session) {
		if (header->flags != VM_PTT_UP) {
			skipped_session = header->session;
			have_skipped = true;
		}
		return;
	}
	if (!waiting.count) {
		if (header->flags == VM_PTT_UP) {
			return;
		}
		waiting.session = header->session;
		waiting.opened_at = now;
		waiting.sealed = false;
		waiting.expired = false;
	}
	/* Preserve the beginning and reserve the final slot for UP. */
	if (waiting.sealed || (header->flags != VM_PTT_UP &&
			       waiting.count >= ARRAY_SIZE(waiting.packets) - 1u)) {
		return;
	}
	waiting.packets[waiting.count++] = *packet;
	waiting.sealed = header->flags == VM_PTT_UP;
	if (phase != IDLE && end_reason == VM_END_NONE) {
		/* The sender sends each session in order. A new session fences a lost UP. */
		end_audio(audio.head, VM_END_SUPERSEDED);
	}
}

static void accept_packet(const struct esb_payload *packet, uint32_t now)
{
	struct vm_header header;
	int16_t pcm[VM_BLOCK_SAMPLES];

	if (packet->pipe != 0 || !vm_decode(packet->data, packet->length, &header)) {
		return;
	}
	if (!have_session || session != header.session) {
		if ((have_previous && header.session == previous_session) ||
		    (have_skipped && header.session == skipped_session) ||
		    (waiting.expired && header.session == waiting.session)) {
			return;
		}
		if (phase != IDLE || key_down || waiting.count) {
			defer_packet(packet, &header, now);
			return;
		}
		if (header.flags == VM_PTT_UP) {
			return;
		}
		k_spinlock_key_t lock = k_spin_lock(&audio_lock);
		/* Keep the surviving pre-roll even if DOWN and the first block were lost. */
		vm_playout_reset(&audio, header.timestamp);
		k_spin_unlock(&audio_lock, lock);
		previous_session = session;
		have_previous = have_session;
		session = header.session;
		have_session = true;
		phase = WAIT_FOR_HOST;
		end_reason = VM_END_NONE;
		key_confirmed = false;
		opened_at = now;
		received_at = now;
		usb_errors_at_open = vm_usb_frame_errors();
		weakest_rssi = 0;
	}

	/* The watchdog closes this session; audio from a still-held button cannot reopen it. */
	if (phase == IDLE || end_reason != VM_END_NONE) {
		return;
	}
	/* Nordic ESB passes the radio's unsigned RSSISAMPLE magnitude. */
	if (packet->rssi > weakest_rssi) {
		weakest_rssi = (uint8_t)packet->rssi;
	}
	if (header.flags == VM_AUDIO) {
		vm_decode_pcm(packet->data, pcm);
		k_spinlock_key_t lock = k_spin_lock(&audio_lock);
		bool accepted = vm_playout_push(&audio, header.timestamp, pcm);

		k_spin_unlock(&audio_lock, lock);
		if (accepted) {
			received_at = now;
		}
	} else if (header.flags == VM_PTT_UP) {
		end_audio(header.timestamp, VM_END_RELEASED);
	}
}

static void tick(uint32_t now)
{
	uint32_t stream_at;
	bool stream = vm_usb_stream_ready(&stream_at);

	if (waiting.count && now - waiting.opened_at >= START_TIMEOUT_MS) {
		waiting.count = 0;
		waiting.expired = true;
	}
	if (phase != IDLE && end_reason == VM_END_NONE && now - received_at >= LINK_TIMEOUT_MS) {
		close_session(VM_END_RADIO_TIMEOUT);
	}
	if (phase == WAIT_FOR_HOST && now - opened_at >= START_TIMEOUT_MS) {
		close_session(VM_END_HOST_TIMEOUT);
	}
	if ((phase == PLAY || phase == TAIL) && !stream) {
		close_session(VM_END_USB_STOPPED);
	}

	if (phase == IDLE && key_down) {
		if (vm_usb_key(false, &release_stats) == 0) {
			key_down = false;
			rearming = true;
			released_at = now;
		}
		return;
	}
	if (phase == IDLE && waiting.count) {
		unsigned count = waiting.count;

		waiting.count = 0;
		for (unsigned i = 0; i < count; i++) {
			accept_packet(&waiting.packets[i], now);
		}
	}

	switch (phase) {
	case IDLE:
		break;
	case WAIT_FOR_HOST:
		if (!key_down) {
			if (rearming && now - released_at < KEY_REARM_MS) {
				break;
			}
			if (vm_usb_key(true, NULL) != 0) {
				break;
			}
			rearming = false;
			key_down = true;
		}
		if (!key_confirmed && vm_usb_key_sent()) {
			key_at = now;
			key_confirmed = true;
		}
		if (key_confirmed && stream && now - key_at >= KEY_LEAD_MS &&
		    (int32_t)(now - stream_at) >= (int32_t)STREAM_LEAD_MS) {
			k_spinlock_key_t lock = k_spin_lock(&audio_lock);
			bool started = vm_playout_begin(&audio);

			k_spin_unlock(&audio_lock, lock);
			if (started) {
				phase = PLAY;
			}
		}
		break;
	case PLAY: {
		k_spinlock_key_t lock = k_spin_lock(&audio_lock);
		bool drained = vm_playout_drained(&audio);

		k_spin_unlock(&audio_lock, lock);
		if (drained) {
			phase = TAIL;
			tail_at = now;
		}
		break;
	}
	case TAIL:
		if (now - tail_at >= KEY_TAIL_MS) {
			close_session(end_reason);
		}
		break;
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
			accept_packet(&packet, k_uptime_get_32());
		}
		tick(k_uptime_get_32());
	}
}
