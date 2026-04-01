import { EventEmitter } from 'events';
import { assertNativeAudioAvailable, getNativeAudioLoadError, loadNativeAudioModule } from './nativeModule';

const NativeModule = loadNativeAudioModule();

if (!NativeModule) {
    console.error('[SystemAudioCapture] Failed to load native module:', getNativeAudioLoadError());
}

const { SystemAudioCapture: RustAudioCapture } = NativeModule || {};
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_READY_TIMEOUT_MS = 3_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 25;

export class SystemAudioCapture extends EventEmitter {
    private isRecording: boolean = false;
    private deviceId: string | null = null;
    private detectedSampleRate: number = DEFAULT_SAMPLE_RATE;
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
        const backendHint = this.deviceId === 'sck'
            ? 'auto (SCK requested)'
            : this.deviceId
                ? `explicit device (${this.deviceId})`
                : 'auto (default)';
        console.log(`[SystemAudioCapture] Initialized (lazy). Device ID: ${this.deviceId || 'default'}, backend hint: ${backendHint}`);
    }

    private ensureMonitor(reason: 'start'): boolean {
        if (this.monitor) {
            return true;
        }

        if (!RustAudioCapture) {
            throw new Error(getNativeAudioLoadError()?.message || '[SystemAudioCapture] Cannot start: Rust module missing');
        }

        console.log('[SystemAudioCapture] Creating native monitor (lazy init)...');
        try {
            this.monitor = new RustAudioCapture(this.deviceId);
            return true;
        } catch (error) {
            console.error('[SystemAudioCapture] Failed to create native monitor:', error);
            this.emit('error', error);
            return false;
        }
    }

    public getSampleRate(): number {
        return this.detectedSampleRate;
    }

    private isMonitorInitialized(): boolean {
        return Boolean(
            this.monitor &&
            typeof this.monitor.isInitialized === 'function' &&
            this.monitor.isInitialized(),
        );
    }

    public refreshSampleRate(): number {
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

    public async waitForReady(
        timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
        pollIntervalMs: number = DEFAULT_READY_POLL_INTERVAL_MS,
    ): Promise<number> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() <= deadline) {
            const rate = this.refreshSampleRate();
            if (this.isMonitorInitialized()) {
                console.log(`[SystemAudioCapture] Native monitor ready at ${rate}Hz`);
                return rate;
            }

            await new Promise<void>((resolve) => {
                setTimeout(resolve, pollIntervalMs);
            });
        }

        const rate = this.refreshSampleRate();
        console.warn(`[SystemAudioCapture] Timed out waiting for native readiness. Using ${rate}Hz`);
        return rate;
    }

    /**
     * Start capturing audio
     */
    public start(): void {
        if (this.isRecording) return;

        if (!RustAudioCapture) {
            throw new Error(getNativeAudioLoadError()?.message || '[SystemAudioCapture] Cannot start: Rust module missing');
        }

        // Create the monitor on demand at meeting start to avoid startup audio glitches.
        if (!this.ensureMonitor('start')) {
            return;
        }

        try {
            console.log('[SystemAudioCapture] Starting native capture...');

            this.monitor.start((first: Uint8Array | null, second?: Uint8Array) => {
                // napi-rs ThreadsafeFunction payloads can arrive as either `(chunk)` or
                // `(err, chunk)` depending on the native ErrorStrategy. Support both.
                const chunk = second ?? first;
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
