// electron/config/optimizations.ts
// Accelerated Intelligence Pipeline - Feature Flags
// Toggle switch to enable/disable acceleration features.
// When disabled, the system falls back to the original implementation.

import os from 'os';

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

  /** Intent acceleration: Foundation Models first-pass intent classification */
  useFoundationModelsIntent: boolean;

  /** Conscious mode verifier: use word-boundary matching for unsupported tech/numeric claims */
  useConsciousVerifierWordBoundary: boolean;

  /** Conscious mode verifier: always run rule-based provenance even in degraded mode */
  useDegradedProvenanceCheck: boolean;

  /** Conscious mode verifier: use tighter numeric claim regex requiring unit suffix */
  useTighterNumericClaimRegex: boolean;

  /** Conscious mode verifier: use expanded technology allowlist from external JSON file */
  useExpandedTechAllowlist: boolean;

  /** Conscious mode orchestrator: use SBERT for semantic thread continuation compatibility */
  useSemanticThreadContinuation: boolean;

  /** Conscious mode confidence: use isotonic regression calibration for confidence scores */
  useConfidenceCalibration: boolean;

  /** Conscious mode verifier: use NLI semantic entailment for claim verification */
  useSemanticEntailment: boolean;

  /** Conscious mode verifier: use probabilistic STAR scorer instead of hard floor rules */
  useProbabilisticStar: boolean;

  /** Conscious mode reaction: use SetFit classifier for reaction classification */
  useSetFitReactions: boolean;

  /** Pause detection: use adaptive pause weights with online learning */
  useAdaptivePause: boolean;

  /** Acceleration: use fuzzy speculation with cosine similarity */
  useFuzzySpeculation: boolean;

  /** Verifier: use Bayesian aggregation across verifiers */
  useBayesianAggregation: boolean;

  /** Verifier: use RAG over session transcript for verification */
  useRAGVerification: boolean;

  /** Verifier: use verification logging for active learning */
  useVerificationLogging: boolean;

  /** Conscious: use flexible response mode (free-form fallback) */
  useFlexibleConsciousResponse: boolean;

  /** Conscious: enable human-like conversation routing (smalltalk/clarification/refinement detection) */
  useHumanLikeConsciousMode: boolean;

  /** Conscious: enable refinement turns inside conscious mode (shorten/expand/rephrase) */
  useConsciousRefinement: boolean;

  /** Triggering: buffer STT final fragments into utterance-level trigger decisions */
  useUtteranceLevelTriggering: boolean;

  /** Triggering: allow user microphone transcripts to request suggestions */
  useMicTranscriptTriggers: boolean;

  /** NAT-206: Two-Tier Answer Contract — Tier-B probe path for non-behavioral follow-ups. Default OFF. */
  useTwoTierAnswerContract: boolean;

  /** NAT-307: Structured problem extractor pipeline. Default OFF. */
  useStructuredProblemExtractor: boolean;

  /** NAT-405: Code editor capture via region-bound Tesseract polling. Default OFF. */
  useCodeEditorCapture: boolean;

  /** NAT-506: Continuous on-screen RAG via pHash+OCR. Default OFF. */
  useContinuousScreenRAG: boolean;

  /** NAT-701: Incremental JSON stream parser state machine. Default OFF. */
  useRobustJsonStreamParser: boolean;

  /** Worker thread configuration */
  workerThreadCount: number;

	/** Cache configuration */
	maxCacheMemoryMB: number;
	semanticCacheThreshold: number;

	/** Prefetch configuration */
	maxPrefetchPredictions: number;

  /** Foundation intent retry backoff base (ms) */
  foundationIntentRetryBaseMs: number;

  /** Foundation intent max retries before fallback */
  foundationIntentMaxRetries: number;

  /** Runtime lane budgets */
  laneBudgets: Record<RuntimeLane, LaneBudgetConfig>;
}

export type RuntimeLane =
	| "realtime"
	| "local-inference"
	| "semantic"
	| "background";

export interface LaneBudgetConfig {
	deadlineMs: number;
	maxConcurrent: number;
	memoryCeilingMb: number;
}

export const DEFAULT_LANE_BUDGETS: Record<RuntimeLane, LaneBudgetConfig> = {
	realtime: {
		deadlineMs: 20,
		maxConcurrent: 1,
		memoryCeilingMb: 64,
	},
	"local-inference": {
		deadlineMs: 2000,
		maxConcurrent: 1,
		memoryCeilingMb: 256,
	},
	semantic: {
		deadlineMs: 100,
		maxConcurrent: 2,
		memoryCeilingMb: 128,
	},
	background: {
		deadlineMs: 5000,
		maxConcurrent: 4,
		memoryCeilingMb: 128,
	},
};

/** Default optimization flags - acceleration enabled for realtime context reliability */
export const DEFAULT_OPTIMIZATION_FLAGS: OptimizationFlags = {
	accelerationEnabled: true,

	// Phase 1
	usePromptCompiler: true,
	useStreamManager: true,
	useEnhancedCache: true,

  // Phase 2
  // NAT-101: Re-enabled — dispose() now calls SafeOnnxSession.release() which swallows
  // EXC_BAD_ACCESS in OrtApis::ReleaseIoBinding so teardown can't crash the main process.
  // Falls back to LocalEmbeddingProvider on non-arm64 or after 3 consecutive ONNX failures.
  useANEEmbeddings: true,
  useParallelContext: true,

	// Phase 3
	useAdaptiveWindow: true,
	usePrefetching: true,

	// Phase 4
	useStealthMode: true,

  // Intent acceleration
  useFoundationModelsIntent: true,

  // Conscious mode verifier
  useConsciousVerifierWordBoundary: true,

  // Conscious mode verifier
  useDegradedProvenanceCheck: true,

  // NAT-600: Accuracy flip-on — tighter numeric regex + expanded tech allowlist now ON.
  // Reduces false-positive star ratings on claims like "100ms" being confused with percentages.
  useTighterNumericClaimRegex: true,

  // NAT-600: Expanded technology allowlist ON — covers modern stack (Rust, Kafka, k8s, etc.).
  useExpandedTechAllowlist: true,

  // NAT-600: Semantic thread continuation ON — SBERT-based compatibility check.
  useSemanticThreadContinuation: true,

  // Conscious mode confidence calibration — still OFF pending isotonic regression eval.
  useConfidenceCalibration: false,

  // Conscious mode verifier — NLI semantic entailment (high latency, stay OFF).
  useSemanticEntailment: false,

  // Conscious mode verifier — probabilistic STAR scorer (pending A/B).
  useProbabilisticStar: false,

  // Conscious mode reaction — SetFit reactions (pending model upload).
  useSetFitReactions: false,

  // Pause detection — adaptive pause ON: tuner learns false-positive/success rates and
  // updates PauseDetector thresholds in real time, reducing stale speculation aborts.
  useAdaptivePause: true,

  // Acceleration — fuzzy speculation ON: cosine threshold 0.92 is conservative enough
  // to prevent wrong-answer injection while catching minor rephrasing of the same question.
  useFuzzySpeculation: true,

  // NAT-600: Bayesian aggregation ON — verifier votes are weighted by historical accuracy
  // instead of worst-case OR. RAG verification ON — cross-checks LLM claims against
  // session transcript to catch hallucinations. Logging stays ON for telemetry.
  useBayesianAggregation: true,
  useRAGVerification: true,
  useVerificationLogging: true,

  // Conscious — NAT-104: free-form fallback ON by default so parse failures show text, not empty UI
  useFlexibleConsciousResponse: true,
  useHumanLikeConsciousMode: true,
  useConsciousRefinement: false,
  useUtteranceLevelTriggering: true,
  useMicTranscriptTriggers: false,

  // Phase 1 flags — NAT-206..506
  useTwoTierAnswerContract: process.env['NATIVELY_FORCE_TWO_TIER'] === '1',
  useStructuredProblemExtractor: false,
  useCodeEditorCapture: false,
  useContinuousScreenRAG: false,
  // NAT-701: Robust incremental JSON stream parser ON — recovers partial structure from
  // malformed mid-stream JSON (common with Gemini v1alpha), preventing silent empty responses.
  useRobustJsonStreamParser: true,

  // NAT-103: default derived at startup; overridden by user setting.
  // Computed lazily here so this module is safe to import in tests without `os`.
  workerThreadCount: (() => {
    try {
      const os = require('os');
      return Math.max(2, Math.min(os.cpus().length - 2, 12));
    } catch {
      return 4;
    }
  })(),

  // Cache config
  maxCacheMemoryMB: 100,
  // Lowered from 0.85 → 0.80: interview questions vary in phrasing but share identical
  // semantics; the TTL + transcript-revision binding (NAT-003) already guard stale hits.
  semanticCacheThreshold: 0.80,

	// Prefetch config
	maxPrefetchPredictions: 5,

  // Foundation intent config
  foundationIntentRetryBaseMs: 100,
  foundationIntentMaxRetries: 2,

  // Runtime budget config
  laneBudgets: DEFAULT_LANE_BUDGETS,
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
export function syncOptimizationFlagsFromSettings(
	accelerationEnabled: boolean,
): void {
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
 * Set optimization flags for testing purposes
 */
export function setOptimizationFlagsForTesting(
	flags: Partial<OptimizationFlags>,
): void {
	currentFlags = { ...DEFAULT_OPTIMIZATION_FLAGS, ...flags };
}

/**
 * Check if a specific optimization is active
 * Returns false if master toggle is off, regardless of individual flag
 */
export function isOptimizationActive(key: keyof Omit<OptimizationFlags, 'accelerationEnabled' | 'workerThreadCount' | 'maxCacheMemoryMB' | 'semanticCacheThreshold' | 'maxPrefetchPredictions' | 'foundationIntentRetryBaseMs' | 'foundationIntentMaxRetries' | 'laneBudgets' | 'useConsciousVerifierWordBoundary'>): boolean {
  return currentFlags.accelerationEnabled && currentFlags[key];
}

/**
 * Check if a conscious mode verifier optimization is active
 * These run independently of the acceleration master toggle since they affect correctness
 */
export function isVerifierOptimizationActive(key: 'useConsciousVerifierWordBoundary' | 'useDegradedProvenanceCheck' | 'useTighterNumericClaimRegex' | 'useExpandedTechAllowlist' | 'useSemanticThreadContinuation' | 'useConfidenceCalibration' | 'useSemanticEntailment' | 'useProbabilisticStar' | 'useSetFitReactions' | 'useAdaptivePause' | 'useFuzzySpeculation' | 'useBayesianAggregation' | 'useRAGVerification' | 'useVerificationLogging'): boolean {
  return currentFlags[key];
}

/**
 * Check if a conscious mode optimization is active
 * These run independently of the acceleration master toggle
 */
export function isConsciousOptimizationActive(key: 'useFlexibleConsciousResponse' | 'useHumanLikeConsciousMode' | 'useConsciousRefinement' | 'useUtteranceLevelTriggering' | 'useMicTranscriptTriggers' | 'useTwoTierAnswerContract' | 'useStructuredProblemExtractor' | 'useCodeEditorCapture' | 'useContinuousScreenRAG' | 'useRobustJsonStreamParser'): boolean {
  return currentFlags[key];
}

/**
 * Check if running on Apple Silicon (M1+)
 */
export function isAppleSilicon(): boolean {
	return process.platform === "darwin" && process.arch === "arm64";
}

/**
 * Get effective worker thread count.
 * NAT-103: default is now dynamic (os.cpus() - 2, clamped [2,12]).
 * This function additionally guards against user setting exceeding physical core count.
 */
export function getEffectiveWorkerCount(): number {
	if (cachedCpuCount === null) {
		try {
			const os = require("os");
			cachedCpuCount = os.cpus().length;
		} catch {
			cachedCpuCount = 4;
		}
	}
	return Math.min(currentFlags.workerThreadCount, cachedCpuCount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive Accelerator — Hardware Detection & Tier Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hardware tier classification based on available RAM.
 * - constrained: ≤8 GB — conservative resource usage
 * - standard: 9–16 GB — balanced performance
 * - high-capacity: ≥17 GB — maximum throughput
 */
export type HardwareTier = 'constrained' | 'standard' | 'high-capacity';

/**
 * Detected hardware profile used for adaptive acceleration decisions.
 */
export interface HardwareProfile {
  cpuCores: number;
  ramGB: number;
  tier: HardwareTier;
  arch: string;
}

/**
 * Classify a machine into a hardware tier based on available RAM.
 *
 * Pure function — safe to call in tests without side effects.
 *
 * @param ramGB Total system RAM in gigabytes
 * @returns The hardware tier classification
 */
export function classifyTier(ramGB: number): HardwareTier {
  if (ramGB <= 8) return 'constrained';
  if (ramGB <= 16) return 'standard';
  return 'high-capacity';
}

/**
 * Compute the optimal worker thread count for a given tier and CPU core count.
 *
 * - constrained: max 2
 * - standard: max(2, min(cores - 2, 6))
 * - high-capacity: max(2, min(cores - 2, 12))
 *
 * Pure function — safe to call in tests without side effects.
 */
export function computeWorkerCount(tier: HardwareTier, cpuCores: number): number {
  switch (tier) {
    case 'constrained':
      return Math.min(2, Math.max(1, cpuCores));
    case 'standard':
      return Math.max(2, Math.min(cpuCores - 2, 6));
    case 'high-capacity':
      return Math.max(2, Math.min(cpuCores - 2, 12));
  }
}

/**
 * Compute the V8 max-old-space-size heap limit for a given tier.
 *
 * - constrained: 512 MB
 * - standard: 1024 MB
 * - high-capacity: 2048 MB
 *
 * Pure function — safe to call in tests without side effects.
 */
export function computeHeapSize(tier: HardwareTier): number {
  switch (tier) {
    case 'constrained':
      return 512;
    case 'standard':
      return 1024;
    case 'high-capacity':
      return 2048;
  }
}

/**
 * Compute the maximum cache memory limit for a given tier.
 *
 * - constrained: 50 MB
 * - standard: 100 MB
 * - high-capacity: 200 MB
 *
 * Pure function — safe to call in tests without side effects.
 */
export function computeCacheMemory(tier: HardwareTier): number {
  switch (tier) {
    case 'constrained':
      return 50;
    case 'standard':
      return 100;
    case 'high-capacity':
      return 200;
  }
}

/**
 * Detect the current machine's hardware profile.
 *
 * Reads CPU core count and total RAM, then classifies the tier.
 * Falls back to safe defaults if detection fails.
 */
export function detectHardware(): HardwareProfile {
  let cpuCores: number;
  let ramGB: number;

  try {
    cpuCores = os.cpus().length;
  } catch {
    cpuCores = 4; // safe fallback
  }

  try {
    ramGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  } catch {
    ramGB = 16; // fall back to standard tier
  }

  const tier = classifyTier(ramGB);
  const arch = process.arch;

  return { cpuCores, ramGB, tier, arch };
}

/**
 * Apply adaptive acceleration based on detected hardware.
 *
 * - Detects hardware profile (CPU cores, RAM, tier)
 * - Computes optimal worker count, heap size, and cache memory
 * - Respects user overrides for `workerThreadCount` and `maxCacheMemoryMB`
 * - Applies computed values via `setOptimizationFlags()`
 * - Appends V8 heap flag via `app.commandLine.appendSwitch`
 * - Enables GPU acceleration flags
 * - Enables SharedArrayBuffer for high-capacity tier
 * - Logs hardware profile and applied settings
 *
 * @param userOverrides Optional user-configured values that take precedence over auto-detection
 * @returns The detected hardware profile
 */
export function applyAdaptiveAcceleration(
  userOverrides?: Partial<Pick<OptimizationFlags, 'workerThreadCount' | 'maxCacheMemoryMB'>>
): HardwareProfile {
  const profile = detectHardware();

  // Compute optimal values based on detected hardware
  const computedWorkerCount = computeWorkerCount(profile.tier, profile.cpuCores);
  const computedHeapSize = computeHeapSize(profile.tier);
  const computedCacheMemory = computeCacheMemory(profile.tier);

  // Apply values, respecting user overrides
  const effectiveWorkerCount =
    userOverrides?.workerThreadCount != null
      ? userOverrides.workerThreadCount
      : computedWorkerCount;

  const effectiveCacheMemory =
    userOverrides?.maxCacheMemoryMB != null
      ? userOverrides.maxCacheMemoryMB
      : computedCacheMemory;

  // Scale prefetch predictions on high-capacity machines: more silence-window pre-warming
  const effectivePrefetchPredictions = profile.tier === 'high-capacity' ? 8 : DEFAULT_OPTIMIZATION_FLAGS.maxPrefetchPredictions;

  // Update optimization flags
  setOptimizationFlags({
    workerThreadCount: effectiveWorkerCount,
    maxCacheMemoryMB: effectiveCacheMemory,
    maxPrefetchPredictions: effectivePrefetchPredictions,
  });

  // Apply V8 heap size via command-line switch
  try {
    const { app: electronApp } = require('electron');
    electronApp.commandLine.appendSwitch('js-flags', `--max-old-space-size=${computedHeapSize}`);
  } catch {
    // app may not be available in test environments
  }

  // Apply GPU acceleration flags
  try {
    const { app: electronApp } = require('electron');
    electronApp.commandLine.appendSwitch('enable-gpu-rasterization');
    electronApp.commandLine.appendSwitch('enable-zero-copy');
    electronApp.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,CanvasOopRasterization');
  } catch {
    // app may not be available in test environments
  }

  // Enable SharedArrayBuffer for high-capacity tier
  if (profile.tier === 'high-capacity') {
    try {
      const { app: electronApp } = require('electron');
      electronApp.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
    } catch {
      // app may not be available in test environments
    }
  }

  // Log hardware profile and applied settings
  console.log(`[Adaptive] Hardware profile: ${profile.cpuCores} cores, ${profile.ramGB}GB RAM, ${profile.arch}`);
  console.log(`[Adaptive] Tier: ${profile.tier}`);
  console.log(`[Adaptive] Workers: ${effectiveWorkerCount}${userOverrides?.workerThreadCount != null ? ' (user override)' : ''}`);
  console.log(`[Adaptive] Cache: ${effectiveCacheMemory}MB${userOverrides?.maxCacheMemoryMB != null ? ' (user override)' : ''}`);
  console.log(`[Adaptive] V8 heap: ${computedHeapSize}MB`);
  console.log(`[Adaptive] GPU flags: enable-gpu-rasterization, enable-zero-copy, VaapiVideoDecoder, CanvasOopRasterization`);
  if (profile.tier === 'high-capacity') {
    console.log(`[Adaptive] SharedArrayBuffer: enabled`);
  }

  return profile;
}
