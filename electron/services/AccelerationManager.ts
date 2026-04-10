import { PromptCompiler } from '../llm/PromptCompiler';
import { StreamManager } from '../llm/StreamManager';
import { EnhancedCache } from '../cache/EnhancedCache';
import { ParallelContextAssembler, setEmbeddingProvider } from '../cache/ParallelContextAssembler';
import { AdaptiveContextWindow } from '../conscious/AdaptiveContextWindow';
import { ConsciousAccelerationOrchestrator } from '../conscious/ConsciousAccelerationOrchestrator';
import { ANEEmbeddingProvider } from '../rag/providers/ANEEmbeddingProvider';
import { StealthManager } from '../stealth/StealthManager';
import { getOptimizationFlags, isOptimizationActive } from '../config/optimizations';
import { WorkerPool } from '../runtime/WorkerPool';
import { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';

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
  workerPool: WorkerPool;
  runtimeBudgetScheduler: RuntimeBudgetScheduler;
}

export class AccelerationManager {
  private promptCompiler: PromptCompiler;
  private enhancedCache: EnhancedCache<string, unknown>;
  private parallelAssembler: ParallelContextAssembler;
  private adaptiveWindow: AdaptiveContextWindow;
  private aneProvider: ANEEmbeddingProvider;
  private consciousOrchestrator: ConsciousAccelerationOrchestrator;
  private workerPool: WorkerPool;
  private runtimeBudgetScheduler: RuntimeBudgetScheduler;

  constructor() {
    const flags = getOptimizationFlags();

    this.promptCompiler = new PromptCompiler();
    this.enhancedCache = new EnhancedCache({
      maxMemoryMB: flags.maxCacheMemoryMB,
      ttlMs: 5 * 60 * 1000,
      enableSemanticLookup: flags.semanticCacheThreshold > 0,
      similarityThreshold: flags.semanticCacheThreshold,
    });
    this.workerPool = new WorkerPool({ size: flags.workerThreadCount });
    this.runtimeBudgetScheduler = new RuntimeBudgetScheduler({
      workerPool: this.workerPool,
      laneBudgets: flags.laneBudgets,
    });
    this.parallelAssembler = new ParallelContextAssembler({
      workerThreadCount: flags.workerThreadCount,
      workerPool: this.workerPool,
    });
    this.adaptiveWindow = new AdaptiveContextWindow();
    this.consciousOrchestrator = new ConsciousAccelerationOrchestrator({
      maxPrefetchPredictions: flags.maxPrefetchPredictions,
      maxMemoryMB: flags.maxCacheMemoryMB,
      budgetScheduler: this.runtimeBudgetScheduler,
      classifierLane: this.runtimeBudgetScheduler,
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

  getWorkerPool(): WorkerPool {
    return this.workerPool;
  }

  getRuntimeBudgetScheduler(): RuntimeBudgetScheduler {
    return this.runtimeBudgetScheduler;
  }

  async runInLane<T>(lane: 'realtime' | 'local-inference' | 'semantic' | 'background', task: () => Promise<T> | T): Promise<T> {
    return this.runtimeBudgetScheduler.submit(lane, task);
  }

  shouldAdmitSpeculation(probability: number, valueOfPrefetch: number, costOfCompute: number): boolean {
    return this.runtimeBudgetScheduler.shouldAdmitSpeculation(probability, valueOfPrefetch, costOfCompute);
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
      workerPool: this.workerPool,
      runtimeBudgetScheduler: this.runtimeBudgetScheduler,
    };
  }
}
