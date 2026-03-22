// node-backend/workers/ScoringWorker.ts

/**
 * ScoringWorker - BM25 scoring implementation.
 *
 * In production, this would run in a Worker Thread for better performance.
 * For now, this provides the scoring algorithm that can be used directly
 * or wrapped in a worker thread.
 *
 * Features:
 * - BM25 scoring algorithm
 * - Batch processing support
 * - Configurable parameters (k1, b)
 * - Efficient document indexing
 *
 * Design: Works with any OpenAI-compatible LLM API.
 */

/**
 * A scored document result.
 */
export interface ScoredDocument {
  /** Original document index */
  index: number;
  /** Document content */
  content: string;
  /** BM25 score */
  score: number;
  /** Normalized score (0-1) */
  normalizedScore: number;
  /** Individual term scores */
  termScores?: Map<string, number>;
}

/**
 * Configuration for BM25 scoring.
 */
export interface BM25Config {
  /** Term frequency saturation parameter (default: 1.5) */
  k1: number;
  /** Document length normalization (default: 0.75) */
  b: number;
  /** Minimum word length to consider */
  minWordLength: number;
  /** Stop words to filter */
  stopWords?: Set<string>;
}

/**
 * Request for batch scoring.
 */
export interface BatchScoreRequest {
  /** Query string */
  query: string;
  /** Documents to score */
  documents: string[];
  /** Number of top results to return (0 = all) */
  topK?: number;
  /** Include term-level scores */
  includeTermScores?: boolean;
}

/**
 * Response from batch scoring.
 */
export interface BatchScoreResponse {
  /** Scored documents, sorted by score descending */
  results: ScoredDocument[];
  /** Query terms used */
  queryTerms: string[];
  /** Total documents scored */
  totalDocuments: number;
  /** Scoring latency in ms */
  latencyMs: number;
}

/**
 * Document index for efficient scoring.
 */
interface DocumentIndex {
  /** Original documents */
  documents: string[];
  /** Tokenized documents */
  tokenized: string[][];
  /** Document frequencies */
  docFreqs: Map<string, number>;
  /** Average document length */
  avgDocLength: number;
  /** Total documents */
  N: number;
}

const DEFAULT_CONFIG: BM25Config = {
  k1: 1.5,
  b: 0.75,
  minWordLength: 2,
  stopWords: new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'must', 'shall',
    'can', 'of', 'at', 'by', 'for', 'with', 'about', 'against',
    'between', 'into', 'through', 'during', 'before', 'after',
    'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out',
    'on', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all',
    'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
    'very', 's', 't', 'just', 'don', 'now', 'and', 'but', 'or',
    'if', 'because', 'as', 'until', 'while', 'this', 'that', 'it',
    'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him',
    'his', 'she', 'her', 'they', 'them', 'their', 'what', 'which',
  ]),
};

export class ScoringWorker {
  private config: BM25Config;
  private documentIndex: DocumentIndex | null = null;

  constructor(config?: Partial<BM25Config>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Score documents against a query using BM25.
   */
  async scoreBM25(
    query: string,
    documents: string[]
  ): Promise<ScoredDocument[]> {
    const response = await this.batchScore({
      query,
      documents,
      topK: 0, // Return all
      includeTermScores: false,
    });

    return response.results;
  }

  /**
   * Batch score with full options.
   */
  async batchScore(request: BatchScoreRequest): Promise<BatchScoreResponse> {
    const startTime = Date.now();

    const {
      query,
      documents,
      topK = 0,
      includeTermScores = false,
    } = request;

    // Tokenize query
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0 || documents.length === 0) {
      return {
        results: documents.map((content, index) => ({
          index,
          content,
          score: 0,
          normalizedScore: 0,
        })),
        queryTerms: [],
        totalDocuments: documents.length,
        latencyMs: Date.now() - startTime,
      };
    }

    // Build document index
    const index = this.buildIndex(documents);

    // Score each document
    const scored: ScoredDocument[] = [];
    let maxScore = 0;

    for (let i = 0; i < documents.length; i++) {
      const { score, termScores } = this.scoreDocument(
        queryTerms,
        index,
        i,
        includeTermScores
      );

      if (score > maxScore) maxScore = score;

      scored.push({
        index: i,
        content: documents[i],
        score,
        normalizedScore: 0, // Set after all scored
        termScores: includeTermScores ? termScores : undefined,
      });
    }

    // Normalize scores
    if (maxScore > 0) {
      for (const doc of scored) {
        doc.normalizedScore = doc.score / maxScore;
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply topK if specified
    const results = topK > 0 ? scored.slice(0, topK) : scored;

    return {
      results,
      queryTerms,
      totalDocuments: documents.length,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Build document index for efficient scoring.
   */
  private buildIndex(documents: string[]): DocumentIndex {
    const tokenized = documents.map((doc) => this.tokenize(doc));
    const docFreqs = new Map<string, number>();

    // Compute document frequencies
    for (const docTerms of tokenized) {
      const uniqueTerms = new Set(docTerms);
      for (const term of uniqueTerms) {
        docFreqs.set(term, (docFreqs.get(term) || 0) + 1);
      }
    }

    // Average document length (in characters)
    const avgDocLength =
      documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length;

    return {
      documents,
      tokenized,
      docFreqs,
      avgDocLength,
      N: documents.length,
    };
  }

  /**
   * Score a single document against query terms.
   */
  private scoreDocument(
    queryTerms: string[],
    index: DocumentIndex,
    docIndex: number,
    includeTermScores: boolean
  ): { score: number; termScores?: Map<string, number> } {
    const docTerms = index.tokenized[docIndex];
    const docLength = index.documents[docIndex].length;
    const { k1, b } = this.config;
    const { avgDocLength, N, docFreqs } = index;

    // Compute term frequencies in document
    const termFreqs = new Map<string, number>();
    for (const term of docTerms) {
      termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
    }

    let score = 0;
    const termScores = includeTermScores
      ? new Map<string, number>()
      : undefined;

    for (const term of queryTerms) {
      const tf = termFreqs.get(term) || 0;
      if (tf === 0) continue;

      const df = docFreqs.get(term) || 0;

      // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      // TF normalization
      const tfNorm =
        (tf * (k1 + 1)) /
        (tf + k1 * (1 - b + b * (docLength / avgDocLength)));

      const termScore = idf * tfNorm;
      score += termScore;

      if (termScores) {
        termScores.set(term, termScore);
      }
    }

    return { score, termScores };
  }

  /**
   * Tokenize text into terms.
   */
  private tokenize(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= this.config.minWordLength);

    // Filter stop words
    if (this.config.stopWords) {
      return words.filter((word) => !this.config.stopWords!.has(word));
    }

    return words;
  }

  /**
   * Get top K documents by score.
   */
  async getTopK(
    query: string,
    documents: string[],
    k: number
  ): Promise<ScoredDocument[]> {
    const response = await this.batchScore({
      query,
      documents,
      topK: k,
    });

    return response.results;
  }

  /**
   * Filter documents above score threshold.
   */
  async filterByThreshold(
    query: string,
    documents: string[],
    threshold: number
  ): Promise<ScoredDocument[]> {
    const all = await this.scoreBM25(query, documents);
    return all.filter((doc) => doc.normalizedScore >= threshold);
  }

  /**
   * Update configuration.
   */
  setConfig(config: Partial<BM25Config>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): BM25Config {
    return { ...this.config };
  }
}

// Default instance
export const scoringWorker = new ScoringWorker();

// Worker thread entry point (for future use with worker_threads)
// This would be used when running in a Worker Thread context
// if (!isMainThread && parentPort) {
//   const worker = new ScoringWorker();
//
//   parentPort.on('message', async (request: BatchScoreRequest) => {
//     const response = await worker.batchScore(request);
//     parentPort!.postMessage(response);
//   });
// }
