import { LLMHelper } from "../LLMHelper";
import { UNIVERSAL_ANSWER_PROMPT } from "./prompts";
import { ConsciousModeResponse, parseConsciousModeResponse } from "../ConsciousMode";
import { Result, Ok, Err, LLMError, wrapAsync } from "../types/Result";
import { PromptCompiler } from "./PromptCompiler";
import { InterviewPhase } from "../conscious/types";

export class AnswerLLM {
    private llmHelper: LLMHelper;
    private promptCompiler: PromptCompiler | null;

    constructor(llmHelper: LLMHelper, promptCompiler?: PromptCompiler) {
        this.llmHelper = llmHelper;
        this.promptCompiler = promptCompiler ?? null;
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
     * Uses PromptCompiler to route coding questions to ThoughtFlow
     * 
     * HIGH RELIABILITY FIX: 
     * Returns Result<ConsciousModeResponse, LLMError> instead of swallowing errors
     */
    async generateReasoningFirst(
        question: string,
        context?: string,
        phase?: InterviewPhase,
    ): Promise<Result<ConsciousModeResponse, LLMError>> {
        return await wrapAsync(
            async () => {
                // Use PromptCompiler to get the right prompt (ThoughtFlow for coding, standard for others)
                let systemPrompt = UNIVERSAL_ANSWER_PROMPT;
                
                if (this.promptCompiler) {
                    const compiled = await this.promptCompiler.compile({
                        provider: 'custom',
                        phase: phase ?? 'requirements_gathering',
                        mode: 'conscious',
                        userQuestion: question,
                    });
                    systemPrompt = compiled.systemPrompt;
                }

                const message = [
                    'STRUCTURED_REASONING_RESPONSE',
                    'Return JSON matching the schema in the system prompt exactly.',
                    'No markdown fences, no prose outside JSON.',
                    `QUESTION: ${question}`,
                ].join('\n\n');
                
                const stream = this.llmHelper.streamChat(message, undefined, context, systemPrompt);

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

    /**
     * @deprecated Use generateReasoningFirst() with Result handling instead  
     * Generate reasoning-first response with fallback to empty parse (for backward compatibility)
     */
    async generateReasoningFirstLegacy(question: string, context?: string): Promise<ConsciousModeResponse> {
        const result = await this.generateReasoningFirst(question, context);
        if (result.success) {
            return result.data;
        } else {
            console.error("[AnswerLLM] Conscious Mode generation failed (legacy mode):", result.error);
            return parseConsciousModeResponse('');
        }
    }
}
