import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousResponseCoordinator } from '../conscious/ConsciousResponseCoordinator';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';
import { formatConsciousModeResponse } from '../ConsciousMode';

test('ConsciousResponseCoordinator streams verified structured sections progressively', () => {
  const tokens: string[] = [];
  const answers: string[] = [];
  const sessionMessages: string[] = [];
  const tracker = new AnswerLatencyTracker();
  const requestId = tracker.start('conscious_answer', 'streaming');
  const coordinator = new ConsciousResponseCoordinator(
    {
      addAssistantMessage: (answer: string) => {
        sessionMessages.push(answer);
      },
      pushUsage: () => {},
    },
    tracker,
    {
      emit: (event: 'suggested_answer_token' | 'suggested_answer', answer: string) => {
        if (event === 'suggested_answer_token') {
          tokens.push(answer);
        } else {
          answers.push(answer);
        }
        return true;
      },
    },
    () => {},
  );

  const structuredResponse = {
    mode: 'reasoning_first' as const,
    openingReasoning: 'I would separate admission from processing.',
    implementationPlan: ['Add durable enqueue'],
    tradeoffs: [] as string[],
    edgeCases: [] as string[],
    scaleConsiderations: [] as string[],
    pushbackResponses: [] as string[],
    likelyFollowUps: [] as string[],
    codeTransition: '',
  };

  const fullAnswer = formatConsciousModeResponse(structuredResponse);

  const result = coordinator.completeStructuredAnswer({
    requestId,
    questionLabel: 'How would you design a queue?',
    confidence: 0.9,
    fullAnswer,
    structuredResponse,
  });

  assert.equal(tokens[0], 'I would separate admission from processing.');
  assert.ok(tokens.length > 1);
  assert.equal(tokens.join(''), result);
  assert.deepEqual(answers, [result]);
  assert.deepEqual(sessionMessages, [result]);
});