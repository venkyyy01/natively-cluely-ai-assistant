import { LLMHelper } from "../LLMHelper";
import { CONSCIOUS_REASONING_SYSTEM_PROMPT, UNIVERSAL_FOLLOWUP_PROMPT } from "./prompts";
import {
    CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS,
    ConsciousModeStructuredResponse,
    ReasoningThread,
    parseConsciousModeResponse,
} from "../ConsciousMode";
import { Result, LLMError, wrapAsync } from "../types/Result";

export class FollowUpLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    /**
     * Generate follow-up response
     * 
     * HIGH RELIABILITY FIX:
     * Returns Result<string, LLMError> instead of swallowing errors with empty strings
     */
    async generate(previousAnswer: string, refinementRequest: string, context?: string): Promise<Result<string, LLMError>> {
        return await wrapAsync(
            async () => {
                const message = `PREVIOUS ANSWER:\n${previousAnswer}\n\nREQUEST: ${refinementRequest}`;
                const stream = this.llmHelper.streamChat(message, undefined, context, UNIVERSAL_FOLLOWUP_PROMPT);
                
                let full = "";
                for await (const chunk of stream) {
                    full += chunk;
                }
                
                // Additional validation to ensure we got meaningful content
                if (full.trim().length === 0) {
                    throw new Error("LLM returned empty follow-up response");
                }
                
                return full;
            },
            `Failed to generate follow-up response for refinement: "${refinementRequest.substring(0, 50)}${refinementRequest.length > 50 ? '...' : ''}"`,
            { 
                previousAnswerLength: previousAnswer.length, 
                refinementRequest, 
                contextLength: context?.length || 0 
            }
        );
    }

    /**
     * Generate streaming follow-up response
     * 
     * HIGH RELIABILITY FIX:
     * Better error handling for streams - errors are logged but don't crash
     */
    async *generateStream(previousAnswer: string, refinementRequest: string, context?: string, abortSignal?: AbortSignal): AsyncGenerator<string> {
        try {
            const message = `PREVIOUS ANSWER:\n${previousAnswer}\n\nREQUEST: ${refinementRequest}`;
            yield* this.llmHelper.streamChat(message, undefined, context, UNIVERSAL_FOLLOWUP_PROMPT, { abortSignal });
        } catch (e) {
            console.error("[FollowUpLLM] Stream Failed:", new LLMError(
                "Follow-up stream generation failed",
                e,
                { 
                    previousAnswerLength: previousAnswer.length, 
                    refinementRequest, 
                    contextLength: context?.length || 0 
                }
            ));
            // For streams, we can't return a Result, but we should at least not crash
        }
    }

    /**
     * Generate reasoning-first follow-up response
     * 
     * HIGH RELIABILITY FIX:
     * Returns Result<ConsciousModeStructuredResponse, LLMError> instead of swallowing errors
     */
    async generateReasoningFirstFollowUp(
        reasoningThread: ReasoningThread,
        followUpQuestion: string,
        context?: string
    ): Promise<Result<ConsciousModeStructuredResponse, LLMError>> {
        return await wrapAsync(
            async () => {
                const message = [
                    'ACTIVE_REASONING_THREAD',
                    `ROOT_QUESTION: ${reasoningThread.rootQuestion}`,
                    `LAST_QUESTION: ${reasoningThread.lastQuestion}`,
                    `CURRENT_RESPONSE: ${JSON.stringify(reasoningThread.response)}`,
                    `FOLLOW_UP_QUESTION: ${followUpQuestion}`,
                    'STRICT FOLLOW-UP RULES (MUST OBEY):',
                    '- You are answering a FOLLOW-UP. STRICTLY align with the previous answers in the conversation history.',
                    '- DO NOT invent new approaches, data structures, algorithms, or architectures unless explicitly asked.',
                    '- Answer ONLY the specific follow-up question concisely and directly.',
                    '- DO NOT restate the original problem statement.',
                    '- DO NOT re-explain concepts the interviewer already knows from prior turns.',
                    '- If asked about tradeoffs, name ONLY the relevant tradeoffs for the CURRENT approach.',
                    '- If asked about complexity, state ONLY the complexity of the CURRENT approach.',
                    '- NEVER revert to a brute-force solution if an optimized approach was already established.',
                    '- NEVER introduce alternative solutions the interviewer did not ask for.',
                    '- Keep "spokenResponse" short and conversational. Leave implementationPlan, edgeCases, scaleConsiderations, and pushbackResponses EMPTY unless explicitly asked.',
                    CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS,
                ].join('\n\n');
                const stream = this.llmHelper.streamChat(message, undefined, context, CONSCIOUS_REASONING_SYSTEM_PROMPT, {
                    skipKnowledgeInterception: true,
                    qualityTier: 'verify',
                });

                let full = "";
                for await (const chunk of stream) {
                    full += chunk;
                }
                
                // Additional validation
                if (full.trim().length === 0) {
                    throw new Error("LLM returned empty response for reasoning-first follow-up generation");
                }

                const parsed = parseConsciousModeResponse(full);
                
                // Validate that parsing was successful and returned a valid response
                if (parsed.mode === 'invalid') {
                    throw new Error(`Failed to parse reasoning-first follow-up response: ${full.substring(0, 200)}...`);
                }
                
                return parsed;
            },
            `Failed to generate reasoning-first follow-up for question: "${followUpQuestion.substring(0, 50)}${followUpQuestion.length > 50 ? '...' : ''}"`,
            { 
                rootQuestion: reasoningThread.rootQuestion,
                followUpQuestion, 
                contextLength: context?.length || 0 
            }
        );
    }

    // BACKWARD COMPATIBILITY METHODS:
    // These methods provide backward compatibility for existing code that expects the old API
    
    /**
     * @deprecated Use generate() with Result handling instead
     * Generate follow-up with fallback to empty string (for backward compatibility)
     */
    async generateLegacy(previousAnswer: string, refinementRequest: string, context?: string): Promise<string> {
        const result = await this.generate(previousAnswer, refinementRequest, context);
        if (result.success) {
            return result.data;
        } else {
            console.error("[FollowUpLLM] Generation failed (legacy mode):", result.error);
            return "";
        }
    }

    /**
     * @deprecated Use generateReasoningFirstFollowUp() with Result handling instead
     * Generate reasoning-first follow-up with fallback to empty parse (for backward compatibility)
     */
    async generateReasoningFirstFollowUpLegacy(
        reasoningThread: ReasoningThread,
        followUpQuestion: string,
        context?: string
    ): Promise<ConsciousModeStructuredResponse> {
        const result = await this.generateReasoningFirstFollowUp(reasoningThread, followUpQuestion, context);
        if (result.success) {
            return result.data;
        } else {
            console.error("[FollowUpLLM] Reasoning-first follow-up failed (legacy mode):", result.error);
            return parseConsciousModeResponse('');
        }
    }
}
