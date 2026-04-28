import test from 'node:test';
import assert from 'node:assert/strict';

import { ConsciousPreparationCoordinator } from '../conscious/ConsciousPreparationCoordinator';
import { TokenCounter } from '../shared/TokenCounter';
import { TokenBudgetManager } from '../conscious/TokenBudget';

function makeCoordinator(opts?: {
  tokenCounter?: TokenCounter;
  tokenBudgetManager?: TokenBudgetManager;
}) {
  const session = {
    isConsciousModeEnabled: (): boolean => true,
    isLikelyGeneralIntent: (): boolean => false,
    getAssistantResponseHistory: (): any[] => [],
    getConsciousEvidenceContext: (): string => 'Evidence context line.',
    getConsciousLongMemoryContext: (): string => 'Long memory context.',
    setConsciousSemanticContext: (): void => {},
    getFormattedContext: (): string => '',
    getActiveReasoningThread: (): null => null,
    getLatestConsciousResponse: (): null => null,
    getLatestQuestionReaction: (): null => null,
    getLatestAnswerHypothesis: (): null => null,
    getConsciousResponsePreferenceContext: (): string => 'Preference context.',
    getConsciousResponsePreferenceSummary: () => ({
      preferredLength: 'concise',
      styleHints: [] as string[],
    }),
  } as any;

  const orchestrator = {
    prepareRoute: async () => ({
      preRouteDecision: { qualifies: true },
    }),
  } as any;

  const composer = {
    compose: () => ({
      contextItems: [] as any[],
      preparedTranscript: 'Prepared transcript.',
      temporalContext: {},
    }),
  } as any;

  const intentService = {
    resolve: async () => ({
      intentResult: { intent: 'general', confidence: 0.9 },
      totalContextAssemblyMs: 50,
      timedOut: false,
    }),
  } as any;

  return new ConsciousPreparationCoordinator(
    session,
    orchestrator,
    composer,
    intentService,
    opts?.tokenCounter,
    opts?.tokenBudgetManager,
  );
}

test('NAT-045: uses accurate token counting instead of whitespace heuristic', () => {
  const tokenCounter = new TokenCounter('openai');
  const tokenBudgetManager = new TokenBudgetManager('openai');
  const coordinator = makeCoordinator({ tokenCounter, tokenBudgetManager });

  const block = (coordinator as any).buildEvidenceContextBlock({
    answerPlan: {
      questionMode: 'technical',
      answerShape: 'prose',
      deliveryFormat: 'text',
      deliveryStyle: 'neutral',
      maxWords: 100,
      groundingHint: 'default',
      focalFacets: [],
    },
    stateBlock: 'State block content.',
    liveRagBlock: 'Live RAG block content.',
    longMemoryBlock: 'Long memory block content.',
    semanticBlock: 'Semantic block content.',
    tokenBudget: 4000,
  });

  assert.strictEqual(typeof block, 'string');
  assert.ok(block.length > 0);
});

test('NAT-045: trims lowest-priority blocks first when over soft budget', () => {
  const tokenCounter = new TokenCounter('openai');
  const tokenBudgetManager = new TokenBudgetManager('openai');
  const coordinator = makeCoordinator({ tokenCounter, tokenBudgetManager });

  // Create a tiny budget so everything must be trimmed
  const block = (coordinator as any).buildEvidenceContextBlock({
    answerPlan: {
      questionMode: 'technical',
      answerShape: 'prose',
      deliveryFormat: 'text',
      deliveryStyle: 'neutral',
      maxWords: 100,
      groundingHint: 'default',
      focalFacets: [],
    },
    stateBlock: 'A'.repeat(500),
    liveRagBlock: 'B'.repeat(500),
    longMemoryBlock: 'C'.repeat(500),
    semanticBlock: 'D'.repeat(500),
    tokenBudget: 100, // tiny soft budget (~60 tokens)
  });

  assert.ok(block.length > 0);
  // Total block should not grossly exceed the soft budget in characters
  // (budget is 100 tokens ~ 400 chars for openai heuristic)
  assert.ok(block.length < 600, `Expected block length < 600, got ${block.length}`);
});

test('NAT-045: keeps all blocks when total tokens are within soft budget', () => {
  const tokenCounter = new TokenCounter('openai');
  const tokenBudgetManager = new TokenBudgetManager('openai');
  const coordinator = makeCoordinator({ tokenCounter, tokenBudgetManager });

  const block = (coordinator as any).buildEvidenceContextBlock({
    answerPlan: {
      questionMode: 'technical',
      answerShape: 'prose',
      deliveryFormat: 'text',
      deliveryStyle: 'neutral',
      maxWords: 100,
      groundingHint: 'default',
      focalFacets: [],
    },
    stateBlock: 'Short state.',
    liveRagBlock: 'Short live.',
    longMemoryBlock: 'Short memory.',
    semanticBlock: 'Short semantic.',
    tokenBudget: 4000,
  });

  assert.ok(block.includes('Preference'));
  assert.ok(block.includes('Short state'));
  assert.ok(block.includes('Short live'));
  assert.ok(block.includes('Short memory'));
  assert.ok(block.includes('Short semantic'));
  assert.ok(block.includes('Evidence'));
});
