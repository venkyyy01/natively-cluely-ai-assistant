/**
 * DeepgramStreamingSTT - WebSocket-based streaming Speech-to-Text using Deepgram Nova-3
 *
 * Implements the same EventEmitter interface as GoogleSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount()
 *
 * Sends raw PCM (linear16, 16-bit LE) over WebSocket — NO WAV header.
 * Receives interim and final transcription results in real time.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { resampleToMonoPcm16 } from './pcm';

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10000;
const KEEPALIVE_INTERVAL_MS = 5000;
const CONNECT_TIMEOUT_MS = 10000;
const LIVENESS_CHECK_INTERVAL_MS = 5000;
const INBOUND_STALL_TIMEOUT_MS = 15000;
const CONNECTION_GUARD_INTERVAL_MS = 8000;
const MAX_BUFFER_SIZE = 500;

/**
 * Ring buffer for O(1) push/pop operations.
 * Replaces array.shift() which is O(n) on large arrays.
 */
class AudioChunkBuffer {
  private buffer: (Buffer | null)[];
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity).fill(null);
  }

  push(chunk: Buffer): void {
    this.buffer[this.tail] = chunk;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    if (this.count > this.capacity) {
      // Overwrite oldest
      this.head = (this.head + 1) % this.capacity;
      this.count = this.capacity;
    }
  }

  shift(): Buffer | null {
    if (this.count === 0) return null;
    const chunk = this.buffer[this.head];
    this.buffer[this.head] = null;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return chunk;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.buffer.fill(null);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

export class DeepgramStreamingSTT extends EventEmitter {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private isActive = false;
  private shouldReconnect = false;

  private inputSampleRate = 16000;
  private numChannels = 1;
  private readonly targetSampleRate = 16000;
  private languageCode = 'en'; // Default to English

  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private connectTimeoutTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private connectionGuardTimer: NodeJS.Timeout | null = null;
  private buffer: AudioChunkBuffer = new AudioChunkBuffer(MAX_BUFFER_SIZE);
  private isConnecting = false;
  private lastInterimTranscript = '';
  private lastInterimConfidence = 1;
  private lastInboundActivityAt = 0;
  private lastAudioActivityAt = 0;

    constructor(apiKey: string) {
        super();
        this.apiKey = apiKey;
    }

    // =========================================================================
    // Configuration (match GoogleSTT / RestSTT interface)
    // =========================================================================

    public setSampleRate(rate: number): void {
        this.inputSampleRate = rate;
        console.log(`[DeepgramStreaming] Input sample rate set to ${rate}`);
    }

    public setAudioChannelCount(count: number): void {
        this.numChannels = count;
        console.log(`[DeepgramStreaming] Channel count set to ${count}`);
    }

    /** Set recognition language using ISO-639-1 code */
    public setRecognitionLanguage(key: string): void {
        const config = RECOGNITION_LANGUAGES[key];
        if (config) {
            this.languageCode = config.iso639;
            console.log(`[DeepgramStreaming] Language set to ${this.languageCode}`);

            if (this.isActive) {
                console.log('[DeepgramStreaming] Language changed while active. Restarting...');
                this.stop();
                this.start();
            }
        }
    }

    /** No-op — no Google credentials needed */
    public setCredentials(_path: string): void { }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    public start(): void {
        if (this.isActive) return;
        this.isActive = true;
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.lastInboundActivityAt = Date.now();
        this.lastAudioActivityAt = 0;
        this.startConnectionGuard();
        this.connect();
    }

  public stop(): void {
    this.shouldReconnect = false;
    this.clearTimers();

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch {
      }
      this.ws.close();
      this.ws = null;
    }

    this.isActive = false;
    this.isConnecting = false;
    this.buffer.clear();
    this.lastInterimTranscript = '';
    this.lastInboundActivityAt = 0;
    this.lastAudioActivityAt = 0;
    this.stopConnectionGuard();
    console.log('[DeepgramStreaming] Stopped');
  }

    public destroy(): void {
        this.stop();
        this.removeAllListeners();
    }

    // =========================================================================
    // Audio Data
    // =========================================================================

  public write(chunk: Buffer): void {
    if (!this.isActive) return;

    const pcm16 = resampleToMonoPcm16(chunk, this.inputSampleRate, this.numChannels, this.targetSampleRate);
    if (pcm16.length > 0 && this.hasNonSilentAudio(pcm16)) {
      this.lastAudioActivityAt = Date.now();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.buffer.push(chunk); // Ring buffer handles capacity internally

      if (!this.isConnecting && this.shouldReconnect && !this.reconnectTimer) {
        console.log('[DeepgramStreaming] WS not ready. Lazy connecting on new audio...');
        this.connect();
      }
      return;
    }

    if (pcm16.length > 0) {
      this.ws.send(pcm16);
    }
  }

    // =========================================================================
    // WebSocket Connection
    // =========================================================================

    private connect(): void {
        if (!this.isActive || !this.shouldReconnect || this.isConnecting) {
            return;
        }

        if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
            return;
        }

        this.isConnecting = true;

        const url =
            `wss://api.deepgram.com/v1/listen` +
            `?model=nova-3` +
            `&encoding=linear16` +
            `&sample_rate=${this.targetSampleRate}` +
            `&channels=1` +
            `&language=${this.languageCode}` +
            `&smart_format=true` +
            `&interim_results=true` +
            `&endpointing=300` +
            `&utterance_end_ms=1000` +
            `&keepalive=true`;

        console.log(`[DeepgramStreaming] Connecting (input=${this.inputSampleRate}, target=${this.targetSampleRate}, ch=1)...`);

        const socket = new WebSocket(url, {
            headers: {
                Authorization: `Token ${this.apiKey}`,
            },
        });
        this.ws = socket;
        this.lastInboundActivityAt = Date.now();
        this.armConnectTimeout(socket);

  socket.on('open', () => {
    if (this.ws !== socket) {
      return;
    }

    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.clearConnectTimeout();
    this.lastInboundActivityAt = Date.now();
    console.log('[DeepgramStreaming] Connected');

    // Send buffered audio (ring buffer O(1) per chunk)
    while (this.buffer.length > 0) {
      const chunk = this.buffer.shift();
      if (chunk && this.ws?.readyState === WebSocket.OPEN) {
        const pcm16 = resampleToMonoPcm16(chunk, this.inputSampleRate, this.numChannels, this.targetSampleRate);
        if (pcm16.length > 0) {
          this.ws.send(pcm16);
        }
      }
    }

    // Start keep-alive pings
    this.startKeepAlive();
    this.startLivenessWatchdog(socket);
    try {
      this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
    } catch {
      // Ignore eager keep-alive errors
    }
  });

        socket.on('message', (data: WebSocket.Data) => {
            if (this.ws !== socket) {
                return;
            }

            try {
                this.lastInboundActivityAt = Date.now();
                const msg = JSON.parse(data.toString());

                // Deepgram response structure:
                // { type: "Results", channel: { alternatives: [{ transcript, confidence }] }, is_final }
                //
                // NAT-009 / audit A-10: Deepgram emits `UtteranceEnd` from a
                // VAD timer, not from a finalization decision. Synthesizing a
                // `final` here from `lastInterimTranscript` produced *fake*
                // finals -- text the user never finished saying -- which then
                // satisfied the `final===true` gate added in NAT-006 and
                // committed answers to half-utterances. We now strictly
                // require `is_final` from the Results message itself, and
                // only use `UtteranceEnd` for interim-state hygiene plus
                // telemetry parity tracking.
                if (msg.type === 'UtteranceEnd') {
                    this.emit('telemetry', {
                        kind: 'stt.utterance_end_seen',
                        hadPendingInterim: this.lastInterimTranscript.trim().length > 0,
                        pendingInterimLength: this.lastInterimTranscript.length,
                    });
                    this.lastInterimTranscript = '';
                    this.lastInterimConfidence = 0;
                    return;
                }

                if (msg.type !== 'Results') return;

                const transcript = msg.channel?.alternatives?.[0]?.transcript;
                if (!transcript) return;

                const confidence = msg.channel?.alternatives?.[0]?.confidence ?? 1.0;
                const isFinal = Boolean(msg.is_final || msg.speech_final);

                if (!isFinal) {
                    this.lastInterimTranscript = transcript;
                    this.lastInterimConfidence = confidence;
                } else {
                    this.lastInterimTranscript = '';
                }

                this.emit('transcript', {
                    text: transcript,
                    isFinal,
                    confidence,
                });
            } catch (err) {
                console.error('[DeepgramStreaming] Parse error:', err);
            }
        });

        socket.on('error', (err: Error) => {
            if (this.ws !== socket) {
                return;
            }

            console.error('[DeepgramStreaming] WebSocket error:', err.message);
            this.emit('error', err);
        });

        socket.on('close', (code: number, reason: Buffer) => {
            this.handleSocketClose(socket, code, reason);
        });
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    private scheduleReconnect(): void {
        if (!this.shouldReconnect || !this.isActive || this.reconnectTimer || this.isConnecting) return;

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
            RECONNECT_MAX_DELAY_MS
        );
        this.reconnectAttempts++;

        console.log(`[DeepgramStreaming] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                this.connect();
            }
        }, delay);
    }

    // =========================================================================
    // Keep-alive
    // =========================================================================

    private startKeepAlive(): void {
        this.clearKeepAlive();
        this.keepAliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                try {
                    // Send KeepAlive JSON instead of raw ping frame for Deepgram API idle prevention
                    this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
                } catch {
                    // Ignore errors
                }
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    private startConnectionGuard(): void {
        this.stopConnectionGuard();
        this.connectionGuardTimer = setInterval(() => {
            if (!this.isActive || !this.shouldReconnect || this.isConnecting || this.reconnectTimer) {
                return;
            }

            if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
                return;
            }

            console.warn('[DeepgramStreaming] Connection guard detected inactive socket. Reconnecting...');
            this.connect();
        }, CONNECTION_GUARD_INTERVAL_MS);
    }

    private stopConnectionGuard(): void {
        if (this.connectionGuardTimer) {
            clearInterval(this.connectionGuardTimer);
            this.connectionGuardTimer = null;
        }
    }

    private startLivenessWatchdog(socket: WebSocket): void {
        this.clearLivenessWatchdog();
        this.livenessTimer = setInterval(() => {
            if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) {
                return;
            }

            if (this.lastAudioActivityAt === 0) {
                return;
            }

            const now = Date.now();
            if (now - this.lastAudioActivityAt > INBOUND_STALL_TIMEOUT_MS) {
                return;
            }

            if (now - this.lastInboundActivityAt <= INBOUND_STALL_TIMEOUT_MS) {
                return;
            }

            console.warn('[DeepgramStreaming] No inbound activity while audio is flowing. Recycling socket...');
            this.abortSocket(socket, 1006, 'inbound-stall');
        }, LIVENESS_CHECK_INTERVAL_MS);
    }

    private clearKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    private clearLivenessWatchdog(): void {
        if (this.livenessTimer) {
            clearInterval(this.livenessTimer);
            this.livenessTimer = null;
        }
    }

    private armConnectTimeout(socket: WebSocket): void {
        this.clearConnectTimeout();
        this.connectTimeoutTimer = setTimeout(() => {
            if (this.ws !== socket || !this.isConnecting) {
                return;
            }

            console.warn('[DeepgramStreaming] Connection attempt timed out. Recycling socket...');
            this.abortSocket(socket, 1006, 'connect-timeout');
        }, CONNECT_TIMEOUT_MS);
    }

    private clearConnectTimeout(): void {
        if (this.connectTimeoutTimer) {
            clearTimeout(this.connectTimeoutTimer);
            this.connectTimeoutTimer = null;
        }
    }

    private abortSocket(socket: WebSocket, code: number, reason: string): void {
        if (this.ws !== socket) {
            return;
        }

        try {
            const terminable = socket as WebSocket & { terminate?: () => void };
            if (typeof terminable.terminate === 'function') {
                terminable.terminate();
            } else {
                socket.close();
            }
        } catch {
            // Ignore close/terminate errors during forced recycling
        }

        this.handleSocketClose(socket, code, Buffer.from(reason));
    }

    private handleSocketClose(socket: WebSocket, code: number, reason: Buffer): void {
        if (this.ws !== socket) {
            return;
        }

        this.ws = null;
        // Do not force isActive=false; let write() trigger reconnect if isActive is still true
        this.isConnecting = false;
        this.clearKeepAlive();
        this.clearLivenessWatchdog();
        this.clearConnectTimeout();
        console.log(`[DeepgramStreaming] Closed (code=${code}, reason=${reason.toString()})`);

        // Auto-reconnect on any close while active.
        // Intentional shutdown sets shouldReconnect=false in stop().
        if (this.shouldReconnect) {
            this.scheduleReconnect();
        }
    }

    private static readonly SILENCE_RMS_THRESHOLD = 50;

    private hasNonSilentAudio(chunk: Buffer): boolean {
        let sum = 0;
        let count = 0;
        const step = 20;
        for (let i = 0; i + 1 < chunk.length; i += 2 * step) {
            const sample = chunk.readInt16LE(i);
            sum += sample * sample;
            count++;
        }
        if (count === 0) return false;
        return Math.sqrt(sum / count) >= DeepgramStreamingSTT.SILENCE_RMS_THRESHOLD;
    }

    private clearTimers(): void {
        this.clearKeepAlive();
        this.clearLivenessWatchdog();
        this.clearConnectTimeout();
        this.stopConnectionGuard();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
