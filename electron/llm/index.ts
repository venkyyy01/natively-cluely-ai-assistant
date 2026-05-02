// electron/llm/index.ts
// Central export for all LLM modules

export { AnswerLLM } from "./AnswerLLM";
export { AssistLLM } from "./AssistLLM";
export { FollowUpLLM } from "./FollowUpLLM";
export { FollowUpQuestionsLLM } from "./FollowUpQuestionsLLM";
export { RecapLLM } from "./RecapLLM";
export { WhatToAnswerLLM } from "./WhatToAnswerLLM";
export { clampResponse, clampProseResponse, validateResponse } from "./postProcessor";
export {
    cleanTranscript,
    sparsifyTranscript,
    formatTranscriptForLLM,
    prepareTranscriptForWhatToAnswer,
    prepareTranscriptForReasoning
} from "./transcriptCleaner";
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
export type { GenerationConfig, GeminiContent, LLMClient } from "./types";
export {
    HARD_SYSTEM_PROMPT,
    ANSWER_MODE_PROMPT,
    ASSIST_MODE_PROMPT,
    FOLLOWUP_MODE_PROMPT,
    RECAP_MODE_PROMPT,
    WHAT_TO_ANSWER_PROMPT,
    TEMPORAL_CONTEXT_TEMPLATE,
    GROQ_TITLE_PROMPT,
    GROQ_SUMMARY_JSON_PROMPT,
    FOLLOWUP_EMAIL_PROMPT,
    GROQ_FOLLOWUP_EMAIL_PROMPT
} from "./prompts";
