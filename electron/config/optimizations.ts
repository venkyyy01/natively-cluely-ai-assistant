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
	// Disabled by default until packaged macOS builds stop crashing inside
	// onnxruntime-node / CoreML session teardown.
	useANEEmbeddings: false,
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

	// Conscious mode verifier
	useTighterNumericClaimRegex: false,

	// Conscious mode verifier
	useExpandedTechAllowlist: false,

	// Conscious mode orchestrator
	useSemanticThreadContinuation: false,

	// Conscious mode confidence
	useConfidenceCalibration: false,

	// Conscious mode verifier
	useSemanticEntailment: false,

	// Conscious mode verifier
	useProbabilisticStar: false,

	// Conscious mode reaction
	useSetFitReactions: false,

	// Pause detection
	useAdaptivePause: false,

	// Acceleration
	useFuzzySpeculation: false,

	// Verifier
	useBayesianAggregation: false,
	useRAGVerification: false,
	useVerificationLogging: false,

	// Conscious
	useFlexibleConsciousResponse: false,
	useHumanLikeConsciousMode: false,
	useConsciousRefinement: false,
	useUtteranceLevelTriggering: true,
	useMicTranscriptTriggers: false,

	// Worker config (6 cores default, user-adjustable)
	workerThreadCount: 6,

	// Cache config
	maxCacheMemoryMB: 100,
	semanticCacheThreshold: 0.85,

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
export function isOptimizationActive(
	key: keyof Omit<
		OptimizationFlags,
		| "accelerationEnabled"
		| "workerThreadCount"
		| "maxCacheMemoryMB"
		| "semanticCacheThreshold"
		| "maxPrefetchPredictions"
		| "foundationIntentRetryBaseMs"
		| "foundationIntentMaxRetries"
		| "laneBudgets"
		| "useConsciousVerifierWordBoundary"
	>,
): boolean {
	return currentFlags.accelerationEnabled && currentFlags[key];
}

/**
 * Check if a conscious mode verifier optimization is active
 * These run independently of the acceleration master toggle since they affect correctness
 */
export function isVerifierOptimizationActive(
	key:
		| "useConsciousVerifierWordBoundary"
		| "useDegradedProvenanceCheck"
		| "useTighterNumericClaimRegex"
		| "useExpandedTechAllowlist"
		| "useSemanticThreadContinuation"
		| "useConfidenceCalibration"
		| "useSemanticEntailment"
		| "useProbabilisticStar"
		| "useSetFitReactions"
		| "useAdaptivePause"
		| "useFuzzySpeculation"
		| "useBayesianAggregation"
		| "useRAGVerification"
		| "useVerificationLogging",
): boolean {
	return currentFlags[key];
}

/**
 * Check if a conscious mode optimization is active
 * These run independently of the acceleration master toggle
 */
export function isConsciousOptimizationActive(
	key:
		| "useFlexibleConsciousResponse"
		| "useHumanLikeConsciousMode"
		| "useConsciousRefinement"
		| "useUtteranceLevelTriggering"
		| "useMicTranscriptTriggers",
): boolean {
	return currentFlags[key];
}

/**
 * Check if running on Apple Silicon (M1+)
 */
export function isAppleSilicon(): boolean {
	return process.platform === "darwin" && process.arch === "arm64";
}

/**
 * Get effective worker thread count
 */
export function getEffectiveWorkerCount(): number {
	if (cachedCpuCount === null) {
		try {
			const os = require("node:os");
			cachedCpuCount = os.cpus().length;
		} catch {
			cachedCpuCount = 4;
		}
	}
	return Math.min(currentFlags.workerThreadCount, cachedCpuCount);
}
