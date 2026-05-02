import { SpeechClient } from "@google-cloud/speech";
import { EventEmitter } from "events";
import * as path from "path";
import {
	type EnglishVariant,
	RECOGNITION_LANGUAGES,
} from "../config/languages";
import { DropFrameMetric } from "./dropMetrics";

/**
 * GoogleSTT
 *
 * Manages a bi-directional streaming connection to Google Speech-to-Text.
 * Mirrors the logic previously in Swift:
 * - Handles infinite stream limits by restarting periodically (though less critical for short calls).
 * - Manages authentication via GOOGLE_APPLICATION_CREDENTIALS.
 * - Parses intermediate and final results.
 */
export class GoogleSTT extends EventEmitter {
	private static readonly PROACTIVE_RESTART_MS = 270_000;
	private client: SpeechClient;
	private stream: any = null; // Stream type is complex in google-cloud libs
	private isStreaming = false;
	private isActive = false;

	// Config
	private encoding = "LINEAR16" as const;
	private sampleRateHertz = 16000;
	private audioChannelCount = 1; // Default to Mono
	private languageCode = "en-US";
	private alternativeLanguageCodes: string[] = ["en-IN", "en-GB"]; // Default fallbacks

	constructor() {
		super();
		// ... (credentials setup) ...

		// Note: In production, credentials are set by main.ts via process.env.GOOGLE_APPLICATION_CREDENTIALS
		// or passed explicitly to setCredentials(). We do not load .env files here to avoid ASAR path issues.
		const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
		if (!credentialsPath) {
			console.error(
				"[GoogleSTT] Missing GOOGLE_APPLICATION_CREDENTIALS in environment. Checked CWD:",
				process.cwd(),
			);
		} else {
			console.log(`[GoogleSTT] Using credentials from: ${credentialsPath}`);
		}

		this.client = new SpeechClient({
			keyFilename: credentialsPath,
		});
	}

	public setCredentials(keyFilePath: string): void {
		console.log(`[GoogleSTT] Updating credentials to: ${keyFilePath}`);
		process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFilePath;
		this.client = new SpeechClient({
			keyFilename: keyFilePath,
		});
	}

	public setSampleRate(rate: number): void {
		if (this.sampleRateHertz === rate) return;
		console.log(`[GoogleSTT] Updating Sample Rate to: ${rate}Hz`);
		this.sampleRateHertz = rate;
		if (this.isStreaming || this.isActive) {
			console.warn(
				"[GoogleSTT] Config changed while active. Restarting stream...",
			);
			this.stop();
			this.start();
		}
	}

	/**
	 * No-op for GoogleSTT — Google handles VAD server-side.
	 * This method exists for interface consistency with RestSTT so that
	 * main.ts can call notifySpeechEnded() without type-casting to `any`.
	 */
	public notifySpeechEnded(): void {
		// Intentionally empty. Google STT detects speech boundaries server-side.
	}

	public setAudioChannelCount(count: number): void {
		if (this.audioChannelCount === count) return;
		console.log(`[GoogleSTT] Updating Channel Count to: ${count}`);
		this.audioChannelCount = count;
		if (this.isStreaming || this.isActive) {
			console.warn(
				"[GoogleSTT] Config changed while active. Restarting stream...",
			);
			this.stop();
			this.start();
		}
	}

	private pendingLanguageChange?: NodeJS.Timeout;

	public setRecognitionLanguage(key: string): void {
		// Debounce to prevent rapid restarts (e.g. scrolling through list)
		if (this.pendingLanguageChange) {
			clearTimeout(this.pendingLanguageChange);
		}

		this.pendingLanguageChange = setTimeout(() => {
			const config = RECOGNITION_LANGUAGES[key];
			if (!config) {
				console.warn(`[GoogleSTT] Unknown language key: ${key}`);
				return;
			}

			console.log(
				`[GoogleSTT] Updating recognition language to: ${key} (${config.bcp47})`,
			);

			// Update state
			this.languageCode = config.bcp47;

			// Handle variants (English specifically)
			if ("alternates" in config) {
				this.alternativeLanguageCodes = (config as EnglishVariant).alternates;
			} else {
				this.alternativeLanguageCodes = [];
			}

			console.log("[GoogleSTT] Primary:", this.languageCode);
			if (this.alternativeLanguageCodes.length > 0) {
				console.log(
					"[GoogleSTT] Alternates:",
					this.alternativeLanguageCodes.join(", "),
				);
			}

			// Restart if active
			if (this.isStreaming || this.isActive) {
				console.log(
					"[GoogleSTT] Language changed while active. Restarting stream...",
				);
				this.stop();
				this.start();
			}

			this.pendingLanguageChange = undefined;
		}, 250);
	}

	public start(): void {
		if (this.isActive) return;
		this.isActive = true;
		this.dropMetric.start(); // NAT-021

		console.log("[GoogleSTT] Starting recognition stream...");
		this.startStream();
	}

	public stop(): void {
		if (!this.isActive) return;

		console.log("[GoogleSTT] Stopping stream...");
		this.isActive = false;
		this.isStreaming = false;
		this.clearProactiveRestartTimer();
		if (this.stream) {
			this.stream.end();
			this.stream.destroy();
			this.stream = null;
		}
		this.dropMetric.stop(); // NAT-021
	}

	public destroy(): void {
		this.stop();
		this.removeAllListeners();
	}

	private buffer: Buffer[] = [];
	// NAT-021: count overflow drops so silent audio loss is observable.
	private dropMetric = new DropFrameMetric({ provider: "google" });
	private isConnecting = false;
	private lastConnectAttempt = 0;
	private proactiveRestartTimer: NodeJS.Timeout | null = null;

	public write(audioData: Buffer): void {
		if (!this.isActive) return;

		if (!this.isStreaming || !this.stream) {
			// Buffer if we are in connecting state, just started, or closed
			this.buffer.push(audioData);
			if (this.buffer.length > 500) {
				this.buffer.shift(); // Cap buffer size
				this.dropMetric.recordDrop(); // NAT-021
			}

			if (!this.isConnecting) {
				if (Date.now() - this.lastConnectAttempt > 1000) {
					console.log(
						`[GoogleSTT] Stream not ready. Lazy connecting on new audio...`,
					);
					this.startStream();
				}
			}
			return;
		}

		// Safety check to prevent "write after destroyed" error
		if (this.stream.destroyed) {
			this.isStreaming = false;
			this.stream = null;
			this.buffer.push(audioData);
			if (this.buffer.length > 500) {
				this.buffer.shift(); // Cap buffer size
				this.dropMetric.recordDrop(); // NAT-021
			}

			if (!this.isConnecting) {
				if (Date.now() - this.lastConnectAttempt > 1000) {
					console.log(`[GoogleSTT] Stream destroyed. Lazy reconnecting...`);
					this.startStream();
				}
			}
			return;
		}

		try {
			// Debug log every ~50th write to avoid spam
			if (Math.random() < 0.02) {
				console.log(`[GoogleSTT] Writing ${audioData.length} bytes to stream`);
			}

			if (this.stream.command && this.stream.command.writable) {
				this.stream.write(audioData);
			} else if (this.stream.writable) {
				this.stream.write(audioData);
			} else {
				console.warn("[GoogleSTT] Stream not writable!");
			}
		} catch (err) {
			console.error("[GoogleSTT] Safe write failed:", err);
			this.isStreaming = false;
		}
	}

	private flushBuffer(): void {
		if (!this.stream) return;

		while (this.buffer.length > 0) {
			const data = this.buffer.shift();
			if (data) {
				try {
					this.stream.write(data);
				} catch (e) {
					console.error("[GoogleSTT] Failed to flush buffer chunk:", e);
				}
			}
		}
	}

	private clearProactiveRestartTimer(): void {
		if (this.proactiveRestartTimer) {
			clearTimeout(this.proactiveRestartTimer);
			this.proactiveRestartTimer = null;
		}
	}

	private scheduleProactiveRestart(streamRef: any): void {
		this.clearProactiveRestartTimer();
		if (!this.isActive) return;

		this.proactiveRestartTimer = setTimeout(() => {
			if (!this.isActive || this.stream !== streamRef) {
				return;
			}

			console.log(
				"[GoogleSTT] Proactively rotating stream before Google streaming limit",
			);
			this.restartStream();
		}, GoogleSTT.PROACTIVE_RESTART_MS);
	}

	private restartStream(): void {
		const previousStream = this.stream;
		this.clearProactiveRestartTimer();
		this.isStreaming = false;
		this.isConnecting = false;
		this.stream = null;

		if (previousStream) {
			try {
				previousStream.end();
				previousStream.destroy();
			} catch (error) {
				console.warn(
					"[GoogleSTT] Failed to tear down proactive rollover stream:",
					error,
				);
			}
		}

		if (this.isActive) {
			this.startStream();
		}
	}

	private startStream(): void {
		this.lastConnectAttempt = Date.now();
		this.isStreaming = true;
		this.isConnecting = true;

		const activeStream = this.client
			.streamingRecognize({
				config: {
					encoding: this.encoding,
					sampleRateHertz: this.sampleRateHertz,
					audioChannelCount: this.audioChannelCount,
					languageCode: this.languageCode,
					enableAutomaticPunctuation: true,
					model: "latest_long",
					useEnhanced: true,
					alternativeLanguageCodes: this.alternativeLanguageCodes,
				},
				interimResults: true,
			})
			.on("error", (err: Error) => {
				if (this.stream !== activeStream) return;
				console.error("[GoogleSTT] Stream error:", err);
				this.emit("error", err);
				this.isConnecting = false;
				this.isStreaming = false;
				this.stream = null;
				this.clearProactiveRestartTimer();
			})
			.on("end", () => {
				if (this.stream !== activeStream) return;
				console.log("[GoogleSTT] Stream ended server-side (idle timeout)");
				this.isConnecting = false;
				this.isStreaming = false;
				this.stream = null;
				this.clearProactiveRestartTimer();
			})
			.on("close", () => {
				if (this.stream !== activeStream) return;
				console.log("[GoogleSTT] Stream closed server-side");
				this.isConnecting = false;
				this.isStreaming = false;
				this.stream = null;
				this.clearProactiveRestartTimer();
			})
			.on("data", (data: any) => {
				if (this.stream !== activeStream) return;
				// ... (existing data handler)
				if (data.results[0] && data.results[0].alternatives[0]) {
					const result = data.results[0];
					const alt = result.alternatives[0];
					const transcript = alt.transcript;
					const isFinal = result.isFinal;

					if (transcript) {
						this.emit("transcript", {
							text: transcript,
							isFinal,
							confidence: alt.confidence,
						});
					}
				}
			});

		this.stream = activeStream;

		// Initialize writeable check or wait for 'open'?
		// gRPC streams are usually writeable immediately.
		// We can flush immediately after creation.
		this.isConnecting = false;
		this.flushBuffer();
		this.scheduleProactiveRestart(activeStream);

		console.log("[GoogleSTT] Stream created. Waiting for events...");
	}
}
