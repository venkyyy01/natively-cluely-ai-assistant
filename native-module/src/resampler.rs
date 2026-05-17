//! NAT-043: Polyphase resampling (rubato `FftFixedIn`) before PCM reaches JS.
//! Downsamples device-rate mono audio to 16 kHz or 24 kHz for STT.

use anyhow::Result;
use rubato::{FftFixedIn, Resampler as RubatoResampler};

const SUB_CHUNKS: usize = 2;

/// High-quality streaming resampler: native rate → 16 kHz or 24 kHz mono i16.
pub struct PolyphaseResampler {
    inner: FftFixedIn<f32>,
    pending: Vec<f32>,
}

impl PolyphaseResampler {
    /// `input_sr`: hardware rate (e.g. 48000). `output_sr`: 16000 or 24000.
    /// `chunk_size_in`: must match the silence-suppressor frame size (20 ms at native rate).
    pub fn new(input_sr: u32, output_sr: u32, chunk_size_in: usize) -> Result<Self> {
        if ![16_000, 24_000].contains(&output_sr) {
            anyhow::bail!("output_sr must be 16000 or 24000, got {}", output_sr);
        }
        let inner = FftFixedIn::<f32>::new(
            input_sr as usize,
            output_sr as usize,
            chunk_size_in,
            SUB_CHUNKS,
            1,
        )
        .map_err(|e| anyhow::anyhow!("FftFixedIn: {:?}", e))?;

        Ok(Self {
            inner,
            pending: Vec::with_capacity(chunk_size_in * 4),
        })
    }

    /// Feed mono i16 PCM at native rate; returns zero or more i16 samples at `output_sr`.
    pub fn push_i16(&mut self, input: &[i16]) -> Result<Vec<i16>> {
        if input.is_empty() {
            return Ok(Vec::new());
        }

        self.pending
            .extend(input.iter().map(|&s| s as f32 * (1.0 / 32768.0)));

        let need = self.inner.input_frames_next();
        let mut out = Vec::new();

        while self.pending.len() >= need {
            let chunk: Vec<f32> = self.pending.drain(0..need).collect();
            let wave_out = self
                .inner
                .process(&[chunk], None)
                .map_err(|e| anyhow::anyhow!("resample process: {:?}", e))?;
            for &s in wave_out[0].iter() {
                let clamped = s.clamp(-1.0, 1.0);
                out.push((clamped * 32767.0).clamp(-32768.0, 32767.0) as i16);
            }
        }

        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::PolyphaseResampler;

    #[test]
    fn polyphase_48k_to_16k_produces_output() {
        let chunk = (48_000 / 1000) * 20; // 20 ms @ 48k
        let mut r = PolyphaseResampler::new(48_000, 16_000, chunk).expect("resampler");
        let mono = vec![i16::MAX / 4; chunk];
        // Not a pure tone — we only assert the pipeline produces 16kHz-scale output.
        let out = r.push_i16(&mono).expect("push");
        assert!(
            !out.is_empty(),
            "expected first chunk after sufficient input"
        );
        // Rough ratio 3:1
        assert!(out.len() / mono.len() <= 1);
        assert!(out.len() * 3 >= mono.len() / 2);
    }
}
