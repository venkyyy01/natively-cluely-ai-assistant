// electron/conscious/index.ts
// Central export point for Conscious Mode Realtime modules

export * from './types';
export { TokenBudgetManager } from './TokenBudget';
export { InterviewPhaseDetector, type PhaseDetectionResult } from './InterviewPhase';
export { ConfidenceScorer } from './ConfidenceScorer';
export { ThreadManager } from './ThreadManager';
export {
  ThreadDirector,
  type ConversationThreadViews,
  type ThreadResetReason,
} from './ThreadDirector';
export { isNativelyThreadDirectorEnabled } from './threadDirectorEnv';
export { ConsciousThreadStore, type PersistedActiveThreadSnapshot, type PersistedConsciousThreadState } from './ConsciousThreadStore';
export { ObservedQuestionStore, type ObservedQuestion } from './ObservedQuestionStore';
export { QuestionReactionClassifier, type QuestionReaction, type QuestionReactionKind } from './QuestionReactionClassifier';
export { AnswerHypothesisStore, type AnswerHypothesis, type PersistedAnswerHypothesisState } from './AnswerHypothesisStore';
export { ConsciousAnswerPlanner, type ConsciousAnswerPlan, type ConsciousAnswerShape } from './ConsciousAnswerPlanner';
export {
  ConsciousResponsePreferenceStore,
  type ConsciousPlannerPreferenceSummary,
  type ConsciousResponsePreferenceFlag,
  type ConsciousResponseQuestionMode,
  type PersistedConsciousResponseDirective,
  type PersistedConsciousResponsePreferenceState,
} from './ConsciousResponsePreferenceStore';
export { ConsciousSemanticFactStore, type ConsciousSemanticFact } from './ConsciousSemanticFactStore';
export { sanitizeProfileData, type ProfileDataSanitizationResult, type ProfileDataSanitizerOptions } from './ProfileDataSanitizer';
export { DesignStateStore, type DesignStateEntry, type DesignStateFacet, type DesignStateRetrievalEntry, type DesignStateStoreStats, type PersistedDesignStateState } from './DesignStateStore';
export { ConsciousRetrievalOrchestrator, type ConsciousRetrievalPack } from './ConsciousRetrievalOrchestrator';
export { ConsciousContextComposer, type ConsciousContextComposition } from './ConsciousContextComposer';
export { ConsciousIntentService, type ResolvedIntentResult, type ConsciousIntentResolution } from './ConsciousIntentService';
export { ConsciousPreparationCoordinator, type ConsciousPreparationResult } from './ConsciousPreparationCoordinator';
export { ConsciousResponseCoordinator } from './ConsciousResponseCoordinator';
export { ConsciousProvenanceVerifier, type ConsciousProvenanceVerdict } from './ConsciousProvenanceVerifier';
export { ConsciousVerifier, type ConsciousVerificationResult } from './ConsciousVerifier';
export { ConsciousVerifierLLM } from './ConsciousVerifierLLM';
export {
  runConsciousEvalHarness,
  runConsciousReplayHarness,
  getDefaultConsciousEvalScenarios,
  getDefaultConsciousReplayScenarios,
  type ConsciousEvalScenario,
  type ConsciousEvalScenarioResult,
  type ConsciousEvalSummary,
  type ConsciousReplayContextItem,
  type ConsciousReplayScenario,
  type ConsciousReplayScenarioResult,
  type ConsciousReplayTrace,
} from './ConsciousEvalHarness';
export { FallbackExecutor } from './FallbackExecutor';
export { extractConstraints, type ExtractedConstraint, type ConstraintType } from './ConstraintExtractor';
export { detectQuestion, type QuestionDetection, type QuestionType } from './QuestionDetector';
export { ResponseFingerprinter, type DuplicateCheckResult, type ResponseFingerprintEntry } from './ResponseFingerprint';
export { ConsciousOrchestrator, type PreparedConsciousRoute, type ConsciousExecutionResult } from './ConsciousOrchestrator';
export { ConsciousCache, type CacheEntry as ConsciousCacheEntry, type CacheStats as ConsciousCacheStats, type ConsciousCacheConfig } from './ConsciousCache';
