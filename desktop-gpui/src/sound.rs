use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub fn play(kind: &str) {
    let (freq, dur) = match kind {
        "start" => (880.0, 90),
        "stop" => (660.0, 90),
        "done" => (1320.0, 120),
        _ => (220.0, 160),
    };
    std::thread::spawn(move || beep(freq, dur));
}

fn beep(freq: f32, dur_ms: u64) {
    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else { return };
    let Ok(config) = device.default_output_config() else { return };
    let rate = config.sample_rate().0 as f32;
    let channels = config.channels() as usize;
    let frames = (rate * dur_ms as f32 / 1000.0) as usize;
    let sample = move |index: usize| {
        let t = index as f32 / rate;
        let envelope = (1.0 - index as f32 / frames as f32).max(0.0);
        (t * freq * std::f32::consts::TAU).sin() * 0.25 * envelope
    };
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config.into(),
            move |data: &mut [f32], _| {
                for (i, frame) in data.chunks_mut(channels).enumerate() {
                    let value = sample(i);
                    for slot in frame {
                        *slot = value;
                    }
                }
            },
            |_| {},
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            &config.into(),
            move |data: &mut [i16], _| {
                for (i, frame) in data.chunks_mut(channels).enumerate() {
                    let value = (sample(i) * 32767.0) as i16;
                    for slot in frame {
                        *slot = value;
                    }
                }
            },
            |_| {},
            None,
        ),
        _ => return,
    };
    let Ok(stream) = stream else { return };
    let _ = stream.play();
    std::thread::sleep(Duration::from_millis(dur_ms + 40));
}