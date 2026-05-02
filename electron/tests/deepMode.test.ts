import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDeepModeQuestion,
  extractClaims,
  createDefaultDeepModeState,
  type Claim,
} from '../conscious/DeepMode';
import { createEmptyConsciousModeResponse } from '../ConsciousMode';

// ── Classification Tests ───────────────────────────────────────────

test('classifyDeepModeQuestion blocks explicit admin prompts', () => {
  assert.strictEqual(classifyDeepModeQuestion('okay'), false);
  assert.strictEqual(classifyDeepModeQuestion('ok'), false);
  assert.strictEqual(classifyDeepModeQuestion('got it'), false);
  assert.strictEqual(classifyDeepModeQuestion('fine'), false);
  assert.strictEqual(classifyDeepModeQuestion('sounds good'), false);
  assert.strictEqual(classifyDeepModeQuestion('repeat that'), false);
  assert.strictEqual(classifyDeepModeQuestion('all set'), false);
});

test('classifyDeepModeQuestion qualifies real technical questions', () => {
  assert.strictEqual(classifyDeepModeQuestion('how would you design a rate limiter?'), true);
  assert.strictEqual(classifyDeepModeQuestion('why sharding?'), true);
  assert.strictEqual(classifyDeepModeQuestion('what approach'), true);
  assert.strictEqual(classifyDeepModeQuestion('tell me about your architecture decisions'), true);
  assert.strictEqual(classifyDeepModeQuestion('what tradeoffs did you consider'), true);
});

test('classifyDeepModeQuestion rejects empty and single-word input', () => {
  assert.strictEqual(classifyDeepModeQuestion(''), false);
  assert.strictEqual(classifyDeepModeQuestion(null), false);
  assert.strictEqual(classifyDeepModeQuestion(undefined), false);
  assert.strictEqual(classifyDeepModeQuestion('hi'), false);
});

// ── Claim Extraction Tests ──────────────────────────────────────────

test('extractClaims returns empty for empty response', () => {
  const response = createEmptyConsciousModeResponse();
  const claims = extractClaims(response);
  assert.strictEqual(claims.length, 0);
});

test('extractClaims extracts openingReasoning as a claim', () => {
  const response = createEmptyConsciousModeResponse();
  response.openingReasoning = 'I would build a caching layer first.';
  const claims = extractClaims(response);
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(claims[0].text, 'I would build a caching layer first.');
  assert.strictEqual(claims[0].field, 'openingReasoning');
});

test('extractClaims extracts claims from implementation plan', () => {
  const response = createEmptyConsciousModeResponse();
  response.implementationPlan = ['Use Redis for caching', 'Add a write-through layer'];
  const claims = extractClaims(response);
  assert.strictEqual(claims.length, 2);
  assert.strictEqual(claims[0].category, 'design');
  assert.strictEqual(claims[1].category, 'design');
});

test('extractClaims tags scaleConsiderations as metric category', () => {
  const response = createEmptyConsciousModeResponse();
  response.scaleConsiderations = ['P99 latency improved from 500ms to 50ms'];
  const claims = extractClaims(response);
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(claims[0].category, 'metric');
});

test('extractClaims tags codeTransition as technology category', () => {
  const response = createEmptyConsciousModeResponse();
  response.codeTransition = 'Here is the code path I would walk through:';
  const claims = extractClaims(response);
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(claims[0].category, 'technology');
});

test('extractClaims extracts behavioral answer claims', () => {
  const response = createEmptyConsciousModeResponse();
  response.behavioralAnswer = {
    question: 'Tell me about a conflict',
    headline: 'I resolved a team disagreement',
    situation: 'Two senior engineers disagreed on the architecture',
    task: 'I needed to mediate and find common ground',
    action: 'I held individual sessions and proposed a hybrid approach',
    result: 'We shipped on time with both engineers satisfied',
    whyThisAnswerWorks: ['Shows leadership', 'Demonstrates conflict resolution'],
  };
  const claims = extractClaims(response);
  assert.strictEqual(claims.length, 4);
  assert.strictEqual(claims[0].category, 'behavioral');
  assert.strictEqual(claims[3].category, 'metric');
});

// ── DeepModeState Tests ─────────────────────────────────────────────

test('createDefaultDeepModeState returns disabled state', () => {
  const state = createDefaultDeepModeState();
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.adaptiveContextBudget, Infinity);
  assert.strictEqual(state.consecutiveCurlFailures, 0);
  assert.strictEqual(state.lastSuccessfulContextSize, 0);
});
