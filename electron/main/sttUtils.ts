import type { EventEmitter } from "node:events";
import type { DeepgramStreamingSTT } from "../audio/DeepgramStreamingSTT";
import type { ElevenLabsStreamingSTT } from "../audio/ElevenLabsStreamingSTT";
import type { GoogleSTT } from "../audio/GoogleSTT";
import type { OpenAIStreamingSTT } from "../audio/OpenAIStreamingSTT";
import type { RestSTT } from "../audio/RestSTT";
import type { SonioxStreamingSTT } from "../audio/SonioxStreamingSTT";

/** Unified type for all STT providers with optional extended capabilities */
export type STTProvider = (
	| GoogleSTT
	| RestSTT
	| DeepgramStreamingSTT
	| SonioxStreamingSTT
	| ElevenLabsStreamingSTT
	| OpenAIStreamingSTT
) & {
	start: () => void;
	stop: () => void;
	on: EventEmitter["on"];
	removeAllListeners: EventEmitter["removeAllListeners"];
	finalize?: () => void;
	setAudioChannelCount?: (count: number) => void;
	notifySpeechEnded?: () => void;
	destroy?: () => void;
};

/** Type guard functions for STT provider optional methods */
export function hasFinalize(
	stt: STTProvider,
): stt is STTProvider & { finalize: () => void } {
	return "finalize" in stt && typeof stt.finalize === "function";
}

export function hasSetAudioChannelCount(
	stt: STTProvider,
): stt is STTProvider & { setAudioChannelCount: (count: number) => void } {
	return (
		"setAudioChannelCount" in stt &&
		typeof stt.setAudioChannelCount === "function"
	);
}

export function hasNotifySpeechEnded(
	stt: STTProvider,
): stt is STTProvider & { notifySpeechEnded: () => void } {
	return (
		"notifySpeechEnded" in stt && typeof stt.notifySpeechEnded === "function"
	);
}

export function hasDestroy(
	stt: STTProvider,
): stt is STTProvider & { destroy: () => void } {
	return "destroy" in stt && typeof stt.destroy === "function";
}

/** Safe wrapper functions for STT provider optional methods */
export function safeFinalize(stt: STTProvider | null): void {
	if (stt && hasFinalize(stt)) {
		try {
			stt.finalize();
		} catch (error) {
			console.error("[Main] Error calling finalize on STT provider:", error);
		}
	}
}

export function safeSetAudioChannelCount(
	stt: STTProvider | null,
	count: number,
): void {
	if (stt && hasSetAudioChannelCount(stt)) {
		try {
			stt.setAudioChannelCount(count);
		} catch (error) {
			console.error(
				"[Main] Error calling setAudioChannelCount on STT provider:",
				error,
			);
		}
	}
}

export function safeNotifySpeechEnded(stt: STTProvider | null): void {
	if (stt && hasNotifySpeechEnded(stt)) {
		try {
			stt.notifySpeechEnded();
		} catch (error) {
			console.error(
				"[Main] Error calling notifySpeechEnded on STT provider:",
				error,
			);
		}
	}
}

export function computePcm16Rms(chunk: Buffer): number {
	if (chunk.length < 2) {
		return 0;
	}

	let sumSquares = 0;
	let sampleCount = 0;
	for (let offset = 0; offset + 1 < chunk.length; offset += 8) {
		const sample = chunk.readInt16LE(offset);
		sumSquares += sample * sample;
		sampleCount += 1;
	}

	if (sampleCount === 0) {
		return 0;
	}

	return Math.sqrt(sumSquares / sampleCount);
}

export function safeDestroy(stt: STTProvider | null): void {
	if (stt && hasDestroy(stt)) {
		try {
			stt.destroy();
		} catch (error) {
			console.error("[Main] Error calling destroy on STT provider:", error);
		}
	}
}
