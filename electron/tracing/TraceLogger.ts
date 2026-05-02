/**
 * NAT-XXX: Structured trace logging for STT -> Intent Classification
 * Logs to console and optionally to file for debugging
 */

import { type Span, TraceContext } from "./TraceContext";

export type TraceLevel = "debug" | "info" | "warn" | "error";

export interface TraceEvent {
	ts: number;
	level: TraceLevel;
	traceId: string;
	spanId?: string;
	event: string;
	data?: Record<string, unknown>;
}

export interface SttTraceData {
	speaker: "interviewer" | "user";
	text: string;
	isFinal: boolean;
	confidence?: number;
	sampleRate?: number;
	provider?: string;
}

export interface IntentClassificationTraceData {
	question: string;
	transcriptRevision?: number;
	assistantResponseCount?: number;
	result?: {
		intent: string;
		confidence: number;
		answerShape: string;
		provider: string;
		retryCount: number;
		fallbackReason?: string;
		staleness?: { transcriptRevision: number; ageMs: number };
	};
	modelUsed?: "regex" | "slm" | "foundation" | "context_heuristic";
	tier?: 1 | 2 | 3;
	error?: string;
}

export interface ModelTraceData {
	modelName: string;
	modelVersion?: string;
	inputTokens?: number;
	outputTokens?: number;
	latencyMs?: number;
	error?: string;
}

class TraceLogger {
	private enabled = true;
	private logToConsole = true;
	private events: TraceEvent[] = [];
	private maxEvents = 10000;

	enable(): void {
		this.enabled = true;
	}

	disable(): void {
		this.enabled = false;
	}

	setConsoleLogging(enabled: boolean): void {
		this.logToConsole = enabled;
	}

	log(event: TraceEvent): void {
		if (!this.enabled) return;

		this.events.push(event);
		if (this.events.length > this.maxEvents) {
			this.events.shift();
		}

		if (this.logToConsole) {
			const dataStr = event.data ? ` | ${JSON.stringify(event.data)}` : "";
			const prefix = `[TRACE:${event.traceId.substring(0, 12)}]`;
			const spanPart = event.spanId
				? ` span=${event.spanId.substring(0, 8)}`
				: "";
			const msg = `${prefix}${spanPart} ${event.event}${dataStr}`;

			switch (event.level) {
				case "debug":
					console.debug(msg);
					break;
				case "info":
					console.info(msg);
					break;
				case "warn":
					console.warn(msg);
					break;
				case "error":
					console.error(msg);
					break;
			}
		}
	}

	logSpanStart(span: Span): void {
		this.log({
			ts: span.startTime,
			level: "debug",
			traceId: span.traceId,
			spanId: span.spanId,
			event: "span.start",
			data: { name: span.name, parentSpanId: span.parentSpanId },
		});
	}

	logSpanEnd(span: Span): void {
		this.log({
			ts: span.endTime ?? Date.now(),
			level: span.status === "error" ? "error" : "debug",
			traceId: span.traceId,
			spanId: span.spanId,
			event: "span.end",
			data: {
				name: span.name,
				durationMs: span.durationMs,
				status: span.status,
				errorMessage: span.errorMessage,
				attributes: span.attributes,
			},
		});
	}

	logSttEvent(
		traceId: string,
		spanId: string | undefined,
		event: "transcript.received" | "transcript.final" | "audio.dropped",
		data: SttTraceData,
	): void {
		this.log({
			ts: Date.now(),
			level: "info",
			traceId,
			spanId,
			event,
			data: { ...data } as unknown as Record<string, unknown>,
		});
	}

	logIntentClassificationEvent(
		traceId: string,
		spanId: string | undefined,
		phase: "started" | "completed" | "failed",
		data: IntentClassificationTraceData,
	): void {
		this.log({
			ts: Date.now(),
			level: phase === "failed" ? "error" : "info",
			traceId,
			spanId,
			event: `intent.classification.${phase}`,
			data: { ...data } as unknown as Record<string, unknown>,
		});
	}

	logModelInvocation(
		traceId: string,
		spanId: string | undefined,
		data: ModelTraceData,
	): void {
		this.log({
			ts: Date.now(),
			level: data.error ? "error" : "debug",
			traceId,
			spanId,
			event: "model.invocation",
			data: { ...data } as unknown as Record<string, unknown>,
		});
	}

	getEvents(): TraceEvent[] {
		return [...this.events];
	}

	clear(): void {
		this.events = [];
	}

	exportToJSON(): string {
		return JSON.stringify(this.events, null, 2);
	}
}

export const traceLogger = new TraceLogger();
