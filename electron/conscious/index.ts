// electron/conscious/index.ts
// Central export point for Conscious Mode Realtime modules

export * from './types';
export { TokenBudgetManager } from './TokenBudget';
export { InterviewPhaseDetector, type PhaseDetectionResult } from './InterviewPhase';
export { ConfidenceScorer } from './ConfidenceScorer';
export { ThreadManager } from './ThreadManager';
export { FallbackExecutor } from './FallbackExecutor';
