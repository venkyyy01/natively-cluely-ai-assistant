import test from 'node:test';
import assert from 'node:assert/strict';
import { isCodingQuestion } from '../llm/prompts';
import { parseConsciousModeResponse, isValidThoughtFlowResponse, ThoughtFlowStructuredResponse } from '../ConsciousMode';

test('isCodingQuestion - should detect coding questions', () => {
  const codingQuestions = [
    'Write a function to reverse a string',
    'Implement a binary search algorithm',
    'How would you solve the two sum problem?',
    'Can you code a solution for finding the longest palindrome?',
    'Write code to merge two sorted arrays',
    'Implement a LRU cache',
    'Given an array, find all pairs that sum to target',
    'Write a function that checks if a string is a palindrome',
    'Code a solution to detect a cycle in a linked list',
    'Implement DFS for a graph',
  ];

  for (const question of codingQuestions) {
    assert.strictEqual(
      isCodingQuestion(question),
      true,
      `Failed to detect coding question: ${question}`
    );
  }
});

test('isCodingQuestion - should not detect system design questions as coding', () => {
  const systemDesignQuestions = [
    'Design a URL shortener',
    'How would you design Twitter?',
    'Design a rate limiter',
    'How would you scale a messaging system?',
    'What database would you choose for this system?',
  ];

  for (const question of systemDesignQuestions) {
    assert.strictEqual(
      isCodingQuestion(question),
      false,
      `False positive for system design question: ${question}`
    );
  }
});

test('isCodingQuestion - should not detect behavioral questions as coding', () => {
  const behavioralQuestions = [
    'Tell me about a time you faced a difficult bug',
    'Describe your experience with team collaboration',
    'What is your greatest strength?',
    'Why do you want to work here?',
  ];

  for (const question of behavioralQuestions) {
    assert.strictEqual(
      isCodingQuestion(question),
      false,
      `False positive for behavioral question: ${question}`
    );
  }
});

test('ThoughtFlow parsing - should parse a valid ThoughtFlow response', () => {
  const validThoughtFlowJSON = JSON.stringify({
    clarifyingQuestions: [
      'What is the expected time complexity?',
      'Can I use extra space?',
      'What is the range of input values?',
    ],
    testCases: [
      { input: '[1,2,3]', expectedOutput: '[3,2,1]', category: 'basic' },
      { input: '[]', expectedOutput: '[]', category: 'edge' },
      { input: '[1]', expectedOutput: '[1]', category: 'edge' },
    ],
    walkthrough: '1. Initialize two pointers\n2. Swap elements\n3. Move pointers inward',
    codeBlock: {
      language: 'python',
      code: 'def reverse(arr):\n    left, right = 0, len(arr) - 1\n    while left < right:\n        arr[left], arr[right] = arr[right], arr[left]\n        left += 1\n        right -= 1\n    return arr',
    },
    spokenIntro: 'Let me walk through my approach to reversing an array.',
  });

  const parsed = parseConsciousModeResponse(validThoughtFlowJSON);
  
  assert.strictEqual(parsed.mode, 'thoughtflow');
  
  if (isValidThoughtFlowResponse(parsed)) {
    assert.strictEqual(isValidThoughtFlowResponse(parsed), true);
    assert.strictEqual(parsed.clarifyingQuestions.length, 3);
    assert.strictEqual(parsed.testCases.length, 3);
    assert.ok(parsed.walkthrough.includes('Initialize two pointers'));
    assert.strictEqual(parsed.codeBlock?.language, 'python');
    assert.ok(parsed.spokenIntro.includes('reversing an array'));
  }
});

test('ThoughtFlow parsing - should handle malformed responses gracefully', () => {
  const malformedJSON = JSON.stringify({
    clarifyingQuestions: ['Question 1'],
    // missing testCases, walkthrough, codeBlock
  });

  const parsed = parseConsciousModeResponse(malformedJSON);
  
  // Should either parse as invalid or normalize to valid ThoughtFlow
  assert.ok(parsed.mode === 'invalid' || parsed.mode === 'thoughtflow');
});

test('ThoughtFlow parsing - should distinguish from standard Conscious Mode responses', () => {
  const standardConsciousResponse = JSON.stringify({
    mode: 'reasoning_first',
    openingReasoning: 'Let me think about this system design...',
    implementationPlan: ['Step 1', 'Step 2'],
    tradeoffs: ['We could use SQL or NoSQL...'],
  });

  const parsed = parseConsciousModeResponse(standardConsciousResponse);
  
  assert.strictEqual(parsed.mode, 'reasoning_first');
  
  if (parsed.mode === 'reasoning_first') {
    assert.strictEqual(isValidThoughtFlowResponse(parsed), false);
  }
});

test('ThoughtFlow validation - should validate complete responses', () => {
  const completeResponse: ThoughtFlowStructuredResponse = {
    mode: 'thoughtflow' as const,
    clarifyingQuestions: ['Q1', 'Q2'],
    testCases: [
      { input: 'test', expectedOutput: 'result', category: 'basic' },
    ],
    walkthrough: 'Step-by-step explanation',
    codeBlock: {
      language: 'javascript',
      code: 'function test() {}',
    },
    spokenIntro: 'Introduction',
  };

  assert.strictEqual(isValidThoughtFlowResponse(completeResponse), true);
});

test('ThoughtFlow validation - should reject incomplete responses', () => {
  const incompleteResponse = {
    mode: 'thoughtflow' as const,
    clarifyingQuestions: ['Q1'],
    // missing required fields
  };

  assert.strictEqual(isValidThoughtFlowResponse(incompleteResponse as any), false);
});

test('ThoughtFlow validation - should reject non-ThoughtFlow responses', () => {
  const consciousResponse = {
    mode: 'reasoning_first' as const,
    openingReasoning: 'Reasoning',
    implementationPlan: ['Step 1'],
    tradeoffs: ['Tradeoffs'],
  };

  assert.strictEqual(isValidThoughtFlowResponse(consciousResponse as any), false);
});
