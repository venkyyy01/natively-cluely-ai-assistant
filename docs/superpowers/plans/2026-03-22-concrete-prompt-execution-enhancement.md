# Concrete Prompt Execution Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance LLM response quality with concrete examples and runtime validation while preserving existing prompt structure.

**Architecture:** Dual-layer approach with enhanced prompts (training) and post-processing validation (enforcement) integrated into existing LLMHelper pipeline.

**Tech Stack:** TypeScript, existing LLMHelper.ts, postProcessor.ts

---

## File Structure

**Files to Modify:**
- `electron/llm/prompts.ts` - Add concrete examples after rule sections
- `electron/llm/postProcessor.ts` - Add validation functions 
- `electron/llm/LLMHelper.ts` - Integrate validation into response pipeline

**Files to Create:**
- `electron/llm/types.ts` - ValidationResult interface (if not exists)
- `electron/tests/llm-validation.test.ts` - Validation logic tests

---

### Task 1: Add Validation Types

**Files:**
- Check: `electron/llm/types.ts`
- Create if missing: `electron/llm/types.ts`

- [ ] **Step 1: Check if types file exists**

Run: `ls electron/llm/types.ts`
Expected: Either file exists or "No such file"

- [ ] **Step 2: Add validation interface**

Add to existing or create new types.ts:
```typescript
export interface ValidationResult {
  isValid: boolean;
  violations: string[];
  regenerationHint?: string;
  metrics: {
    sentenceCount: number;
    maxWordsPerSentence: number;
    estimatedSpeakingTime: number;
  };
}

export interface ResponseQuality {
  followsPyramid: boolean;
  hasAiSpeak: string[];
  isWithinLimits: boolean;
}
```

- [ ] **Step 3: Commit types**

```bash
git add electron/llm/types.ts
git commit -m "feat: add validation types for response quality"
```

### Task 2: Enhance Prompts with Concrete Examples

**Files:**
- Modify: `electron/llm/prompts.ts:172` (after human_answer_constraints)

- [ ] **Step 1: Add execution examples block**

Add after line 171 in prompts.ts (before </human_answer_constraints>):
```typescript
<execution_examples>
**MIT PYRAMID EXAMPLES**:
✓ Good: "React uses virtual DOM for performance. This reduces actual DOM manipulations."
✗ Bad: "React is a JavaScript library that was created by Facebook and uses something called a virtual DOM which is essentially an abstraction..."

✓ Good: "I'd use Redis for caching. It handles high-throughput scenarios well."  
✗ Bad: "For caching, I would probably recommend Redis because it's an in-memory data structure store that can be used as..."

**EVIDENCE EXAMPLES**:
✓ Good: "GraphQL reduces over-fetching. We used it at my last company for mobile APIs."
✗ Bad: "GraphQL is really great because it solves a lot of problems with REST APIs like over-fetching and under-fetching, and it gives you this really powerful query language..."

**WORD LIMIT EXAMPLES**:
✓ Good (18 words): "Microservices improve scalability but increase complexity. I'd recommend starting monolithic then splitting strategically."
✗ Bad (35 words): "Microservices are an architectural pattern that can improve scalability and allow teams to work independently, but they also introduce operational complexity and distributed system challenges that you need to consider."
</execution_examples>
```

- [ ] **Step 2: Run syntax check**

Run: `npm run type-check` or equivalent
Expected: No TypeScript errors

- [ ] **Step 3: Commit prompt examples**

```bash
git add electron/llm/prompts.ts
git commit -m "feat: add concrete execution examples to prompts"
```

### Task 3: Write Validation Tests

**Files:**
- Create: `electron/tests/llm-validation.test.ts`

- [ ] **Step 1: Write failing validation tests**

```typescript
import { validateResponseQuality } from '../../electron/llm/postProcessor';

describe('Response Validation', () => {
  test('should pass valid short response', () => {
    const response = "React uses virtual DOM. This improves performance.";
    const result = validateResponseQuality(response);
    expect(result.isValid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test('should fail on too many sentences', () => {
    const response = "First sentence. Second sentence. Third sentence.";
    const result = validateResponseQuality(response);
    expect(result.isValid).toBe(false);
    expect(result.violations).toContain('Too many sentences: 3/2');
  });

  test('should fail on long sentences', () => {
    const response = "This is a really long sentence that definitely exceeds the twenty-five word limit that we have established for maintaining conciseness.";
    const result = validateResponseQuality(response);
    expect(result.isValid).toBe(false);
    expect(result.violations).toContain(expect.stringMatching(/Sentence .* too long/));
  });

  test('should detect AI-speak phrases', () => {
    const response = "That's a great question! Let me help you understand this.";
    const result = validateResponseQuality(response);
    expect(result.isValid).toBe(false);
    expect(result.violations).toContain(expect.stringMatching(/Contains AI-speak/));
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test:electron electron/tests/llm-validation.test.ts`
Expected: FAIL with "validateResponseQuality not found"

- [ ] **Step 5: Commit failing tests**

```bash
git add electron/tests/llm-validation.test.ts
git commit -m "test: add validation tests (failing)"
```

### Task 4: Implement Validation Functions

**Files:**
- Modify: `electron/llm/postProcessor.ts`

- [ ] **Step 1: Add validation imports**

Add to top of postProcessor.ts:
```typescript
import { ValidationResult, ResponseQuality } from './types';
import { LLM_SPEAK_BLOCKLIST } from './prompts';
```

- [ ] **Step 2: Implement core validation function**

Add to postProcessor.ts:
```typescript
export function validateResponseQuality(response: string): ValidationResult {
  const sentences = splitIntoSentences(response);
  const violations: string[] = [];
  
  // Sentence limit check
  if (sentences.length > 2) {
    violations.push(`Too many sentences: ${sentences.length}/2`);
  }
  
  // Word limit per sentence
  let maxWordsPerSentence = 0;
  sentences.forEach((sentence, i) => {
    const wordCount = sentence.trim().split(/\s+/).length;
    maxWordsPerSentence = Math.max(maxWordsPerSentence, wordCount);
    if (wordCount > 25) {
      violations.push(`Sentence ${i+1} too long: ${wordCount}/25 words`);
    }
  });
  
  // Anti-pattern check
  const blockedPhrases = LLM_SPEAK_BLOCKLIST.filter(phrase => 
    response.toLowerCase().includes(phrase.toLowerCase())
  );
  if (blockedPhrases.length > 0) {
    violations.push(`Contains AI-speak: ${blockedPhrases.slice(0, 2).join(', ')}`);
  }
  
  // Estimate speaking time (150 words per minute average)
  const totalWords = response.split(/\s+/).length;
  const estimatedSpeakingTime = (totalWords / 150) * 60; // seconds
  
  return {
    isValid: violations.length === 0,
    violations,
    regenerationHint: violations.length > 0 ? generateRewriteHint(violations) : undefined,
    metrics: {
      sentenceCount: sentences.length,
      maxWordsPerSentence,
      estimatedSpeakingTime
    }
  };
}

function splitIntoSentences(text: string): string[] {
  // Simple sentence splitting - can be enhanced
  return text.split(/[.!?]+/).filter(s => s.trim().length > 0);
}

function generateRewriteHint(violations: string[]): string {
  const hints = [];
  
  if (violations.some(v => v.includes('Too many sentences'))) {
    hints.push('Combine or remove sentences');
  }
  
  if (violations.some(v => v.includes('too long'))) {
    hints.push('Shorten sentences to under 25 words each');
  }
  
  if (violations.some(v => v.includes('AI-speak'))) {
    hints.push('Remove conversational fluff phrases');
  }
  
  return `Rewrite to fix: ${hints.join(', ')}`;
}
```

- [ ] **Step 3: Run tests to verify implementation**

Run: `npm run test:electron electron/tests/llm-validation.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit validation implementation**

```bash
git add electron/llm/postProcessor.ts
git commit -m "feat: implement response validation with metrics"
```

### Task 5: Integrate Validation into LLM Pipeline

**Files:**
- Modify: `electron/llm/LLMHelper.ts`

- [ ] **Step 1: Add validation import**

Add to imports in LLMHelper.ts:
```typescript
import { validateResponseQuality } from './postProcessor';
```

- [ ] **Step 2: Find response return point**

Run: `grep -n "return.*response" electron/llm/LLMHelper.ts`
Expected: Line numbers showing where responses are returned

- [ ] **Step 3: Add validation hook before response return**

Add validation check before main response return:
```typescript
// Add before existing response return
const validation = validateResponseQuality(finalResponse);

if (!validation.isValid && shouldEnforceValidation) {
  // Log violation for monitoring
  console.warn('Response validation failed:', validation.violations);
  
  // For now, return with warning comment - can enhance with regeneration
  return `${finalResponse}\n\n<!-- Validation: ${validation.violations.join(', ')} -->`;
}

return finalResponse;
```

- [ ] **Step 4: Add validation toggle**

Add near top of file:
```typescript
const shouldEnforceValidation = process.env.ENFORCE_RESPONSE_VALIDATION === 'true';
```

- [ ] **Step 5: Test integration**

Run: `npm run build`
Expected: No build errors

- [ ] **Step 6: Commit pipeline integration**

```bash
git add electron/llm/LLMHelper.ts
git commit -m "feat: integrate validation into LLM response pipeline"
```

### Task 6: Add Validation Metrics and Monitoring

**Files:**
- Modify: `electron/llm/postProcessor.ts`

- [ ] **Step 1: Add metrics collection**

Add to postProcessor.ts:
```typescript
export function logValidationMetrics(validation: ValidationResult, prompt: string): void {
  if (process.env.NODE_ENV === 'development') {
    console.log('Response Validation Metrics:', {
      isValid: validation.isValid,
      violations: validation.violations,
      sentenceCount: validation.metrics.sentenceCount,
      maxWordsPerSentence: validation.metrics.maxWordsPerSentence,
      speakingTime: `${validation.metrics.estimatedSpeakingTime.toFixed(1)}s`,
      promptType: detectPromptType(prompt)
    });
  }
}

function detectPromptType(prompt: string): string {
  if (prompt.includes('coding') || prompt.includes('algorithm')) return 'technical';
  if (prompt.includes('define') || prompt.includes('what is')) return 'definition';
  return 'general';
}
```

- [ ] **Step 2: Update LLMHelper to use metrics**

Add metrics logging in LLMHelper.ts:
```typescript
import { validateResponseQuality, logValidationMetrics } from './postProcessor';

// In response processing:
const validation = validateResponseQuality(finalResponse);
logValidationMetrics(validation, prompt);
```

- [ ] **Step 3: Test metrics output**

Set environment variable and test:
```bash
export NODE_ENV=development
export ENFORCE_RESPONSE_VALIDATION=true
# Run your app and check console for metrics
```

- [ ] **Step 4: Commit metrics and monitoring**

```bash
git add electron/llm/postProcessor.ts electron/llm/LLMHelper.ts
git commit -m "feat: add validation metrics and monitoring"
```

### Task 7: Final Integration Test

**Files:**
- Test: Complete system test

- [ ] **Step 1: Create integration test**

Create `electron/tests/integration-quality.test.ts`:
```typescript
import { validateResponseQuality } from '../../electron/llm/postProcessor';

describe('End-to-End Response Quality', () => {
  test('system enforces MIT pyramid structure', () => {
    const goodResponse = "Redis handles caching efficiently. We used it for session storage.";
    const badResponse = "Well, that's a great question! Let me explain how Redis works. Redis is an in-memory data structure store that can be used as a database, cache, and message broker...";
    
    expect(validateResponseQuality(goodResponse).isValid).toBe(true);
    expect(validateResponseQuality(badResponse).isValid).toBe(false);
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `npm run test:electron`
Expected: All tests pass

- [ ] **Step 3: Test with validation enabled**

```bash
export ENFORCE_RESPONSE_VALIDATION=true
# Manual test of your LLM system
```

- [ ] **Step 4: Final commit**

```bash
git add electron/tests/integration-quality.test.ts
git commit -m "test: add integration tests for response quality system"
```

---

## Success Criteria

- [ ] All existing prompts preserved without structural changes
- [ ] Concrete examples added to guide LLM behavior  
- [ ] Validation system catches violations with specific feedback
- [ ] Metrics available for monitoring response quality
- [ ] Tests verify both individual components and integration
- [ ] System can be toggled on/off via environment variable