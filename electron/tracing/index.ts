/**
 * NAT-XXX: Tracing module exports
 * Provides trace context management for STT -> Intent Classification flow
 */

export { TraceContext, Span, type SpanAttributes, type TraceId } from './TraceContext';
export {
  traceLogger,
  type TraceEvent,
  type TraceLevel,
  type SttTraceData,
  type IntentClassificationTraceData,
  type ModelTraceData,
} from './TraceLogger';

import { TraceContext, Span } from './TraceContext';
import { traceLogger } from './TraceLogger';

// Global active traces map (by some correlation key like requestId or sessionId)
const activeTraces = new Map<string, TraceContext>();

export function startTrace(correlationId: string): TraceContext {
  const trace = new TraceContext(correlationId);
  activeTraces.set(correlationId, trace);
  return trace;
}

export function getTrace(correlationId: string): TraceContext | undefined {
  return activeTraces.get(correlationId);
}

export function endTrace(correlationId: string): TraceContext | undefined {
  const trace = activeTraces.get(correlationId);
  if (trace) {
    // End all unfinished spans
    for (const span of trace.getAllSpans()) {
      if (!span.endTime) {
        span.end();
        traceLogger.logSpanEnd(span);
      }
    }
    activeTraces.delete(correlationId);
  }
  return trace;
}

export function startSpan(
  correlationId: string,
  name: string,
  parentSpanId?: string,
): Span | undefined {
  const trace = activeTraces.get(correlationId);
  if (!trace) {
    // Auto-start a trace if none exists
    const newTrace = startTrace(correlationId);
    const span = newTrace.startSpan(name, parentSpanId);
    traceLogger.logSpanStart(span);
    return span;
  }
  const span = trace.startSpan(name, parentSpanId);
  traceLogger.logSpanStart(span);
  return span;
}

export function endSpan(
  correlationId: string,
  spanId: string,
  status: 'ok' | 'error' = 'ok',
  errorMessage?: string,
): void {
  const trace = activeTraces.get(correlationId);
  if (trace) {
    const span = trace.getSpan(spanId);
    if (span) {
      span.end(status, errorMessage);
      traceLogger.logSpanEnd(span);
    }
  }
}

export function getCurrentSpan(correlationId: string): Span | undefined {
  const trace = activeTraces.get(correlationId);
  return trace?.getCurrentSpan();
}

export function setSpanAttribute(
  correlationId: string,
  spanId: string,
  key: string,
  value: string | number | boolean,
): void {
  const trace = activeTraces.get(correlationId);
  const span = trace?.getSpan(spanId);
  if (span) {
    span.setAttribute(key, value);
  }
}

export function clearAllTraces(): void {
  activeTraces.clear();
  traceLogger.clear();
}
