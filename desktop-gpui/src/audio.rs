use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};

const TARGET_RATE: u32 = 16_000;

pub struct Recorder {
    stream: cpal::Stream,
    buffer: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    channels: u16,
}

impl Recorder {
    pub fn start() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("Микрофон не найден.")?;
        let supported = device.default_input_config().map_err(|error| error.to_string())?;
        let rate = supported.sample_rate().0;
        let channels = supported.channels();
        let config: StreamConfig = supported.clone().into();
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let sink = buffer.clone();
        let stream = match supported.sample_format() {
            SampleFormat::F32 => device
                .build_input_stream(
                    &config,
                    move |data: &[f32], _| sink.lock().unwrap().extend_from_slice(data),
                    |error| eprintln!("input error: {error}"),
                    None,
                )
                .map_err(|error| error.to_string())?,
            SampleFormat::I16 => device
                .build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        let mut guard = sink.lock().unwrap();
                        guard.extend(data.iter().map(|&s| s as f32 / 32768.0));
                    },
                    |error| eprintln!("input error: {error}"),
                    None,
                )
                .map_err(|error| error.to_string())?,
            format => return Err(format!("Неподдерживаемый формат микрофона: {format:?}")),
        };
        stream.play().map_err(|error| error.to_string())?;
        Ok(Self { stream, buffer, rate, channels })
    }

    pub fn stop(self) -> Result<Vec<u8>, String> {
        drop(self.stream);
        let interleaved = self.buffer.lock().unwrap().clone();
        if interleaved.is_empty() {
            return Err("Запись пуста.".into());
        }
        let mono = downmix(&interleaved, self.channels);
        let resampled = resample(&mono, self.rate, TARGET_RATE);
        Ok(encode_wav(&resampled, TARGET_RATE))
    }
}

fn downmix(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    if channels == 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut output = Vec::with_capacity(out_len);
    for index in 0..out_len {
        let position = index as f64 * ratio;
        let left = position.floor() as usize;
        let fraction = (position - left as f64) as f32;
        let a = input[left.min(input.len() - 1)];
        let b = input[(left + 1).min(input.len() - 1)];
        output.push(a + (b - a) * fraction);
    }
    output
}

fn encode_wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let pcm: Vec<i16> = samples
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect();
    let data_len = (pcm.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in pcm {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}