import { LLMHelper } from "../LLMHelper";
import { FAST_STANDARD_ANSWER_PROMPT, UNIVERSAL_WHAT_TO_ANSWER_PROMPT } from "./prompts";
import { TemporalContext } from "./TemporalContextBuilder";
import { IntentResult } from "./IntentClassifier";
import { ConsciousModeStructuredResponse, parseConsciousModeResponse } from "../ConsciousMode";

export interface StreamFailureDetails {
    error: unknown;
    kind: 'timeout' | 'error';
}

export class WhatToAnswerLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    private buildConversationContext(
        cleanedTranscript: string,
        temporalContext?: TemporalContext,
        intentResult?: IntentResult,
        fastPath?: boolean,
    ): string {
        if (fastPath) {
            return cleanedTranscript;
        }

        const contextParts: string[] = [];

        if (intentResult) {
            contextParts.push(`<intent_and_shape>
DETECTED INTENT: ${intentResult.intent}
ANSWER SHAPE: ${intentResult.answerShape}
</intent_and_shape>`);
        }

        if (temporalContext && temporalContext.hasRecentResponses) {
            const history = temporalContext.previousResponses.map((r, i) => `${i + 1}. "${r}"`).join('\n');
            contextParts.push(`PREVIOUS RESPONSES (Avoid Repetition):\n${history}`);
        }

        const extraContext = contextParts.join('\n\n');
        return extraContext
            ? `${extraContext}\n\nCONVERSATION:\n${cleanedTranscript}`
            : `CONVERSATION:\n${cleanedTranscript}`;
    }

    // Deprecated non-streaming method (redirect to streaming or implement if needed)
    async generate(cleanedTranscript: string): Promise<string> {
        // Simple wrapper around stream
        const stream = this.generateStream(cleanedTranscript);
        let full = "";
        for await (const chunk of stream) full += chunk;
        return full;
    }

    async *generateStream(
        cleanedTranscript: string,
        temporalContext?: TemporalContext,
        intentResult?: IntentResult,
        imagePaths?: string[],
        options?: {
            fastPath?: boolean;
            latestQuestion?: string;
            onInitialStreamFailure?: (details: StreamFailureDetails) => void;
            onFallbackResponsePrepared?: (details: StreamFailureDetails & { hadVisibleOutput: boolean }) => void;
            abortSignal?: AbortSignal;
        }
    ): AsyncGenerator<string> {
        let yieldedAnyChunk = false;
        try {
            const conversationContext = this.buildConversationContext(
                cleanedTranscript,
                temporalContext,
                intentResult,
                options?.fastPath,
            );
            const primaryQuestion = options?.latestQuestion?.trim() || cleanedTranscript;

            const prompt = options?.fastPath ? FAST_STANDARD_ANSWER_PROMPT : UNIVERSAL_WHAT_TO_ANSWER_PROMPT;
            for await (const chunk of this.llmHelper.streamChat(primaryQuestion, imagePaths, conversationContext, prompt, {
                skipKnowledgeInterception: !!options?.fastPath,
                abortSignal: options?.abortSignal,
            })) {
                yieldedAnyChunk = true;
                yield chunk;
            }

        } catch (error) {
            if (options?.abortSignal?.aborted) {
                return;
            }
            const errorMessage = error instanceof Error
                ? `${error.name}: ${error.message}`.toLowerCase()
                : String(error).toLowerCase();
            const failureDetails: StreamFailureDetails = {
                error,
                kind: errorMessage.includes('timeout') || errorMessage.includes('timed out') || errorMessage.includes('abort')
                    ? 'timeout'
                    : 'error',
            };
            if (!yieldedAnyChunk) {
                options?.onInitialStreamFailure?.(failureDetails);
                options?.onFallbackResponsePrepared?.({ ...failureDetails, hadVisibleOutput: false });
                console.error("[WhatToAnswerLLM] Stream failed:", error);
                yield "Could you repeat that? I want to make sure I address your question properly.";
                return;
            }
            console.error("[WhatToAnswerLLM] Stream failed:", error);
        }
    }

    async generateReasoningFirst(
        cleanedTranscript: string,
        question: string,
        temporalContext?: TemporalContext,
        intentResult?: IntentResult,
        imagePaths?: string[]
    ): Promise<ConsciousModeStructuredResponse> {
        let full = "";

        const contextParts: string[] = [
            'STRUCTURED_REASONING_RESPONSE',
            'Return JSON with keys: mode, openingReasoning, implementationPlan, tradeoffs, edgeCases, scaleConsiderations, pushbackResponses, likelyFollowUps, codeTransition.',
            'Set mode to reasoning_first.',
            `QUESTION: ${question}`,
        ];

        if (intentResult) {
            contextParts.push(`INTENT: ${intentResult.intent}`);
            contextParts.push(`ANSWER_SHAPE: ${intentResult.answerShape}`);
        }

        if (temporalContext?.hasRecentResponses) {
            contextParts.push(`PREVIOUS_RESPONSES: ${temporalContext.previousResponses.join(' | ')}`);
        }

        contextParts.push(`CONVERSATION:\n${cleanedTranscript}`);

        const message = contextParts.join('\n\n');
        const stream = this.llmHelper.streamChat(message, imagePaths, undefined, UNIVERSAL_WHAT_TO_ANSWER_PROMPT);

        for await (const chunk of stream) {
            full += chunk;
        }

        return parseConsciousModeResponse(full);
    }
}
