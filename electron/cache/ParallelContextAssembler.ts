import { isOptimizationActive, getEffectiveWorkerCount } from '../config/optimizations';
import { InterviewPhase } from '../conscious/types';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

export interface ContextAssemblyInput {
  query: string;
  transcript: Array<{
    speaker: string;
    text: string;
    timestamp: number;
  }>;
  previousContext: {
    recentTopics: string[];
    activeThread: string | null;
  };
}

export interface ContextAssemblyOutput {
  embedding: number[];
  bm25Results: Array<{ text: string; score: number }>;
  phase: InterviewPhase;
  confidence: number;
  relevantContext: Array<{ text: string; timestamp: number }>;
}

// Embedding provider interface for real embeddings
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  isInitialized(): boolean;
}

// Global embedding provider set by AccelerationManager
let globalEmbeddingProvider: EmbeddingProvider | null = null;

export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  globalEmbeddingProvider = provider;
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  return globalEmbeddingProvider;
}

export async function computeBM25(
  query: string,
  documents: Array<{ text: string; timestamp: number }>,
  k1: number = 1.5,
  b: number = 0.75
): Promise<Array<{ text: string; score: number; timestamp: number }>> {
  if (documents.length === 0) return [];

  const queryTerms = query.toLowerCase().split(/\s+/);
  const docTerms = documents.map(d => d.text.toLowerCase().split(/\s+/));

  const avgDocLength = docTerms.reduce((sum, doc) => sum + doc.length, 0) / docTerms.length;

  return documents.map((doc, idx) => {
    let score = 0;
    const docLen = docTerms[idx].length;

    for (const term of queryTerms) {
      const tf = docTerms[idx].filter(t => t.includes(term)).length;
      if (tf > 0) {
        const df = docTerms.filter(doc => doc.some(t => t.includes(term))).length;
        const idf = Math.log((documents.length - df + 0.5) / (df + 0.5) + 1);
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLength)));
      }
    }

    return { text: doc.text, score, timestamp: doc.timestamp };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score);
}

function detectPhase(transcript: Array<{ text: string; timestamp: number }>): InterviewPhase {
  const recentText = transcript.slice(-3).map(t => t.text.toLowerCase()).join(' ');

  if (recentText.includes('implement') || recentText.includes('code')) {
    return 'implementation';
  }
  if (recentText.includes('scale') || recentText.includes('million')) {
    return 'scaling_discussion';
  }
  if (recentText.includes('why') || recentText.includes('design') || recentText.includes('architecture')) {
    return 'high_level_design';
  }
  if (recentText.includes('complexity') || recentText.includes('big o')) {
    return 'complexity_analysis';
  }
  if (recentText.includes('fail') || recentText.includes('error')) {
    return 'failure_handling';
  }
  if (recentText.includes('tell me about') || recentText.includes('experience')) {
    return 'behavioral_story';
  }
  if (recentText.includes('wrap up') || recentText.includes('any questions')) {
    return 'wrap_up';
  }

  return 'requirements_gathering';
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function generateEmbeddingFallback(query: string): number[] {
  const hash = simpleHash(query);
  const embedding = new Array(384).fill(0);
  embedding[hash % 384] = 1;
  embedding[(hash + 1) % 384] = 0.5;
  return embedding;
}

if (!isMainThread) {
  const { type, payload } = workerData;
  if (type === 'bm25') {
    computeBM25(payload.query, payload.documents).then(result => {
      parentPort?.postMessage(result);
    });
  } else if (type === 'embedding') {
    parentPort?.postMessage(generateEmbeddingFallback(payload.query));
  } else if (type === 'phase') {
    parentPort?.postMessage(detectPhase(payload.transcript));
  }
}

export class ParallelContextAssembler {
  private workerCount: number;

  constructor(options: { workerThreadCount?: number }) {
    this.workerCount = options.workerThreadCount || getEffectiveWorkerCount();
  }

  getWorkerCount(): number {
    return this.workerCount;
  }

  private runInWorker<T>(type: string, payload: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { type, payload }
      });
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  }

  async assemble(input: ContextAssemblyInput): Promise<ContextAssemblyOutput> {
    if (!isOptimizationActive('useParallelContext')) {
      return this.assembleLegacy(input);
    }

    const docs = input.transcript
      .filter(t => t.speaker !== 'assistant')
      .map(t => ({ text: t.text, timestamp: t.timestamp }));

    // Try to use real embeddings if ANE provider is available
    const embeddingProvider = getEmbeddingProvider();
    let embedding: number[];

    if (embeddingProvider?.isInitialized()) {
      // Use real embeddings from ANE provider
      embedding = await embeddingProvider.embed(input.query);
    } else {
      // Fall back to hash-based embedding (worker thread)
      embedding = await this.runInWorker<number[]>('embedding', { query: input.query });
    }

    const [bm25ResultsRaw, phaseResult] = await Promise.all([
      this.runInWorker<Array<{ text: string; score: number; timestamp: number }>>('bm25', { query: input.query, documents: docs }),
      this.runInWorker<InterviewPhase>('phase', { transcript: input.transcript }),
    ]);

    const bm25Results = (await bm25ResultsRaw).map((r: { text: string; score: number }) => ({ text: r.text, score: r.score }));
    const phase = await phaseResult;
    const relevantContext = this.selectRelevantContext(bm25Results, phase);
    const confidence = this.calculateConfidence(embedding, relevantContext);

    return {
      embedding,
      bm25Results,
      phase,
      confidence,
      relevantContext
    };
  }

  private selectRelevantContext(
    bm25Results: Array<{ text: string; score: number }>,
    phase: InterviewPhase
  ): Array<{ text: string; timestamp: number }> {
    const budgetMap: Record<InterviewPhase, number> = {
      requirements_gathering: 500,
      high_level_design: 800,
      deep_dive: 1000,
      implementation: 1200,
      complexity_analysis: 600,
      scaling_discussion: 800,
      failure_handling: 600,
      behavioral_story: 400,
      wrap_up: 300,
    };

    const budget = budgetMap[phase] || 500;
    let usedTokens = 0;
    const selected: Array<{ text: string; timestamp: number }> = [];

    for (const result of bm25Results) {
      const tokens = result.text.split(/\s+/).length;
      if (usedTokens + tokens <= budget) {
        selected.push({ text: result.text, timestamp: Date.now() });
        usedTokens += tokens;
      }
    }

    return selected;
  }

  private calculateConfidence(embedding: number[], context: Array<{ text: string; timestamp: number }>): number {
    const contextScore = context.length > 0 ? 0.5 : 0;
    const embeddingScore = embedding.length === 384 ? 0.3 : 0;
    const baseScore = 0.2;

    return Math.min(0.95, baseScore + contextScore + embeddingScore);
  }

  private async assembleLegacy(input: ContextAssemblyInput): Promise<ContextAssemblyOutput> {
    const embeddingProvider = getEmbeddingProvider();
    const embedding = embeddingProvider?.isInitialized()
      ? await embeddingProvider.embed(input.query)
      : generateEmbeddingFallback(input.query);
    const docs = input.transcript
      .filter(t => t.speaker !== 'assistant')
      .map(t => ({ text: t.text, timestamp: t.timestamp }));
    const bm25ResultsRaw = await computeBM25(input.query, docs);
    const bm25Results = bm25ResultsRaw.map((r: { text: string; score: number }) => ({ text: r.text, score: r.score }));
    const phase = detectPhase(input.transcript);
    const relevantContext = this.selectRelevantContext(bm25Results, phase);
    const confidence = this.calculateConfidence(embedding, relevantContext);

    return { embedding, bm25Results, phase, confidence, relevantContext };
  }

  terminate(): void {
    // Cleanup if needed (worker pool would be terminated here)
  }
}