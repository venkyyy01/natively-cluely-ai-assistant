// electron/tests/fallbackExecutor.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { FallbackExecutor } from '../conscious/FallbackExecutor';
import { InterviewPhase } from '../conscious/types';

test('FallbackExecutor - should return emergency template for phase', () => {
  const executor = new FallbackExecutor();
  const response = executor.getEmergencyResponse('requirements_gathering');
  assert.ok(response);
  assert.equal(typeof response, 'string');
  assert.ok(response.length > 10);
});

test('FallbackExecutor - should have emergency templates for all phases', () => {
  const executor = new FallbackExecutor();
  const phases: InterviewPhase[] = [
    'requirements_gathering', 'high_level_design', 'deep_dive',
    'implementation', 'complexity_analysis', 'scaling_discussion',
    'failure_handling', 'behavioral_story', 'wrap_up'
  ];
  
  for (const phase of phases) {
    const response = executor.getEmergencyResponse(phase);
    assert.ok(response);
  }
});

test('FallbackExecutor - should track failure state', () => {
  const executor = new FallbackExecutor();
  executor.recordFailure('full_conscious');
  executor.recordFailure('full_conscious');
  
  const state = executor.getFailureState();
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(state.degradationLevel, 'reduced');
});

test('FallbackExecutor - should recover on success', () => {
  const executor = new FallbackExecutor();
  executor.recordFailure('full_conscious');
  executor.recordFailure('full_conscious');
  executor.recordSuccess();
  
  const state = executor.getFailureState();
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.degradationLevel, 'none');
});

test('FallbackExecutor - should get start tier based on degradation level', () => {
  const executor = new FallbackExecutor();
  assert.equal(executor.getStartTier(), 0); // none -> tier 0
  
  executor.recordFailure('full_conscious');
  executor.recordFailure('full_conscious');
  assert.equal(executor.getStartTier(), 1); // reduced -> tier 1
  
  executor.recordFailure('reduced_conscious');
  executor.recordFailure('reduced_conscious');
  assert.equal(executor.getStartTier(), 2); // minimal -> tier 2
});

test('FallbackExecutor - does not auto-recover on cooldown alone without a full conscious success', () => {
  const executor = new FallbackExecutor();
  executor.recordFailure('full_conscious');
  executor.recordFailure('full_conscious');
  (executor as any).failureState.lastFailureTime = Date.now() - 301_000;

  const recovered = executor.checkAutoRecovery();

  assert.equal(recovered, false);
  assert.equal(executor.getFailureState().degradationLevel, 'reduced');
});

test('FallbackExecutor - auto-recovery requires a successful full conscious probe after failures', () => {
  const executor = new FallbackExecutor();
  executor.recordFailure('full_conscious');
  executor.recordFailure('full_conscious');
  executor.recordFailure('reduced_conscious');
  executor.recordFailure('reduced_conscious');
  executor.recordSuccess('full_conscious');
  (executor as any).failureState.lastFailureTime = Date.now() - 301_000;

  const recovered = executor.checkAutoRecovery();

  assert.equal(recovered, true);
  assert.equal(executor.getFailureState().degradationLevel, 'none');
  assert.equal(executor.getFailureState().consecutiveFailures, 0);
});
