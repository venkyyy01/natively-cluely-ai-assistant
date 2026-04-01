import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../SessionTracker';

test('SessionTracker merges adjacent same-speaker final transcript fragments into one conversation turn', () => {
  const session = new SessionTracker();

  session.addTranscript({
    marker: 'seg-1',
    speaker: 'interviewer',
    text: 'How would you',
    timestamp: 1_000,
    final: true,
    confidence: 0.8,
  });
  session.addTranscript({
    marker: 'seg-2',
    speaker: 'interviewer',
    text: 'design a cache?',
    timestamp: 1_300,
    final: true,
    confidence: 0.6,
  });

  const turns = session.getConversationTurns();

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.speaker, 'interviewer');
  assert.equal(turns[0]?.source, 'system');
  assert.equal(turns[0]?.text, 'How would you design a cache?');
  assert.equal(turns[0]?.startedAt, 1_000);
  assert.equal(turns[0]?.endedAt, 1_300);
  assert.equal(turns[0]?.final, true);
  assert.equal(turns[0]?.confidence, 0.7);
  assert.deepEqual(turns[0]?.mergedSegmentIds, ['seg-1', 'seg-2']);
});

test('SessionTracker preserves overlapping speaker turns instead of flattening them', () => {
  const session = new SessionTracker();

  session.addTranscript({
    speaker: 'interviewer',
    text: 'Walk me through the design.',
    timestamp: 1_000,
    final: true,
  });
  session.addTranscript({
    speaker: 'user',
    text: 'I would start with the API boundary.',
    timestamp: 1_100,
    final: true,
  });
  session.addTranscript({
    speaker: 'interviewer',
    text: 'What happens if traffic spikes?',
    timestamp: 1_600,
    final: true,
  });

  const turns = session.getConversationTurns();

  assert.equal(turns.length, 3);
  assert.equal(turns[0]?.speaker, 'interviewer');
  assert.equal(turns[1]?.speaker, 'user');
  assert.equal(turns[2]?.speaker, 'interviewer');
  assert.equal(turns[0]?.overlapGroupId, turns[1]?.overlapGroupId);
  assert.equal(turns[1]?.overlapGroupId, turns[2]?.overlapGroupId);
  assert.notEqual(turns[0]?.overlapGroupId, undefined);
});

test('SessionTracker keeps merging same-speaker continuation fragments even after overlap tagging', () => {
  const session = new SessionTracker();

  session.addTranscript({
    speaker: 'interviewer',
    text: 'Walk me through the design.',
    timestamp: 1_000,
    final: true,
  });
  session.addTranscript({
    speaker: 'user',
    text: 'I would start with the API boundary.',
    timestamp: 1_100,
    final: true,
  });
  session.addTranscript({
    speaker: 'interviewer',
    text: 'The first piece is the write path.',
    timestamp: 1_200,
    final: true,
  });
  session.addTranscript({
    speaker: 'interviewer',
    text: 'Then I would separate the read path.',
    timestamp: 1_350,
    final: true,
  });

  const turns = session.getConversationTurns();

  assert.equal(turns.length, 3);
  assert.equal(turns[2]?.text, 'The first piece is the write path. Then I would separate the read path.');
  assert.equal(turns[1]?.overlapGroupId, turns[2]?.overlapGroupId);
});

test('SessionTracker caches assembled turns and invalidates the cache when a new segment arrives', () => {
  const session = new SessionTracker();
  const tracker = session as any;

  session.addTranscript({
    speaker: 'interviewer',
    text: 'Tell me about the data model.',
    timestamp: 1_000,
    final: true,
  });

  const first = session.getConversationTurns();
  const second = session.getConversationTurns();
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  assert.equal(Array.isArray(tracker.turnCache), true);

  session.addTranscript({
    speaker: 'user',
    text: 'I would separate write and read concerns.',
    timestamp: 2_500,
    final: true,
  });

  const third = session.getConversationTurns();
  assert.notEqual(third, first);
  assert.equal(third.length, 2);
});

test('SessionTracker invalidates the turn cache when transcript compaction rewrites the source segments', async () => {
  const session = new SessionTracker();
  const tracker = session as any;

  tracker.fullTranscript = Array.from({ length: 1_801 }, (_, index) => ({
    speaker: index % 2 === 0 ? 'interviewer' : 'user',
    text: `segment-${index}`,
    timestamp: index * 2_000,
    final: true,
  }));

  const beforeCompaction = session.getConversationTurns();
  assert.ok(beforeCompaction.length > 1_300);

  await tracker.compactTranscriptIfNeeded();

  const afterCompaction = session.getConversationTurns();
  assert.notEqual(afterCompaction, beforeCompaction);
  assert.ok(afterCompaction.length < beforeCompaction.length);
});

test('SessionTracker returns defensive transcript snapshots instead of the live backing array', () => {
  const session = new SessionTracker();

  session.addTranscript({
    speaker: 'interviewer',
    text: 'Original transcript text.',
    timestamp: 1_000,
    final: true,
  });

  const firstSnapshot = session.getFullTranscript();
  firstSnapshot[0]!.text = 'Mutated externally.';

  const secondSnapshot = session.getFullTranscript();
  assert.equal(secondSnapshot[0]?.text, 'Original transcript text.');
});

test('SessionTracker reports P50/P95/P99 ingestion latency stats for repeated final transcript arrivals', () => {
  const session = new SessionTracker();
  const originalNow = Date.now;
  const nowValues = [1_050, 1_150, 1_300, 2_050, 2_400];
  let nowIndex = 0;

  Date.now = () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? originalNow();

  try {
    session.addTranscript({
      speaker: 'interviewer',
      text: 'First fragment',
      timestamp: 1_000,
      final: true,
    });
    session.addTranscript({
      speaker: 'interviewer',
      text: 'Second fragment',
      timestamp: 1_100,
      final: true,
    });
    session.addTranscript({
      speaker: 'interviewer',
      text: 'Third fragment',
      timestamp: 1_200,
      final: true,
    });
    session.addTranscript({
      speaker: 'user',
      text: 'Reply start',
      timestamp: 2_000,
      final: true,
    });
    session.addTranscript({
      speaker: 'user',
      text: 'Reply finish',
      timestamp: 2_300,
      final: true,
    });

    assert.deepEqual(session.getTimingVarianceStats(), {
      sampleCount: 5,
      p50: 50,
      p95: 100,
      p99: 100,
      max: 100,
    });
  } finally {
    Date.now = originalNow;
  }
});

test('SessionTracker formats prompt context from assembled conversation turns instead of raw transcript fragments', () => {
  const session = new SessionTracker();
  const originalNow = Date.now;

  Date.now = () => 5_000;

  try {
    session.addTranscript({
      marker: 'seg-1',
      speaker: 'interviewer',
      text: 'How would you',
      timestamp: 1_000,
      final: true,
    });
    session.addTranscript({
      marker: 'seg-2',
      speaker: 'interviewer',
      text: 'design a cache?',
      timestamp: 1_300,
      final: true,
    });
    session.addTranscript({
      speaker: 'user',
      text: 'I would start with cache-aside and clear ownership boundaries.',
      timestamp: 2_000,
      final: true,
    });

    assert.equal(
      session.getFormattedContext(10),
      [
        '[INTERVIEWER]: How would you design a cache?',
        '[ME]: I would start with cache-aside and clear ownership boundaries.',
      ].join('\n'),
    );
  } finally {
    Date.now = originalNow;
  }
});

test('SessionTracker keeps formatted prompt context strictly bounded to the requested time window', () => {
  const session = new SessionTracker();
  const originalNow = Date.now;

  Date.now = () => 5_000;

  try {
    session.addTranscript({
      speaker: 'interviewer',
      text: 'How would you',
      timestamp: 1_800,
      final: true,
    });
    session.addTranscript({
      speaker: 'interviewer',
      text: 'design a cache?',
      timestamp: 2_100,
      final: true,
    });

    assert.equal(session.getFormattedContext(3), '[INTERVIEWER]: design a cache?');
  } finally {
    Date.now = originalNow;
  }
});

test('SessionTracker keeps distinct assistant suggestions separate in formatted prompt context', () => {
  const session = new SessionTracker();
  const originalNow = Date.now;

  Date.now = () => 10_000;

  try {
    session.addAssistantMessage('Start by clarifying the write and read paths first.');

    Date.now = () => 10_300;
    session.addAssistantMessage('Then explain the cache invalidation tradeoff clearly.');

    Date.now = () => 11_000;
    assert.equal(
      session.getFormattedContext(5),
      [
        '[ASSISTANT (PREVIOUS SUGGESTION)]: Start by clarifying the write and read paths first.',
        '[ASSISTANT (PREVIOUS SUGGESTION)]: Then explain the cache invalidation tradeoff clearly.',
      ].join('\n'),
    );
  } finally {
    Date.now = originalNow;
  }
});

test('SessionTracker does not merge out-of-order same-speaker fragments in formatted prompt context', () => {
  const session = new SessionTracker();
  const originalNow = Date.now;

  Date.now = () => 5_000;

  try {
    session.addTranscript({
      speaker: 'interviewer',
      text: 'design a cache?',
      timestamp: 2_000,
      final: true,
    });
    session.addTranscript({
      speaker: 'interviewer',
      text: 'How would you',
      timestamp: 1_700,
      final: true,
    });

    assert.equal(
      session.getFormattedContext(10),
      [
        '[INTERVIEWER]: design a cache?',
        '[INTERVIEWER]: How would you',
      ].join('\n'),
    );
  } finally {
    Date.now = originalNow;
  }
});
