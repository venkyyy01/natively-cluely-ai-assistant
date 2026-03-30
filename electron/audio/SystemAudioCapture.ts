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

    constructor(deviceId?: string | null) {
        super();
        this.deviceId = deviceId || null;
        const RustAudioCtor = assertNativeAudioAvailable('SystemAudioCapture')?.SystemAudioCapture;
        if (!RustAudioCtor) {
            throw new Error('[SystemAudioCapture] Rust class implementation not found.');
        }

        // LAZY INIT: Don't create native monitor here - it causes 1-second audio mute + quality drop
        // The monitor will be created in start() when the meeting actually begins
        console.log(`[SystemAudioCapture] Initialized (lazy). Device ID: ${this.deviceId || 'default'}`);
    }

    public getSampleRate(): number {
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
     * Start capturing audio
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustAudioCapture) {
            throw new Error(getNativeAudioLoadError()?.message || '[SystemAudioCapture] Cannot start: Rust module missing');
        }

        // LAZY INIT: Create monitor here when meeting starts (not in constructor)
        // This prevents the 1-second audio mute + quality drop at app launch
        if (!this.monitor) {
            console.log('[SystemAudioCapture] Creating native monitor (lazy init)...');
            try {
                this.monitor = new RustAudioCapture(this.deviceId);
            } catch (e) {
                console.error('[SystemAudioCapture] Failed to create native monitor:', e);
                this.emit('error', e);
                return;
            }
        }

        try {
            console.log('[SystemAudioCapture] Starting native capture...');
            
            // Fetch real sample rate as soon as monitor starts
            if (typeof this.monitor.getSampleRate === 'function') {
                this.detectedSampleRate = this.monitor.getSampleRate();
                console.log(`[SystemAudioCapture] Detected sample rate: ${this.detectedSampleRate}`);
            }

            this.monitor.start((chunk: Uint8Array) => {
                // The native module sends raw PCM bytes (Uint8Array) via zero-copy napi::Buffer
                if (chunk && chunk.length > 0) {
                    const buffer = Buffer.from(chunk);
                    this.emit('data', buffer);
                }
            }, () => {
                // Speech-ended callback from Rust SilenceSuppressor
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
