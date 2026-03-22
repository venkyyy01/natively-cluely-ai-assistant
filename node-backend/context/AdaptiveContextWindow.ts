// node-backend/context/AdaptiveContextWindow.ts

/**
 * AdaptiveContextWindow - Dynamically sizes context window based on constraints.
 *
 * Features:
 * - Sliding window with importance weighting
 * - Adjusts based on question complexity
 * - Respects token budget and latency targets
 * - Balances recency vs relevance
 *
 * Design: Works with any OpenAI-compatible LLM API.
 */

/**
 * Context entry with metadata.
 */
export interface ContextEntry {
  /** Unique identifier */
  id: string;
  /** Text content */
  content: string;
  /** Entry type */
  type: 'question' | 'answer' | 'context' | 'system';
  /** Timestamp */
  timestamp: number;
  /** Precomputed embedding */
  embedding?: number[];
  /** Interview phase when this was created */
  phase?: string;
  /** Estimated token count */
  tokenCount?: number;
  /** Importance score (0-1) */
  importance?: number;
}

/**
 * Configuration for context selection.
 */
export interface ContextSelectionConfig {
  /** Maximum token budget */
  tokenBudget: number;
  /** Weight for recency (0-1) */
  recencyWeight: number;
  /** Weight for semantic similarity (0-1) */
  semanticWeight: number;
  /** Weight for phase alignment (0-1) */
  phaseAlignmentWeight: number;
  /** Weight for importance score (0-1) */
  importanceWeight: number;
  /** Target response latency in ms (affects budget) */
  latencyTargetMs?: number;
}

/**
 * Result of context optimization.
 */
export interface OptimizedContext {
  /** Selected context entries */
  entries: ContextEntry[];
  /** Formatted context string */
  contextString: string;
  /** Total tokens used */
  totalTokens: number;
  /** Token budget used */
  budgetUsed: number;
  /** Window size stats */
  windowStats: {
    consideredCount: number;
    selectedCount: number;
    recencyRange: { oldest: number; newest: number };
    averageScore: number;
  };
  /** Optimization latency in ms */
  latencyMs: number;
}

/**
 * Question complexity assessment.
 */
export interface ComplexityAssessment {
  /** Complexity level */
  level: 'simple' | 'moderate' | 'complex';
  /** Numeric score (0-1) */
  score: number;
  /** Factors contributing to complexity */
  factors: string[];
  /** Recommended token budget multiplier */
  budgetMultiplier: number;
}

const DEFAULT_CONFIG: ContextSelectionConfig = {
  tokenBudget: 2000,
  recencyWeight: 0.25,
  semanticWeight: 0.35,
  phaseAlignmentWeight: 0.2,
  importanceWeight: 0.2,
};

// Tokens per character (rough estimate)
const TOKENS_PER_CHAR = 0.25;

// Complexity indicators
const COMPLEX_INDICATORS = [
  'design',
  'architect',
  'scale',
  'million',
  'system',
  'tradeoff',
  'compare',
  'explain',
  'how would you',
  'walk me through',
];

const SIMPLE_INDICATORS = [
  'what is',
  'define',
  'yes or no',
  'which',
  'when',
  'where',
];

export class AdaptiveContextWindow {
  private config: ContextSelectionConfig;
  private currentPhase: string = 'unknown';

  constructor(config?: Partial<ContextSelectionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the current interview phase.
   */
  setPhase(phase: string): void {
    this.currentPhase = phase;
  }

  /**
   * Optimize context selection for a question.
   *
   * @param context - Available context entries
   * @param question - The current question
   * @param budget - Token budget (overrides config if provided)
   * @param queryEmbedding - Optional query embedding for semantic matching
   * @returns Optimized context within budget
   */
  optimize(
    context: ContextEntry[],
    question: string,
    budget?: number,
    queryEmbedding?: number[]
  ): OptimizedContext {
    const startTime = Date.now();

    // Assess question complexity
    const complexity = this.assessComplexity(question);

    // Adjust budget based on complexity
    const baseBudget = budget ?? this.config.tokenBudget;
    const adjustedBudget = Math.floor(baseBudget * complexity.budgetMultiplier);

    // Further adjust for latency if target specified
    const finalBudget = this.adjustForLatency(
      adjustedBudget,
      this.config.latencyTargetMs
    );

    // Score all entries
    const scored = this.scoreEntries(
      context,
      question,
      queryEmbedding
    );

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Select within budget using sliding window
    const selected = this.selectWithinBudget(scored, finalBudget);

    // Re-sort selected by timestamp for coherent context
    selected.sort((a, b) => a.entry.timestamp - b.entry.timestamp);

    // Build context string
    const contextString = this.formatContextString(
      selected.map((s) => s.entry)
    );

    // Calculate stats
    const totalTokens = selected.reduce(
      (sum, s) =>
        sum + (s.entry.tokenCount || this.estimateTokens(s.entry.content)),
      0
    );

    const timestamps = selected.map((s) => s.entry.timestamp);

    return {
      entries: selected.map((s) => s.entry),
      contextString,
      totalTokens,
      budgetUsed: finalBudget,
      windowStats: {
        consideredCount: context.length,
        selectedCount: selected.length,
        recencyRange: {
          oldest: Math.min(...timestamps, Date.now()),
          newest: Math.max(...timestamps, Date.now()),
        },
        averageScore:
          selected.length > 0
            ? selected.reduce((sum, s) => sum + s.score, 0) / selected.length
            : 0,
      },
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Assess question complexity.
   */
  assessComplexity(question: string): ComplexityAssessment {
    const lower = question.toLowerCase();
    const factors: string[] = [];
    let score = 0.5; // Start at moderate

    // Check for complex indicators
    for (const indicator of COMPLEX_INDICATORS) {
      if (lower.includes(indicator)) {
        score += 0.1;
        factors.push(`Contains "${indicator}"`);
      }
    }

    // Check for simple indicators
    for (const indicator of SIMPLE_INDICATORS) {
      if (lower.includes(indicator)) {
        score -= 0.1;
        factors.push(`Simple pattern: "${indicator}"`);
      }
    }

    // Question length affects complexity
    if (question.length > 150) {
      score += 0.1;
      factors.push('Long question');
    } else if (question.length < 30) {
      score -= 0.1;
      factors.push('Short question');
    }

    // Multiple question marks suggest compound question
    const questionMarks = (question.match(/\?/g) || []).length;
    if (questionMarks > 1) {
      score += 0.1;
      factors.push('Multiple parts');
    }

    // Clamp score
    score = Math.max(0, Math.min(1, score));

    // Determine level
    let level: 'simple' | 'moderate' | 'complex';
    let budgetMultiplier: number;

    if (score < 0.35) {
      level = 'simple';
      budgetMultiplier = 0.7;
    } else if (score > 0.65) {
      level = 'complex';
      budgetMultiplier = 1.3;
    } else {
      level = 'moderate';
      budgetMultiplier = 1.0;
    }

    return { level, score, factors, budgetMultiplier };
  }

  /**
   * Score context entries for relevance.
   */
  private scoreEntries(
    entries: ContextEntry[],
    question: string,
    queryEmbedding?: number[]
  ): Array<{ entry: ContextEntry; score: number }> {
    if (entries.length === 0) return [];

    const now = Date.now();
    const maxAge = Math.max(
      ...entries.map((e) => now - e.timestamp),
      1
    );

    return entries.map((entry) => {
      // Recency score (newer = higher)
      const age = now - entry.timestamp;
      const recencyScore = 1 - age / maxAge;

      // Semantic score
      let semanticScore = 0;
      if (queryEmbedding && entry.embedding) {
        semanticScore = this.cosineSimilarity(queryEmbedding, entry.embedding);
      } else {
        // Fallback: keyword overlap
        semanticScore = this.keywordOverlap(question, entry.content);
      }

      // Phase alignment score
      const phaseScore =
        entry.phase === this.currentPhase
          ? 1.0
          : entry.phase
            ? 0.5
            : 0.3;

      // Importance score
      const importanceScore = entry.importance ?? 0.5;

      // Weighted combination
      const score =
        this.config.recencyWeight * recencyScore +
        this.config.semanticWeight * semanticScore +
        this.config.phaseAlignmentWeight * phaseScore +
        this.config.importanceWeight * importanceScore;

      return { entry, score };
    });
  }

  /**
   * Select entries within token budget.
   */
  private selectWithinBudget(
    scored: Array<{ entry: ContextEntry; score: number }>,
    budget: number
  ): Array<{ entry: ContextEntry; score: number }> {
    const selected: Array<{ entry: ContextEntry; score: number }> = [];
    let usedTokens = 0;

    for (const item of scored) {
      const tokens =
        item.entry.tokenCount || this.estimateTokens(item.entry.content);

      if (usedTokens + tokens <= budget) {
        selected.push({
          entry: { ...item.entry, tokenCount: tokens },
          score: item.score,
        });
        usedTokens += tokens;
      }

      // Early exit if we've used 95% of budget
      if (usedTokens >= budget * 0.95) break;
    }

    return selected;
  }

  /**
   * Format context entries into a string.
   */
  private formatContextString(entries: ContextEntry[]): string {
    const parts: string[] = [];

    for (const entry of entries) {
      switch (entry.type) {
        case 'question':
          parts.push(`Q: ${entry.content}`);
          break;
        case 'answer':
          parts.push(`A: ${entry.content}`);
          break;
        case 'context':
          parts.push(`[Context] ${entry.content}`);
          break;
        case 'system':
          parts.push(`[System] ${entry.content}`);
          break;
        default:
          parts.push(entry.content);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Adjust budget based on latency target.
   */
  private adjustForLatency(budget: number, targetMs?: number): number {
    if (!targetMs) return budget;

    // Rough estimate: ~20 tokens/second generation
    // If target is 2000ms, that's ~40 tokens output
    // Input tokens should be proportional

    // Very rough heuristic
    if (targetMs < 500) {
      return Math.floor(budget * 0.6);
    } else if (targetMs < 1000) {
      return Math.floor(budget * 0.8);
    }

    return budget;
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * Compute keyword overlap score.
   */
  private keywordOverlap(text1: string, text2: string): number {
    const words1 = new Set(
      text1
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );

    const words2 = new Set(
      text2
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );

    if (words1.size === 0 || words2.size === 0) return 0;

    let overlap = 0;
    for (const word of words1) {
      if (words2.has(word)) overlap++;
    }

    return overlap / Math.max(words1.size, words2.size);
  }

  /**
   * Estimate token count.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length * TOKENS_PER_CHAR);
  }

  /**
   * Update configuration.
   */
  setConfig(config: Partial<ContextSelectionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): ContextSelectionConfig {
    return { ...this.config };
  }
}

// Default instance
export const adaptiveContextWindow = new AdaptiveContextWindow();
