import type { LLMHelper } from "../LLMHelper";
import { LLMError, type Result, wrapAsync } from "../types/Result";
import { UNIVERSAL_FOLLOW_UP_QUESTIONS_PROMPT } from "./prompts";

export class FollowUpQuestionsLLM {
	private llmHelper: LLMHelper;

	constructor(llmHelper: LLMHelper) {
		this.llmHelper = llmHelper;
	}

	/**
	 * Generate follow-up questions
	 *
	 * HIGH RELIABILITY FIX:
	 * Returns Result<string, LLMError> instead of swallowing errors with empty strings
	 */
	async generate(context: string): Promise<Result<string, LLMError>> {
		return await wrapAsync(
			async () => {
				const stream = this.llmHelper.streamChat(
					context,
					undefined,
					undefined,
					UNIVERSAL_FOLLOW_UP_QUESTIONS_PROMPT,
				);
				let full = "";
				for await (const chunk of stream) {
					full += chunk;
				}

				// Additional validation to ensure we got meaningful content
				if (full.trim().length === 0) {
					throw new Error("LLM returned empty follow-up questions response");
				}

				return full;
			},
			`Failed to generate follow-up questions for context: "${context.substring(0, 100)}${context.length > 100 ? "..." : ""}"`,
			{ contextLength: context.length },
		);
	}

	/**
	 * Generate follow-up questions (streaming)
	 *
	 * HIGH RELIABILITY FIX:
	 * Better error handling for streams - errors are logged but don't crash
	 */
	async *generateStream(context: string): AsyncGenerator<string> {
		try {
			yield* this.llmHelper.streamChat(
				context,
				undefined,
				undefined,
				UNIVERSAL_FOLLOW_UP_QUESTIONS_PROMPT,
			);
		} catch (e) {
			console.error(
				"[FollowUpQuestionsLLM] Stream Failed:",
				new LLMError("Follow-up questions stream generation failed", e, {
					contextLength: context.length,
				}),
			);
			// For streams, we can't return a Result, but we should at least not crash
		}
	}

	// BACKWARD COMPATIBILITY METHODS:

	/**
	 * @deprecated Use generate() with Result handling instead
	 * Generate follow-up questions with fallback to empty string (for backward compatibility)
	 */
	async generateLegacy(context: string): Promise<string> {
		const result = await this.generate(context);
		if (result.success) {
			return result.data;
		} else {
			console.error(
				"[FollowUpQuestionsLLM] Generation failed (legacy mode):",
				result.error,
			);
			return "";
		}
	}
}
