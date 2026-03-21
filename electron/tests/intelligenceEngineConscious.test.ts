// electron/tests/intelligenceEngineConscious.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { LLMHelper } from '../LLMHelper';

// Mock LLMHelper
vi.mock('../LLMHelper', () => ({
  LLMHelper: vi.fn().mockImplementation(() => ({
    getProvider: () => 'openai',
  })),
}));

describe('IntelligenceEngine Conscious Integration', () => {
  let engine: IntelligenceEngine;
  let session: SessionTracker;

  beforeEach(() => {
    const mockLLMHelper = new LLMHelper({} as any, {} as any);
    session = new SessionTracker();
    engine = new IntelligenceEngine(mockLLMHelper, session);
  });

  it('should have fallback executor', () => {
    expect(engine.getFallbackExecutor()).toBeDefined();
  });

  it('should detect phase from transcript', () => {
    session.setConsciousModeEnabled(true);
    const phase = session.detectPhaseFromTranscript('Can I clarify the requirements?');
    expect(phase).toBe('requirements_gathering');
  });
});
