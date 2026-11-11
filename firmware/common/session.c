#include "session.h"
#include "playout.h"
#include "protocol.h"
#include "usb.h"

#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>

LOG_MODULE_REGISTER(vibemic_session, LOG_LEVEL_INF);

#define LINK_TIMEOUT_MS 250u
#define SHORT_PRESS_AUDIO_GRACE_MS 2000u
#define PENDING_TIMEOUT_MS (VM_PLAYOUT_BLOCKS * VM_BLOCK_MS + 250u)
#define KEY_LEAD_MS 45u
#define STREAM_LEAD_MS 20u
#define KEY_TAIL_MS 35u
#define KEY_REARM_MS 15u
#define APPROVAL_TIMEOUT_MS 525u
#define WIRED_AUDIO_LEAD_MS 150u
#define DIRECT_USB IS_ENABLED(CONFIG_VIBEMIC_DIRECT_USB)

enum phase { IDLE, WAIT_FOR_HOST, PLAY, TAIL };
static enum phase phase;
static uint32_t session, opened_at, received_at, key_at, released_at, tail_at;
static uint32_t usb_errors_at_open;
static uint8_t weakest_rssi;
static struct vm_link_stats release_stats;
static enum vm_end_reason end_reason;
static bool have_session, key_down, key_confirmed, rearming, release_pending;
static bool have_previous, have_skipped, played;
static uint32_t previous_session, skipped_session;
static struct {
	uint32_t token, started;
	bool seen, armed;
} approval;
static struct vm_playout audio;
static struct k_spinlock audio_lock;
static struct vm_battery battery;
static bool battery_pending;

/* Input for one next press while the current PCM and HID release drain. */
static struct {
	uint32_t session, received_at;
	unsigned count;
	bool sealed, expired;
	struct queued_packet {
		uint8_t data[VM_AUDIO_BYTES];
		uint8_t size, rssi;
	} packets[VM_PLAYOUT_BLOCKS + 2u];
} waiting;

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

static void close_session(enum vm_end_reason reason)
{
	static const char *const reason_text[] = {
		[VM_END_RELEASED] = "PTT up",
		[VM_END_RADIO_TIMEOUT] = "radio timeout",
		[VM_END_HOST_TIMEOUT] = "host did not open audio for this press",
		[VM_END_USB_STOPPED] = "USB audio stopped",
		[VM_END_SUPERSEDED] = "superseded by new press",
	};
	k_spinlock_key_t lock = k_spin_lock(&audio_lock);
	uint32_t concealed = audio.concealed, dropped = audio.dropped;

	audio.started = false;
	k_spin_unlock(&audio_lock, lock);
	uint32_t usb_errors = vm_usb_frame_errors() - usb_errors_at_open;

	if (key_down && !release_pending) {
		release_pending = true;
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

static void defer_packet(const uint8_t *wire, size_t size, uint8_t rssi,
			 const struct vm_header *header, uint32_t now)
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
		waiting.sealed = false;
		waiting.expired = false;
	}
	if (!waiting.sealed) {
		waiting.received_at = now;
	}
	/* Preserve the beginning and reserve the final slot for UP. */
	if (waiting.sealed || (header->flags != VM_PTT_UP &&
			       waiting.count >= ARRAY_SIZE(waiting.packets) - 1u)) {
		return;
	}
	struct queued_packet *queued = &waiting.packets[waiting.count++];

	memcpy(queued->data, wire, size);
	queued->size = size;
	queued->rssi = rssi;
	waiting.sealed = header->flags == VM_PTT_UP;
	if (phase != IDLE && end_reason == VM_END_NONE) {
		/* The sender sends each session in order. A new session fences a lost UP. */
		end_audio(audio.head, VM_END_SUPERSEDED);
	}
}

void vm_session_accept(const uint8_t *wire, size_t size, uint8_t rssi, uint32_t now)
{
	struct vm_header header;
	int16_t pcm[VM_BLOCK_SAMPLES];

	if (!vm_decode(wire, size, &header)) {
		return;
	}
	if (header.flags == VM_BATTERY_STATUS) {
		vm_decode_battery(wire, &battery);
		battery_pending = true;
		return; /* Telemetry never opens or extends an audio/gesture session. */
	}
	if (header.flags == VM_APPROVAL_ARM) {
		if (!approval.seen || approval.token != header.session) {
			approval.token = header.session;
			approval.started = now;
			approval.seen = true;
			approval.armed = phase == IDLE && !key_down &&
					 vm_usb_approval(VM_APPROVAL_ARM, approval.token) == 0;
		}
		return;
	}
	if (header.flags == VM_APPROVAL_COMMIT) {
		if (approval.armed && approval.token == header.session) {
			approval.armed = false;
			if (phase == IDLE && !key_down &&
			    now - approval.started <= APPROVAL_TIMEOUT_MS) {
				vm_usb_approval(VM_APPROVAL_COMMIT, approval.token);
			}
		}
		return;
	}
	approval.armed = false;
	if (!have_session || session != header.session) {
		if ((have_previous && header.session == previous_session) ||
		    (have_skipped && header.session == skipped_session) ||
		    (waiting.expired && header.session == waiting.session)) {
			return;
		}
		if (phase != IDLE || (!DIRECT_USB && key_down) || waiting.count) {
			defer_packet(wire, size, rssi, &header, now);
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
		played = false;
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
	if (rssi > weakest_rssi) {
		weakest_rssi = rssi;
	}
	if (header.flags == VM_AUDIO) {
		vm_decode_pcm(wire, pcm);
		k_spinlock_key_t lock = k_spin_lock(&audio_lock);
		if (phase == WAIT_FOR_HOST) {
			vm_playout_push_waiting(&audio, header.timestamp, pcm);
		} else {
			vm_playout_push(&audio, header.timestamp, pcm);
		}

		k_spin_unlock(&audio_lock, lock);
		/* Radio activity and audio buffer capacity are independent. */
		received_at = now;
	} else if (header.flags == VM_PTT_UP) {
		end_audio(header.timestamp, VM_END_RELEASED);
	}
}

void vm_session_tick(uint32_t now)
{
	uint32_t stream_at;
	bool stream = vm_usb_stream_ready(&stream_at);

	if (battery_pending && phase == IDLE && !key_down && !approval.armed &&
	    vm_usb_battery(&battery) == 0) {
		battery_pending = false;
	}

	if (waiting.count && now - waiting.received_at >= PENDING_TIMEOUT_MS) {
		waiting.count = 0;
		waiting.expired = true;
	}
	if (phase != IDLE && end_reason == VM_END_NONE && now - received_at >= LINK_TIMEOUT_MS) {
		close_session(VM_END_RADIO_TIMEOUT);
	}
	if ((phase == PLAY || phase == TAIL) && !stream) {
		if (end_reason == VM_END_NONE) {
			k_spinlock_key_t lock = k_spin_lock(&audio_lock);

			audio.started = false;
			k_spin_unlock(&audio_lock, lock);
			phase = WAIT_FOR_HOST;
		} else {
			close_session(VM_END_USB_STOPPED);
		}
	}
	if (phase == WAIT_FOR_HOST && end_reason != VM_END_NONE && !stream &&
	    (played || vm_usb_shortcut_requested() || end_reason == VM_END_SUPERSEDED ||
	     now - opened_at >= SHORT_PRESS_AUDIO_GRACE_MS)) {
		close_session(played ? VM_END_USB_STOPPED : VM_END_HOST_TIMEOUT);
	}

	if (release_pending) {
		int err = vm_usb_key(false, &release_stats);

		vm_usb_shortcut_tick();
		if (err == 0) {
			key_down = false;
			release_pending = false;
			rearming = true;
			released_at = now;
		}
		if (!DIRECT_USB) {
			return;
		}
	}
	vm_usb_shortcut_tick();
	if (phase == IDLE && waiting.count) {
		unsigned count = waiting.count;

		waiting.count = 0;
		for (unsigned i = 0; i < count; i++) {
			const struct queued_packet *queued = &waiting.packets[i];

			vm_session_accept(queued->data, queued->size, queued->rssi, now);
		}
	}

	switch (phase) {
	case IDLE:
		break;
	case WAIT_FOR_HOST: {
		if (!key_down && (!rearming || now - released_at >= KEY_REARM_MS) &&
		    vm_usb_key(true, NULL) == 0) {
			rearming = false;
			key_down = true;
		}
		if (key_down && !release_pending && !key_confirmed && vm_usb_key_sent()) {
			key_at = now;
			key_confirmed = true;
		}
		/* A wired audio client can record without waiting for the HID endpoint. */
		bool lead_elapsed = key_confirmed ? now - key_at >= KEY_LEAD_MS :
				    DIRECT_USB && now - opened_at >= WIRED_AUDIO_LEAD_MS;

		if (lead_elapsed && stream &&
		    (int32_t)(now - stream_at) >= (int32_t)STREAM_LEAD_MS) {
			k_spinlock_key_t lock = k_spin_lock(&audio_lock);
			bool started = vm_playout_begin(&audio);

			k_spin_unlock(&audio_lock, lock);
			if (started) {
				played = true;
				phase = PLAY;
			}
		}
		break;
	}
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

void vm_session_reset(void)
{
	/* The HID interface was deconfigured. Discard its pending audio and edges. */
	k_spinlock_key_t lock = k_spin_lock(&audio_lock);
	audio.started = false;
	k_spin_unlock(&audio_lock, lock);
	phase = IDLE;
	key_down = false;
	release_pending = false;
	rearming = false;
	have_session = have_previous = have_skipped = false;
	waiting.count = 0;
	waiting.expired = false;
	approval.seen = approval.armed = false;
	battery_pending = false;
}
