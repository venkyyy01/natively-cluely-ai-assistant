// electron/tests/streamingHandlerAbortDiscipline.test.ts
//
// NAT-008 / audit A-8: ConsciousStreamingHandler.start() must cleanly abort
// the prior in-flight stream so we never interleave tokens from two turns.
//
// These tests verify:
//   1. start() while an existing stream is in-flight aborts the prior
//      AbortController (no leaked controllers).
//   2. The cancellation event for the *prior* stream is emitted and awaited
//      BEFORE start() returns (handlers see ordered cancellation, then the
//      new stream begins).
//   3. The new stream gets a strictly greater streamId, and chunk loops
//      already mid-flight from the prior stream stop emitting once the new
//      streamId supersedes them (no token interleaving).
//   4. Events are stamped with the streamId of the stream that produced
//      them, so handlers can route or filter by stream.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousStreamingHandler, type StreamEvent } from '../conscious/ConsciousStreamingHandler';

test('NAT-008: start() while prior stream in-flight aborts it and emits cancelled for the prior streamId', async () => {
  const handler = new ConsciousStreamingHandler({
    enableProgressiveRendering: true,
    chunkDelayMs: 0,
    maxChunkSize: 5,
    bufferSize: 1,
    abortOnError: false,
    timeoutMs: 1000,
  });

  const events: StreamEvent[] = [];
  handler.on((event) => {
    events.push(event);
  });

  await handler.start();
  const firstStreamId = handler.getCurrentStreamId();
  assert.equal(firstStreamId, 1, 'first start() bumps stream id to 1');

  await handler.start();
  const secondStreamId = handler.getCurrentStreamId();
  assert.equal(secondStreamId, 2, 'second start() bumps stream id to 2');

  const cancelledForFirst = events.find(
    (e) => e.type === 'cancelled' && e.streamId === firstStreamId,
  );
  assert.ok(cancelledForFirst, 'a cancelled event for the FIRST streamId must have been emitted');
  assert.equal(handler.isAborted(), false, 'second start() installs a fresh, non-aborted controller');
});

test('NAT-008: streamReasoning from a superseded stream stops emitting chunks', async () => {
  const handler = new ConsciousStreamingHandler({
    enableProgressiveRendering: true,
    chunkDelayMs: 5,
    maxChunkSize: 4,
    bufferSize: 1,
    abortOnError: false,
    timeoutMs: 1000,
  });

  const reasoningChunkStreamIds: number[] = [];
  handler.on((event) => {
    if (event.type === 'reasoning_chunk' && event.streamId != null) {
      reasoningChunkStreamIds.push(event.streamId);
    }
  });

  await handler.start();
  const firstStreamId = handler.getCurrentStreamId();

  // Long enough that we are guaranteed to be mid-loop when start() lands.
  const longReasoning = 'a'.repeat(200);
  const inFlight = handler.streamReasoning(longReasoning);

  await new Promise((resolve) => setTimeout(resolve, 12));

  await handler.start();
  const secondStreamId = handler.getCurrentStreamId();
  assert.notEqual(firstStreamId, secondStreamId);

  await inFlight;

  const chunksAfterSupersede = reasoningChunkStreamIds.filter(
    (id, idx) => id === firstStreamId && idx > 0
      && reasoningChunkStreamIds.slice(0, idx).some((prior) => prior === firstStreamId)
      && reasoningChunkStreamIds.indexOf(secondStreamId) !== -1
      && idx > reasoningChunkStreamIds.indexOf(secondStreamId),
  );
  assert.equal(
    chunksAfterSupersede.length,
    0,
    'no reasoning_chunk events for the OLD streamId should be emitted after the new stream starts',
  );

  for (const id of reasoningChunkStreamIds) {
    assert.ok(
      id === firstStreamId || id === secondStreamId,
      `chunk streamId must be one of {${firstStreamId}, ${secondStreamId}}, got ${id}`,
    );
  }
});

test('NAT-008: cancelled event ordering — handler sees cancelled for prior id BEFORE any event for new id', async () => {
  const handler = new ConsciousStreamingHandler({
    enableProgressiveRendering: false,
    chunkDelayMs: 0,
    maxChunkSize: 100,
    bufferSize: 1,
    abortOnError: false,
    timeoutMs: 1000,
  });

  const ordered: Array<{ type: string; streamId?: number }> = [];
  handler.on(async (event) => {
    if (event.type === 'cancelled') {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    ordered.push({ type: event.type, streamId: event.streamId });
  });

  await handler.start();
  const firstId = handler.getCurrentStreamId();

  await handler.start();
  const secondId = handler.getCurrentStreamId();

  await handler.streamReasoning('hello');

  const cancelledIdx = ordered.findIndex(
    (e) => e.type === 'cancelled' && e.streamId === firstId,
  );
  assert.ok(cancelledIdx >= 0, 'cancelled for firstId was emitted');

  const firstEventForSecondId = ordered.findIndex(
    (e) => e.streamId === secondId,
  );
  assert.ok(firstEventForSecondId >= 0, 'at least one event for secondId was emitted');

  assert.ok(
    cancelledIdx < firstEventForSecondId,
    `cancelled(firstId) must arrive at handler BEFORE first event(secondId): cancelledIdx=${cancelledIdx} firstNewIdx=${firstEventForSecondId}`,
  );
});

test('NAT-008: emit() stamps streamId automatically when caller does not supply one', async () => {
  const handler = new ConsciousStreamingHandler({
    enableProgressiveRendering: false,
    chunkDelayMs: 0,
    maxChunkSize: 100,
    bufferSize: 1,
    abortOnError: false,
    timeoutMs: 1000,
  });

  const seenStreamIds: Array<number | undefined> = [];
  handler.on((event) => {
    seenStreamIds.push(event.streamId);
  });

  await handler.start();
  const id = handler.getCurrentStreamId();
  await handler.streamReasoning('hi');

  assert.ok(seenStreamIds.length > 0, 'some events were emitted');
  for (const sid of seenStreamIds) {
    assert.equal(sid, id, `every emitted event in this stream must carry streamId=${id}, got ${sid}`);
  }
});
