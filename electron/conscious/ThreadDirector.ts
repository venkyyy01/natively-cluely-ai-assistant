// electron/conscious/ThreadDirector.ts — NAT-055 single entry for conversation thread lifecycle
import { EventEmitter } from "events";
import type { ConsciousModeStructuredResponse } from "../ConsciousMode";
import type { ConsciousThreadStore } from "./ConsciousThreadStore";
import type { ThreadManager } from "./ThreadManager";
import type { InterviewPhase } from "./types";

export type ThreadResetReason = string;

export interface ConversationThreadViews {
	design: { activeThreadId: string | null };
	reasoning: { activeThreadId: string | null; followUpCount: number | null };
	telemetry: { suspendedThreadCount: number; hasActiveDesignThread: boolean };
}

/**
 * Owns mutations that touch both the design-time thread (ThreadManager) and the
 * reasoning snapshot (ConsciousThreadStore). SessionTracker routes here when
 * `NATIVELY_THREAD_DIRECTOR=1`.
 */
export class ThreadDirector extends EventEmitter {
	constructor(private readonly store: ConsciousThreadStore) {
		super();
		this.setMaxListeners(50);
	}

	getThreadManager(): ThreadManager {
		return this.store.getThreadManager();
	}

	getViews(): ConversationThreadViews {
		const design = this.store.getThreadManager().getActiveThread();
		const reasoning = this.store.getActiveReasoningThread();
		const suspended = this.store.getThreadManager().getSuspendedThreads();
		return {
			design: { activeThreadId: design?.id ?? null },
			reasoning: {
				activeThreadId: reasoning?.threadId ?? null,
				followUpCount: reasoning?.followUpCount ?? null,
			},
			telemetry: {
				suspendedThreadCount: suspended.length,
				hasActiveDesignThread: design !== null,
			},
		};
	}

	/**
	 * When both a design thread and a reasoning snapshot exist, `ReasoningThread.threadId`
	 * must match the active `ConversationThread.id`.
	 */
	assertDesignReasoningInvariant(): void {
		const design = this.store.getThreadManager().getActiveThread();
		const reasoning = this.store.getActiveReasoningThread();
		if (!design || !reasoning) {
			return;
		}
		if (reasoning.threadId !== design.id) {
			throw new Error(
				`ThreadDirector invariant: design ${design.id} !== reasoning.threadId ${String(reasoning.threadId)}`,
			);
		}
	}

	handleObservedInterviewerTranscript(
		transcript: string,
		detectPhaseFromTranscript: (transcript: string) => InterviewPhase,
		setCurrentPhase: (phase: InterviewPhase) => void,
	): void {
		this.store.handleObservedInterviewerTranscript(
			transcript,
			detectPhaseFromTranscript,
			setCurrentPhase,
		);
		this.assertDesignReasoningInvariant();
	}

	recordConsciousResponse(
		question: string,
		response: ConsciousModeStructuredResponse,
		threadAction: "start" | "continue" | "reset",
	): void {
		this.store.recordConsciousResponse(question, response, threadAction);
		this.assertDesignReasoningInvariant();
	}

	openThread(topic: string, phase: InterviewPhase) {
		return this.store.getThreadManager().createThread(topic, phase);
	}

	resumeThread(threadId: string): boolean {
		return this.store.getThreadManager().resumeThread(threadId);
	}

	suspendThread(interruptedBy?: string): void {
		this.store.getThreadManager().suspendActive(interruptedBy);
	}

	resetThread(reason: ThreadResetReason): void {
		this.store.reset();
		this.emit("thread:reset", { reason });
	}

	subscribe(
		event: "thread:reset",
		listener: (payload: { reason: ThreadResetReason }) => void,
	): () => void {
		this.on(event, listener);
		return () => {
			this.off(event, listener);
		};
	}
}
