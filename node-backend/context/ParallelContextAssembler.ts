// node-backend/context/ParallelContextAssembler.ts

/**
 * ParallelContextAssembler - Assembles context from multiple sources in parallel.
 *
 * Features:
 * - Parallel fetching from multiple context sources
 * - BM25 + semantic scoring for chunk ranking
 * - Token budget management
 * - Priority-based source selection
 *
 * Design: Works with any OpenAI-compatible LLM API.
 */

/**
 * Types of context sources available.
 */
export type ContextType = 'transcript' | 'knowledge' | 'conversation' | 'system';

/**
 * A chunk of context with metadata.
 */
export interface ContextChunk {
  /** Unique identifier for this chunk */
  id: string;
  /** The text content */
  content: string;
  /** Source type */
  type: ContextType;
  /** Timestamp when this chunk was created */
  timestamp: number;
  /** Precomputed embedding (if available) */
  embedding?: number[];
  /** Token count estimate */
  tokenCount?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A source of context chunks.
 */
export interface ContextSource {
  /** Type of this source */
  type: ContextType;
  /** Async function to fetch chunks from this source */
  fetch: () => Promise<ContextChunk[]>;
  /** Priority (higher = more important, fetched first) */
  priority: number;
  /** Maximum chunks to include from this source */
  maxChunks?: number;
}

/**
 * A scored context chunk.
 */
export interface ScoredChunk extends ContextChunk {
  /** Combined relevance score */
  score: number;
  /** BM25 score component */
  bm25Score: number;
  /** Semantic similarity score component */
  semanticScore: number;
}

/**
 * Result of context assembly.
 */
export interface AssembledContext {
  /** Selected chunks within budget */
  chunks: ScoredChunk[];
  /** Total tokens used */
  totalTokens: number;
  /** Token budget provided */
  budget: number;
  /** Chunks by source type */
  byType: Record<ContextType, number>;
  /** Assembly latency in ms */
  latencyMs: number;
  /** Number of chunks considered */
  consideredCount: number;
  /** Number of chunks selected */
  selectedCount: number;
}

/**
 * Configuration for scoring weights.
 */
export interface ScoringConfig {
  /** Weight for BM25 score (0-1) */
  bm25Weight: number;
  /** Weight for semantic similarity (0-1) */
  semanticWeight: number;
  /** Weight for recency (0-1) */
  recencyWeight: number;
  /** Weight for source priority (0-1) */
  priorityWeight: number;
}

/**
 * Result from fetching a single source.
 */
interface FetchResult {
  type: ContextType;
  chunks: ContextChunk[];
  priority: number;
  error?: Error;
}

const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  bm25Weight: 0.35,
  semanticWeight: 0.35,
  recencyWeight: 0.15,
  priorityWeight: 0.15,
};

// Average tokens per character (rough estimate)
const TOKENS_PER_CHAR = 0.25;

export class ParallelContextAssembler {
  private scoringConfig: ScoringConfig;

  // BM25 parameters
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(config?: Partial<ScoringConfig>) {
    this.scoringConfig = { ...DEFAULT_SCORING_CONFIG, ...config };
  }

  /**
   * Assemble context from multiple sources in parallel.
   *
   * @param sources - Array of context sources to fetch from
   * @param budget - Maximum token budget
   * @param query - Query string for relevance scoring
   * @param queryEmbedding - Optional precomputed query embedding
   * @returns Assembled context within budget
   */
  async assemble(
    sources: ContextSource[],
    budget: number,
    query: string,
    queryEmbedding?: number[]
  ): Promise<AssembledContext> {
    const startTime = Date.now();

    // Sort sources by priority (highest first)
    const sortedSources = [...sources].sort((a, b) => b.priority - a.priority);

    // Fetch from all sources in parallel
    const fetchPromises = sortedSources.map((source) =>
      this.fetchSource(source)
    );

    const results = await Promise.allSettled(fetchPromises);

    // Collect all chunks
    const allChunks: Array<ContextChunk & { sourcePriority: number }> = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { chunks, priority } = result.value;
        for (const chunk of chunks) {
          allChunks.push({ ...chunk, sourcePriority: priority });
        }
      }
    }

    // Score all chunks
    const scoredChunks = this.scoreChunks(
      allChunks,
      query,
      queryEmbedding
    );

    // Sort by score descending
    scoredChunks.sort((a, b) => b.score - a.score);

    // Select chunks within budget
    const selected = this.selectWithinBudget(scoredChunks, budget);

    // Count by type
    const byType: Record<ContextType, number> = {
      transcript: 0,
      knowledge: 0,
      conversation: 0,
      system: 0,
    };

    let totalTokens = 0;
    for (const chunk of selected) {
      byType[chunk.type]++;
      totalTokens += chunk.tokenCount || this.estimateTokens(chunk.content);
    }

    return {
      chunks: selected,
      totalTokens,
      budget,
      byType,
      latencyMs: Date.now() - startTime,
      consideredCount: allChunks.length,
      selectedCount: selected.length,
    };
  }

  /**
   * Fetch chunks from a single source with error handling.
   */
  private async fetchSource(source: ContextSource): Promise<FetchResult> {
    try {
      const chunks = await source.fetch();

      // Apply max chunks limit if specified
      const limitedChunks = source.maxChunks
        ? chunks.slice(0, source.maxChunks)
        : chunks;

      return {
        type: source.type,
        chunks: limitedChunks,
        priority: source.priority,
      };
    } catch (error) {
      console.error(
        `ParallelContextAssembler: Failed to fetch from ${source.type}:`,
        error
      );
      return {
        type: source.type,
        chunks: [],
        priority: source.priority,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Score all chunks for relevance.
   */
  private scoreChunks(
    chunks: Array<ContextChunk & { sourcePriority: number }>,
    query: string,
    queryEmbedding?: number[]
  ): ScoredChunk[] {
    if (chunks.length === 0) return [];

    // Compute BM25 scores
    const bm25Scores = this.computeBM25Scores(
      query,
      chunks.map((c) => c.content)
    );

    // Normalize scores
    const maxBM25 = Math.max(...bm25Scores, 0.001);
    const maxPriority = Math.max(...chunks.map((c) => c.sourcePriority), 1);
    const now = Date.now();
    const maxAge = Math.max(
      ...chunks.map((c) => now - c.timestamp),
      1
    );

    return chunks.map((chunk, i) => {
      // BM25 score (normalized)
      const bm25Score = bm25Scores[i] / maxBM25;

      // Semantic score (if embeddings available)
      let semanticScore = 0;
      if (queryEmbedding && chunk.embedding) {
        semanticScore = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      }

      // Recency score (newer = higher)
      const age = now - chunk.timestamp;
      const recencyScore = 1 - age / maxAge;

      // Priority score (normalized)
      const priorityScore = chunk.sourcePriority / maxPriority;

      // Weighted combination
      const score =
        this.scoringConfig.bm25Weight * bm25Score +
        this.scoringConfig.semanticWeight * semanticScore +
        this.scoringConfig.recencyWeight * recencyScore +
        this.scoringConfig.priorityWeight * priorityScore;

      const { sourcePriority, ...rest } = chunk;
      return {
        ...rest,
        score,
        bm25Score,
        semanticScore,
      };
    });
  }

  /**
   * Compute BM25 scores for a query against multiple documents.
   */
  private computeBM25Scores(query: string, documents: string[]): number[] {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) {
      return documents.map(() => 0);
    }

    // Compute document frequencies
    const docFreqs = new Map<string, number>();
    for (const doc of documents) {
      const docTerms = new Set(this.tokenize(doc));
      for (const term of docTerms) {
        docFreqs.set(term, (docFreqs.get(term) || 0) + 1);
      }
    }

    // Average document length
    const avgDocLen =
      documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length;

    // Compute BM25 for each document
    return documents.map((doc) => {
      const docTerms = this.tokenize(doc);
      const termFreqs = new Map<string, number>();
      for (const term of docTerms) {
        termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
      }

      let score = 0;
      const docLen = doc.length;
      const N = documents.length;

      for (const term of queryTerms) {
        const tf = termFreqs.get(term) || 0;
        if (tf === 0) continue;

        const df = docFreqs.get(term) || 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        const tfNorm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen)));

        score += idf * tfNorm;
      }

      return score;
    });
  }

  /**
   * Simple tokenization for BM25.
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
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
   * Select chunks within token budget using greedy selection.
   */
  private selectWithinBudget(
    chunks: ScoredChunk[],
    budget: number
  ): ScoredChunk[] {
    const selected: ScoredChunk[] = [];
    let usedTokens = 0;

    for (const chunk of chunks) {
      const tokens = chunk.tokenCount || this.estimateTokens(chunk.content);

      if (usedTokens + tokens <= budget) {
        selected.push({ ...chunk, tokenCount: tokens });
        usedTokens += tokens;
      }

      // Stop early if we've filled the budget
      if (usedTokens >= budget * 0.95) break;
    }

    return selected;
  }

  /**
   * Estimate token count for text.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length * TOKENS_PER_CHAR);
  }

  /**
   * Update scoring configuration.
   */
  setScoringConfig(config: Partial<ScoringConfig>): void {
    this.scoringConfig = { ...this.scoringConfig, ...config };
  }
}

// Default instance
export const contextAssembler = new ParallelContextAssembler();
