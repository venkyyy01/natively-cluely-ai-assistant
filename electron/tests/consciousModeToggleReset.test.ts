/**
 * NAT-CM-AUDIT — Conscious mode toggle reset
 *
 * Regression: turning conscious mode OFF and then back ON from the overlay
 * UI should reset all conscious state. Previously the OFF path cleared
 * thread/hypothesis stores but missed `_codingProblem`, `phaseDetector`,
 * `tokenBudgetManager`, `adaptiveContextWindow`, response fingerprinter,
 * and the context assembly cache. After the user took a coding screenshot,
 * a subsequent toggle-off-then-on left the coding problem in the session
 * which kept biasing answers toward A/B/C/D structure even on normal Q&A.
 *
 * These tests pin the new behavior:
 *   - OFF→ON wipes `_codingProblem`
 *   - OFF→ON wipes phase detector
 *   - same-state toggle is a no-op
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../SessionTracker';
import { CODING_PROBLEM_SCHEMA_VERSION, type CodingProblem } from '../coding/types';

function sampleCodingProblem(): CodingProblem {
  return {
    schemaVersion: CODING_PROBLEM_SCHEMA_VERSION,
    title: 'Two Sum',
    difficulty: 'easy',
    problemType: 'arrays',
    problemStatement: 'Given an array of integers, return indices of two that sum to target.',
    examples: [
      { input: '[2,7,11,15], target=9', output: '[0,1]', explanation: '2+7=9' },
    ],
    constraints: ['1 <= nums.length <= 10^4'],
    extractedAt: Date.now(),
  };
}

test('toggle off→on wipes the coding problem so the next answer is not biased toward A/B/C/D', () => {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  session.setCodingProblem(sampleCodingProblem());

  assert.ok(session.getCodingProblem(), 'coding problem should be set');

  session.setConsciousModeEnabled(false);
  assert.equal(session.getCodingProblem(), null, 'coding problem must be cleared on toggle off');

  session.setConsciousModeEnabled(true);
  assert.equal(session.getCodingProblem(), null, 'coding problem must remain cleared after toggle on');
});

test('toggle off→on resets the interview phase detector', () => {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  session.setCurrentPhase('scaling_discussion', 'manual');
  assert.equal(session.getCurrentPhase(), 'scaling_discussion');

  session.setConsciousModeEnabled(false);
  // Phase detector reset should bring it back to the initial phase.
  // We don't assert the exact initial phase string (it's owned by
  // InterviewPhaseDetector); we only assert it is no longer the polluted
  // 'scaling_discussion'.
  assert.notEqual(session.getCurrentPhase(), 'scaling_discussion');
});

test('toggle is idempotent — same value is a no-op', () => {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  session.setCodingProblem(sampleCodingProblem());

  // No-op: same value, state must survive.
  session.setConsciousModeEnabled(true);
  assert.ok(session.getCodingProblem(), 'idempotent toggle must not wipe state');
});

test('toggle off→on clears semantic context block', () => {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  session.setConsciousSemanticContext('<conscious_semantic_memory>some pollution</conscious_semantic_memory>');
  assert.ok(session.getConsciousSemanticContext().length > 0);

  session.setConsciousModeEnabled(false);
  assert.equal(session.getConsciousSemanticContext(), '');

  session.setConsciousModeEnabled(true);
  assert.equal(session.getConsciousSemanticContext(), '');
});

test('toggle off→on clears thread, hypothesis, and design state stores', () => {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);

  session.recordConsciousResponse('How would you partition a tenant analytics system?', {
    mode: 'reasoning_first',
    openingReasoning: 'I would shard by tenant id with a control-plane lookup.',
    implementationPlan: ['Hash tenant_id to shard'],
    tradeoffs: ['Cross-tenant queries get more expensive'],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
  }, 'start');

  assert.ok(session.getActiveReasoningThread(), 'thread should be active before toggle');
  assert.ok(session.getLatestAnswerHypothesis(), 'hypothesis should be set before toggle');

  session.setConsciousModeEnabled(false);
  assert.equal(session.getActiveReasoningThread(), null);
  assert.equal(session.getLatestAnswerHypothesis(), null);

  session.setConsciousModeEnabled(true);
  assert.equal(session.getActiveReasoningThread(), null, 'toggle on must not resurrect prior thread');
  assert.equal(session.getLatestAnswerHypothesis(), null, 'toggle on must not resurrect prior hypothesis');
});
