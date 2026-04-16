import { LLMHelper } from "../LLMHelper";
import { CONSCIOUS_REASONING_SYSTEM_PROMPT, UNIVERSAL_ANSWER_PROMPT } from "./prompts";
import { ConsciousModeStructuredResponse, parseConsciousModeResponse } from "../ConsciousMode";

export class AnswerLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    /**
     * Generate a spoken interview answer
     */
    async generate(question: string, context?: string): Promise<string> {
        try {
            // Use LLMHelper's streamChat but collect all tokens since this method is non-streaming
            // We use UNIVERSAL_ANSWER_PROMPT as override
            const stream = this.llmHelper.streamChat(question, undefined, context, UNIVERSAL_ANSWER_PROMPT);

            let fullResponse = "";
            for await (const chunk of stream) {
                fullResponse += chunk;
            }
            return fullResponse.trim();

        } catch (error) {
            console.error("[AnswerLLM] Generation failed:", error);
            return "";
        }
    }

    async generateReasoningFirst(question: string, context?: string): Promise<ConsciousModeStructuredResponse> {
        try {
            const message = [
                'STRUCTURED_REASONING_RESPONSE',
                'Return JSON with keys: mode, openingReasoning, implementationPlan, tradeoffs, edgeCases, scaleConsiderations, pushbackResponses, likelyFollowUps, codeTransition.',
                'Set mode to reasoning_first.',
                `QUESTION: ${question}`,
            ].join('\n\n');
            const stream = this.llmHelper.streamChat(message, undefined, context, CONSCIOUS_REASONING_SYSTEM_PROMPT, {
                skipKnowledgeInterception: true,
                qualityTier: 'structured_reasoning',
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
