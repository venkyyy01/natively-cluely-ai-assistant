import {
	CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS,
	type ConsciousModeStructuredResponse,
	parseConsciousModeResponse,
	type ReasoningThread,
} from "../ConsciousMode";
import { Result, LLMError, wrapAsync } from "../types/Result";
import type { ProbeAnswer, ProbeType } from "../coding/types";
import { parseProbeAnswer } from "../coding/types";

const PROBE_ANSWER_SYSTEM_PROMPT = `You are a precise coding-interview assistant answering a single focused follow-up probe.
You MUST respond ONLY with valid JSON matching the probe_answer_v1 schema below.
NEVER restate the original problem. NEVER revert to brute-force unless explicitly asked. NEVER emit implementationPlan or any conscious_mode_v1 field.

SCHEMA:
{
  "schemaVersion": "probe_answer_v1",
  "probeType": "<one of: complexity|edge_case|tradeoff|pushback|alternative|data_structure|generic>",
  "question": "<the exact probe question>",
  "answer": "<your spoken answer — MAX 4 sentences, natural conversational English>",
  "delta": { "fact": "<single declarative sentence>", "attachTo": "<tradeoffs|edgeCases|implementationPlan>" },
  "confidence": <0.0-1.0>
}

The "delta" field is optional — include it ONLY when there is a single concrete new fact worth preserving in the root response.
`;

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

    /**
     * NAT-203: Tier-B — generate a focused probe answer.
     * Uses probe_answer_v1 schema only — NEVER injects CONSCIOUS_MODE_JSON_RESPONSE_INSTRUCTIONS.
     * Optionally injects <recent_code> context (populated by NAT-403).
     */
    async generateProbeAnswer(
        thread: ReasoningThread,
        probeQuestion: string,
        probeType: ProbeType,
        ctx?: { context?: string; recentCode?: string },
    ): Promise<Result<ProbeAnswer, LLMError>> {
        return await wrapAsync(
            async () => {
                const codeFence = ctx?.recentCode
                    ? `\n\n<recent_code>\n${ctx.recentCode.slice(0, 2000)}\n</recent_code>`
                    : '';

                const message = [
                    `ROOT_QUESTION: ${thread.rootQuestion}`,
                    `LAST_QUESTION: ${thread.lastQuestion}`,
                    `PROBE_TYPE: ${probeType}`,
                    `PROBE_QUESTION: ${probeQuestion}`,
                    'STRICT PROBE RULES:',
                    '- Answer ONLY this specific probe question.',
                    '- NEVER restate the original problem.',
                    '- NEVER revert to brute-force if optimized was established.',
                    '- Keep "answer" ≤ 4 sentences, conversational.',
                    '- Emit "delta" ONLY if there is a single new concrete fact worth preserving.',
                    codeFence,
                ].join('\n');

                const stream = this.llmHelper.streamChat(
                    message,
                    undefined,
                    ctx?.context,
                    PROBE_ANSWER_SYSTEM_PROMPT,
                    { skipKnowledgeInterception: true, qualityTier: 'fast' },
                );

                let full = '';
                for await (const chunk of stream) {
                    full += chunk;
                }

                if (!full.trim()) {
                    throw new Error('LLM returned empty probe answer');
                }

                const result = parseProbeAnswer(full);
                if (!result.success) {
                    throw new Error(`Failed to parse probe answer (${(result as { success: false; error: unknown }).error})`);
                }

                return (result as { success: true; data: ProbeAnswer }).data;
            },
            `generateProbeAnswer failed for probe: "${probeQuestion.slice(0, 60)}"`,
            { rootQuestion: thread.rootQuestion, probeType, probeQuestion },
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
