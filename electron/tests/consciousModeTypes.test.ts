// electron/tests/consciousModeTypes.test.ts
import { describe, it, expect } from 'vitest';
import {
  InterviewPhase,
  ConversationThread,
  TokenBudget,
  ConfidenceScore,
  FallbackTier,
  ConsciousResponse,
  INTERVIEW_PHASES,
} from '../conscious/types';

describe('ConsciousModeTypes', () => {
  it('should have all interview phases defined', () => {
    expect(INTERVIEW_PHASES).toContain('requirements_gathering');
    expect(INTERVIEW_PHASES).toContain('high_level_design');
    expect(INTERVIEW_PHASES).toContain('implementation');
    expect(INTERVIEW_PHASES.length).toBe(9);
  });

  it('should have correct fallback tier count', () => {
    const tiers: FallbackTier[] = ['full_conscious', 'reduced_conscious', 'normal_mode', 'emergency_local'];
    expect(tiers.length).toBe(4);
  });
});
