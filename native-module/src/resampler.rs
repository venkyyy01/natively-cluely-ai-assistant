use anyhow::Result;
use rubato::{FftFixedIn, Resampler as RubatoResampler};

const MAX_BUFFERED_CHUNKS: usize = 8;

/// High-quality resampler using rubato (polyphase FIR with sinc interpolation)
/// Converts f32 audio from input sample rate to 16kHz i16 output
pub struct Resampler {
    resampler: FftFixedIn<f32>,
    input_buffer: Vec<Vec<f32>>,
    output_buffer: Vec<Vec<f32>>,
}

impl Resampler {
    pub fn new(input_sample_rate: f64) -> Result<Self> {
        let output_sample_rate = 16000.0;
        let input_chunk_size = 1024usize;

        println!(
            "[Resampler] Created: {}Hz -> {}Hz (high-quality rubato)",
            input_sample_rate, output_sample_rate
        );

        // FftFixedIn: Fixed input chunk size, variable output size
        // This is ideal for streaming from a microphone tap that delivers fixed-size buffers
        let resampler = FftFixedIn::<f32>::new(
            input_sample_rate as usize,
            output_sample_rate as usize,
            input_chunk_size, // chunk size (internal buffer)
            2,                // sub-chunks for better quality
            1,                // mono
        )
        .map_err(|e| anyhow::anyhow!("Failed to create resampler: {}", e))?;

        let max_input_buffer_len = input_chunk_size * MAX_BUFFERED_CHUNKS;

        Ok(Self {
            resampler,
            input_buffer: vec![Vec::with_capacity(max_input_buffer_len)],
            output_buffer: vec![Vec::new()],
        })
    }

    /// Resample f32 audio data to i16 at 16kHz using high-quality algorithm
    pub fn resample(&mut self, input_data: &[f32]) -> Result<Vec<i16>> {
        if input_data.is_empty() {
            return Ok(Vec::new());
        }

        // Add new input to our buffer (mono, so channel 0)
        self.input_buffer[0].extend_from_slice(input_data);
        let frames_needed = self.resampler.input_frames_next();
        let max_buffer_len = frames_needed * MAX_BUFFERED_CHUNKS;

        if self.input_buffer[0].len() > max_buffer_len {
            let overflow = self.input_buffer[0].len() - max_buffer_len;
            self.input_buffer[0].drain(0..overflow);
            println!(
                "[Resampler] Dropped {} buffered samples to cap backlog at {} frames",
                overflow, max_buffer_len
            );
        }

        let mut output_samples = Vec::new();

        // Process complete chunks
        while self.input_buffer[0].len() >= frames_needed {
            // Take exactly the frames we need
            let chunk: Vec<f32> = self.input_buffer[0].drain(0..frames_needed).collect();
            let input_chunk = vec![chunk];

            // Resize output buffer
            let output_frames = self.resampler.output_frames_next();
            self.output_buffer[0].resize(output_frames, 0.0);

            // Process
            match self
                .resampler
                .process_into_buffer(&input_chunk, &mut self.output_buffer, None)
            {
                Ok((_, out_len)) => {
                    // Convert f32 [-1.0, 1.0] to i16
                    for i in 0..out_len {
                        let sample = self.output_buffer[0][i];
                        let scaled = (sample * 32767.0).clamp(-32768.0, 32767.0);
                        output_samples.push(scaled as i16);
                    }
                }
                Err(e) => {
                    println!("[Resampler] Process error: {}", e);
                }
            }
        }

        Ok(output_samples)
    }
}
