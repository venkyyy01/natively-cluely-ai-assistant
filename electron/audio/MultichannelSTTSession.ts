import { EventEmitter } from "events";

/**
 * NAT-062 — Multichannel STT session abstraction.
 *
 * For diarization-capable providers (Deepgram Nova-3, Soniox), a single
 * WebSocket connection can carry multiple audio channels instead of
 * opening two independent sessions. This reduces cross-talk and improves
 * speaker labelling accuracy.
 *
 * Consumers write interleaved stereo frames (L = interviewer, R = user)
 * or provider-specific multichannel packets.
 */

export interface MultichannelSTTOptions {
	sampleRate: number;
	channels: number;
	channelLabels: string[];
	/** Provider-specific query params appended to WS URL. */
	providerParams?: Record<string, string>;
}

export interface DiarizedTranscript {
	text: string;
	isFinal: boolean;
	confidence: number;
	/** Channel index or label that produced this transcript. */
	channel: number | string;
	speaker?: string;
}

/**
 * Abstract base for a multichannel STT session.
 * Implementations provider-specific (Deepgram, Soniox, etc.).
 */
export abstract class MultichannelSTTSession extends EventEmitter {
	protected connected = false;

	constructor(protected readonly options: MultichannelSTTOptions) {
		super();
	}

	abstract start(): Promise<void>;
	abstract stop(): Promise<void>;

	/**
	 * Write a frame of interleaved PCM16 data.
	 * Frame length must be a multiple of `channels * 2` bytes.
	 */
	abstract writeInterleavedFrame(frame: Buffer): void;

	isConnected(): boolean {
		return this.connected;
	}
}

/** Deepgram-specific multichannel session. */
export class DeepgramMultichannelSession extends MultichannelSTTSession {
	private ws: WebSocket | null = null;

	async start(): Promise<void> {
		// Placeholder: real implementation would open a single WS with
		// channels=2, diarize=true, multichannel=true
		this.connected = true;
		this.emit("connected");
	}

	async stop(): Promise<void> {
		this.connected = false;
		this.ws = null;
		this.emit("disconnected");
	}

	writeInterleavedFrame(_frame: Buffer): void {
		if (!this.connected) return;
		// Placeholder: send over WS
	}
}

/** Soniox-specific multichannel session. */
export class SonioxMultichannelSession extends MultichannelSTTSession {
	async start(): Promise<void> {
		this.connected = true;
		this.emit("connected");
	}

	async stop(): Promise<void> {
		this.connected = false;
		this.emit("disconnected");
	}

	writeInterleavedFrame(_frame: Buffer): void {
		if (!this.connected) return;
	}
}

/** Capabilities registry. */
export function supportsMultichannelDiarization(provider: string): boolean {
	return provider === "deepgram" || provider === "soniox";
}

/** Factory. */
export function createMultichannelSession(
	provider: string,
	options: MultichannelSTTOptions,
): MultichannelSTTSession {
	if (provider === "deepgram") return new DeepgramMultichannelSession(options);
	if (provider === "soniox") return new SonioxMultichannelSession(options);
	throw new Error(
		`Provider ${provider} does not support multichannel diarization`,
	);
}
