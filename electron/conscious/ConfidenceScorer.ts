// electron/conscious/ConfidenceScorer.ts
import { 
  ConversationThread, 
  ConfidenceScore, 
  CONFIDENCE_WEIGHTS,
  InterviewPhase,
  RESUME_THRESHOLD 
} from './types';

const EXPLICIT_RESUME_MARKERS = [
  /back to/i,
  /as I was saying/i,
  /going back/i,
  /returning to/i,
  /where were we/i,
  /continuing with/i,
  /let's continue/i,
  /about that.*earlier/i,
  /picking up/i,
  /resume/i,
];

const TOPIC_SHIFT_MARKERS = [
  'new question',
  'different topic', 
  "let's talk about",
  'moving on',
  'switch gears',
  'change topic',
  'new subject',
];

export class ConfidenceScorer {
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  calculateResumeConfidence(
    transcript: string,
    thread: ConversationThread,
    currentPhase: InterviewPhase,
    sttConfidence: number = 0.9,
    queryEmbedding?: number[]
  ): ConfidenceScore {
    const now = Date.now();
    const lowerTranscript = transcript.toLowerCase();
    
    // BM25 keyword overlap
    const bm25Score = this.calculateBM25(transcript, thread.resumeKeywords);
    
    // Explicit resume markers
    const hasExplicitMarker = EXPLICIT_RESUME_MARKERS.some(p => p.test(transcript));
    const explicitMarkers = hasExplicitMarker ? 1.0 : 0.0;
    
    // Temporal decay (exponential decay over TTL)
    const timeSinceSuspend = now - (thread.suspendedAt || now);
    const temporalDecay = Math.exp(-timeSinceSuspend / (thread.ttlMs / 2));
    
    // Phase alignment
    const phaseAlignment = currentPhase === thread.phase ? 1.0 : 0.3;
    
    // STT quality factor
    const sttQuality = sttConfidence;
    
    // Topic shift penalty
    const hasTopicShift = TOPIC_SHIFT_MARKERS.some(marker => 
      lowerTranscript.includes(marker)
    );
    const topicShiftPenalty = hasTopicShift ? 1.0 : 0.0;
    
    // Interruption recency penalty
    const recentInterruption = thread.interruptedBy && 
      lowerTranscript.includes(thread.interruptedBy.toLowerCase());
    const interruptionRecency = recentInterruption ? 1.0 : 0.0;
    
    // Embedding score (if available)
    const embeddingScore = thread.embedding && queryEmbedding
      ? this.cosineSimilarity(thread.embedding, queryEmbedding)
      : 0;
    
    // Calculate weighted sum
    const total = Math.max(0, Math.min(1,
      (bm25Score * CONFIDENCE_WEIGHTS.bm25) +
      (embeddingScore * CONFIDENCE_WEIGHTS.embedding) +
      (explicitMarkers * CONFIDENCE_WEIGHTS.explicitMarkers) +
      (temporalDecay * CONFIDENCE_WEIGHTS.temporalDecay) +
      (phaseAlignment * CONFIDENCE_WEIGHTS.phaseAlignment) +
      (sttQuality * CONFIDENCE_WEIGHTS.sttQuality) +
      (topicShiftPenalty * CONFIDENCE_WEIGHTS.topicShiftPenalty) +
      (interruptionRecency * CONFIDENCE_WEIGHTS.interruptionRecency)
    ));
    
    return {
      bm25Score,
      embeddingScore,
      explicitMarkers,
      temporalDecay,
      phaseAlignment,
      sttQuality,
      topicShiftPenalty,
      interruptionRecency,
      total,
    };
  }
  
  /**
   * Calculate BM25 relevance score between query and document keywords.
   * 
   * BM25 formula: score = Σ IDF(qi) * (f(qi,D) * (k1 + 1)) / (f(qi,D) + k1 * (1 - b + b * |D|/avgdl))
   * 
   * Where:
   * - IDF(qi) = log((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
   * - f(qi,D) = term frequency of qi in document D
   * - N = total documents (we assume small corpus of 3 suspended threads)
   * - n(qi) = number of documents containing qi (assume 1 for matching terms)
   * - k1 = term frequency saturation parameter (typically 1.2-2.0)
   * - b = length normalization parameter (typically 0.75)
   * - |D| = document length
   * - avgdl = average document length
   */
  private calculateBM25(
    query: string,
    documentKeywords: string[],
    k1: number = 1.5,
    b: number = 0.75
  ): number {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0 || documentKeywords.length === 0) return 0;
    
    const N = 3; // Assume small corpus of suspended threads
    const avgDocLength = 10; // Average expected keywords per thread
    const docLength = documentKeywords.length;
    const docKeywordsLower = documentKeywords.map(k => k.toLowerCase());
    
    let score = 0;
    
    for (const term of queryTerms) {
      // Calculate term frequency in this document
      const tf = docKeywordsLower.filter(k => 
        k.includes(term) || term.includes(k)
      ).length;
      
      if (tf === 0) continue;
      
      // IDF: assume df=1 for matching terms (term appears in 1 of N docs)
      // This gives higher weight to rarer terms
      const df = 1;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      
      // BM25 term weight with length normalization
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
      
      score += idf * (numerator / denominator);
    }
    
    // Normalize by query length to get a 0-1 range
    return Math.min(1, score / queryTerms.length);
  }
  
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }
  
  shouldResume(confidence: ConfidenceScore): boolean {
    return confidence.total >= RESUME_THRESHOLD;
  }
}
