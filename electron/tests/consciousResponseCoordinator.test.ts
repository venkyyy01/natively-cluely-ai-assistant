import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousResponseCoordinator } from '../conscious/ConsciousResponseCoordinator';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';

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

  const fullAnswer = coordinator.completeStructuredAnswer({
    requestId,
    questionLabel: 'How would you design a queue?',
    confidence: 0.9,
    fullAnswer: [
      'Opening reasoning: I would separate admission from processing.',
      'Implementation plan:',
      '- Add durable enqueue',
      'Tradeoffs:',
      'Edge cases:',
      'Scale considerations:',
      'Pushback responses:',
      'Likely follow-ups:',
      'Code transition:',
    ].join('\n'),
    structuredResponse: {
      mode: 'reasoning_first',
      openingReasoning: 'I would separate admission from processing.',
      implementationPlan: ['Add durable enqueue'],
      tradeoffs: [],
      edgeCases: [],
      scaleConsiderations: [],
      pushbackResponses: [],
      likelyFollowUps: [],
      codeTransition: '',
    },
  });

  assert.equal(tokens[0], 'Opening reasoning: I would separate admission from processing.');
  assert.ok(tokens.length > 1);
  assert.equal(tokens.join(''), fullAnswer);
  assert.deepEqual(answers, [fullAnswer]);
  assert.deepEqual(sessionMessages, [fullAnswer]);
});
