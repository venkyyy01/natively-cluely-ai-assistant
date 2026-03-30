import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LLMHelper } from '../LLMHelper';
import { validateResponseQuality } from '../llm/postProcessor';

describe('LLM Integration Tests', () => {
  test('generateSuggestion produces brief responses with validation enabled', async () => {
    // Set environment variable for validation
    process.env.ENFORCE_RESPONSE_VALIDATION = 'true';
    
    const llmHelper = new LLMHelper();
    
    // Mock a realistic interview scenario
    const mockContext = "INTERVIEW CONTEXT:\n" +
      "Interviewer: Tell me about a time you faced a difficult challenge at work.\n" +
      "Candidate: Well, there was this project where...";
    
    const lastQuestion = "Tell me about a time you faced a difficult challenge at work.";
    
    try {
      const suggestion = await llmHelper.generateSuggestion(mockContext, lastQuestion);
      
      // Validate the response meets our criteria
      const validation = validateResponseQuality(suggestion);
      
      // Assert validation passes
      assert.strictEqual(validation.isValid, true, 
        `Validation failed: ${validation.violations.join(', ')}`);
      
      // Assert specific quality metrics
      assert.ok(validation.metrics.maxWordsPerSentence <= 15, 
        `Sentences too long: max ${validation.metrics.maxWordsPerSentence} words (limit 15)`);
      
      assert.ok(validation.metrics.sentenceCount <= 2, 
        `Too many sentences: ${validation.metrics.sentenceCount} (max 2)`);
      
      assert.ok(validation.metrics.estimatedSpeakingTime <= 10, 
        `Speaking time too long: ${validation.metrics.estimatedSpeakingTime}s (max 10s)`);
      
      // Log success metrics
      console.log(`✓ Response validated: ${validation.metrics.sentenceCount} sentences`);
      console.log(`✓ Speaking time: ~${validation.metrics.estimatedSpeakingTime}s`);
      
    } catch (error) {
      console.error('Integration test failed:', error);
      throw error;
    } finally {
      // Clean up environment variable
      delete process.env.ENFORCE_RESPONSE_VALIDATION;
    }
  });

  test('validation catches verbose responses and provides feedback', async () => {
    // Test cases that should fail validation
    const verboseResponses = [
      // Too many words per sentence
      "That's an excellent question that really gets to the heart of problem-solving in professional environments and I think it's important to consider multiple perspectives.",
      
      // Too many sentences  
      "Consider the STAR method. Start with situation context. Then describe the task. Follow with your action. End with results.",
      
      // AI-speak (if detected by our validation)
      "I'd be happy to help you with this important question about fascinating topics."
    ];

    for (const response of verboseResponses) {
      const validation = validateResponseQuality(response);
      
      assert.strictEqual(validation.isValid, false, 
        `Should have failed validation: "${response}"`);
      
      assert.ok(validation.violations.length > 0, 
        'Should have specific validation violations');
      
      console.log(`✓ Correctly caught invalid response: ${validation.violations.join(', ')}`);
    }
  });

  test('validation passes brief, direct responses', async () => {
    // Test cases that should pass validation
    const goodResponses = [
      "Use the STAR method.",
      "Focus on specific results.",
      "Mention leadership skills.",
      "Quantify impact with numbers."
    ];

    for (const response of goodResponses) {
      const validation = validateResponseQuality(response);
      
      assert.strictEqual(validation.isValid, true, 
        `Should have passed validation: "${response}" - ${validation.violations.join(', ')}`);
      
      console.log(`✓ Correctly validated good response: ${validation.metrics.sentenceCount} sentences`);
    }
  });

  test('system works without validation when env var disabled', async () => {
    // Ensure validation is disabled
    delete process.env.ENFORCE_RESPONSE_VALIDATION;
    
    const llmHelper = new LLMHelper();
    const mockContext = "INTERVIEW CONTEXT:\nInterviewer: How would you implement a cache?\nCandidate: I would use Redis...";
    const lastQuestion = "How would you implement a cache?";
    
    try {
      const suggestion = await llmHelper.generateSuggestion(mockContext, lastQuestion);
      
      // Should get a response (validation disabled, so length doesn't matter)
      assert.ok(typeof suggestion === 'string', 'Should return a string response');
      assert.ok(suggestion.length > 0, 'Response should not be empty');
      
      console.log('✓ System works with validation disabled');
      
    } catch (error) {
      console.error('Test failed with validation disabled:', error);
      throw error;
    }
  });

  test('MIT Pyramid structure is enforced in prompts', async () => {
    // This test verifies our prompt enhancements are working
    // by checking that responses follow Answer-Evidence-Stop pattern
    
    process.env.ENFORCE_RESPONSE_VALIDATION = 'true';
    const llmHelper = new LLMHelper();
    const mockContext = "INTERVIEW CONTEXT:\nInterviewer: What is your greatest strength?\nCandidate: I think my greatest strength is...";
    const lastQuestion = "What is your greatest strength?";
    
    try {
      const suggestion = await llmHelper.generateSuggestion(mockContext, lastQuestion);
      
      const validation = validateResponseQuality(suggestion);
      
      // Should pass validation (brief, direct)
      assert.strictEqual(validation.isValid, true, 
        `MIT Pyramid validation failed: ${validation.violations.join(', ')}`);
      
      // Should not start with hedging language
      const startsWithHedging = /^(I think|I believe|Perhaps|Maybe|It seems)/i.test(suggestion.trim());
      assert.strictEqual(startsWithHedging, false, 'Should not start with hedging language');
      
      // Should not contain filler phrases
      const fillerPhrases = ['I hope this helps', 'Does this make sense', 'Let me know if'];
      const containsFiller = fillerPhrases.some(phrase => 
        suggestion.toLowerCase().includes(phrase.toLowerCase())
      );
      assert.strictEqual(containsFiller, false, 'Should not contain filler phrases');
      
      console.log('✓ MIT Pyramid structure enforced in response');
      console.log(`✓ Response: "${suggestion}"`);
      
    } catch (error) {
      console.error('MIT Pyramid test failed:', error);
      throw error;
    } finally {
      delete process.env.ENFORCE_RESPONSE_VALIDATION;
    }
  });
});