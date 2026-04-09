// electron/conscious/index.ts
// Central export point for Conscious Mode Realtime modules

export * from './types';
export { TokenBudgetManager } from './TokenBudget';
export { InterviewPhaseDetector, type PhaseDetectionResult } from './InterviewPhase';
export { ConfidenceScorer } from './ConfidenceScorer';
export { ThreadManager } from './ThreadManager';
export { ConsciousThreadStore, type PersistedActiveThreadSnapshot, type PersistedConsciousThreadState } from './ConsciousThreadStore';
export { ObservedQuestionStore, type ObservedQuestion } from './ObservedQuestionStore';
export { QuestionReactionClassifier, type QuestionReaction, type QuestionReactionKind } from './QuestionReactionClassifier';
export { AnswerHypothesisStore, type AnswerHypothesis, type PersistedAnswerHypothesisState } from './AnswerHypothesisStore';
export { ConsciousRetrievalOrchestrator, type ConsciousRetrievalPack } from './ConsciousRetrievalOrchestrator';
export { ConsciousContextComposer, type ConsciousContextComposition } from './ConsciousContextComposer';
export { ConsciousIntentService, type ResolvedIntentResult, type ConsciousIntentResolution } from './ConsciousIntentService';
export { ConsciousPreparationCoordinator, type ConsciousPreparationResult } from './ConsciousPreparationCoordinator';
export { ConsciousResponseCoordinator } from './ConsciousResponseCoordinator';
export { ConsciousVerifier, type ConsciousVerificationResult } from './ConsciousVerifier';
export { FallbackExecutor } from './FallbackExecutor';
export { extractConstraints, type ExtractedConstraint, type ConstraintType } from './ConstraintExtractor';
export { detectQuestion, type QuestionDetection, type QuestionType } from './QuestionDetector';
export { ResponseFingerprinter, type DuplicateCheckResult, type ResponseFingerprintEntry } from './ResponseFingerprint';
export { ConsciousOrchestrator, type PreparedConsciousRoute, type ConsciousExecutionResult } from './ConsciousOrchestrator';
