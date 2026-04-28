import test from 'node:test';
import assert from 'node:assert/strict';

import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';

class TestIntelligenceEngine extends IntelligenceEngine {
  protected override async classifyIntentForRoute() {
    return {
      intent: 'general' as const,
      answerShape: 'concise',
      confidence: 1,
      provider: 'test',
      retryCount: 0,
    };
  }
}

class CapturingLatencyTracker extends AnswerLatencyTracker {
  public completedSnapshots: Array<ReturnType<AnswerLatencyTracker['complete']>> = [];

  override complete(requestId: string) {
    const snapshot = super.complete(requestId);
    this.completedSnapshots.push(snapshot);
    return snapshot;
  }
}

interface ChunkSchedule {
  chunk: string;
  delayMs?: number;
  onYield?: () => void | Promise<void>;
}

class ScheduledLLMHelper {
  public streamChats = 0;

  constructor(private readonly schedule: ChunkSchedule[]) {}

  getProviderCapabilityClass() {
    return 'streaming' as const;
  }

  getKnowledgeOrchestrator(): null {
    return null;
  }

  async *streamChat(_message: string): AsyncGenerator<string> {
    this.streamChats += 1;
    for (const item of this.schedule) {
      if (item.delayMs && item.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, item.delayMs));
      }
      yield item.chunk;
      if (item.onYield) {
        await item.onYield();
      }
    }
  }
}

function addInterviewerTurn(session: SessionTracker, text: string, timestamp: number): void {
  session.handleTranscript({
    speaker: 'interviewer',
    text,
    timestamp,
    final: true,
  });
}

test('NAT-007 / audit A-7: stream stops mid-flight when transcriptRevision advances', async () => {
  const session = new SessionTracker();

  const helper = new ScheduledLLMHelper([
    {
      chunk: 'first chunk ',
      onYield: () => {
        // Simulate the user sending another final transcript while we're still
        // generating the answer for the previous one. SessionTracker bumps
        // transcriptRevision on every final/interim handle.
        addInterviewerTurn(session, 'Actually, what about caching?', Date.now() + 100);
      },
    },
    { chunk: 'second chunk ', delayMs: 0 },
    { chunk: 'third chunk', delayMs: 0 },
  ]);

  const engine = new TestIntelligenceEngine(helper as unknown as never, session);
  const tracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = tracker;

  const initialQuestion = 'How would you design a rate limiter?';
  addInterviewerTurn(session, initialQuestion, Date.now());
  const revisionAtStart = session.getTranscriptRevision();

  const assistantBefore = session
    .getContext(180)
    .filter((entry) => entry.role === 'assistant').length;

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  // The streaming loop must have observed the revision drift mid-stream and
  // bailed before committing the partial answer to the session.
  assert.equal(
    answer,
    null,
    'stale-stopped run should return null instead of committing a partial answer',
  );

  const assistantAfter = session
    .getContext(180)
    .filter((entry) => entry.role === 'assistant').length;
  assert.equal(
    assistantAfter,
    assistantBefore,
    'session must NOT have addAssistantMessage called for a stale-stopped stream',
  );

  assert.notEqual(
    session.getTranscriptRevision(),
    revisionAtStart,
    'sanity: transcript revision actually advanced during the run',
  );

  const snapshot = tracker.completedSnapshots[tracker.completedSnapshots.length - 1];
  assert.equal(
    snapshot?.staleStopReason,
    'transcript_revision_changed',
    'latency snapshot should be tagged with the stale-stop reason',
  );
  assert.equal(snapshot?.completed, true);
});

test('NAT-007: AnswerLatencyTracker.markStaleStop finalizes snapshot exactly once', () => {
  const tracker = new AnswerLatencyTracker();
  const requestId = tracker.start('fast_standard_answer', 'streaming');

  const stale = tracker.markStaleStop(requestId, 'transcript_revision_changed');
  assert.equal(stale?.completed, true);
  assert.equal(stale?.staleStopReason, 'transcript_revision_changed');

  const completedAtFromStale = stale?.marks.completedAt;
  const second = tracker.complete(requestId);
  assert.equal(
    second?.marks.completedAt,
    completedAtFromStale,
    'subsequent complete() must NOT overwrite completedAt set by stale-stop',
  );
});
