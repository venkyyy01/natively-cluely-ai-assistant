import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../SessionTracker';
import { parseConsciousModeResponse } from '../ConsciousMode';
import { consciousModeRealtimeConfig } from '../consciousModeConfig';
import { createConsciousModeTranscriptFixture } from './fixtures/consciousModeTranscripts';

test('Conscious Mode centralizes realtime defaults for transcript debounce, timeout, resume TTL, and failure threshold', () => {
  assert.equal(consciousModeRealtimeConfig.transcriptDebounceMs, 350);
  assert.equal(consciousModeRealtimeConfig.structuredGenerationTimeoutMs, 1200);
  assert.equal(consciousModeRealtimeConfig.resumeTtlMs, 5 * 60 * 1000);
  assert.equal(consciousModeRealtimeConfig.repeatedFailureThreshold, 3);
});

test('SessionTracker buffers interviewer partials and promotes the latest revision after the debounce window', () => {
  const session = new SessionTracker();
  const baseTimestamp = Date.now();
  const fixture = createConsciousModeTranscriptFixture(baseTimestamp);

  assert.equal(session.handleTranscript(fixture.partialInterviewer), null);
  assert.equal(session.getFullTranscript().length, 0);
  assert.equal(session.getLastInterimInterviewer()?.text, fixture.partialInterviewer.text);

  assert.equal(session.handleTranscript(fixture.revisedPartialInterviewer), null);
  assert.equal(session.getLastInterimInterviewer()?.text, fixture.revisedPartialInterviewer.text);

  const promoted = session.handleTranscript({
    ...fixture.userHeartbeat,
    timestamp: fixture.revisedPartialInterviewer.timestamp + consciousModeRealtimeConfig.transcriptDebounceMs + 1,
  });

  assert.equal(promoted?.role, 'user');
  assert.equal(session.getLastInterimInterviewer(), null);
  assert.deepEqual(session.getContext(180).map(item => item.text), [
    fixture.revisedPartialInterviewer.text,
    fixture.userHeartbeat.text,
  ]);
  assert.deepEqual(session.getFullTranscript().map(segment => segment.text), [
    fixture.revisedPartialInterviewer.text,
    fixture.userHeartbeat.text,
  ]);
});

test('SessionTracker does not preserve stale partial text when a nearby interviewer turn is unrelated', () => {
  const session = new SessionTracker();
  const fixture = createConsciousModeTranscriptFixture(Date.now());

  assert.equal(session.handleTranscript(fixture.partialInterviewer), null);
  assert.equal(session.getLastInterimInterviewer()?.text, fixture.partialInterviewer.text);

  assert.equal(session.handleTranscript(fixture.unrelatedInterviewerNearRevisionWindow)?.role, 'interviewer');
  assert.equal(session.getLastInterimInterviewer(), null);
  assert.deepEqual(session.getContext(180).map(item => item.text), [
    fixture.unrelatedInterviewerNearRevisionWindow.text,
  ]);
  assert.deepEqual(session.getFullTranscript().map(segment => segment.text), [
    fixture.unrelatedInterviewerNearRevisionWindow.text,
  ]);
});

test('SessionTracker suppresses duplicate final interviewer transcripts', () => {
  const session = new SessionTracker();
  const fixture = createConsciousModeTranscriptFixture(Date.now());

  assert.equal(session.handleTranscript(fixture.finalInterviewer)?.role, 'interviewer');
  assert.equal(session.handleTranscript(fixture.duplicateFinalInterviewer), null);
  assert.deepEqual(session.getContext(180).map(item => item.text), [fixture.finalInterviewer.text]);
  assert.deepEqual(session.getFullTranscript().map(segment => segment.text), [fixture.finalInterviewer.text]);
});

test('SessionTracker rejects empty turns and very short low-confidence turns', () => {
  const session = new SessionTracker();
  const fixture = createConsciousModeTranscriptFixture(Date.now());

  assert.equal(session.handleTranscript(fixture.emptyTurn), null);
  assert.equal(session.handleTranscript(fixture.lowConfidenceNoise), null);
  assert.equal(session.getContext(180).length, 0);
  assert.equal(session.getFullTranscript().length, 0);
});

test('SessionTracker keeps out-of-order late interviewer finals out of the active context while still storing raw history', () => {
  const session = new SessionTracker();
  const fixture = createConsciousModeTranscriptFixture(Date.now());

  session.recordConsciousResponse(
    'How would you design a rate limiter for an API?',
    parseConsciousModeResponse(JSON.stringify({
      mode: 'reasoning_first',
      openingReasoning: 'Start with the limiting dimension.',
      implementationPlan: ['Use a token bucket'],
    })),
    'start',
  );

  assert.equal(session.handleTranscript(fixture.finalInterviewer)?.role, 'interviewer');
  assert.equal(session.handleTranscript(fixture.lateInterviewer), null);
  assert.equal(session.getLastInterviewerTurn(), fixture.finalInterviewer.text);
  assert.equal(session.getActiveReasoningThread()?.rootQuestion, 'How would you design a rate limiter for an API?');
  assert.deepEqual(session.getFullTranscript().map(segment => segment.text), [
    fixture.finalInterviewer.text,
    fixture.lateInterviewer.text,
  ]);
});

test('SessionTracker dedupes repeated out-of-order late interviewer finals in raw history', () => {
  const session = new SessionTracker();
  const fixture = createConsciousModeTranscriptFixture(Date.now());

  assert.equal(session.handleTranscript(fixture.finalInterviewer)?.role, 'interviewer');
  assert.equal(session.handleTranscript(fixture.lateInterviewer), null);
  assert.equal(session.handleTranscript(fixture.duplicateLateInterviewer), null);

  assert.deepEqual(session.getContext(180).map(item => item.text), [fixture.finalInterviewer.text]);
  assert.deepEqual(session.getFullTranscript().map(segment => segment.text), [
    fixture.finalInterviewer.text,
    fixture.lateInterviewer.text,
  ]);
});

test('SessionTracker fails closed on overlapping speaker-attribution errors without mutating thread state', () => {
  const session = new SessionTracker();
  const fixture = createConsciousModeTranscriptFixture(Date.now());

  session.recordConsciousResponse(
    'How would you design a rate limiter for an API?',
    parseConsciousModeResponse(JSON.stringify({
      mode: 'reasoning_first',
      openingReasoning: 'Start with the limiting dimension.',
      implementationPlan: ['Use a token bucket'],
    })),
    'start',
  );

  const beforeThread = session.getActiveReasoningThread();

  assert.equal(session.handleTranscript(fixture.overlapFailureInterviewer), null);
  assert.deepEqual(session.getActiveReasoningThread(), beforeThread);
  assert.equal(session.getContext(180).length, 0);
  assert.equal(session.getFullTranscript().length, 0);
});
