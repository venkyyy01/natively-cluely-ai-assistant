import { SupervisorBus } from "../runtime/SupervisorBus";

export type CheckpointTrigger =
	| "answer-committed"
	| "phase-transition"
	| "user-action"
	| "meeting-stop";

interface EventCheckpointPolicyOptions {
	bus?: SupervisorBus;
	cooldownMs?: number;
	now?: () => number;
	triggerCheckpoint: (
		checkpointId: string,
		trigger: CheckpointTrigger,
		detail?: string,
	) => Promise<void> | void;
	checkpointIdFactory?: (trigger: CheckpointTrigger, detail?: string) => string;
}

export class EventCheckpointPolicy {
	private readonly bus: SupervisorBus;
	private readonly cooldownMs: number;
	private readonly now: () => number;
	private readonly triggerCheckpoint: (
		checkpointId: string,
		trigger: CheckpointTrigger,
		detail?: string,
	) => Promise<void> | void;
	private readonly checkpointIdFactory: (
		trigger: CheckpointTrigger,
		detail?: string,
	) => string;
	private lastCheckpointAt = Number.NEGATIVE_INFINITY;

	constructor(options: EventCheckpointPolicyOptions) {
		this.bus = options.bus ?? new SupervisorBus();
		this.cooldownMs = options.cooldownMs ?? 5000;
		this.now = options.now ?? Date.now;
		this.triggerCheckpoint = options.triggerCheckpoint;
		this.checkpointIdFactory =
			options.checkpointIdFactory ??
			((trigger, detail) => `${trigger}:${detail ?? "auto"}:${this.now()}`);

		this.bus.subscribe("inference:answer-committed", async (event) => {
			await this.requestCheckpoint("answer-committed", event.requestId);
		});
		this.bus.subscribe("lifecycle:meeting-stopping", async () => {
			await this.requestCheckpoint("meeting-stop");
		});
	}

	async notePhaseTransition(phase: string): Promise<boolean> {
		return this.requestCheckpoint("phase-transition", phase);
	}

	async noteUserAction(action: string): Promise<boolean> {
		return this.requestCheckpoint("user-action", action);
	}

	private async requestCheckpoint(
		trigger: CheckpointTrigger,
		detail?: string,
	): Promise<boolean> {
		const now = this.now();
		if (now - this.lastCheckpointAt < this.cooldownMs) {
			return false;
		}

		this.lastCheckpointAt = now;
		const checkpointId = this.checkpointIdFactory(trigger, detail);
		await this.triggerCheckpoint(checkpointId, trigger, detail);
		return true;
	}
}
