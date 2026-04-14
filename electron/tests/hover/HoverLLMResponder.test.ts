import * as assert from 'assert';
import { describe, it, beforeEach } from 'node:test';
import { HoverLLMResponder } from '../../hover/HoverLLMResponder';

class MockLLMHelper {
  private mockResponse: string = '';

  setMockResponse(response: string) {
    this.mockResponse = response;
  }

  async generateFromImage(_imagePath: string, _prompt: string, _options?: any): Promise<string> {
    return this.mockResponse;
  }
}

describe('HoverLLMResponder', () => {
  let responder: HoverLLMResponder;
  let mockLLMHelper: MockLLMHelper;

  const mockCapture = {
    id: 'test-id',
    path: '/tmp/test-image.png',
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    cursorPosition: { x: 200, y: 150, screenId: 0, timestamp: Date.now() },
    timestamp: Date.now(),
  };

  beforeEach(() => {
    mockLLMHelper = new MockLLMHelper();
    responder = new HoverLLMResponder(mockLLMHelper as any);
  });

  it('should generate code response for coding question', async () => {
    mockLLMHelper.setMockResponse('def reverse_string(s):\n    return s[::-1]');

    const analysis = {
      questionType: 'coding' as const,
      detectedLanguage: 'python' as string | undefined,
      confidence: 0.9,
    };

    const response = await responder.generateResponse(mockCapture, analysis);

    assert.strictEqual(response.type, 'code');
    assert.strictEqual(response.language, 'python');
    assert.ok(response.content.includes('def'));
  });

  it('should default to Python if no language detected', async () => {
    mockLLMHelper.setMockResponse('def solution(): pass');

    const analysis = {
      questionType: 'coding' as const,
      detectedLanguage: undefined as string | undefined,
      confidence: 0.7,
    };

    const response = await responder.generateResponse(mockCapture, analysis);

    assert.strictEqual(response.type, 'code');
    assert.strictEqual(response.language, 'python');
  });

  it('should generate MCQ response', async () => {
    mockLLMHelper.setMockResponse(JSON.stringify({
      optionLabel: 'B',
      justification: 'Option B is correct because it handles edge cases properly.',
    }));

    const analysis = {
      questionType: 'mcq' as const,
      confidence: 0.95,
    };

    const response = await responder.generateResponse(mockCapture, analysis);

    assert.strictEqual(response.type, 'mcq');
    assert.strictEqual(response.optionLabel, 'B');
    assert.ok(response.justification?.includes('edge cases'));
  });

  it('should generate subjective response', async () => {
    mockLLMHelper.setMockResponse('Microservices offer better scalability but add operational complexity. Monoliths are simpler to deploy but harder to scale horizontally.');

    const analysis = {
      questionType: 'subjective' as const,
      confidence: 0.85,
    };

    const response = await responder.generateResponse(mockCapture, analysis);

    assert.strictEqual(response.type, 'subjective');
    assert.ok(response.content.length > 0);
  });

  it('should handle unknown question type', async () => {
    mockLLMHelper.setMockResponse('This appears to be a diagram showing system architecture.');

    const analysis = {
      questionType: 'unknown' as const,
      confidence: 0.3,
    };

    const response = await responder.generateResponse(mockCapture, analysis);

    assert.strictEqual(response.type, 'subjective');
    assert.ok(response.content.length > 0);
  });
});
