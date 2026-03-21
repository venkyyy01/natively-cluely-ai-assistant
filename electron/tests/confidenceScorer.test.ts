// electron/tests/confidenceScorer.test.ts
import { describe, it, expect } from 'vitest';
import { ConfidenceScorer } from '../conscious/ConfidenceScorer';
import { ConversationThread, InterviewPhase } from '../conscious/types';

describe('ConfidenceScorer', () => {
  const scorer = new ConfidenceScorer();

  const createMockThread = (overrides: Partial<ConversationThread> = {}): ConversationThread => ({
    id: 'test-thread',
    status: 'suspended',
    topic: 'caching layer design',
    goal: 'Design Redis caching',
    phase: 'high_level_design',
    keyDecisions: ['Use Redis', 'TTL-based expiry'],
    constraints: [],
    codeContext: { snippets: [], maxSnippets: 3, totalTokenBudget: 500 },
    createdAt: Date.now() - 60000,
    lastActiveAt: Date.now() - 5000,
    suspendedAt: Date.now() - 5000, // Very recent suspension for higher temporal decay
    ttlMs: 300000,
    resumeKeywords: ['caching', 'redis', 'cache', 'layer'],
    turnCount: 5,
    tokenCount: 200,
    resumeCount: 0,
    ...overrides,
  });

  it('should return high confidence for explicit resume markers', () => {
    const thread = createMockThread();
    const score = scorer.calculateResumeConfidence(
      "Let's go back to the caching layer",
      thread,
      'high_level_design'
    );
    // Without embedding score (0.25 weight), max theoretical score is ~0.65
    // With explicit markers + keywords + aligned phase + fresh thread, expect ~0.55+
    expect(score.total).toBeGreaterThanOrEqual(0.55);
    expect(score.explicitMarkers).toBeGreaterThan(0);
  });

  it('should apply temporal decay to old threads', () => {
    const freshThread = createMockThread({ suspendedAt: Date.now() - 60000 });
    const oldThread = createMockThread({ suspendedAt: Date.now() - 240000 });

    const freshScore = scorer.calculateResumeConfidence('caching', freshThread, 'high_level_design');
    const oldScore = scorer.calculateResumeConfidence('caching', oldThread, 'high_level_design');

    expect(freshScore.temporalDecay).toBeGreaterThan(oldScore.temporalDecay);
  });

  it('should give phase alignment bonus', () => {
    const thread = createMockThread({ phase: 'high_level_design' });
    const alignedScore = scorer.calculateResumeConfidence('caching', thread, 'high_level_design');
    const misalignedScore = scorer.calculateResumeConfidence('caching', thread, 'implementation');

    expect(alignedScore.phaseAlignment).toBeGreaterThan(misalignedScore.phaseAlignment);
  });

  it('should apply topic shift penalty', () => {
    const thread = createMockThread();
    const score = scorer.calculateResumeConfidence(
      "Let's move on to a different topic entirely",
      thread,
      'high_level_design'
    );
    expect(score.topicShiftPenalty).toBeGreaterThan(0);
  });

  it('should calculate BM25 score for keyword overlap', () => {
    const thread = createMockThread({ resumeKeywords: ['caching', 'redis', 'layer'] });
    const score = scorer.calculateResumeConfidence('redis caching layer', thread, 'high_level_design');
    expect(score.bm25Score).toBeGreaterThan(0);
  });
});
