import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { validateResponseQuality } from '../llm/postProcessor';

async function createMockedHelper(responseText: string) {
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: {
          getPath: () => '/tmp',
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  const { LLMHelper } = await import('../LLMHelper');
  const helper = new LLMHelper();
  let capturedPrompt = '';

  (helper as any).client = {};
  (helper as any).generateWithFlash = async (parts: Array<{ text: string }>) => {
    capturedPrompt = parts[0]?.text || '';
    return responseText;
  };
  (helper as any).processResponse = (text: string) => text;

  return {
    helper,
    getPrompt: () => capturedPrompt,
    cleanup: () => {
      helper.scrubKeys();
      (Module as any)._load = originalLoad;
    },
  };
}

afterEach(() => {
  delete process.env.ENFORCE_RESPONSE_VALIDATION;
});

describe('LLM Integration Tests', () => {
  test('generateSuggestion appends validation feedback for verbose responses when validation is enabled', async () => {
    process.env.ENFORCE_RESPONSE_VALIDATION = 'true';
    const mocked = await createMockedHelper("That's an excellent question that really gets to the heart of problem-solving in professional environments and I think it's important to consider multiple perspectives.");

    try {
      const suggestion = await mocked.helper.generateSuggestion(
        'Interviewer: Tell me about a difficult challenge at work.',
        'Tell me about a difficult challenge at work.',
      );

      assert.match(suggestion, /<!-- Validation:/);
      assert.match(mocked.getPrompt(), /Provide a concise, natural response/);
      assert.match(mocked.getPrompt(), /ANSWER DIRECTLY:/);
    } finally {
      mocked.cleanup();
    }
  });

  test('validation catches verbose responses and provides feedback', () => {
    const verboseResponses = [
      "That's an excellent question that really gets to the heart of problem-solving in professional environments and I think it's important to consider multiple perspectives.",
      'Consider the STAR method. Start with situation context. Then describe the task. Follow with your action. End with results.',
      "I'd be happy to help you with this important question about fascinating topics.",
    ];

    for (const response of verboseResponses) {
      const validation = validateResponseQuality(response);
      assert.equal(validation.isValid, false, `Should have failed validation: ${response}`);
      assert.ok(validation.violations.length > 0);
    }
  });

  test('validation passes brief, direct responses', () => {
    const goodResponses = [
      'Use the STAR method.',
      'Focus on specific results.',
      'Mention leadership skills.',
      'Quantify impact with numbers.',
    ];

    for (const response of goodResponses) {
      const validation = validateResponseQuality(response);
      assert.equal(validation.isValid, true, `Should have passed validation: ${response}`);
    }
  });

  test('generateSuggestion returns the raw response when validation is disabled', async () => {
    const mocked = await createMockedHelper('This answer can be longer because validation is disabled. It still returns exactly what the model produced.');

    try {
      const suggestion = await mocked.helper.generateSuggestion(
        'Interviewer: How would you implement a cache?',
        'How would you implement a cache?',
      );

      assert.equal(
        suggestion,
        'This answer can be longer because validation is disabled. It still returns exactly what the model produced.',
      );
    } finally {
      mocked.cleanup();
    }
  });

  test('generateSuggestion prompt keeps the direct-answer contract', async () => {
    process.env.ENFORCE_RESPONSE_VALIDATION = 'true';
    const mocked = await createMockedHelper('Lead with your strongest example.');

    try {
      const suggestion = await mocked.helper.generateSuggestion(
        'Interviewer: What is your greatest strength?',
        'What is your greatest strength?',
      );

      assert.equal(suggestion, 'Lead with your strongest example.');
      assert.match(mocked.getPrompt(), /Do NOT preface with "You could say"/);
      assert.match(mocked.getPrompt(), /Never hedge\. Never say "it depends"\./);
      assert.doesNotMatch(suggestion, /^(I think|I believe|Perhaps|Maybe|It seems)/i);
    } finally {
      mocked.cleanup();
    }
  });
});
