import type { EventCheckpointPolicy } from "../memory/EventCheckpointPolicy";
import type { TieredMemoryManager } from "../memory/TieredMemoryManager";
import { SupervisorBus } from "./SupervisorBus";
import type { ISupervisor, SupervisorState } from "./types";

export interface RecoverySupervisorDelegate {
	start?: () => Promise<void> | void;
	stop?: () => Promise<void> | void;
	checkpoint?: (checkpointId: string) => Promise<void> | void;
	restore?: (sessionId: string) => Promise<void> | void;
}

interface RecoverySupervisorOptions {
	delegate: RecoverySupervisorDelegate;
	bus?: SupervisorBus;
	checkpointPolicy?: EventCheckpointPolicy;
	tieredMemoryManager?: TieredMemoryManager<unknown>;
}

export class RecoverySupervisor implements ISupervisor {
	readonly name = "recovery" as const;
	private state: SupervisorState = "idle";
	private readonly delegate: RecoverySupervisorDelegate;
	private readonly bus: SupervisorBus;
	private readonly checkpointPolicy?: EventCheckpointPolicy;
	private readonly tieredMemoryManager?: TieredMemoryManager<unknown>;

	constructor(options: RecoverySupervisorOptions) {
		this.delegate = options.delegate;
		this.bus = options.bus ?? new SupervisorBus();
		this.checkpointPolicy = options.checkpointPolicy;
		this.tieredMemoryManager = options.tieredMemoryManager;
	}

	getState(): SupervisorState {
		return this.state;
	}

	async start(): Promise<void> {
		if (this.state !== "idle") {
			throw new Error(`Cannot start recovery supervisor while ${this.state}`);
		}

		this.state = "starting";
		try {
			await this.delegate.start?.();
			this.state = "running";
		} catch (error) {
			this.state = "faulted";
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.state === "idle") {
			return;
		}

		this.state = "stopping";
		try {
			await this.delegate.stop?.();
		} finally {
			this.state = "idle";
		}
	}

	async checkpoint(checkpointId: string): Promise<void> {
		await this.delegate.checkpoint?.(checkpointId);
		await this.bus.emit({ type: "recovery:checkpoint-written", checkpointId });
	}

	async restore(sessionId: string): Promise<void> {
		await this.delegate.restore?.(sessionId);
		await this.bus.emit({ type: "recovery:restore-complete", sessionId });
	}

	getTieredMemoryManager<
		TValue = unknown,
	>(): TieredMemoryManager<TValue> | null {
		return (
			(this.tieredMemoryManager as TieredMemoryManager<TValue> | undefined) ??
			null
		);
	}

	async notePhaseTransition(phase: string): Promise<boolean> {
		if (!this.checkpointPolicy) {
			return false;
		}

		return this.checkpointPolicy.notePhaseTransition(phase);
	}

	async noteUserAction(action: string): Promise<boolean> {
		if (!this.checkpointPolicy) {
			return false;
		}

		return this.checkpointPolicy.noteUserAction(action);
	}
}
