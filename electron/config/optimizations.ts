// electron/config/optimizations.ts
// Accelerated Intelligence Pipeline - Feature Flags
// Toggle switch to enable/disable acceleration features.
// When disabled, the system falls back to the original implementation.

export interface OptimizationFlags {
  /** Master toggle - enables/disables all acceleration features */
  accelerationEnabled: boolean;

  /** Phase 1: Quick Wins */
  usePromptCompiler: boolean;
  useStreamManager: boolean;
  useEnhancedCache: boolean;

  /** Phase 2: Neural Acceleration (Apple Silicon only) */
  useANEEmbeddings: boolean;
  useParallelContext: boolean;

  /** Phase 3: Intelligent Context */
  useAdaptiveWindow: boolean;
  usePrefetching: boolean;

  /** Phase 4: Stealth & Process Isolation */
  useStealthMode: boolean;

  /** Worker thread configuration */
  workerThreadCount: number;

  /** Cache configuration */
  maxCacheMemoryMB: number;
  semanticCacheThreshold: number;

  /** Prefetch configuration */
  maxPrefetchPredictions: number;
}

/** Default optimization flags - master toggle disabled, individual flags enabled for when toggle is ON */
export const DEFAULT_OPTIMIZATION_FLAGS: OptimizationFlags = {
  accelerationEnabled: false,

  // Phase 1
  usePromptCompiler: true,
  useStreamManager: true,
  useEnhancedCache: true,

  // Phase 2
  useANEEmbeddings: true,
  useParallelContext: true,

  // Phase 3
  useAdaptiveWindow: true,
  usePrefetching: true,

  // Phase 4
  useStealthMode: true,

  // Worker config (6 cores default, user-adjustable)
  workerThreadCount: 6,

  // Cache config
  maxCacheMemoryMB: 100,
  semanticCacheThreshold: 0.85,

  // Prefetch config
  maxPrefetchPredictions: 5,
};

/** Runtime optimization state */
let currentFlags: OptimizationFlags = { ...DEFAULT_OPTIMIZATION_FLAGS };

/** Cached CPU count to avoid repeated os.cpus() calls */
let cachedCpuCount: number | null = null;

/**
 * Get current optimization flags
 */
export function getOptimizationFlags(): Readonly<OptimizationFlags> {
  return currentFlags;
}

/**
 * Update optimization flags from settings
 */
export function syncOptimizationFlagsFromSettings(getAccelerationModeEnabled: () => boolean): void {
  const accelerationEnabled = getAccelerationModeEnabled();
  if (currentFlags.accelerationEnabled !== accelerationEnabled) {
    currentFlags = { ...currentFlags, accelerationEnabled };
  }
}

/**
 * Update optimization flags (partial update supported)
 */
export function setOptimizationFlags(flags: Partial<OptimizationFlags>): void {
  currentFlags = { ...currentFlags, ...flags };
}

/**
 * Check if a specific optimization is active
 * Returns false if master toggle is off, regardless of individual flag
 */
export function isOptimizationActive(key: keyof Omit<OptimizationFlags, 'accelerationEnabled' | 'workerThreadCount' | 'maxCacheMemoryMB' | 'semanticCacheThreshold' | 'maxPrefetchPredictions'>): boolean {
  return currentFlags.accelerationEnabled && currentFlags[key];
}

/**
 * Check if running on Apple Silicon (M1+)
 */
export function isAppleSilicon(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

/**
 * Get effective worker thread count
 * Respects user setting but caps at available cores
 */
export function getEffectiveWorkerCount(): number {
  if (cachedCpuCount === null) {
    cachedCpuCount = require('os').cpus().length;
  }
  return Math.min(currentFlags.workerThreadCount, cachedCpuCount - 1);
}
