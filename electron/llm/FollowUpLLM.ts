import { LLMHelper } from "../LLMHelper";
import { CONSCIOUS_REASONING_SYSTEM_PROMPT, UNIVERSAL_FOLLOWUP_PROMPT } from "./prompts";
import {
    CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS,
    ConsciousModeStructuredResponse,
    ReasoningThread,
    parseConsciousModeResponse,
} from "../ConsciousMode";

export class FollowUpLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    async generate(previousAnswer: string, refinementRequest: string, context?: string): Promise<string> {
        try {
            const message = `PREVIOUS ANSWER:\n${previousAnswer}\n\nREQUEST: ${refinementRequest}`;
            const stream = this.llmHelper.streamChat(message, undefined, context, UNIVERSAL_FOLLOWUP_PROMPT);
            let full = "";
            for await (const chunk of stream) full += chunk;
            return full;
        } catch (e) {
            console.error("[FollowUpLLM] Failed:", e);
            return "";
        }
    }

    async *generateStream(previousAnswer: string, refinementRequest: string, context?: string, abortSignal?: AbortSignal): AsyncGenerator<string> {
        try {
            const message = `PREVIOUS ANSWER:\n${previousAnswer}\n\nREQUEST: ${refinementRequest}`;
            yield* this.llmHelper.streamChat(message, undefined, context, UNIVERSAL_FOLLOWUP_PROMPT, { abortSignal });
        } catch (e) {
            console.error("[FollowUpLLM] Stream Failed:", e);
        }
    }

    async generateReasoningFirstFollowUp(
        reasoningThread: ReasoningThread,
        followUpQuestion: string,
        context?: string
    ): Promise<ConsciousModeStructuredResponse> {
        try {
            const message = [
                'ACTIVE_REASONING_THREAD',
                `ROOT_QUESTION: ${reasoningThread.rootQuestion}`,
                `LAST_QUESTION: ${reasoningThread.lastQuestion}`,
                `CURRENT_RESPONSE: ${JSON.stringify(reasoningThread.response)}`,
                `FOLLOW_UP_QUESTION: ${followUpQuestion}`,
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

            return parseConsciousModeResponse(full);
        } catch (e) {
            console.error("[FollowUpLLM] Conscious Mode follow-up failed:", e);
            return parseConsciousModeResponse('');
        }
    }
}
