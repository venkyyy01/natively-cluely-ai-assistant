import type { SupervisorBus } from "./SupervisorBus";
import type { ISupervisor, SupervisorState } from "./types";
import type { WarmStandbyManager } from "./WarmStandbyManager";

export interface AudioSupervisorDelegates {
	startCapture: () => Promise<void> | void;
	startCaptureFromWarmStandby?: (resource: unknown) => Promise<void> | void;
	stopCapture: () => Promise<void> | void;
	onStealthFault?: (reason: string) => Promise<void> | void;
	startAudioTest?: (deviceId?: string) => Promise<void> | void;
	stopAudioTest?: () => Promise<void> | void;
	onChunk?: (chunk: Buffer) => Promise<void> | void;
	onSpeechEnded?: () => Promise<void> | void;
	onError?: (error: Error) => Promise<void> | void;
}

interface AudioSupervisorOptions {
	bus: SupervisorBus;
	delegates: AudioSupervisorDelegates;
	logger?: Pick<Console, "warn">;
	warmStandby?: Pick<
		WarmStandbyManager<unknown, unknown, unknown>,
		"getAudioResource" | "isAudioResourceHealthy" | "invalidateAudioResource"
	>;
}

export class AudioSupervisor implements ISupervisor {
	public readonly name = "audio" as const;

	private state: SupervisorState = "idle";
	private readonly bus: SupervisorBus;
	private readonly delegates: AudioSupervisorDelegates;
	private readonly logger: Pick<Console, "warn">;
	private readonly warmStandby?: Pick<
		WarmStandbyManager<unknown, unknown, unknown>,
		"getAudioResource" | "isAudioResourceHealthy" | "invalidateAudioResource"
	>;

	constructor(options: AudioSupervisorOptions) {
		this.bus = options.bus;
		this.delegates = options.delegates;
		this.logger = options.logger ?? console;
		this.warmStandby = options.warmStandby;
		this.bus.subscribe("stealth:fault", async (event) => {
			await this.handleStealthFault(event.reason);
		});
	}

	getState(): SupervisorState {
		return this.state;
	}

	async start(): Promise<void> {
		if (this.state === "running" || this.state === "starting") {
			return;
		}

		this.state = "starting";
		try {
			await this.startCaptureWithWarmStandbyFallback();
			this.state = "running";
			await this.bus.emit({ type: "audio:capture-started" });
		} catch (error) {
			this.state = "faulted";
			await this.reportError(error);
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.state === "idle") {
			return;
		}

		this.state = "stopping";
		try {
			await this.delegates.stopCapture();
		} finally {
			this.state = "idle";
			await this.bus.emit({ type: "audio:capture-stopped" });
		}
	}

	async handleChunk(chunk: Buffer): Promise<void> {
		if (this.state !== "running") {
			return;
		}

		await this.delegates.onChunk?.(chunk);
	}

	async handleSpeechEnded(): Promise<void> {
		if (this.state !== "running") {
			return;
		}

		await this.delegates.onSpeechEnded?.();
	}

	async reportGap(durationMs: number): Promise<void> {
		if (durationMs <= 0) {
			return;
		}

		await this.bus.emit({ type: "audio:gap-detected", durationMs });
	}

	async reportError(error: unknown): Promise<void> {
		const normalizedError =
			error instanceof Error ? error : new Error(String(error));
		this.logger.warn("[AudioSupervisor] capture error:", normalizedError);
		await this.delegates.onError?.(normalizedError);
	}

	async startAudioTest(deviceId?: string): Promise<void> {
		await this.delegates.startAudioTest?.(deviceId);
	}

	async stopAudioTest(): Promise<void> {
		await this.delegates.stopAudioTest?.();
	}

	private async startCaptureWithWarmStandbyFallback(): Promise<void> {
		const warmResource = this.warmStandby?.getAudioResource();
		const canUseWarmStandby =
			warmResource !== null &&
			warmResource !== undefined &&
			this.delegates.startCaptureFromWarmStandby;
		if (!canUseWarmStandby) {
			await this.delegates.startCapture();
			return;
		}

		const healthy = await this.warmStandby?.isAudioResourceHealthy();
		if (!healthy) {
			await this.warmStandby?.invalidateAudioResource();
			await this.delegates.startCapture();
			return;
		}

		try {
			await this.delegates.startCaptureFromWarmStandby?.(warmResource);
		} catch (error) {
			await this.warmStandby?.invalidateAudioResource();
			this.logger.warn(
				"[AudioSupervisor] Warm capture activation failed, falling back to cold start:",
				error,
			);
			await this.delegates.startCapture();
		}
	}

	private async handleStealthFault(reason: string): Promise<void> {
		if (this.state !== "running") {
			return;
		}

		await this.delegates.onStealthFault?.(reason);
	}
}
