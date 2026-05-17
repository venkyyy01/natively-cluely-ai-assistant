// electron/llm/index.ts
// Central export for all LLM modules

export { AnswerLLM } from "./AnswerLLM";
export { AssistLLM } from "./AssistLLM";
export { FollowUpLLM } from "./FollowUpLLM";
export { FollowUpQuestionsLLM } from "./FollowUpQuestionsLLM";
export type { ConversationIntent, IntentResult } from "./IntentClassifier";
export {
	classifyIntent,
	getAnswerShapeGuidance,
	warmupIntentClassifier,
} from "./IntentClassifier";
export {
	clampProseResponse,
	clampResponse,
	validateResponse,
} from "./postProcessor";
export {
	ANSWER_MODE_PROMPT,
	ASSIST_MODE_PROMPT,
	FOLLOWUP_EMAIL_PROMPT,
	FOLLOWUP_MODE_PROMPT,
	GROQ_FOLLOWUP_EMAIL_PROMPT,
	GROQ_SUMMARY_JSON_PROMPT,
	GROQ_TITLE_PROMPT,
	HARD_SYSTEM_PROMPT,
	RECAP_MODE_PROMPT,
	TEMPORAL_CONTEXT_TEMPLATE,
	WHAT_TO_ANSWER_PROMPT,
} from "./prompts";
export { RecapLLM } from "./RecapLLM";
export type {
	AssistantResponse,
	TemporalContext,
} from "./TemporalContextBuilder";
export {
	buildTemporalContext,
	formatTemporalContextForPrompt,
} from "./TemporalContextBuilder";
export type { TranscriptTurn } from "./transcriptCleaner";
export {
    buildTemporalContext,
    formatTemporalContextForPrompt
} from "./TemporalContextBuilder";
export type { TemporalContext, AssistantResponse } from "./TemporalContextBuilder";
export {
    classifyIntent,
    getAnswerShapeGuidance,
    warmupIntentClassifier
} from "./IntentClassifier";
export type { ConversationIntent, IntentResult } from "./IntentClassifier";
export {
    IntentClassificationCoordinator,
    FoundationModelsIntentProvider,
    LegacyIntentProvider,
    FOUNDATION_INTENT_ALLOWED_INTENTS,
    FOUNDATION_INTENT_PROMPT_VERSION,
    FOUNDATION_INTENT_SCHEMA_VERSION,
    resolveFoundationModelsIntentHelperPath,
    createIntentProviderError,
    getIntentProviderErrorCode,
} from './providers';
export type {
    CoordinatedIntentResult,
    IntentClassificationCoordinatorOptions,
    IntentClassificationInput,
    IntentInferenceProvider,
    IntentProviderError,
    IntentProviderErrorType,
    FoundationIntentLabel,
} from './providers';
export { MODE_CONFIGS } from "./types";
export { WhatToAnswerLLM } from "./WhatToAnswerLLM";
