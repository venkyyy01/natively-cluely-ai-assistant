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
          /**
           * Optional abort signal threaded through the OCR cascade so a
           * cancelled conscious-mode turn doesn't keep paying ~15 s of
           * Tesseract CPU per image after the user has moved on. The
           * signal is also forwarded to the underlying streamChat call.
           */
          abortSignal?: AbortSignal;
        }
    ): Promise<ConsciousModeStructuredResponse> {
        let full = "";
        let earlyReasoningEmitted = false;
        const behavioralPromptRequested = intentResult?.intent === 'behavioral'
            || /QUESTION_MODE:\s*behavioral/i.test(cleanedTranscript)
            || isBehavioralQuestionText(question);

        // OCR INJECTION (NAT-OCR-1):
        //
        // If the active provider is text-only (Groq / Cerebras / Ollama /
        // cURL-no-image / explicitly text-only OpenAI/Claude variant), the
        // streaming pipeline downstream will strip image paths anyway. By
        // resolving the OCR text here we get to:
        //   1. Prepend the recognised text into the transcript so the
        //      structured prompt has actual content to reason over.
        //   2. Replace the "LIVE_CODING_SCREENSHOT_TURN: true" directive
        //      with an OCR-aware version that tells the model *exactly*
        //      what input shape it has, instead of asking it to "read the
        //      screenshot" it can never see.
        //   3. Drop image paths cleanly so providers that error on images
        //      (Cerebras has zero vision support) never see them.
        //
        // For vision-capable models (Gemini, GPT-4o, Claude vision, Groq
        // llama-4-scout) `requiresOcr` is `false` and this is a no-op —
        // the original screenshot → vision LLM path is preserved verbatim.
        let effectiveImagePaths = imagePaths;
        let ocrText = '';
        let ocrUsed = false;
        if (imagePaths?.length) {
            try {
                const resolved = await this.llmHelper.resolveScreenshotTextForNonVision(
                    imagePaths,
                    options?.abortSignal,
                );
                if (resolved.requiresOcr) {
                    ocrUsed = true;
                    ocrText = resolved.text;
                    effectiveImagePaths = [];
                }
            } catch (err) {
                if (options?.abortSignal?.aborted) {
                    // Caller already cancelled — propagate so the orchestrator
                    // can short-circuit the rest of the turn cleanly.
                    throw err;
                }
                console.warn('[WhatToAnswerLLM] OCR resolution failed; falling back to vision path:', err);
            }
        }

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
            // Two flavours of the same A/B/C/D contract:
            //   - vision path: "the screenshot contains the problem; read it"
            //   - OCR  path:  "the OCR'd text below IS the problem; treat it
            //                  verbatim; OCR may have minor character errors"
            // The schema and required fields are identical between the two so
            // downstream parsing in `parseConsciousModeResponse` does not
            // change at all.
            const liveCodingDirective = ocrUsed
                ? [
                    'LIVE_CODING_SCREENSHOT_TURN: true',
                    'INPUT_MODALITY: ocr_text (no image attached)',
                    'The block labelled SCREENSHOT_OCR below contains the verbatim OCR-extracted text from the user\'s screenshot. Treat it as the source of truth. OCR can introduce small character errors (e.g. l↔1, O↔0, missing punctuation); silently correct obvious noise.',
                    'STRICT LIVE-CODING OUTPUT CONTRACT:',
                    '- Return codingInterviewAnswer with all required nested fields.',
                    '- The visible answer must follow exactly: A. Problem Understanding, B. Brute Force Approach, C. Optimized Approach, D. Tradeoffs & Interview Reasoning.',
                    '- Include full brute force code and full optimized code.',
                    '- Include time and space complexity plus reasoning for both approaches.',
                    '- Use prior conversation context to avoid contradicting earlier solutions.',
                  ].join('\n')
                : [
                    'LIVE_CODING_SCREENSHOT_TURN: true',
                    'STRICT LIVE-CODING OUTPUT CONTRACT:',
                    '- Return codingInterviewAnswer with all required nested fields.',
                    '- The visible answer must follow exactly: A. Problem Understanding, B. Brute Force Approach, C. Optimized Approach, D. Tradeoffs & Interview Reasoning.',
                    '- Include full brute force code and full optimized code.',
                    '- Include time and space complexity plus reasoning for both approaches.',
                    '- Use prior conversation context to avoid contradicting earlier solutions.',
                  ].join('\n');
            contextParts.push(liveCodingDirective);
        }

        if (temporalContext?.hasRecentResponses) {
            contextParts.push(`PREVIOUS_RESPONSES: ${temporalContext.previousResponses.join(' | ')}`);
        }

        if (ocrUsed && ocrText) {
            // Inject OCR before the conversation transcript so the model
            // anchors on the screenshot content first; cap to keep the
            // prompt budget sane (the OCR cascade already trims via
            // trimScreenshotFallbackText).
            contextParts.push(`SCREENSHOT_OCR (text-only model — use as primary source):\n${ocrText}`);
        }

        contextParts.push(`CONVERSATION:\n${cleanedTranscript}`);

        const message = [
            'STRUCTURED_REASONING_RESPONSE',
            ...contextParts,
        ].join('\n\n');
        const stream = this.llmHelper.streamChat(
            message,
            effectiveImagePaths,
            undefined,
            behavioralPromptRequested
                ? CONSCIOUS_BEHAVIORAL_REASONING_SYSTEM_PROMPT
                : CONSCIOUS_REASONING_SYSTEM_PROMPT,
            {
            skipKnowledgeInterception: true,
            qualityTier: 'verify',
            abortSignal: options?.abortSignal,
        });

        for await (const chunk of stream) {
            if (options?.abortSignal?.aborted) {
                break;
            }
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
