/**
 * NAT-XXX: Tests for STT -> Intent Classification tracing
 * Verifies trace context propagation and span creation throughout the pipeline
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TraceContext,
  Span,
  startTrace,
  getTrace,
  endTrace,
  startSpan,
  endSpan,
  setSpanAttribute,
  getCurrentSpan,
  clearAllTraces,
} from '../tracing';
import { traceLogger } from '../tracing';

test('TraceContext: creates spans with parent-child relationships', () => {
  const trace = new TraceContext('test-trace-1');

  const rootSpan = trace.startSpan('root');
  assert.equal(rootSpan.traceId, 'test-trace-1');
  assert.equal(rootSpan.parentSpanId, undefined);
  assert.equal(rootSpan.name, 'root');

  const childSpan = trace.startSpan('child', rootSpan.spanId);
  assert.equal(childSpan.parentSpanId, rootSpan.spanId);

  const grandchildSpan = trace.startSpan('grandchild', childSpan.spanId);
  assert.equal(grandchildSpan.parentSpanId, childSpan.spanId);
});

test('TraceContext: spans track attributes and timing', () => {
  const trace = new TraceContext('test-trace-2');
  const span = trace.startSpan('timed-span');

  span.setAttribute('stt.speaker', 'interviewer');
  span.setAttribute('stt.confidence', 0.95);
  span.setAttribute('stt.is_final', true);

  assert.equal(span.attributes['stt.speaker'], 'interviewer');
  assert.equal(span.attributes['stt.confidence'], 0.95);
  assert.equal(span.attributes['stt.is_final'], true);

  // Verify span has start time
  assert.ok(span.startTime > 0);
  assert.equal(span.endTime, undefined);

  span.end('ok');
  assert.ok(span.endTime);
  assert.ok(span.durationMs! >= 0);
  assert.equal(span.status, 'ok');
});

test('TraceContext: handles error spans', () => {
  const trace = new TraceContext('test-trace-3');
  const span = trace.startSpan('error-span');

  span.end('error', 'Something went wrong');

  assert.equal(span.status, 'error');
  assert.equal(span.errorMessage, 'Something went wrong');
});

test('Global trace helpers: start/end trace', () => {
  clearAllTraces();

  const trace = startTrace('global-test-1');
  assert.ok(trace);
  assert.equal(trace.traceId, 'global-test-1');

  const retrieved = getTrace('global-test-1');
  assert.equal(retrieved, trace);

  endTrace('global-test-1');
  assert.equal(getTrace('global-test-1'), undefined);
});

test('Global span helpers: start/end span', () => {
  clearAllTraces();

  const span = startSpan('span-test-1', 'test.operation');
  assert.ok(span);
  assert.equal(span.name, 'test.operation');

  setSpanAttribute('span-test-1', span.spanId, 'intent.model', 'regex');
  assert.equal(span.attributes['intent.model'], 'regex');

  const current = getCurrentSpan('span-test-1');
  assert.equal(current?.spanId, span.spanId);

  endSpan('span-test-1', span.spanId, 'ok');
  assert.equal(span.status, 'ok');
  assert.ok(span.endTime);
});

test('TraceLogger: logs events', () => {
  traceLogger.setConsoleLogging(false); // Don't spam console during tests
  traceLogger.clear();

  traceLogger.logSttEvent('trace-1', 'span-1', 'transcript.final', {
    speaker: 'interviewer',
    text: 'Hello world',
    isFinal: true,
    confidence: 0.95,
    provider: 'deepgram',
    sampleRate: 16000,
  });

  traceLogger.logIntentClassificationEvent('trace-1', 'span-2', 'completed', {
    question: 'What is your experience?',
    transcriptRevision: 5,
    assistantResponseCount: 10,
    result: {
      intent: 'behavioral',
      confidence: 0.88,
      answerShape: 'STAR format',
      provider: 'foundation',
      retryCount: 0,
    },
    modelUsed: 'foundation',
    tier: 1,
  });

  traceLogger.logModelInvocation('trace-1', 'span-3', {
    modelName: 'Xenova/nli-deberta-v3-small',
    modelVersion: 'quantized',
    latencyMs: 25,
    inputTokens: 45,
    outputTokens: 8,
  });

  const events = traceLogger.getEvents();
  assert.equal(events.length, 3);

  const sttEvent = events[0]!;
  assert.equal(sttEvent.traceId, 'trace-1');
  assert.equal(sttEvent.event, 'transcript.final');
  assert.equal(sttEvent.level, 'info');
});

test('TraceContext: toJSON serialization', () => {
  const trace = new TraceContext('json-test');
  const span = trace.startSpan('serializable');
  span.setAttribute('key', 'value');
  span.end('ok');

  const json = trace.toJSON();
  assert.equal(json.traceId, 'json-test');
  assert.ok(Array.isArray(json.spans));
  assert.equal((json.spans as unknown[]).length, 1);
});

test('Span: toJSON serialization', () => {
  const span = new Span('trace-json', undefined, 'test-span');
  span.setAttributes({
    'stt.provider': 'deepgram',
    'stt.model': 'nova-3',
  });
  span.end('ok');

  const json = span.toJSON();
  assert.equal(json.traceId, 'trace-json');
  assert.equal(json.name, 'test-span');
  assert.equal(json.status, 'ok');
  assert.ok(json.attributes);
  assert.equal((json.attributes as Record<string, string>)['stt.provider'], 'deepgram');
});

test('TraceContext: purges finished spans correctly', () => {
  clearAllTraces();
  const trace = startTrace('purge-test');

  const span1 = startSpan('purge-test', 'span1');
  const span2 = startSpan('purge-test', 'span2');

  endSpan('purge-test', span1!.spanId, 'ok');
  endSpan('purge-test', span2!.spanId, 'error', 'failed');

  // Verify trace still has spans
  assert.equal(trace.getAllSpans().length, 2);

  endTrace('purge-test');

  // After ending trace, should be removed
  assert.equal(getTrace('purge-test'), undefined);
});

test('Nested spans: depth tracking', () => {
  clearAllTraces();

  const trace = new TraceContext('nest-test');

  const root = trace.startSpan('root');
  assert.ok(root);
  assert.equal(trace.getCurrentSpan()?.spanId, root.spanId);

  const child = trace.startSpan('child', root.spanId);
  assert.equal(child.parentSpanId, root.spanId);
  assert.equal(trace.getCurrentSpan()?.spanId, child.spanId);

  const grandchild = trace.startSpan('grandchild');
  assert.equal(grandchild.parentSpanId, child.spanId);
  assert.equal(trace.getCurrentSpan()?.spanId, grandchild.spanId);

  trace.endSpan(grandchild.spanId, 'ok');
  // After ending grandchild, current should be child
  const afterGrandchild = trace.getCurrentSpan();
  assert.ok(afterGrandchild);
  assert.equal(afterGrandchild.spanId, child.spanId);

  trace.endSpan(child.spanId, 'ok');
  // After ending child, current should be root
  const afterChild = trace.getCurrentSpan();
  assert.ok(afterChild);
  assert.equal(afterChild.spanId, root.spanId);

  trace.endSpan(root.spanId, 'ok');
  // After ending root, current should be undefined
  assert.equal(trace.getCurrentSpan(), undefined);
});

test('Error handling: missing trace', () => {
  // Should gracefully handle operations on non-existent traces
  const result = getTrace('non-existent');
  assert.equal(result, undefined);

  // endSpan should not throw
  endSpan('non-existent', 'span-id', 'ok');
});

// Cleanup after tests
process.on('beforeExit', () => {
  clearAllTraces();
});
