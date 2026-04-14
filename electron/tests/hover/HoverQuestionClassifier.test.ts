import * as assert from 'assert';
import { describe, it, beforeEach } from 'node:test';
import { HoverQuestionClassifier } from '../../hover/HoverQuestionClassifier';

class MockLLMHelper {
  async generateFromImage(_imagePath: string, _prompt: string, _options?: any): Promise<string> {
    return JSON.stringify({
      questionType: 'coding',
      detectedLanguage: 'python',
      questionText: 'Write a function to reverse a string',
      confidence: 0.95,
    });
  }
}

describe('HoverQuestionClassifier', () => {
  let classifier: HoverQuestionClassifier;
  let mockLLMHelper: MockLLMHelper;

  beforeEach(() => {
    mockLLMHelper = new MockLLMHelper();
    classifier = new HoverQuestionClassifier(mockLLMHelper as any);
  });

  it('should detect Python from text', () => {
    const text = 'import numpy as np\ndef process_data(df):';
    const language = classifier.detectLanguageFromText(text);
    assert.strictEqual(language, 'python');
  });

  it('should detect JavaScript from text', () => {
    const text = 'const result = await fetch(url);';
    const language = classifier.detectLanguageFromText(text);
    assert.strictEqual(language, 'javascript');
  });

  it('should detect TypeScript from text', () => {
    const text = 'interface User { name: string; age: number; }';
    const language = classifier.detectLanguageFromText(text);
    assert.strictEqual(language, 'typescript');
  });

  it('should detect Java from text', () => {
    const text = 'public class Main { public static void main(String[] args) {} }';
    const language = classifier.detectLanguageFromText(text);
    assert.strictEqual(language, 'java');
  });

  it('should detect Go from text', () => {
    const text = 'func main() { fmt.Println("Hello") }';
    const language = classifier.detectLanguageFromText(text);
    assert.strictEqual(language, 'go');
  });

  it('should detect Rust from text', () => {
    const text = 'fn main() { let mut x = 5; }';
    const language = classifier.detectLanguageFromText(text);
    assert.strictEqual(language, 'rust');
  });

  it('should return undefined for unknown language', () => {
    const text = 'this is just plain text with no code';
    const language = classifier.detectLanguageFromText(text);
    assert.strictEqual(language, undefined);
  });

  it('should detect MCQ indicators', () => {
    const text = 'A) First option\nB) Second option\nC) Third option';
    assert.strictEqual(classifier.hasMCQIndicators(text), true);
  });

  it('should not detect MCQ indicators in regular text', () => {
    const text = 'This is a regular paragraph without options.';
    assert.strictEqual(classifier.hasMCQIndicators(text), false);
  });

  it('should detect subjective question indicators', () => {
    const text = 'Explain the difference between microservices and monoliths.';
    assert.strictEqual(classifier.hasSubjectiveIndicators(text), true);
  });

  it('should detect why questions as subjective', () => {
    const text = 'Why is the sky blue?';
    assert.strictEqual(classifier.hasSubjectiveIndicators(text), true);
  });

  it('should not detect subjective indicators in code', () => {
    const text = 'function calculateSum(a, b) { return a + b; }';
    assert.strictEqual(classifier.hasSubjectiveIndicators(text), false);
  });

  it('should classify with LLM', async () => {
    const mockCapture = {
      id: 'test-id',
      path: '/tmp/test-image.png',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      cursorPosition: { x: 200, y: 150, screenId: 0, timestamp: Date.now() },
      timestamp: Date.now(),
    };

    const result = await classifier.classify(mockCapture);
    
    assert.strictEqual(result.questionType, 'coding');
    assert.strictEqual(result.detectedLanguage, 'python');
    assert.ok(result.confidence > 0);
  });
});
