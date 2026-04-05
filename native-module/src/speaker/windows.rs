// Ported logic
use crate::audio_config::RING_BUFFER_SAMPLES;
use anyhow::Result;
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use tracing::error;
use wasapi::{get_default_device, DeviceCollection, Direction, SampleType, ShareMode, WaveFormat};

struct WakerState {
    shutdown: bool,
}

pub struct SpeakerInput {
    device_id: Option<String>,
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>,
    waker_state: Arc<Mutex<WakerState>>,
    capture_thread: Option<thread::JoinHandle<()>>,
    actual_sample_rate: u32,
    data_ready: Arc<(Mutex<bool>, Condvar)>,
    last_error: Arc<Mutex<Option<String>>>,
    dropped_samples: Arc<AtomicU64>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.actual_sample_rate
    }

    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }

    pub fn data_ready_signal(&self) -> Arc<(Mutex<bool>, Condvar)> {
        self.data_ready.clone()
    }

    pub fn take_error(&self) -> Option<String> {
        self.last_error.lock().ok()?.take()
    }

    pub fn take_dropped_samples(&self) -> u64 {
        self.dropped_samples.swap(0, Ordering::Relaxed)
    }
}

// Helper to find device by ID
fn find_device_by_id(direction: &Direction, device_id: &str) -> Option<wasapi::Device> {
    let collection = DeviceCollection::new(direction).ok()?;
    let count = collection.get_nbr_devices().ok()?;

    for i in 0..count {
        if let Ok(device) = collection.get_device_at_index(i) {
            if let Ok(id) = device.get_id() {
                if id == device_id {
                    return Some(device);
                }
            }
        }
    }
    None
}

pub fn list_output_devices() -> Result<Vec<(String, String)>> {
    let collection =
        DeviceCollection::new(&Direction::Render).map_err(|e| anyhow::anyhow!("{}", e))?;
    let count = collection
        .get_nbr_devices()
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    let mut list = Vec::new();

    for i in 0..count {
        if let Ok(device) = collection.get_device_at_index(i) {
            let id = device.get_id().unwrap_or_default();
            let name = device.get_friendlyname().unwrap_or_default();
            if !id.is_empty() {
                list.push((id, name));
            }
        }
    }
    Ok(list)
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let device_id = device_id.filter(|id| !id.is_empty() && id != "default");
        Ok(Self { device_id })
    }

    pub fn stream(self) -> SpeakerStream {
        let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES);
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState { shutdown: false }));
        let data_ready = Arc::new((Mutex::new(false), Condvar::new()));
        let (init_tx, init_rx) = mpsc::channel();

        let waker_clone = waker_state.clone();
        let data_ready_clone = data_ready.clone();
        let last_error = Arc::new(Mutex::new(None));
        let last_error_clone = last_error.clone();
        let dropped_samples = Arc::new(AtomicU64::new(0));
        let dropped_samples_clone = dropped_samples.clone();
        let device_id = self.device_id;

        let capture_thread = thread::spawn(move || {
            if let Err(e) = Self::capture_audio_loop(
                producer,
                waker_clone,
                data_ready_clone,
                init_tx,
                device_id,
                dropped_samples_clone,
            ) {
                if let Ok(mut slot) = last_error_clone.lock() {
                    *slot = Some(e.to_string());
                }
                error!("Audio capture loop failed: {}", e);
            }
        });

        let actual_sample_rate = match init_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(rate)) => rate,
            Ok(Err(e)) => {
                error!("Audio initialization failed: {}", e);
                0
            }
            Err(_) => {
                error!("Audio initialization timeout");
                0
            }
        };

        SpeakerStream {
            consumer: Some(consumer),
            waker_state,
            capture_thread: Some(capture_thread),
            actual_sample_rate,
            data_ready,
            last_error,
            dropped_samples,
        }
    }

    fn capture_audio_loop(
        mut producer: HeapProd<f32>,
        waker_state: Arc<Mutex<WakerState>>,
        data_ready: Arc<(Mutex<bool>, Condvar)>,
        init_tx: mpsc::Sender<Result<u32>>,
        device_id: Option<String>,
        dropped_samples: Arc<AtomicU64>,
    ) -> Result<()> {
        let init_result = (|| -> Result<_> {
            let device = match device_id {
                Some(ref id) => match find_device_by_id(&Direction::Render, id) {
                    Some(d) => d,
                    None => get_default_device(&Direction::Render)
                        .map_err(|e| anyhow::anyhow!("{}", e))
                        .expect("No default render device"),
                },
                None => {
                    get_default_device(&Direction::Render).map_err(|e| anyhow::anyhow!("{}", e))?
                }
            };

            let mut audio_client = device
                .get_iaudioclient()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let device_format = audio_client
                .get_mixformat()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let actual_rate = device_format.get_samplespersec();
            let desired_format =
                WaveFormat::new(32, 32, &SampleType::Float, actual_rate as usize, 1, None);

            let (_def_time, min_time) = audio_client
                .get_periods()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            // For WASAPI loopback: device=Render, but initialize with Direction::Capture
            // This triggers AUDCLNT_STREAMFLAGS_LOOPBACK flag in wasapi
            audio_client
                .initialize_client(
                    &desired_format,
                    min_time,
                    &Direction::Capture,
                    &ShareMode::Shared,
                    true,
                )
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let h_event = audio_client
                .set_get_eventhandle()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let render_client = audio_client
                .get_audiocaptureclient()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            audio_client
                .start_stream()
                .map_err(|e| anyhow::anyhow!("{}", e))?;

            Ok((h_event, render_client, actual_rate, audio_client))
        })();

        match init_result {
            Ok((h_event, render_client, sample_rate, audio_client)) => {
                let _ = init_tx.send(Ok(sample_rate));
                let mut consecutive_timeouts = 0u32;
                const MAX_CONSECUTIVE_TIMEOUTS: u32 = 20; // ~60 seconds of total silence allowed
                loop {
                    {
                        let state = waker_state.lock().unwrap();
                        if state.shutdown {
                            let _ = audio_client.stop_stream();
                            break;
                        }
                    }

                    if h_event.wait_for_event(3000).is_err() {
                        consecutive_timeouts += 1;
                        if consecutive_timeouts >= MAX_CONSECUTIVE_TIMEOUTS {
                            return Err(anyhow::anyhow!(
                                "Timed out waiting for Windows loopback audio event after {}s of silence",
                                MAX_CONSECUTIVE_TIMEOUTS * 3
                            ));
                        }
                        // No audio playing right now — keep waiting
                        continue;
                    }

                    consecutive_timeouts = 0;

                    let mut temp_queue = VecDeque::new();
                    // bytes_per_frame for 32-bit float mono = 4 bytes
                    let bytes_per_frame: usize = 4; // 32-bit float, 1 channel
                    if let Err(e) =
                        render_client.read_from_device_to_deque(bytes_per_frame, &mut temp_queue)
                    {
                        error!("Failed to read audio data: {}", e);
                        continue;
                    }

                    if temp_queue.is_empty() {
                        continue;
                    }

                    let mut samples = Vec::with_capacity(temp_queue.len() / 4);
                    while temp_queue.len() >= 4 {
                        let bytes = [
                            temp_queue.pop_front().unwrap(),
                            temp_queue.pop_front().unwrap(),
                            temp_queue.pop_front().unwrap(),
                            temp_queue.pop_front().unwrap(),
                        ];
                        let sample = f32::from_le_bytes(bytes);
                        samples.push(sample);
                    }

                    if !samples.is_empty() {
                        let written = producer.push_slice(&samples);
                        let dropped = samples.len().saturating_sub(written) as u64;
                        if dropped > 0 {
                            dropped_samples.fetch_add(dropped, Ordering::Relaxed);
                        }

                        // Signal data ready
                        let (lock, cvar) = &*data_ready;
                        let mut ready = lock.lock().unwrap();
                        *ready = true;
                        cvar.notify_all();
                    }
                }
            }
            Err(e) => {
                let message = format!("Failed to initialize Windows loopback audio stream: {}", e);
                let _ = init_tx.send(Err(anyhow::anyhow!(message.clone())));
                return Err(anyhow::anyhow!(message));
            }
        }
        Ok(())
    }
}

// Implement Drop to stop the thread
impl Drop for SpeakerStream {
    fn drop(&mut self) {
        if let Ok(mut state) = self.waker_state.lock() {
            state.shutdown = true;
        }
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
    }
}
