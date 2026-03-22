import { EnhancedCache } from '../cache/EnhancedCache';
import { InterviewPhase } from '../conscious/types';
import { isOptimizationActive, getOptimizationFlags } from '../config/optimizations';

export interface PrefetchedContext {
  context: {
    relevantContext: Array<{ text: string; timestamp: number }>;
    phase: InterviewPhase;
  };
  embedding: number[];
  confidence: number;
}

export interface PredictedFollowUp {
  query: string;
  embedding: number[];
  confidence: number;
}

const PHASE_FOLLOWUP_PATTERNS: Record<InterviewPhase, string[]> = {
  requirements_gathering: [
    'What are the key requirements?',
    'What are the constraints?',
    'What is the success criteria?',
  ],
  high_level_design: [
    'What are the main components?',
    'How do they communicate?',
    'What are the trade-offs?',
  ],
  deep_dive: [
    'Can you show the implementation?',
    'How does this work internally?',
    'What are the edge cases?',
  ],
  implementation: [
    'How would you test this?',
    'What are the performance implications?',
    'How do you handle errors?',
  ],
  complexity_analysis: [
    'What is the time complexity?',
    'What is the space complexity?',
    'Can we optimize further?',
  ],
  scaling_discussion: [
    'How does this scale to millions of users?',
    'What are the bottlenecks?',
    'How do you handle traffic spikes?',
  ],
  failure_handling: [
    'What happens if this fails?',
    'How do you monitor this?',
    'What is the recovery plan?',
  ],
  behavioral_story: [
    'What was the challenge?',
    'What was your role?',
    'What was the outcome?',
  ],
  wrap_up: [
    'Any questions for me?',
    'What are next steps?',
    'When will you decide?',
  ],
};

const TOPIC_FOLLOWUPS: Record<string, string[]> = {
  'react': ['virtual dom', 'hooks', 'state management'],
  'database': ['indexing', 'normalization', 'caching'],
  'api': ['rest', 'authentication', 'rate limiting'],
  'cache': ['invalidation', 'ttl', 'eviction policy'],
  'testing': ['unit tests', 'integration tests', 'mocking'],
};

export class PredictivePrefetcher {
  private prefetchCache: EnhancedCache<string, PrefetchedContext>;
  private isUserSpeaking: boolean = false;
  private currentPhase: InterviewPhase = 'requirements_gathering';
  private predictions: PredictedFollowUp[] = [];
  private silenceStartTime: number = 0;

  constructor(options: { maxPrefetchPredictions?: number; maxMemoryMB?: number }) {
    const flags = getOptimizationFlags();

    this.prefetchCache = new EnhancedCache<string, PrefetchedContext>({
      maxMemoryMB: options.maxMemoryMB || flags.maxCacheMemoryMB,
      ttlMs: 5 * 60 * 1000,
      enableSemanticLookup: true,
      similarityThreshold: flags.semanticCacheThreshold,
    });
  }

  onSilenceStart(): void {
    if (!isOptimizationActive('usePrefetching')) return;

    this.isUserSpeaking = false;
    this.silenceStartTime = Date.now();
    this.startPrefetching();
  }

  onUserSpeaking(): void {
    this.isUserSpeaking = true;
    this.predictions = [];
  }

  onPhaseChange(phase: InterviewPhase): void {
    this.currentPhase = phase;
  }

  onTopicShiftDetected(): void {
    this.prefetchCache.clear();
    this.predictions = [];
  }

  getPredictions(): PredictedFollowUp[] {
    return this.predictions;
  }

  private async startPrefetching(): Promise<void> {
    if (this.isUserSpeaking) return;

    const predictions = this.predictFollowUps();
    const flags = getOptimizationFlags();

    for (const prediction of predictions.slice(0, flags.maxPrefetchPredictions)) {
      if (this.isUserSpeaking) break;

      try {
        const context = await this.assembleContext(prediction.query);
        await this.prefetchCache.set(prediction.query, {
          context,
          embedding: prediction.embedding,
          confidence: prediction.confidence,
        }, prediction.embedding);
      } catch (error) {
        console.warn('[PredictivePrefetcher] Failed to prefetch:', error);
      }
    }

    this.predictions = predictions.slice(0, flags.maxPrefetchPredictions);
  }

  private predictFollowUps(): PredictedFollowUp[] {
    const phasePredictions = PHASE_FOLLOWUP_PATTERNS[this.currentPhase] || [];

    const topicPredictions: string[] = [];

    return [...phasePredictions, ...topicPredictions]
      .slice(0, 10)
      .map(query => ({
        query,
        embedding: this.quickEmbed(query),
        confidence: this.estimateConfidence(query),
      }));
  }

  private quickEmbed(text: string): number[] {
    const hash = this.simpleHash(text);
    const embedding = new Array(384).fill(0);

    for (let i = 0; i < 5; i++) {
      embedding[(hash + i * 7) % 384] = Math.sin((hash + i) / 10);
    }

    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? embedding.map(v => v / norm) : embedding;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  private estimateConfidence(query: string): number {
    const phaseQuestions = PHASE_FOLLOWUP_PATTERNS[this.currentPhase] || [];
    if (phaseQuestions.includes(query)) {
      return 0.8 + Math.random() * 0.15;
    }
    return 0.5 + Math.random() * 0.3;
  }

  private async assembleContext(query: string): Promise<{
    relevantContext: Array<{ text: string; timestamp: number }>;
    phase: InterviewPhase;
  }> {
    return {
      relevantContext: [
        { text: `Related to: ${query}`, timestamp: Date.now() },
      ],
      phase: this.currentPhase,
    };
  }

  async getContext(query: string, embedding: number[]): Promise<{
    relevantContext: Array<{ text: string; timestamp: number }>;
    phase: InterviewPhase;
  } | null> {
    const cached = await this.prefetchCache.get(query, embedding);

    if (cached) {
      return cached.context;
    }

    return null;
  }
}
