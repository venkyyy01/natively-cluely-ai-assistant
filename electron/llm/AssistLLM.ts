// electron/llm/AssistLLM.ts
// MODE: Assist - Passive observation (low priority)
// Provides brief observational insights, NEVER suggests what to say
// Uses LLMHelper for centralized routing and universal prompts

import type { LLMHelper } from "../LLMHelper";
import {
	Err,
	type LLMError,
	Ok,
	type Result,
	wrapAsync,
} from "../types/Result";
import { UNIVERSAL_ASSIST_PROMPT } from "./prompts";

export class AssistLLM {
	private llmHelper: LLMHelper;

	constructor(llmHelper: LLMHelper) {
		this.llmHelper = llmHelper;
	}

	/**
	 * Generate passive observational insight
	 *
	 * HIGH RELIABILITY FIX:
	 * Returns Result<string, LLMError> instead of swallowing errors with empty strings
	 *
	 * @param context - Current conversation context
	 * @returns Result containing insight (no post-clamp; prompt enforces brevity)
	 */
	async generate(context: string): Promise<Result<string, LLMError>> {
		if (!context.trim()) {
			return Ok(""); // Empty context is valid, just return empty result
		}

		return await wrapAsync(
			async () => {
				// Centralized LLM logic
				// providing a specific instruction as message, using UNIVERSAL_ASSIST_PROMPT as system prompt
				const instruction =
					"Briefly summarize what is happening right now in 1-2 sentences. Do not give advice, just observation.";

				const result = await this.llmHelper.chat(
					instruction,
					undefined, // no image
					context,
					UNIVERSAL_ASSIST_PROMPT,
				);

				// Additional validation to ensure we got meaningful content
				if (result.trim().length === 0) {
					throw new Error("LLM returned empty assist response");
				}

				return result;
			},
			`Failed to generate assist insight for context: "${context.substring(0, 100)}${context.length > 100 ? "..." : ""}"`,
			{ contextLength: context.length },
		);
	}

	// BACKWARD COMPATIBILITY METHODS:

	/**
	 * @deprecated Use generate() with Result handling instead
	 * Generate assist insight with fallback to empty string (for backward compatibility)
	 */
	async generateLegacy(context: string): Promise<string> {
		const result = await this.generate(context);
		if (result.success) {
			return result.data;
		} else {
			console.error(
				"[AssistLLM] Generation failed (legacy mode):",
				result.error,
			);
			return "";
		}
	}
}
