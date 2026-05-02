// electron/conscious/index.ts
// Central export point for Conscious Mode Realtime modules

export {
	type AnswerHypothesis,
	AnswerHypothesisStore,
	type PersistedAnswerHypothesisState,
} from "./AnswerHypothesisStore";
export { ConfidenceScorer } from "./ConfidenceScorer";
export {
	type ConsciousAnswerPlan,
	ConsciousAnswerPlanner,
	type ConsciousAnswerShape,
} from "./ConsciousAnswerPlanner";
export {
	type CacheEntry as ConsciousCacheEntry,
	type CacheStats as ConsciousCacheStats,
	ConsciousCache,
	type ConsciousCacheConfig,
} from "./ConsciousCache";
export {
	ConsciousContextComposer,
	type ConsciousContextComposition,
} from "./ConsciousContextComposer";
export {
	type ConsciousEvalScenario,
	type ConsciousEvalScenarioResult,
	type ConsciousEvalSummary,
	type ConsciousReplayContextItem,
	type ConsciousReplayScenario,
	type ConsciousReplayScenarioResult,
	type ConsciousReplayTrace,
	getDefaultConsciousEvalScenarios,
	getDefaultConsciousReplayScenarios,
	runConsciousEvalHarness,
	runConsciousReplayHarness,
} from "./ConsciousEvalHarness";
export {
	type ConsciousIntentResolution,
	ConsciousIntentService,
	type ResolvedIntentResult,
} from "./ConsciousIntentService";
export {
	type ConsciousExecutionResult,
	ConsciousOrchestrator,
	type PreparedConsciousRoute,
} from "./ConsciousOrchestrator";
export {
	ConsciousPreparationCoordinator,
	type ConsciousPreparationResult,
} from "./ConsciousPreparationCoordinator";
export {
	type ConsciousProvenanceVerdict,
	ConsciousProvenanceVerifier,
} from "./ConsciousProvenanceVerifier";
export { ConsciousResponseCoordinator } from "./ConsciousResponseCoordinator";
export {
	type ConsciousPlannerPreferenceSummary,
	type ConsciousResponsePreferenceFlag,
	ConsciousResponsePreferenceStore,
	type ConsciousResponseQuestionMode,
	type PersistedConsciousResponseDirective,
	type PersistedConsciousResponsePreferenceState,
} from "./ConsciousResponsePreferenceStore";
export {
	ConsciousRetrievalOrchestrator,
	type ConsciousRetrievalPack,
} from "./ConsciousRetrievalOrchestrator";
export {
	type ConsciousSemanticFact,
	ConsciousSemanticFactStore,
} from "./ConsciousSemanticFactStore";
export {
	ConsciousThreadStore,
	type PersistedActiveThreadSnapshot,
	type PersistedConsciousThreadState,
} from "./ConsciousThreadStore";
export {
	type ConsciousVerificationResult,
	ConsciousVerifier,
} from "./ConsciousVerifier";
export { ConsciousVerifierLLM } from "./ConsciousVerifierLLM";
export {
	type ConstraintType,
	type ExtractedConstraint,
	extractConstraints,
} from "./ConstraintExtractor";
export {
	type BackgroundVerificationOutcome,
	type Claim,
	type ClaimCategory,
	type ClaimVerificationResult,
	classifyDeepModeQuestion,
	createDefaultDeepModeState,
	type DeepModeConfig,
	type DeepModeState,
	extractClaims,
} from "./DeepMode";
export {
	type DesignStateEntry,
	type DesignStateFacet,
	type DesignStateRetrievalEntry,
	DesignStateStore,
	type DesignStateStoreStats,
	type PersistedDesignStateState,
} from "./DesignStateStore";
export { FallbackExecutor } from "./FallbackExecutor";
export {
	InterviewPhaseDetector,
	type PhaseDetectionResult,
} from "./InterviewPhase";
export {
	type ObservedQuestion,
	ObservedQuestionStore,
} from "./ObservedQuestionStore";
export {
	type ProfileDataSanitizationResult,
	type ProfileDataSanitizerOptions,
	sanitizeProfileData,
} from "./ProfileDataSanitizer";
export {
	detectQuestion,
	type QuestionDetection,
	type QuestionType,
} from "./QuestionDetector";
export {
	type QuestionReaction,
	QuestionReactionClassifier,
	type QuestionReactionKind,
} from "./QuestionReactionClassifier";
export {
	type DuplicateCheckResult,
	type ResponseFingerprintEntry,
	ResponseFingerprinter,
} from "./ResponseFingerprint";
export {
	type ConversationThreadViews,
	ThreadDirector,
	type ThreadResetReason,
} from "./ThreadDirector";
export { ThreadManager } from "./ThreadManager";
export { TokenBudgetManager } from "./TokenBudget";
export { isNativelyThreadDirectorEnabled } from "./threadDirectorEnv";
export * from "./types";
