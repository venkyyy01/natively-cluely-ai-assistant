import type {
	ProtectionEvent,
	ProtectionEventContext,
	ProtectionEventType,
	ProtectionSnapshot,
	ProtectionState,
	ProtectionStateMachineOptions,
	ProtectionViolation,
	ProtectionViolationType,
} from "./protectionStateTypes";

const DEFAULT_MAX_VIOLATIONS = 50;

function cloneEvent(event: ProtectionEvent): ProtectionEvent {
	return {
		...event,
		warnings: event.warnings ? [...event.warnings] : undefined,
		metadata: event.metadata ? { ...event.metadata } : undefined,
	};
}

function cloneViolation(violation: ProtectionViolation): ProtectionViolation {
	return {
		...violation,
		event: cloneEvent(violation.event),
	};
}

function nextStateForEvent(
	current: ProtectionState,
	event: ProtectionEvent,
): ProtectionState {
	switch (event.type) {
		case "window-created":
			return current === "fault-contained" ? current : "protecting-hidden";
		case "protection-apply-started":
			return current === "fault-contained" ? current : "protecting-hidden";
		case "protection-apply-finished":
			return current === "fault-contained" ? current : "protecting-hidden";
		case "verification-passed":
			return current === "fault-contained" ? current : "verified-hidden";
		case "verification-failed":
			return current === "fault-contained" ? current : "degraded-observed";
		case "show-requested":
			return current;
		case "shown":
			return current === "verified-hidden" || current === "visible-protected"
				? "visible-protected"
				: "degraded-observed";
		case "hide-requested":
			return current;
		case "hidden":
			return current === "visible-protected" ? "verified-hidden" : current;
		case "fault":
			return "fault-contained";
		case "recovery-requested":
			return "protecting-hidden";
	}
}

function violationForEvent(
	current: ProtectionState,
	event: ProtectionEvent,
): ProtectionViolationType | null {
	if (
		event.type === "show-requested" &&
		current !== "verified-hidden" &&
		current !== "visible-protected"
	) {
		return "show-before-verified";
	}

	if (
		event.type === "shown" &&
		current !== "verified-hidden" &&
		current !== "visible-protected"
	) {
		return "shown-before-verified";
	}

	if (event.type === "protection-apply-started" && event.visible) {
		return "protecting-visible-window";
	}

	return null;
}

export class ProtectionStateMachine {
	private readonly logger?: Pick<Console, "warn" | "log">;
	private readonly maxViolations: number;
	private readonly now: () => number;
	private state: ProtectionState = "boot";
	private previousState: ProtectionState | null = null;
	private lastEvent: ProtectionEvent | null = null;
	private updatedAtMs = 0;
	private eventCount = 0;
	private violations: ProtectionViolation[] = [];

	constructor(options: ProtectionStateMachineOptions = {}) {
		this.logger = options.logger;
		this.maxViolations = options.maxViolations ?? DEFAULT_MAX_VIOLATIONS;
		this.now = options.now ?? (() => Date.now());
		this.updatedAtMs = this.now();
	}

	record(
		type: ProtectionEventType,
		context: ProtectionEventContext = {},
	): ProtectionSnapshot {
		const event: ProtectionEvent = {
			...context,
			type,
			timestampMs: this.now(),
		};
		const stateBefore = this.state;
		const violationType = violationForEvent(stateBefore, event);
		if (violationType) {
			const violation: ProtectionViolation = {
				type: violationType,
				stateBefore,
				event: cloneEvent(event),
				timestampMs: event.timestampMs,
			};
			this.violations.push(violation);
			if (this.violations.length > this.maxViolations) {
				this.violations = this.violations.slice(
					this.violations.length - this.maxViolations,
				);
			}
			this.logger?.warn?.(
				`[ProtectionStateMachine] Observe-only violation: ${violationType}`,
				{
					stateBefore,
					eventType: event.type,
					source: event.source,
					windowId: event.windowId,
					windowRole: event.windowRole,
					reason: event.reason,
				},
			);
		}

		const nextState = nextStateForEvent(this.state, event);
		this.previousState = this.state;
		this.state = nextState;
		this.lastEvent = cloneEvent(event);
		this.updatedAtMs = event.timestampMs;
		this.eventCount += 1;

		return this.getSnapshot();
	}

	getSnapshot(): ProtectionSnapshot {
		return {
			state: this.state,
			previousState: this.previousState,
			lastEventType: this.lastEvent?.type ?? null,
			lastEvent: this.lastEvent ? cloneEvent(this.lastEvent) : null,
			updatedAtMs: this.updatedAtMs,
			eventCount: this.eventCount,
			violations: this.violations.map(cloneViolation),
		};
	}

	clear(): void {
		this.state = "boot";
		this.previousState = null;
		this.lastEvent = null;
		this.updatedAtMs = this.now();
		this.eventCount = 0;
		this.violations = [];
	}
}
