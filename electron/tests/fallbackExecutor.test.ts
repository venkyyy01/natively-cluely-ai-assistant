// electron/tests/fallbackExecutor.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FallbackExecutor } from '../conscious/FallbackExecutor';
import { InterviewPhase } from '../conscious/types';

describe('FallbackExecutor', () => {
  let executor: FallbackExecutor;

  beforeEach(() => {
    executor = new FallbackExecutor();
  });

  it('should return emergency template for phase', () => {
    const response = executor.getEmergencyResponse('requirements_gathering');
    expect(response).toBeTruthy();
    expect(typeof response).toBe('string');
    expect(response.length).toBeGreaterThan(10);
  });

  it('should have emergency templates for all phases', () => {
    const phases: InterviewPhase[] = [
      'requirements_gathering', 'high_level_design', 'deep_dive',
      'implementation', 'complexity_analysis', 'scaling_discussion',
      'failure_handling', 'behavioral_story', 'wrap_up'
    ];
    
    for (const phase of phases) {
      const response = executor.getEmergencyResponse(phase);
      expect(response).toBeTruthy();
    }
  });

  it('should track failure state', () => {
    executor.recordFailure('full_conscious');
    executor.recordFailure('full_conscious');
    
    const state = executor.getFailureState();
    expect(state.consecutiveFailures).toBe(2);
    expect(state.degradationLevel).toBe('reduced');
  });

  it('should recover on success', () => {
    executor.recordFailure('full_conscious');
    executor.recordFailure('full_conscious');
    executor.recordSuccess();
    
    const state = executor.getFailureState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.degradationLevel).toBe('none');
  });

  it('should get start tier based on degradation level', () => {
    expect(executor.getStartTier()).toBe(0); // none -> tier 0
    
    executor.recordFailure('full_conscious');
    executor.recordFailure('full_conscious');
    expect(executor.getStartTier()).toBe(1); // reduced -> tier 1
    
    executor.recordFailure('reduced_conscious');
    executor.recordFailure('reduced_conscious');
    expect(executor.getStartTier()).toBe(2); // minimal -> tier 2
  });
});
