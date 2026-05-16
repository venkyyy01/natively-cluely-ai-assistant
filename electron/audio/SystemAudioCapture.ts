import { EventEmitter } from 'events';
import { assertNativeAudioAvailable, getNativeAudioLoadError, loadNativeAudioModule } from './nativeModule';

const NativeModule = loadNativeAudioModule();

if (!NativeModule) {
    console.error('[SystemAudioCapture] Failed to load native module:', getNativeAudioLoadError());
}

const { SystemAudioCapture: RustAudioCapture } = NativeModule || {};

export class SystemAudioCapture extends EventEmitter {
    private isRecording: boolean = false;
    private deviceId: string | null = null;
    private detectedSampleRate: number = 48000;
    private monitor: any = null;
    private isNativeAvailable: boolean = false;

    constructor(deviceId?: string | null) {
        super();
        this.deviceId = deviceId || null;
        
        try {
            const nativeModule = assertNativeAudioAvailable('SystemAudioCapture');
            const RustAudioCtor = nativeModule?.SystemAudioCapture;
            if (!RustAudioCtor) {
                // CRITICAL: This must throw to maintain API contract - tests depend on this
                throw new Error('Rust class implementation not found');
            }
            this.isNativeAvailable = true;
            // LAZY INIT: Don't create native monitor here - it causes 1-second audio mute + quality drop
            // The monitor will be created in start() when the meeting actually begins
            console.log(`[SystemAudioCapture] ✅ Initialized (lazy). Device ID: ${this.deviceId || 'default'}`);
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            // CRITICAL: Throw for missing implementation (test requirement)
            if (errorMessage.includes('Rust class implementation not found')) {
                throw e;
            }
            // For other errors, fall back gracefully
            console.error('[SystemAudioCapture] ❌ Failed to initialize native audio module:', e);
            console.warn('[SystemAudioCapture] 🔄 Falling back to software-only mode');
            this.isNativeAvailable = false;
        }
    }

    private ensureMonitor(reason: 'probe' | 'start'): boolean {
        if (this.monitor) {
            return true;
        }

        if (!this.isNativeAvailable) {
            if (reason === 'start') {
                console.error('[SystemAudioCapture] ⚠️ Cannot start: Native audio module not available');
                this.emit('error', new Error('Native audio module not available - system audio capture disabled'));
            }
            return false;
        }

        if (!RustAudioCapture) {
            if (reason === 'start') {
                const error = getNativeAudioLoadError()?.message || '[SystemAudioCapture] Cannot start: Rust module missing';
                console.error('[SystemAudioCapture] ❌', error);
                this.emit('error', new Error(error));
            }
            return false;
        }

        console.log(`[SystemAudioCapture] Creating native monitor (${reason === 'probe' ? 'sample-rate probe' : 'lazy init'})...`);
        try {
            this.monitor = new RustAudioCapture(this.deviceId);
            return true;
        } catch (error) {
            console.error('[SystemAudioCapture] Failed to create native monitor:', error);
            if (reason === 'start') {
                this.emit('error', error);
            }
            return false;
        }
    }

    public getSampleRate(): number {
        if (!this.monitor && !this.ensureMonitor('probe')) {
            return this.detectedSampleRate;
        }

        if (this.monitor && typeof this.monitor.getSampleRate === 'function') {
            const nativeRate = this.monitor.getSampleRate();
            if (nativeRate !== this.detectedSampleRate) {
                console.log(`[SystemAudioCapture] Real native rate: ${nativeRate}`);
                this.detectedSampleRate = nativeRate;
            }
            return nativeRate;
        }
        return this.detectedSampleRate;
    }

    /**
     * PCM sample rate of buffers emitted on `data` (after native polyphase resample, NAT-043).
     * Use for STT `setSampleRate`; use `getSampleRate()` for hardware/native diagnostics.
     */
    public getOutputSampleRate(): number {
        if (!this.monitor && !this.ensureMonitor('probe')) {
            return 16000;
        }
        if (this.monitor && typeof this.monitor.getOutputSampleRate === 'function') {
            return this.monitor.getOutputSampleRate() as number;
        }
        return 16000;
    }

    /**
     * Start capturing audio
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustAudioCapture) {
            throw new Error(getNativeAudioLoadError()?.message || '[SystemAudioCapture] Cannot start: Rust module missing');
        }

        // Create the monitor on demand at meeting start or when sample-rate probing needs it.
        if (!this.ensureMonitor('start')) {
            return;
        }

        try {
            console.log('[SystemAudioCapture] Starting native capture...');
            
            // Fetch real sample rate as soon as monitor starts
            if (typeof this.monitor.getSampleRate === 'function') {
                this.detectedSampleRate = this.monitor.getSampleRate();
                console.log(`[SystemAudioCapture] Detected sample rate: ${this.detectedSampleRate}`);
            }

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
                    console.error('[SystemAudioCapture] Native DSP thread panicked:', first);
                    this.emit('error', panicErr);
                    return;
                }
                const chunk = second ?? first;
                if (chunk && chunk.length > 0) {
                    const buffer = Buffer.from(chunk);
                    this.emit('data', buffer);
                }
            }, () => {
                this.emit('speech_ended');
            });

            this.isRecording = true;
            this.emit('start');
        } catch (error) {
            console.error('[SystemAudioCapture] Failed to start:', error);
            this.emit('error', error);
        }
    }

  /**
  * Stop capturing
  */
  public stop(): void {
    if (!this.isRecording) return;

    console.log('[SystemAudioCapture] Stopping capture...');
    try {
      this.monitor?.stop();
    } catch (e) {
      console.error('[SystemAudioCapture] Error stopping:', e);
    }

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
