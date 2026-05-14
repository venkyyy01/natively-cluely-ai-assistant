import { pipeline } from '@xenova/transformers';
import type { ReasoningThread } from '../ConsciousMode';
import { registerEmbeddingPipeline } from './embeddingPipelineRegistry';

export class SemanticThreadMatcher {
  private embedder: any | null = null;
  private embeddingCache = new Map<string, number[]>();
  private inFlightEmbeddings = new Map<string, Promise<number[]>>();
  private modelLoadPromise: Promise<void> | null = null;
  private modelLoadError = false;
  private disposed = false;
  private readonly unregister: () => void;

  private static readonly THRESHOLD = 0.62;
  private static readonly MIN_WORD_COUNT = 4;

  constructor() {
    // Lazy load model on first use
    // Register for graceful shutdown so the xenova-bundled InferenceSession
    // is released before V8 finalizers run (see embeddingPipelineRegistry.ts
    // and crashreport.md incident FEBA7065 for context).
    this.unregister = registerEmbeddingPipeline(this);
  }

  private async ensureModelLoaded(): Promise<void> {
    // R2: refuse to (re)start model load after dispose. Without this guard a
    // stale audio callback that fires after `dispose()` can spawn a fresh
    // pipeline that is NOT in the registry, leak past the shutdown hook, and
    // re-introduce the destructor SIGTRAP we were trying to eliminate.
    if (this.disposed) {
      throw new Error('SemanticThreadMatcher: disposed');
    }

    if (this.embedder) {
      return;
    }

    if (this.modelLoadError) {
      throw new Error('SBERT model failed to load, semantic thread continuation disabled');
    }

    if (this.modelLoadPromise) {
      return this.modelLoadPromise;
    }

    this.modelLoadPromise = (async () => {
      try {
        const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        // If `dispose()` raced us, drop the freshly-created pipeline rather
        // than installing it on a tombstoned instance (R1). Dispose it
        // inline so its native session is released immediately.
        if (this.disposed) {
          try {
            if (typeof (embedder as any)?.dispose === 'function') {
              await (embedder as any).dispose();
            }
          } catch {
            // already-disposed instance, nothing to do
          }
          return;
        }
        this.embedder = embedder;
      } catch (error) {
        console.warn('[SemanticThreadMatcher] Failed to load SBERT model:', error);
        this.modelLoadError = true;
        throw error;
      }
    })();

    return this.modelLoadPromise;
  }

  private async getEmbedding(text: string): Promise<number[]> {
    const cacheKey = text.toLowerCase().trim();
    
    // Check cache
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Check if already in flight
    const inFlight = this.inFlightEmbeddings.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    // Compute embedding
    const promise = (async () => {
      await this.ensureModelLoaded();
      if (!this.embedder) {
        throw new Error('Embedder not initialized');
      }

      const output = await this.embedder(text, {
        pooling: 'mean',
        normalize: true,
      });

      const embedding = Array.from(output.data) as number[];
      this.embeddingCache.set(cacheKey, embedding);
      this.inFlightEmbeddings.delete(cacheKey);
      
      return embedding;
    })();

    this.inFlightEmbeddings.set(cacheKey, promise);
    return promise;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private hasReferentialFollowUpCue(question: string): boolean {
    const lowered = question.toLowerCase();
    return /\b(this|that|it|those|these|them|there|then)\b/.test(lowered)
      || /^(and|but|so)\b/.test(lowered)
      || /\b(what if|how would that|how does that|why that|why this)\b/.test(lowered);
  }

  private buildThreadCorpus(thread: ReasoningThread): string {
    return [
      thread.rootQuestion,
      thread.lastQuestion,
      ...thread.response.likelyFollowUps,
      thread.response.behavioralAnswer?.question,
    ].filter(Boolean).join(' ');
  }

  async isCompatible(question: string, thread: ReasoningThread): Promise<boolean> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      return false;
    }

    const wordCount = normalizedQuestion.split(/\s+/).filter(Boolean).length;
    
    // Fallback to original method for very short questions
    if (wordCount < SemanticThreadMatcher.MIN_WORD_COUNT) {
      return false; // Caller will use original stopword method
    }

    // Check for referential follow-up cues (fast path)
    const hasReferentialCue = this.hasReferentialFollowUpCue(normalizedQuestion);
    if (hasReferentialCue) {
      return true;
    }

    try {
      const qEmb = await this.getEmbedding(normalizedQuestion);
      
      // Use cached thread embedding if available
      let tEmb = thread.embedding;
      if (!tEmb) {
        const threadCorpus = this.buildThreadCorpus(thread);
        if (!threadCorpus) {
          return false;
        }
        tEmb = await this.getEmbedding(threadCorpus);
      }

      const sim = this.cosineSimilarity(qEmb, tEmb);
      return sim >= SemanticThreadMatcher.THRESHOLD;
    } catch (error) {
      console.warn('[SemanticThreadMatcher] Embedding computation failed, falling back:', error);
      return false; // Caller will use original stopword method
    }
  }

  async cacheThreadEmbedding(thread: ReasoningThread): Promise<void> {
    try {
      const threadCorpus = this.buildThreadCorpus(thread);
      if (!threadCorpus) {
        return;
      }
      thread.embedding = await this.getEmbedding(threadCorpus);
    } catch (error) {
      console.warn('[SemanticThreadMatcher] Failed to cache thread embedding:', error);
    }
  }

  clearCache(): void {
    this.embeddingCache.clear();
    this.inFlightEmbeddings.clear();
  }

  /**
   * Release the underlying xenova pipeline (which owns a napi-v3
   * InferenceSession) and unregister from the disposable registry.
   *
   * Idempotent. All errors are swallowed; the destructor crash this method
   * prevents (EXC_BREAKPOINT inside ~InferenceSessionWrap) is exactly what
   * we must not propagate during shutdown.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unregister();
    // R1: if a pipeline() load is in flight, wait for it to settle so we can
    // dispose whatever it produced. Without this await, the late-resolving
    // pipeline would assign to `this.embedder` after we nulled it, leak past
    // the registry, and re-introduce the destructor crash. The race-handling
    // branch inside `ensureModelLoaded` already disposes its own embedder
    // when it sees `this.disposed`; we still grab whatever ended up on the
    // instance below as a belt-and-braces second pass.
    const inFlight = this.modelLoadPromise;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // swallow: load failure is fine, we just need it resolved
      }
    }
    const embedder = this.embedder;
    this.embedder = null;
    this.modelLoadPromise = null;
    this.embeddingCache.clear();
    this.inFlightEmbeddings.clear();
    if (!embedder) return;
    try {
      if (typeof embedder.dispose === 'function') {
        await embedder.dispose();
      }
    } catch (err) {
      console.warn('[SemanticThreadMatcher] dispose error swallowed:', err);
    }
  }
}
