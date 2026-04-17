import { EnhancedCache } from '../cache/EnhancedCache';
import { InterviewPhase } from '../conscious/types';
import { isOptimizationActive, getOptimizationFlags } from '../config/optimizations';
import { computeBM25, getEmbeddingProvider } from '../cache/ParallelContextAssembler';
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

interface PredictedFollowUpDraft {
  query: string;
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
  private transcriptRevision = 0;
  private transcriptSignature = '';
  private bm25Cache = new Map<string, Array<{ text: string; score: number; timestamp: number }>>();
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
  updateTranscriptSegments(segments: Array<{ text: string; timestamp: number; speaker: string }>, transcriptRevision?: number): void {
    const trimmed = segments.slice(-50);
    const signature = trimmed.map((segment) => `${segment.speaker}:${segment.timestamp}:${segment.text}`).join('\u0000');

    if (typeof transcriptRevision === 'number') {
      if (transcriptRevision !== this.transcriptRevision) {
        this.transcriptRevision = transcriptRevision;
        this.bm25Cache.clear();
      }
    } else if (signature !== this.transcriptSignature) {
      this.transcriptRevision += 1;
      this.bm25Cache.clear();
    }

    this.transcriptSignature = signature;
    this.transcriptSegments = trimmed;
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

  getCandidateQueries(seedQuery?: string, limit: number = 3): PredictedFollowUpDraft[] {
    const drafts = this.predictFollowUpDrafts();
    const deduped: PredictedFollowUpDraft[] = [];
    const seen = new Set<string>();

    const pushCandidate = (candidate?: PredictedFollowUpDraft) => {
      if (!candidate) {
        return;
      }

      const normalized = candidate.query.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      deduped.push(candidate);
    };

    if (seedQuery?.trim()) {
      pushCandidate({ query: seedQuery.trim(), confidence: 0.98 });
    }

    for (const draft of drafts) {
      pushCandidate(draft);
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped.slice(0, limit);
  }

  async getSemanticEmbedding(text: string): Promise<number[]> {
    const provider = getEmbeddingProvider();
    if (provider?.isInitialized()) {
      return provider.embed(text);
    }

    return this.fallbackSemanticEmbedding(text);
  }

  private async startPrefetching(): Promise<void> {
    if (this.isUserSpeaking) return;

    const predictions = await this.predictFollowUps();
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

  private async predictFollowUps(): Promise<PredictedFollowUp[]> {
    const drafts = this.predictFollowUpDrafts();

    return Promise.all(drafts.slice(0, 10).map(async (draft) => ({
      ...draft,
      embedding: await this.getSemanticEmbedding(draft.query),
    })));
  }

  private predictFollowUpDrafts(): PredictedFollowUpDraft[] {
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
        confidence: this.estimateConfidence(query),
      }));
  }

  private normalizeSemanticToken(token: string): string {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.endsWith('ies') && normalized.length > 4) {
      return `${normalized.slice(0, -3)}y`;
    }
    if (normalized.endsWith('ing') && normalized.length > 5) {
      return normalized.slice(0, -3);
    }
    if (normalized.endsWith('es') && normalized.length > 4) {
      return normalized.slice(0, -2);
    }
    if (normalized.endsWith('s') && normalized.length > 3) {
      return normalized.slice(0, -1);
    }
    return normalized;
  }

  private fallbackSemanticEmbedding(text: string): number[] {
    const embedding = new Array(384).fill(0);
    const tokens = text
      .split(/\s+/)
      .map((token) => this.normalizeSemanticToken(token))
      .filter((token) => token.length >= 2);

    for (const token of tokens) {
      const hash = this.simpleHash(token);
      embedding[hash % 384] += 1;
      embedding[(hash * 31) % 384] += 0.5;
    }

    const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? embedding.map((value) => value / norm) : embedding;
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
      const cacheKey = `${this.transcriptRevision}:${query.trim().toLowerCase()}`;
      let bm25Results = this.bm25Cache.get(cacheKey);
      if (!bm25Results) {
        bm25Results = await computeBM25(query, docs);
        this.bm25Cache.set(cacheKey, bm25Results);
      }
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
    const effectiveEmbedding = embedding ?? await this.getSemanticEmbedding(query);
    const cached = await this.prefetchCache.get(query, effectiveEmbedding);

    if (cached) {
      return cached.context;
    }

    return null;
  }
}
