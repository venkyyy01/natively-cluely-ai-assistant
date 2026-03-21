// electron/tests/interviewPhase.test.ts
import { describe, it, expect } from 'vitest';
import { InterviewPhaseDetector } from '../conscious/InterviewPhase';
import { InterviewPhase } from '../conscious/types';

describe('InterviewPhaseDetector', () => {
  const detector = new InterviewPhaseDetector();

  it('should detect requirements_gathering phase', () => {
    const result = detector.detectPhase(
      "Can I assume we have unlimited storage?",
      'high_level_design',
      []
    );
    expect(result.phase).toBe('requirements_gathering');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('should detect implementation phase', () => {
    const result = detector.detectPhase(
      "Let me write the code for this LRU cache",
      'deep_dive',
      []
    );
    expect(result.phase).toBe('implementation');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('should detect behavioral_story phase', () => {
    const result = detector.detectPhase(
      "Tell me about a time you led a challenging project",
      'requirements_gathering',
      []
    );
    expect(result.phase).toBe('behavioral_story');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('should maintain current phase when confidence is low', () => {
    const result = detector.detectPhase(
      "Okay, continue",
      'deep_dive',
      []
    );
    expect(result.phase).toBe('deep_dive');
  });

  it('should detect scaling_discussion from scale keywords', () => {
    const result = detector.detectPhase(
      "How would this scale to a million users?",
      'high_level_design',
      []
    );
    expect(result.phase).toBe('scaling_discussion');
  });
});
