import type { InterviewPhase } from "../conscious/types";

export type SupervisorState =
	| "idle"
	| "starting"
	| "running"
	| "stopping"
	| "faulted";

export type StealthState = "OFF" | "ARMING" | "FULL_STEALTH" | "FAULT";

export type RuntimeLifecycleState = "idle" | "starting" | "active" | "stopping";

export type SupervisorName =
	| "audio"
	| "stt"
	| "inference"
	| "stealth"
	| "recovery";

export type SupervisorCoreEvent =
	| { type: "audio:gap-detected"; durationMs: number }
	| { type: "audio:capture-started" }
	| { type: "audio:capture-stopped" }
	| {
			type: "stt:transcript";
			speaker: "interviewer" | "user";
			text: string;
			final: boolean;
			traceId?: string;
	  }
	| { type: "stt:provider-exhausted"; speaker: "interviewer" | "user" }
	| { type: "inference:draft-ready"; requestId: string }
	| { type: "inference:answer-committed"; requestId: string }
	| { type: "stealth:state-changed"; from: StealthState; to: StealthState }
	| { type: "stealth:illegal_transition"; from: StealthState; event: string }
	| { type: "stealth:native-arm-skipped"; reason: string }
	| { type: "stealth:fault"; reason: string }
	| { type: "stealth:fault-loop-detected"; reason: string }
	| { type: "recovery:checkpoint-written"; checkpointId: string }
	| { type: "recovery:restore-complete"; sessionId: string }
	| { type: "lifecycle:meeting-starting"; meetingId: string }
	| { type: "lifecycle:meeting-active"; meetingId: string }
	| { type: "lifecycle:meeting-stopping" }
	| { type: "lifecycle:meeting-idle" }
	| {
			type: "conscious:phase_changed";
			from: InterviewPhase;
			to: InterviewPhase;
			trigger: "interviewer_transcript" | "manual";
	  }
	| {
			type: "conscious:thread_action";
			action: "start" | "continue" | "reset";
			question: string;
			phase: InterviewPhase;
			threadId: string | null;
			topic: string | null;
	  }
	| { type: "budget:pressure"; lane: string; level: "warning" | "critical" };

export type SupervisorEvent =
	| SupervisorCoreEvent
	| {
			type: "bus:listener-error";
			sourceEventType: SupervisorCoreEvent["type"];
			failureCount: number;
			messages: string[];
			critical: boolean;
	  }
	| {
			/**
			 * NAT-020: emitted when a single listener has thrown
			 * `LISTENER_FAILURE_THRESHOLD` times within
			 * `LISTENER_FAILURE_WINDOW_MS` and has been auto-unsubscribed by the
			 * bus circuit-breaker. Subscribers can use this to alert / restart
			 * the offending component. The bus itself never re-throws.
			 */
			type: "bus:listener-circuit-open";
			sourceEventType: SupervisorCoreEvent["type"] | "any";
			failureCount: number;
			/** Reason string from the most recent failure, for debugging. */
			lastErrorMessage: string;
	  };

export type SupervisorEventType = SupervisorEvent["type"];

export type SupervisorEventListener<TType extends SupervisorEventType> = (
	event: Extract<SupervisorEvent, { type: TType }>,
) => void | Promise<void>;

export type SupervisorEventAnyListener = (
	event: SupervisorEvent,
) => void | Promise<void>;

export interface ISupervisor {
	readonly name: SupervisorName;
	start(): Promise<void>;
	stop(): Promise<void>;
	getState(): SupervisorState;
}
