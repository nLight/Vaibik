/* Receiver session timing against a fake USB host: the dongle must keep the PTT key
 * (and the native-dictation shortcut it drives) down until the host has heard the
 * whole phrase, without holding it forever when the host never listens.
 */
#include "protocol.h"
#include "session.h"
#include "usb.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define SAMPLE 1000
#define NEVER UINT32_MAX

static uint32_t now, open_at, session_id = 100;
static struct {
	bool key, stream;
	uint32_t stream_since, downs, ups, up_at, heard;
	enum vm_end_reason reason;
} usb;

int vm_usb_key(bool down, const struct vm_link_stats *stats)
{
	usb.key = down;
	if (down) {
		usb.downs++;
	} else {
		usb.ups++;
		usb.up_at = now;
		usb.reason = stats ? stats->reason : VM_END_NONE;
	}
	return 0;
}

int vm_usb_approval(enum vm_flag flag, uint32_t token)
{
	(void)flag;
	(void)token;
	return 0;
}

int vm_usb_battery(const struct vm_battery *battery)
{
	(void)battery;
	return 0;
}

bool vm_usb_key_sent(void)
{
	return true;
}

void vm_usb_shortcut_tick(void)
{
}

bool vm_usb_stream_ready(uint32_t *since)
{
	*since = usb.stream_since;
	return usb.stream;
}

uint32_t vm_usb_frame_errors(void)
{
	return 0;
}

/* One millisecond: a USB frame while the host listens, then the receiver loop. */
static void step(void)
{
	if (!usb.stream && now >= open_at) {
		usb.stream = true;
		usb.stream_since = now;
	}
	if (usb.stream) {
		int16_t frame[VM_USB_FRAME_SAMPLES];

		vm_usb_render(frame);
		for (unsigned i = 0; i < VM_USB_FRAME_SAMPLES; i++) {
			usb.heard += frame[i] == SAMPLE;
		}
	}
	vm_session_tick(now);
	now++;
}

static void send(uint8_t flag, uint32_t block)
{
	uint8_t wire[VM_AUDIO_BYTES];
	int16_t pcm[VM_BLOCK_SAMPLES];

	for (unsigned i = 0; i < VM_BLOCK_SAMPLES; i++) {
		pcm[i] = SAMPLE;
	}
	vm_encode(wire, flag, session_id, block, pcm);
	vm_session_accept(wire, flag == VM_AUDIO ? VM_AUDIO_BYTES : VM_HEADER_BYTES, 40, now);
}

/* Press and speak `blocks` of audio in real time. Returns the press start time. */
static uint32_t press(uint32_t blocks, uint32_t host_opens_at)
{
	uint32_t started;

	vm_session_reset();
	memset(&usb, 0, sizeof(usb));
	session_id++;
	now += 1000;
	started = now;
	open_at = host_opens_at == NEVER ? NEVER : started + host_opens_at;
	send(VM_PTT_DOWN, 0);
	for (uint32_t block = 0; block < blocks; block++) {
		send(VM_AUDIO, block);
		for (unsigned ms = 0; ms < VM_BLOCK_MS; ms++) {
			step();
		}
	}
	assert(usb.key && usb.downs == 1 && usb.ups == 0);
	return started;
}

static void run_until_released(uint32_t limit_ms)
{
	for (uint32_t i = 0; i < limit_ms && usb.ups == 0; i++) {
		step();
	}
	assert(usb.ups == 1 && !usb.key);
}

static void slow_dictation_app_hears_whole_phrase(void)
{
	/* A 300 ms phrase; Codex or Claude opens the microphone 400 ms after release. */
	uint32_t started = press(60, 300 + 400);

	send(VM_PTT_UP, 60);
	run_until_released(5000);
	assert(usb.reason == VM_END_RELEASED);
	assert(usb.up_at > started + 700);
	assert(usb.heard == 60u * VM_BLOCK_SAMPLES);
}

static void host_that_never_listens_releases_after_grace(void)
{
	uint32_t started = press(60, NEVER);

	send(VM_PTT_UP, 60);
	run_until_released(5000);
	assert(usb.reason == VM_END_HOST_TIMEOUT);
	assert(usb.up_at >= started + 2000 && usb.up_at <= started + 2010);

	/* A press longer than the grace period releases right after the button. */
	started = press(440, NEVER);
	uint32_t released = now;

	send(VM_PTT_UP, 440);
	run_until_released(5000);
	assert(usb.reason == VM_END_HOST_TIMEOUT && usb.up_at - released <= 2);
	(void)started;
}

static void radio_loss_drains_audio_already_received(void)
{
	/* The host is 500 ms behind when the transmitter goes silent without an UP. */
	press(120, 500);
	run_until_released(5000);
	assert(usb.reason == VM_END_RADIO_TIMEOUT);
	/* Drift correction may repeat a few samples while the backlog shrinks. */
	assert(usb.heard >= 120u * VM_BLOCK_SAMPLES && usb.heard < 120u * VM_BLOCK_SAMPLES + 32u);
}

static void prompt_host_still_releases_promptly(void)
{
	uint32_t released;

	press(60, 0);
	released = now;
	send(VM_PTT_UP, 60);
	run_until_released(5000);
	assert(usb.reason == VM_END_RELEASED);
	assert(usb.heard == 60u * VM_BLOCK_SAMPLES);
	assert(usb.up_at - released < 150);
}

int main(void)
{
	slow_dictation_app_hears_whole_phrase();
	host_that_never_listens_releases_after_grace();
	radio_loss_drains_audio_already_received();
	prompt_host_still_releases_promptly();
	puts("VibeMic receiver session checks passed");
}
