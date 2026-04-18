import test from 'node:test';
import assert from 'node:assert/strict';

test('Conscious Mode modules import in plain node without requiring Electron at module load time', async () => {
  const engineModule = await import('../IntelligenceEngine');
  const intentModule = await import('../llm/IntentClassifier');

  assert.equal(typeof engineModule.IntelligenceEngine, 'function');
  assert.equal(typeof intentModule.classifyIntent, 'function');
});

test('Intent classifier still executes regex routing in plain node tests', async () => {
  const { classifyIntent } = await import('../llm/IntentClassifier');
  const result = await classifyIntent('What happened next?', '[INTERVIEWER] What happened next?', 0);

  assert.equal(result.intent, 'follow_up');
});

test('Intent classifier treats hidden behavioral prompts as behavioral in plain node tests', async () => {
  const { classifyIntent } = await import('../llm/IntentClassifier');
  const result = await classifyIntent('How do you make difficult decisions?', '[INTERVIEWER] How do you make difficult decisions?', 0);

  assert.equal(result.intent, 'behavioral');
});
