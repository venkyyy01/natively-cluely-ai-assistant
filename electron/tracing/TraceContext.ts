/**
 * NAT-XXX: Distributed tracing for STT -> Intent Classification flow
 * Captures complete request lifecycle with correlation IDs
 */

export interface TraceId {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
}

export interface SpanAttributes {
	[key: string]: string | number | boolean | undefined;
}

export class Span {
	public readonly spanId: string;
	public readonly traceId: string;
	public readonly parentSpanId?: string;
	public readonly name: string;
	public readonly startTime: number;
	public endTime?: number;
	public status: "ok" | "error" = "ok";
	public errorMessage?: string;
	public attributes: SpanAttributes = {};

	constructor(
		traceId: string,
		parentSpanId: string | undefined,
		name: string,
		spanId?: string,
	) {
		this.traceId = traceId;
		this.parentSpanId = parentSpanId;
		this.name = name;
		this.spanId = spanId ?? generateSpanId();
		this.startTime = Date.now();
	}

	setAttribute(key: string, value: string | number | boolean): void {
		this.attributes[key] = value;
	}

	setAttributes(attrs: SpanAttributes): void {
		Object.assign(this.attributes, attrs);
	}

	end(status: "ok" | "error" = "ok", errorMessage?: string): void {
		this.endTime = Date.now();
		this.status = status;
		this.errorMessage = errorMessage;
	}

	get durationMs(): number | undefined {
		if (this.endTime) {
			return this.endTime - this.startTime;
		}
		return undefined;
	}

	toJSON(): Record<string, unknown> {
		return {
			traceId: this.traceId,
			spanId: this.spanId,
			parentSpanId: this.parentSpanId,
			name: this.name,
			startTime: this.startTime,
			endTime: this.endTime,
			durationMs: this.durationMs,
			status: this.status,
			errorMessage: this.errorMessage,
			attributes: this.attributes,
		};
	}
}

export class TraceContext {
	public readonly traceId: string;
	private spans: Map<string, Span> = new Map();
	private currentSpanId?: string;

	constructor(traceId?: string) {
		this.traceId = traceId ?? generateTraceId();
	}

	startSpan(name: string, parentSpanId?: string): Span {
		const parent = parentSpanId ?? this.currentSpanId;
		const span = new Span(this.traceId, parent, name);
		this.spans.set(span.spanId, span);
		this.currentSpanId = span.spanId;
		return span;
	}

	endSpan(
		spanId: string,
		status: "ok" | "error" = "ok",
		errorMessage?: string,
	): void {
		const span = this.spans.get(spanId);
		if (span) {
			span.end(status, errorMessage);
			// Reset current span to parent if ending the current one
			if (this.currentSpanId === spanId) {
				this.currentSpanId = span.parentSpanId;
			}
		}
	}

	getSpan(spanId: string): Span | undefined {
		return this.spans.get(spanId);
	}

	getCurrentSpan(): Span | undefined {
		if (this.currentSpanId) {
			return this.spans.get(this.currentSpanId);
		}
		return undefined;
	}

	getAllSpans(): Span[] {
		return Array.from(this.spans.values());
	}

	toJSON(): Record<string, unknown> {
		return {
			traceId: this.traceId,
			spans: this.getAllSpans().map((s) => s.toJSON()),
		};
	}
}

function generateTraceId(): string {
	return `tr-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 11)}`;
}

function generateSpanId(): string {
	return `sp-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
}
