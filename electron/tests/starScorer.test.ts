import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StarScorer } from '../conscious/StarScorer';
import type { ConsciousModeStructuredResponse } from '../ConsciousMode';

function response(overrides: Partial<ConsciousModeStructuredResponse> = {}): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: 'I would use Redis and Kafka for the core path.',
    implementationPlan: ['Use Redis for caching', 'Use Kafka for the async fan-out'],
    tradeoffs: [],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
    ...overrides,
  };
}

function behavioralResponse(overrides: Partial<ConsciousModeStructuredResponse['behavioralAnswer']> = {}): ConsciousModeStructuredResponse {
  return response({
    behavioralAnswer: {
      question: 'Tell me about a time you improved system performance.',
      headline: 'Reduced API latency by 40%',
      situation: 'Our API was experiencing high latency under load.',
      task: 'I needed to identify and fix the performance bottleneck.',
      action: 'I analyzed metrics, identified a slow database query, added proper indexing, and implemented query caching.',
      result: 'API latency dropped from 200ms to 120ms, improving user experience and reducing timeouts.',
      whyThisAnswerWorks: ['Data-driven approach', 'Targeted optimization', 'Measurable impact'],
    },
    ...overrides,
  });
}

describe('StarScorer', () => {
  it('should score high-depth action > 0.7', () => {
    const scorer = new StarScorer();
    const highDepthResponse = behavioralResponse({
      action: 'I analyzed production metrics, identified a slow N+1 query pattern in the user service, implemented Redis caching with a 5-minute TTL, and added database connection pooling to handle peak load.',
      result: 'API latency dropped from 200ms to 120ms, reducing timeout errors by 60% and improving user satisfaction scores.',
    });

    const score = scorer.score(highDepthResponse);
    assert.ok(score.overall > 0.7, `High-depth action should score > 0.7, got ${score.overall}`);
  });

  it('should score low-depth action < 0.5', () => {
    const scorer = new StarScorer();
    const lowDepthResponse = response({
      behavioralAnswer: {
        question: 'Tell me about a time you improved system performance.',
        headline: 'Fixed performance issue',
        situation: 'The system was slow.',
        task: 'Fix it.',
        action: 'I fixed it.',
        result: 'It worked.',
        whyThisAnswerWorks: ['Quick fix'],
      },
    });

    const score = scorer.score(lowDepthResponse);
    assert.ok(score.overall < 0.5, `Low-depth action should score < 0.5, got ${score.overall}`);
  });

  it('should accept concise but high-quality answers', () => {
    const scorer = new StarScorer();
    const conciseResponse = behavioralResponse({
      action: 'I added Redis caching and database indexing to reduce API latency.',
      result: 'Latency dropped from 200ms to 120ms, improving user experience.',
    });

    const score = scorer.score(conciseResponse);
    assert.ok(scorer.isAcceptable(score), `Concise high-quality answer should be acceptable, got score ${score.overall}`);
  });

  it('should return 0 for missing behavioral field', () => {
    const scorer = new StarScorer();
    const noBehavioralResponse = response();

    const score = scorer.score(noBehavioralResponse);
    assert.strictEqual(score.overall, 0, 'Missing behavioral field should score 0');
    assert.ok(!scorer.isAcceptable(score), 'Missing behavioral field should not be acceptable');
  });

  it('should extract action word count correctly', () => {
    const scorer = new StarScorer();
    const testResponse = response({
      behavioralAnswer: {
        question: 'Test',
        headline: 'Test',
        situation: 'Test',
        task: 'Test',
        action: 'I analyzed metrics and fixed the query.',
        result: 'Test result.',
        whyThisAnswerWorks: ['Test'],
      },
    });

    const score = scorer.score(testResponse);
    assert.strictEqual(score.details.actionWordCount, 7, 'Action word count should be 7');
  });

  it('should extract result word count correctly', () => {
    const scorer = new StarScorer();
    const testResponse = response({
      behavioralAnswer: {
        question: 'Test',
        headline: 'Test',
        situation: 'Test',
        task: 'Test',
        action: 'Test action.',
        result: 'Latency dropped from 200ms to 120ms.',
        whyThisAnswerWorks: ['Test'],
      },
    });

    const score = scorer.score(testResponse);
    assert.strictEqual(score.details.resultWordCount, 6, 'Result word count should be 6');
  });

  it('should detect impact cues in result', () => {
    const scorer = new StarScorer();
    const withImpact = behavioralResponse({
      result: 'Reduced latency by 40ms and improved throughput by 50%.',
    });

    const score = scorer.score(withImpact);
    assert.ok(score.details.hasImpactCue, 'Should detect impact cues');
  });

  it('should detect action verbs', () => {
    const scorer = new StarScorer();
    const withVerb = behavioralResponse({
      action: 'I implemented caching and deployed it to production.',
    });

    const score = scorer.score(withVerb);
    assert.ok(score.details.hasActionVerb, 'Should detect action verbs');
  });

  it('should compute action-to-situation ratio correctly', () => {
    const scorer = new StarScorer();
    const testResponse = behavioralResponse({
      situation: 'The system was slow.',
      action: 'I analyzed metrics, identified the bottleneck, implemented caching, and optimized the database queries.',
    });

    const score = scorer.score(testResponse);
    assert.ok(score.details.actionToSituationRatio > 1, 'Action should be longer than situation');
  });

  it('should compute action-to-task ratio correctly', () => {
    const scorer = new StarScorer();
    const testResponse = behavioralResponse({
      task: 'Fix the slowness.',
      action: 'I analyzed metrics, identified the bottleneck, implemented caching, and optimized the database queries.',
    });

    const score = scorer.score(testResponse);
    assert.ok(score.details.actionToTaskRatio > 1, 'Action should be longer than task');
  });

  it('should return scores in [0, 1] range', () => {
    const scorer = new StarScorer();
    const testResponse = behavioralResponse();

    const score = scorer.score(testResponse);
    assert.ok(score.overall >= 0 && score.overall <= 1, `Score should be in [0, 1], got ${score.overall}`);
  });

  it('should accept high-quality answers with threshold', () => {
    const scorer = new StarScorer();
    const highQualityResponse = behavioralResponse({
      action: 'I analyzed production metrics, identified a slow N+1 query pattern, implemented Redis caching with proper invalidation, and added database connection pooling.',
      result: 'API latency dropped from 200ms to 120ms, reducing timeout errors by 60% and improving user satisfaction.',
    });

    const score = scorer.score(highQualityResponse);
    assert.ok(scorer.isAcceptable(score), `High-quality answer should be acceptable with threshold 0.55, got ${score.overall}`);
  });

  it('should reject low-quality answers with threshold', () => {
    const scorer = new StarScorer();
    const lowQualityResponse = response({
      behavioralAnswer: {
        question: 'Test',
        headline: 'Test',
        situation: 'Test',
        task: 'Test',
        action: 'I did some work.',
        result: 'It was fine.',
        whyThisAnswerWorks: ['Test'],
      },
    });

    const score = scorer.score(lowQualityResponse);
    assert.ok(!scorer.isAcceptable(score), `Low-quality answer should not be acceptable with threshold 0.55, got ${score.overall}`);
  });
});
