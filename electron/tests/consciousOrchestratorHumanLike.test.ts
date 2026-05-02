import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousOrchestrator } from '../conscious/ConsciousOrchestrator';
import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';
import type { AnswerHypothesis } from '../conscious/AnswerHypothesisStore';
import type { QuestionReaction } from '../conscious/QuestionReactionClassifier';
import { setOptimizationFlagsForTesting } from '../config/optimizations';

const baselineResponse: ConsciousModeStructuredResponse = {
  mode: 'reasoning_first',
  openingReasoning: 'Use a token bucket.',
  implementationPlan: ['Use Redis as the counter.'],
  tradeoffs: [],
  edgeCases: [],
  scaleConsiderations: [],
  pushbackResponses: [],
  likelyFollowUps: [],
  codeTransition: '',
};

function createSession() {
  const session = {
    isConsciousModeEnabled: (): boolean => true,
    getActiveReasoningThread: (): ReasoningThread | null => null,
    getLatestConsciousResponse: (): ConsciousModeStructuredResponse | null => null,
    clearConsciousModeThread: () => {},
    getFormattedContext: (): string => '',
    getConsciousEvidenceContext: (): string => '',
    getConsciousSemanticContext: (): string => '',
    getConsciousLongMemoryContext: (): string => '',
    getLatestQuestionReaction: (): QuestionReaction | null => null,
    getLatestAnswerHypothesis: (): AnswerHypothesis | null => null,
    recordConsciousResponse: (): void => {},
  };
  return session;
}

test('ConsciousOrchestrator.planTurn returns legacy plan when human-like flag is off', () => {
  setOptimizationFlagsForTesting({ useHumanLikeConsciousMode: false });
  const orchestrator = new ConsciousOrchestrator(createSession());
  const plan = orchestrator.planTurn('Hi there');
  assert.equal(plan.conversationKind, 'technical');
  assert.equal(plan.responseShape, 'structured');
  assert.equal(plan.verificationLevel, 'strict');
  assert.equal(plan.shouldBypassConscious, false);
});

test('ConsciousOrchestrator.planTurn classifies smalltalk when human-like flag is on', () => {
  setOptimizationFlagsForTesting({ useHumanLikeConsciousMode: true });
  const orchestrator = new ConsciousOrchestrator(createSession());
  const plan = orchestrator.planTurn('Hi there');
  assert.equal(plan.conversationKind, 'smalltalk');
  assert.equal(plan.shouldBypassConscious, true);
  assert.equal(plan.verification.runJudge, false);
});

test('ConsciousOrchestrator.planTurn detects refinement intent', () => {
  setOptimizationFlagsForTesting({ useHumanLikeConsciousMode: true });
  const orchestrator = new ConsciousOrchestrator(createSession());
  const plan = orchestrator.planTurn('Make it shorter please');
  assert.equal(plan.conversationKind, 'refinement');
  assert.equal(plan.refinementIntent, 'shorten');
  assert.equal(plan.verification.runProvenance, false);
});

test('ConsciousOrchestrator.planTurn keeps strict verification for technical questions', () => {
  setOptimizationFlagsForTesting({ useHumanLikeConsciousMode: true });
  const orchestrator = new ConsciousOrchestrator(createSession());
  const plan = orchestrator.planTurn('How would you design a distributed rate limiter at 1M QPS?');
  assert.equal(plan.conversationKind, 'technical');
  assert.equal(plan.verificationLevel, 'strict');
  assert.equal(plan.verification.runProvenance, true);
  assert.equal(plan.verification.runJudge, true);
});

test('ConsciousOrchestrator.buildRefinementPrompt returns null when refinement flag off', () => {
  setOptimizationFlagsForTesting({
    useHumanLikeConsciousMode: true,
    useConsciousRefinement: false,
  });
  const orchestrator = new ConsciousOrchestrator(createSession());
  const plan = orchestrator.planTurn('Make it shorter please');
  const prompt = orchestrator.buildRefinementPrompt({
    plan,
    previousAnswer: 'Long previous answer that exceeds the 80 char threshold to be considered a useful target for shortening, definitely.',
    userRefinementRequest: 'make it shorter',
  });
  assert.equal(prompt, null);
});

test('ConsciousOrchestrator.buildRefinementPrompt returns a prompt when both flags on', () => {
  setOptimizationFlagsForTesting({
    useHumanLikeConsciousMode: true,
    useConsciousRefinement: true,
  });
  const orchestrator = new ConsciousOrchestrator(createSession());
  const plan = orchestrator.planTurn('Make it shorter please');
  const prompt = orchestrator.buildRefinementPrompt({
    plan,
    previousAnswer: 'I built a caching layer on top of Postgres so reads do not hit the primary directly under load.',
    lastInterviewerQuestion: 'How would you reduce latency?',
    userRefinementRequest: 'make it shorter',
  });
  assert.ok(prompt, 'prompt should be non-null');
  assert.match(prompt!.userMessage, /REFINEMENT_INTENT: shorten/);
  assert.match(prompt!.userMessage, /caching layer/);
});

test('ConsciousOrchestrator.buildRefinementPrompt skips no-op refinements', () => {
  setOptimizationFlagsForTesting({
    useHumanLikeConsciousMode: true,
    useConsciousRefinement: true,
  });
  const orchestrator = new ConsciousOrchestrator(createSession());
  const plan = orchestrator.planTurn('Make it shorter please');
  const prompt = orchestrator.buildRefinementPrompt({
    plan,
    previousAnswer: 'Short.',
    userRefinementRequest: 'make it shorter',
  });
  // Already short — refinement is a no-op.
  assert.equal(prompt, null);
});

test('ConsciousOrchestrator.buildRefinementPrompt rejects non-refinement turns', () => {
  setOptimizationFlagsForTesting({
    useHumanLikeConsciousMode: true,
    useConsciousRefinement: true,
  });
  const orchestrator = new ConsciousOrchestrator(createSession());
  const plan = orchestrator.planTurn('How would you design a rate limiter?');
  const prompt = orchestrator.buildRefinementPrompt({
    plan,
    previousAnswer: 'Some previous answer that is long enough to be useful for refinement scenarios in tests.',
    userRefinementRequest: 'make it shorter',
  });
  // Not a refinement turn — buildRefinementPrompt must refuse.
  assert.equal(prompt, null);
});
