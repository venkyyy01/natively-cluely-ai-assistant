import { LLMHelper } from "../LLMHelper";
import { CONSCIOUS_REASONING_SYSTEM_PROMPT, UNIVERSAL_ANSWER_PROMPT } from "./prompts";
import {
    CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS,
    ConsciousModeStructuredResponse,
    parseConsciousModeResponse,
} from "../ConsciousMode";

export class AnswerLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    /**
     * Generate a spoken interview answer
     * 
     * HIGH RELIABILITY FIX:
     * Returns Result<string, LLMError> instead of swallowing errors with empty strings
     */
    async generate(question: string, context?: string): Promise<Result<string, LLMError>> {
        return await wrapAsync(
            async () => {
                // Use LLMHelper's streamChat but collect all tokens since this method is non-streaming
                // We use UNIVERSAL_ANSWER_PROMPT as override
                const stream = this.llmHelper.streamChat(question, undefined, context, UNIVERSAL_ANSWER_PROMPT);

                let fullResponse = "";
                for await (const chunk of stream) {
                    fullResponse += chunk;
                }
                
                const trimmedResponse = fullResponse.trim();
                
                // Additional validation to ensure we got meaningful content
                if (trimmedResponse.length === 0) {
                    throw new Error("LLM returned empty response");
                }
                
                return trimmedResponse;
            },
            `Failed to generate answer for question: "${question.substring(0, 50)}${question.length > 50 ? '...' : ''}"`,
            { question, contextLength: context?.length || 0 }
        );
    }

    /**
     * Generate reasoning-first structured response
     * 
     * HIGH RELIABILITY FIX: 
     * Returns Result<ConsciousModeStructuredResponse, LLMError> instead of swallowing errors
     */
    async generateReasoningFirst(question: string, context?: string): Promise<Result<ConsciousModeStructuredResponse, LLMError>> {
        return await wrapAsync(
            async () => {
                const message = [
                    'STRUCTURED_REASONING_RESPONSE',
                    'Return JSON with keys: mode, openingReasoning, implementationPlan, tradeoffs, edgeCases, scaleConsiderations, pushbackResponses, likelyFollowUps, codeTransition.',
                    'Set mode to reasoning_first.',
                    `QUESTION: ${question}`,
                ].join('\n\n');
                
                const stream = this.llmHelper.streamChat(message, undefined, context, UNIVERSAL_ANSWER_PROMPT);

                let fullResponse = "";
                for await (const chunk of stream) {
                    fullResponse += chunk;
                }

                // Additional validation
                if (fullResponse.trim().length === 0) {
                    throw new Error("LLM returned empty response for reasoning-first generation");
                }

                const parsed = parseConsciousModeResponse(fullResponse);
                
                // Validate that parsing was successful and returned a valid response
                if (parsed.mode === 'invalid') {
                    throw new Error(`Failed to parse reasoning-first response: ${fullResponse.substring(0, 200)}...`);
                }
                
                return parsed;
            },
            `Failed to generate reasoning-first response for question: "${question.substring(0, 50)}${question.length > 50 ? '...' : ''}"`,
            { question, contextLength: context?.length || 0 }
        );
    }

    // BACKWARD COMPATIBILITY METHODS:
    // These methods provide backward compatibility for existing code that expects the old API
    // while encouraging migration to the new Result-based API

    /**
     * @deprecated Use generate() with Result handling instead
     * Generate answer with fallback to empty string (for backward compatibility)
     */
    async generateLegacy(question: string, context?: string): Promise<string> {
        const result = await this.generate(question, context);
        if (result.success) {
            return result.data;
        } else {
            console.error("[AnswerLLM] Generation failed (legacy mode):", result.error);
            return "";
        }
    }

    async generateReasoningFirst(question: string, context?: string): Promise<ConsciousModeStructuredResponse> {
        try {
            const message = [
                'STRUCTURED_REASONING_RESPONSE',
                CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS,
                `QUESTION: ${question}`,
            ].join('\n\n');
            const stream = this.llmHelper.streamChat(message, undefined, context, CONSCIOUS_REASONING_SYSTEM_PROMPT, {
                skipKnowledgeInterception: true,
                qualityTier: 'verify',
            });

            let fullResponse = "";
            for await (const chunk of stream) {
                fullResponse += chunk;
            }

            return parseConsciousModeResponse(fullResponse);
        } catch (error) {
            console.error("[AnswerLLM] Conscious Mode generation failed:", error);
            return parseConsciousModeResponse('');
        }
    }
}
