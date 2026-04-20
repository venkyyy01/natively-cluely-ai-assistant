import { EventEmitter } from 'events';
import { assertNativeAudioAvailable, getNativeAudioLoadError, loadNativeAudioModule } from './nativeModule';

const NativeModule = loadNativeAudioModule();

if (!NativeModule) {
    const error = getNativeAudioLoadError();
    console.error('[MicrophoneCapture] ❌ Failed to load native module:', error?.message || 'Unknown error');
    console.error('[MicrophoneCapture] 🔧 This will prevent audio capture from working');
} else {
    console.log('[MicrophoneCapture] ✅ Native module loaded successfully');
    console.log('[MicrophoneCapture] Available exports:', Object.keys(NativeModule));
}

const { MicrophoneCapture: RustMicCapture } = NativeModule || {};

export class MicrophoneCapture extends EventEmitter {
    private monitor: any = null;
    private isRecording: boolean = false;
    private deviceId: string | null = null;

    constructor(deviceId?: string | null) {
        super();
        this.deviceId = deviceId || null;
        const RustMicCtor = assertNativeAudioAvailable('MicrophoneCapture')?.MicrophoneCapture;
        if (!RustMicCtor) {
            throw new Error('[MicrophoneCapture] Rust class implementation not found.');
        }

        console.log(`[MicrophoneCapture] Initialized wrapper. Device ID: ${this.deviceId || 'default'}`);
        try {
            console.log('[MicrophoneCapture] Creating native monitor (Eager Init)...');
            this.monitor = new RustMicCtor(this.deviceId);
        } catch (e) {
            console.error('[MicrophoneCapture] Failed to create native monitor:', e);
            throw e;
        }
    }

    public getSampleRate(): number {
        if (this.monitor && typeof this.monitor.getSampleRate === 'function') {
            const nativeRate = this.monitor.getSampleRate();
            console.log(`[MicrophoneCapture] Real native rate: ${nativeRate}`);
            return nativeRate;
        }
        return 48000; // Safe default for most modern mics before native initialization
    }

    /**
     * PCM sample rate of buffers emitted on `data` (after native polyphase resample, NAT-043).
     * Use this for STT `setSampleRate`; use `getSampleRate()` for hardware/native diagnostics.
     */
    public getOutputSampleRate(): number {
        if (this.monitor && typeof this.monitor.getOutputSampleRate === 'function') {
            return this.monitor.getOutputSampleRate() as number;
        }
        return 16000;
    }

    /**
     * Start capturing microphone audio
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustMicCapture) {
            throw new Error(getNativeAudioLoadError()?.message || '[MicrophoneCapture] Cannot start: Rust module missing');
        }

        // Monitor should be ready from constructor
        if (!this.monitor) {
            console.log('[MicrophoneCapture] Monitor not initialized. Re-initializing...');
            try {
                this.monitor = new RustMicCapture(this.deviceId);
            } catch (e) {
                console.error('[MicrophoneCapture] Failed to re-initialize monitor:', e);
                this.emit('error', e);
                throw e;
            }
        }

        try {
            console.log('[MicrophoneCapture] Starting native capture...');

            this.monitor.start((first: Uint8Array | Error | null, second?: Uint8Array) => {
                // napi-rs ThreadsafeFunction (CalleeHandled) invokes us as
                // `(err, value)`. A panic inside the Rust DSP thread is now
                // surfaced as `(Error, undefined)` instead of aborting the
                // host process — emit it as a typed error so the existing
                // recovery loop in `handleAudioCaptureError` re-runs the
                // audio pipeline (and through it, STTReconnector).
                if (first instanceof Error) {
                    const panicErr = new Error(`audio_thread_panic: ${first.message}`);
                    (panicErr as Error & { code?: string }).code = 'AUDIO_THREAD_PANIC';
                    console.error('[MicrophoneCapture] Native DSP thread panicked:', first);
                    this.emit('error', panicErr);
                    return;
                }
                const chunk = second ?? first;
                if (chunk && chunk.length > 0) {
                    if (Math.random() < 0.05) {
                        console.log(`[MicrophoneCapture] Emitting chunk: ${chunk.length} bytes to JS`);
                    }
                    this.emit('data', Buffer.from(chunk));
                }
            }, () => {
                this.emit('speech_ended');
            });

            this.isRecording = true;
            this.emit('start');
        } catch (error) {
            console.error('[MicrophoneCapture] Failed to start:', error);
            this.emit('error', error);
        }
    }

    /**
     * Stop capturing
     */
    public stop(): void {
        if (!this.isRecording) return;

        console.log('[MicrophoneCapture] Stopping capture...');
        try {
            this.monitor?.stop();
        } catch (e) {
            console.error('[MicrophoneCapture] Error stopping:', e);
        }

        // DO NOT destroy monitor here. Keep it alive for seamless restart.
        // this.monitor = null; 

        this.isRecording = false;
        this.emit('stop');
    }

  /**
  * Fully destroy the capture instance, releasing all native resources.
  * Use this when completely tearing down audio (e.g., reconfigureAudio, app quit).
  * For pause/resume, use stop() instead.
  */
  public destroy(): void {
    this.stop();
    this.monitor = null;
    this.removeAllListeners();
  }
}
