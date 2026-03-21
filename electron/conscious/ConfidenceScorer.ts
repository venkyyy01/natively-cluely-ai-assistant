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
  calculateResumeConfidence(
    transcript: string,
    thread: ConversationThread,
    currentPhase: InterviewPhase,
    sttConfidence: number = 0.9
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
    
    // Embedding score placeholder (0 if not available)
    const embeddingScore = 0;
    
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
  
  private calculateBM25(
    query: string,
    documentKeywords: string[],
    k1: number = 1.5,
    b: number = 0.75
  ): number {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0 || documentKeywords.length === 0) return 0;
    
    const avgDocLength = 10;
    const docLength = documentKeywords.length;
    
    let score = 0;
    
    for (const term of queryTerms) {
      const tf = documentKeywords.filter(k => 
        k.toLowerCase().includes(term.toLowerCase()) ||
        term.toLowerCase().includes(k.toLowerCase())
      ).length;
      
      if (tf === 0) continue;
      
      // Simplified IDF
      const idf = Math.log(1 + (3 - tf + 0.5) / (tf + 0.5));
      
      // BM25 term score
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
      
      score += idf * (numerator / denominator);
    }
    
    // Normalize to 0-1 range
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
