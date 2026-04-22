import test from 'node:test';
import assert from 'node:assert/strict';

import { ConsciousPreparationCoordinator } from '../conscious/ConsciousPreparationCoordinator';

function createSessionStub() {
  return {
    isConsciousModeEnabled: () => true,
    isLikelyGeneralIntent: () => false,
    getAssistantResponseHistory: (): any[] => [],
    getConsciousEvidenceContext: () => '',
    getConsciousLongMemoryContext: () => '',
    setConsciousSemanticContext: () => {},
    getFormattedContext: () => '',
    getActiveReasoningThread: (): any => null,
    getLatestConsciousResponse: (): any => null,
    getLatestQuestionReaction: (): any => null,
    getLatestAnswerHypothesis: (): any => null,
    getConsciousResponsePreferenceContext: () => '',
    getConsciousResponsePreferenceSummary: (): any => ({
      questionMode: 'live_coding',
      directives: [] as string[],
      relevantFrameworkHints: [] as string[],
      preferConcise: false,
      preferFirstPerson: false,
      preferConversational: false,
      preferIndianEnglish: false,
      preferPlainLanguage: false,
      avoidRoboticTone: false,
      updatedAt: Date.now(),
    }),
  };
}

function createCoordinatorWithTinyBudget() {
  const session = createSessionStub();
  const coordinator = new ConsciousPreparationCoordinator(
    session as any,
    {
      prepareRoute: () => ({ preRouteDecision: { qualifies: true } }),
    } as any,
    {
      compose: (input: any) => ({
        contextItems: input.contextItems,
        preparedTranscript: input.evidenceContextBlock,
        temporalContext: {
          current: '',
          priorQuestions: [] as string[],
          priorAnswers: [] as string[],
          phasesSeen: [] as string[],
        },
      }),
    } as any,
    {
      resolve: async () => ({
        intentResult: {
          intent: 'coding',
          confidence: 0.95,
          answerShape: 'Provide a concrete implementation answer.',
        },
        totalContextAssemblyMs: 0,
        timedOut: false,
      }),
    } as any,
    {
      count: (text: string) => text.length,
    } as any,
    {
      getProvider: () => 'openai',
    } as any,
  );

  return coordinator;
}

test('ConsciousPreparationCoordinator keeps conscious plan block structurally intact when trimming evidence', async () => {
  const coordinator = createCoordinatorWithTinyBudget();

  const result = await coordinator.prepareReasoningContext({
    resolvedQuestion: 'Write a retry helper in TypeScript',
    contextItems: [
      {
        role: 'interviewer',
        text: 'Please write robust retry logic with jitter and cancellation support.',
        timestamp: Date.now(),
      },
    ],
    lastInterim: null,
    lastInterviewerTurn: 'Write a retry helper in TypeScript',
    useConsciousAcceleration: false,
    getAssembledContext: async () => ({ contextItems: [] }),
    getConsciousRelevantContext: async () => [],
    tokenBudget: 200,
    transcriptTurnLimit: 6,
    temporalWindowSeconds: 120,
    profileData: null,
    hardBudgetMs: 500,
    contextAssemblyStart: Date.now(),
    classifyIntent: async () => ({
      intent: 'coding',
      confidence: 0.9,
      answerShape: 'Provide a concrete implementation answer.',
    }),
    prefetchedIntent: {
      intent: 'coding',
      confidence: 0.9,
      answerShape: 'Provide a concrete implementation answer.',
    } as any,
  });

  const transcript = result.preparedTranscript;
  assert.match(transcript, /<conscious_answer_plan>/);
  assert.match(transcript, /<\/conscious_answer_plan>/);
});
