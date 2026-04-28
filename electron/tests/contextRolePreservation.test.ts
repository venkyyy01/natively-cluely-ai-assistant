import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../SessionTracker';
import { ParallelContextAssembler } from '../cache/ParallelContextAssembler';

test('SessionTracker adaptive context preserves original speaker roles', async () => {
  const tracker = new SessionTracker();

  tracker.handleTranscript({
    speaker: 'interviewer',
    text: 'How would you design a durable queue?',
    timestamp: Date.now() - 3000,
    final: true,
  });

  tracker.handleTranscript({
    speaker: 'user',
    text: 'I would start with an append-only log and explicit retry semantics.',
    timestamp: Date.now() - 2000,
    final: true,
  });

  tracker.addAssistantMessage('I would prioritize durability and idempotency before throughput tuning.');

  const context = await tracker.getAdaptiveContext('queue durability', [1, 0, 0], 500);

  assert.ok(context.some((item) => item.role === 'interviewer'));
  assert.ok(context.some((item) => item.role === 'user') || context.some((item) => item.role === 'assistant'));
  assert.equal(context.every((item) => item.role === 'interviewer'), false);
});

test('ParallelContextAssembler preserves user role and timestamps for relevant context', async () => {
  const assembler = new ParallelContextAssembler({ workerThreadCount: 1 });
  const tsUser = Date.now() - 2000;

  const result = await assembler.assemble({
    query: 'retry semantics append-only log',
    transcript: [
      { speaker: 'interviewer', text: 'How would you design durable queues?', timestamp: Date.now() - 3000 },
      { speaker: 'user', text: 'I would use append-only log with retry semantics.', timestamp: tsUser },
    ],
    previousContext: { recentTopics: [], activeThread: null },
  });

  assert.ok(result.relevantContext.length > 0);
  const userEntry = result.relevantContext.find((item) => item.text.includes('append-only log'));
  assert.ok(userEntry);
  assert.equal(userEntry?.role, 'user');
  assert.equal(userEntry?.timestamp, tsUser);
});
