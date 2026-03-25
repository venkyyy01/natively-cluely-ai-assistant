import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAnswerRoute, isProfileRequiredQuestion, isKnowledgeRequiredQuestion } from '../latency/answerRouteSelector';

test('route selector prefers manual and follow-up routes first', () => {
  assert.equal(selectAnswerRoute({
    explicitManual: true,
    explicitFollowUp: false,
    consciousModeEnabled: true,
    profileModeEnabled: true,
    hasProfile: true,
    hasKnowledgeData: true,
    latestQuestion: 'tell me about yourself',
    activeReasoningThread: null,
  }), 'manual_answer');

  assert.equal(selectAnswerRoute({
    explicitManual: false,
    explicitFollowUp: true,
    consciousModeEnabled: true,
    profileModeEnabled: true,
    hasProfile: true,
    hasKnowledgeData: true,
    latestQuestion: 'tell me about yourself',
    activeReasoningThread: null,
  }), 'follow_up_refinement');
});

test('route selector sends conscious questions to conscious route without intent classification', () => {
  assert.equal(selectAnswerRoute({
    explicitManual: false,
    explicitFollowUp: false,
    consciousModeEnabled: true,
    profileModeEnabled: false,
    hasProfile: false,
    hasKnowledgeData: false,
    latestQuestion: 'How would you design a rate limiter for an API?',
    activeReasoningThread: null,
  }), 'conscious_answer');
});

test('route selector uses conservative profile and knowledge heuristics', () => {
  assert.equal(isProfileRequiredQuestion('What experience do you have with Redis?'), false);
  assert.equal(isProfileRequiredQuestion('What experience do you have with Redis in your previous role?'), true);
  assert.equal(isKnowledgeRequiredQuestion('Why do you want to work here?'), true);
  assert.equal(isKnowledgeRequiredQuestion('How would you design a rate limiter?'), false);
});

test('route selector keeps generic technical questions on fast standard route', () => {
  assert.equal(selectAnswerRoute({
    explicitManual: false,
    explicitFollowUp: false,
    consciousModeEnabled: false,
    profileModeEnabled: true,
    hasProfile: true,
    hasKnowledgeData: true,
    latestQuestion: 'What are the tradeoffs of using Redis here?',
    activeReasoningThread: null,
  }), 'fast_standard_answer');
});
