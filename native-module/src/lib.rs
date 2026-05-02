#![deny(clippy::all)]
#![allow(unexpected_cfgs, deprecated)]

#[macro_use]
extern crate napi_derive;

use std::any::Any;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use ringbuf::traits::Consumer;

pub mod audio_config;
pub mod license;
pub mod microphone;
pub mod resampler;
pub mod silence_suppression;
pub mod speaker;
pub mod stealth;

use crate::audio_config::DSP_POLL_MS;
use crate::resampler::PolyphaseResampler;
use crate::silence_suppression::{FrameAction, SilenceSuppressionConfig, SilenceSuppressor};

// ============================================================================
// HELPERS — i16 slice → zero-copy LE bytes
// ============================================================================

/// Convert an i16 slice to little-endian bytes.
/// Returns a Vec<u8> suitable for wrapping in napi::Buffer.
#[inline]
fn i16_slice_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

/// 20ms of mono silence at `output_sr` (STT-facing rate after NAT-043 resample).
fn silence_pcm_le_bytes_20ms(output_sr: u32) -> Vec<u8> {
    let samples = (output_sr as usize) / 50;
    vec![0u8; samples.saturating_mul(2)]
}

/// Convert a panic payload (as returned by `catch_unwind`) into a printable string.
/// Matches the shapes most commonly produced by `panic!()` and `assert!()`.
fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "unknown panic payload".to_string()
}

/// Run a closure under `catch_unwind`. On panic, returns Err(message). On success, returns Ok(()).
/// `label` is used purely for the error log written to stderr when a panic is caught.
fn run_dsp_thread_body<F>(label: &str, body: F) -> std::result::Result<(), String>
where
    F: FnOnce(),
{
    match std::panic::catch_unwind(AssertUnwindSafe(body)) {
        Ok(()) => Ok(()),
        Err(payload) => {
            let msg = panic_payload_to_string(payload);
            eprintln!("[{}] DSP thread panicked: {}", label, msg);
            Err(msg)
        }
    }
}

fn join_thread_with_timeout(handle: thread::JoinHandle<()>, timeout: Duration, label: &str) {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(handle.join());
    });

    match rx.recv_timeout(timeout) {
        Ok(_) => {}
        Err(mpsc::RecvTimeoutError::Timeout) => {
            eprintln!(
                "[{}] DSP thread did not exit in {:?}, detaching",
                label, timeout
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            eprintln!("[{}] DSP thread join channel disconnected", label);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{join_thread_with_timeout, panic_payload_to_string, run_dsp_thread_body};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn join_thread_with_timeout_handles_fast_shutdown() {
        let handle = thread::spawn(|| {});
        join_thread_with_timeout(handle, Duration::from_millis(50), "test");
    }

    #[test]
    fn join_thread_with_timeout_handles_timeout_without_panicking() {
        let handle = thread::spawn(|| thread::sleep(Duration::from_millis(100)));
        join_thread_with_timeout(handle, Duration::from_millis(1), "test");
        thread::sleep(Duration::from_millis(120));
    }

    #[test]
    fn panic_payload_to_string_handles_str_literals() {
        let payload: Box<dyn std::any::Any + Send> = Box::new("boom");
        assert_eq!(panic_payload_to_string(payload), "boom");
    }

    #[test]
    fn panic_payload_to_string_handles_string() {
        let payload: Box<dyn std::any::Any + Send> = Box::new(String::from("kaboom"));
        assert_eq!(panic_payload_to_string(payload), "kaboom");
    }

    #[test]
    fn run_dsp_thread_body_returns_ok_on_clean_exit() {
        let result = run_dsp_thread_body("clean", || {
            // do nothing — simulates a normal DSP shutdown.
        });
        assert!(result.is_ok());
    }

    #[test]
    fn run_dsp_thread_body_catches_panic_and_returns_message() {
        let result = run_dsp_thread_body("panicker", || panic!("simulated audio thread panic"));
        match result {
            Ok(()) => panic!("expected panic to be caught"),
            Err(msg) => assert!(
                msg.contains("simulated audio thread panic"),
                "unexpected panic message: {msg}"
            ),
        }
    }

    #[test]
    fn run_dsp_thread_body_panic_does_not_abort_process() {
        // Spawn a worker thread that panics inside the boundary. If the panic
        // boundary is missing, this test would terminate the process. The
        // assertion below proves the panic was contained and observable.
        let observed = Arc::new(AtomicBool::new(false));
        let observed_clone = observed.clone();
        let handle = thread::spawn(move || {
            let result = run_dsp_thread_body("worker", || panic!("from inside worker"));
            if result.is_err() {
                observed_clone.store(true, Ordering::SeqCst);
            }
        });
        handle
            .join()
            .expect("worker thread should not abort process");
        assert!(
            observed.load(Ordering::SeqCst),
            "panic boundary should report Err"
        );
    }
}

// ============================================================================
// SYSTEM AUDIO CAPTURE (CoreAudio Tap / ScreenCaptureKit on macOS)
// ============================================================================

#[napi]
pub struct SystemAudioCapture {
    stop_signal: Arc<AtomicBool>,
    capture_thread: Option<thread::JoinHandle<()>>,
    /// Shared atomic sample rate — updated by the background thread once the
    /// native device is initialized. Callers always get the real hardware rate.
    sample_rate: Arc<AtomicU32>,
    device_id: Option<String>,
    /// PCM sample rate delivered to JS (16k or 24k) after polyphase resample (NAT-043).
    output_sample_rate: u32,
}

#[napi]
impl SystemAudioCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>, output_sample_rate: Option<u32>) -> napi::Result<Self> {
        let out_sr = output_sample_rate.unwrap_or(16_000);
        if out_sr != 16_000 && out_sr != 24_000 {
            return Err(napi::Error::from_reason(format!(
                "output_sample_rate must be 16000 or 24000, got {}",
                out_sr
            )));
        }
        println!(
            "[SystemAudioCapture] Created (device: {:?}, output_pcm_hz: {})",
            device_id, out_sr
        );

        Ok(SystemAudioCapture {
            stop_signal: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            // Default to 48000 until the background thread reports the real rate.
            // 48kHz is the standard macOS CoreAudio rate.
            sample_rate: Arc::new(AtomicU32::new(48000)),
            device_id,
            output_sample_rate: out_sr,
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate.load(Ordering::Acquire)
    }

    /// Sample rate of PCM buffers emitted to JS (after native polyphase resample).
    #[napi]
    pub fn get_output_sample_rate(&self) -> u32 {
        self.output_sample_rate
    }

    #[napi]
    pub fn start(
        &mut self,
        callback: JsFunction,
        on_speech_ended: Option<JsFunction>,
    ) -> napi::Result<()> {
        // CalleeHandled: a thrown JS callback won't abort the host process.
        // The JS side already supports both `(chunk)` and `(err, chunk)` arities.
        let tsfn: ThreadsafeFunction<Buffer, ErrorStrategy::CalleeHandled> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;
        // Cloned handle reserved for delivering an `audio_thread_panic` event
        // to JS if the DSP thread panics.
        let tsfn_for_panic = tsfn.clone();

        let speech_ended_tsfn: Option<ThreadsafeFunction<bool, ErrorStrategy::CalleeHandled>> =
            match on_speech_ended {
                Some(f) => Some(f.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?),
                None => None,
            };

        self.stop_signal.store(false, Ordering::SeqCst);
        let stop_signal = self.stop_signal.clone();
        let device_id = self.device_id.as_ref().cloned();
        let sample_rate_shared = self.sample_rate.clone();
        let output_sr = self.output_sample_rate;

        // ★ ALL init + DSP runs in background thread — start() returns INSTANTLY
        // This prevents the 5-7 second main-thread block from SCK initialization.
        self.capture_thread = Some(thread::spawn(move || {
            let dsp_body = move || {
                // 1. SCK Init (takes 5-7 seconds — runs OFF main thread)
                println!("[SystemAudioCapture] Background init starting...");
                let input = match speaker::SpeakerInput::new(device_id) {
                    Ok(i) => i,
                    Err(e) => {
                        println!("[SystemAudioCapture] Init failed: {}. Trying default...", e);
                        match speaker::SpeakerInput::new(None) {
                            Ok(i) => i,
                            Err(e2) => {
                                eprintln!(
                                    "[SystemAudioCapture] FATAL: All init attempts failed: {}",
                                    e2
                                );
                                return;
                            }
                        }
                    }
                };

                let mut stream = input.stream();
                let mut consumer = match stream.take_consumer() {
                    Some(c) => c,
                    None => {
                        eprintln!("[SystemAudioCapture] FATAL: Failed to get consumer");
                        return;
                    }
                };

                let native_rate = stream.sample_rate();
                // Publish the real native rate so JS can read it via get_sample_rate()
                sample_rate_shared.store(native_rate, Ordering::Release);
                println!(
                "[SystemAudioCapture] Background init complete. Initial Rate: {}Hz. DSP starting.",
                native_rate
            );

                // 2. DSP loop with silence suppression + WebRTC VAD
                let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
                    native_sample_rate: native_rate,
                    ..SilenceSuppressionConfig::for_system_audio()
                });

                // 20ms chunks at native rate (e.g. 960 samples at 48kHz)
                let chunk_size = (native_rate as usize / 1000) * 20;
                let mut pcm_resampler =
                    match PolyphaseResampler::new(native_rate, output_sr, chunk_size) {
                        Ok(r) => r,
                        Err(e) => {
                            eprintln!(
                                "[SystemAudioCapture] FATAL: polyphase resampler ({}Hz → {}Hz): {}",
                                native_rate, output_sr, e
                            );
                            return;
                        }
                    };
                let silence_out = silence_pcm_le_bytes_20ms(output_sr);

                let mut frame_buffer: Vec<i16> = Vec::with_capacity(chunk_size * 4);
                let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);
                let mut last_emit_at = Instant::now();

                loop {
                    if stop_signal.load(Ordering::Relaxed) {
                        break;
                    }

                    // Drain ALL available samples from ring buffer (lock-free)
                    while let Some(sample) = consumer.try_pop() {
                        raw_batch.push(sample);
                    }

                    // Convert f32 -> i16 at native sample rate
                    if !raw_batch.is_empty() {
                        for &f in &raw_batch {
                            let scaled = (f * 32767.0).clamp(-32768.0, 32767.0);
                            frame_buffer.push(scaled as i16);
                        }
                        raw_batch.clear();
                    }

                    // Process in 20ms chunks through the two-stage gate
                    while frame_buffer.len() >= chunk_size {
                        let frame: Vec<i16> = frame_buffer.drain(0..chunk_size).collect();

                        let (action, speech_ended) = suppressor.process(&frame);

                        match action {
                            FrameAction::Send(data) => match pcm_resampler.push_i16(&data) {
                                Ok(out) if !out.is_empty() => {
                                    let bytes = i16_slice_to_le_bytes(&out);
                                    tsfn.call(
                                        Ok(Buffer::from(bytes)),
                                        ThreadsafeFunctionCallMode::NonBlocking,
                                    );
                                    last_emit_at = Instant::now();
                                }
                                Ok(_) => {}
                                Err(e) => eprintln!("[SystemAudioCapture] resample: {}", e),
                            },
                            FrameAction::SendSilence => {
                                tsfn.call(
                                    Ok(Buffer::from(silence_out.clone())),
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );
                                last_emit_at = Instant::now();
                            }
                            FrameAction::Suppress => {
                                // Do nothing — bandwidth saving
                            }
                        }

                        if speech_ended {
                            if let Some(ref se_tsfn) = speech_ended_tsfn {
                                se_tsfn.call(Ok(true), ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                    }

                    if raw_batch.is_empty()
                        && frame_buffer.is_empty()
                        && last_emit_at.elapsed() >= Duration::from_millis(100)
                    {
                        tsfn.call(
                            Ok(Buffer::from(silence_out.clone())),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                        last_emit_at = Instant::now();
                    }

                    thread::sleep(Duration::from_millis(DSP_POLL_MS));
                }

                println!("[SystemAudioCapture] DSP thread stopped.");
                // stream is dropped here → SpeakerStream::Drop calls stop_with_ch
            };

            // Run the DSP body under a panic boundary so a fault in audio
            // processing surfaces as a typed event to JS instead of aborting
            // the Electron process.
            if let Err(panic_msg) = run_dsp_thread_body("SystemAudioCapture", dsp_body) {
                let err = napi::Error::new(
                    napi::Status::GenericFailure,
                    format!("audio_thread_panic: {}", panic_msg),
                );
                tsfn_for_panic.call(Err(err), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            join_thread_with_timeout(handle, Duration::from_secs(2), "SystemAudioCapture");
        }
    }
}

// ============================================================================
// MICROPHONE CAPTURE (CPAL)
//
// Design: The MicrophoneStream (CPAL handle) is recreated on every start()
// call. This guarantees the ring buffer consumer is always fresh, allowing
// seamless stop→start restart cycles (e.g. between meetings).
// ============================================================================

#[napi]
pub struct MicrophoneCapture {
    stop_signal: Arc<AtomicBool>,
    capture_thread: Option<thread::JoinHandle<()>>,
    /// Shared atomic sample rate — updated once the CPAL device is opened.
    sample_rate: Arc<AtomicU32>,
    /// Stores the requested device ID for recreation on restart.
    device_id: Option<String>,
    /// Holds the live CPAL stream. Recreated on each start().
    input: Option<microphone::MicrophoneStream>,
    /// PCM rate delivered to JS after resample (NAT-043).
    output_sample_rate: u32,
}

#[napi]
impl MicrophoneCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>, output_sample_rate: Option<u32>) -> napi::Result<Self> {
        let out_sr = output_sample_rate.unwrap_or(16_000);
        if out_sr != 16_000 && out_sr != 24_000 {
            return Err(napi::Error::from_reason(format!(
                "output_sample_rate must be 16000 or 24000, got {}",
                out_sr
            )));
        }
        // Eagerly create the stream to detect device errors early and read the
        // native sample rate.
        let input = match microphone::MicrophoneStream::new(device_id.clone()) {
            Ok(i) => i,
            Err(e) => return Err(napi::Error::from_reason(format!("Failed: {}", e))),
        };

        let native_rate = input.sample_rate();
        println!(
            "[MicrophoneCapture] Initialized. Device: {:?}, native={}Hz, output_pcm_hz={}",
            device_id, native_rate, out_sr
        );

        Ok(MicrophoneCapture {
            stop_signal: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            sample_rate: Arc::new(AtomicU32::new(native_rate)),
            device_id,
            input: Some(input),
            output_sample_rate: out_sr,
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate.load(Ordering::Acquire)
    }

    #[napi]
    pub fn get_output_sample_rate(&self) -> u32 {
        self.output_sample_rate
    }

    #[napi]
    pub fn start(
        &mut self,
        callback: JsFunction,
        on_speech_ended: Option<JsFunction>,
    ) -> napi::Result<()> {
        // CalleeHandled so a JS-side throw doesn't abort the host process.
        let tsfn: ThreadsafeFunction<Buffer, ErrorStrategy::CalleeHandled> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;
        // Cloned handle reserved for delivering an `audio_thread_panic` event
        // to JS if the DSP thread panics.
        let tsfn_for_panic = tsfn.clone();

        let speech_ended_tsfn: Option<ThreadsafeFunction<bool, ErrorStrategy::CalleeHandled>> =
            match on_speech_ended {
                Some(f) => Some(f.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?),
                None => None,
            };

        self.stop_signal.store(false, Ordering::SeqCst);
        let stop_signal = self.stop_signal.clone();
        let output_sr = self.output_sample_rate;

        // If the stream was consumed by a previous start() cycle, recreate it.
        // This is the fix for the one-shot take_consumer() bug.
        if self.input.is_none() {
            println!("[MicrophoneCapture] Recreating CPAL stream for restart...");
            match microphone::MicrophoneStream::new(self.device_id.clone()) {
                Ok(i) => {
                    let rate = i.sample_rate();
                    self.sample_rate.store(rate, Ordering::Release);
                    self.input = Some(i);
                }
                Err(e) => {
                    return Err(napi::Error::from_reason(format!(
                        "[MicrophoneCapture] Failed to recreate stream: {}",
                        e
                    )));
                }
            }
        }

        let input_ref = self
            .input
            .as_mut()
            .ok_or_else(|| napi::Error::from_reason("Input missing"))?;

        input_ref
            .play()
            .map_err(|e| napi::Error::from_reason(format!("{}", e)))?;

        let native_rate = input_ref.sample_rate();
        self.sample_rate.store(native_rate, Ordering::Release);

        let mut consumer = input_ref
            .take_consumer()
            .ok_or_else(|| napi::Error::from_reason("Failed to get consumer"))?;

        // DSP thread with silence suppression + WebRTC VAD
        self.capture_thread = Some(thread::spawn(move || {
            let dsp_body = move || {
                let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
                    native_sample_rate: native_rate,
                    ..SilenceSuppressionConfig::for_microphone()
                });

                // 20ms chunks at native rate
                let chunk_size = (native_rate as usize / 1000) * 20;
                let mut pcm_resampler =
                    match PolyphaseResampler::new(native_rate, output_sr, chunk_size) {
                        Ok(r) => r,
                        Err(e) => {
                            eprintln!(
                                "[MicrophoneCapture] FATAL: polyphase resampler ({}Hz → {}Hz): {}",
                                native_rate, output_sr, e
                            );
                            return;
                        }
                    };
                let silence_out = silence_pcm_le_bytes_20ms(output_sr);

                let mut frame_buffer: Vec<i16> = Vec::with_capacity(chunk_size * 4);
                let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);

                println!(
                "[MicrophoneCapture] DSP thread started (VAD + suppression + resample {}→{}Hz, chunk={})",
                native_rate, output_sr, chunk_size
            );

                loop {
                    if stop_signal.load(Ordering::Relaxed) {
                        break;
                    }

                    while let Some(sample) = consumer.try_pop() {
                        raw_batch.push(sample);
                    }

                    if !raw_batch.is_empty() {
                        for &f in &raw_batch {
                            let scaled = (f * 32767.0).clamp(-32768.0, 32767.0);
                            frame_buffer.push(scaled as i16);
                        }
                        raw_batch.clear();
                    }

                    while frame_buffer.len() >= chunk_size {
                        let frame: Vec<i16> = frame_buffer.drain(0..chunk_size).collect();

                        let (action, speech_ended) = suppressor.process(&frame);

                        match action {
                            FrameAction::Send(data) => match pcm_resampler.push_i16(&data) {
                                Ok(out) if !out.is_empty() => {
                                    let bytes = i16_slice_to_le_bytes(&out);
                                    tsfn.call(
                                        Ok(Buffer::from(bytes)),
                                        ThreadsafeFunctionCallMode::NonBlocking,
                                    );
                                }
                                Ok(_) => {}
                                Err(e) => eprintln!("[MicrophoneCapture] resample: {}", e),
                            },
                            FrameAction::SendSilence => {
                                tsfn.call(
                                    Ok(Buffer::from(silence_out.clone())),
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );
                            }
                            FrameAction::Suppress => {
                                // Do nothing
                            }
                        }

                        if speech_ended {
                            if let Some(ref se_tsfn) = speech_ended_tsfn {
                                se_tsfn.call(Ok(true), ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                    }

                    thread::sleep(Duration::from_millis(DSP_POLL_MS));
                }

                println!("[MicrophoneCapture] DSP thread stopped.");
            };

            // Run the DSP body under a panic boundary so a fault in audio
            // processing surfaces as a typed event to JS instead of aborting
            // the Electron process.
            if let Err(panic_msg) = run_dsp_thread_body("MicrophoneCapture", dsp_body) {
                let err = napi::Error::new(
                    napi::Status::GenericFailure,
                    format!("audio_thread_panic: {}", panic_msg),
                );
                tsfn_for_panic.call(Err(err), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            join_thread_with_timeout(handle, Duration::from_secs(2), "MicrophoneCapture");
        }
        // Pause and destroy the CPAL stream so start() recreates it fresh.
        if let Some(ref input) = self.input {
            let _ = input.pause();
        }
        self.input = None;
    }
}

// ============================================================================
// DEVICE ENUMERATION
// ============================================================================

#[napi(object)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
}

#[napi]
pub fn get_input_devices() -> Vec<AudioDeviceInfo> {
    match microphone::list_input_devices() {
        Ok(devs) => devs
            .into_iter()
            .map(|(id, name)| AudioDeviceInfo { id, name })
            .collect(),
        Err(e) => {
            eprintln!("[get_input_devices] Error: {}", e);
            Vec::new()
        }
    }
}

#[napi]
pub fn get_output_devices() -> Vec<AudioDeviceInfo> {
    match speaker::list_output_devices() {
        Ok(devs) => devs
            .into_iter()
            .map(|(id, name)| AudioDeviceInfo { id, name })
            .collect(),
        Err(e) => {
            eprintln!("[get_output_devices] Error: {}", e);
            Vec::new()
        }
    }
}
