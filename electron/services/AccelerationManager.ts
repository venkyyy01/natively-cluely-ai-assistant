import { PromptCompiler } from '../llm/PromptCompiler';
import { StreamManager } from '../llm/StreamManager';
import { EnhancedCache } from '../cache/EnhancedCache';
import { ParallelContextAssembler } from '../cache/ParallelContextAssembler';
import { AdaptiveContextWindow } from '../conscious/AdaptiveContextWindow';
import { PredictivePrefetcher } from '../prefetch/PredictivePrefetcher';
import { ANEEmbeddingProvider } from '../rag/providers/ANEEmbeddingProvider';
import { StealthManager } from '../stealth/StealthManager';
import { getOptimizationFlags, isOptimizationActive, setOptimizationFlags } from '../config/optimizations';
import { InterviewPhase } from '../conscious/types';

export interface AccelerationModules {
  promptCompiler: PromptCompiler;
  streamManager: StreamManager | null;
  enhancedCache: EnhancedCache<string, unknown>;
  parallelAssembler: ParallelContextAssembler;
  adaptiveWindow: AdaptiveContextWindow;
  prefetcher: PredictivePrefetcher;
  aneProvider: ANEEmbeddingProvider;
  stealthManager: StealthManager | null;
}

export class AccelerationManager {
  private promptCompiler: PromptCompiler;
  private enhancedCache: EnhancedCache<string, unknown>;
  private parallelAssembler: ParallelContextAssembler;
  private adaptiveWindow: AdaptiveContextWindow;
  private prefetcher: PredictivePrefetcher;
  private aneProvider: ANEEmbeddingProvider;

  constructor() {
    const flags = getOptimizationFlags();

    this.promptCompiler = new PromptCompiler();
    this.enhancedCache = new EnhancedCache({
      maxMemoryMB: flags.maxCacheMemoryMB,
      ttlMs: 5 * 60 * 1000,
      enableSemanticLookup: flags.semanticCacheThreshold > 0,
      similarityThreshold: flags.semanticCacheThreshold,
    });
    this.parallelAssembler = new ParallelContextAssembler({
      workerThreadCount: flags.workerThreadCount,
    });
    this.adaptiveWindow = new AdaptiveContextWindow();
    this.prefetcher = new PredictivePrefetcher({
      maxPrefetchPredictions: flags.maxPrefetchPredictions,
      maxMemoryMB: flags.maxCacheMemoryMB,
    });
    this.aneProvider = new ANEEmbeddingProvider();
  }

  async initialize(): Promise<void> {
    if (!isOptimizationActive('useANEEmbeddings')) {
      console.log('[AccelerationManager] ANE embeddings disabled, skipping provider init');
      return;
    }

    await this.aneProvider.initialize();
    console.log('[AccelerationManager] Initialized with acceleration modules');
  }

  getPromptCompiler(): PromptCompiler {
    return this.promptCompiler;
  }

  getEnhancedCache(): EnhancedCache<string, unknown> {
    return this.enhancedCache;
  }

  getParallelAssembler(): ParallelContextAssembler {
    return this.parallelAssembler;
  }

  getAdaptiveWindow(): AdaptiveContextWindow {
    return this.adaptiveWindow;
  }

  getPrefetcher(): PredictivePrefetcher {
    return this.prefetcher;
  }

  getANEProvider(): ANEEmbeddingProvider {
    return this.aneProvider;
  }

  setPhase(phase: InterviewPhase): void {
    this.adaptiveWindow.setCurrentPhase(phase);
    this.prefetcher.onPhaseChange(phase);
  }

  onSilenceStart(): void {
    this.prefetcher.onSilenceStart();
  }

  onUserSpeaking(): void {
    this.prefetcher.onUserSpeaking();
  }

  clearCaches(): void {
    this.promptCompiler.clearCache();
    this.enhancedCache.clear();
    this.prefetcher.onTopicShiftDetected();
  }

  getModules(): AccelerationModules {
    return {
      promptCompiler: this.promptCompiler,
      streamManager: null,
      enhancedCache: this.enhancedCache,
      parallelAssembler: this.parallelAssembler,
      adaptiveWindow: this.adaptiveWindow,
      prefetcher: this.prefetcher,
      aneProvider: this.aneProvider,
      stealthManager: null,
    };
  }
}
