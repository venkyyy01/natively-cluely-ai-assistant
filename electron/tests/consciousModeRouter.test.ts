/**
 * Tests for ConsciousModeRouter
 *
 * Unified test suite for the consolidated conscious mode routing system.
 * Tests classification, verification, strategy hints, and routing decisions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ConsciousModeRouter, type RouterOptions } from '../conscious/ConsciousModeRouter';

// Mock LLMHelper for testing
class MockLLMHelper {
  public prompts: string[] = [];

  async *streamChat(prompt: string, imagePaths: string[] | undefined, context: string | undefined, systemPrompt: string): AsyncGenerator<string> {
    this.prompts.push(prompt);
    const utterance = prompt.match(/Utterance: "([\s\S]*?)"/)?.[1] ?? '';
    // Mock classification response
    if (utterance.includes('Hi there') || utterance.includes('Hello') || utterance.includes('thanks')) {
      yield JSON.stringify({ kind: 'smalltalk', confidence: 0.9 });
    } else if (utterance.includes('Tell me about a time')) {
      yield JSON.stringify({ kind: 'behavioral', confidence: 0.88 });
    } else if (utterance.includes('But what about')) {
      yield JSON.stringify({ kind: 'pushback', confidence: 0.87 });
    } else if (utterance.includes('clarify') || utterance.includes('explain') || utterance.includes('What do you mean')) {
      yield JSON.stringify({ kind: 'clarification', confidence: 0.85 });
    } else if (utterance.includes('shorter') || utterance.includes('expand') || utterance.includes('rephrase')) {
      yield JSON.stringify({ kind: 'refinement', confidence: 0.8, refinementIntent: 'shorten' });
    } else if (utterance.includes('got it') || utterance.includes('understood') || utterance.includes('Got it')) {
      yield JSON.stringify({ kind: 'acknowledgement', confidence: 0.9 });
    } else if (utterance.includes('by the way') || utterance.includes('By the way') || utterance.includes('btw')) {
      yield JSON.stringify({ kind: 'off_topic_aside', confidence: 0.8 });
    } else {
      yield JSON.stringify({ kind: 'technical', confidence: 0.7 });
    }
  }
}

describe('ConsciousModeRouter', () => {
  const router = new ConsciousModeRouter();
  const mockLLMHelper = new MockLLMHelper();

  describe('local embedding classifier initialization', () => {
    it('initializes local embedding model', async () => {
      await router.initialize();
      // If it doesn't throw, initialization succeeded
      // In production, the model would load and be ready
    });

    it('handles initialization errors gracefully', async () => {
      // The router should continue to work even if model fails to load
      // It will fall back to hash-based embeddings
      await router.initialize();
      const plan = await router.plan('Test utterance', { enabled: true });
      assert.ok(plan); // Should still return a plan
    });
  });

  describe('legacy plan (feature flag disabled)', () => {
    it('returns strict plan when flag is disabled', async () => {
      const plan = await router.plan('Any question', { enabled: false });
      assert.strictEqual(plan.kind, 'technical');
      assert.strictEqual(plan.confidence, 1.0);
      assert.strictEqual(plan.verificationLevel, 'strict');
      assert.strictEqual(plan.responseShape, 'structured');
      assert.strictEqual(plan.shouldBypassConscious, false);
      assert.strictEqual(plan.reason, 'legacy_strict_plan');
      assert.strictEqual(plan.verification.runProvenance, true);
      assert.strictEqual(plan.verification.runDeterministic, true);
      assert.strictEqual(plan.verification.runJudge, true);
    });

    it('ignores all options when flag is disabled', async () => {
      const plan = await router.plan('Hi there!', {
        enabled: false,
        isInsideThread: true,
        isLiveCoding: true,
        isDegraded: true,
      });
      assert.strictEqual(plan.kind, 'technical');
      assert.strictEqual(plan.verificationLevel, 'strict');
    });
  });

  describe('LLM-based classification (feature flag enabled)', () => {
    it('classifies smalltalk via LLM', async () => {
      const plan = await router.plan('Hi there!', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.kind, 'smalltalk');
      assert.strictEqual(plan.responseShape, 'free_form');
      assert.strictEqual(plan.verificationLevel, 'skip');
      assert.strictEqual(plan.shouldBypassConscious, true);
      assert.strictEqual(plan.verification.runProvenance, false);
      assert.strictEqual(plan.verification.runDeterministic, false);
      assert.strictEqual(plan.verification.runJudge, false);
    });

    it('classifies clarification via LLM', async () => {
      const plan = await router.plan('Can you clarify that?', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.kind, 'clarification');
      assert.strictEqual(plan.responseShape, 'free_form');
      assert.strictEqual(plan.verificationLevel, 'relaxed');
    });

    it('classifies refinement via LLM', async () => {
      const plan = await router.plan('Make it shorter', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.kind, 'refinement');
      assert.strictEqual(plan.refinementIntent, 'shorten');
    });

    it('classifies acknowledgement via LLM', async () => {
      const plan = await router.plan('Got it!', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.kind, 'acknowledgement');
    });

    it('classifies off topic aside via LLM', async () => {
      const plan = await router.plan('By the way, what time is it?', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.kind, 'off_topic_aside');
    });

    it('classifies technical questions via LLM', async () => {
      const plan = await router.plan('Explain React hooks', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.kind, 'technical');
    });

    it('classifies behavioral questions via LLM with STAR senior format', async () => {
      const plan = await router.plan('Tell me about a time you led a project', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.kind, 'behavioral');
      assert.strictEqual(plan.responseShape, 'structured');
      assert.strictEqual(plan.verificationLevel, 'moderate');
      assert.match(plan.strategyHint || '', /Direct answer \(1-2 lines\)/);
      assert.match(plan.strategyHint || '', /STAR format \(Situation, Task, Action, Result\)/);
      assert.match(plan.strategyHint || '', /Tradeoff: why this approach over alternatives/);
      assert.match(plan.tonePreamble || '', /There are three parts/);
      assert.match(plan.tonePreamble || '', /The key tradeoff is/);
      assert.match(plan.tonePreamble || '', /No filler phrases/);
      assert.ok(mockLLMHelper.prompts.some((prompt) => prompt.includes('- behavioral: STAR format interview questions')));
    });

    it('classifies pushback via LLM with reframing template', async () => {
      const plan = await router.plan('But what about edge cases?', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.kind, 'pushback');
      assert.strictEqual(plan.responseShape, 'structured');
      assert.strictEqual(plan.verificationLevel, 'strict');
      assert.match(plan.strategyHint || '', /That would be a concern if X\. In our case, we did Y because Z\./);
      assert.doesNotMatch(plan.strategyHint || '', /defend your reasoning/i);
      assert.ok(mockLLMHelper.prompts.some((prompt) => prompt.includes('- pushback: interviewer challenge')));
    });

    it('falls back to technical when no LLMHelper', async () => {
      const plan = await router.plan('Any utterance', { enabled: true });
      assert.strictEqual(plan.kind, 'technical');
    });
  });

  describe('refinement usefulness', () => {
    it('rejects shorten when already short', () => {
      const result = router.isRefinementUseful({
        intent: 'shorten',
        previousAnswer: 'Short answer.',
      });
      assert.strictEqual(result, false);
    });

    it('accepts shorten when long', () => {
      const result = router.isRefinementUseful({
        intent: 'shorten',
        previousAnswer: 'This is a very long answer that goes on and on and on and on and on and on and on and on and on.',
      });
      assert.strictEqual(result, true);
    });

    it('rejects expand when already long', () => {
      const result = router.isRefinementUseful({
        intent: 'expand',
        previousAnswer: 'This is a very long answer that goes on and on and on and on and on and on and on and on and on.',
      });
      assert.strictEqual(result, false);
    });

    it('accepts expand when short', () => {
      const result = router.isRefinementUseful({
        intent: 'expand',
        previousAnswer: 'Short.',
      });
      assert.strictEqual(result, true);
    });

    it('rejects simplify when already simple', () => {
      const result = router.isRefinementUseful({
        intent: 'simplify',
        previousAnswer: 'It is good.',
      });
      assert.strictEqual(result, false);
    });
  });

  describe('refinement prompt building', () => {
    it('builds prompt for shorten', () => {
      const prompt = router.buildRefinementPrompt({
        previousAnswer: 'This is a long answer with many details.',
        refinementIntent: 'shorten',
        lastQuestion: 'What is React?',
        userRequest: 'Make it shorter',
      });
      assert.strictEqual(prompt.includes('concise'), true);
      assert.strictEqual(prompt.includes('This is a long answer with many details.'), true);
    });

    it('builds prompt for expand', () => {
      const prompt = router.buildRefinementPrompt({
        previousAnswer: 'Short answer.',
        refinementIntent: 'expand',
        userRequest: 'Expand this',
      });
      assert.strictEqual(prompt.includes('more detail'), true);
    });

    it('builds prompt for rephrase', () => {
      const prompt = router.buildRefinementPrompt({
        previousAnswer: 'Original text.',
        refinementIntent: 'rephrase',
        userRequest: 'Say it differently',
      });
      assert.strictEqual(prompt.includes('different words'), true);
    });

    it('builds prompt for simplify', () => {
      const prompt = router.buildRefinementPrompt({
        previousAnswer: 'Complex technical explanation.',
        refinementIntent: 'simplify',
        userRequest: 'Simplify this',
      });
      assert.strictEqual(prompt.includes('simpler'), true);
    });

    it('builds prompt for add example', () => {
      const prompt = router.buildRefinementPrompt({
        previousAnswer: 'Explanation without example.',
        refinementIntent: 'add_example',
        userRequest: 'Give me an example',
      });
      assert.strictEqual(prompt.includes('concrete example'), true);
    });
  });

  describe('technical classification (fallback)', () => {
    it('classifies technical questions when no LLMHelper', async () => {
      const plan = await router.plan('How does React work?', { enabled: true });
      assert.strictEqual(plan.kind, 'technical');
      assert.strictEqual(plan.responseShape, 'structured');
      assert.strictEqual(plan.verificationLevel, 'strict');
      assert.strictEqual(plan.shouldBypassConscious, false);
      assert.strictEqual(plan.verification.runProvenance, true);
      assert.strictEqual(plan.verification.runDeterministic, true);
      assert.strictEqual(plan.verification.runJudge, true);
    });

    it('detects behavioral question patterns and adds STAR hint', async () => {
      const plan = await router.plan('Tell me about a time you led a project', { enabled: true });
      assert.strictEqual(plan.kind, 'behavioral');
      assert.match(plan.strategyHint || '', /Direct answer \(1-2 lines\)/);
      assert.match(plan.strategyHint || '', /STAR format \(Situation, Task, Action, Result\)/);
      assert.match(plan.strategyHint || '', /Tradeoff: why this approach over alternatives/);
      assert.strictEqual(plan.verificationLevel, 'moderate');
    });

    it('detects coding patterns and adds code-first hint', async () => {
      const plan = await router.plan('Design a system for file storage', { enabled: true });
      assert.strictEqual(plan.kind, 'technical');
      assert.match(plan.strategyHint || '', /Direct answer \(1-2 lines\)/);
      assert.match(plan.strategyHint || '', /Code-first approach: show implementation, then explain/);
      assert.match(plan.strategyHint || '', /Tradeoff: performance vs\. readability/);
    });

    it('detects deep dive patterns and adds structured hint', async () => {
      const plan = await router.plan('Explain how database indexing works', { enabled: true });
      assert.strictEqual(plan.kind, 'technical');
      assert.match(plan.strategyHint || '', /Direct answer \(1-2 lines\)/);
      assert.match(plan.strategyHint || '', /Structured approach: constraints → design → tradeoffs → alternatives/);
      assert.match(plan.strategyHint || '', /Tradeoff: complexity vs\. maintainability/);
    });

    it('detects pushback patterns and boosts verification', async () => {
      const plan = await router.plan('But what about edge cases?', { enabled: true });
      assert.strictEqual(plan.kind, 'pushback');
      assert.strictEqual(plan.verificationLevel, 'strict');
      assert.match(plan.strategyHint || '', /That would be a concern if X\. In our case, we did Y because Z\./);
      assert.doesNotMatch(plan.strategyHint || '', /assertive/i);
    });

    it('boosts verification when inside thread', async () => {
      const plan = await router.plan('What about scalability?', { enabled: true, isInsideThread: true });
      assert.strictEqual(plan.kind, 'technical');
      assert.strictEqual(plan.verificationLevel, 'strict');
    });

    it('adds live coding hint when live coding', async () => {
      const plan = await router.plan('How do I handle errors?', { enabled: true, isLiveCoding: true });
      assert.strictEqual(plan.kind, 'technical');
      assert.ok(plan.strategyHint?.includes('code correctness'));
    });
  });

  describe('verification plans', () => {
    it('strict verification runs all checkers', async () => {
      const plan = await router.plan('Technical question', { enabled: true });
      assert.strictEqual(plan.verificationLevel, 'strict');
      assert.strictEqual(plan.verification.runProvenance, true);
      assert.strictEqual(plan.verification.runDeterministic, true);
      assert.strictEqual(plan.verification.runJudge, true);
    });

    it('moderate verification skips judge', async () => {
      const plan = await router.plan('Can you make it shorter?', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.verificationLevel, 'moderate');
      assert.strictEqual(plan.verification.runProvenance, true);
      assert.strictEqual(plan.verification.runDeterministic, true);
      assert.strictEqual(plan.verification.runJudge, false);
    });

    it('relaxed verification runs only provenance', async () => {
      const plan = await router.plan('What do you mean?', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.verificationLevel, 'relaxed');
      assert.strictEqual(plan.verification.runProvenance, true);
      assert.strictEqual(plan.verification.runDeterministic, false);
      assert.strictEqual(plan.verification.runJudge, false);
    });

    it('skip verification runs no checkers', async () => {
      const plan = await router.plan('Hi there!', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.verificationLevel, 'skip');
      assert.strictEqual(plan.verification.runProvenance, false);
      assert.strictEqual(plan.verification.runDeterministic, false);
      assert.strictEqual(plan.verification.runJudge, false);
    });

    it('degraded mode skips judge', async () => {
      const plan = await router.plan('Technical question', { enabled: true, isDegraded: true });
      assert.strictEqual(plan.verification.runJudge, false);
      assert.strictEqual(plan.verification.reason, 'strict_verification_all_checkers_degraded_mode');
    });

    it('degraded mode can still run provenance when flag is true', async () => {
      const plan = await router.plan('Technical question', { enabled: true, isDegraded: true, useDegradedProvenanceCheck: true });
      assert.strictEqual(plan.verification.runJudge, false);
      assert.strictEqual(plan.verification.runProvenance, true);
    });

    it('degraded mode skips provenance when flag is false', async () => {
      const plan = await router.plan('Technical question', { enabled: true, isDegraded: true, useDegradedProvenanceCheck: false });
      assert.strictEqual(plan.verification.runJudge, false);
      assert.strictEqual(plan.verification.runProvenance, false);
    });
  });

  describe('reason propagation', () => {
    it('uses llm_classification reason when LLM used', async () => {
      const plan = await router.plan('Hi there!', { enabled: true, llmHelper: mockLLMHelper });
      assert.strictEqual(plan.reason, 'llm_classification');
    });

    it('uses technical_question_detected reason when no LLM', async () => {
      const plan = await router.plan('How does this work?', { enabled: true });
      assert.strictEqual(plan.reason, 'technical_question_detected');
    });

    it('uses legacy reason for disabled flag', async () => {
      const plan = await router.plan('Any question', { enabled: false });
      assert.strictEqual(plan.reason, 'legacy_strict_plan');
    });
  });
});
