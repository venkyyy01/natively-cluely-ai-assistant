import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousOrchestrator } from '../conscious/ConsciousOrchestrator';
import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';
import type { AnswerHypothesis } from '../conscious/AnswerHypothesisStore';
import type { QuestionReaction } from '../conscious/QuestionReactionClassifier';

const response: ConsciousModeStructuredResponse = {
  mode: 'reasoning_first',
  openingReasoning: 'Use token buckets.',
  implementationPlan: ['Use Redis'],
  tradeoffs: [],
  edgeCases: [],
  scaleConsiderations: [],
  pushbackResponses: [],
  likelyFollowUps: [],
  codeTransition: '',
};

const reaction: QuestionReaction = {
  kind: 'topic_shift',
  confidence: 0.95,
  cues: ['explicit_topic_shift'],
  targetFacets: [],
  shouldContinueThread: false,
};

test('ConsciousOrchestrator.prepareRoute is side-effect free for reset decisions', () => {
  let cleared = false;
  const session = {
    isConsciousModeEnabled: (): boolean => true,
    getActiveReasoningThread: (): ReasoningThread => ({
      rootQuestion: 'How would you design a rate limiter?',
      lastQuestion: 'How would you design a rate limiter?',
      response,
      followUpCount: 1,
      updatedAt: Date.now(),
    }),
    getLatestConsciousResponse: (): ConsciousModeStructuredResponse | null => null,
    clearConsciousModeThread: () => {
      cleared = true;
    },
    getFormattedContext: (): string => '',
    getConsciousEvidenceContext: (): string => '',
    getLatestQuestionReaction: (): QuestionReaction => reaction,
    getLatestAnswerHypothesis: (): AnswerHypothesis | null => null,
    recordConsciousResponse: (): void => {},
  };

  const orchestrator = new ConsciousOrchestrator(session as any);
  const prepared = orchestrator.prepareRoute({
    question: 'Let us switch gears and talk about the launch plan.',
    knowledgeStatus: null,
    screenshotBackedLiveCodingTurn: false,
  });

  assert.equal(prepared.preRouteDecision.threadAction, 'reset');
  assert.equal(cleared, false);

  orchestrator.applyRouteSideEffects(prepared);
  assert.equal(cleared, true);
});
