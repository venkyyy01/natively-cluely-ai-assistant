// electron/tests/intelligenceEngineConscious.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { LLMHelper } from '../LLMHelper';

test('IntelligenceEngine Conscious Integration - should have fallback executor', () => {
  const mockLLMHelper = {
    getProvider: () => 'openai',
  } as unknown as LLMHelper;
  
  const session = new SessionTracker();
  const engine = new IntelligenceEngine(mockLLMHelper, session);
  
  assert.ok(engine.getFallbackExecutor());
});

test('IntelligenceEngine Conscious Integration - should detect phase from transcript', () => {
  const mockLLMHelper = {
    getProvider: () => 'openai',
  } as unknown as LLMHelper;
  
  const session = new SessionTracker();
  const engine = new IntelligenceEngine(mockLLMHelper, session);
  
  session.setConsciousModeEnabled(true);
  const phase = session.detectPhaseFromTranscript('Can I clarify the requirements?');
  assert.equal(phase, 'requirements_gathering');
});
