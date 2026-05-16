import { LLMHelper } from "../LLMHelper";
import {
    CONSCIOUS_BEHAVIORAL_REASONING_SYSTEM_PROMPT,
    CONSCIOUS_REASONING_SYSTEM_PROMPT,
    FAST_STANDARD_ANSWER_PROMPT,
    UNIVERSAL_WHAT_TO_ANSWER_PROMPT,
} from "./prompts";
import { TemporalContext } from "./TemporalContextBuilder";
import { IntentResult } from "./IntentClassifier";
import {
    CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS,
    ConsciousModeStructuredResponse,
    isBehavioralQuestionText,
    parseConsciousModeResponse,
    tryParseConsciousModeOpeningReasoning,
} from "../ConsciousMode";

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
            if (typeof this.llmHelper.streamChat !== 'function') {
                throw new TypeError('LLMHelper.streamChat is not available');
            }

            const stream = this.llmHelper.streamChat(primaryQuestion, imagePaths, conversationContext, prompt, {
                skipKnowledgeInterception: !!options?.fastPath,
                abortSignal: options?.abortSignal,
            });
            if (!stream || typeof (stream as AsyncIterable<string>)[Symbol.asyncIterator] !== 'function') {
                throw new TypeError('LLMHelper.streamChat must return an async iterable');
            }

            for await (const chunk of stream) {
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
            // Stream yielded tokens then failed - signal truncation to consumer
            console.error("[WhatToAnswerLLM] Stream failed after yielding tokens:", error);
            yield "\n\n[Response truncated due to error. Please ask again.]";
        }
    }

    async generateReasoningFirst(
        cleanedTranscript: string,
        question: string,
        temporalContext?: TemporalContext,
        intentResult?: IntentResult,
        imagePaths?: string[],
        options?: {
          /** Called when openingReasoning is extractable from partial JSON.
           *  Enables early display before full response is parsed. */
          onEarlyReasoning?: (text: string) => void;
        }
    ): Promise<ConsciousModeStructuredResponse> {
        let full = "";
        let earlyReasoningEmitted = false;
        const behavioralPromptRequested = intentResult?.intent === 'behavioral'
            || /QUESTION_MODE:\s*behavioral/i.test(cleanedTranscript)
            || isBehavioralQuestionText(question);
        const liveCodingPromptRequested = Boolean(imagePaths?.length)
            && (
                intentResult?.intent === 'coding'
                || /QUESTION_MODE:\s*live_coding/i.test(cleanedTranscript)
                || /(write|implement|debug|fix|refactor|function|typescript|javascript|python|java|sql|query|code|snippet|algorithm|console|output)/i.test(question)
            );

        const contextParts: string[] = [
            `QUESTION: ${question}`,
        ];

        if (intentResult) {
            let intentHint: string;
            switch (intentResult.intent) {
                case 'behavioral':
                    intentHint = 'This is a behavioral question. Tell one concrete story, own it with "I".';
                    break;
                case 'coding':
                    intentHint = 'This is a coding question. For a fresh problem, use the mandatory A/B/C/D interview structure with brute force and optimized code.';
                    break;
                case 'deep_dive':
                    intentHint = 'They want more detail on the same topic. Go deeper, don\'t start a new topic.';
                    break;
                case 'clarification':
                    intentHint = 'They want clarification. Keep it short, answer what they actually asked.';
                    break;
                default:
                    intentHint = 'Answer directly. Keep it short and conversational.';
            }
            contextParts.push(intentHint);
        }

        if (liveCodingPromptRequested) {
            contextParts.push([
                'LIVE_CODING_SCREENSHOT_TURN: true',
                'STRICT LIVE-CODING OUTPUT CONTRACT:',
                '- Return codingInterviewAnswer with all required nested fields.',
                '- The visible answer must follow exactly: A. Problem Understanding, B. Brute Force Approach, C. Optimized Approach, D. Tradeoffs & Interview Reasoning.',
                '- Include full brute force code and full optimized code.',
                '- Include time and space complexity plus reasoning for both approaches.',
                '- Use prior conversation context to avoid contradicting earlier solutions.',
            ].join('\n'));
        }

        if (temporalContext?.hasRecentResponses) {
            contextParts.push(`PREVIOUS_RESPONSES: ${temporalContext.previousResponses.join(' | ')}`);
        }

        contextParts.push(`CONVERSATION:\n${cleanedTranscript}`);

        const message = [
            'STRUCTURED_REASONING_RESPONSE',
            ...contextParts,
        ].join('\n\n');
        const stream = this.llmHelper.streamChat(
            message,
            imagePaths,
            undefined,
            behavioralPromptRequested
                ? CONSCIOUS_BEHAVIORAL_REASONING_SYSTEM_PROMPT
                : CONSCIOUS_REASONING_SYSTEM_PROMPT,
            {
            skipKnowledgeInterception: true,
            qualityTier: 'verify',
        });

        for await (const chunk of stream) {
            full += chunk;

            // NAT-L4: Try to extract openingReasoning from partial JSON
            // so the UI can show something while the rest accumulates.
            if (!earlyReasoningEmitted && options?.onEarlyReasoning && full.length > 30) {
                const early = tryParseConsciousModeOpeningReasoning(full);
                if (early) {
                    options.onEarlyReasoning(early);
                    earlyReasoningEmitted = true;
                }
            }
        }

        return parseConsciousModeResponse(full);
    }
}
