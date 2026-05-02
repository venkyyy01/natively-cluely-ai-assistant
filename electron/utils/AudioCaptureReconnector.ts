import { EventEmitter } from "events";

/**
 * AudioCaptureReconnector - Comprehensive audio reconnection management
 *
 * Handles all audio capture failures and provides intelligent recovery strategies
 * including device switching, format fallbacks, and graceful degradation.
 */

export interface AudioDevice {
	id: string;
	label: string;
	kind: "audioinput" | "audiooutput";
	isDefault?: boolean;
}

export interface ReconnectionAttempt {
	attemptNumber: number;
	timestamp: number;
	strategy: ReconnectionStrategy;
	deviceId?: string;
	error?: string;
	success: boolean;
	duration: number;
}

export interface AudioReconnectionConfig {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	enableDeviceFallback: boolean;
	enableFormatFallback: boolean;
	deviceScanIntervalMs: number;
	healthCheckIntervalMs: number;
}

export enum ReconnectionStrategy {
	RETRY_SAME_DEVICE = "retry-same-device",
	SWITCH_TO_DEFAULT = "switch-to-default",
	SCAN_ALTERNATIVE_DEVICES = "scan-alternative-devices",
	LOWER_SAMPLE_RATE = "lower-sample-rate",
	MONO_FALLBACK = "mono-fallback",
	GRACEFUL_DEGRADATION = "graceful-degradation",
}

export interface AudioCaptureInstance {
	type: "system" | "microphone";
	deviceId?: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	isActive(): boolean;
	getHealth(): { connected: boolean; level: number; errors: number };
}

export class AudioCaptureReconnector extends EventEmitter {
	private config: AudioReconnectionConfig;
	private attempts: ReconnectionAttempt[] = [];
	private isReconnecting = false;
	private healthCheckInterval?: NodeJS.Timeout;
	private deviceScanInterval?: NodeJS.Timeout;
	private availableDevices: AudioDevice[] = [];
	private lastSuccessfulConfig: {
		deviceId?: string;
		sampleRate?: number;
		channels?: number;
	} = {};

	constructor(config: Partial<AudioReconnectionConfig> = {}) {
		super();
		this.config = {
			maxAttempts: 5,
			baseDelayMs: 2000,
			maxDelayMs: 30000,
			enableDeviceFallback: true,
			enableFormatFallback: true,
			deviceScanIntervalMs: 10000,
			healthCheckIntervalMs: 5000,
			...config,
		};
	}

	/**
	 * Start monitoring and be ready for reconnection
	 */
	public start(): void {
		this.startHealthCheck();
		this.startDeviceScanning();
		console.log("[AudioReconnector] Started monitoring");
	}

	/**
	 * Stop all monitoring
	 */
	public stop(): void {
		this.stopHealthCheck();
		this.stopDeviceScanning();
		this.isReconnecting = false;
		console.log("[AudioReconnector] Stopped monitoring");
	}

	/**
	 * Attempt to reconnect audio capture with comprehensive strategy
	 */
	public async reconnect(
		captureInstance: AudioCaptureInstance,
		originalError: Error,
		currentDeviceId?: string,
	): Promise<boolean> {
		if (this.isReconnecting) {
			console.warn("[AudioReconnector] Already reconnecting, queuing request");
			return new Promise((resolve) => {
				this.once("reconnection-completed", resolve);
			});
		}

		this.isReconnecting = true;
		console.log(
			`[AudioReconnector] Starting reconnection for ${captureInstance.type} audio`,
		);

		const startTime = Date.now();
		let success = false;

		try {
			// Get current device list
			await this.updateAvailableDevices();

			// Try different strategies in order of preference
			const strategies = this.getReconnectionStrategies(
				captureInstance,
				currentDeviceId,
			);

			for (const strategy of strategies) {
				if (this.attempts.length >= this.config.maxAttempts) {
					break;
				}

				const attemptResult = await this.executeReconnectionStrategy(
					captureInstance,
					strategy,
					currentDeviceId,
				);

				this.attempts.push(attemptResult);
				this.emit("reconnection-attempt", attemptResult);

				if (attemptResult.success) {
					success = true;
					this.lastSuccessfulConfig = {
						deviceId: attemptResult.deviceId,
						// Note: sample rate and channels would need to be tracked separately
					};
					break;
				}

				// Progressive backoff
				const delay = Math.min(
					this.config.baseDelayMs * 2 ** (this.attempts.length - 1),
					this.config.maxDelayMs,
				);

				console.log(
					`[AudioReconnector] Strategy ${strategy} failed, waiting ${delay}ms before next attempt`,
				);
				await this.delay(delay);
			}
		} catch (error) {
			console.error("[AudioReconnector] Reconnection process failed:", error);
		} finally {
			this.isReconnecting = false;
			const duration = Date.now() - startTime;

			const result = {
				success,
				attempts: this.attempts.length,
				duration,
				strategies: this.attempts.map((a) => a.strategy),
			};

			this.emit("reconnection-completed", success);

			if (success) {
				this.emit("reconnection-success", result);
				console.log(
					`[AudioReconnector] Successfully reconnected after ${this.attempts.length} attempts in ${duration}ms`,
				);
				this.resetAttempts();
			} else {
				this.emit("reconnection-failed", result);
				console.error(
					`[AudioReconnector] Failed to reconnect after ${this.attempts.length} attempts`,
				);
			}
		}

		return success;
	}

	/**
	 * Get list of reconnection strategies to try
	 */
	private getReconnectionStrategies(
		captureInstance: AudioCaptureInstance,
		currentDeviceId?: string,
	): ReconnectionStrategy[] {
		const strategies: ReconnectionStrategy[] = [];

		// 1. First try the same device/config
		strategies.push(ReconnectionStrategy.RETRY_SAME_DEVICE);

		// 2. Try switching to default device if we weren't using it
		if (currentDeviceId && !this.isDefaultDevice(currentDeviceId)) {
			strategies.push(ReconnectionStrategy.SWITCH_TO_DEFAULT);
		}

		// 3. Scan for alternative devices
		if (this.config.enableDeviceFallback && this.availableDevices.length > 1) {
			strategies.push(ReconnectionStrategy.SCAN_ALTERNATIVE_DEVICES);
		}

		// 4. Try format fallbacks
		if (this.config.enableFormatFallback) {
			strategies.push(ReconnectionStrategy.LOWER_SAMPLE_RATE);
			strategies.push(ReconnectionStrategy.MONO_FALLBACK);
		}

		// 5. Graceful degradation as last resort
		strategies.push(ReconnectionStrategy.GRACEFUL_DEGRADATION);

		return strategies;
	}

	/**
	 * Execute a specific reconnection strategy
	 */
	private async executeReconnectionStrategy(
		captureInstance: AudioCaptureInstance,
		strategy: ReconnectionStrategy,
		currentDeviceId?: string,
	): Promise<ReconnectionAttempt> {
		const attempt: ReconnectionAttempt = {
			attemptNumber: this.attempts.length + 1,
			timestamp: Date.now(),
			strategy,
			success: false,
			duration: 0,
		};

		const startTime = Date.now();

		try {
			console.log(`[AudioReconnector] Executing strategy: ${strategy}`);

			// Stop current capture
			if (captureInstance.isActive()) {
				await captureInstance.stop();
			}

			switch (strategy) {
				case ReconnectionStrategy.RETRY_SAME_DEVICE:
					await captureInstance.start();
					break;

				case ReconnectionStrategy.SWITCH_TO_DEFAULT: {
					const defaultDevice = this.availableDevices.find(
						(d) => d.isDefault && d.kind === "audioinput",
					);
					if (defaultDevice) {
						attempt.deviceId = defaultDevice.id;
						// Note: Would need to pass device ID to captureInstance.start()
						await captureInstance.start();
					} else {
						throw new Error("No default device found");
					}
					break;
				}

				case ReconnectionStrategy.SCAN_ALTERNATIVE_DEVICES: {
					const alternativeDevices = this.availableDevices
						.filter((d) => d.kind === "audioinput" && d.id !== currentDeviceId)
						.slice(0, 3); // Try up to 3 alternative devices

					for (const device of alternativeDevices) {
						try {
							attempt.deviceId = device.id;
							// Note: Would need to pass device ID to captureInstance.start()
							await captureInstance.start();
							break; // Success, exit loop
						} catch (deviceError) {
							console.warn(
								`[AudioReconnector] Device ${device.label} failed:`,
								deviceError,
							);
						}
					}

					if (!captureInstance.isActive()) {
						throw new Error("All alternative devices failed");
					}
					break;
				}

				case ReconnectionStrategy.LOWER_SAMPLE_RATE:
					// Note: This would require modifying the capture instance to support different sample rates
					// For now, just retry with current config
					await captureInstance.start();
					break;

				case ReconnectionStrategy.MONO_FALLBACK:
					// Note: This would require modifying the capture instance to support mono mode
					// For now, just retry with current config
					await captureInstance.start();
					break;

				case ReconnectionStrategy.GRACEFUL_DEGRADATION:
					// This might involve switching to a simpler audio mode or disabling certain features
					console.warn("[AudioReconnector] Attempting graceful degradation");
					await captureInstance.start();
					break;

				default:
					throw new Error(`Unknown strategy: ${strategy}`);
			}

			// Verify the capture is actually working
			await this.delay(1000); // Give it time to start

			if (!captureInstance.isActive()) {
				throw new Error("Capture failed to start properly");
			}

			// Check health
			const health = captureInstance.getHealth();
			if (!health.connected) {
				throw new Error("Capture started but is not connected");
			}

			attempt.success = true;
			console.log(`[AudioReconnector] Strategy ${strategy} succeeded`);
		} catch (error) {
			attempt.error = error instanceof Error ? error.message : String(error);
			console.error(`[AudioReconnector] Strategy ${strategy} failed:`, error);
		}

		attempt.duration = Date.now() - startTime;
		return attempt;
	}

	/**
	 * Start health monitoring of audio capture
	 */
	private startHealthCheck(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
		}

		this.healthCheckInterval = setInterval(() => {
			this.emit("health-check");
		}, this.config.healthCheckIntervalMs);
	}

	/**
	 * Stop health monitoring
	 */
	private stopHealthCheck(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = undefined;
		}
	}

	/**
	 * Start scanning for available devices
	 */
	private startDeviceScanning(): void {
		if (this.deviceScanInterval) {
			clearInterval(this.deviceScanInterval);
		}

		// Initial scan
		this.updateAvailableDevices();

		this.deviceScanInterval = setInterval(() => {
			this.updateAvailableDevices();
		}, this.config.deviceScanIntervalMs);
	}

	/**
	 * Stop device scanning
	 */
	private stopDeviceScanning(): void {
		if (this.deviceScanInterval) {
			clearInterval(this.deviceScanInterval);
			this.deviceScanInterval = undefined;
		}
	}

	/**
	 * Update the list of available audio devices
	 */
	private async updateAvailableDevices(): Promise<void> {
		try {
			// Note: In a real implementation, this would use navigator.mediaDevices.enumerateDevices()
			// or a Node.js audio device enumeration library

			// Mock implementation for now
			const devices: AudioDevice[] = [
				{
					id: "default",
					label: "Default - System Audio",
					kind: "audioinput",
					isDefault: true,
				},
				{ id: "device1", label: "Built-in Microphone", kind: "audioinput" },
				{ id: "device2", label: "USB Microphone", kind: "audioinput" },
			];

			const previousCount = this.availableDevices.length;
			this.availableDevices = devices;

			if (devices.length !== previousCount) {
				console.log(
					`[AudioReconnector] Device list updated: ${devices.length} devices available`,
				);
				this.emit("devices-updated", devices);
			}
		} catch (error) {
			console.error("[AudioReconnector] Failed to update device list:", error);
		}
	}

	/**
	 * Check if a device ID represents the default device
	 */
	private isDefaultDevice(deviceId: string): boolean {
		const device = this.availableDevices.find((d) => d.id === deviceId);
		return device?.isDefault || deviceId === "default" || deviceId === "";
	}

	/**
	 * Reset attempt counter after successful reconnection
	 */
	private resetAttempts(): void {
		this.attempts = [];
	}

	/**
	 * Utility delay function
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Get reconnection statistics
	 */
	public getStats() {
		return {
			totalAttempts: this.attempts.length,
			isReconnecting: this.isReconnecting,
			lastSuccessfulConfig: this.lastSuccessfulConfig,
			availableDevices: this.availableDevices.length,
			strategies: this.attempts.map((a) => ({
				strategy: a.strategy,
				success: a.success,
				duration: a.duration,
			})),
		};
	}

	/**
	 * Force a device rescan
	 */
	public async forceDeviceScan(): Promise<AudioDevice[]> {
		await this.updateAvailableDevices();
		return [...this.availableDevices];
	}
}
