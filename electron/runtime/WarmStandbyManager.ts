import { SupervisorBus } from "./SupervisorBus";

export type WarmStandbyState =
	| "idle"
	| "warming"
	| "ready"
	| "bound"
	| "cooling"
	| "faulted";

export interface WarmStandbyResourceHandler<TResource> {
	warmUp: () => Promise<TResource> | TResource;
	coolDown?: (resource: TResource) => Promise<void> | void;
	checkHealth?: (resource: TResource) => Promise<boolean> | boolean;
}

export interface WarmStandbyHealth {
	state: WarmStandbyState;
	ready: boolean;
	activeMeetingId: string | null;
	deferredBackgroundWarmup: boolean;
	audio: {
		ready: boolean;
		healthy: boolean;
	};
	stt: {
		ready: boolean;
		healthy: boolean;
	};
	workerPool: {
		ready: boolean;
		healthy: boolean;
	};
	lastError: string | null;
}

interface WarmStandbyManagerOptions<
	TAudioResource,
	TSttResource,
	TWorkerPoolResource,
> {
	bus?: SupervisorBus;
	logger?: Pick<Console, "warn">;
	audio?: WarmStandbyResourceHandler<TAudioResource>;
	stt?: WarmStandbyResourceHandler<TSttResource>;
	workerPool?: WarmStandbyResourceHandler<TWorkerPoolResource>;
}

export class WarmStandbyManager<
	TAudioResource = unknown,
	TSttResource = unknown,
	TWorkerPoolResource = unknown,
> {
	private readonly bus: SupervisorBus;
	private readonly logger: Pick<Console, "warn">;
	private readonly audioHandler?: WarmStandbyResourceHandler<TAudioResource>;
	private readonly sttHandler?: WarmStandbyResourceHandler<TSttResource>;
	private readonly workerPoolHandler?: WarmStandbyResourceHandler<TWorkerPoolResource>;

	private state: WarmStandbyState = "idle";
	private lastError: string | null = null;
	private activeMeetingId: string | null = null;
	private deferredBackgroundWarmup = false;
	private lifecyclePromise: Promise<void> = Promise.resolve();

	private audioResource: TAudioResource | null = null;
	private sttResource: TSttResource | null = null;
	private workerPoolResource: TWorkerPoolResource | null = null;

	constructor(
		options: WarmStandbyManagerOptions<
			TAudioResource,
			TSttResource,
			TWorkerPoolResource
		> = {},
	) {
		this.bus = options.bus ?? new SupervisorBus();
		this.logger = options.logger ?? console;
		this.audioHandler = options.audio;
		this.sttHandler = options.stt;
		this.workerPoolHandler = options.workerPool;

		this.bus.subscribe("budget:pressure", async (event) => {
			if (
				event.lane === "background" &&
				event.level === "critical" &&
				this.activeMeetingId === null
			) {
				this.deferredBackgroundWarmup = true;
			}
		});
	}

	getState(): WarmStandbyState {
		return this.state;
	}

	async warmUp(): Promise<WarmStandbyHealth> {
		return this.enqueueLifecycle(async () => {
			const shouldWarmMissingWorkerPool =
				!this.deferredBackgroundWarmup &&
				this.workerPoolHandler &&
				this.workerPoolResource === null;
			if (
				(this.state === "ready" || this.state === "bound") &&
				!shouldWarmMissingWorkerPool
			) {
				return this.getHealth();
			}

			this.state = "warming";
			this.lastError = null;

			try {
				if (this.audioHandler && this.audioResource === null) {
					this.audioResource = await this.audioHandler.warmUp();
				}

				if (this.sttHandler && this.sttResource === null) {
					this.sttResource = await this.sttHandler.warmUp();
				}

				if (
					!this.deferredBackgroundWarmup &&
					this.workerPoolHandler &&
					this.workerPoolResource === null
				) {
					this.workerPoolResource = await this.workerPoolHandler.warmUp();
				}

				this.state = this.activeMeetingId ? "bound" : "ready";
				return this.getHealth();
			} catch (error) {
				this.lastError = error instanceof Error ? error.message : String(error);
				this.state = "faulted";
				await this.coolDownPartiallyWarmedResources();
				throw error;
			}
		});
	}

	async coolDown(): Promise<void> {
		return this.enqueueLifecycle(async () => {
			this.state = "cooling";
			this.activeMeetingId = null;
			this.lastError = null;

			await this.coolDownResource(
				this.workerPoolHandler,
				this.workerPoolResource,
			);
			this.workerPoolResource = null;

			await this.coolDownResource(this.sttHandler, this.sttResource);
			this.sttResource = null;

			await this.coolDownResource(this.audioHandler, this.audioResource);
			this.audioResource = null;

			this.state = "idle";
		});
	}

	async bindMeeting(meetingId: string): Promise<void> {
		await this.warmUp();
		this.activeMeetingId = meetingId;
		this.state = "bound";
	}

	async unbindMeeting(): Promise<void> {
		this.activeMeetingId = null;
		this.state = this.hasAnyWarmResources() ? "ready" : "idle";
	}

	getAudioResource(): TAudioResource | null {
		return this.audioResource;
	}

	getSttResource(): TSttResource | null {
		return this.sttResource;
	}

	getWorkerPoolResource(): TWorkerPoolResource | null {
		return this.workerPoolResource;
	}

	async isAudioResourceHealthy(): Promise<boolean> {
		return this.checkResourceHealth(this.audioHandler, this.audioResource);
	}

	async isSttResourceHealthy(): Promise<boolean> {
		return this.checkResourceHealth(this.sttHandler, this.sttResource);
	}

	async isWorkerPoolResourceHealthy(): Promise<boolean> {
		return this.checkResourceHealth(
			this.workerPoolHandler,
			this.workerPoolResource,
		);
	}

	async invalidateAudioResource(): Promise<void> {
		return this.enqueueLifecycle(async () => {
			await this.coolDownResource(this.audioHandler, this.audioResource);
			this.audioResource = null;
			this.state = this.hasAnyWarmResources() ? "ready" : "idle";
		});
	}

	async invalidateSttResource(): Promise<void> {
		return this.enqueueLifecycle(async () => {
			await this.coolDownResource(this.sttHandler, this.sttResource);
			this.sttResource = null;
			this.state = this.hasAnyWarmResources() ? "ready" : "idle";
		});
	}

	async invalidateWorkerPoolResource(): Promise<void> {
		return this.enqueueLifecycle(async () => {
			await this.coolDownResource(
				this.workerPoolHandler,
				this.workerPoolResource,
			);
			this.workerPoolResource = null;
			this.state = this.hasAnyWarmResources() ? "ready" : "idle";
		});
	}

	private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		let resolve!: (value: T) => void;
		let reject!: (reason: unknown) => void;
		const resultPromise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		this.lifecyclePromise = this.lifecyclePromise.then(
			() => operation().then(resolve, reject),
			() => operation().then(resolve, reject),
		);

		return resultPromise;
	}

	async resumeDeferredWarmup(): Promise<WarmStandbyHealth> {
		this.deferredBackgroundWarmup = false;
		if (this.workerPoolHandler && this.workerPoolResource === null) {
			this.state = this.activeMeetingId ? "bound" : "warming";
		}
		return this.warmUp();
	}

	getHealth(): WarmStandbyHealth {
		return {
			state: this.state,
			ready: this.state === "ready" || this.state === "bound",
			activeMeetingId: this.activeMeetingId,
			deferredBackgroundWarmup: this.deferredBackgroundWarmup,
			audio: {
				ready: this.audioResource !== null,
				healthy: this.audioResource !== null && !this.lastError,
			},
			stt: {
				ready: this.sttResource !== null,
				healthy: this.sttResource !== null && !this.lastError,
			},
			workerPool: {
				ready: this.workerPoolResource !== null,
				healthy: this.workerPoolResource !== null && !this.lastError,
			},
			lastError: this.lastError,
		};
	}

	private async checkResourceHealth<TResource>(
		handler: WarmStandbyResourceHandler<TResource> | undefined,
		resource: TResource | null,
	): Promise<boolean> {
		if (!handler || resource === null) {
			return false;
		}

		if (!handler.checkHealth) {
			return true;
		}

		try {
			return Boolean(await handler.checkHealth(resource));
		} catch (error) {
			this.logger.warn(
				"[WarmStandbyManager] Resource health check failed:",
				error,
			);
			return false;
		}
	}

	private async coolDownPartiallyWarmedResources(): Promise<void> {
		await this.coolDownResource(
			this.workerPoolHandler,
			this.workerPoolResource,
		);
		this.workerPoolResource = null;
		await this.coolDownResource(this.sttHandler, this.sttResource);
		this.sttResource = null;
		await this.coolDownResource(this.audioHandler, this.audioResource);
		this.audioResource = null;
	}

	private async coolDownResource<TResource>(
		handler: WarmStandbyResourceHandler<TResource> | undefined,
		resource: TResource | null,
	): Promise<void> {
		if (!handler?.coolDown || resource === null) {
			return;
		}

		try {
			await handler.coolDown(resource);
		} catch (error) {
			this.logger.warn("[WarmStandbyManager] Failed cooling resource:", error);
		}
	}

	private hasAnyWarmResources(): boolean {
		return (
			this.audioResource !== null ||
			this.sttResource !== null ||
			this.workerPoolResource !== null
		);
	}
}
