import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';

class FakeLLMHelper {
  private callIndex = 0;

  async *streamChat(message: string): AsyncGenerator<string> {
    this.callIndex += 1;

    if (this.callIndex === 1) {
      yield JSON.stringify({
        mode: 'reasoning_first',
        openingReasoning: 'I would first pick the simplest partitioning strategy that keeps writes cheap.',
        implementationPlan: ['Partition by tenant', 'Cache hot reads', 'Keep writes append-only'],
        tradeoffs: ['Cross-tenant analytics become more complex'],
        edgeCases: ['Tenants with highly uneven traffic can create hotspots'],
        scaleConsiderations: [],
        pushbackResponses: ['The partitioning keeps the operational model straightforward while we validate load patterns.'],
        likelyFollowUps: ['What happens when one tenant grows much faster than the others?'],
        codeTransition: 'Then I would model the tenant-aware repository boundary.',
      });
      return;
    }

    if (message.includes('ACTIVE_REASONING_THREAD') && this.callIndex === 2) {
      yield JSON.stringify({
        mode: 'reasoning_first',
        openingReasoning: 'The tradeoff is mostly around cross-tenant coordination and operational visibility.',
        implementationPlan: [],
        tradeoffs: ['Cross-tenant reporting needs an aggregation path'],
        edgeCases: [],
        scaleConsiderations: [],
        pushbackResponses: ['I would call out that the tradeoff buys us better tenant isolation on the write path.'],
        likelyFollowUps: ['How does this behave if one tenant is 10x larger?'],
        codeTransition: '',
      });
      return;
    }

    if (message.includes('ACTIVE_REASONING_THREAD')) {
      yield JSON.stringify({
        mode: 'reasoning_first',
        openingReasoning: 'If one tenant is 10x larger, I would split that tenant again before changing the whole design.',
        implementationPlan: [],
        tradeoffs: [],
        edgeCases: ['Hot tenants need rebalancing without moving everyone else'],
        scaleConsiderations: ['Promote large tenants to dedicated partitions and rebalance asynchronously'],
        pushbackResponses: ['That lets me preserve the base design while scaling the exceptional tenant separately.'],
        likelyFollowUps: ['What metrics would you watch first?'],
        codeTransition: 'At that point I would show the shard-mapping abstraction.',
      });
      return;
    }

    yield 'Could you repeat that? I want to make sure I address your question properly.';
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

test('Conscious Mode preserves and extends the same reasoning thread across pushback and scale follow-ups', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);

  addInterviewerTurn(session, 'How would you partition a multi-tenant analytics system?', Date.now() - 3000);
  await engine.runWhatShouldISay(undefined, 0.85);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'Why this approach?', Date.now() - 2000);
  await engine.runWhatShouldISay(undefined, 0.85);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'What if one tenant is 10x larger?', Date.now() - 1000);
  await engine.runWhatShouldISay(undefined, 0.85);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'What metrics would you watch first?', Date.now() - 500);
  await engine.runWhatShouldISay(undefined, 0.85);

  const thread = session.getActiveReasoningThread();

  assert.equal(thread?.rootQuestion, 'How would you partition a multi-tenant analytics system?');
  assert.equal(thread?.followUpCount, 3);
  assert.equal(thread?.response.mode, 'reasoning_first');
  assert.deepEqual(thread?.response.implementationPlan, [
    'Partition by tenant',
    'Cache hot reads',
    'Keep writes append-only',
  ]);
  assert.deepEqual(thread?.response.tradeoffs, [
    'Cross-tenant analytics become more complex',
    'Cross-tenant reporting needs an aggregation path',
  ]);
  assert.deepEqual(thread?.response.edgeCases, [
    'Tenants with highly uneven traffic can create hotspots',
    'Hot tenants need rebalancing without moving everyone else',
  ]);
  assert.deepEqual(thread?.response.scaleConsiderations, [
    'Promote large tenants to dedicated partitions and rebalance asynchronously',
  ]);
  assert.equal(thread?.response.codeTransition, 'At that point I would show the shard-mapping abstraction.');
});

test('Conscious Mode resets an active reasoning thread when the interviewer clearly changes to a non-technical topic', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you partition a multi-tenant analytics system?', Date.now() - 2000);
  await engine.runWhatShouldISay(undefined, 0.85);

  const existingThread = session.getActiveReasoningThread();
  assert.equal(existingThread?.rootQuestion, 'How would you partition a multi-tenant analytics system?');

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'Let us switch gears and talk about the launch plan.', Date.now());
  const answer = await engine.runWhatShouldISay(undefined, 0.85);

  assert.equal(answer, 'Could you repeat that? I want to make sure I address your question properly.');
  assert.equal(session.getActiveReasoningThread(), null);
  assert.equal(session.getLatestConsciousResponse(), null);
});

test('Conscious Mode does not let unrelated generic pushback hijack an old thread', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you partition a multi-tenant analytics system?', Date.now() - 30_000);
  await engine.runWhatShouldISay(undefined, 0.85);

  const threadBefore = session.getActiveReasoningThread();
  assert.equal(threadBefore?.followUpCount, 0);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'What if?', Date.now());
  const answer = await engine.runWhatShouldISay(undefined, 0.85);

  assert.equal(answer, 'Could you repeat that? I want to make sure I address your question properly.');
  const threadAfter = session.getActiveReasoningThread();
  assert.equal(threadAfter?.rootQuestion, 'How would you partition a multi-tenant analytics system?');
  assert.equal(threadAfter?.followUpCount, 0);
});
