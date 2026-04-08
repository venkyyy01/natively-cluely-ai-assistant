import { PromptCompiler } from '../llm/PromptCompiler';
import { StreamManager } from '../llm/StreamManager';
import { EnhancedCache } from '../cache/EnhancedCache';
import { ParallelContextAssembler, setEmbeddingProvider } from '../cache/ParallelContextAssembler';
import { AdaptiveContextWindow } from '../conscious/AdaptiveContextWindow';
import { ConsciousAccelerationOrchestrator } from '../conscious/ConsciousAccelerationOrchestrator';
import { ANEEmbeddingProvider } from '../rag/providers/ANEEmbeddingProvider';
import { StealthManager } from '../stealth/StealthManager';
import { getOptimizationFlags, isOptimizationActive } from '../config/optimizations';

let activeAccelerationManager: AccelerationManager | null = null;

export function setActiveAccelerationManager(manager: AccelerationManager | null): void {
  activeAccelerationManager = manager;
}

export function getActiveAccelerationManager(): AccelerationManager | null {
  return activeAccelerationManager;
}

export interface AccelerationModules {
  promptCompiler: PromptCompiler;
  streamManager: StreamManager | null;
  enhancedCache: EnhancedCache<string, unknown>;
  parallelAssembler: ParallelContextAssembler;
  adaptiveWindow: AdaptiveContextWindow;
  aneProvider: ANEEmbeddingProvider;
  stealthManager: StealthManager | null;
  consciousOrchestrator: ConsciousAccelerationOrchestrator;
}

export class AccelerationManager {
  private promptCompiler: PromptCompiler;
  private enhancedCache: EnhancedCache<string, unknown>;
  private parallelAssembler: ParallelContextAssembler;
  private adaptiveWindow: AdaptiveContextWindow;
  private aneProvider: ANEEmbeddingProvider;
  private consciousOrchestrator: ConsciousAccelerationOrchestrator;

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
    this.consciousOrchestrator = new ConsciousAccelerationOrchestrator({
      maxPrefetchPredictions: flags.maxPrefetchPredictions,
      maxMemoryMB: flags.maxCacheMemoryMB,
    });
    this.aneProvider = new ANEEmbeddingProvider();
  }

  setConsciousModeEnabled(enabled: boolean): void {
    this.consciousOrchestrator.setEnabled(enabled);
  }

  isConsciousModeEnabled(): boolean {
    return this.consciousOrchestrator.isEnabled();
  }

  getPauseThresholdProfile() {
    return this.consciousOrchestrator.getPauseThresholdProfile();
  }

  getConsciousOrchestrator(): ConsciousAccelerationOrchestrator {
    return this.consciousOrchestrator;
  }

  /**
   * Register ANE provider as the global embedding source
   */
  private registerANEProvider(): void {
    if (isOptimizationActive('useANEEmbeddings') && this.aneProvider.isInitialized()) {
      setEmbeddingProvider(this.aneProvider);
      console.log('[AccelerationManager] ANE provider registered for real embeddings');
    } else {
      setEmbeddingProvider(null);
    }
  }

  async initialize(): Promise<void> {
    if (isOptimizationActive('useANEEmbeddings')) {
      await this.aneProvider.initialize();
    }

    this.registerANEProvider();
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

  getANEProvider(): ANEEmbeddingProvider {
    return this.aneProvider;
  }

  clearCaches(): void {
    this.promptCompiler.clearCache();
    this.enhancedCache.clear();
    this.consciousOrchestrator.clearState();
  }

  getModules(): AccelerationModules {
    return {
      promptCompiler: this.promptCompiler,
      streamManager: null,
      enhancedCache: this.enhancedCache,
      parallelAssembler: this.parallelAssembler,
      adaptiveWindow: this.adaptiveWindow,
      aneProvider: this.aneProvider,
      stealthManager: null,
      consciousOrchestrator: this.consciousOrchestrator,
    };
  }
}
