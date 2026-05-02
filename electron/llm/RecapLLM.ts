import type { LLMHelper } from "../LLMHelper";
import { Err, LLMError, Ok, type Result, wrapAsync } from "../types/Result";
import { UNIVERSAL_RECAP_PROMPT } from "./prompts";

export class RecapLLM {
	private llmHelper: LLMHelper;

	constructor(llmHelper: LLMHelper) {
		this.llmHelper = llmHelper;
	}

	/**
	 * Generate a neutral conversation summary
	 *
	 * HIGH RELIABILITY FIX:
	 * Returns Result<string, LLMError> instead of swallowing errors with empty strings
	 */
	async generate(context: string): Promise<Result<string, LLMError>> {
		if (!context.trim()) {
			return Ok(""); // Empty context is valid, just return empty result
		}

		return await wrapAsync(
			async () => {
				const stream = this.llmHelper.streamChat(
					context,
					undefined,
					undefined,
					UNIVERSAL_RECAP_PROMPT,
				);
				let fullResponse = "";
				for await (const chunk of stream) {
					fullResponse += chunk;
				}

				return this.clampRecapResponse(fullResponse);
			},
			`Failed to generate recap for context: "${context.substring(0, 100)}${context.length > 100 ? "..." : ""}"`,
			{ contextLength: context.length },
		);
	}

	/**
	 * Generate a neutral conversation summary (Streamed)
	 *
	 * HIGH RELIABILITY FIX:
	 * Better error handling for streams - errors are logged but don't crash
	 */
	async *generateStream(
		context: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<string> {
		if (!context.trim()) return;

		try {
			// Use our universal helper
			yield* this.llmHelper.streamChat(
				context,
				undefined,
				undefined,
				UNIVERSAL_RECAP_PROMPT,
				{ abortSignal },
			);
		} catch (error) {
			console.error(
				"[RecapLLM] Streaming generation failed:",
				new LLMError("Recap stream generation failed", error, {
					contextLength: context.length,
				}),
			);
			// For streams, we can't return a Result, but we should at least not crash
		}
	}

	private clampRecapResponse(text: string): string {
		if (!text) return "";
		// Simple clamp: max 5 lines
		return text
			.split("\n")
			.filter((l) => l.trim())
			.slice(0, 5)
			.join("\n");
	}

	// BACKWARD COMPATIBILITY METHODS:

	/**
	 * @deprecated Use generate() with Result handling instead
	 * Generate recap with fallback to empty string (for backward compatibility)
	 */
	async generateLegacy(context: string): Promise<string> {
		const result = await this.generate(context);
		if (result.success) {
			return result.data;
		} else {
			console.error(
				"[RecapLLM] Generation failed (legacy mode):",
				result.error,
			);
			return "";
		}
	}
}
