use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};

const LEVEL: f32 = 0.2;
const ATTACK_MS: f32 = 4.0;
const RELEASE_MS: f32 = 30.0;

pub fn play(kind: &str) {
    let (freq, dur) = match kind {
        "start" => (880.0, 90),
        "stop" => (660.0, 90),
        "done" => (1320.0, 120),
        _ => (220.0, 160),
    };
    std::thread::spawn(move || beep(freq, dur));
}

/// A sine cue with a short fade-in and a smooth fade-out, then silence. The position
/// carries across audio callbacks, so the tone never restarts mid-cue.
struct Tone {
    step: f32,
    phase: f32,
    index: usize,
    frames: usize,
    attack: f32,
    release: f32,
}

impl Tone {
    fn new(freq: f32, dur_ms: u64, rate: f32) -> Self {
        Self {
            step: freq * std::f32::consts::TAU / rate,
            phase: 0.0,
            index: 0,
            frames: (rate * dur_ms as f32 / 1000.0) as usize,
            attack: (rate * ATTACK_MS / 1000.0).max(1.0),
            release: (rate * RELEASE_MS / 1000.0).max(1.0),
        }
    }

    fn next(&mut self) -> f32 {
        if self.index >= self.frames {
            return 0.0;
        }
        let rise = (self.index as f32 / self.attack).min(1.0);
        let fall = ((self.frames - self.index) as f32 / self.release).min(1.0);
        // Raised-cosine edges avoid the clicks of a hard start or stop.
        let gain = (0.5 - 0.5 * (std::f32::consts::PI * rise).cos())
            * (0.5 - 0.5 * (std::f32::consts::PI * fall).cos());
        let value = self.phase.sin() * LEVEL * gain;
        self.phase = (self.phase + self.step) % std::f32::consts::TAU;
        self.index += 1;
        value
    }
}

fn open<T>(device: &cpal::Device, config: &cpal::StreamConfig, mut tone: Tone) -> Option<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                for frame in data.chunks_mut(channels) {
                    let value = T::from_sample(tone.next());
                    for slot in frame {
                        *slot = value;
                    }
                }
            },
            |_| {},
            None,
        )
        .ok()
}

fn beep(freq: f32, dur_ms: u64) {
    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else { return };
    let Ok(supported) = device.default_output_config() else { return };
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let tone = Tone::new(freq, dur_ms, config.sample_rate.0 as f32);
    let stream = match format {
        cpal::SampleFormat::F32 => open::<f32>(&device, &config, tone),
        cpal::SampleFormat::I16 => open::<i16>(&device, &config, tone),
        cpal::SampleFormat::U16 => open::<u16>(&device, &config, tone),
        _ => None,
    };
    let Some(stream) = stream else { return };
    if stream.play().is_ok() {
        // Let the device drain the tail (Bluetooth outputs buffer more) before closing.
        std::thread::sleep(Duration::from_millis(dur_ms + 150));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tone_is_continuous_and_fades_to_silence() {
        let rate = 48_000.0;
        let mut tone = Tone::new(880.0, 90, rate);
        let samples: Vec<f32> = (0..tone.frames + 500).map(|_| tone.next()).collect();
        let max_step = 880.0 * std::f32::consts::TAU / rate * LEVEL * 1.05;
        assert!(samples[0].abs() < 1e-6);
        assert!(samples.windows(2).all(|pair| (pair[1] - pair[0]).abs() <= max_step));
        assert!(samples.iter().any(|sample| sample.abs() > LEVEL * 0.9));
        assert!(samples[tone.frames - 1].abs() < 1e-3);
        assert!(samples[tone.frames..].iter().all(|sample| *sample == 0.0));
    }
}
