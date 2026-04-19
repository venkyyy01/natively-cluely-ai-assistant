import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousOrchestrator } from '../conscious/ConsciousOrchestrator';
import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';
import type { AnswerHypothesis } from '../conscious/AnswerHypothesisStore';
import type { QuestionReaction } from '../conscious/QuestionReactionClassifier';
import type { IntentResult } from '../llm/IntentClassifier';

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

function createThread(): ReasoningThread {
  return {
    rootQuestion: 'How would you design a rate limiter?',
    lastQuestion: 'How would you design a rate limiter?',
    response,
    followUpCount: 1,
    updatedAt: Date.now(),
  };
}

function createSession(overrides?: {
  latestReaction?: QuestionReaction | null;
  activeThread?: ReasoningThread | null;
}) {
  let cleared = false;
  const session = {
    isConsciousModeEnabled: (): boolean => true,
    getActiveReasoningThread: (): ReasoningThread | null => {
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'activeThread')) {
        return overrides.activeThread ?? null;
      }

      return createThread();
    },
    getLatestConsciousResponse: (): ConsciousModeStructuredResponse | null => null,
    clearConsciousModeThread: () => {
      cleared = true;
    },
    getFormattedContext: (): string => '',
    getConsciousEvidenceContext: (): string => '',
    getConsciousSemanticContext: (): string => '',
    getConsciousLongMemoryContext: (): string => '',
    getLatestQuestionReaction: (): QuestionReaction | null => {
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'latestReaction')) {
        return overrides.latestReaction ?? null;
      }

      return reaction;
    },
    getLatestAnswerHypothesis: (): AnswerHypothesis | null => null,
    recordConsciousResponse: (): void => {},
  };

  return {
    session,
    wasCleared: () => cleared,
  };
}

test('ConsciousOrchestrator.prepareRoute is side-effect free for reset decisions', () => {
  const { session, wasCleared } = createSession();

  const orchestrator = new ConsciousOrchestrator(session as any);
  const prepared = orchestrator.prepareRoute({
    question: 'Let us switch gears and talk about the launch plan.',
    knowledgeStatus: null,
    screenshotBackedLiveCodingTurn: false,
  });

  assert.equal(prepared.preRouteDecision.threadAction, 'reset');
  assert.equal(wasCleared(), false);

  orchestrator.applyRouteSideEffects(prepared);
  assert.equal(wasCleared(), true);
});

test('ConsciousOrchestrator.prepareRoute resets when classifier continuation is topically incompatible', () => {
  const { session } = createSession({
    latestReaction: {
      kind: 'generic_follow_up',
      confidence: 0.7,
      cues: ['active_thread_follow_up'],
      targetFacets: [],
      shouldContinueThread: true,
    },
  });

  const orchestrator = new ConsciousOrchestrator(session as any);
  const prepared = orchestrator.prepareRoute({
    question: 'Can you explain payroll compliance controls?',
    knowledgeStatus: null,
    screenshotBackedLiveCodingTurn: false,
  });

  assert.equal(prepared.preRouteDecision.threadAction, 'reset');
});

test('ConsciousOrchestrator.prepareRoute preserves referential continuation for short follow-ups', () => {
  const { session } = createSession({ latestReaction: null });

  const orchestrator = new ConsciousOrchestrator(session as any);
  const prepared = orchestrator.prepareRoute({
    question: 'Would that still hold?',
    knowledgeStatus: null,
    screenshotBackedLiveCodingTurn: false,
  });

  assert.equal(prepared.preRouteDecision.threadAction, 'continue');
});

test('ConsciousOrchestrator.prepareRoute can promote prefetched inferred intents into the conscious route', () => {
  const { session } = createSession({ latestReaction: null, activeThread: null });
  const orchestrator = new ConsciousOrchestrator(session as any);
  const prefetchedIntent: IntentResult = {
    intent: 'behavioral',
    confidence: 0.94,
    answerShape: 'Tell one grounded story.',
  };

  const prepared = orchestrator.prepareRoute({
    question: 'I want to understand how you handled a difficult stakeholder on a launch.',
    knowledgeStatus: null,
    screenshotBackedLiveCodingTurn: false,
    prefetchedIntent,
  });

  assert.equal(prepared.preRouteDecision.qualifies, true);
  assert.equal(prepared.preRouteDecision.threadAction, 'start');
  assert.equal(prepared.selectedRoute, 'conscious_answer');
});

test('ConsciousOrchestrator.prepareRoute downgrades fresh conscious routing on weak general prefetched intent', () => {
  const { session } = createSession({ latestReaction: null, activeThread: null });
  const orchestrator = new ConsciousOrchestrator(session as any);

  const prepared = orchestrator.prepareRoute({
    question: 'How would you partition the write path across tenants?',
    knowledgeStatus: null,
    screenshotBackedLiveCodingTurn: false,
    prefetchedIntent: {
      intent: 'general',
      confidence: 0.41,
      answerShape: 'Respond naturally.',
    },
  });

  assert.equal(prepared.selectedRoute, 'fast_standard_answer');
  assert.equal(prepared.effectiveRoute, 'fast_standard_answer');
});

test('ConsciousOrchestrator.prepareRoute promotes strong deep-dive prefetched intent into the conscious route', () => {
  const { session } = createSession({ latestReaction: null, activeThread: null });
  const orchestrator = new ConsciousOrchestrator(session as any);

  const prepared = orchestrator.prepareRoute({
    question: 'What tradeoffs matter most here?',
    knowledgeStatus: null,
    screenshotBackedLiveCodingTurn: false,
    prefetchedIntent: {
      intent: 'deep_dive',
      confidence: 0.93,
      answerShape: 'Explain the core tradeoffs.',
    },
  });

  assert.equal(prepared.preRouteDecision.qualifies, true);
  assert.equal(prepared.preRouteDecision.threadAction, 'start');
  assert.equal(prepared.selectedRoute, 'conscious_answer');
});
