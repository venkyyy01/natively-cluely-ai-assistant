import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticQuestionClassifier } from '../conscious/SemanticQuestionClassifier';

function makeClient(response: string, opts?: { hasCapability?: boolean; delayMs?: number; throws?: boolean }) {
  return {
    generateContentStructured: async (_message: string) => {
      if (opts?.throws) throw new Error('client_error');
      if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return response;
    },
    hasStructuredGenerationCapability: () => opts?.hasCapability !== false,
  };
}

test('SemanticQuestionClassifier returns null when no client is configured', async () => {
  const classifier = new SemanticQuestionClassifier(null);
  const out = await classifier.classify({ question: 'How would you build it?' });
  assert.equal(out, null);
});

test('SemanticQuestionClassifier returns null when client lacks structured capability', async () => {
  const classifier = new SemanticQuestionClassifier(makeClient('{}', { hasCapability: false }));
  const out = await classifier.classify({ question: 'How would you build it?' });
  assert.equal(out, null);
});

test('SemanticQuestionClassifier parses a valid LLM response', async () => {
  const payload = JSON.stringify({
    questionMode: 'system_design',
    reactionKind: 'fresh_question',
    confidence: 0.86,
    reason: 'Walk-me-through about a pipeline indicates architecture/scale.',
    signals: ['walk me through', 'recommendation pipeline'],
  });
  const classifier = new SemanticQuestionClassifier(makeClient(payload));
  const out = await classifier.classify({ question: 'Walk me through how you would structure a recommendation pipeline.' });

  assert.ok(out);
  assert.equal(out!.questionMode, 'system_design');
  assert.equal(out!.reactionKind, 'fresh_question');
  assert.ok(out!.confidence > 0.8);
});

test('SemanticQuestionClassifier returns null on malformed JSON', async () => {
  const classifier = new SemanticQuestionClassifier(makeClient('not json at all'));
  const out = await classifier.classify({ question: 'Tell me about a time you led a project.' });
  assert.equal(out, null);
});

test('SemanticQuestionClassifier returns null on out-of-vocabulary labels', async () => {
  const classifier = new SemanticQuestionClassifier(makeClient(JSON.stringify({
    questionMode: 'invented_label',
    reactionKind: 'made_up',
    confidence: 0.99,
    reason: 'invalid',
  })));
  const out = await classifier.classify({ question: 'whatever' });
  assert.equal(out, null);
});

test('SemanticQuestionClassifier respects the timeout budget', async () => {
  const classifier = new SemanticQuestionClassifier(
    makeClient(JSON.stringify({ questionMode: 'system_design', reactionKind: 'fresh_question', confidence: 0.9 }), { delayMs: 200 }),
    { timeoutMs: 50 },
  );
  const out = await classifier.classify({ question: 'How would you scale this?' });
  assert.equal(out, null);
});

test('SemanticQuestionClassifier swallows client errors and returns null', async () => {
  const classifier = new SemanticQuestionClassifier(makeClient('', { throws: true }));
  const out = await classifier.classify({ question: 'How would you scale this?' });
  assert.equal(out, null);
});

test('SemanticQuestionClassifier caches identical questions', async () => {
  let calls = 0;
  const client = {
    generateContentStructured: async () => {
      calls += 1;
      return JSON.stringify({ questionMode: 'system_design', reactionKind: 'fresh_question', confidence: 0.86 });
    },
    hasStructuredGenerationCapability: () => true,
  };
  const classifier = new SemanticQuestionClassifier(client);

  const a = await classifier.classify({ question: 'How would you design a feed?' });
  const b = await classifier.classify({ question: 'How would you design a feed?' });
  const c = await classifier.classify({ question: '  How would YOU design a feed?  ' });

  assert.ok(a && b && c);
  assert.equal(calls, 1);
});
