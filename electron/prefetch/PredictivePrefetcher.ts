import { EnhancedCache } from '../cache/EnhancedCache';
import { InterviewPhase } from '../conscious/types';
import { isOptimizationActive, getOptimizationFlags } from '../config/optimizations';
import { computeBM25 } from '../cache/ParallelContextAssembler';
import type { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';

export interface PrefetchedContext {
  context: {
    relevantContext: Array<{ role: 'interviewer' | 'user' | 'assistant'; text: string; timestamp: number }>;
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
  private transcriptSegments: Array<{ text: string; timestamp: number; speaker: string }> = [];
  private readonly budgetScheduler?: Pick<RuntimeBudgetScheduler, 'shouldAdmitSpeculation'>;

  constructor(options: {
    maxPrefetchPredictions?: number;
    maxMemoryMB?: number;
    budgetScheduler?: Pick<RuntimeBudgetScheduler, 'shouldAdmitSpeculation'>;
  }) {
    const flags = getOptimizationFlags();
    this.budgetScheduler = options.budgetScheduler;

    this.prefetchCache = new EnhancedCache<string, PrefetchedContext>({
      maxMemoryMB: options.maxMemoryMB || flags.maxCacheMemoryMB,
      ttlMs: 5 * 60 * 1000,
      enableSemanticLookup: true,
      similarityThreshold: flags.semanticCacheThreshold,
    });
  }

  /**
   * Update transcript segments for real context assembly
   */
  updateTranscriptSegments(segments: Array<{ text: string; timestamp: number; speaker: string }>): void {
    this.transcriptSegments = segments.slice(-50);
  }

  /**
   * Clear transcript segments (e.g., on meeting end)
   */
  clearTranscriptSegments(): void {
    this.transcriptSegments = [];
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
    const admittedPredictions: PredictedFollowUp[] = [];

    for (const prediction of predictions.slice(0, flags.maxPrefetchPredictions)) {
      if (this.isUserSpeaking) break;
      if (this.budgetScheduler && !this.budgetScheduler.shouldAdmitSpeculation(prediction.confidence, 1, 0.5)) {
        continue;
      }

      admittedPredictions.push(prediction);

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

    this.predictions = admittedPredictions;
  }

  private predictFollowUps(): PredictedFollowUp[] {
    const phasePredictions = PHASE_FOLLOWUP_PATTERNS[this.currentPhase] || [];

    const transcriptText = this.transcriptSegments
      .slice(-12)
      .map((segment) => segment.text.toLowerCase())
      .join(' ');
    const topicPredictions = Object.entries(TOPIC_FOLLOWUPS)
      .filter(([topic]) => transcriptText.includes(topic))
      .flatMap(([, followUps]) => followUps.map((followUp) => `How does ${followUp} relate here?`));

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
    const queryIndex = phaseQuestions.indexOf(query);
    if (queryIndex >= 0) {
      return 0.85 + (queryIndex * 0.03);
    }
    return 0.55 + (this.simpleHash(query) % 10) * 0.03;
  }

  private async assembleContext(query: string): Promise<{
    relevantContext: Array<{ role: 'interviewer' | 'user' | 'assistant'; text: string; timestamp: number }>;
    phase: InterviewPhase;
  }> {
    // Real context assembly: BM25 search over recent transcript segments
    const docs = this.transcriptSegments
      .filter(s => s.speaker !== 'assistant' && s.text.trim().length > 0)
      .map(s => ({
        role: s.speaker === 'user' ? 'user' as const : s.speaker === 'assistant' ? 'assistant' as const : 'interviewer' as const,
        text: s.text,
        timestamp: s.timestamp,
      }));

    if (docs.length === 0) {
      return {
        relevantContext: [],
        phase: this.currentPhase,
      };
    }

    try {
      const bm25Results = await computeBM25(query, docs);
      const relevantContext = bm25Results
        .slice(0, 5)
        .map(r => ({
          role: docs.find((doc) => doc.text.trim().toLowerCase() === r.text.trim().toLowerCase())?.role ?? 'interviewer' as const,
          text: r.text,
          timestamp: r.timestamp,
        }));

      return {
        relevantContext,
        phase: this.currentPhase,
      };
    } catch (error) {
      console.warn('[PredictivePrefetcher] BM25 search failed, returning empty context:', error);
      return {
        relevantContext: [],
        phase: this.currentPhase,
      };
    }
  }

  async getContext(query: string, embedding?: number[]): Promise<{
    relevantContext: Array<{ role: 'interviewer' | 'user' | 'assistant'; text: string; timestamp: number }>;
    phase: InterviewPhase;
  } | null> {
    const cached = await this.prefetchCache.get(query, embedding);

    if (cached) {
      return cached.context;
    }

    return null;
  }
}
