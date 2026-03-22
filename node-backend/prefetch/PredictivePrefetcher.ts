// node-backend/prefetch/PredictivePrefetcher.ts

/**
 * PredictivePrefetcher - Background prefetching of likely responses.
 *
 * Features:
 * - Predicts next questions based on interview stage
 * - Uses recent question patterns to anticipate follow-ups
 * - Warms cache with prefetched context/responses
 * - Respects user activity (pauses during speech)
 *
 * Design: Works with any OpenAI-compatible LLM API.
 */

import { EnhancedCache } from '../cache/EnhancedCache.js';

/**
 * Interview phases for prediction.
 */
export type InterviewPhase =
  | 'intro'
  | 'technical'
  | 'behavioral'
  | 'experience'
  | 'system_design'
  | 'coding'
  | 'closing'
  | 'unknown';

/**
 * Context for prefetching decisions.
 */
export interface PrefetchContext {
  /** Current interview phase */
  phase: InterviewPhase;
  /** Recent questions (most recent first) */
  recentQuestions: string[];
  /** Job role being interviewed for */
  jobRole?: string;
  /** Company name */
  company?: string;
  /** Topics discussed so far */
  topics: string[];
  /** Current transcript snippet */
  transcriptSnippet?: string;
}

/**
 * A predicted question with confidence.
 */
export interface PredictedQuestion {
  /** The predicted question text */
  question: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Reason for prediction */
  reason: string;
  /** Related topic */
  topic?: string;
}

/**
 * Result of prefetching.
 */
export interface PrefetchResult {
  /** Questions that were prefetched */
  questions: string[];
  /** Number of cache entries warmed */
  cacheWarmed: number;
  /** Time taken in ms */
  latencyMs: number;
  /** Whether prefetching was interrupted */
  interrupted: boolean;
}

/**
 * Prefetched context entry.
 */
export interface PrefetchedContext {
  /** The question this is for */
  question: string;
  /** Precomputed context */
  context: string;
  /** Embedding if available */
  embedding?: number[];
  /** Confidence of the prediction */
  confidence: number;
  /** When this was prefetched */
  prefetchedAt: number;
}

/**
 * Callback to generate context for a question.
 */
export type ContextGenerator = (question: string) => Promise<{
  context: string;
  embedding?: number[];
}>;

/**
 * Phase-based follow-up patterns.
 */
const PHASE_FOLLOWUP_PATTERNS: Record<InterviewPhase, string[]> = {
  intro: [
    'Tell me about yourself',
    'Why are you interested in this role?',
    'What do you know about our company?',
    'Walk me through your resume',
    'What are you looking for in your next role?',
  ],
  technical: [
    'Can you explain how that works in more detail?',
    'What are the tradeoffs of that approach?',
    'How would you handle edge cases?',
    'What about scalability?',
    'Can you give me a concrete example?',
    'What alternatives did you consider?',
    'How would you test this?',
  ],
  behavioral: [
    'Can you give me another example?',
    'What would you do differently?',
    'How did you handle the conflict?',
    'What did you learn from that experience?',
    'How did you measure success?',
    'Tell me about a time when you failed',
    'How do you handle disagreements with teammates?',
  ],
  experience: [
    'What was your specific contribution?',
    'What technologies did you use?',
    'How big was the team?',
    'What were the main challenges?',
    'What impact did the project have?',
    'How long did it take?',
  ],
  system_design: [
    'How would you handle millions of users?',
    'What about data consistency?',
    'How would you ensure reliability?',
    'What happens if this component fails?',
    'How would you monitor this system?',
    'What about security considerations?',
    'How would you handle caching?',
  ],
  coding: [
    'Can you optimize this solution?',
    'What is the time complexity?',
    'What is the space complexity?',
    'Can you write tests for this?',
    'How would you handle this edge case?',
    'Are there any bugs in your code?',
  ],
  closing: [
    'Do you have any questions for us?',
    'What are your salary expectations?',
    'When can you start?',
    'Is there anything else you would like to add?',
    'What questions do you have about the role?',
  ],
  unknown: [
    'Can you tell me more about that?',
    'What do you mean by that?',
    'Can you give me an example?',
  ],
};

/**
 * Topic-based follow-up patterns.
 */
const TOPIC_FOLLOWUPS: Record<string, string[]> = {
  architecture: [
    'How would you scale this?',
    'What about microservices vs monolith?',
    'How do you handle service communication?',
  ],
  database: [
    'SQL or NoSQL for this use case?',
    'How would you handle data migration?',
    'What about database sharding?',
  ],
  api: [
    'REST or GraphQL?',
    'How do you handle API versioning?',
    'What about rate limiting?',
  ],
  testing: [
    'How do you approach test coverage?',
    'Unit tests vs integration tests?',
    'How do you handle test data?',
  ],
  leadership: [
    'How do you motivate your team?',
    'How do you handle underperformers?',
    'How do you make decisions?',
  ],
  conflict: [
    'What was the outcome?',
    'How did you resolve it?',
    'What would you do differently?',
  ],
};

export class PredictivePrefetcher {
  private prefetchCache: EnhancedCache<string, PrefetchedContext>;
  private isUserSpeaking = false;
  private currentPhase: InterviewPhase = 'unknown';
  private recentQuestions: string[] = [];
  private activeTopics: Set<string> = new Set();
  private contextGenerator?: ContextGenerator;
  private prefetchInProgress = false;
  private abortController?: AbortController;

  constructor() {
    this.prefetchCache = new EnhancedCache<string, PrefetchedContext>({
      maxSize: 50,
      ttlMs: 15 * 60 * 1000, // 15 minutes
      enableSemanticLookup: true,
      similarityThreshold: 0.8,
      name: 'prefetch',
    });
  }

  /**
   * Set the context generator callback.
   */
  setContextGenerator(generator: ContextGenerator): void {
    this.contextGenerator = generator;
  }

  /**
   * Update the current interview phase.
   */
  setPhase(phase: InterviewPhase): void {
    this.currentPhase = phase;
  }

  /**
   * Add a question to the recent questions list.
   */
  addQuestion(question: string): void {
    this.recentQuestions.unshift(question);
    if (this.recentQuestions.length > 10) {
      this.recentQuestions.pop();
    }

    // Extract topics from question
    this.extractTopics(question);
  }

  /**
   * Add a topic to track.
   */
  addTopic(topic: string): void {
    this.activeTopics.add(topic.toLowerCase());
  }

  /**
   * Signal that user started speaking.
   */
  onUserSpeaking(): void {
    this.isUserSpeaking = true;
    this.abortPrefetching();
  }

  /**
   * Signal that user stopped speaking (silence detected).
   */
  onSilenceStart(): void {
    this.isUserSpeaking = false;
    // Don't automatically start - let caller decide
  }

  /**
   * Predict likely next questions based on context.
   */
  predictNextQuestions(context: PrefetchContext): PredictedQuestion[] {
    const predictions: PredictedQuestion[] = [];

    // Phase-based predictions
    const phasePatterns = PHASE_FOLLOWUP_PATTERNS[context.phase] || [];
    for (const pattern of phasePatterns.slice(0, 3)) {
      predictions.push({
        question: pattern,
        confidence: 0.6 + Math.random() * 0.2, // 0.6-0.8
        reason: `Common ${context.phase} phase question`,
        topic: context.phase,
      });
    }

    // Topic-based predictions
    for (const topic of context.topics.slice(0, 3)) {
      const topicPatterns = TOPIC_FOLLOWUPS[topic.toLowerCase()] || [];
      for (const pattern of topicPatterns.slice(0, 2)) {
        predictions.push({
          question: pattern,
          confidence: 0.5 + Math.random() * 0.2, // 0.5-0.7
          reason: `Follow-up on ${topic}`,
          topic,
        });
      }
    }

    // Pattern-based: Look for question types in recent questions
    if (context.recentQuestions.length > 0) {
      const lastQuestion = context.recentQuestions[0];

      // If last question was about experience, predict follow-ups
      if (
        lastQuestion.toLowerCase().includes('tell me about') ||
        lastQuestion.toLowerCase().includes('describe')
      ) {
        predictions.push({
          question: 'Can you tell me more about your specific role?',
          confidence: 0.7,
          reason: 'Follow-up to experience question',
        });
        predictions.push({
          question: 'What were the main challenges you faced?',
          confidence: 0.65,
          reason: 'Follow-up to experience question',
        });
      }

      // If last question was technical
      if (
        lastQuestion.toLowerCase().includes('how would you') ||
        lastQuestion.toLowerCase().includes('design')
      ) {
        predictions.push({
          question: 'What about scalability concerns?',
          confidence: 0.6,
          reason: 'Technical follow-up',
        });
      }
    }

    // Sort by confidence and deduplicate
    const seen = new Set<string>();
    return predictions
      .filter((p) => {
        const key = p.question.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  }

  /**
   * Prefetch responses for predicted questions.
   */
  async prefetchResponses(questions: string[]): Promise<PrefetchResult> {
    if (!this.contextGenerator) {
      return {
        questions: [],
        cacheWarmed: 0,
        latencyMs: 0,
        interrupted: false,
      };
    }

    if (this.prefetchInProgress) {
      this.abortPrefetching();
    }

    const startTime = Date.now();
    this.prefetchInProgress = true;
    this.abortController = new AbortController();

    let cacheWarmed = 0;
    const prefetchedQuestions: string[] = [];

    try {
      for (const question of questions) {
        // Check if aborted
        if (this.abortController.signal.aborted || this.isUserSpeaking) {
          break;
        }

        // Skip if already cached
        const existing = this.prefetchCache.get(question);
        if (existing) {
          continue;
        }

        try {
          const { context, embedding } =
            await this.contextGenerator(question);

          this.prefetchCache.set(question, {
            question,
            context,
            embedding,
            confidence: 0.7,
            prefetchedAt: Date.now(),
          });

          cacheWarmed++;
          prefetchedQuestions.push(question);
        } catch {
          // Silently skip failed prefetches
          console.error(
            `PredictivePrefetcher: Failed to prefetch for "${question.slice(0, 50)}..."`
          );
        }
      }
    } finally {
      this.prefetchInProgress = false;
    }

    return {
      questions: prefetchedQuestions,
      cacheWarmed,
      latencyMs: Date.now() - startTime,
      interrupted: this.abortController?.signal.aborted || false,
    };
  }

  /**
   * Get prefetched context for a question.
   */
  getPrefetchedContext(
    question: string,
    embedding?: number[]
  ): PrefetchedContext | null {
    const result = this.prefetchCache.get(question, embedding);
    return result?.value || null;
  }

  /**
   * Start background prefetching based on current context.
   */
  async startPrefetching(): Promise<PrefetchResult> {
    if (this.isUserSpeaking) {
      return {
        questions: [],
        cacheWarmed: 0,
        latencyMs: 0,
        interrupted: true,
      };
    }

    const context: PrefetchContext = {
      phase: this.currentPhase,
      recentQuestions: this.recentQuestions,
      topics: Array.from(this.activeTopics),
    };

    const predictions = this.predictNextQuestions(context);
    const questions = predictions.map((p) => p.question);

    return this.prefetchResponses(questions);
  }

  /**
   * Abort ongoing prefetching.
   */
  abortPrefetching(): void {
    this.abortController?.abort();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats() {
    return this.prefetchCache.getStats();
  }

  /**
   * Clear prefetch cache.
   */
  clearCache(): void {
    this.prefetchCache.clear();
  }

  /**
   * Extract topics from question text.
   */
  private extractTopics(question: string): void {
    const text = question.toLowerCase();

    const topicKeywords: Record<string, string[]> = {
      architecture: ['architecture', 'system', 'design', 'scale'],
      database: ['database', 'sql', 'nosql', 'data', 'query'],
      api: ['api', 'rest', 'graphql', 'endpoint'],
      testing: ['test', 'testing', 'coverage', 'qa'],
      leadership: ['team', 'lead', 'manage', 'mentor'],
      conflict: ['conflict', 'disagree', 'challenge', 'difficult'],
    };

    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some((kw) => text.includes(kw))) {
        this.activeTopics.add(topic);
      }
    }
  }
}

// Default instance
export const predictivePrefetcher = new PredictivePrefetcher();
